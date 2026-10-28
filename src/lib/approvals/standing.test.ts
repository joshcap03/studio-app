import { describe, expect, it } from "vitest";
import { isStandingKind, siteOf, standingKindFor, standingLabel } from "./standing";

const act = (tool: string, args: unknown) => ({ tool, arguments: args });

describe("standingKindFor", () => {
  it("still covers putting labels on the member's own mail and making labels", () => {
    expect(standingKindFor([act("GMAIL_BATCH_MODIFY_MESSAGES", { messageIds: ["a", "b"], addLabelIds: ["Label_7"], removeLabelIds: ["UNREAD"] })])).toBe("gmail_labels");
    expect(standingKindFor([act("GMAIL_ADD_LABEL_TO_EMAIL", { user_id: "me", message_id: "a1", add_label_ids: ["CATEGORY_PROMOTIONS"] })])).toBe("gmail_labels");
    expect(
      standingKindFor([act("GMAIL_CREATE_LABEL", { label_name: "Priority" }), act("GMAIL_BATCH_MODIFY_MESSAGES", { messageIds: ["a"], addLabelIds: ["Label_1"] })]),
    ).toBe("gmail_labels");
  });

  it("keys any other app tool by its slug, so each use case asks once", () => {
    expect(standingKindFor([act("STRIPE_CREATE_REFUND", { charge: "ch_1", amount: 500 })])).toBe("tool:STRIPE_CREATE_REFUND");
    expect(standingKindFor([act("GMAIL_DELETE_MESSAGE", { message_id: "a" }), act("GMAIL_DELETE_MESSAGE", { message_id: "b" })])).toBe("tool:GMAIL_DELETE_MESSAGE");
    // Labels that would trash or archive aren't the tidy kind, so they're keyed by their tool.
    expect(standingKindFor([act("GMAIL_BATCH_MODIFY_MESSAGES", { messageIds: ["a"], addLabelIds: ["TRASH"] })])).toBe("tool:GMAIL_BATCH_MODIFY_MESSAGES");
  });

  it("keys a browser step by the site the browser is on, read from the browser, and by nothing else", () => {
    expect(standingKindFor([act("act", { action: "click Pay and Print" })], { site: "usps.com" })).toBe("site:usps.com");
    expect(standingKindFor([act("act", { action: "click Pay and Print" })])).toBeNull();
    expect(standingKindFor([act("act", { action: "click Pay" })], { site: "not a host" })).toBeNull();
  });

  it("fails closed on code, mixed requests, unreadable actions, or nothing", () => {
    for (const tool of ["composio_remote_workbench", "composio_remote_bash_tool", "COMPOSIO_MANAGE_CONNECTIONS", ""]) {
      expect(standingKindFor([act(tool, { code: "x" })])).toBeNull();
    }
    expect(standingKindFor([act("STRIPE_CREATE_REFUND", {}), act("STRIPE_CREATE_PAYOUT", {})])).toBeNull();
    expect(standingKindFor([act("act", {}), act("STRIPE_CREATE_REFUND", {})], { site: "usps.com" })).toBeNull();
    expect(standingKindFor([])).toBeNull();
    expect(standingKindFor(undefined)).toBeNull();
  });

  it("gives a run an event started only the tidy kind, never money", () => {
    expect(standingKindFor([act("STRIPE_CREATE_REFUND", {})], { tidyOnly: true })).toBeNull();
    expect(standingKindFor([act("act", { action: "Pay" })], { site: "usps.com", tidyOnly: true })).toBeNull();
    expect(standingKindFor([act("GMAIL_ADD_LABEL_TO_EMAIL", { message_id: "a", add_label_ids: ["Label_1"] })], { tidyOnly: true })).toBe("gmail_labels");
  });
});

describe("kinds", () => {
  it("accepts only the shapes the database does", () => {
    for (const k of ["gmail_labels", "tool:STRIPE_CREATE_REFUND", "site:usps.com", "site:cns.usps.com"]) expect(isStandingKind(k)).toBe(true);
    for (const k of ["tool:stripe", "tool:STRIPE", "site:usps", "site:http://usps.com", "site:USPS.COM", "money", "", null, 3]) expect(isStandingKind(k)).toBe(false);
  });

  it("reads a site from the page's origin: https only, without www", () => {
    expect(siteOf("https://www.usps.com")).toBe("usps.com");
    expect(siteOf("https://cns.usps.com")).toBe("cns.usps.com");
    expect(siteOf("http://usps.com")).toBeNull();
    expect(siteOf("about:blank")).toBeNull();
    expect(siteOf(null)).toBeNull();
  });

  it("labels each kind in plain words", () => {
    expect(standingLabel("tool:STRIPE_CREATE_REFUND")).toBe("Stripe: create refund");
    expect(standingLabel("site:usps.com")).toBe("Pay and order on usps.com");
    expect(standingLabel("gmail_labels")).toBe("Sort your Gmail with labels");
  });
});
