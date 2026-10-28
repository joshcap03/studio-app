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
reaches the model, chat history, or traces.

The browser outlives the run that opened it: the member may take minutes to find a password or
a code the site sent them. So this node opens each conversation's browser itself through
Browserbase's API, kept alive across disconnects for BROWSER_TIMEOUT_S, and passes the new session
to `start`. It ends when the agent calls `end` (released through the API too, since keep-alive
outlasts the server's own close), at that timeout, or when the plan's concurrent browsers are all
in use and it's the one idle longest (MIN_IDLE_TO_END_S or more) in this process. If the plan
refuses keep-alive it opens without it; if Browserbase's API can't open one at all, `start` opens
the server's own.

Saved sign-ins: the app fills `context_id` per run with the member's own Browserbase context (one
per person), and the browser opens with it (persisted, so a site the member signed in to there
stays signed in once that browser closes). Tweaks are dropped when a paused run resumes, so the
member's context is also kept in the process cache under their id from the session id.

Residential proxies (the `proxies` input, off by default; install.py carries it over): some sites' bot
protection lets a datacenter browser sign in and then serves it empty pages or "service unavailable"
(USPS Click-N-Ship did). With it on, each browser opens behind Browserbase's residential proxies,
billed per GB; a plan that refuses them gets the browser without.

Downloads: Browserbase keeps a file the browser downloads only while a CDP connection has turned
downloads on, and Stagehand doesn't. So act and navigate take expect_download: with it, this node
turns downloads on over its own connection to the conversation's browser, held open while the
action runs and until the download it starts finishes (DOWNLOAD_FINISH_S at most), and tells the
agent what came down, so save_file can give it to the member from Browserbase's store. Without it,
an action costs nothing extra.

