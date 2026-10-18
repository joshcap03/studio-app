#!/usr/bin/env node
// Creates (or updates) the one ElevenLabs agent every Studio call uses, in custom-LLM mode with
// Studio's voice front as its model (see docs/voice.md). Run it from your own terminal; it reads
// secrets from the environment and prints only ids.
//
//   ELEVENLABS_API_KEY=…  VOICE_LLM_SECRET=…  APP_URL=https://<your app>  node scripts/voice-agent.mjs
//
// Set ELEVENLABS_AGENT_ID to update that agent instead of creating one. --dry-run prints what
// would be sent (secrets left out) without calling ElevenLabs.

const API = "https://api.elevenlabs.io/v1/convai";
const dry = process.argv.includes("--dry-run");
const key = process.env.ELEVENLABS_API_KEY?.trim();
const llmSecret = process.env.VOICE_LLM_SECRET?.trim();
const app = process.env.APP_URL?.trim().replace(/\/+$/, "");
const existing = process.env.ELEVENLABS_AGENT_ID?.trim();

if (!dry && (!key || !llmSecret || !app)) fail("Set ELEVENLABS_API_KEY, VOICE_LLM_SECRET (the same value as in Vercel), and APP_URL.");
if (app && !/^https:\/\//.test(app)) fail("APP_URL must be the app's https address.");

const SECRET_NAME = "studio_voice_llm_key";

// Client tools: the browser runs each one and checks it against the member's own words. Studio's
// voice front gives the model its own descriptions; these only let ElevenLabs deliver the calls.
const TOOLS = [
  { name: "send_message", description: "Hand the member's exact words to the agent.", properties: {} },
  {
    name: "fill_card",
    description: "Fill one field of the card on screen. Nothing is sent.",
    properties: {
      field: { type: "string", description: "The field's id." },
      value: { type: "string", description: "The answer; JSON for picks, verdicts, and list entries." },
      sure: { type: "boolean", description: "False when guessing." },
    },
    required: ["field", "value"],
  },
  {
    name: "answer_question",
    description: "Pick options on the question card on screen. Nothing is sent.",
    properties: { answers: { type: "string", description: "JSON list of {question, option}." } },
    required: ["answers"],
  },
  { name: "send_card", description: "Send the card on screen, only after the member said send.", properties: {} },
  { name: "stop_work", description: "Stop the agent's current work, only when the member asked to stop.", properties: {} },
];

function toolConfig(t) {
  return {
    tool_config: {
      type: "client",
      name: t.name,
      description: t.description,
      parameters: { type: "object", properties: t.properties, ...(t.required ? { required: t.required } : {}) },
      expects_response: true,
      response_timeout_secs: 10,
      pre_tool_speech: "off",
      interruption_mode: "allow",
    },
  };
}

const BACKCHANNELS = ["mm-hm", "mhm", "mm", "uh-huh", "uh huh", "yeah", "yep", "yup", "okay", "ok", "right", "sure", "alright", "got it", "gotcha", "i see", "cool", "nice", "wow", "oh", "ah", "huh", "hmm", "uh", "um"];

function agentBody(secretId, toolIds) {
  return {
    name: "Studio voice",
    conversation_config: {
      agent: {
        // The browser cues the greeting; Studio's voice front writes it.
        first_message: "",
        language: "en",
        disable_first_message_interruptions: false,
        prompt: {
          // Ignored: Studio's voice front builds the prompt for every call, guardrail first.
          prompt: "Studio builds this voice's instructions per call.",
          llm: "custom-llm",
          tool_ids: toolIds,
          built_in_tools: { end_call: {}, skip_turn: {} },
          custom_llm: {
            url: `${app ?? "https://<APP_URL>"}/api/voice/llm/v1/chat/completions`,
            model_id: "studio-voice",
            api_key: { secret_id: secretId },
            request_headers: {
              "X-Studio-Conversation": { variable_name: "system__conversation_id" },
              "X-Studio-Voice-Ctx": { variable_name: "secret__studio_voice_ctx" },
            },
            api_type: "chat_completions",
          },
        },
      },
      turn: {
        turn_model: "turn_v3",
        turn_eagerness: "patient",
        spelling_patience: "auto",
        speculative_turn: false,
        turn_timeout: 20,
        initial_wait_time: 1,
        silence_end_call_timeout: 900,
        retranscribe_on_turn_timeout: false,
        interruption_ignore_terms: BACKCHANNELS,
        interruption_ignore_term_languages: ["en"],
        merge_with_default_ignore_terms: true,
      },
      conversation: {
        max_duration_seconds: 1800,
        client_events: ["conversation_initiation_metadata", "audio", "interruption", "user_transcript", "agent_response", "agent_response_correction", "client_tool_call", "vad_score"],
      },
    },
    platform_settings: {
      auth: { enable_auth: true },
      overrides: { custom_llm_extra_body: false, conversation_config_override: { tts: { voice_id: true } } },
      privacy: { record_voice: false, retention_days: 30, zero_retention_mode: false },
    },
  };
}

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) fail(`${method} ${path} → ${res.status}: ${text.slice(0, 800)}`);
  return text ? JSON.parse(text) : {};
}

function fail(message) {
  console.error(`voice-agent: ${message}`);
  process.exit(1);
}

if (dry) {
  console.log(JSON.stringify({ secret: { type: "new", name: SECRET_NAME, value: "<VOICE_LLM_SECRET>" }, tools: TOOLS.map(toolConfig), agent: agentBody("<secret_id>", ["<tool ids>"]) }, null, 2));
  process.exit(0);
}

// The key ElevenLabs sends the voice front, as a workspace secret (a new one each run; ElevenLabs
// keeps secrets write-only).
const secret = await call("POST", "/secrets", { type: "new", name: `${SECRET_NAME}_${Date.now()}`, value: llmSecret });

// Studio's client tools, reused by name when they already exist.
const listed = await call("GET", "/tools");
const have = new Map((listed.tools ?? []).map((t) => [t.tool_config?.name, t.id]));
const toolIds = [];
for (const t of TOOLS) {
  const id = have.get(t.name);
  if (id) {
    await call("PATCH", `/tools/${id}`, toolConfig(t));
    toolIds.push(id);
  } else {
    toolIds.push((await call("POST", "/tools", toolConfig(t))).id);
  }
}

const body = agentBody(secret.secret_id, toolIds);
const agentId = existing ? (await call("PATCH", `/agents/${existing}`, body), existing) : (await call("POST", "/agents/create", body)).agent_id;

// What ElevenLabs stored, so a setting it dropped shows up now rather than on a call.
const stored = await call("GET", `/agents/${agentId}`);
const llm = stored.conversation_config?.agent?.prompt?.custom_llm ?? {};
console.log(`ElevenLabs agent: ${agentId}`);
console.log(`Custom LLM: ${llm.url ?? "(missing)"}`);
console.log(`Request headers: ${JSON.stringify(llm.request_headers ?? {})}`);
console.log(`Tools: ${(stored.conversation_config?.agent?.prompt?.tool_ids ?? []).length} client tools`);
console.log(`Signed tokens required: ${stored.platform_settings?.auth?.enable_auth === true}`);
console.log("Set ELEVENLABS_AGENT_ID to this id in Vercel (see docs/voice.md).");
