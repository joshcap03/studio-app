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
    typing: null,
    closeTyping: none,
    typed: none,
    cancel: none,
    dismiss: none,
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