One call at a time per conversation: the agent may ask for several page actions in one turn, and
on one page they'd fill over each other (and with no browser yet, each would open its own). A
failed action is the action's, not the browser's: the server answered, so the connection and the
browser (its page as the agent left it) are kept, and the agent hears the error. A lost connection
is forgotten and remade on the next call, the kept-alive browser with it. Only when the server says
the browser session is gone, or MAX_STRIKES calls in a row fail, is the browser dropped for a fresh
one (and released, so it doesn't burn the plan's minutes).
Tool names stay Browserbase's (start, end, navigate, act, observe, extract): the Tool Gateway
routes `act` through take_action, so it still needs the owner's approval. Wire the output to
the Tool Gateway's Tools input. Authenticates with a Langflow global variable sent in one
header: the Browserbase key in `x-bb-api-key`, or "Bearer <key>" in `Authorization`
(install.py carries over whichever the shared node used).
Source of truth: langflow/components/studio_browser.py in the Studio repo.
"""

import asyncio
import hashlib
import json
import re
import time

import httpx
import websockets
from langchain_core.tools import StructuredTool
from lfx.base.agents.utils import safe_cache_get, safe_cache_set
from lfx.base.mcp.util import MCPStreamableHttpClient, update_tools
from lfx.custom.custom_component.component_with_cache import ComponentWithCache
from lfx.io import BoolInput, MessageTextInput, Output, SecretStrInput
from pydantic import Field, create_model

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
# (Long enough that an owner finding a password or reading an approval card doesn't lose the
# browser it's for.)
MIN_IDLE_TO_END_S = 900
# How long a browser this node opens lives, kept alive while the agent waits on the member.
BROWSER_TIMEOUT_S = 3600
CONCURRENCY_LIMIT = re.compile(r"concurrent sessions", re.IGNORECASE)
# Browserbase's own API, for opening a browser with the member's saved sign-ins.
BROWSERBASE_API = "https://api.browserbase.com/v1"
# The app's format for a context id; anything else (an unfilled "{{browser_context}}") is ignored.
CONTEXT_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
SESSION_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
# Actions that can start a download, and how long one has to begin after the action, then to finish.
DOWNLOAD_TOOLS = {"act", "navigate"}
DOWNLOAD_START_S = 3
DOWNLOAD_FINISH_S = 30
# How lfx reports a client that lost its MCP session (the browser itself may be fine).
DISCONNECTED = re.compile(r"not initialized or disconnected", re.IGNORECASE)
# How lfx reports the server's own error result: the action failed, but the server answered, so
# the connection and the browser are fine. (A lost connection reads "Tool '…' execution failed".)
ACTION_FAILED = re.compile(r"^MCP tool '[^']+' failed:")
# The server saying the browser session itself is gone.
SESSION_GONE = re.compile(r"session[^.\n]{0,60}(not found|no longer|ended|expired|terminated|closed|invalid|does not exist)"
                          r"|no (active |browser )?session", re.IGNORECASE)
# A bound browser is dropped for a fresh one after this many failed calls in a row on it.
MAX_STRIKES = 3
# Browserbase's own model behind act/observe/extract now and then answers off its schema
# (an element id its own validator refuses); the same call usually works the next time.
# Tried again this many times before the agent hears of it.
FLAKE = re.compile(r"AI_NoObjectGeneratedError|AI_TypeValidationError|did not match schema")
FLAKE_RETRIES = 2


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


CARD_LIKE = re.compile(r"\b[0-9](?:[ -]?[0-9]){12,18}\b")


def luhn(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
    return total % 10 == 0


def mask_cards(text: str) -> str:
    """Card numbers (13-19 digits that pass Luhn) cut to their last four. Studio fills cards into
    the page itself so the agent never sees them; this keeps one off the page from reaching it."""
    def mask(m):
        digits = re.sub(r"[ -]", "", m.group(0))
        return f"•••• {digits[-4:]}" if luhn(digits) else m.group(0)
    return CARD_LIKE.sub(mask, text)


def scrub_text(text: str) -> str:
    return mask_cards(SIGNING_KEY.sub("signingKey=[removed]", SIGNED_URL.sub("[removed]", text)))


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


def with_downloads(result, names: list[str], expected: bool):
    """The result with what the action downloaded (or that it downloaded nothing) told to the agent."""
    content = getattr(result, "content", None)
    if not expected or not isinstance(content, list) or not content or not hasattr(content[0], "text"):
        return result
    if names:
        note = (f"Your browser downloaded: {', '.join(names)}. To give the owner one, call save_file with "
                f"downloaded set to its name exactly as here.")
    else:
        note = ("Nothing downloaded. If the page shows the file or a link to it, call save_file with its link, "
                "or with neither to save the page.")
    return result.model_copy(update={"content": [*content, content[0].model_copy(update={"text": note})]})


URL_IN_ACTION = re.compile(r"https?://\S+", re.IGNORECASE)
NO_ACTION = re.compile(r"No action found", re.IGNORECASE)


def with_navigate_hint(result, name: str, kwargs: dict):
    """An act that named a URL and found nothing to do is told how to open one: act works on the
    page it has, so "Go to https://…" finds no element, and an agent that doesn't know asks for a
    sign-in on a blank page."""
    action = kwargs.get("action")
    content = getattr(result, "content", None)
    if name != "act" or not isinstance(action, str) or not URL_IN_ACTION.search(action) or not isinstance(content, list) or not content:
        return result
    if not any(NO_ACTION.search(getattr(item, "text", "") or "") for item in content):
        return result
    note = "act can't open a URL: call navigate with the URL first, then act on the page it opens."
    return result.model_copy(update={"content": [*content, content[0].model_copy(update={"text": note})]})


async def catch_downloads(api_key: str, sid: str, work):
    """Runs `work` (an action in the browser) with downloads on, over a CDP connection of this
    node's own, held until a download it started finishes. Returns its result and the names of the
    files that finished. Best effort: anything that goes wrong here just runs the action."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(f"{BROWSERBASE_API}/sessions/{sid}", headers={"X-BB-API-Key": api_key})
        connect_url = res.json().get("connectUrl") if res.status_code == 200 else None
    except (httpx.HTTPError, ValueError, AttributeError):
        connect_url = None
    if not isinstance(connect_url, str) or not connect_url.startswith("wss://"):
        return await work(), []
    return await downloads_over(connect_url, work)


