import { getConfig } from "@/lib/config";
import type { StoredApproval } from "@/lib/db/store";
import type { Tenant } from "@/lib/tenant-core";
import { openCall } from "./calls";
import { isApproveIntent, isDeclineIntent } from "./intent";
import { voiceStatus } from "./status";

// Spoken approvals, server side: whether they're on for a member, whether a decision said on a
// call stands, and the member's report that one wasn't what they said, which turns them off for
// everyone (the trip wire, cleared only with SQL). The browser has already checked the read-back
// was said, the yes was spoken, and the hold ran (src/lib/voice/approval-guard.ts); this checks
// again what the server can know. Everything runs under the member's session. Free of Next.js,
// so a turn can use it anywhere.

const TAP = "Tap Approve on screen instead.";

/**
 * Whether spoken approvals are on for this member: the VOICE_SPOKEN_APPROVALS switch, their
 * voice preview, a real voice (the mock's only in front of the mock agent), and the trip wire not
 * tripped. Fails closed when the wire can't be read.
 */
export async function spokenApprovalsOn(tenant: Tenant): Promise<boolean> {
  const config = getConfig();
  if (!config.voice?.spokenApprovals || !voiceStatus(tenant)) return false;
  // The mock voice's "speech" is typed: it stands in for speech only in front of the mock agent.
  if (config.voice.provider === "mock" && config.agent?.provider !== "mock") return false;
  const { data, error } = await tenant.db.rpc("spoken_approvals_off");
  if (error) {
    console.error("[voice] couldn't read whether spoken approvals are off", error.message);
    return false;
  }
  return data === false;
}

/**
 * Why a decision the member said on a call doesn't stand, or null when it does. Approving needs
 * spoken approvals on, a voice-ok request (classified when the agent asked), from the mock agent
 * when the voice is the mock's typed stand-in, their words a clear "send it", and their own call
 * in this agent still open. Declining changes nothing outside Studio, so it needs only a clear
 * no on their open call; any request may be declined by voice.
 */
export async function checkSpokenDecision(
  tenant: Tenant,
  approval: StoredApproval,
  decision: "approve" | "reject",
  spoken: { heard: string; voiceSessionId: string },
): Promise<string | null> {
  if (!voiceStatus(tenant)) return `Calls are off here. ${TAP}`;
  if (decision === "approve") {
    if (!approval.spoken?.ok) return `That one's a tap. ${TAP}`;
    // Words on a mock call are typed, so they never approve a real provider's request.
    if (getConfig().voice?.provider !== "elevenlabs" && approval.provider !== "mock") return `That one's a tap. ${TAP}`;
    if (!isApproveIntent(spoken.heard)) return `That didn't sound like “send it”. ${TAP}`;
    if (!(await spokenApprovalsOn(tenant))) return `Approvals are taps for now. ${TAP}`;
  } else if (!isDeclineIntent(spoken.heard)) {
    return "That didn't sound like a no. Tap Decline on screen instead.";
  }
  const call = /^[0-9a-f-]{36}$/i.test(spoken.voiceSessionId) ? await openCall(tenant, spoken.voiceSessionId).catch(() => null) : null;
  if (!call) return `The call has ended. ${decision === "approve" ? TAP : "Tap Decline on screen instead."}`;
  return null;
}

/**
 * The member says the request they approved by voice wasn't what they said. Trips the wire:
 * spoken approval is off for everyone from now on. False when it isn't their spoken approval in
 * that conversation.
 */
export async function reportSpokenApproval(tenant: Tenant, conversationId: string, approvalId: string): Promise<boolean> {
  // Only someone with calls has spoken approvals to report (the database checks the call itself).
  if (!voiceStatus(tenant)) return false;
  const { data, error } = await tenant.db.rpc("report_spoken_approval", { p_conversation: conversationId, p_approval: approvalId });
  if (error) throw new Error(error.message);
  if (data === true) console.error("[voice] a spoken approval was reported wrong; spoken approvals are off until cleared", { approvalId });
  return data === true;
}
