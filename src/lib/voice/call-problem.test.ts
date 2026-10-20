import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callProblem } from "@/components/voice/call";

describe("voice calls and the microphone", () => {
  it("let Studio's own pages use the microphone, the camera and screen sharing (for calls), and nothing else new", () => {
    const config = readFileSync(join(__dirname, "..", "..", "..", "next.config.ts"), "utf8");
    const policy = /Permissions-Policy", value: "([^"]+)"/.exec(config)?.[1] ?? "";
    expect(policy).toContain("microphone=(self)");
    expect(policy).toContain("camera=(self)");
    expect(policy).toContain("display-capture=(self)");
    expect(policy).toContain("payment=()");
    expect(policy).toContain("geolocation=()");
  });

  it("explain a refused or missing microphone in plain words", () => {
    expect(callProblem("Permission denied")).toContain("Allow it for this site");
    expect(callProblem("NotAllowedError: Permission dismissed")).toContain("microphone");
    expect(callProblem("Requested device not found")).toContain("No microphone found");
    expect(callProblem("The connection closed")).toBe("The connection closed.");
    expect(callProblem(undefined)).toBe("The call dropped.");
  });
});
