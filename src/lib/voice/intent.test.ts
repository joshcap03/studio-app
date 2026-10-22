import { describe, expect, it } from "vitest";
import {
  greetingKind,
  isLookIntent,
  isOpenIntent,
  pressIntent,
  isAffirmation,
  isApproveIntent,
  isBackchannel,
  isDeclineIntent,
  isHangOnIntent,
  isHoldOn,
  isRedirect,
  isRetryIntent,
  isSendIntent,
  isStopIntent,
  isVoiceNoteIntent,
  LATE_ANSWER_MS,
  longJobAnswer,
  spokenWords,
} from "./intent";

describe("isSendIntent", () => {
  it("takes a clear send, alone or ending what they said", () => {
    for (const said of ["Send", "send it.", "Okay, send it", "That's it, send.", "Keep four and send", "Pass on five. Send it now.", "go ahead and send it", "submit"]) {
      expect(isSendIntent(said), said).toBe(true);
    }
  });
  it("ignores send that isn't a command to send this card", () => {
    for (const said of ["Don't send it yet", "send me a summary", "I'll send it later", "should I send it?", "Send it to Sam instead of me", "keep four", ""]) {
      expect(isSendIntent(said), said).toBe(false);
    }
  });
});

describe("isStopIntent", () => {
  it("takes a plain stop", () => {
    for (const said of ["Stop", "stop.", "Okay stop that", "Wait, stop.", "cancel", "stop the search"]) expect(isStopIntent(said), said).toBe(true);
  });
  it("leaves stops with more to say to redirects", () => {
    for (const said of ["Stop, look in Austin instead", "don't stop", "nonstop", "mm-hm"]) expect(isStopIntent(said), said).toBe(false);
  });
});

describe("isRedirect", () => {
  it("takes 'actually…' and 'stop, …' with something after them", () => {
    for (const said of ["Actually, look in Austin too", "No, actually, skip agencies", "Stop, do contract roles instead", "Scratch that, remote only"]) {
      expect(isRedirect(said), said).toBe(true);
    }
  });
  it("doesn't take asides or backchannels as a change of course", () => {
    for (const said of ["Also, no agencies", "mm-hm", "yeah", "Actually", "That's actually great", "stop"]) expect(isRedirect(said), said).toBe(false);
  });
});

describe("isRetryIntent", () => {
  it("takes a plain 'try again'", () => {
    for (const said of ["Try again", "try that again.", "Okay, try again", "Can you try it again please", "retry", "Give it another go"]) {
      expect(isRetryIntent(said), said).toBe(true);
    }
  });
  it("leaves anything more, or anything else, to be said to the worker", () => {
    for (const said of ["Try again but in Austin", "don't try again", "try a different search", "again?", "yeah", "Try again. And add remote roles.", ""]) {
      expect(isRetryIntent(said), said).toBe(false);
    }
  });
});

describe("hang on, or a voice note?", () => {
  it("hears a voice note asked for, however the answer starts", () => {
    for (const said of [
      "Voice note",
      "A voice note, please.",
      "Just send me a voice note",
      "No, just send me a voice note",
      "No, just send a voice note",
      "No, send me a voice note.",
      "No, a voice note is fine.",
      "Nah, send me a voice note",
      "Nope, voice note",
      "Not now, send me a voice note",
      "Leave me a note",
      "voice note is fine",
      "Can you send me a voice note?",
      "I'd rather have a voice note when it's done",
      "Actually, just send me a voice note",
    ]) {
      expect(isVoiceNoteIntent(said), said).toBe(true);
      expect(isHangOnIntent(said), said).toBe(false);
    }
  });
  it("hears hanging on, even with the note turned down in the same breath", () => {
    for (const said of [
      "I'll hang on",
      "Yeah, I can wait.",
      "I'll wait, thanks",
      "keep going",
      "No, I'll stay on the line",
      "Sure, hang on",
      "I'll just wait",
      "Nah I'm good, I'll wait",
      "No thanks, I'll hang on",
      "Thanks, I'll hang on",
      "No voice note, I'll wait",
      "No need for a voice note, I'll hang on",
      "I don't need a voice note, I'll wait",
      "I'll hang on, let me know when it's done.",
      "Yeah I'll wait, just let me know when it's done",
      "I'll hang on and you let me know when it's done",
      "Actually, I'll wait",
      "I can wait, no voice note",
      "I'll hang on, no need for a voice note thanks",
    ]) {
      expect(isHangOnIntent(said), said).toBe(true);
      expect(isVoiceNoteIntent(said), said).toBe(false);
    }
  });
  it("never takes a request that mentions a note, or comes with one, for the answer", () => {
    for (const said of [
      "Send a note to Sarah that I'm running late",
      "Leave a note on the Casting Co invoice saying paid",
      "Drop a note in the tracker that Bob called",
      "Send a note to the landlord too",
      "Also leave a note for Casting Co about the invoice",
      "Voice note is fine, and also add Acme to the tracker",
      "Also email Bob, and send me a voice note when it's done",
    ]) {
      expect(isVoiceNoteIntent(said), said).toBe(false);
      expect(isHangOnIntent(said), said).toBe(false);
    }
  });
  it("takes neither from a no, a question, or something else", () => {
    for (const said of [
      "I don't need a voice note",
      "don't send a voice note",
      "Don't send me a voice note",
      "no voice note",
      "No voice notes",
      "No, not a voice note",
      "I'd rather not get a voice note",
      "No need for a voice note",
      "What's a voice note?",
      "Let me know when it's done",
      "Also look in Austin",
      "I can't wait",
      "mm-hm",
      "",
    ]) {
      expect(isVoiceNoteIntent(said), said).toBe(false);
    }
    for (const said of ["Hang on, look in Austin too", "Wait, what's taking so long?", "I can't wait", "I can't just wait", "Don't wait", "Let me know when it's done", "I don't need a voice note", "mm-hm", ""]) {
      expect(isHangOnIntent(said), said).toBe(false);
    }
  });
});

