import { firstName } from "@/lib/setup-words";
import { getConfig } from "@/lib/config";
import type { Tenant } from "@/lib/tenant-core";
import { getGuardrail, getSettings } from "@/lib/workspace";
import { ELEVENLABS_CAPABILITIES, ELEVENLABS_LABEL, ELEVENLABS_VOICES, openElevenLabsCall, VoiceUnavailable } from "./elevenlabs";
import { MOCK_VOICE_LABEL } from "./mock";
import { spokenApprovalsOn } from "./approvals";
import { agentLabel, resolvePersona } from "./persona";
import { clipKey, sealContext } from "./seal";
import { dictationStatus, voiceStatus } from "./status";
import type { VoiceCapabilities, VoiceGrant, VoiceJoin, VoiceStatus } from "./types";

// Voice calls, server side: whether a member can call, starting a call (cap, provider, seal),
// ending one, and charging speech outside calls (previews, voice notes, voice messages) to the
// same daily voice time. Everything runs under the member's own session; the voice front, which
// has none, gets only the sealed context.

export { dictationStatus, VoiceUnavailable, voiceStatus, type VoiceStatus };

const MOCK_CAPABILITIES: VoiceCapabilities = { audio: false, bargeIn: true, verbatimTranscripts: true };
const GUARDRAIL_CHARS = 4000;
const MANNER_CHARS = 600;

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

  // Whether this call may approve by voice is settled when it starts; the server checks again on each decision.
  const [settings, guardrail, approvals] = await Promise.all([getSettings(tenant), getGuardrail(tenant), spokenApprovalsOn(tenant)]);
  // The server picks the voice from what the member chose; the browser only applies it.
  const persona = await resolvePersona(tenant, { templateId: settings.templateId });
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
      member: firstName(tenant.account.name),
      agent: agentLabel(settings.templateId, settings.name),
      guardrail: guardrail ? guardrail.slice(0, GUARDRAIL_CHARS) : null,
      ...(persona.manner ? { manner: persona.manner.slice(0, MANNER_CHARS) } : {}),
      approvals,
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
      persona: { name: persona.name, voice: persona.voice, voiceId: mock ? null : ELEVENLABS_VOICES[persona.voice] },
      maxSeconds: claim.max_seconds,
      ...(getConfig().browser ? { browserView: true } : {}),
      spokenApprovals: approvals,
    },
  };
}

/** Ends one of the member's calls; the seconds it used, or null when it isn't theirs or already ended. */
export async function endVoiceCall(tenant: Tenant, sessionId: string): Promise<number | null> {
  return check(await tenant.db.rpc("end_voice_session", { p_id: sessionId })) as number | null;
}

export type ClipKind = "preview" | "note" | "transcribe";

/** The most one clip charges (claim_voice_clip's own limit): longer time is charged in parts. */
export const MAX_CLIP_SECONDS = 3600;

/** No daily limit (Postgres's largest integer), for time already spent. */
const NO_LIMIT = 2_147_483_647;

/**
 * Charges one clip of speech outside a call to the member's daily voice time (shared with
 * calls), before it's made. `ref` names the clip, never its words (a message id and a hash, say):
 * the same clip again the same day is already paid for, so a replay charges nothing. The ledger
 * keeps only a keyed hash of it (clipKey), so no row a member writes can pass for one of these.
 *
 * `spent`: the time is already used (the provider has heard the recording), so it's charged even
 * past today's limit, and nothing more is made for them today. Never refused.
 */
export async function claimVoiceClip(
  tenant: Tenant,
  clip: { kind: ClipKind; ref: string; seconds: number },
  { spent = false }: { spent?: boolean } = {},
): Promise<{ ok: true; charged: number } | { ok: false; refused: "daily" }> {
  // A recording is dictation, which is on with or without the rest of voice, under its own daily limit.
  const config = getConfig();
  const ledger =
    clip.kind === "transcribe"
      ? config.dictation && { sealSecret: config.dictation.sealSecret, secondsPerDay: config.dictation.secondsPerDay }
      : config.voice && { sealSecret: config.voice.sealSecret, secondsPerDay: config.voice.limits.secondsPerDay };
  if (!ledger) throw new VoiceUnavailable("Voice isn't set up.");
  const seconds = Math.max(0, Math.ceil(clip.seconds));
  if (seconds > MAX_CLIP_SECONDS) throw new RangeError(`A clip charges at most ${MAX_CLIP_SECONDS} seconds.`);
  const rows = check(
    await tenant.db.rpc("claim_voice_clip", {
      ws: tenant.workspace.id,
      p_kind: clip.kind,
      p_ref: clipKey(clip.kind, clip.ref, ledger.sealSecret),
      p_seconds: seconds,
      p_daily_seconds: spent ? NO_LIMIT : ledger.secondsPerDay,
    }),
  ) as { clip_id: string | null; seconds: number; refused: string | null }[];
  const claim = rows[0];
  return claim?.clip_id ? { ok: true, charged: claim.seconds } : { ok: false, refused: "daily" };
}
