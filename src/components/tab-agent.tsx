"use client";

import { useEffect } from "react";
import { api } from "@/lib/client/api";
import { showAgent } from "@/lib/client/tab-agent";

/**
 * Names the agent this page was rendered for, so the tab's requests stay with it. Renders nothing.
 * `remember`: the page was opened under an agent other than the tab's last (a chat link from a
 * push or from Home), so that agent becomes the one new tabs open on too.
 */
export function TabAgent({ id, remember = false }: { id: string; remember?: boolean }) {
  showAgent(id);
  useEffect(() => {
    if (remember) api.setActiveAgent(id).catch(() => undefined);
  }, [id, remember]);
  return null;
}