async def downloads_over(connect_url: str, work):
    """catch_downloads on a browser's CDP connection (the signed URL stays in this process)."""
    try:
        ws = await websockets.connect(connect_url, max_size=None, open_timeout=10, ping_interval=None)
    except Exception:  # noqa: BLE001  Downloads are extra; the action isn't.
        return await work(), []
    begun: dict = {}
    finished: dict = {}
    allowed = asyncio.Event()
    changed = asyncio.Event()

    async def listen():
        async for raw in ws:
            try:
                message = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
            if message.get("id") == 1:
                allowed.set()
                continue
            params = message.get("params") or {}
            if message.get("method") == "Browser.downloadWillBegin":
                begun[params.get("guid")] = str(params.get("suggestedFilename") or "download")
                changed.set()
            elif message.get("method") == "Browser.downloadProgress" and params.get("state") in ("completed", "canceled"):
                finished[params.get("guid")] = params["state"]
                changed.set()

    listener = asyncio.create_task(listen())
    try:
        await ws.send(json.dumps({"id": 1, "method": "Browser.setDownloadBehavior",
                                  "params": {"behavior": "allow", "downloadPath": "downloads", "eventsEnabled": True}}))
        try:
            await asyncio.wait_for(allowed.wait(), 5)
        except asyncio.TimeoutError:
            pass
        result = await work()
        loop = asyncio.get_running_loop()
        start_by = loop.time() + DOWNLOAD_START_S
        finish_by = loop.time() + DOWNLOAD_FINISH_S
        while True:
            pending = [g for g in begun if g not in finished]
            if (begun and not pending) or (not begun and loop.time() >= start_by) or loop.time() >= finish_by:
                break
            changed.clear()
            try:
                await asyncio.wait_for(changed.wait(), max(0.1, (finish_by if begun else start_by) - loop.time()))
            except asyncio.TimeoutError:
                pass
        return result, [name for g, name in begun.items() if finished.get(g) == "completed"]
    finally:
        listener.cancel()
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass


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
        MessageTextInput(name="context_id", display_name="Saved Sign-ins", value="", advanced=True,
                         info="Filled per run by the Studio app: the member's Browserbase context. Leave empty here."),
        BoolInput(name="proxies", display_name="Residential Proxies", value=False, advanced=True,
                  info=("Open each browser behind Browserbase's residential proxies (billed per GB by Browserbase). "
                        "For sites whose bot protection serves a datacenter browser blank pages or 'service "
                        "unavailable' once signed in. If the plan refuses it, the browser opens without.")),
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

        strikes_key = f"studio_browser:strikes:{server}"

        def strike(sid: str) -> int:
            """Counts a failed call on this conversation's browser; how many in a row it has had."""
            current = safe_cache_get(cache, strikes_key) or {}
            entry = current.get(conv)
            count = entry[1] + 1 if entry and entry[0] == sid else 1
            current[conv] = (sid, count)
            if len(current) > MAX_CONNECTIONS:
                current = dict(list(current.items())[-MAX_CONNECTIONS:])
            safe_cache_set(cache, strikes_key, current)
            return count

        def clear_strikes() -> None:
            current = safe_cache_get(cache, strikes_key) or {}
            if current.pop(conv, None) is not None:
                safe_cache_set(cache, strikes_key, current)

        locks_key = f"studio_browser:locks:{server}"

        def conversation_lock() -> asyncio.Lock:
            """This conversation's lock in this process (one per event loop): its browser takes
            one call at a time."""
            loop = asyncio.get_running_loop()
            current = safe_cache_get(cache, locks_key) or {}
            entry = current.get(conv)
            if entry and entry[0] is loop:
                return entry[1]
            lock = asyncio.Lock()
            current[conv] = (loop, lock)
            if len(current) > MAX_CONNECTIONS:
                current = dict(list(current.items())[-MAX_CONNECTIONS:])
            safe_cache_set(cache, locks_key, current)
            return lock

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
            await release(sid)
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

        # The member's saved sign-ins: this run's, else the ones last seen for them in this process
        # (a resumed run has no tweaks). Keyed by a hash of their id from the session id.
        contexts_key = f"studio_browser:contexts:{server}"
        parts = session_id.split(".")
        member = hashlib.sha256(parts[1].encode()).hexdigest()[:32] if len(parts) == 3 else None
        given = str(self.context_id or "").strip()
        known = {k: v for k, v in (safe_cache_get(cache, contexts_key) or {}).items() if time.monotonic() - v[0] < BINDING_TTL_S}
        if member and CONTEXT_ID.match(given):
            known[member] = (time.monotonic(), given)
            if len(known) > MAX_CONNECTIONS:
                known = dict(sorted(known.items(), key=lambda kv: kv[1][0])[-MAX_CONNECTIONS:])
            safe_cache_set(cache, contexts_key, known)
        context = known[member][1] if member in known else None
        api_key = auth[7:].strip() if auth.lower().startswith("bearer ") else auth

        async def open_browser() -> str | None:
            """A new browser kept alive between runs, with the member's saved sign-ins if they have
            any (saved again when it closes), or None."""
            body = {"keepAlive": True, "timeout": BROWSER_TIMEOUT_S}
            if context:
                body["browserSettings"] = {"context": {"id": context, "persist": True}}
            if bool(getattr(self, "proxies", False)):
                body["proxies"] = True
            made_room = False
            for _ in range(4):
                try:
                    async with httpx.AsyncClient(timeout=20) as client:
                        res = await client.post(f"{BROWSERBASE_API}/sessions", json=body,
                                                headers={"X-BB-API-Key": api_key, "Content-Type": "application/json"})
                except httpx.HTTPError:
                    return None
                if res.status_code == 429 and not made_room and await make_room():
                    made_room = True
                    continue
                if res.status_code in (400, 402, 403) and body.pop("proxies", None):
                    continue  # A plan without proxies: open the browser without them.
                if res.status_code in (400, 403) and body.pop("keepAlive", None):
                    continue  # A plan without keep-alive: open one that lives while it's connected.
                if res.status_code >= 300:
                    return None
                try:
                    sid = res.json().get("id")  # Only the id: its connection details stay here.
                except ValueError:
                    return None
                return sid if isinstance(sid, str) and SESSION_ID.match(sid) else None
            return None

        async def release(sid: str) -> None:
            """Ends a browser for good (kept-alive ones outlast the server's own close)."""
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    await client.post(f"{BROWSERBASE_API}/sessions/{sid}", json={"status": "REQUEST_RELEASE"},
                                      headers={"X-BB-API-Key": api_key, "Content-Type": "application/json"})
            except httpx.HTTPError:
                pass

        async def start(tool, kwargs: dict):
            """Starts (or reuses) this conversation's browser, making room once if the plan is full."""
            current = bound()
            opened = None
            if current is None:
                current = opened = await open_browser()
                if current is None:
                    self.status = "Couldn't open a kept-alive browser; opening the server's own"
            _, session_field = without_session_arg(tool.args_schema)
            args = {**kwargs, **({session_field: current} if session_field and current else {})}
            try:
                return await tool.coroutine(**args)
            except ValueError as exc:
                if opened:
                    await release(opened)
                    if not DISCONNECTED.search(str(exc)):
                        # The server couldn't use the browser opened here; let it open its own.
                        return await tool.coroutine(**kwargs)
                elif current and not DISCONNECTED.search(str(exc)):
                    # The bound browser ended; open a fresh one for this conversation.
                    bind(None)
                    await release(current)
                    return await start(tool, kwargs)
                if CONCURRENCY_LIMIT.search(str(exc)) and await make_room():
                    return await tool.coroutine(**kwargs)
                forget_connection(conv)
                raise

        def make_tool(name: str, description: str, model):
            public_model, session_field = without_session_arg(model)
            if name in DOWNLOAD_TOOLS:
                fields = getattr(public_model, "model_fields", {}) or {}
                public_model = create_model(public_model.__name__, **{n: (f.annotation, f) for n, f in fields.items()},
                                            expect_download=(bool, Field(default=False, description=(
                                                "True when this will download a file (a Download, Export, or Print "
                                                "label button, or a file's link), so your browser keeps it for "
                                                "save_file."))))

            async def call(**kwargs):
                for arg in SESSION_ARGS:
                    kwargs.pop(arg, None)
                expect_download = bool(kwargs.pop("expect_download", False))
                # One call at a time: the agent's parallel calls would each open a browser, or
                # fill one page over each other.
                async with conversation_lock():
                    return await call_now(kwargs, expect_download)

            async def call_now(kwargs: dict, expect_download: bool):
                tools = await conversation_tools(conv)
                tool = tools.get(name)
                if tool is None:
                    msg = f"The browser has no tool '{name}' right now."
                    raise ValueError(msg)
                if name == "start":
                    result = await start(tool, kwargs)
                    bind(started_session(result))
                    clear_strikes()
                    return with_session(clean_result(result), bound())
                current = bound()
                if current is None and name != "end" and "start" in tools:
                    # A new connection has no browser yet; open this conversation's own first.
                    current = started_session(await start(tools["start"], {}))
                if current:
                    bind(current)  # In use from now: make_room counts idle time from here.
                if session_field and current:
                    kwargs[session_field] = current
                downloaded: list[str] = []
                try:
                    for attempt in range(FLAKE_RETRIES + 1):
                        try:
                            if expect_download and current and name in DOWNLOAD_TOOLS:
                                result, downloaded = await catch_downloads(api_key, current, lambda: tool.coroutine(**kwargs))
                            else:
                                result = await tool.coroutine(**kwargs)
                            break
                        except ValueError as exc:
                            if attempt == FLAKE_RETRIES or not FLAKE.search(str(exc)):
                                raise
                except Exception as exc:
                    failed = str(exc)
                    if ACTION_FAILED.match(failed):
                        # The server answered: the action failed, not the browser. Its page, as the
                        # agent left it, is what the next call needs, so connection and browser stay.
                        gone = bool(SESSION_GONE.search(failed))
                    else:
                        # The connection went; the next call remakes it. The kept-alive browser outlives it.
                        forget_connection(conv)
                        gone = False
                    if current and (name == "end" or gone or strike(current) >= MAX_STRIKES):
                        if bound() == current:
                            bind(None)  # Next call opens a fresh browser rather than retrying a dead one.
                        await release(current)
                    raise
                clear_strikes()
                if name == "end" and current:
                    await release(current)
                if name == "end" or bound() == current:
                    bind(None if name == "end" else current)
                result = with_downloads(with_navigate_hint(result, name, kwargs), downloaded, expect_download and name in DOWNLOAD_TOOLS)
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
