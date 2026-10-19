import { describe, expect, it } from "vitest";
import { addLinkBody, describeLink, patchItemBody } from "./library";

describe("describeLink", () => {
  it("knows Google's docs from their paths", () => {
    expect(describeLink("https://docs.google.com/spreadsheets/d/abc/edit#gid=0")).toEqual({ kind: "spreadsheet", source: "Google Sheets", title: "Google Sheet" });
    expect(describeLink("https://docs.google.com/document/d/abc/edit")).toMatchObject({ kind: "document", source: "Google Docs" });
    expect(describeLink("https://docs.google.com/presentation/d/abc")).toMatchObject({ kind: "presentation", source: "Google Slides" });
    expect(describeLink("https://drive.google.com/file/d/abc/view")).toMatchObject({ kind: "file", source: "Google Drive" });
  });

  it("names PDFs by their file, and anything else by its site", () => {
    expect(describeLink("https://example.com/files/My%20Resume.pdf")).toEqual({ kind: "pdf", source: "example.com", title: "My Resume.pdf" });
    expect(describeLink("https://example.com/files/bad%E0%A4.pdf").title).toBe("bad%E0%A4.pdf");
    expect(describeLink("https://www.notion.so/page-1")).toMatchObject({ kind: "document", source: "Notion" });
    expect(describeLink("https://www.linkedin.com/jobs/view/1")).toEqual({ kind: "link", source: "linkedin.com", title: "linkedin.com" });
  });
});

describe("request bodies", () => {
  it("take https links only", () => {
    expect(addLinkBody.safeParse({ url: "https://docs.google.com/document/d/1" }).success).toBe(true);
    expect(addLinkBody.safeParse({ url: "http://example.com" }).success).toBe(false);
    expect(addLinkBody.safeParse({ url: "javascript:alert(1)" }).success).toBe(false);
    expect(addLinkBody.safeParse({ url: "https://example.com", workspaceId: "x" }).success).toBe(false);
  });

  it("change a name or a pin, nothing else", () => {
    expect(patchItemBody.safeParse({ pinned: true }).success).toBe(true);
    expect(patchItemBody.safeParse({ title: "  " }).success).toBe(false);
    expect(patchItemBody.safeParse({}).success).toBe(false);
    expect(patchItemBody.safeParse({ url: "https://evil.example" }).success).toBe(false);
  });
});
