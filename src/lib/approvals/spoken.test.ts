import { describe, expect, it } from "vitest";
import type { ApprovalAction } from "@/lib/agent/types";
import { TECHNICAL } from "@/lib/voice/relay";
import { fitTools, MAX_READ_BACK, MAX_TOOLS_CHARS, recipientsOf, spokenApprovalFor, spokenWhen, spokenZone } from "./spoken";

const summary = "Email Jo the March invoice";
const one = (tool: string, args: unknown): ApprovalAction[] => [{ tool, arguments: args }];
const classify = (actions: ApprovalAction[] | undefined, s = summary) => spokenApprovalFor({ actions, summary: s });
const reason = (actions: ApprovalAction[] | undefined, s = summary) => {
  const out = classify(actions, s);
  return out.voiceOk ? "ok" : out.tapOnly;
};
const readBack = (actions: ApprovalAction[]) => {
  const out = classify(actions);
  if (!out.voiceOk) throw new Error(`not voice-ok: ${out.tapOnly}`);
  return out.readBack;
};

describe("spokenApprovalFor: what may be approved by voice", () => {
  it("allows an email, a reply or a forward to a few people, a draft, and a calendar event", () => {
    expect(reason(one("GMAIL_SEND_EMAIL", { recipient_email: "jo@acme.example", subject: "March invoice", body: "Hi Jo." }))).toBe("ok");
    expect(reason(one("GMAIL_REPLY_TO_THREAD", { thread_id: "t1", recipient_email: "jo@acme.example", message_body: "Thanks!" }))).toBe("ok");
    expect(reason(one("GMAIL_FORWARD_MESSAGE", { message_id: "m1", recipient_email: "jo@acme.example" }))).toBe("ok");
    expect(reason(one("OUTLOOK_OUTLOOK_SEND_EMAIL", { to_email: "jo@acme.example", subject: "Hi", body: "Hi." }))).toBe("ok");
    expect(reason(one("GMAIL_CREATE_EMAIL_DRAFT", { recipient_email: "jo@acme.example", subject: "Draft", body: "Hi." }))).toBe("ok");
    expect(reason(one("GOOGLECALENDAR_CREATE_EVENT", { summary: "Coffee with Jo", start_datetime: "2026-10-21T15:00:00", attendees: ["jo@acme.example"] }))).toBe("ok");
    expect(reason(one("GOOGLECALENDAR_QUICK_ADD", { text: "Coffee with Jo tomorrow at 3pm" }))).toBe("ok");
  });

  it("keeps money a tap, whatever the app or the wording", () => {
    expect(reason(one("STRIPE_CREATE_REFUND", { charge: "ch_1" }))).toBe("money");
    expect(reason(one("QUICKBOOKS_CREATE_BILL_PAYMENT", { amount: 1240 }))).toBe("money");
    expect(reason(one("SHOPIFY_UPDATE_PRODUCT", { title: "Huggies" }))).toBe("money");
    expect(reason(one("PAYPAL_SEND_PAYOUT", { email: "jo@acme.example" }))).toBe("money");
    expect(reason(one("XERO_CREATE_INVOICE", {}))).toBe("money");
    expect(reason(one("ACME_TRANSFER_FUNDS", {}))).toBe("money");
    expect(reason(one("NOTION_CREATE_ORDER", {}))).toBe("money");
    // Anywhere in one approval: a payment beside an email is still a payment.
    expect(reason([...one("GMAIL_SEND_EMAIL", { recipient_email: "jo@acme.example" }), ...one("STRIPE_CREATE_CHARGE", {})])).toBe("money");
  });

  it("keeps deletions a tap, including deletions inside a batch of edits", () => {
    expect(reason(one("GMAIL_MOVE_TO_TRASH", { message_id: "m1" }))).toBe("deletion");
    expect(reason(one("GOOGLECALENDAR_DELETE_EVENT", { event_id: "e1" }))).toBe("deletion");
    expect(reason(one("GOOGLESHEETS_CLEAR_VALUES", { range: "A1:B2" }))).toBe("deletion");
    expect(reason(one("GOOGLEDRIVE_ARCHIVE_FILE", {}))).toBe("deletion");
    expect(reason(one("GOOGLESHEETS_BATCH_UPDATE", { requests: [{ deleteDimension: { range: {} } }] }))).toBe("deletion");
    expect(reason(one("GOOGLEDOCS_BATCH_UPDATE", { requests: [{ deleteContentRange: {} }] }))).toBe("deletion");
  });

  it("keeps sends to more than five people, and posts to many, a tap", () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((n) => `${n}@acme.example`);
    expect(reason(one("GMAIL_SEND_EMAIL", { recipient_email: six[0], extra_recipients: six.slice(1) }))).toBe("bulk_send");
    expect(reason(one("GMAIL_SEND_EMAIL", { recipient_email: six[0], cc: six.slice(1, 3), bcc: six.slice(3) }))).toBe("bulk_send");
    expect(reason(one("GMAIL_SEND_EMAIL", { recipient_email: six.join(", ") }))).toBe("bulk_send");
    expect(reason(one("GOOGLECALENDAR_CREATE_EVENT", { start_datetime: "2026-10-21T15:00:00", attendees: six.map((email) => ({ email })) }))).toBe("bulk_send");
    // Five separate emails to two people each are ten people.
    expect(reason(Array.from({ length: 3 }, (_, i) => ({ tool: "GMAIL_SEND_EMAIL", arguments: { recipient_email: six[i], cc: six[i + 3] } })))).toBe("bulk_send");
    expect(reason(one("MAILCHIMP_SEND_CAMPAIGN", {}))).toBe("bulk_send");
    expect(reason(one("LINKEDIN_CREATE_LINKED_IN_POST", { text: "Hi" }))).toBe("bulk_send");
    expect(reason(one("GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE", {}))).toBe("bulk_send");
    expect(reason(one("SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL", { channel: "C0123", text: "Hi all" }))).toBe("bulk_send");
    // A direct message isn't many people, but Studio doesn't read Slack back: a tap all the same.
    expect(reason(one("SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL", { channel: "D0123", text: "Hi" }))).toBe("unsupported");
    // A draft isn't sent, so it may name anyone.
    expect(reason(one("GMAIL_CREATE_EMAIL_DRAFT", { recipient_email: six.join(","), subject: "Hi", body: "Hi all." }))).toBe("ok");
  });

  it("fails closed on anything it can't read back plainly", () => {
    expect(reason(undefined)).toBe("unsupported");
    expect(reason([])).toBe("unsupported");
    // The browser can do anything: a step that pays is money, the rest stay taps, as do connecting apps and code.
    expect(reason(one("act", { action: "click Buy" }))).toBe("money");
    expect(reason(one("act", { action: "click the Place order button" }))).toBe("money");
    expect(reason(one("act", { action: "click the Sign in button" }))).toBe("unsupported");
    expect(reason(one("composio_manage_connections", { toolkits: ["gmail"] }))).toBe("unsupported");
    expect(reason(one("composio_remote_workbench", { code: "send()" }))).toBe("unsupported");
    expect(reason(one("", null))).toBe("unsupported");
    // Familiar apps, other actions.
    expect(reason(one("GMAIL_ADD_LABEL_TO_EMAIL", { message_id: "m1" }))).toBe("unsupported");
    expect(reason(one("GMAIL_SEND_DRAFT", { draft_id: "d1" }))).toBe("unsupported");
    expect(reason(one("GMAIL_SEND_EMAIL_TO_LABEL", { recipient_email: "jo@acme.example" }))).toBe("unsupported");
    expect(reason(one("GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND", { values: [["a"]] }))).toBe("unsupported");
    expect(reason(one("GOOGLECALENDAR_UPDATE_EVENT", { event_id: "e1", start_datetime: "2026-10-21T15:00:00" }))).toBe("unsupported");
    // Two things at once, even two harmless ones.
    expect(reason([...one("GMAIL_SEND_EMAIL", { recipient_email: "jo@acme.example" }), ...one("GMAIL_SEND_EMAIL", { recipient_email: "sam@acme.example" })])).toBe("unsupported");
    // A reply with nobody named could go to the whole thread; a name with no address could be a group.
    expect(reason(one("GMAIL_REPLY_TO_THREAD", { thread_id: "t1", message_body: "Thanks!" }))).toBe("unsupported");
    expect(reason(one("GMAIL_SEND_EMAIL", { recipient_email: "The sales team", body: "Hi" }))).toBe("unsupported");
    expect(reason(one("GOOGLECALENDAR_CREATE_EVENT", { start_datetime: "2026-10-21T15:00:00", attendees: [{ displayName: "Jo" }] }))).toBe("unsupported");
    // An event with no time it can say.
    expect(reason(one("GOOGLECALENDAR_CREATE_EVENT", { summary: "Coffee", start_datetime: "tomorrow-ish" }))).toBe("unsupported");
    // Arguments that aren't an object.
    expect(reason(one("GMAIL_SEND_EMAIL", "not json"))).toBe("unsupported");
    // No summary of its own from the agent.
    expect(reason(one("GMAIL_SEND_EMAIL", { recipient_email: "jo@acme.example" }), "Tool execution requires approval")).toBe("unsupported");
    expect(reason(one("GMAIL_SEND_EMAIL", { recipient_email: "jo@acme.example" }), "The agent wants to make a change")).toBe("unsupported");
    // A secret in what would be said.
    expect(reason(one("GMAIL_SEND_EMAIL", { recipient_email: "jo@acme.example", subject: "key sk-live-abcdefghijklmnopqrstuvwx" }))).toBe("unsupported");
  });

  it("keeps the tools it covers, for looking into a report", () => {
    expect(classify(one("GMAIL_SEND_EMAIL", { recipient_email: "jo@acme.example" })).tools).toEqual(["GMAIL_SEND_EMAIL"]);
    expect(classify(one("STRIPE_CREATE_REFUND", {})).tools).toEqual(["STRIPE_CREATE_REFUND"]);
  });
});

