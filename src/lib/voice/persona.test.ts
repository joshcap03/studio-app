import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Companion } from "@/lib/types";

// Who the agent is to one member, decided on the server: their kept name where companions are
// on, their voice where voice is on, their manner wherever it was chosen, else the template's.

const flags = vi.hoisted(() => ({ voice: true, companion: false }));
vi.mock("./status", () => ({ voiceStatus: () => (flags.voice ? { provider: "mock" } : null) }));
vi.mock("@/lib/flags", () => ({ previewEnabled: (_: unknown, feature: string) => feature === "companion" && flags.companion }));
const getCompanion = vi.hoisted(() => vi.fn());
vi.mock("@/lib/companion", () => ({ getCompanion }));

const { resolvePersona } = await import("./persona");

const companion = (row: Partial<Companion>): Companion => ({
  workspaceId: "w",
  stage: "drawn",
  name: null,
  manner: null,
  voice: null,
  look: { shape: "classic", tint: "chart-1", seed: 1 },
  ...row,
});

/** A tenant whose agent started from `templateId`, as workspace_settings holds it. */
function tenant(templateId: string | null) {
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { template_id: templateId }, error: null }) };
  const from = vi.fn(() => query);
  return { tenant: { email: "m@example.test", workspace: { id: "w" }, db: { from } } as never, from };
}

beforeEach(() => {
  Object.assign(flags, { voice: true, companion: false });
  getCompanion.mockReset();
});

describe("resolvePersona", () => {
  it("starts with its template's name and voice", async () => {
    getCompanion.mockResolvedValue(companion({}));
    expect(await resolvePersona(tenant("job-search").tenant)).toEqual({ name: "Rowan", nameKept: false, voice: "steady", manner: null });
    expect(await resolvePersona(tenant(null).tenant)).toMatchObject({ name: "Sam", voice: "easygoing" });
  });

  it("speaks with the voice and manner the member chose, before it has a name", async () => {
    getCompanion.mockResolvedValue(companion({ voice: "warm", manner: "I keep it short." }));
    expect(await resolvePersona(tenant("small-business").tenant)).toEqual({ name: "June", nameKept: false, voice: "warm", manner: "I keep it short." });
  });

  it("goes by a kept name only where companions are on, and by a chosen voice only where voice is", async () => {
    getCompanion.mockResolvedValue(companion({ stage: "arrived", name: "Juniper", voice: "bright", manner: "Brief." }));
    expect(await resolvePersona(tenant("job-search").tenant)).toMatchObject({ name: "Rowan", nameKept: false, voice: "bright" });
    flags.companion = true;
    expect(await resolvePersona(tenant("job-search").tenant)).toEqual({ name: "Juniper", nameKept: true, voice: "bright", manner: "Brief." });
    flags.voice = false;
    expect(await resolvePersona(tenant("job-search").tenant)).toMatchObject({ name: "Juniper", voice: "steady" });
  });

  it("reads nothing it was handed, and nothing of the member's when neither preview is on", async () => {
    const { tenant: t, from } = tenant("job-search");
    expect(await resolvePersona(t, { templateId: "content-social", companion: companion({ voice: "gentle" }) })).toMatchObject({ name: "Iris", voice: "gentle" });
    expect(from).not.toHaveBeenCalled();
    expect(getCompanion).not.toHaveBeenCalled();
    flags.voice = false;
    expect(await resolvePersona(t)).toEqual({ name: "Rowan", nameKept: false, voice: "steady", manner: null });
    expect(getCompanion).not.toHaveBeenCalled();
  });

  it("falls back to the template's when the member's choice can't be read", async () => {
    getCompanion.mockRejectedValue(new Error("down"));
    expect(await resolvePersona(tenant("inbox-calendar").tenant)).toEqual({ name: "Ada", nameKept: false, voice: "gentle", manner: null });
  });
});
