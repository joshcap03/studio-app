"use client";

import { Check, Eye, RotateCcw, StickyNote } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { shownLines, shownText } from "@/lib/chat/show-me";
import { api, ApiError } from "@/lib/client/api";
import { MAX_SHOWN_NOTES, MAX_SHOWN_STEPS, type Attachment, type ShownNote, type ShownStep, type UiHandoff, type UiResponse } from "@/lib/types";
import { useVoiceOn } from "@/components/voice/player";
import { BrowserDrive } from "./browser-drive";
import { listenForNotes } from "./show-me-notes";

// "Show me once" (the agent's watch_me tool, a browser hand-off marked to watch): the member does
// a job in the agent's browser while Studio notes each step, and the agent writes it up as a skill
// for them to check. Nothing happens until they tap Show me. They drive the browser through Studio
// (BrowserDrive), so the server sees each input and says what it was done to; what goes into a
// password, card, or code field is never kept. They add why as they go, typed here or said on a
// call (show-me-notes.ts). They see each step as it's noted, and Done sends exactly that as their
// next message (src/lib/chat/show-me.ts).

const card = "mt-4 overflow-hidden rounded-xl border border-line-strong bg-surface shadow-composer animate-fade-up";
const input =
  "w-full rounded-lg border border-line bg-transparent px-3 py-2 text-[14px] leading-[1.5] text-fg placeholder:text-fg-4 focus:border-line-strong focus:outline-none";
const primary =
  "inline-flex h-8 items-center gap-1.5 rounded-lg bg-inverse px-3.5 text-[13px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:bg-press disabled:text-fg-4";
const secondary = "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg disabled:opacity-60";

/** The latest lines shown while recording; the rest are counted. */
const RECENT = 4;

