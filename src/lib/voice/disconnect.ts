// Why a call the provider closed ended, in plain words for the call screen, or null when it just
// ended (the member hung up, or the agent closed it cleanly). Pure, provider-neutral in shape:
// ElevenLabs reports why in its close reason (out of credits, a quota) or an error message.

export type Disconnect =
  | { reason: "user" }
  | { reason: "agent"; closeCode?: number; closeReason?: string }
  | { reason: "error"; message: string; closeCode?: number; closeReason?: string };

/** Said when the voice provider has no minutes left on its account. */
export const OUT_OF_MINUTES = "Calls are paused: Studio’s voice minutes have run out for now.";

const NORMAL_CLOSE = 1000;

export function disconnectProblem(details: Disconnect | undefined): string | null {
  if (!details || details.reason === "user") return null;
  const why = [details.closeReason, details.reason === "error" ? details.message : ""].filter(Boolean).join(" ").trim();
  if (/quota|credits?\b|out of (?:minutes|characters)/i.test(why)) return OUT_OF_MINUTES;
  if (details.reason === "error") return why || "The call dropped.";
  return details.closeCode !== undefined && details.closeCode !== NORMAL_CLOSE && why ? why : null;
}
