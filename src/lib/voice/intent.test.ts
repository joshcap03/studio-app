import { describe, expect, it } from "vitest";
import { isBackchannel, isRedirect, isSendIntent, isStopIntent, spokenWords } from "./intent";

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