describe("the read-back", () => {
  it("says who it goes to, the subject, and how the body starts, from the arguments alone", () => {
    expect(
      readBack(
        one("GMAIL_SEND_EMAIL", {
          recipient_email: "Jo@Acme.example",
          cc: ["sam@acme.example"],
          subject: "March invoice",
          body: "Hi Jo, here's the March invoice. Let me know if anything's off.",
        }),
      ),
    ).toBe("I'll email jo@acme.example, cc sam@acme.example, subject “March invoice”, saying “Hi Jo, here's the March invoice”.");
    expect(readBack(one("GMAIL_REPLY_TO_THREAD", { thread_id: "t1", recipient_email: "billing@casting.example", message_body: "Hi, it looks like invoice #4471 was paid twice. Could you refund it?" }))).toBe(
      "I'll reply in the thread to billing@casting.example, saying “Hi, it looks like invoice 4471 was paid twice”.",
    );
    expect(readBack(one("GMAIL_FORWARD_MESSAGE", { message_id: "m1", recipient_email: "jo@acme.example", additional_text: "FYI." }))).toBe(
      "I'll forward the email to jo@acme.example, adding “FYI”.",
    );
    expect(readBack(one("GMAIL_CREATE_EMAIL_DRAFT", { recipient_email: "jo@acme.example", subject: "Hello", body: "Hi Jo." }))).toBe(
      "I'll save a draft to jo@acme.example, subject “Hello”, saying “Hi Jo”. It won't be sent.",
    );
    expect(readBack(one("GOOGLECALENDAR_CREATE_EVENT", { summary: "Coffee with Jo", start_datetime: "2026-10-21T15:30:00", attendees: [{ email: "jo@acme.example" }] }))).toBe(
      "I'll add “Coffee with Jo” to your calendar for October 21, 2026 at 3:30 PM, inviting jo@acme.example.",
    );
    expect(readBack(one("GOOGLECALENDAR_QUICK_ADD", { text: "Coffee with Jo tomorrow at 3pm" }))).toBe("I'll add this to your calendar: “Coffee with Jo tomorrow at 3pm”.");
  });

  it("names every recipient, including ones the card's six fields would leave off", () => {
    const line = readBack(
      one("GMAIL_SEND_EMAIL", { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, recipient_email: "jo@acme.example", bcc: "lee@acme.example", subject: "Hi" }),
    );
    expect(line).toContain("bcc lee@acme.example");
  });

  it("mentions attachments, and drops markup, links and quotes from what it quotes", () => {
    const line = readBack(
      one("GMAIL_SEND_EMAIL", {
        recipient_email: "jo@acme.example",
        subject: "[Action] \"Invoice\" `4471`",
        body: "<p>Hi&nbsp;Jo, see <a href='https://x.example'>https://x.example</a> for the **invoice**.</p>",
        attachment: { name: "invoice.pdf" },
      }),
    );
    expect(line).toBe("I'll email jo@acme.example, subject “Action Invoice 4471”, with an attachment, saying “Hi Jo, see for the invoice”.");
    expect(TECHNICAL.test(line)).toBe(false);
  });

  it("stays within its length, cutting the quote first", () => {
    const line = readBack(one("GMAIL_SEND_EMAIL", { recipient_email: "jo@acme.example", subject: "S".repeat(100), body: `${"word ".repeat(200)}end.` }));
    expect(line.length).toBeLessThanOrEqual(MAX_READ_BACK);
    expect(line).toMatch(/…”\.$/);
  });

  it("says times as written, and nothing in a zone it wouldn't say", () => {
    expect(spokenWhen("2026-10-21T09:00:00")).toBe("October 21, 2026 at 9 AM");
    expect(spokenWhen("2026-10-21T09:00:00.000")).toBe("October 21, 2026 at 9 AM");
    expect(spokenWhen("2026-10-21T09:00:00-07:00")).toBeNull();
    expect(spokenWhen("2026-10-21T09:00:00Z")).toBeNull();
    expect(spokenWhen("2026-10-21T09:00 tomorrow")).toBeNull();
    expect(spokenWhen("2026-12-01T00:05")).toBe("December 1, 2026 at 12:05 AM");
    expect(spokenWhen("2026-12-01")).toBe("December 1, 2026");
    expect(spokenWhen("2026-13-01T10:00")).toBeNull();
    expect(spokenWhen("next week")).toBeNull();
  });
});