export function ShowMeCard({
  handoff,
  response,
  conversationId,
  messageId,
  onAnswer,
  onResponse,
}: {
  handoff: UiHandoff;
  response?: UiResponse;
  conversationId: string;
  messageId: string;
  /** Present while it can be shown (the latest reply, agent idle). */
  onAnswer?: (text: string, extras: { attachments: Attachment[] }) => void;
  onResponse?: (messageId: string, blockId: string, response: UiResponse) => void;
}) {
  const [showing, setShowing] = useState(false);
  const [steps, setSteps] = useState<ShownStep[]>([]);
  const [notes, setNotes] = useState<ShownNote[]>([]);
  const [note, setNote] = useState("");
  // Notes can be said on a call only where there are calls.
  const voiceOn = useVoiceOn();
  const [busy, setBusy] = useState<"start" | "done" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // Kept in step at once, since Done can come right after the last input lands.
  const stepsRef = useRef<ShownStep[]>([]);
  const notesRef = useRef<ShownNote[]>([]);

  const addStep = (step: ShownStep) => {
    if (stepsRef.current.length >= MAX_SHOWN_STEPS) return;
    stepsRef.current = [...stepsRef.current, step];
    setSteps(stepsRef.current);
  };
  const addNote = (text: string, via: ShownNote["via"]) => {
    const words = text.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!words || notesRef.current.length >= MAX_SHOWN_NOTES) return;
    notesRef.current = [...notesRef.current, { at: Date.now(), text: words, via }];
    setNotes(notesRef.current);
  };

  // While recording, what they say on a call in this conversation is a note.
  useEffect(() => (showing && !sent ? listenForNotes(conversationId, (words) => addNote(words, "call")) : undefined), [showing, sent, conversationId]);

  const where = handoff.site ? ` on ${handoff.site}` : "";
  if (!onAnswer || sent || response) {
    const shown = response?.status === "handed-back" ? response : null;
    return (
      <section aria-label="Show me how" className="mt-3 flex items-start gap-2 text-[13px] leading-[1.5] text-fg-3 animate-fade-up">
        {shown || sent ? <Check size={14} className="settle-check mt-[3px] shrink-0 text-success" /> : <Eye size={14} className="mt-[3px] shrink-0 text-fg-4" />}
        <span className="min-w-0 [overflow-wrap:anywhere]">
          Asked you to show me how{where}
          {shown || sent ? (
            <span className="text-fg-4">
              {" "}
              · You showed me{shown?.steps ? ` ${shown.steps} ${shown.steps === 1 ? "step" : "steps"}` : ""}
            </span>
          ) : null}
        </span>
      </section>
    );
  }
  const answer = onAnswer;

  /** Where the page is, as a step: where the showing starts, or where it ended. */
  const look = async () => {
    const at = Date.now();
    const { step } = await api.driveBrowser(conversationId, { type: "look" }, { record: true });
    if (step) addStep({ ...step, at });
  };

  async function start() {
    setBusy("start");
    setError(null);
    stepsRef.current = [];
    notesRef.current = [];
    setSteps([]);
    setNotes([]);
    try {
      await look();
      setShowing(true);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? "There's no browser open here right now. Ask me to open the page again." : e instanceof ApiError ? e.message : "Couldn't reach the browser just now. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function done() {
    setBusy("done");
    setError(null);
    if (note.trim()) {
      addNote(note, "typed");
      setNote("");
    }
    // The last inputs land first, then where it ended.
    await queue.current.catch(() => undefined);
    await look().catch(() => undefined);
    const recorded = stepsRef.current;
    const count = shownLines(recorded, []).length;
    try {
      const { response: saved } = await api.answerUi(conversationId, handoff.id, { action: "handback", steps: count });
      onResponse?.(messageId, handoff.id, saved);
    } catch (e) {
      // Already handed back (another tab): still send it, once.
      if (!(e instanceof ApiError && e.status === 409)) {
        setError(e instanceof ApiError ? e.message : "Couldn't send this. Try again.");
        setBusy(null);
        return;
      }
    }
    setSent(true);
    setBusy(null);
    answer(shownText(handoff, recorded, notesRef.current), { attachments: [] });
  }

  const lines = shownLines(steps, notes);
  const stepCount = lines.filter((l) => l.kind === "step").length;
  const recent = lines.slice(-RECENT);
  let number = stepCount - recent.filter((l) => l.kind === "step").length;

  return (
    <section aria-label="Show me how" className={card}>
      <div className="flex items-start gap-3 px-4 pt-3.5 pb-3">
        <Eye size={17} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] font-medium leading-[1.45] text-fg">Show me how{where}</p>
          <p className="mt-0.5 text-[13.5px] leading-[1.5] text-fg-2 [overflow-wrap:anywhere]">{handoff.reason}</p>
        </div>
      </div>

      {showing ? (
        <div className="flex flex-col gap-3 px-4 pb-3">
          <BrowserDrive conversationId={conversationId} onStep={addStep} queue={queue} status="I'm watching. Do it as you usually would." />
          <div aria-live="polite" className="rounded-lg bg-subtle px-3 py-2 text-[12.5px] leading-[1.55] text-fg-2">
            {lines.length === 0 ? (
              <p className="text-fg-3">Each step shows here as I note it. What goes into a password, card, or code field isn&apos;t kept.</p>
            ) : (
              <>
                {stepCount > recent.filter((l) => l.kind === "step").length ? <p className="text-fg-4">{number} earlier {number === 1 ? "step" : "steps"}</p> : null}
                <ol className="flex flex-col gap-0.5">
                  {recent.map((l, i) =>
                    l.kind === "note" ? (
                      <li key={i} className="flex gap-1.5 text-fg-3">
                        <StickyNote size={12} className="mt-[3px] shrink-0" aria-hidden="true" />
                        <span className="min-w-0 [overflow-wrap:anywhere]">“{l.text}”</span>
                      </li>
                    ) : (
                      <li key={i} className="flex gap-1.5">
                        <span className="w-5 shrink-0 text-right tabular-nums text-fg-4">{(number += 1)}.</span>
                        <span className="min-w-0 [overflow-wrap:anywhere]">
                          {l.page ? <span className="text-fg-3">{l.page}: </span> : null}
                          {l.text}
                        </span>
                      </li>
                    ),
                  )}
                </ol>
              </>
            )}
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addNote(note, "typed");
              setNote("");
            }}
          >
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
              placeholder={voiceOn ? "Why that one? Add a note, or say it on a call" : "Why that one? Add a note"}
              aria-label="Add a note on what you're doing"
              className={input}
            />
            <button type="submit" disabled={!note.trim()} className={secondary}>
              Add
            </button>
          </form>
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2 border-t border-line px-3 py-2.5">
        <span className={`mr-auto min-w-0 pl-1 text-[12px] ${error ? "text-danger" : "text-fg-3"}`}>
          {error ?? (showing ? `${stepCount} ${stepCount === 1 ? "step" : "steps"} so far` : "Do it once in my browser and I'll write it up as a skill. Passwords and cards aren't recorded.")}
        </span>
        {showing ? (
          <>
            <button type="button" onClick={() => void start()} disabled={busy !== null} className={secondary}>
              <RotateCcw size={13} />
              Start over
            </button>
            <button type="button" onClick={() => void done()} disabled={busy !== null || stepCount === 0} className={primary}>
              {busy === "done" ? <span className="spinner size-3.5" aria-hidden="true" /> : <Check size={14} />}
              Done
            </button>
          </>
        ) : (
          <button type="button" onClick={() => void start()} disabled={busy !== null} className={primary}>
            {busy === "start" ? <span className="spinner size-3.5" aria-hidden="true" /> : <Eye size={14} />}
            Show me
          </button>
        )}
      </div>
    </section>
  );
}
