"""Dynamic Tool Gateway for Langflow: discover_tools, execute_tool, take_action, remember, ask_user, show_form, propose_agent.

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
    scope: str = Field(default="workspace", description="'workspace' for facts about what this workspace is for (its work, people, and goals); 'personal' for this user's own preferences.")
    category: str = Field(default="other", description="What the fact is about: customers (people and contacts), suppliers (companies and organizations), products (work, offerings, and pricing), policies (rules and standing preferences), voice (tone and style), team, or other.")


PLAN_STEP_SCHEMA = {
    "type": "object",
    "properties": {
        "text": {"type": "string", "description": "The step, in a short plain sentence."},
        "status": {"type": "string", "description": "todo, doing, done, blocked, or needs_you (waiting on the owner)."},
        "note": {"type": "string", "description": "Optional: what happened or what's blocking it, in one line."},
    },
    "required": ["text", "status"],
}


class PlanArgs(BaseModel):
    steps: list[dict] = Field(description=("The task's whole plan, in order, replacing the old one: each step an object "
                                           "with text, status (todo, doing, done, blocked, needs_you), and an optional note."),
                              json_schema_extra={"items": PLAN_STEP_SCHEMA})


class RecordArgs(BaseModel):
    collection: str = Field(description="Which list it belongs to, a short lowercase name, e.g. applications, contacts, companies.")
    key: str = Field(description=("What makes it unique in that list, so saving it again updates it: e.g. the job "
                                  "posting's link, a person's profile link or email, a company's domain."))
    title: str = Field(default="", description="What the owner sees, e.g. 'Senior PM, Payments — Acme'.")
    status: str = Field(default="", description="Where it stands, one or two words, e.g. discovered, applied, replied.")
    url: str = Field(default="", description="Its http(s) link exactly as a tool returned it, if any.")
    fields: dict = Field(default_factory=dict, description="Any other details as short key-value pairs, e.g. {'score': 4, 'location': 'Remote'}.")


class RunReportArgs(BaseModel):
    outcome: str = Field(description=("nothing_new if this run found nothing worth the owner's attention, update if "
                                      "there's something for them to read, needs_you if they must decide or act."))
    summary: str = Field(default="", description="One short sentence for the notification, e.g. '3 new roles match; 1 recruiter replied'.")


# Nested argument shapes are plain JSON schema rather than nested models: LangChain rebuilds
# a tool's argument model where nested model names can't be resolved inside Langflow, and the
# agent then sees the tool with no arguments at all.
TIMELINE_ENTRY_SCHEMA = {
    "type": "object",
    "properties": {
        "when": {"type": "string", "description": "When it happened, from the record: ISO date or date-time, e.g. 2026-10-06."},
        "what": {"type": "string", "description": "What happened, in one plain sentence, e.g. 'Stripe refunded 4 orders ($612)'."},
        "app": {"type": "string", "description": "The app's toolkit slug in lower case, e.g. stripe, shopify, gmail, googlecalendar."},
        "url": {"type": "string", "description": "The record's https link exactly as a tool result returned it; empty if none."},
    },
    "required": ["when", "what"],
}
TIMELINE_CAUSE_SCHEMA = {
    "type": "object",
    "properties": {
        "text": {"type": "string", "description": "One likely cause, in a plain sentence."},
        "entries": {"type": "array", "items": {"type": "integer"}, "description": "Indexes into entries that support this cause."},
    },
    "required": ["text"],
}


class TimelineArgs(BaseModel):
    question: str = Field(description="What was investigated, e.g. 'Why revenue dipped on Tue Oct 6' or 'Trip plans for December'.")
    entries: list[dict] = Field(description=("Dated records found in the owner's apps, one per record, each an object "
                                             "with keys when (ISO date), what (one sentence), app (toolkit slug), and "
                                             "url (the record's link)."),
                                json_schema_extra={"items": TIMELINE_ENTRY_SCHEMA})
    causes: list[dict] = Field(default_factory=list, description="For a why question, likely causes, most likely first. Empty otherwise.",
                               json_schema_extra={"items": TIMELINE_CAUSE_SCHEMA})


CITATION_SCHEMA = {
    "type": "object",
    "properties": {
        "n": {"type": "integer", "description": "The citation number you'll write as [n] in your answer, starting at 1."},
        "url": {"type": "string", "description": "The source's https link exactly as a tool result returned it."},
        "quote": {"type": "string", "description": "A short passage (a phrase or sentence, under 300 characters) copied word for word from that tool result, containing the fact."},
    },
    "required": ["n", "url", "quote"],
}


class CiteArgs(BaseModel):
    sources: list[dict] = Field(description="One entry per fact you'll cite, numbered from 1. Reuse a number for the same passage.",
                                json_schema_extra={"items": CITATION_SCHEMA, "minItems": 1, "maxItems": 30})
VISUAL_SERIES_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "description": "What the series measures, e.g. 'Revenue' or '2025'."},
        "values": {"type": "array", "items": {"type": "number"}, "description": "One number per label, in label order; null where unknown."},
    },
    "required": ["name", "values"],
}
VISUAL_STAT_SCHEMA = {
    "type": "object",
    "properties": {
        "label": {"type": "string", "description": "What the number is, e.g. 'Orders this week'."},
        "value": {"type": "string", "description": "The number as people say it, e.g. '$4,120' or '5 days'."},
        "change": {"type": "string", "description": "Optional change against what, e.g. '-18% vs last week'."},
        "tone": {"type": "string", "enum": ["good", "bad", "neutral"], "description": "Whether the change is good or bad news."},
    },
    "required": ["label", "value"],
}


class VisualArgs(BaseModel):
    kind: str = Field(description=("chart (numbers across dates or categories), stats (2-6 key numbers), or table "
                                   "(things compared side by side, e.g. options, bookings, people)."))
    title: str = Field(description="What it shows, e.g. 'Daily revenue, Oct 1-14' or 'Trip bookings'.")
    app: str = Field(default="", description="The app the data came from, as a lower-case toolkit slug (e.g. shopify), if one.")
    chart: str = Field(default="bar", description="For kind=chart: bar or line (line for trends over time).")
    unit: str = Field(default="", description="For kind=chart: the values' unit, e.g. '$', 'orders', '%'.")
    labels: list[str] = Field(default_factory=list, description="For kind=chart: the x-axis labels (dates or categories), 2-31 of them.")
    series: list[dict] = Field(default_factory=list, description=("For kind=chart: 1-4 series, each an object with keys "
                                                                  "name and values (one number per label)."),
                               json_schema_extra={"items": VISUAL_SERIES_SCHEMA})
    items: list[dict] = Field(default_factory=list, description=("For kind=stats: 2-6 objects with keys label, value, "
                                                                 "and optionally change and tone (good, bad, neutral)."),
                              json_schema_extra={"items": VISUAL_STAT_SCHEMA})
    columns: list[str] = Field(default_factory=list, description="For kind=table: 2-6 column headings.")
    rows: list[list[str]] = Field(default_factory=list, description="For kind=table: up to 20 rows, one cell per column.")


QUESTION_SCHEMA = {
    "type": "object",
    "properties": {
        "question": {"type": "string", "description": "The question, one sentence ending in a question mark."},
        "header": {"type": "string", "description": "A 1-3 word label for it, e.g. 'Tone' or 'Date range'."},
        "options": {
            "type": "array", "minItems": 2, "maxItems": 4,
            "description": "2-4 distinct choices, your recommendation first. Don't add 'Other'; the owner can always type their own answer.",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string", "description": "The choice as the owner would say it, 1-6 words."},
                    "description": {"type": "string", "description": "Optional: what picking it means, one short sentence."},
                },
                "required": ["label"],
            },
        },
        "multi_select": {"type": "boolean", "description": "True when more than one choice can apply."},
    },
    "required": ["question", "options"],
}


class AskArgs(BaseModel):
    questions: list[dict] = Field(description="1-3 questions, asked together.",
                                  json_schema_extra={"items": QUESTION_SCHEMA, "minItems": 1, "maxItems": 3})


FORM_FIELD_SCHEMA = {
    "type": "object",
    "properties": {
        "kind": {"type": "string", "enum": ["choice", "multi_choice", "rank", "scale", "verdict", "text", "long_text", "file", "list", "connect"],
                 "description": ("choice or multi_choice (2-8 options), rank (the owner puts 2-8 options in order, "
                                 "most important first), scale (one point between two labelled ends, e.g. 'Ask me "
                                 "first' to 'Just do it'), verdict (results you found or drafted for the owner to "
                                 "keep or pass on, a pass with a reason), text (one line), long_text (a paragraph), "
                                 "file (the owner drops in files, e.g. a resume), list (repeatable entries with the "
                                 "same parts, e.g. stories), connect (apps to connect, shown as Connect buttons). "
                                 "Prefer something the owner can react to (choices drafted from what you know, a "
                                 "rank, a scale, a verdict) over an empty text box.")},
        "id": {"type": "string", "description": "A short snake_case id, unique in the form, e.g. 'target_roles'."},
        "label": {"type": "string", "description": "The question or label, as the owner would read it."},
        "help": {"type": "string", "description": "Optional: one short line on what to put, or why you ask."},
        "required": {"type": "boolean", "description": "True only when you can't go on without it."},
        "options": {"type": "array", "items": {"type": "string"}, "description": "For choice, multi_choice, and rank: 2-8 choices."},
        "allow_other": {"type": "boolean", "description": ("For choice and multi_choice: a 'Something else' choice they can type is "
                                                         "on by default; false only for a truly closed question (e.g. yes/no).")},
        "steps": {"type": "integer", "description": "For scale: how many points, 3-7 (default 5)."},
        "low": {"type": "string", "description": "For scale: what the first point means, e.g. 'Ask me first'."},
        "high": {"type": "string", "description": "For scale: what the last point means, e.g. 'Just do it'."},
        "items": {"type": "array", "description": ("For verdict: 1-8 real results in ONE field, each an object with title, body "
                                                   "(one or two lines on why it might fit), link (its URL, if it has one), and "
                                                   "record ({collection, key}) when it's a tracker row. The card adds the Keep "
                                                   "and Pass buttons itself; don't list them."),
                  "items": {"type": "object", "properties": {"title": {"type": "string"}, "body": {"type": "string"}, "link": {"type": "string"},
                                                             "record": {"type": "object", "properties": {"collection": {"type": "string"}, "key": {"type": "string"}}}},
                            "required": ["title"]}},
        "reasons": {"type": "array", "items": {"type": "string"}, "description": "For verdict: 2-6 short reasons someone might pass, e.g. 'Too junior', 'Not remote'."},
        "placeholder": {"type": "string", "description": "For text and long_text: an example answer."},
        "prefill": {"description": ("What you already know, for the owner to confirm or fix: a string for text and "
                                    "long_text, a list of option labels for choices, every option label in your "
                                    "suggested order for rank, a number for scale, or for list a list of objects "
                                    "keyed by part id (your drafts).")},
        "accept": {"type": "array", "items": {"type": "string"}, "description": "For file: allowed extensions, e.g. ['pdf', 'docx']."},
        "keep": {"type": "boolean", "description": ("For file: true to keep the files in this agent's files, so they come with "
                                                    "every future conversation (e.g. a resume). False for a one-off file.")},
        "max": {"type": "integer", "description": "For file and list: the most files or entries (1-8)."},
        "parts": {"type": "array", "description": "For list: 1-5 parts of each entry, each an object with id, label, and long (true for a paragraph).",
                  "items": {"type": "object", "properties": {"id": {"type": "string"}, "label": {"type": "string"}, "long": {"type": "boolean"}},
                            "required": ["label"]}},
        "item_label": {"type": "string", "description": "For list: what one entry is called, e.g. 'Story'."},
        "apps": {"type": "array", "items": {"type": "string"}, "description": "For connect: app ids, e.g. ['gmail', 'apollo', 'hunter']."},
    },
    "required": ["kind", "label"],
}


class FormArgs(BaseModel):
    title: str = Field(description="What the form is for, 2-6 words, e.g. 'Your search'.")
    intro: str = Field(default="", description="Optional: one or two sentences on why you're asking.")
    fields: list[dict] = Field(description="1-8 fields, in the order the owner fills them in.",
                               json_schema_extra={"items": FORM_FIELD_SCHEMA, "minItems": 1, "maxItems": 8})
    submit_label: str = Field(default="", description="Optional button text, e.g. 'Next' or 'Save stories'.")


PROPOSED_TASK_SCHEMA = {
    "type": "object",
    "properties": {
        "template_task_id": {"type": "string", "description": "The id of a task CONTEXT lists as already set up (paused), to switch it on."},
        "title": {"type": "string", "description": "The task, 2-6 words."},
        "instructions": {"type": "string", "description": "What to do each run, in the owner's terms."},
        "skill": {"type": "string", "description": "Optional: a library skill id it runs with."},
        "schedule": {"type": "object", "description": ("When it runs: {every: 'day'|'weekdays', at: 'HH:MM'}, "
                                                        "{every: 'week', at: 'HH:MM', weekday: 0-6 (0 = Sunday)}, "
                                                        "{every: 'hours', hours: 1-24}, or null for on demand.")},
    },
    "required": ["title", "instructions"],
}


class ProposeArgs(BaseModel):
    summary: str = Field(description="Two or three sentences: what this agent will do for the owner, in their words.")
    profile: str = Field(default="", description="The agent's 'What this agent is for', rewritten from what the owner told you.")
    instructions: str = Field(default="", description="Standing instructions for the agent, tuned to the owner's answers. The whole text.")
    skills: list = Field(default_factory=list, description=("Library skill ids to add, or new skills as objects with name, "
                                                           "description, and instructions."))
    tasks: list[dict] = Field(default_factory=list, description="Recurring or on-demand tasks to switch on.",
                              json_schema_extra={"items": PROPOSED_TASK_SCHEMA, "maxItems": 8})
    memories: list[str] = Field(default_factory=list, description="Lasting facts to remember about the owner, one sentence each.")


# Explicit rebuild prevents some custom-component code evaluators from losing namespaces.
DiscoverArgs.model_rebuild()
ExecuteArgs.model_rebuild()
ActionArgs.model_rebuild()
MemoryArgs.model_rebuild()
TimelineArgs.model_rebuild()
CiteArgs.model_rebuild()
VisualArgs.model_rebuild()
AskArgs.model_rebuild()
FormArgs.model_rebuild()
ProposeArgs.model_rebuild()


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


# Web search results get a bigger budget than other tools, shared across every source, so a
# search reads all the sources it found instead of the first few in full.
WEB_RESULT_CHARS = 12000


def web_results(payload):
    """The sources in a list of web results (e.g. Exa's search), or None for anything else."""
    items = getattr(payload, "results", None)
    if items is None and isinstance(payload, dict):
        items = payload.get("results")
    if not isinstance(items, list) or not items:
        return None
    field = lambda item, key: item.get(key) if isinstance(item, dict) else getattr(item, key, None)
    sources = []
    for item in items:
        url = field(item, "url")
        if not isinstance(url, str) or not url.startswith("http"):
            return None
        body = next((v for k in ("highlights", "summary", "text", "snippet", "description", "content") if (v := field(item, k))), "")
        if isinstance(body, list):
            body = " … ".join(str(b) for b in body)
        sources.append({"title": " ".join(str(field(item, "title") or "").split()), "url": url,
                        "published": str(field(item, "published_date") or field(item, "publishedDate") or "")[:10],
                        "body": " ".join(str(body).split())})
    return sources


def compact_web_results(sources, limit):
    """Every source as Title/URL/Published/text, each trimmed to its share of the budget."""
    budget = max(limit, WEB_RESULT_CHARS)
    share = max(300, budget // len(sources))
    blocks = []
    for s in sources:
        head = f"Title: {s['title']}\nURL: {s['url']}" + (f"\nPublished: {s['published']}" if s["published"] else "")
        room = max(150, share - len(head))
        body = s["body"] if len(s["body"]) <= room else s["body"][:room].rsplit(" ", 1)[0] + " …"
        blocks.append(head + (f"\n{body}" if body else ""))
    return f"{len(sources)} results\n\n" + "\n\n".join(blocks)


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
    sources = web_results(payload)
    if sources:
        return compact_web_results(sources, limit)
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

        def update_plan(steps: list) -> str:
            # Like remember, this changes nothing here: the app checks the plan and saves it to
            # the task this conversation belongs to, where the owner can edit it.
            def plain(v):
                return v.model_dump() if hasattr(v, "model_dump") else dict(v) if isinstance(v, dict) else {"text": str(v)}
            rows = [plain(s) for s in (steps or [])][:30]
            rows = [{k: " ".join(str(r.get(k) or "").split())[:300] for k in ("text", "status", "note")} for r in rows]
            rows = [r for r in rows if r["text"]]
            if not rows:
                return "No plan to save: give at least one step with text."
            return json.dumps({"plan_update": {"steps": rows},
                               "note": "Plan saved. The owner sees it with the task; no need to repeat it."})

        async def update_plan_async(steps: list) -> str:
            return update_plan(steps)

        def save_record(collection: str, key: str, title: str = "", status: str = "", url: str = "", fields: dict | None = None) -> str:
            # The app upserts this into the owner's own tracker (by collection and key). Nothing
            # is stored here and no outside account changes, so it needs no approval.
            collection = "-".join(str(collection or "").lower().split())[:40]
            key = " ".join(str(key or "").split())[:200]
            if not collection or not key:
                return "Not saved: give a collection and a key."
            extra = fields.model_dump() if hasattr(fields, "model_dump") else dict(fields or {})
            record = {"collection": collection, "key": key, "title": " ".join(str(title or "").split())[:200],
                      "status": " ".join(str(status or "").split())[:40], "url": str(url or "").strip()[:2000],
                      "fields": {str(k)[:60]: v for k, v in list(extra.items())[:30]}}
            return json.dumps({"record": record, "note": (
                "Saved to the owner's tracker. If it's a new result you found for them (a role, a lead, an "
                "option), not their own entry or a status change: once all of this reply's results are saved, "
                "end with show_form and one verdict field holding them (each with its record, link, and a line "
                "on why), so they keep or pass each, rather than listing them in your text.")})

        async def save_record_async(collection: str, key: str, title: str = "", status: str = "", url: str = "", fields: dict | None = None) -> str:
            return save_record(collection, key, title, status, url, fields)

        def report_run(outcome: str, summary: str = "") -> str:
            # The app reads this to decide whether to notify the owner; it changes nothing.
            outcome = outcome if outcome in ("nothing_new", "update", "needs_you") else "update"
            return json.dumps({"run_report": {"outcome": outcome, "summary": " ".join(str(summary or "").split())[:300]},
                               "note": "Reported. Finish your reply briefly."})

        async def report_run_async(outcome: str, summary: str = "") -> str:
            return report_run(outcome, summary)

        def report_timeline(question: str, entries: list, causes: list | None = None) -> str:
            # Like remember, this changes nothing: the app reads the structured result, checks
            # each link against what this run's tools returned, and shows it as a timeline.
            def plain(v):
                return v.model_dump() if hasattr(v, "model_dump") else dict(v) if isinstance(v, dict) else {}
            # Models sometimes name the keys their own way (date, event, link); keep the record
            # rather than dropping the whole timeline, and refuse rows with no date or text.
            aliases = {"when": ("when", "date", "datetime", "time", "timestamp"),
                       "what": ("what", "event", "title", "description", "summary", "text"),
                       "url": ("url", "link", "href"), "app": ("app", "toolkit", "source")}
            rows = []
            for e in [plain(e) for e in (entries or [])][:80]:
                row = {k: next((e[a] for a in names if e.get(a)), None) for k, names in aliases.items()}
                rows.append({k: v for k, v in row.items() if v is not None})
            if not rows:
                return "Nothing to report: entries is empty."
            if not all(r.get("when") and r.get("what") for r in rows):
                return ("Not shown: every entry needs 'when' (ISO date) and 'what' (one sentence), plus 'app' and "
                        "'url' when known. Call report_timeline again with those keys.")
            return json.dumps({
                "timeline": {
                    "question": " ".join(str(question or "").split())[:300],
                    "entries": rows,
                    "causes": [plain(c) for c in (causes or [])][:10],
                },
                "note": "Timeline shown to the owner. Now answer briefly (the likely causes, for a why question) and say what you couldn't check.",
            })

        async def report_timeline_async(question: str, entries: list, causes: list | None = None) -> str:
            return report_timeline(question, entries, causes)

        def cite(sources: list) -> str:
            # Like report_timeline, this changes nothing: the app checks each link and quote
            # against what this run's tools returned and shows the ones that hold up as
            # numbered citations in the answer.
            def plain(v):
                return v.model_dump() if hasattr(v, "model_dump") else dict(v) if isinstance(v, dict) else {}
            aliases = {"n": ("n", "number", "id", "index"), "url": ("url", "link", "href"),
                       "quote": ("quote", "text", "excerpt", "passage", "snippet")}
            rows = []
            for e in [plain(e) for e in (sources or [])][:60]:
                row = {k: next((e[a] for a in names if e.get(a) not in (None, "")), None) for k, names in aliases.items()}
                rows.append({k: v for k, v in row.items() if v is not None})
            if not rows:
                return "Nothing to cite: sources is empty."
            if not all(r.get("n") is not None and r.get("url") and r.get("quote") for r in rows):
                return ("Not shown: every source needs 'n' (its number), 'url' (the link exactly as a tool returned it) and "
                        "'quote' (a short passage copied word for word from that result). Call cite again with those keys.")
            return json.dumps({
                "citations": {"sources": rows},
                "note": ("Now write your answer. Put [n] right after the sentence or figure each source supports, "
                         "e.g. 'Rated 4.5/5 from 9 reviews [2].' Don't add a list of sources or links at the end: "
                         "the owner sees them under your answer. If you'll end on a question with a few likely "
                         "answers (whether to go ahead, which first), ask it with ask_user after your answer "
                         "instead of writing it out."),
            })

        async def cite_async(sources: list) -> str:
            return cite(sources)
        def report_visual(kind: str, title: str, app: str = "", chart: str = "bar", unit: str = "",
                          labels: list | None = None, series: list | None = None, items: list | None = None,
                          columns: list | None = None, rows: list | None = None) -> str:
            # Like report_timeline, this changes nothing: the app validates the structured result
            # and draws it in Results next to the timeline. Only numbers and text the tools returned.
            def plain(v):
                return v.model_dump() if hasattr(v, "model_dump") else dict(v) if isinstance(v, dict) else {}
            def first(d, *names):
                return next((d[n] for n in names if d.get(n) not in (None, "")), None)
            kind = str(kind or "").strip().lower()
            visual = {"kind": kind, "title": " ".join(str(title or "").split())[:200], "app": str(app or "").strip().lower()}
            if kind == "chart":
                labels = [str(x) for x in (labels or [])][:31]
                lines = []
                for raw in [plain(x) for x in (series or [])][:4]:
                    values = first(raw, "values", "data", "points") or []
                    lines.append({"name": str(first(raw, "name", "label") or ""), "values": list(values)[:len(labels)]})
                if len(labels) < 2 or not lines or any(len(x["values"]) != len(labels) for x in lines):
                    return ("Not shown: a chart needs 2+ labels and 1-4 series, each with one value per label. "
                            "Call report_visual again.")
                visual.update({"chart": "line" if str(chart).lower() == "line" else "bar", "unit": str(unit or "")[:12],
                               "labels": labels, "series": lines})
            elif kind == "stats":
                stats = []
                for raw in [plain(x) for x in (items or [])][:6]:
                    stat = {"label": first(raw, "label", "name", "title"), "value": first(raw, "value", "number", "amount"),
                            "change": first(raw, "change", "delta"), "tone": first(raw, "tone")}
                    stats.append({k: str(v) for k, v in stat.items() if v is not None})
                if not stats or not all(x.get("label") and x.get("value") for x in stats):
                    return "Not shown: stats needs 1-6 items, each with label and value. Call report_visual again."
                visual["items"] = stats
            elif kind == "table":
                columns = [str(c) for c in (columns or [])][:6]
                table = [[str(c) for c in (r if isinstance(r, (list, tuple)) else [])][:len(columns)] for r in (rows or [])][:20]
                if len(columns) < 2 or not table:
                    return "Not shown: a table needs 2-6 columns and at least one row. Call report_visual again."
                visual.update({"columns": columns, "rows": table})
            else:
                return "Not shown: kind must be chart, stats, or table."
            return json.dumps({"visual": visual, "note": "Shown to the owner in Results; don't repeat it in your reply."})

        async def report_visual_async(kind: str, title: str, app: str = "", chart: str = "bar", unit: str = "",
                                      labels: list | None = None, series: list | None = None, items: list | None = None,
                                      columns: list | None = None, rows: list | None = None) -> str:
            return report_visual(kind, title, app, chart, unit, labels, series, items, columns, rows)

        def ask_user(questions: list) -> str:
            # Like remember, this changes nothing and doesn't wait: the app reads the structured
            # result and shows the questions as buttons under the reply. The owner's answer
            # arrives as their next message.
            def plain(v):
                return v.model_dump() if hasattr(v, "model_dump") else dict(v) if isinstance(v, dict) else {}
            items = []
            for q in [plain(q) for q in (questions or [])][:3]:
                options = [{"label": o} if isinstance(o, str) else plain(o) for o in (q.get("options") or [])][:4]
                if q.get("question") and len(options) >= 2:
                    items.append({**q, "options": options})
            if not items:
                return "Nothing to ask: each question needs text and at least two options."
            return json.dumps({
                "ask_user": {"questions": items},
                "note": ("The owner now sees these questions with the options as buttons. End your reply here: "
                         "at most one short sentence, without repeating the question or listing the options. "
                         "Their answer arrives as their next message."),
            })

        async def ask_user_async(questions: list) -> str:
            return ask_user(questions)

        def show_form(title: str, fields: list, intro: str = "", submit_label: str = "") -> str:
            # Like ask_user, this changes nothing and doesn't wait: the app validates the form and
            # shows it under the reply. The owner's answers arrive as their next message.
            def plain(v):
                return v.model_dump() if hasattr(v, "model_dump") else dict(v) if isinstance(v, dict) else {}
            items = [f for f in (plain(f) for f in (fields or [])[:8]) if f.get("label") and (f.get("kind") or f.get("type"))]
            if not str(title or "").strip() or not items:
                return "Not shown: a form needs a title and at least one field with a kind and a label."
            return json.dumps({
                "form": {"title": " ".join(str(title).split())[:120], "intro": str(intro or "")[:600],
                         "fields": items, "submit_label": " ".join(str(submit_label or "").split())[:30]},
                "note": ("The owner now sees this form. End your reply here: at most one short sentence, without "
                         "repeating the fields. Their answers arrive as their next message."),
            })

        async def show_form_async(title: str, fields: list, intro: str = "", submit_label: str = "") -> str:
            return show_form(title, fields, intro, submit_label)

        def propose_agent(summary: str, profile: str = "", instructions: str = "", skills: list | None = None,
                          tasks: list | None = None, memories: list | None = None) -> str:
            # Changes nothing: the app shows the proposal as a card, and only the owner's Apply
            # changes this agent's setup.
            def plain(v):
                return v.model_dump() if hasattr(v, "model_dump") else dict(v) if isinstance(v, dict) else v
            proposal = {"summary": str(summary or "")[:600], "profile": str(profile or "")[:8000],
                        "instructions": str(instructions or "")[:8000], "skills": [plain(x) for x in (skills or [])][:8],
                        "tasks": [plain(x) for x in (tasks or [])][:8], "memories": [str(m)[:500] for m in (memories or [])][:8]}
            if not any(proposal[k] for k in ("profile", "instructions", "skills", "tasks", "memories")):
                return "Not shown: propose at least one change (profile, instructions, skills, tasks, or memories)."
            return json.dumps({
                "proposal": proposal,
                "note": ("The owner now sees your proposal and can apply all or part of it; nothing changes until "
                         "they do. End your reply here with one short sentence."),
            })

        async def propose_agent_async(summary: str, profile: str = "", instructions: str = "", skills: list | None = None,
                                      tasks: list | None = None, memories: list | None = None) -> str:
            return propose_agent(summary, profile, instructions, skills, tasks, memories)

        available = capabilities(registry)
        offers = f"Available behind it: {', '.join(available)}. " if available else ""
        self.status = f"Gateway registered {len(registry)} tools; agent sees discover_tools, execute_tool, take_action, remember, report_timeline, report_visual, cite, ask_user, show_form, propose_agent"
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
                description=("Remember a lasting fact for future conversations: how the owner works, their goals, the people and "
                             "organizations they deal with, standing preferences, or a correction to something you remembered. Call it on "
                             "your own whenever you learn one, without asking; the owner can undo it. Never one-off "
                             "results, links, or numbers that go stale, and nothing already in what you remember."),
            ),
            StructuredTool.from_function(
                func=update_plan, coroutine=update_plan_async, name="update_plan",
                args_schema=PlanArgs,
                description=("Only in a conversation that works on a task or is this agent's setup interview (see "
                             "CONTEXT): write or update its plan or checklist, the whole list of steps each time. Call it when you make a plan and whenever "
                             "a step starts, finishes, gets blocked, or needs the owner. Saved for the owner; changes "
                             "nothing in their accounts."),
            ),
            StructuredTool.from_function(
                func=save_record, coroutine=save_record_async, name="save_record",
                args_schema=RecordArgs,
                description=("Add or update one row in the owner's tracker: a list kept across conversations, e.g. job "
                             "applications, people contacted, companies researched. Saving the same collection and key "
                             "again updates that row, so check the tracker in CONTEXT before adding. Only when "
                             "CONTEXT has a tracker section; otherwise nothing would be kept. Use it for "
                             "things the owner will want to follow over time, not one-off answers. Saved for the owner; "
                             "changes nothing in their accounts."),
            ),
            StructuredTool.from_function(
                func=report_run, coroutine=report_run_async, name="report_run",
                args_schema=RunReportArgs,
                description=("Only in a conversation that works on a task: once this run's work is done, say whether "
                             "the owner should hear about it. They get a notification for update and needs_you, none "
                             "for nothing_new. Changes nothing."),
            ),
            StructuredTool.from_function(
                func=report_timeline, coroutine=report_timeline_async, name="report_timeline",
                args_schema=TimelineArgs,
                description=("Only when the request asks you to investigate something: after reading the owner's apps, "
                             "report the dated records you found, each with the record's link exactly as a tool returned "
                             "it, and, for a why question, the likely causes. The owner sees it as a timeline. Changes nothing."),
            ),
            StructuredTool.from_function(
                func=cite, coroutine=cite_async, name="cite",
                args_schema=CiteArgs,
                description=("Before writing an answer that states facts you got from tool results (web pages, emails, "
                             "files, records), list the sources you'll cite: a number, the link exactly as the tool "
                             "returned it, and a short passage copied word for word from that result. Then write [n] "
                             "after each fact in your answer. The owner sees numbered citations they can check. "
                             "Changes nothing."),
            ),
            StructuredTool.from_function(
                func=report_visual, coroutine=report_visual_async, name="report_visual",
                args_schema=VisualArgs,
                description=("Show what you found, in the owner's apps or in your research, as a chart (numbers over "
                             "time or by category), key numbers, or a comparison table (e.g. roles or options side by "
                             "side on what the owner weighs: pay, location, stage, fit), when seeing it beats reading "
                             "it. Call it once per visual, only with numbers and facts a tool returned. Changes nothing."),
            ),
            StructuredTool.from_function(
                func=ask_user, coroutine=ask_user_async, name="ask_user",
                args_schema=AskArgs,
                description=("Ask the owner a question with a few choices to click, when you need their decision or a "
                             "missing detail and can't sensibly pick a default yourself (which of several matching "
                             "records, which way to go, whether to take a next step, a preference). Use it instead of "
                             "ending your reply on such a question in text. Don't use it to confirm a change to their "
                             "accounts (take_action already asks), or for things you can look up. Call it as the last "
                             "thing in your reply; their answer arrives as the next message."),
            ),
            StructuredTool.from_function(
                func=show_form, coroutine=show_form_async, name="show_form",
                args_schema=FormArgs,
                description=("Show the owner a short form when you need several details at once, an order of priorities "
                             "(rank), a point on a scale, their verdict on results you found (verdict), longer "
                             "answers, files (a resume, a price list), repeatable entries (stories, contacts), or "
                             "apps to connect: for example while setting up this agent. Whenever you bring them "
                             "results to act on (roles, leads, options you found), show those in one verdict field "
                             "so they keep or pass each. Draft answers they can react to and prefill what you already know, so "
                             "they mostly pick, order, or fix rather than type. Use ask_user instead for one quick "
                             "choice. Call it as the last thing in your reply; their answers arrive as the next "
                             "message. Changes nothing."),
            ),
            StructuredTool.from_function(
                func=propose_agent, coroutine=propose_agent_async, name="propose_agent",
                args_schema=ProposeArgs,
                description=("Propose how this agent should be set up for the owner: what it's for, its standing "
                             "instructions, skills to add, tasks to switch on (with schedules), and facts to remember. "
                             "Use it once you've learned what they want, e.g. at the end of setup or when they ask "
                             "you to change how you work. The owner reviews it and applies what they want; nothing "
                             "changes until they do. Call it as the last thing in your reply."),
            ),
        ]
