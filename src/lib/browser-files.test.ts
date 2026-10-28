import { describe, expect, it } from "vitest";
import type { CdpCall } from "@/lib/browser-view";
import { fetchOnPage, fileName, parseBrowserFile, sniffType } from "./browser-files";

// Getting a file from the agent's browser: what save_file may ask for, the name and type it's kept
// as, and the CDP exchange on a fake browser (only reads: no clicks, no typing).

const PDF = Buffer.from("%PDF-1.4 label");

function browser(page: { url: string; resource?: Record<string, unknown>; chunks?: Buffer[]; blob?: unknown }) {
  const sent: string[] = [];
  const chunks = [...(page.chunks ?? [PDF])];
  const call: CdpCall = async (method, params = {}) => {
    sent.push(method);
    switch (method) {
      case "Target.getTargets":
        return { targetInfos: [{ targetId: "t1", type: "page", url: page.url }] };
      case "Target.attachToTarget":
        return { sessionId: "s1" };
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "f1", url: page.url } } };
      case "Page.printToPDF":
        return { data: PDF.toString("base64") };
      case "Network.loadNetworkResource":
        sent.push(String(params.url));
        return { resource: page.resource ?? { success: true, httpStatusCode: 200, stream: "h1", headers: { "Content-Type": "application/pdf" } } };
      case "IO.read": {
        const chunk = chunks.shift() ?? Buffer.alloc(0);
        return { data: chunk.toString("base64"), base64Encoded: true, eof: chunks.length === 0 };
      }
      case "IO.close":
      case "Network.enable":
        return {};
      case "Runtime.evaluate":
        return { result: { value: page.blob } };
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  return { call, sent };
}

describe("files from the agent's browser", () => {
  it("take a name and an optional link from save_file, nothing else", () => {
    expect(parseBrowserFile({ name: "  Label  Jane.pdf ", link: " /label/1.pdf " })).toEqual({ name: "Label Jane.pdf", link: "/label/1.pdf" });
    expect(parseBrowserFile({ name: "Page" })).toEqual({ name: "Page" });
    expect(parseBrowserFile({ name: "x", link: "two words" })).toEqual({ name: "x" });
    expect(parseBrowserFile({ link: "/a.pdf" })).toBeNull();
    expect(parseBrowserFile("Label.pdf")).toBeNull();
  });

  it("are kept only as types Studio keeps, named for the member with the right extension", () => {
    expect(fileName("Label - Jane.pdf", "application/pdf")).toEqual({ name: "Label - Jane.pdf", mimeType: "application/pdf" });
    expect(fileName("Label for Jane", "application/pdf; charset=binary")).toEqual({ name: "Label for Jane.pdf", mimeType: "application/pdf" });
    expect(fileName("../../etc/Receipt", "image/png")).toEqual({ name: "Receipt.png", mimeType: "image/png" });
    expect(fileName("Setup.exe", "application/pdf")).toEqual({ name: "Setup.pdf", mimeType: "application/pdf" });
    // What the file is decides, not what the agent called it: a sign-in page isn't a label.
    expect(fileName("Label.pdf", "text/html; charset=utf-8")).toBeNull();
    expect(fileName("Label.pdf", "application/octet-stream")).toBeNull();
    expect(fileName("Setup", "application/x-msdownload")).toBeNull();
  });

  it("know a PDF or picture by its first bytes when the site doesn't say", () => {
    expect(sniffType(new Uint8Array(PDF))).toBe("application/pdf");
    expect(sniffType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffType(new Uint8Array(Buffer.from("MZ\x90")))).toBe("");
  });

  it("fetch a link the way the page would, resolved against it, read in chunks", async () => {
    const { call, sent } = browser({ url: "https://cns.usps.com/labelInformation.shtml", chunks: [PDF.subarray(0, 4), PDF.subarray(4)] });
    const got = await fetchOnPage(call, "/go/printLabel.pdf?id=9");
    expect(got).toEqual({ ok: true, bytes: new Uint8Array(PDF), mimeType: "application/pdf" });
    expect(sent).toContain("https://cns.usps.com/go/printLabel.pdf?id=9");
    expect(sent).toContain("IO.close");
    expect(sent.some((m) => /^(Input|DOM\.set|Page\.navigate)/.test(m))).toBe(false);
  });

  it("save the open page as a PDF when there's no link", async () => {
    const { call, sent } = browser({ url: "https://shop.example/receipt" });
    expect(await fetchOnPage(call, undefined)).toEqual({ ok: true, bytes: new Uint8Array(PDF), mimeType: "application/pdf" });
    expect(sent).toContain("Page.printToPDF");
  });

  it("refuse links that aren't https or the page's own blobs, and say when one failed or is too big", async () => {
    expect(await fetchOnPage(browser({ url: "https://shop.example/" }).call, "http://shop.example/a.pdf")).toEqual({ ok: false, reason: "refused" });
    expect(await fetchOnPage(browser({ url: "https://shop.example/" }).call, "file:///etc/passwd")).toEqual({ ok: false, reason: "refused" });
    expect(await fetchOnPage(browser({ url: "https://shop.example/" }).call, "blob:https://evil.example/1")).toEqual({ ok: false, reason: "refused" });
    const own = browser({ url: "https://shop.example/", blob: { type: "application/pdf", data: PDF.toString("base64") } });
    expect(await fetchOnPage(own.call, "blob:https://shop.example/1")).toEqual({ ok: true, bytes: new Uint8Array(PDF), mimeType: "application/pdf" });
    const missing = browser({ url: "https://shop.example/", resource: { success: false, httpStatusCode: 404 } });
    expect(await fetchOnPage(missing.call, "/gone.pdf")).toEqual({ ok: false, reason: "failed" });
    const big = browser({ url: "https://shop.example/", chunks: [Buffer.alloc(6 * 1024 * 1024), Buffer.alloc(6 * 1024 * 1024)] });
    expect(await fetchOnPage(big.call, "/huge.pdf")).toEqual({ ok: false, reason: "too-big" });
    expect(big.sent).toContain("IO.close");
  });
});
