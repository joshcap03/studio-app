"""Studio Browser: Browserbase's hosted browser tools, one browser per conversation.

Replaces a shared Browserbase MCP node. Langflow reuses one MCP connection per URL and
headers for every run in the process, and Browserbase's hosted server keeps one active
browser per MCP connection, so a shared node put every tenant in the same browser: the same
cookies, logins and open pages. This node opens the hosted server once per conversation
instead, with an extra header derived from the run's session id
(`<workspace>.<member id>.<conversation>`), which Langflow restores when a paused run resumes
after an approval (tweaks it drops). Without a session id it returns no tools (fails closed).

The browser session `start` returns is bound to the conversation and passed on every later
call; the model never sees or sets a `sessionId` argument. A page tool called before `start`
opens the conversation's browser first (a new connection has none). Results drop the signed
CDP URL (`cdpUrl`, full control of the browser) and any other `signingKey`, so neither
reaches the model, chat history, or traces. When the plan's concurrent browsers are all in
use, opening one ends the browser idle longest (five minutes or more) in this process and tries
again; nothing else ends a browser early (Browserbase ends each after its session timeout).

Tool names stay Browserbase's (start, end, navigate, act, observe, extract): the Tool Gateway
routes `act` through take_action, so it still needs the owner's approval. Wire the output to
the Tool Gateway's Tools input. Authenticates with a Langflow global variable sent in one
header: the Browserbase key in `x-bb-api-key`, or "Bearer <key>" in `Authorization`
(install.py carries over whichever the shared node used).
Source of truth: langflow/components/studio_browser.py in the Studio repo.
"""

import hashlib
import json
import re
import time

from langchain_core.tools import StructuredTool
from lfx.base.agents.utils import safe_cache_get, safe_cache_set
from lfx.base.mcp.util import MCPStreamableHttpClient, update_tools
from lfx.custom.custom_component.component_with_cache import ComponentWithCache
from lfx.io import MessageTextInput, Output, SecretStrInput
from pydantic import create_model

# Header that gives each conversation its own MCP connection (and so its own browser). The
# value is a hash, so Browserbase never sees workspace, member, or conversation ids.
CONVERSATION_HEADER = "x-studio-conversation"
SESSION_ARGS = {"sessionId", "session_id"}
# Connection details that grant control of the browser. Dropped from every result.
SECRET_KEYS = {"cdpUrl", "connectUrl", "wsUrl", "debuggerUrl", "debuggerFullscreenUrl", "signingKey"}
SIGNED_URL = re.compile(r"""wss?://[^\s"'\\]*signingKey=[^\s"'\\&]*""")
SIGNING_KEY = re.compile(r"""signingKey=[^\s"'\\&]+""")
# Tool schemas are the same for every conversation; reuse them for an hour.
SCHEMA_TTL_S = 3600
# One conversation's connection and tools are reused this long between calls.
CONNECTION_TTL_S = 600
# At most this many conversations' connections are kept at once (the oldest go first), so the
# shared process doesn't grow with every conversation that ever browsed.
MAX_CONNECTIONS = 200
# A bound browser is forgotten after this long without use (Browserbase ends idle ones).
BINDING_TTL_S = 3600
# When the plan's concurrent browsers are all in use, `start` ends this process's browser
# that has been idle longest, if idle at least this long, and tries once more.
# (Long enough that an owner reading an approval card doesn't lose the browser it's for.)
MIN_IDLE_TO_END_S = 300
CONCURRENCY_LIMIT = re.compile(r"concurrent sessions", re.IGNORECASE)
# How lfx reports a client that lost its MCP session (the browser itself may be fine).
DISCONNECTED = re.compile(r"not initialized or disconnected", re.IGNORECASE)


def conversation_key(session_id: str) -> str:
    return hashlib.sha256(session_id.encode()).hexdigest()[:32]


def scrub_value(value):
    """Removes signed connection details from a parsed result, at any depth."""
    if isinstance(value, dict):
        return {k: scrub_value(v) for k, v in value.items() if k not in SECRET_KEYS}
    if isinstance(value, list):
        return [scrub_value(v) for v in value]
    if isinstance(value, str):
        return scrub_text(value)
    return value


def scrub_text(text: str) -> str:
    return SIGNING_KEY.sub("signingKey=[removed]", SIGNED_URL.sub("[removed]", text))


def clean_text(text: str) -> str:
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return scrub_text(text)
    return scrub_text(json.dumps(scrub_value(parsed), ensure_ascii=False))


def clean_result(result):
    """The same MCP result with signed connection details removed from its text."""
    content = getattr(result, "content", None)
    if not isinstance(content, list):
        return scrub_value(result) if isinstance(result, (dict, list, str)) else result
    cleaned = []
    for item in content:
        text = getattr(item, "text", None)
        cleaned.append(item.model_copy(update={"text": clean_text(text)}) if isinstance(text, str) else item)
    return result.model_copy(update={"content": cleaned})


