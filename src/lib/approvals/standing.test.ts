import { describe, expect, it } from "vitest";
import { standingKindFor } from "./standing";

const act = (tool: string, args: unknown) => ({ tool, arguments: args });

describe("standingKindFor", () => {
  it("covers putting labels on the member's own mail and making labels", () => {
    expect(standingKindFor([act("GMAIL_BATCH_MODIFY_MESSAGES", { messageIds: ["a", "b"], addLabelIds: ["Label_7"], removeLabelIds: ["UNREAD"] })])).toBe("gmail_labels");
    expect(standingKindFor([act("GMAIL_ADD_LABEL_TO_EMAIL", { user_id: "me", message_id: "a1", add_label_ids: ["CATEGORY_PROMOTIONS"] })])).toBe("gmail_labels");
    expect(standingKindFor([act("GMAIL_MODIFY_THREAD_LABELS", { thread_id: "t1", add_label_ids: ["STARRED"] })])).toBe("gmail_labels");
    expect(
      standingKindFor([act("GMAIL_CREATE_LABEL", { label_name: "Priority" }), act("GMAIL_BATCH_MODIFY_MESSAGES", { messageIds: ["a"], addLabelIds: ["Label_1"] })]),
    ).toBe("gmail_labels");
  });

  it("never covers trashing, spam, archiving, or passing mail off as sent or a draft", () => {
    for (const label of ["TRASH", "SPAM", "INBOX", "SENT", "DRAFT", "trash"]) {
      expect(standingKindFor([act("GMAIL_BATCH_MODIFY_MESSAGES", { messageIds: ["a"], addLabelIds: [label] })])).toBeNull();
      expect(standingKindFor([act("GMAIL_ADD_LABEL_TO_EMAIL", { message_id: "a", remove_label_ids: [label] })])).toBeNull();
    }
    expect(standingKindFor([act("GMAIL_CREATE_LABEL", { label_name: "Trash" })])).toBeNull();
  });

  it("fails closed on anything else: other actions, code, unknown arguments, another mailbox, or nothing", () => {
    const labelled = act("GMAIL_BATCH_MODIFY_MESSAGES", { messageIds: ["a"], addLabelIds: ["Label_1"] });
    expect(standingKindFor([labelled, act("GMAIL_SEND_EMAIL", { recipient_email: "jo@acme.example" })])).toBeNull();
    for (const tool of ["GMAIL_DELETE_LABEL", "GMAIL_REMOVE_LABEL", "GMAIL_PATCH_LABEL", "GMAIL_MOVE_TO_TRASH", "composio_remote_workbench", "act", ""]) {
      expect(standingKindFor([act(tool, { label_id: "Label_1", code: "x" })])).toBeNull();
    }
    expect(standingKindFor([act("GMAIL_BATCH_MODIFY_MESSAGES", { messageIds: ["a"], addLabelIds: ["Label_1"], extra: 1 })])).toBeNull();
    expect(standingKindFor([act("GMAIL_ADD_LABEL_TO_EMAIL", { user_id: "boss@acme.example", message_id: "a", add_label_ids: ["Label_1"] })])).toBeNull();
    expect(standingKindFor([act("GMAIL_BATCH_MODIFY_MESSAGES", { messageIds: [], addLabelIds: ["Label_1"] })])).toBeNull();
    expect(standingKindFor([act("GMAIL_BATCH_MODIFY_MESSAGES", "not json")])).toBeNull();
    expect(standingKindFor([])).toBeNull();
    expect(standingKindFor(undefined)).toBeNull();
  });
});