describe("events: said whole, or a tap", () => {
  const event = (args: Record<string, unknown>, tool = "GOOGLECALENDAR_CREATE_EVENT") => one(tool, { summary: "Call", start_datetime: "2026-10-21T15:30:00", ...args });

  it("keeps a repeating event a tap, however the repeat is given", () => {
    expect(reason(event({ recurrence: ["RRULE:FREQ=DAILY"], attendees: ["a@x.example"] }))).toBe("unsupported");
    expect(reason(event({ rrule: "FREQ=WEEKLY" }))).toBe("unsupported");
    expect(reason(event({ recurrence: { pattern: { type: "daily" }, range: { type: "noEnd" } } }, "OUTLOOK_CALENDAR_CREATE_EVENT"))).toBe("unsupported");
    expect(reason(event({ start: { dateTime: "2026-10-21T15:30:00", recurrence: "daily" } }))).toBe("unsupported");
    expect(reason(event({ is_recurring: true }))).toBe("unsupported");
    // An empty one is no repeat.
    expect(reason(event({ recurrence: [] }))).toBe("ok");
  });

  it("keeps an event with anything the read-back wouldn't say a tap", () => {
    expect(reason(event({ create_meeting_room: true }))).toBe("unsupported");
    expect(reason(event({ visibility: "public" }))).toBe("unsupported");
    expect(reason(event({ calendar_id: "team@group.calendar.example" }))).toBe("unsupported");
    expect(reason(event({ calendar_id: "primary", send_updates: true, description: "Agenda", location: "Cafe" }))).toBe("ok");
    expect(reason(event({ start: { dateTime: "2026-10-21T15:30:00", colorId: "4" } }))).toBe("unsupported");
    expect(reason(one("GOOGLECALENDAR_QUICK_ADD", { text: "Coffee tomorrow", calendar_id: "work@x.example" }))).toBe("unsupported");
    // Unknown and empty is nothing.
    expect(reason(event({ guests_can_modify: false, extra: "" }))).toBe("ok");
  });

  it("says when it ends, or how long it runs, and fails closed on either it can't say", () => {
    expect(readBack(event({ end_datetime: "2026-10-21T16:30:00" }))).toBe("I'll add “Call” to your calendar for October 21, 2026 at 3:30 PM, until 4:30 PM.");
    expect(readBack(event({ end_datetime: "2026-10-22T09:00:00" }))).toBe("I'll add “Call” to your calendar for October 21, 2026 at 3:30 PM, until October 22, 2026 at 9 AM.");
    expect(readBack(event({ event_duration_hour: 1, event_duration_minutes: 30 }))).toBe("I'll add “Call” to your calendar for October 21, 2026 at 3:30 PM, for 1 hour and 30 minutes.");
    expect(readBack(event({ event_duration_minutes: "45" }))).toBe("I'll add “Call” to your calendar for October 21, 2026 at 3:30 PM, for 45 minutes.");
    expect(readBack(event({ end: { dateTime: "2026-10-21T16:00:00" } }))).toContain("until 4 PM");
    expect(reason(event({ end_datetime: "later" }))).toBe("unsupported");
    expect(reason(event({ end_datetime: "2026-10-21T16:30:00Z" }))).toBe("unsupported");
    expect(reason(event({ event_duration_minutes: -5 }))).toBe("unsupported");
    expect(reason(event({ end_datetime: "2026-10-21T16:30:00", event_duration_hour: 1 }))).toBe("unsupported");
  });

  it("says its time zone, and keeps one it can't say, or a clock in another, a tap", () => {
    expect(readBack(event({ timezone: "America/New_York", attendees: ["a@x.example"] }))).toBe(
      "I'll add “Call” to your calendar for October 21, 2026 at 3:30 PM New York time, inviting a@x.example.",
    );
    expect(readBack(event({ start_datetime: undefined, start: { dateTime: "2026-10-21T15:30:00", timeZone: "Europe/London" } }))).toContain("3:30 PM London time");
    expect(readBack(event({ time_zone: "UTC" }, "OUTLOOK_CALENDAR_CREATE_EVENT"))).toContain("3:30 PM UTC");
    // A trailing Z or offset, said or not: a tap.
    expect(reason(event({ start_datetime: "2026-10-21T15:30:00Z" }))).toBe("unsupported");
    expect(reason(event({ start_datetime: "2026-10-21T15:30:00-07:00", timezone: "America/Los_Angeles" }))).toBe("unsupported");
    expect(reason(event({ start_datetime: undefined, start: { dateTime: "2026-10-21T15:30:00Z", timeZone: "UTC" } }))).toBe("unsupported");
    // Two zones, or one that isn't a place.
    expect(reason(event({ timezone: "America/New_York", start_datetime: undefined, start: { dateTime: "2026-10-21T15:30:00", timeZone: "Europe/London" } }))).toBe("unsupported");
    expect(reason(event({ timezone: "+05:30" }))).toBe("unsupported");
    expect(reason(event({ timezone: { id: "America/New_York" } }))).toBe("unsupported");
    expect(spokenZone("America/Argentina/Buenos_Aires")).toBe("Buenos Aires time");
    expect(spokenZone("EST5EDT")).toBeNull();
  });

  it("counts and names invitees under every key a calendar uses for them", () => {
    const people = (n: number) => Array.from({ length: n }, (_, i) => `p${i}@x.example`);
    const outlook = (args: Record<string, unknown>) => one("OUTLOOK_OUTLOOK_CALENDAR_CREATE_EVENT", { subject: "All hands", start_datetime: "2026-10-21T15:00:00", ...args });
    expect(reason(outlook({ attendees_info: people(30).map((email) => ({ email })) }))).toBe("bulk_send");
    expect(reason(outlook({ attendees_info: people(7) }))).toBe("bulk_send");
    expect(readBack(outlook({ attendees_info: [{ email: "jo@acme.example", name: "Jo" }] }))).toBe("I'll add “All hands” to your calendar for October 21, 2026 at 3 PM, inviting jo@acme.example.");
    expect(reason(event({ attendee_emails: people(40) }))).toBe("bulk_send");
    expect(readBack(event({ attendee_emails: ["jo@acme.example"] }))).toContain("inviting jo@acme.example");
  });
});

