"""Dynamic Tool Gateway for Langflow: discover_tools, execute_tool, take_action, remember.

Connect existing executable Tool outputs to Tools and Gateway Tools to Agent.Tools.
No additional LLM router. Original tools remain connected behind the gateway.

Approvals: anything that changes something in the owner's accounts (sending, creating,
updating, deleting, browser actions) must go through take_action, which carries
``approval_actions`` metadata so the Agent's human-in-the-loop middleware pauses the run
until the owner approves or declines it. execute_tool refuses those calls. Source of truth:
langflow/components/tool_gateway.py in the Studio repo.
"""

import asyncio
import difflib
import json
import re
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool, StructuredTool
from pydantic import BaseModel, Field, ValidationError
from lfx.custom.custom_component.component import Component
from lfx.io import HandleInput, IntInput, Output


class DiscoverArgs(BaseModel):
    query: str = Field(description="Describe the action needed, e.g. 'read Gmail'.")


class ExecuteArgs(BaseModel):
    tool_name: str = Field(description="Exact name from discover_tools.")
    arguments: dict | str | None = Field(default=None, description="Tool arguments, following the discovered schema.")


class ActionArgs(BaseModel):
    tool_name: str = Field(description="Exact name from discover_tools.")
    arguments: dict | str | None = Field(default=None, description="Tool arguments, following the discovered schema.")
    summary: str = Field(description="One plain-English sentence the owner reads before approving, e.g. 'Send the March invoice to jo@acme.com'.")


MEMORY_CATEGORIES = {"customers", "suppliers", "products", "policies", "voice", "team", "other"}


class MemoryArgs(BaseModel):
    content: str = Field(description="The fact to remember, as one short self-contained sentence.")
    scope: str = Field(default="workspace", description="'workspace' for facts about the business; 'personal' for this user's own preferences.")
    category: str = Field(default="other", description="What the fact is about: customers, suppliers, products (products and pricing), policies (policies and rules), voice (tone and style), team, or other.")


# Explicit rebuild prevents some custom-component code evaluators from losing namespaces.
DiscoverArgs.model_rebuild()
ExecuteArgs.model_rebuild()
ActionArgs.model_rebuild()
MemoryArgs.model_rebuild()


def words(s):
    return set(re.findall(r"[a-z0-9]+", str(s or "").lower()))


ALIASES = {
    "email": {"gmail", "inbox", "mail"}, "gmail": {"email", "mail"},
    "website": {"web", "search", "exa"}, "browse": {"web", "search", "exa"},
    "research": {"web", "search", "exa"}, "memory": {"profile", "supermemory", "remember"},
    "remember": {"memory", "supermemory"}, "profile": {"memory", "supermemory"},
    "calculation": {"python", "evaluate", "expression"},
    "spreadsheet": {"sheets", "composio", "workbooks"},
    "file": {"drive", "composio"}, "app": {"composio", "tools"},
}


def capabilities(registry):
    """Plain names for what sits behind the gateway, so the agent knows what discover_tools can find."""
    found = []
    def has(test):
        return any(test(name.lower(), words(name) | words((tool.description or "")[:400])) for name, tool in registry.items())
    if has(lambda name, w: "exa" in w or {"web", "search"} <= w or "internet" in w):
        found.append("web search")
    if has(lambda name, w: name.startswith("composio_")):
        found.append("the owner's connected apps")
    if has(lambda name, w: "python" in w or "repl" in w):
        found.append("running Python")
    if has(lambda name, w: name == "load_skill"):
        found.append("skills")
    return found


def original_schema(tool):
    schema = getattr(tool, "args_schema", None)
    if isinstance(schema, dict):
        return schema
    if schema is not None and hasattr(schema, "model_json_schema"):
        return schema.model_json_schema()
    return {"type": "object", "properties": getattr(tool, "args", {}) or {}}