def with_session(result, session: str | None):
    """The result with this conversation's browser session id put first in its JSON text, so the
    app can show its member that browser (view only). The id isn't a secret (start returns it too);
    its connection URL is, and stays stripped."""
    content = getattr(result, "content", None)
    if not session or not isinstance(content, list):
        return result
    tagged, out = False, []
    for item in content:
        text = getattr(item, "text", None)
        if not tagged and isinstance(text, str):
            try:
                parsed = json.loads(text)
            except (json.JSONDecodeError, TypeError):
                parsed = None
            if isinstance(parsed, dict):
                item = item.model_copy(update={"text": json.dumps({"studioBrowserSession": session, **parsed})})
                tagged = True
        out.append(item)
    return result.model_copy(update={"content": out})


def started_session(result) -> str | None:
    """The browser session id a successful `start` returned."""
    if getattr(result, "isError", False):
        return None
    for item in getattr(result, "content", None) or []:
        try:
            parsed = json.loads(getattr(item, "text", "") or "")
        except (json.JSONDecodeError, TypeError):
            continue
        data = parsed.get("data") if isinstance(parsed, dict) else None
        if isinstance(parsed, dict) and parsed.get("success") is not False and isinstance(data, dict):
            sid = data.get("sessionId")
            if isinstance(sid, str) and sid and data.get("available") is not False:
                return sid
    return None


def without_session_arg(model):
    """The tool's argument model minus its sessionId field, and that field's name."""
    fields = getattr(model, "model_fields", {}) or {}
    session_field = next((name for name, f in fields.items() if name in SESSION_ARGS or f.alias in SESSION_ARGS), None)
    if session_field is None:
        return model, None
    kept = {name: (f.annotation, f) for name, f in fields.items() if name != session_field}
    return create_model(model.__name__, **kept), session_field


