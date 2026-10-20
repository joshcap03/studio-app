import { describe, expect, it } from "vitest";
import { shareProblem, snapshotName, snapshotSize } from "./share";

describe("snapshots of what they share", () => {
  it("scale down to 1600 px on the long edge, never up", () => {
    expect(snapshotSize(3200, 1800)).toEqual({ width: 1600, height: 900 });
    expect(snapshotSize(1080, 1920)).toEqual({ width: 900, height: 1600 });
    expect(snapshotSize(800, 600)).toEqual({ width: 800, height: 600 });
  });
  it("are named the way the member reads them in the thread", () => {
    expect(snapshotName("screen", new Date(2026, 9, 20, 14, 2))).toBe("Screen snapshot 14.02.jpg");
    expect(snapshotName("camera", new Date(2026, 9, 20, 9, 30))).toBe("Camera snapshot 09.30.jpg");
  });
  it("explain a share that didn't start in plain words", () => {
    expect(shareProblem("screen", new DOMException("x", "NotAllowedError"))).toBe("Sharing didn't start.");
    expect(shareProblem("camera", new DOMException("x", "NotAllowedError"))).toContain("Allow it for this site");
    expect(shareProblem("camera", new DOMException("x", "NotFoundError"))).toBe("No camera found.");
    expect(shareProblem("screen", new Error("boom"))).toBe("Couldn't share your screen.");
  });
});
