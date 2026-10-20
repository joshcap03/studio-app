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
/** A run this quiet for this long gets one holding line. */
const STILL_ON_IT_MS = 9000;
const STILL_ON_IT = ["Still working on it.", "Bear with me, I'm still on it.", "Still going, one moment."];
/** Seconds before the end of the call for the heads-up, on calls long enough to need one. */
const HEADS_UP_S = 60;
/** A job this long with nothing new gets asked about once: hang on, or a voice note when it's done? */
export const LONG_JOB_MS = 45_000;

/** A line's words compared loosely: case, punctuation, and markdown don't make a sentence new. */
const sameWords = (sentence: string) => plain(sentence).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const FILLER = new Set(["the rest is on screen"]);

interface Queued {
  text: string;
  turn: number;
  /**
   * Said as written, never cut into sentences (a read-back: an address like jo@acme.example isn't
   * two sentences), and `again` even when it's been said already.
   */
  whole?: boolean;
  again?: boolean;
}

export class CallNarrator {
  private relay = initialRelay();
  /** Lines waiting for the floor, each with the turn it belongs to. */
  private lines: Queued[] = [];
  private progress: Queued | null = null;
  private lastProgressAt = 0;
  /** This turn's reply as it streams, and its gist once read (as soon as it was written). */
  private turnText = "";
  private earlyGist: string | null = null;
  private stillSaid = false;
  private turns = 0;
  /** Replies already read, by id and status (a reply paused for an OK is read again when it ends). */
  private read = new Set<string>();
  /** Sentences said, by turn: a turn's lines can still be waiting when the next one starts. */
  private said = new Map<number, Set<string>>();
  private cued = new Set<VoiceCue>();
  /** When the run last brought something new (null until one's been seen going), and whether this turn asked about waiting. */
  private newsAt: number | null = null;
  private longAsked = false;

  /** One streamed event of this conversation's run, at `now`. The run's end is `reply`'s to read. */
  event(event: StreamEvent, now = Date.now()): void {
    if (event.type === "start" || event.type === "text" || event.type === "text-replace" || (event.type === "activity" && !event.step.hidden)) this.newsAt = now;
    if (event.type === "start") {
      this.turns += 1;
      for (const turn of this.said.keys()) if (turn < this.turns - 1) this.said.delete(turn);
      this.turnText = "";
      this.earlyGist = null;
      this.stillSaid = false;
      this.longAsked = false;
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
  reply(message: ChatMessage, options: { superseded?: boolean; spokenApprovals?: boolean; spent?: readonly string[] } = {}): void {
    const key = `${message.id}:${message.status}`;
    if (this.read.has(key)) return;
    this.read.add(key);
    // Progress isn't news once the run is over.
    this.progress = null;
    const question = closingQuestion(message.content);
    let lines = relayReply(message, { spokenApprovals: options.spokenApprovals, spent: options.spent });
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

  /**
   * One of the call's own fixed lines, said ahead of what's queued after it: that the job came
   * back just as the call was about to hang up for its voice note.
   */
  aside(text: string): void {
    this.lines.push({ text, turn: this.turns });
  }

  /**
   * A line said again, word for word, even though it was said this turn: a request's read-back,
   * when what the member said after it means it has to be heard again before a yes counts.
   */
  again(text: string): void {
    this.lines.push({ text, turn: this.turns, whole: true, again: true });
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
      this.lines.push({ text: STILL_ON_IT[(this.turns - 1 + STILL_ON_IT.length) % STILL_ON_IT.length], turn: this.turns });
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

  /**
   * Whether to ask now if they'd rather hang on or get a voice note: once a turn, when the run
   * has gone LONG_JOB_MS with nothing new. `running`: whether the worker is on it.
   */
  longJob(now: number, running: boolean): boolean {
    if (!running) {
      this.newsAt = null;
      return false;
    }
    // A run already going when the call joined counts from when it was first seen.
    this.newsAt ??= now;
    if (this.longAsked || now - this.newsAt < LONG_JOB_MS) return false;
    this.longAsked = true;
    return true;
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
        this.progress = { text: line.text, turn: this.turns };
        continue;
      }
      // Older progress isn't news once the reply is here.
      if (line.kind === "reply") this.progress = null;
      this.lines.push({ text: line.text, turn: this.turns, ...(line.kind === "approval" ? { whole: true } : {}) });
    }
  }

  /** The line without the sentences already said this turn; nothing if only filler is left. A whole line is said as it is, or not at all. */
  private unsaid({ text: line, turn, whole, again }: Queued): string | null {
    const said = this.said.get(turn) ?? new Set<string>();
    this.said.set(turn, said);
    if (whole) {
      const all = sentences(line).map(sameWords).filter(Boolean);
      if (!again && all.length && all.every((w) => said.has(w))) return null;
      for (const w of all) said.add(w);
      return line;
    }
    const kept = sentences(line).filter((s) => {
      const words = sameWords(s);
      if (!words) return false;
      if (said.has(words)) return false;
      said.add(words);
      return true;
    });
    if (kept.every((s) => FILLER.has(sameWords(s)))) return null;
    return kept.join(" ");
  }
}