class StudioBrowserComponent(ComponentWithCache):
    display_name = "Studio Browser"
    description = "Browserbase browser tools with one browser per conversation."
    icon = "globe"
    name = "StudioBrowser"

    inputs = [
        SecretStrInput(name="auth_value", display_name="Browserbase Credential", value="", required=True,
                       info="A Langflow global variable: the Browserbase key, or 'Bearer <key>' with Authorization."),
        MessageTextInput(name="auth_header", display_name="Credential Header", value="x-bb-api-key", advanced=True,
                         info="x-bb-api-key for a bare key, Authorization for 'Bearer <key>'."),
        MessageTextInput(name="url", display_name="Browserbase MCP URL", value="https://mcp.browserbase.com/mcp", advanced=True),
    ]
    outputs = [Output(display_name="Tools", name="tools", method="build_tools", types=["Tool"])]

    def _session_id(self) -> str | None:
        graph = getattr(self, "graph", None)
        sid = str(getattr(graph, "session_id", "") or "").strip()
        flow_id = str(getattr(graph, "flow_id", "") or "")
        # Langflow falls back to the flow id when a run has no session: that would be shared.
        if not sid or sid == flow_id:
            return None
        return sid

    async def build_tools(self):
        session_id = self._session_id()
        if session_id is None:
            self.status = "No conversation for this run: no browser tools"
            return []
        url = (self.url or "https://mcp.browserbase.com/mcp").strip()
        auth = self.auth_value or ""
        header = (self.auth_header or "x-bb-api-key").strip()
        if not url.startswith("https://") or not auth or not header:
            self.status = "Browserbase isn't configured: no browser tools"
            return []

        cache = self._shared_component_cache
        conv = conversation_key(session_id)
        server = hashlib.sha256(json.dumps([url, header, auth]).encode()).hexdigest()
        bindings_key = f"studio_browser:sessions:{server}"

        connections_key = f"studio_browser:tools:{server}"

        def connections() -> dict:
            """Each conversation's connection: {conversation: (opened, tools by name, client)}, fresh ones only."""
            now = time.monotonic()
            return {k: v for k, v in (safe_cache_get(cache, connections_key) or {}).items() if now - v[0] < CONNECTION_TTL_S}

        def forget_connection(key: str) -> None:
            """Drops a conversation's connection (after a failed call), so its next call reconnects."""
            current = connections()
            if current.pop(key, None) is not None:
                safe_cache_set(cache, connections_key, current)

        async def conversation_tools(key: str) -> dict:
            """One conversation's own MCP tools, connecting its own MCP session if needed."""
            cached = connections().get(key)
            # A client that lost its session refuses every call until it reconnects.
            if cached and getattr(cached[2], "_connected", True) is not False:
                return cached[1]
            client = MCPStreamableHttpClient(component_cache=cache)
            _, tools, _ = await update_tools(
                server_name="browserbase",
                server_config={
                    "mode": "Streamable_HTTP",
                    "url": url,
                    "headers": {header: auth, CONVERSATION_HEADER: key},
                },
                mcp_streamable_http_client=client,
            )
            by_name = {t.name: t for t in tools}
            if by_name:
                current = connections()
                current[key] = (time.monotonic(), by_name, client)
                if len(current) > MAX_CONNECTIONS:
                    current = dict(sorted(current.items(), key=lambda kv: kv[1][0])[-MAX_CONNECTIONS:])
                safe_cache_set(cache, connections_key, current)
            return by_name

        def bindings() -> dict:
            """Each conversation's browser session in this process: {conversation: (last used, id)}."""
            now = time.monotonic()
            return {k: v for k, v in (safe_cache_get(cache, bindings_key) or {}).items() if now - v[0] < BINDING_TTL_S}

        def bound() -> str | None:
            entry = bindings().get(conv)
            return entry[1] if entry else None

        def bind(sid: str | None) -> None:
            current = bindings()
            current.pop(conv, None)
            if sid:
                current[conv] = (time.monotonic(), sid)
            safe_cache_set(cache, bindings_key, current)

        async def make_room() -> bool:
            """Ends the browser idle longest (at least a minute) to free a concurrent session."""
            now = time.monotonic()
            idle = sorted((v[0], k, v[1]) for k, v in bindings().items() if k != conv and now - v[0] >= MIN_IDLE_TO_END_S)
            if not idle:
                return False
            _, key, sid = idle[0]
            current = bindings()
            current.pop(key, None)
            safe_cache_set(cache, bindings_key, current)
            end = (await conversation_tools(key)).get("end")
            if end is None:
                return False
            _, session_field = without_session_arg(end.args_schema)
            try:
                await end.coroutine(**({session_field: sid} if session_field else {}))
            except ValueError:
                pass  # Already ended; the slot is free either way.
            return True

        schema_key = f"studio_browser:schemas:{server}"
        schemas = safe_cache_get(cache, schema_key)
        if not schemas or time.monotonic() - schemas[0] > SCHEMA_TTL_S:
            try:
                listed = await conversation_tools(conv)
            except Exception as exc:  # noqa: BLE001  Browsing is optional; the rest of the run isn't.
                self.status = f"Browserbase unavailable: {type(exc).__name__}"
                return []
            schemas = (time.monotonic(), [(t.name, t.description or "", t.args_schema) for t in listed.values()])
            safe_cache_set(cache, schema_key, schemas)

        async def start(tool, kwargs: dict):
            """Starts (or reuses) this conversation's browser, making room once if the plan is full."""
            current = bound()
            _, session_field = without_session_arg(tool.args_schema)
            args = {**kwargs, **({session_field: current} if session_field and current else {})}
            try:
                return await tool.coroutine(**args)
            except ValueError as exc:
                if current and not DISCONNECTED.search(str(exc)):
                    # The bound browser ended; start a fresh one for this conversation.
                    bind(None)
                    return await tool.coroutine(**kwargs)
                if CONCURRENCY_LIMIT.search(str(exc)) and await make_room():
                    return await tool.coroutine(**kwargs)
                forget_connection(conv)
                raise

        def make_tool(name: str, description: str, model):
            public_model, session_field = without_session_arg(model)

            async def call(**kwargs):
                for arg in SESSION_ARGS:
                    kwargs.pop(arg, None)
                tools = await conversation_tools(conv)
                tool = tools.get(name)
                if tool is None:
                    msg = f"The browser has no tool '{name}' right now."
                    raise ValueError(msg)
                if name == "start":
                    result = await start(tool, kwargs)
                    bind(started_session(result))
                    return with_session(clean_result(result), bound())
                current = bound()
                if current is None and name != "end" and "start" in tools:
                    # A new connection has no browser yet; open this conversation's own first.
                    current = started_session(await start(tools["start"], {}))
                if current:
                    bind(current)  # In use from now: make_room counts idle time from here.
                if session_field and current:
                    kwargs[session_field] = current
                try:
                    result = await tool.coroutine(**kwargs)
                except Exception:
                    forget_connection(conv)
                    if current and bound() == current:
                        bind(None)  # Next call opens a fresh browser rather than retrying a dead one.
                    raise
                if name == "end" or bound() == current:
                    bind(None if name == "end" else current)
                return with_session(clean_result(result), None if name == "end" else current)

            return StructuredTool(
                name=name,
                description=description,
                args_schema=public_model,
                coroutine=call,
                tags=[name],
                metadata={"server_name": "browserbase"},
            )

        tools = [make_tool(name, description, model) for name, description, model in schemas[1]]
        self.status = f"{len(tools)} browser tools for this conversation"
        return tools