describe("addresses under keys it doesn't know", () => {
  const people = (n: number) => Array.from({ length: n }, (_, i) => `p${i}@x.example`);

  it("count toward a bulk send, and keep the request a tap", () => {
    expect(reason(one("GMAIL_SEND_EMAIL", { recipient_email: "jo@acme.example", extra_people: people(6) }))).toBe("bulk_send");
    expect(reason(one("GOOGLECALENDAR_CREATE_EVENT", { summary: "Call", start_datetime: "2026-10-21T15:30:00", whoever: people(6) }))).toBe("bulk_send");
    expect(reason(one("GMAIL_SEND_EMAIL", { recipient_email: "jo@acme.example", extra_people: ["sam@acme.example"] }))).toBe("unsupported");
    expect(reason(one("GMAIL_SEND_EMAIL", { recipient_email: "jo@acme.example", reply_to: "sam@acme.example" }))).toBe("unsupported");
    expect(reason(one("OUTLOOK_CALENDAR_CREATE_EVENT", { subject: "Sync", start_datetime: "2026-10-21T15:30:00", nested: { deep: { list: ["sam@acme.example"] } } }))).toBe("unsupported");
    expect(reason(one("GMAIL_CREATE_EMAIL_DRAFT", { recipient_email: "jo@acme.example", others: "sam@acme.example", body: "Hi." }))).toBe("unsupported");
  });

  it("aren't counted in the sender's fields or in what it quotes", () => {
    expect(reason(one("GMAIL_SEND_EMAIL", { recipient_email: "jo@acme.example", user_id: "me", from_email: "me@mine.example", body: "Reach Sam at sam@acme.example." }))).toBe("ok");
    expect(reason(one("GMAIL_SEND_EMAIL", { recipient_email: "jo@acme.example", subject: "From sam@acme.example" }))).toBe("ok");
  });

  it("fail closed when the arguments nest too deep to read", () => {
    let deep: unknown = "sam@acme.example";
    for (let i = 0; i < 14; i++) deep = { inner: deep };
    expect(reason(one("GMAIL_SEND_EMAIL", { recipient_email: "jo@acme.example", deep }))).toBe("unsupported");
  });
});