def compact_schema(schema):
    """Remove schema verbosity without losing property names or nested argument shapes."""
    structural = {"type", "properties", "required", "items", "$ref", "$defs",
                  "anyOf", "oneOf", "allOf", "additionalProperties", "enum",
                  "default", "format", "minItems", "maxItems", "minimum", "maximum",
                  "minLength", "maxLength", "pattern"}

    def visit(value, mapping=False):
        if isinstance(value, list):
            return [visit(v) for v in value]
        if not isinstance(value, dict):
            return value
        if mapping:
            # Field names and $defs model names are arbitrary, NOT schema keywords.
            return {key: visit(child) for key, child in value.items()}
        out = {}
        for key, child in value.items():
            if key in ("properties", "$defs") and isinstance(child, dict):
                out[key] = visit(child, mapping=True)
            elif key in structural:
                out[key] = visit(child)
            elif key == "description":
                desc = str(child)
                out[key] = desc[:150] + ("…" if len(desc) > 150 else "")
        return out

    return visit(schema)


def compact_result(result, limit):
    """Prefer structured MCP payloads; avoid duplicating text/structured representations."""
    structured = getattr(result, "structuredContent", None)
    if structured is None and isinstance(result, dict):
        structured = result.get("structuredContent") or result.get("structured_content")
    if structured is not None:
        payload = structured
    else:
        content = getattr(result, "content", None)
        if content is None and isinstance(result, dict):
            content = result.get("content")
        if isinstance(content, list):
            text_parts = []
            for part in content:
                txt = part.get("text") if isinstance(part, dict) else getattr(part, "text", None)
                if txt is not None:
                    text_parts.append(txt)
            payload = "\n".join(text_parts) if text_parts else content
        else:
            payload = content if content is not None else result
    out = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, default=str)
    if len(out) > limit:
        # Explicit warning so the agent doesn't mistake the excerpt for complete data.
        return out[:limit] + f"\n[PARTIAL RESULT: {len(out)} chars total, {len(out)-limit} omitted. Do not treat as complete; narrow the query or use an execution/data-processing tool for the full dataset.]"
    return out


COMPOSIO_SLUG = re.compile(r"^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$")

# Read-only tools: safe to retry, and they should answer within seconds.
LOOKUP_TOOLS = {
    "composio_search_tools", "composio_get_tool_schemas", "composio_wait_for_connections",
    "composio_search_skills", "composio_use_skill", "load_skill",
    "search", "search_memory", "list_memories", "list_documents", "get_document", "get_profile",
}

# Composio slugs read TOOLKIT_VERB_OBJECT. A slug with a changing verb needs approval; one
# with only reading verbs doesn't; anything unrecognized needs approval (fail closed).
WRITE_WORDS = {
    "SEND", "CREATE", "UPDATE", "DELETE", "REMOVE", "ADD", "INSERT", "APPEND", "MODIFY", "PATCH",
    "PUT", "POST", "REPLY", "FORWARD", "MOVE", "ARCHIVE", "TRASH", "UNTRASH", "UPLOAD", "SET",
    "CLEAR", "CANCEL", "REFUND", "FULFILL", "PUBLISH", "SHARE", "INVITE", "MARK", "LABEL",
    "UNLABEL", "WRITE", "EDIT", "RENAME", "COPY", "DUPLICATE", "MERGE", "SUBMIT", "PAY",
    "CHARGE", "TRANSFER", "APPROVE", "REJECT", "ASSIGN", "SCHEDULE", "BOOK", "ENABLE",
    "DISABLE", "START", "STOP", "RUN", "EXECUTE", "TRIGGER", "IMPORT", "SYNC", "SUBSCRIBE",
    "UNSUBSCRIBE", "ACCEPT", "DECLINE", "RESPOND", "CLOSE", "RESTORE", "EMPTY", "PIN", "STAR",
    "MUTE", "REPLACE", "ADJUST", "COMPLETE", "RESOLVE", "INVOKE", "SAVE", "DRAFT",
}
READ_WORDS = {
    "GET", "LIST", "FETCH", "SEARCH", "FIND", "READ", "QUERY", "RETRIEVE", "LOOKUP", "COUNT",
    "DOWNLOAD", "EXPORT", "VIEW", "DESCRIBE", "CHECK", "PREVIEW", "ANALYZE", "SUMMARIZE",
}
# Tools that act in the world without a Composio slug to read.
ACTION_TOOLS = {"act"}
# Tools that run arbitrary code. Code can build tool slugs at runtime or call any API over
# the network, so reading it can't prove it only reads: every run needs approval.
CODE_TOOLS = {"composio_remote_workbench", "composio_remote_bash_tool"}


