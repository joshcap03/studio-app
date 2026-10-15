import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ previewEmails: new Set(["preview@example.test"]) }),
}));

const { previewEnabled } = await import("./flags");

describe("previewEnabled", () => {
  it("is on only for allowlisted session emails, ignoring case and spacing", () => {
    expect(previewEnabled({ email: "preview@example.test" }, "brain")).toBe(true);
    expect(previewEnabled({ email: " Preview@Example.TEST " }, "why")).toBe(true);
    expect(previewEnabled({ email: "someone@example.test" }, "brain")).toBe(false);
    expect(previewEnabled({ email: null }, "brain")).toBe(false);
    expect(previewEnabled({ email: "" }, "brain")).toBe(false);
  });
});