describe("the tools kept with a request", () => {
  it("always fit the column, however many or long the names", () => {
    const long = Array.from({ length: 12 }, (_, i) => `${"X".repeat(98)}${i}_A`);
    const kept = classify(long.map((tool) => ({ tool, arguments: {} }))).tools;
    expect(kept.length).toBeLessThanOrEqual(10);
    expect(kept.join(",").length).toBeLessThanOrEqual(MAX_TOOLS_CHARS);
    expect(fitTools(long).join(",").length).toBeLessThanOrEqual(MAX_TOOLS_CHARS);
    expect(fitTools(["A_B", "", "C_D"])).toEqual(["A_B", "C_D"]);
  });
});

describe("recipientsOf", () => {
  it("finds addresses in strings, lists, and objects, however they're keyed and nested", () => {
    expect(
      recipientsOf({
        message: { toRecipients: [{ emailAddress: { address: "jo@acme.example", name: "Jo" } }], ccRecipients: [{ emailAddress: { address: "sam@acme.example" } }] },
        bcc_emails: "Lee <lee@acme.example>; kim@acme.example",
        body: "write to spam@acme.example",
      }),
    ).toEqual({ to: ["jo@acme.example"], cc: ["sam@acme.example"], bcc: ["lee@acme.example", "kim@acme.example"], all: ["jo@acme.example", "sam@acme.example", "lee@acme.example", "kim@acme.example"], unknown: false, stray: [] });
  });

  it("counts someone once wherever they're named, and flags a name with no address", () => {
    expect(recipientsOf({ to: "jo@acme.example", cc: "JO@acme.example" }).all).toEqual(["jo@acme.example"]);
    expect(recipientsOf({ to: "Jo" }).unknown).toBe(true);
    expect(recipientsOf({ attendees: [{ displayName: "Jo" }] }).unknown).toBe(true);
    expect(recipientsOf({ to: "", cc: [] })).toMatchObject({ all: [], unknown: false });
  });
});