def slug_changes_things(slug):
    tokens = str(slug or "").upper().split("_")[1:]
    if any(t in WRITE_WORDS for t in tokens):
        return True
    return not any(t in READ_WORDS for t in tokens)


def needs_approval(name, arguments):
    """Whether a routed call changes something in the owner's accounts."""
    if name in ACTION_TOOLS:
        return True
    if name == "composio_multi_execute_tool":
        calls = arguments.get("tools") if isinstance(arguments, dict) else None
        if not isinstance(calls, list):
            return True
        return any(not isinstance(c, dict) or slug_changes_things(c.get("tool_slug")) for c in calls)
    if name in CODE_TOOLS:
        return True
    # Composio's own meta tools (connections, skills, feedback) change or send things unless
    # listed as lookups; new ones fail closed.
    if name.startswith("composio_") and name not in LOOKUP_TOOLS:
        return True
    return False


class ToolGatewayComponent(Component):
    display_name = "Tool Gateway"
    description = "Dynamic discovery and execution of connected tools with compact tool context."
    icon = "waypoints"
    name = "ToolGatewayComponent"

    inputs = [
        HandleInput(name="tools", display_name="Tools", input_types=["Tool"], is_list=True, required=True),
        IntInput(name="max_results", display_name="Max Discovery Results", value=3, advanced=True),
        IntInput(name="max_result_chars", display_name="Max Result Characters", value=4000, advanced=True),
        IntInput(name="lookup_timeout", display_name="Lookup Timeout (seconds)", value=45, advanced=True,
                 info="Read-only lookups (tool search, schemas, memory, web search). Retried once on timeout."),
        IntInput(name="work_timeout", display_name="Work Timeout (seconds)", value=200, advanced=True,
                 info="Everything else (workbench, browser, app actions). Never retried automatically."),
    ]
    outputs = [Output(display_name="Gateway Tools", name="gateway_tools", method="build_gateway_tools", types=["Tool"])]

    def build_gateway_tools(self):
        registry = {}
        def add(value):
            if isinstance(value, (list, tuple)):
                for child in value:
                    add(child)
            elif isinstance(value, BaseTool):
                key = value.name
                n = 2
                while key in registry:
                    key = f"{value.name}_{n}"
                    n += 1
                registry[key] = value
        add(self.tools)
        if not registry:
            raise ValueError("No executable Tool objects received by gateway. Connect Tool outputs to Tools input.")
        max_hits = max(1, min(5, int(self.max_results or 3)))
        max_chars = max(500, int(self.max_result_chars or 4000))
        cache = {}

        def discover(query: str) -> str:
            key = query.strip().lower()
            if key in cache:
                return cache[key]
            original = words(query)
            expanded = set(original)
            for token in original:
                expanded.update(ALIASES.get(token, set()))
            # User-intent mapping avoids generic "search" outranking a specific profile lookup.
            wants_profile = ("me" in original or "user" in original or "myself" in original) and bool(original & {"know", "profile", "about", "identity"})
            ranked = []
            for name, tool in registry.items():
                n = words(name)
                d = words((tool.description or "")[:400])
                score = 5 * len(original & n) + 2 * len(expanded & n) + len(original & d)
                if wants_profile:
                    if "get_profile" in name.lower():
                        score += 50
                    elif "search_memory" in name.lower():
                        score += 10
                # Avoid irrelevant general-purpose discovery during personal-memory lookups.
                if wants_profile and "composio" in name.lower():
                    score -= 15
                if score > 0:
                    ranked.append((score, name, tool))
            ranked.sort(key=lambda row: (-row[0], row[1]))
            hits = ranked[:max_hits]
            data = [{"name": name, "description": (tool.description or "")[:180],
                     "parameters": compact_schema(original_schema(tool))}
                    for _, name, tool in hits]
            response = json.dumps(data, ensure_ascii=False, default=str)
            if not hits:
                response = json.dumps({"matches": [], "hint": "Try a more specific query or tool name."})
            cache[key] = response
            return response

        def route(name, arguments):
            # Agents sometimes wrap a call in execute_tool twice; unwrap to the inner tool.
            for _ in range(3):
                if name != "execute_tool":
                    break
                inner = arguments
                if isinstance(inner, str):
                    try:
                        inner = json.loads(inner) if inner.strip() else {}
                    except json.JSONDecodeError:
                        break
                if not isinstance(inner, dict) or not isinstance(inner.get("tool_name"), str):
                    break
                name, arguments = inner["tool_name"], inner.get("arguments") or {}
            # Agents sometimes call a Composio tool slug (e.g. GRANOLA_MCP_QUERY_GRANOLA_MEETINGS)
            # directly. Send it through Composio's executor instead of failing.
            if name not in registry and COMPOSIO_SLUG.match(name or "") and "composio_multi_execute_tool" in registry:
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments) if arguments.strip() else {}
                    except json.JSONDecodeError:
                        return name, arguments
                return "composio_multi_execute_tool", {
                    "tools": [{"tool_slug": name, "arguments": arguments or {}}],
                    "sync_response_to_workbench": False,
                }
            return name, arguments

        def prepare(name, arguments):
            tool = registry.get(name)
            if tool is None:
                return None, None, f"Unknown tool '{name}'. Close matches: {difflib.get_close_matches(name, registry.keys(), n=3)}"
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments) if arguments.strip() else {}
                except json.JSONDecodeError as exc:
                    return None, None, f"Tool arguments must be valid JSON: {exc}"
            if arguments is None:
                arguments = {}
            if not isinstance(arguments, dict):
                return None, None, "Tool arguments must be a JSON object."
            if name == "composio_multi_execute_tool":
                # Required by Composio but irrelevant here; agents leave it out.
                arguments = {"sync_response_to_workbench": False, **arguments}
            try:
                model = getattr(tool, "args_schema", None)
                if isinstance(model, type) and issubclass(model, BaseModel):
                    model.model_validate(arguments)
                elif isinstance(model, dict):
                    missing = [k for k in model.get("required", []) if k not in arguments]
                    if missing:
                        raise ValueError(f"Missing required fields: {missing}")
            except (ValidationError, ValueError) as exc:
                return None, None, f"Invalid arguments for {name}: {exc}. Required fields must be supplied; do not invent IDs or namespaces."
            return tool, arguments, None

        # Per-tool deadlines: a hung lookup fails fast (and is retried once, since it changes
        # nothing); real work gets a long deadline and is never retried automatically.
        lookup_timeout = int(getattr(self, "lookup_timeout", 45) or 45)
        work_timeout = int(getattr(self, "work_timeout", 200) or 200)

        approval_hint = ("This changes something in the owner's accounts, so it needs their approval. "
                         "Call take_action with the same tool_name and arguments plus a one-sentence summary.")

        async def execute_async(tool_name: str, arguments=None, config: RunnableConfig = None) -> str:
            return await run_async(tool_name, arguments, config, approved=False)

        refused = "Approvals aren't available in this run, so nothing was changed. Tell the owner what you would have done."

        def approvals_active(config):
            # The Agent only gives tools a thread_id when it was built with approval
            # interrupts and a checkpointer; without one, nothing paused before this call.
            return bool(((config or {}).get("configurable") or {}).get("thread_id"))

        async def action_async(tool_name: str, arguments=None, summary: str = "", config: RunnableConfig = None) -> str:
            # Reaching this body with approvals active means the owner approved the call.
            if not approvals_active(config):
                return refused
            return await run_async(tool_name, arguments, config, approved=True)

        async def run_async(tool_name, arguments, config, approved):
            tool_name, arguments = route(tool_name, arguments)
            tool, params, error = prepare(tool_name, arguments)
            if error:
                return error
            if not approved and needs_approval(tool_name, params):
                return approval_hint
            lookup = tool_name in LOOKUP_TOOLS
            limit = lookup_timeout if lookup else work_timeout
            attempts = 2 if lookup else 1
            for attempt in range(attempts):
                try:
                    try:
                        result = await asyncio.wait_for(tool.ainvoke(params, config=config), timeout=limit)
                    except NotImplementedError:
                        result = await asyncio.wait_for(asyncio.to_thread(tool.invoke, params, config), timeout=limit)
                    return compact_result(result, max_chars)
                except asyncio.TimeoutError:
                    if attempt + 1 < attempts:
                        continue
                    tried = " (tried twice)" if attempts > 1 else ""
                    hint = ("The service didn't respond; try another approach or tell the user." if lookup else
                            "It may or may not have finished; check before retrying, and tell the user.")
                    return f"Tool {tool_name} timed out after {limit}s{tried}. {hint}"
                except Exception as exc:
                    return f"Tool {tool_name} failed: {type(exc).__name__}: {exc}. Do not blindly retry writes."

        def run_sync(tool_name, arguments, config, approved):
            tool_name, arguments = route(tool_name, arguments)
            tool, params, error = prepare(tool_name, arguments)
            if error:
                return error
            if not approved and needs_approval(tool_name, params):
                return approval_hint
            try:
                return compact_result(tool.invoke(params, config=config), max_chars)
            except Exception as exc:
                return f"Tool {tool_name} failed: {type(exc).__name__}: {exc}. Do not blindly retry writes."

        def execute_sync(tool_name: str, arguments=None, config: RunnableConfig = None) -> str:
            return run_sync(tool_name, arguments, config, approved=False)

        def action_sync(tool_name: str, arguments=None, summary: str = "", config: RunnableConfig = None) -> str:
            if not approvals_active(config):
                return refused
            return run_sync(tool_name, arguments, config, approved=True)

        async def discover_async(query: str) -> str:
            return discover(query)

        def remember(content: str, scope: str = "workspace", category: str = "other") -> str:
            # The app saves this to the caller's own memory (it knows whose; this flow doesn't)
            # and shows it with an Undo. Nothing is stored here; the structured result is what
            # the app reads.
            text = " ".join(str(content or "").split())[:500]
            if not text:
                return "Nothing to remember: content is empty."
            return json.dumps({
                "memory_proposal": {
                    "content": text,
                    "scope": "personal" if scope == "personal" else "workspace",
                    "category": category if category in MEMORY_CATEGORIES else "other",
                },
                "note": "Remembered. The owner sees it and can undo it; no need to mention it.",
            })

        async def remember_async(content: str, scope: str = "workspace", category: str = "other") -> str:
            return remember(content, scope, category)

        available = capabilities(registry)
        offers = f"Available behind it: {', '.join(available)}. " if available else ""
        self.status = f"Gateway registered {len(registry)} tools; agent sees discover_tools, execute_tool, take_action, remember"
        return [
            StructuredTool.from_function(
                func=discover, coroutine=discover_async, name="discover_tools",
                args_schema=DiscoverArgs,
                description=(f"Discover relevant tools. {offers}When the user asks you to look something up, search, "
                             "research, or check something, use a tool rather than answering from memory. Returns exact "
                             "names and compact argument schemas; query again if task changes. Call a returned tool "
                             "through execute_tool or take_action, never by its name directly."),
            ),
            StructuredTool.from_function(
                func=execute_sync, coroutine=execute_async, name="execute_tool",
                args_schema=ExecuteArgs,
                description=("Execute a discovered tool by exact name with schema-valid arguments, for looking things up "
                             "and working with data. Anything that sends, creates, changes, or deletes something in the "
                             "owner's accounts must use take_action instead. Errors are not successful results."),
            ),
            StructuredTool.from_function(
                func=action_sync, coroutine=action_async, name="take_action",
                args_schema=ActionArgs,
                description=("Do something that changes the owner's accounts (send, create, update, delete, post, pay, "
                             "browser actions). The owner sees your summary and approves or declines before it runs; "
                             "if declined, don't retry it, say what you would have done instead."),
                metadata={"approval_actions": ["approve", "reject"]},
            ),
            StructuredTool.from_function(
                func=remember, coroutine=remember_async, name="remember",
                args_schema=MemoryArgs,
                description=("Remember a lasting fact for future conversations: how the business works, people and "
                             "suppliers, standing preferences, or a correction to something you remembered. Call it on "
                             "your own whenever you learn one, without asking; the owner can undo it. Never one-off "
                             "results, links, or numbers that go stale, and nothing already in what you remember."),
            ),
        ]
