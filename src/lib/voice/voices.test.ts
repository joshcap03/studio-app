import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ELEVENLABS_TTS_MODEL, ELEVENLABS_VOICE_SETTINGS, ELEVENLABS_VOICES } from "./elevenlabs";
import { VOICES, VOICE_KEYS, isVoiceKey, voiceByKey } from "./voices";

const SCRIPT = readFileSync(join(__dirname, "..", "..", "..", "scripts", "voice-agent.mjs"), "utf8");

describe("voices", () => {
  it("are Studio's own: unique keys the database takes, short labels, one line each", () => {
    expect(new Set(VOICE_KEYS).size).toBe(VOICES.length);
    expect(new Set(VOICES.map((v) => v.label.toLowerCase())).size).toBe(VOICES.length);
    for (const v of VOICES) {
      // agent_companions.voice checks the same shape.
      expect(v.key).toMatch(/^[a-z0-9-]{1,40}$/);
      expect(v.label.length).toBeLessThanOrEqual(16);
      expect(v.description.length).toBeLessThanOrEqual(80);
      expect(v.description).toMatch(/\.$/);
    }
    expect(isVoiceKey("steady")).toBe(true);
    expect(isVoiceKey("Steady")).toBe(false);
    expect(isVoiceKey("SAz9YHcvj6GT2YYXdXww")).toBe(false);
    expect(voiceByKey("warm")?.label).toBe("Warm");
    expect(voiceByKey(null)).toBeUndefined();
  });

  it("each map to one ElevenLabs voice, and only the adapter knows which", () => {
    expect(Object.keys(ELEVENLABS_VOICES).sort()).toEqual([...VOICE_KEYS].sort());
    expect(new Set(Object.values(ELEVENLABS_VOICES)).size).toBe(VOICES.length);
    // The voices calls already used.
    expect(ELEVENLABS_VOICES).toMatchObject({ steady: "SAz9YHcvj6GT2YYXdXww", clear: "Xb7hH8MSUJpSbSDYk0k2", easygoing: "cjVigY5qzO86Huf0OWal" });
    for (const id of Object.values(ELEVENLABS_VOICES)) expect(JSON.stringify(VOICES)).not.toContain(id);
  });

  it("match what scripts/voice-agent.mjs sets up and checks, speech model included", () => {
    for (const [key, id] of Object.entries(ELEVENLABS_VOICES)) expect(SCRIPT).toContain(`${key}: "${id}"`);
    expect(SCRIPT).toContain(`const TTS_MODEL = "${ELEVENLABS_TTS_MODEL}";`);
    // And speaks the same way: the same speed and steadiness as previews and voice notes.
    expect(SCRIPT).toContain(`const TTS = { model_id: TTS_MODEL, speed: ${ELEVENLABS_VOICE_SETTINGS.speed}, stability: ${ELEVENLABS_VOICE_SETTINGS.stability} };`);
    expect(SCRIPT).toContain("tts: TTS,");
    // Each call still picks its voice.
    expect(SCRIPT).toContain("conversation_config_override: { tts: { voice_id: true } }");
  });
});
