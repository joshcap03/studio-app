import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, parseBody } from "@/lib/api";
import { MAX_MANNER, getCompanion, nameCompanion, setCompanionSound, withToMeet } from "@/lib/companion";
import { previewEnabled } from "@/lib/flags";
import { firstName } from "@/lib/setup-words";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { voiceStatus } from "@/lib/voice/status";
import { VOICE_KEYS } from "@/lib/voice/voices";
import { getSettings } from "@/lib/workspace";

const body = z
  .strictObject({
    name: z.string().max(80).optional(),
    manner: z.string().max(MAX_MANNER).optional(),
    // null goes back to the agent's starting voice.
    voice: z.enum(VOICE_KEYS, { error: "Pick one of the voices." }).nullable().optional(),
  })
  .refine((b) => b.name !== undefined || b.manner !== undefined || b.voice !== undefined, "Nothing to change.");

/** Who the agent the member is in is to them (null where it isn't shown), as it moves along. */
export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  if (!previewEnabled(auth.value, "companion")) return NextResponse.json({ companion: null });
  try {
    const [companion, settings] = await Promise.all([getCompanion(auth.value), getSettings(auth.value)]);
    return NextResponse.json({ companion: await withToMeet(auth.value, companion, settings.setup) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * The member renames the agent, rewrites how it talks with them, or picks its voice. How it
 * sounds is theirs to change at any stage (the voice with the voice preview); the name only once
 * it has introduced itself, since it gets its name by introducing itself.
 */
export async function PATCH(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const named = previewEnabled(auth.value, "companion");
  const voice = Boolean(voiceStatus(auth.value));
  if (!named && !voice) return jsonError(404, "Not found.");
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;
  if (input.voice !== undefined && !voice) return jsonError(404, "Not found.");
  try {
    const current = await getCompanion(auth.value);
    if (input.name !== undefined && input.name.trim() !== (current.name ?? "")) {
      if (!named) return jsonError(404, "Not found.");
      if (current.stage !== "arrived") return jsonError(409, "It gets its name when it introduces itself.");
      const kept = await nameCompanion(auth.value, { name: input.name, member: firstName(auth.value.account.name) });
      if (!kept.ok) return jsonError(400, kept.error);
    }
    if (input.manner !== undefined || input.voice !== undefined) {
      await setCompanionSound(auth.value, { ...(input.voice !== undefined ? { voice: input.voice } : {}), ...(input.manner !== undefined ? { manner: input.manner } : {}) });
    }
    return NextResponse.json({ companion: await getCompanion(auth.value) });
  } catch (error) {
    return errorResponse(error);
  }
}
