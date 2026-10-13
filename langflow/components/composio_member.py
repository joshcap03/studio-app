"""Member Apps: Composio tools that act only through the calling member's own connections.

Replaces a shared Composio MCP node. On every run the Studio app fills `member_id` (the
member's opaque Composio user id) and `toolkits` (optional auth configs to pin, by app)
through LANGFLOW_TWEAKS. This node opens a Composio tool-router session for that member
alone and returns its tools, so one member's Gmail is never reachable from another
member's run. Without a valid member id it returns no tools (fails closed).

Langflow 1.12 drops tweaks when a paused run resumes after an approval, so the node also
reads the member id from the session id the app sends (`<workspace>.<member id>.<conversation>`),
which Langflow does restore. If both are present they must agree.

Apps are dynamic: the session covers Composio's whole catalog, and the agent can send the
member a link to connect an app in chat (Composio-managed auth unless `toolkits` pins an
auth config for that app). Wire the output to the Tool Gateway's
Tools input. Needs the Langflow global variable COMPOSIO_API_KEY (the same Composio project
the app uses). Source of truth: langflow/components/composio_member.py in the Studio repo.
"""

import json
import re

import httpx
from lfx.base.mcp.util import update_tools
from lfx.custom.custom_component.component import Component
from lfx.io import MessageTextInput, MultilineInput, Output, SecretStrInput

# The app's format (workspace_members.composio_user_id). Anything else, including an
# unfilled "{{composio_user_id}}" placeholder, is refused rather than run as some shared user.
MEMBER_ID = re.compile(r"^lj_[0-9a-f]{32}$")
SLUG = re.compile(r"^[a-z0-9_]+$")


class MemberAppsComponent(Component):
    display_name = "Member Apps"
    description = "Composio tools scoped to the calling member's own connected apps."
    icon = "plug"
    name = "MemberApps"

    inputs = [
        SecretStrInput(name="api_key", display_name="Composio API Key", value="COMPOSIO_API_KEY", required=True),
        MessageTextInput(name="member_id", display_name="Member ID", value="", advanced=True,
                         info="Filled per run by the Studio app. Leave empty here."),
        MultilineInput(name="toolkits", display_name="Toolkits", value="", advanced=True,
                       info="Filled per run by the Studio app: auth configs to pin, {slug: id}. Leave empty here."),
        MessageTextInput(name="base_url", display_name="Composio API URL", value="https://backend.composio.dev", advanced=True),
    ]
    outputs = [Output(display_name="Tools", name="tools", method="build_tools", types=["Tool"])]

    def _toolkits(self) -> dict[str, str]:
        try:
            raw = json.loads(self.toolkits or "{}")
        except json.JSONDecodeError:
            return {}
        if not isinstance(raw, dict):
            return {}
        return {k: v for k, v in raw.items() if isinstance(k, str) and SLUG.match(k) and isinstance(v, str) and v}

    def _member(self) -> str | None:
        tweaked = (self.member_id or "").strip()
        graph = getattr(self, "graph", None)
        parts = str(getattr(graph, "session_id", "") or "").split(".")
        from_session = parts[1] if len(parts) == 3 else ""
        valid = [m for m in (tweaked, from_session) if MEMBER_ID.match(m)]
        if not valid or len(set(valid)) > 1:
            return None
        return valid[0]

    async def build_tools(self):
        member = self._member()
        toolkits = self._toolkits()
        if member is None:
            self.status = "No member for this run: no app tools"
            return []

        base = (self.base_url or "https://backend.composio.dev").rstrip("/")
        async with httpx.AsyncClient(timeout=30) as client:
            res = await client.post(
                f"{base}/api/v3.1/tool_router/session",
                headers={"x-api-key": self.api_key},
                json={
                    "user_id": member,
                    "auth_configs": toolkits,
                    "manage_connections": {"enable": True, "enable_wait_for_connections": True},
                },
            )
        if res.status_code >= 400:
            msg = f"Composio refused the session ({res.status_code}): {res.text[:300]}"
            raise ValueError(msg)
        url = ((res.json() or {}).get("mcp") or {}).get("url")
        if not url or not url.startswith(base + "/"):
            msg = "Composio returned no MCP endpoint for this session."
            raise ValueError(msg)

        _, tools, _ = await update_tools(
            server_name="composio",
            server_config={"mode": "Streamable_HTTP", "url": url, "headers": {"x-api-key": self.api_key}},
        )
        # The gateway keys on lowercase composio_* names; the session may report them upper-case.
        for tool in tools:
            tool.name = tool.name.lower()
        self.status = f"{len(tools)} tools for this member"
        return tools
