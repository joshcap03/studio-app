"use client";

import { showAgent } from "@/lib/client/tab-agent";

/** Names the agent this page was rendered for, so the tab's requests stay with it. Renders nothing. */
export function TabAgent({ id }: { id: string }) {
  showAgent(id);
  return null;
}