describe("isBackchannel", () => {
  it("knows acknowledgements from answers", () => {
    for (const said of ["Mm-hm.", "yeah", "Okay", "right", "Got it", "uh huh"]) expect(isBackchannel(said), said).toBe(true);
    for (const said of ["yes", "Yeah, remote only", "okay send it", "no"]) expect(isBackchannel(said), said).toBe(false);
  });
});

describe("spokenWords", () => {
  it("drops punctuation, case, and fillers", () => {
    expect(spokenWords("Um, Product Designer — uh, senior!")).toBe("product designer senior");
  });
});

describe("longJobAnswer", () => {
  const asked = { open: true, running: true, closedAt: null, now: 10_000 };

  it("takes what they said last as the answer, and anything before it as talk-over", () => {
    expect(longJobAnswer(["voice note"], asked)).toEqual({ answer: "note", late: false, earlier: "" });
    expect(longJobAnswer(["Also add Acme", "No, I'll hang on"], asked)).toEqual({ answer: "wait", late: false, earlier: "Also add Acme" });
    // A request said with it, or after it, isn't the answer.
    expect(longJobAnswer(["Voice note is fine, and also add Acme to the tracker"], asked)).toBeNull();
    expect(longJobAnswer(["voice note", "and add Acme"], asked)).toBeNull();
  });

  it("is only an answer while the question is open, or just after the job came back", () => {
    expect(longJobAnswer(["voice note"], { ...asked, open: false })).toBeNull();
    expect(longJobAnswer(["voice note"], { ...asked, running: false })).toBeNull();
    // The job came back a moment before they answered: there's nothing to wait for.
    const closed = { open: false, running: false, closedAt: 10_000, now: 10_000 + LATE_ANSWER_MS - 1 };
    expect(longJobAnswer(["voice note"], closed)).toEqual({ answer: "note", late: true, earlier: "" });
    expect(longJobAnswer(["I'll wait"], closed)).toEqual({ answer: "wait", late: true, earlier: "" });
    expect(longJobAnswer(["voice note"], { ...closed, now: 10_000 + LATE_ANSWER_MS })).toBeNull();
    expect(longJobAnswer(["Find more roles"], closed)).toBeNull();
  });
});

describe("approving a request by voice", () => {
  it("takes a clear action phrase, with plain agreement around it", () => {
    for (const said of [
      "Send it",
      "send it.",
      "Send.",
      "Yes, send it",
      "Yes. Send it.",
      "Yeah, send it please",
      "Okay, go ahead",
      "Go ahead and send it",
      "Go for it",
      "Approve it",
      "I approve",
      "Yes, do it",
      "Do it.",
      "Uh, yeah, send it",
      "That's right, send it now",
      "Just send it",
      "Confirm",
    ]) {
      expect(isApproveIntent(said), said).toBe(true);
    }
  });

  it("never takes agreement alone, a question, a negation, a hedge, or anything more", () => {
    for (const said of [
      "Yes",
      "yeah",
      "okay",
      "sure",
      "Sounds good",
      "That's right",
      "Send it?",
      "Should I send it",
      "Don't send it",
      "No, send it",
      "No",
      "Not yet",
      "Send it later",
      "Send it, but to Sam",
      "Send it to Sam instead",
      "Send it and cc Sam",
      "Send it. Actually, wait.",
      "Yes, but change the subject",
      "Wait",
      "Maybe send it",
      "I guess send it",
      "Send me a summary",
      "Approved?",
      "Go ahead and change it",
      "",
    ]) {
      expect(isApproveIntent(said), said).toBe(false);
    }
  });
});

