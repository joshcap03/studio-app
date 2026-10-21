import { afterEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ voice: undefined as unknown }));
vi.mock("@/lib/config", () => ({ getConfig: () => config }));

const { mockTone, recordingSeconds, speak, speechSeconds, SpeechUnavailable, transcribe, MAX_SPEECH_CHARS } = await import("./speech");
const { ELEVENLABS_STT_MODEL, ELEVENLABS_TTS_MODEL, ELEVENLABS_VOICE_SETTINGS, ELEVENLABS_VOICES } = await import("./elevenlabs");

const ELEVENLABS = { provider: "elevenlabs", elevenlabs: { apiKey: "xi_test", agentId: "agent_test" } };

afterEach(() => {
  vi.unstubAllGlobals();
  config.voice = undefined;
});

describe("speech", () => {
  it("estimates how long text takes to say and a recording runs, for the daily voice time", () => {
    expect(speechSeconds("Hi.")).toBe(1);
    expect(speechSeconds("x".repeat(150))).toBe(10);
    expect(speechSeconds(`  ${"x".repeat(16)}  `)).toBe(2);
    expect(recordingSeconds(0)).toBe(1);
    expect(recordingSeconds(40_000)).toBe(10);
  });

  it("is off without voice, and refuses empty or overlong text before calling anyone", async () => {
    await expect(speak("Hello.", "steady")).rejects.toBeInstanceOf(SpeechUnavailable);
    await expect(transcribe(new Uint8Array(4), "audio/webm")).rejects.toBeInstanceOf(SpeechUnavailable);
    config.voice = ELEVENLABS;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(speak("   ", "steady")).rejects.toBeInstanceOf(RangeError);
    await expect(speak("x".repeat(MAX_SPEECH_CHARS + 1), "steady")).rejects.toBeInstanceOf(RangeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is a labeled tone under the mock, and hears nothing (the member types instead)", async () => {
    config.voice = { provider: "mock" };
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const speech = await speak("Hello.", "warm");
    expect(speech).toMatchObject({ type: "audio/wav", mock: true });
    expect(await transcribe(new Uint8Array(100), "audio/webm")).toEqual({ text: "", seconds: 0, mock: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("makes the mock tone a short, valid WAV", () => {
    const wav = mockTone();
    const view = new DataView(wav.buffer);
    const tag = (at: number) => String.fromCharCode(...wav.slice(at, at + 4));
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
    const rate = view.getUint32(24, true);
    const seconds = view.getUint32(40, true) / 2 / rate;
    expect(seconds).toBeGreaterThan(0.5);
    expect(seconds).toBeLessThan(1.2);
  });

  it("asks ElevenLabs for the chosen voice's MP3 with the call agent's model, keeping the key server side", async () => {
    config.voice = ELEVENLABS;
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", fetch);
    const speech = await speak("  Hello there.  ", "casual");
    expect(speech).toEqual({ audio: new Uint8Array([1, 2, 3]), type: "audio/mpeg", mock: false });
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICES.casual}?output_format=mp3_44100_64`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "xi-api-key": "xi_test" });
    expect(JSON.parse(String(init.body))).toEqual({ text: "Hello there.", model_id: ELEVENLABS_TTS_MODEL, voice_settings: ELEVENLABS_VOICE_SETTINGS });
  });

  it("says SpeechUnavailable when ElevenLabs refuses, fails, or sends nothing", async () => {
    config.voice = ELEVENLABS;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    await expect(speak("Hello.", "steady")).rejects.toBeInstanceOf(SpeechUnavailable);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(0), { status: 200 })));
    await expect(speak("Hello.", "steady")).rejects.toBeInstanceOf(SpeechUnavailable);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network");
      }),
    );
    await expect(speak("Hello.", "steady")).rejects.toBeInstanceOf(SpeechUnavailable);
    await expect(transcribe(new Uint8Array(4), "audio/webm")).rejects.toBeInstanceOf(SpeechUnavailable);
  });

  it("transcribes with Scribe, timing the recording by the length it measured, else the last thing it timed, else its size", async () => {
    config.voice = ELEVENLABS;
    const words = [
      { text: "Find", type: "word", start: 0.1, end: 0.4 },
      { text: " ", type: "spacing", start: 0.4, end: 0.5 },
      { text: "roles", type: "word", start: 0.5, end: 3.2 },
      { text: "(laughs)", type: "audio_event", start: 3.2, end: 9 },
    ];
    // A long silence after the words: the provider's own length is what it charges for.
    const fetch = vi.fn(async () => Response.json({ text: " Find roles ", words, audio_duration_secs: 64.2 }));
    vi.stubGlobal("fetch", fetch);
    expect(await transcribe(new Uint8Array(10), "audio/webm")).toEqual({ text: "Find roles", seconds: 65 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    const form = init.body as FormData;
    expect(form.get("model_id")).toBe(ELEVENLABS_STT_MODEL);
    expect((form.get("file") as Blob).type).toBe("audio/webm");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ text: "Find roles", words })));
    expect(await transcribe(new Uint8Array(10), "audio/webm")).toEqual({ text: "Find roles", seconds: 9 });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ text: "", words: [] })));
    expect(await transcribe(new Uint8Array(20_000), "audio/mp4")).toEqual({ text: "", seconds: 5 });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ words: [] })));
    await expect(transcribe(new Uint8Array(4), "audio/webm")).rejects.toBeInstanceOf(SpeechUnavailable);
  });
});
