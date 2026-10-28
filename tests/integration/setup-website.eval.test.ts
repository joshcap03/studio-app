import { afterAll, describe, expect, it } from "vitest";
import { describeTurn, liveFlow, setupSession, type ScriptedMember } from "./setup-harness";

// A short eval of the setup interview against a live flow with a real model (LANGFLOW_TEST_* env;
// see setup-harness.ts), to the agent's advice only: someone whose time goes to a job they do by
// hand on a website, paying at checkout each time. The agent's browser can do that job with them
// (sign-ins and cards through the secure card, each change on their OK), so its advice offers to,
// rather than saying it can't use the site. The seller and their shop are made up.

const ADVICE = /\b(recommend|suggest|i'd start|start with|help (you )?most|where i (can|could) help|here's my read|i think i (can|could)|i'd leave)\b/i;
const OFFERS_SITE = /\b(browser|(?:i|i'd|i could|i can) (?:\w+ ){0,4}(?:buy|purchase|check ?out|pay for|make|create|fill)\b[^.]{0,80}\b(?:labels?|site|website|form)|(?:on|through|in) (?:the|their|your) (?:carrier'?s? )?(?:site|website))/i;
const REFUSES_SITE = /\b(?:can't|cannot|can not|unable to|not able to) (?:\w+ ){0,3}(?:click|log ?in|sign in|use|go into|get into|reach|access|operate|work in)\b[^.]{0,40}\b(?:site|website|carrier|shipping|label|for you)/i;
const plain = (s: string) => s.replace(/[‘’]/g, "'");

const SELLER: ScriptedMember = {
  templateId: "small-business",
  agentName: "Shop",
  name: "Robin",
  discovery: [
    "I need help making my shipping labels. I spend a lot of time making them on the carrier's website.",
    "People order through my shop's social account, send me their address, and I go onto the carrier's website, type it all in, pay for the label, and download it.",
    "About 40 a week. Typing every address and paying for each label one by one is the slow part.",
    "It's always the same box, weight, and speed.",
  ],
  advice: ADVICE,
  agree: "Yes, that's it.",
  bar: [],
  passReason: "Not for my shop",
};

describe.skipIf(!liveFlow)("Setup interview for a job done by hand on a website, to the advice", () => {
  const session = setupSession(SELLER);
  const { turns, answer } = session;

  afterAll(() => session.writeLog("website setup"));

  it("offers to do the website job in its browser instead of saying it can't", { timeout: 600_000 }, async () => {
    let last = await session.start();
    for (let i = 0; i < 6 && !(turns.length > 2 && ADVICE.test(last.reply) && last.reply.length > 400) && !last.form; i++) last = await answer(last);
    const said = turns.slice(1).map((x) => plain(x.reply)).join("\n---\n");
    expect(said, turns.map(describeTurn).join("\n---\n")).toMatch(OFFERS_SITE);
    expect(said, turns.map(describeTurn).join("\n---\n")).not.toMatch(REFUSES_SITE);
  });
});
