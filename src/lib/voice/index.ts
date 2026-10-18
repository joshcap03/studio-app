import { getConfig } from "@/lib/config";
import { previewEnabled } from "@/lib/flags";
import type { Tenant } from "@/lib/tenant-core";
import { getGuardrail, getSettings } from "@/lib/workspace";
import { ELEVENLABS_CAPABILITIES, ELEVENLABS_LABEL, openElevenLabsCall, VoiceUnavailable } from "./elevenlabs";
import { MOCK_VOICE_LABEL } from "./mock";
import { agentLabel, personaFor } from "./persona";
import { sealContext } from "./seal";
import type { VoiceCapabilities, VoiceGrant, VoiceJoin, VoiceStatus } from "./types";

// Voice calls, server side: whether a member can call, starting a call (cap, provider, seal),
// and ending one. Everything runs under the member's own session; the voice front, which has
// none, gets only the sealed context.

export { VoiceUnavailable, type VoiceStatus };

const MOCK_CAPABILITIES: VoiceCapabilities = { audio: false, bargeIn: true, verbatimTranscripts: true };
const GUARDRAIL_CHARS = 4000;

/** Whether this member can call: null when calls are off for them. */
export function voiceStatus(tenant: Pick<Tenant, "email">): VoiceStatus | null {
  const voice = getConfig().voice;
  if (!voice || !previewEnabled(tenant, "voice")) return null;
  return voice.provider === "mock"
    ? { provider: "mock", label: MOCK_VOICE_LABEL, live: false }
    : { provider: "elevenlabs", label: ELEVENLABS_LABEL, live: true };
}

function check<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

/** Starts a call for the member, or says why not ("daily": today's voice time is used up). */
export async function startVoiceCall(tenant: Tenant): Promise<{ ok: true; grant: VoiceGrant } | { ok: false; refused: "daily" }> {
  const voice = getConfig().voice;
  if (!voice) throw new VoiceUnavailable("Voice isn't set up.");
  const rows = check(
    await tenant.db.rpc("claim_voice", {
      ws: tenant.workspace.id,
      p_provider: voice.provider,
      p_daily_seconds: voice.limits.secondsPerDay,
      p_call_seconds: voice.limits.callSeconds,
    }),
  ) as { session_id: string | null; max_seconds: number; refused: string | null }[];
  const claim = rows[0];
  if (!claim?.session_id) return { ok: false, refused: "daily" };

  let opened: { conversationId: string; join: VoiceJoin };
  try {
    opened =
      voice.provider === "elevenlabs" ? await openElevenLabsCall(voice.elevenlabs!) : { conversationId: `mock_${crypto.randomUUID()}`, join: { kind: "mock" } };
    check(await tenant.db.from("voice_sessions").update({ provider_conversation_id: opened.conversationId }).eq("id", claim.session_id));
  } catch (e) {
    await endVoiceCall(tenant, claim.session_id).catch(() => undefined);
    throw e instanceof VoiceUnavailable ? e : new VoiceUnavailable("Couldn't open the call.", { cause: e });
  }

  const [settings, guardrail] = await Promise.all([getSettings(tenant), getGuardrail(tenant)]);
  const persona = personaFor(settings.templateId);
  // A little past the call's limit, for the last words and the hang-up.
  const exp = Date.now() + (claim.max_seconds + 120) * 1000;
  const context = sealContext(
    {
      v: 1,
      sid: claim.session_id,
      cid: opened.conversationId,
      provider: voice.provider,
      uid: tenant.userId,
      ws: tenant.workspace.id,
      exp,
      name: persona.name,
      agent: agentLabel(settings.templateId, settings.name),
      guardrail: guardrail ? guardrail.slice(0, GUARDRAIL_CHARS) : null,
    },
    voice.sealSecret,
  );
  const mock = voice.provider === "mock";
  return {
    ok: true,
    grant: {
      sessionId: claim.session_id,
      provider: voice.provider,
      label: mock ? MOCK_VOICE_LABEL : ELEVENLABS_LABEL,
      live: !mock,
      capabilities: mock ? MOCK_CAPABILITIES : ELEVENLABS_CAPABILITIES,
      conversationId: opened.conversationId,
      join: opened.join,
      context,
      persona,
      maxSeconds: claim.max_seconds,
    },
  };
}

/** Ends one of the member's calls; the seconds it used, or null when it isn't theirs or already ended. */
export async function endVoiceCall(tenant: Tenant, sessionId: string): Promise<number | null> {
  return check(await tenant.db.rpc("end_voice_session", { p_id: sessionId })) as number | null;
}
