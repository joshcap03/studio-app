#!/usr/bin/env node
// How conversational real calls were, from ElevenLabs' own record of each one, scored against the
// voice spec's targets: how fast the voice answers once the member stops, dead air while they
// wait, talk-over, backchannels ignored, failures, and cost. Read-only; prints no secrets.
//
//   ELEVENLABS_API_KEY=… ELEVENLABS_AGENT_ID=… node scripts/voice-call-metrics.mjs [--calls 10]

const key = process.env.ELEVENLABS_API_KEY?.trim();
const agent = process.env.ELEVENLABS_AGENT_ID?.trim();
if (!key || !agent) {
  console.error("Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID.");
  process.exit(1);
}
const at = process.argv.indexOf("--calls");
const limit = at > 0 ? Number(process.argv[at + 1]) || 10 : 10;

// From the spec ("How we'll know it's working").
const TARGET_FIRST_AUDIO_S = 0.8;
const DEAD_AIR_S = 4;

async function get(path) {
  const res = await fetch(`https://api.elevenlabs.io/v1/convai${path}`, { headers: { "xi-api-key": key } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

const metric = (item, name) => {
  const m = item.conversation_turn_metrics?.metrics?.[name];
  return typeof m?.elapsed_time === "number" ? m.elapsed_time : undefined;
};
const isMarker = (item) => (item.message ?? "").trimStart().startsWith("⟦studio⟧");
const spoke = (item) => item.role === "user" && item.source_medium === "audio" && !isMarker(item) && (item.message ?? "").replace(/[.\s…]/g, "") !== "";

function pct(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
const s = (v) => (v === null || v === undefined ? "–" : `${v.toFixed(2)}s`);

const { conversations = [] } = await get(`/conversations?agent_id=${agent}&page_size=${Math.min(limit, 100)}`);
const all = { answers: [], deadAir: 0, interrupted: 0, backchannels: 0, failed: 0, seconds: 0, calls: 0 };
const rows = [];
for (const c of conversations.slice(0, limit)) {
  const d = await get(`/conversations/${c.conversation_id}`);
  const items = d.transcript ?? [];
  const answers = [];
  let deadAir = 0;
  items.forEach((item, i) => {
    if (!spoke(item)) return;
    // The first thing the voice said after they stopped.
    const reply = items.slice(i + 1).find((x) => x.role === "agent" && metric(x, "convai_ttf_audio_since_silence") !== undefined);
    const first = reply ? metric(reply, "convai_ttf_audio_since_silence") : undefined;
    if (first === undefined) return;
    answers.push(first);
    if (first > DEAD_AIR_S) deadAir += 1;
  });
  const interrupted = items.filter((x) => x.role === "agent" && x.interrupted).length;
  const backchannels = items.filter((x) => x.ignored_as_backchannel).length;
  const failed = d.status === "failed";
  const secs = d.metadata?.call_duration_secs ?? 0;
  all.answers.push(...answers);
  all.deadAir += deadAir;
  all.interrupted += interrupted;
  all.backchannels += backchannels;
  all.failed += failed ? 1 : 0;
  all.seconds += secs;
  all.calls += 1;
  rows.push({
    call: c.conversation_id.slice(-8),
    when: new Date((d.metadata?.start_time_unix_secs ?? 0) * 1000).toISOString().slice(5, 16).replace("T", " "),
    secs,
    turns: answers.length,
    "answer p50": s(pct(answers, 50)),
    "answer max": s(answers.length ? Math.max(...answers) : null),
    "dead air": deadAir,
    "cut off": interrupted,
    "mm-hm ignored": backchannels,
    ended: failed ? `FAILED: ${d.metadata?.termination_reason ?? "?"}` : (d.metadata?.termination_reason ?? ""),
  });
}

console.table(rows);
const p50 = pct(all.answers, 50);
const p90 = pct(all.answers, 90);
console.log(`\n${all.calls} calls, ${Math.round(all.seconds / 60)} min, ${all.answers.length} spoken turns`);
console.log(`Voice answers after the member stops: p50 ${s(p50)}, p90 ${s(p90)} (target under ${TARGET_FIRST_AUDIO_S}s) ${p50 !== null && p50 <= TARGET_FIRST_AUDIO_S ? "✓" : "✗"}`);
console.log(`Dead air over ${DEAD_AIR_S}s: ${all.deadAir} (${all.calls ? (all.deadAir / all.calls).toFixed(1) : 0} per call; target under 1) ${all.calls && all.deadAir / all.calls < 1 ? "✓" : "✗"}`);
console.log(`Voice cut off by the member: ${all.interrupted} · Backchannels ignored: ${all.backchannels} · Failed calls: ${all.failed}`);
