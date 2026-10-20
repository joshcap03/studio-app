import { describe, expect, it } from "vitest";
import { isCrossSite, isSameOrigin } from "./same-origin";

const request = (headers: Record<string, string>) => ({ headers: new Headers({ host: "studio.test", ...headers }) });

describe("same origin", () => {
  it("lets writes through only from the app's own pages", () => {
    expect(isSameOrigin(request({ "sec-fetch-site": "same-origin", origin: "https://studio.test" }))).toBe(true);
    expect(isSameOrigin(request({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOrigin(request({ origin: "https://studio.test" }))).toBe(true);
    expect(isSameOrigin(request({ "sec-fetch-site": "cross-site", origin: "https://studio.test" }))).toBe(false);
    expect(isSameOrigin(request({ origin: "https://elsewhere.test" }))).toBe(false);
    // Nothing to go on: not a write the app's pages would send.
    expect(isSameOrigin(request({}))).toBe(false);
  });

  it("refuses a GET that changes something only when the browser marks it as from elsewhere", () => {
    expect(isCrossSite(request({ "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(isCrossSite(request({ "sec-fetch-site": "same-site" }))).toBe(true);
    expect(isCrossSite(request({ origin: "https://elsewhere.test" }))).toBe(true);
    expect(isCrossSite(request({ origin: "null" }))).toBe(true);
    expect(isCrossSite(request({ "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(isCrossSite(request({ "sec-fetch-site": "none" }))).toBe(false);
    expect(isCrossSite(request({ origin: "https://studio.test" }))).toBe(false);
    // An older browser's own fetch says neither.
    expect(isCrossSite(request({}))).toBe(false);
  });
});