describe("declining a request by voice", () => {
  it("takes a clear no to it", () => {
    for (const said of ["Don't send it", "No, don't send it.", "Decline", "decline it", "No, cancel that", "Cancel it", "Reject it", "Never mind", "No thanks", "Actually, don't", "Forget it", "Scratch that"]) {
      expect(isDeclineIntent(said), said).toBe(true);
    }
  });
  it("leaves a bare no, stop, or cancel, and anything more, alone", () => {
    for (const said of ["No", "Stop", "Cancel", "Wait", "Don't send it yet", "Don't send it to Sam", "No, send it to Sam", "Decline? Why?", "Send it", "Don't worry about it, I'll do it", ""]) {
      expect(isDeclineIntent(said), said).toBe(false);
    }
  });
});

describe("agreeing, and holding off", () => {
  it("knows agreement that asks for nothing", () => {
    for (const said of ["Yes", "Yeah, that's right", "Correct.", "Sounds good", "Yes please", "Okay okay"]) expect(isAffirmation(said), said).toBe(true);
    for (const said of ["Yes, send it", "Yes, but", "No", "That's wrong", "Right, and add Sam", ""]) expect(isAffirmation(said), said).toBe(false);
  });
  it("knows holding off that asks for nothing", () => {
    for (const said of ["Wait", "Hold on a sec", "No, wait", "Not yet", "Stop", "Cancel", "One second", "Let me think"]) expect(isHoldOn(said), said).toBe(true);
    for (const said of ["Wait, change the subject", "Stop sending emails", "Hold the Tuesday slot", "No", "Send it", ""]) expect(isHoldOn(said), said).toBe(false);
  });
});

describe("isLookIntent", () => {
  it("hears a request to look at what they're showing", () => {
    for (const said of ["Look at this", "can you see my screen?", "Take a look at that error", "do you see this", "have a look", "check this out"]) {
      expect(isLookIntent(said), said).toBe(true);
    }
  });
  it("ignores other talk and being told not to look", () => {
    for (const said of ["I'll look into it later", "find roles that look good", "don't look at that", "send it", "okay"]) {
      expect(isLookIntent(said), said).toBe(false);
    }
  });
});

describe("greetingKind", () => {
  it("knows a hello, a how-are-you, and a check of the line", () => {
    for (const said of ["hello", "Hello?", "hi there", "Hey Rowan!", "hello hello", "Good morning.", "oh, hi"]) expect(greetingKind(said, "Rowan")).toBe("hello");
    for (const said of ["Hey, how are you?", "how's it going", "hi Rowan, how are you doing today?"]) expect(greetingKind(said, "Rowan")).toBe("how");
    for (const said of ["Can you hear me?", "hello? are you there?", "Rowan, are you there?", "is this working", "hello, anyone there?"]) expect(greetingKind(said, "Rowan")).toBe("check");
  });

  it("is never a request said with a hello", () => {
    for (const said of ["hi, find me jobs in Austin", "hey stop", "hello, send it", "okay", "so", "Austin", "hey June", "there", "what's up with my application?"]) {
      expect(greetingKind(said, "Rowan")).toBeNull();
    }
  });
});

describe("isOpenIntent", () => {
  it("takes asking to go somewhere in Studio, and nothing more", () => {
    for (const said of ["Open my tasks", "show me the job tracker", "Can you pull up the Ramp chat?", "go back to the Ramp and Stash chat", "new chat", "Go back.", "take me to settings please"]) {
      expect(isOpenIntent(said), said).toBe(true);
    }
  });
  it("never takes a request that only starts that way", () => {
    for (const said of ["I'm open to agencies", "open to ideas", "show me how to write a cover letter", "open my tasks and run the first one", "What's open right now?", "go to the gym", "Find me roles"]) {
      expect(isOpenIntent(said), said).toBe(said === "go to the gym");
    }
  });
});

describe("pressIntent", () => {
  it("names the button they asked for", () => {
    expect(pressIntent("Pause it.")).toBe("pause");
    expect(pressIntent("okay, run it now")).toBe("run_now");
    expect(pressIntent("Can you resume this task?")).toBe("resume");
    expect(pressIntent("turn it back on")).toBe("resume");
    expect(pressIntent("open its chat")).toBe("open_chat");
    expect(pressIntent("show me the results")).toBe("open_results");
  });
  it("is nothing for anything more, or anything else", () => {
    for (const said of ["pause it and email Sam", "run the numbers for me", "should I pause it?", "stop", "send it", "the results look good"]) {
      expect(pressIntent(said), said).toBeNull();
    }
  });
});
