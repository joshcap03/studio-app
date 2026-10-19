import type { ChatMessage, JourneyStep, StreamEvent } from "@/lib/types";
import type { VoiceCue } from "./types";
import { closingQuestion, initialRelay, plain, relayEvent, relayJourney, relayReply, sentences, speakableGist, type RelayLine } from "./relay";

// What a call says out loud, from what the backend reported (relay.ts), and in what order: lines
// wait while the voice or the member has the floor and go out together once it's free. A
// sentence is said once per turn, whichever way it arrived: an opening line, the reply read as
// soon as it was written, the same words again in the finished reply, or a reply caught up on
// joining. Pure; the call screen decides when the floor is free and says what this hands it.

/** Progress lines at a calm pace: at most one this often, newest wins. */
const PROGRESS_GAP_MS = 6000;
/** A run this quiet for this long gets one "Still on it." */
const STILL_ON_IT_MS = 9000;
/** Seconds before the end of the call for the heads-up, on calls long enough to need one. */
const HEADS_UP_S = 60;

/** A line's words compared loosely: case, punctuation, and markdown don't make a sentence new. */
const sameWords = (sentence: string) => plain(sentence).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const FILLER = new Set(["the rest is on screen"]);

export class CallNarrator {
  private relay = initialRelay();
  private lines: string[] = [];
  private progress: string | null = null;
  private lastProgressAt = 0;
  /** This turn's reply as it streams, and its gist once read (as soon as it was written). */
  private turnText = "";
  private earlyGist: string | null = null;
  private stillSaid = false;
  /** Replies already read, by id and status (a reply paused for an OK is read again when it ends). */
  private read = new Set<string>();
  /** Sentences said this turn. */
  private said = new Set<string>();
  private cued = new Set<VoiceCue>();

  /** One streamed event of this conversation's run. The run's end is `reply`'s to read. */
  event(event: StreamEvent): void {
    if (event.type === "start") {
      this.turnText = "";
      this.earlyGist = null;
      this.stillSaid = false;
      this.said.clear();
    } else if (event.type === "text") {
      this.turnText += event.delta;
    } else if (event.type === "text-replace") {
      this.turnText = event.text;
    } else if (event.type === "activity" && this.earlyGist === null && this.turnText.trim()) {
      // The agent wrote its reply and moved on (its plan, its memory): read it now rather than
      // when the turn ends.
      const gist = speakableGist(this.turnText);
      if (gist) {
        this.earlyGist = gist;
        this.queue([{ kind: "reply", text: gist, droppable: false }]);
      }
    }
    const out = relayEvent(this.relay, event);
    this.relay = out.state;
    this.queue(out.lines);
  }

  /**
   * A finished reply, read once: its gist and what it asks of the member. `superseded` when the
   * member has already said more (held while it worked), which goes along next: the question it
   * ends on is theirs to hear from the next reply, not this one.
   */
  reply(message: ChatMessage, options: { superseded?: boolean } = {}): void {
    const key = `${message.id}:${message.status}`;
    if (this.read.has(key)) return;
    this.read.add(key);
    // Progress isn't news once the run is over.
    this.progress = null;
    const question = closingQuestion(message.content);
    let lines = relayReply(message);
    // Its gist was read as soon as it was written; only a closing question that came after is new.
    const early = this.earlyGist;
    if (early) {
      lines = lines.flatMap((line) => (line.kind !== "reply" ? [line] : question && !early.includes(question) ? [{ ...line, text: question }] : []));
    }
    if (options.superseded && question) {
      lines = lines.flatMap((line) => {
        if (line.kind !== "reply") return [line];
        const text = line.text.replace(question, "").trim();
        return text ? [{ ...line, text }] : [];
      });
    }
    this.queue(lines);
  }

  /** What finishing each journey step gave the agent. */
  journey(before: JourneyStep[], after: JourneyStep[]): void {
    this.queue(relayJourney(before, after));
  }

  /**
   * What to say now that the floor is free, if anything. `quietMs`: how long since anyone last
   * spoke; `running`: whether the worker is on it.
   */
  take(now: number, { running, quietMs }: { running: boolean; quietMs: number }): string[] {
    if (running && !this.lines.length && !this.progress && !this.stillSaid && quietMs >= STILL_ON_IT_MS) {
      this.stillSaid = true;
      this.lines.push("Still on it.");
    }
    const out = this.lines.splice(0);
    if (this.progress && (out.length || now - this.lastProgressAt >= PROGRESS_GAP_MS)) {
      out.push(this.progress);
      this.progress = null;
      this.lastProgressAt = now;
    }
    return out.flatMap((line) => {
      const fresh = this.unsaid(line);
      return fresh ? [fresh] : [];
    });
  }

  /** The call's clock: the heads-up a minute before the end (on calls long enough), then time's up, each once. */
  clock(elapsed: number, maxSeconds: number): VoiceCue | null {
    if (elapsed >= maxSeconds) return this.cueOnce("time_up");
    if (maxSeconds > 2 * HEADS_UP_S && elapsed >= maxSeconds - HEADS_UP_S) return this.cueOnce("heads_up");
    return null;
  }

  private cueOnce(cue: VoiceCue): VoiceCue | null {
    if (this.cued.has(cue)) return null;
    this.cued.add(cue);
    return cue;
  }

  private queue(lines: RelayLine[]): void {
    for (const line of lines) {
      if (line.droppable) {
        this.progress = line.text;
        continue;
      }
      // Older progress isn't news once the reply is here.
      if (line.kind === "reply") this.progress = null;
      this.lines.push(line.text);
    }
  }

  /** The line without the sentences already said this turn; nothing if only filler is left. */
  private unsaid(line: string): string | null {
    const kept = sentences(line).filter((s) => {
      const words = sameWords(s);
      if (!words) return false;
      if (this.said.has(words)) return false;
      this.said.add(words);
      return true;
    });
    if (kept.every((s) => FILLER.has(sameWords(s)))) return null;
    return kept.join(" ");
  }
}
