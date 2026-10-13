"""Workspace Context: the agent's instructions plus what the Studio app knows about this workspace.

Wire its output to Agent → Agent Instructions (system_prompt). The base instructions live in
this node; the app fills `workspace_context` on every run (via LANGFLOW_TWEAKS) with the
workspace's settings and the memories its owner confirmed. Plain concatenation, no template
parsing, so braces in either part are safe. Source of truth: langflow/components/ in the
Studio repo.
"""

from lfx.custom.custom_component.component import Component
from lfx.io import MultilineInput, Output
from lfx.schema.message import Message


class WorkspaceContextComponent(Component):
    display_name = "Workspace Context"
    description = "Agent instructions with the calling workspace's settings and memories appended."
    icon = "building-2"
    name = "WorkspaceContext"

    inputs = [
        MultilineInput(name="base_prompt", display_name="Agent Instructions", value=""),
        MultilineInput(
            name="workspace_context",
            display_name="Workspace Context",
            value="",
            info="Filled per run by the Studio app. Leave empty here.",
        ),
    ]
    outputs = [Output(display_name="System Prompt", name="system_prompt", method="build_prompt", types=["Message"])]

    def build_prompt(self) -> Message:
        base = (self.base_prompt or "").strip()
        context = (self.workspace_context or "").strip()
        text = f"{base}\n\n# THIS WORKSPACE\n\n{context}" if context else base
        self.status = f"{len(context)} characters of workspace context" if context else "No workspace context"
        return Message(text=text)
