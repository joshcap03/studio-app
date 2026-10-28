import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpCall } from "@/lib/browser-view";
import { fetchDownload, fetchOnPage, fileName, fileType, parseBrowserFile } from "./browser-files";

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
    expect(parseBrowserFile({ name: "Export", downloaded: " orders.xlsx ", link: "/x" })).toEqual({ name: "Export", downloaded: "orders.xlsx" });
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

  it("are the type their bytes show, with the site's word or the name telling which kind of Office file", () => {
    const bytes = (...b: number[]) => new Uint8Array([...b, 0, 0, 0, 0, 0, 0, 0, 0]);
    const zip = bytes(0x50, 0x4b, 0x03, 0x04);
    const ole = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
    const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    expect(fileType(new Uint8Array(PDF), "application/octet-stream", "Label")).toBe("application/pdf");
    expect(fileType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "", "x")).toBe("image/png");
    expect(fileType(zip, XLSX, "Export")).toBe(XLSX);
    expect(fileType(zip, "application/octet-stream", "Statement.xlsx")).toBe(XLSX);
    expect(fileType(zip, "application/x-zip-compressed", "Photos")).toBe("application/zip");
    expect(fileType(ole, "application/vnd.ms-excel", "Report")).toBe("application/vnd.ms-excel");
    expect(fileType(ole, "application/octet-stream", "Letter.doc")).toBe("");
    expect(fileType(new Uint8Array(Buffer.from("a,b\n1,2")), "text/csv; charset=utf-8", "x")).toBe("text/csv");
    // What the site claims doesn't make it so.
    expect(fileType(new Uint8Array(Buffer.from("  <!DOCTYPE html><title>Sign in</title>")), "application/pdf", "Label.pdf")).toBe("text/html");
    expect(fileType(new Uint8Array(Buffer.from("MZ\x90\x00")), "application/pdf", "Label.pdf")).toBe("");
    expect(fileName("Export", XLSX)).toEqual({ name: "Export.xlsx", mimeType: XLSX });
    expect(fileName("Photos.zip", "application/zip")).toEqual({ name: "Photos.zip", mimeType: "application/zip" });
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

  describe("downloaded by a click", () => {
    afterEach(() => vi.unstubAllGlobals());
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 60 * 60_000).toISOString();

    function store(lists: { id: string; filename: string; createdAt: string; mimeType?: string; size?: number }[][]) {
      const asked: string[] = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        asked.push(url);
        expect((init.headers as Record<string, string>)["X-BB-API-Key"]).toBe("bb-key");
        if (url.includes("/downloads?")) return new Response(JSON.stringify({ downloads: lists.length > 1 ? lists.shift() : lists[0] }));
        return new Response(PDF, { headers: { "Content-Type": "application/pdf" } });
      });
      return asked;
    }
    const noWait = async () => undefined;

    it("wait for the named file to reach Browserbase's store, then fetch it", async () => {
      const asked = store([[{ id: "older", filename: "other.pdf", createdAt: now }], [{ id: "d2", filename: "label.pdf", createdAt: now, mimeType: "application/pdf", size: 14 }]]);
      expect(await fetchDownload("bb-key", "sess", "label.pdf", noWait)).toEqual({ ok: true, bytes: new Uint8Array(PDF), mimeType: "application/pdf" });
      expect(asked.at(-1)).toBe("https://api.browserbase.com/v1/downloads/d2");
      expect(asked[0]).toContain("sessionId=sess");
    });

    it("fall back to a download from the last few minutes, never an old one", async () => {
      store([[{ id: "recent", filename: "Label_123.pdf", createdAt: now }]]);
      expect((await fetchDownload("bb-key", "sess", "label.pdf", noWait)).ok).toBe(true);
      store([[{ id: "stale", filename: "Label_123.pdf", createdAt: old }]]);
      expect(await fetchDownload("bb-key", "sess", "label.pdf", noWait)).toEqual({ ok: false, reason: "no-download" });
      store([[{ id: "big", filename: "label.pdf", createdAt: now, size: 11 * 1024 * 1024 }]]);
      expect(await fetchDownload("bb-key", "sess", "label.pdf", noWait)).toEqual({ ok: false, reason: "too-big" });
    });
  });
});
