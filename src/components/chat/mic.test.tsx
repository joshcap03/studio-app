import { Tooltip } from "radix-ui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MicState } from "@/lib/voice/mic";
import { MicButton, MicStatus, type MicControl } from "./mic";

// What the message box's mic shows: the timer is on screen but never read out each second, and
// the mic waits while a call has it.

function control(state: MicState, patch: Partial<MicControl> = {}): MicControl {
  const none = () => undefined;
  return {
    state,
    held: false,
    elapsed: 0,
    hold: true,
    level: () => 0,
    typing: null,
    closeTyping: none,
    typed: none,
    cancel: none,
    done: none,
    dismiss: none,
    dictate: none,
    button: { onPointerDown: none, onPointerMove: none, onPointerUp: none, onPointerCancel: none, onClick: none, onContextMenu: none },
    ...patch,
  };
}

const RECORDING: MicState = { phase: "recording", pressedAt: 0, startedAt: 0, down: true, mode: null };

/** The text inside each live region of `html`. */
function announced(html: string): string[] {
  return [...html.matchAll(/<(\w+)[^>]*role="(?:status|alert)"[^>]*>(.*?)<\/\1>/g)].map((m) => m[2].replace(/<[^>]+>/g, ""));
}

describe("the mic while it records", () => {
  it("shows the timer without announcing it, and announces what to do", () => {
    const html = renderToStaticMarkup(<MicStatus mic={control(RECORDING, { elapsed: 5.4 })} holdsToDraft={false} />);
    expect(html).toContain("0:05 / 2:00");
    expect(announced(html)).toEqual(["Let go to send · slide away to cancel"]);
    const dictating = renderToStaticMarkup(<MicStatus mic={control({ ...RECORDING, down: false, mode: "dictation" }, { elapsed: 61 })} holdsToDraft={false} />);
    expect(announced(dictating).join(" ")).not.toMatch(/\d:\d\d/);
  });

  it("dictating, shows the waveform and the timer, with cancel and done", () => {
    const html = renderToStaticMarkup(<MicStatus mic={control({ ...RECORDING, down: false, mode: "dictation" }, { elapsed: 61, hold: false })} holdsToDraft={false} />);
    expect(html).toContain("1:01");
    expect(html).not.toContain("/ 2:00");
    expect(announced(html)).toEqual(["Listening · tap ✓ when you&#x27;re done · Esc cancels"]);
    expect(html).toContain('aria-label="Cancel"');
    const done = (markup: string) => markup.match(/<button[^>]*aria-label="Done: add the words to your message"[^>]*>/)?.[0] ?? "";
    expect(done(html)).not.toBe("");
    expect(done(html)).not.toContain('disabled=""');
    // Still opening, nothing to be done with yet.
    const opening = renderToStaticMarkup(<MicStatus mic={control({ phase: "starting", pressedAt: 0, down: false, mode: "dictation" }, { hold: false })} holdsToDraft={false} />);
    expect(opening.match(/<button[^>]*Done: add the words[^>]*>/)?.[0]).toContain('disabled=""');
  });

  it("is plain dictation without voice: no hold to send", () => {
    const html = renderToStaticMarkup(
      <Tooltip.Provider>
        <MicButton mic={control({ phase: "idle" }, { hold: false })} />
      </Tooltip.Provider>,
    );
    expect(html).toContain('aria-label="Dictate"');
    expect(html).not.toContain("voice message");
  });

  it("waits while a call has the mic", () => {
    const render = (held: boolean) =>
      renderToStaticMarkup(
        <Tooltip.Provider>
          <MicButton mic={control({ phase: "idle" }, { held })} />
        </Tooltip.Provider>,
      );
    expect(render(true)).toMatch(/<button[^>]*disabled=""/);
    expect(render(false)).not.toMatch(/<button[^>]*disabled=""/);
  });
});
