import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, parseBody } from "@/lib/api";
import { MAX_MANNER, getCompanion, nameCompanion, setCompanionManner } from "@/lib/companion";
import { previewEnabled } from "@/lib/flags";
import { firstName } from "@/lib/setup-words";
import { authorizeTenant, jsonError } from "@/lib/tenant";

const body = z
  .strictObject({ name: z.string().max(80).optional(), manner: z.string().max(MAX_MANNER).optional() })
  .refine((b) => b.name !== undefined || b.manner !== undefined, "Nothing to change.");

/** Who the agent the member is in is to them (null where it isn't shown), as it moves along. */
export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  if (!previewEnabled(auth.value, "companion")) return NextResponse.json({ companion: null });
  try {
    return NextResponse.json({ companion: await getCompanion(auth.value) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * The member renames the agent or rewrites how it talks with them, once it has introduced
 * itself; before that, it gets its name by introducing itself.
 */
export async function PATCH(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  if (!previewEnabled(auth.value, "companion")) return jsonError(404, "Not found.");
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;
  try {
    const current = await getCompanion(auth.value);
    if (current.stage !== "arrived") return jsonError(409, "It gets its name when it introduces itself.");
    if (input.name !== undefined && input.name.trim() !== current.name) {
      const named = await nameCompanion(auth.value, { name: input.name, manner: input.manner, member: firstName(auth.value.account.name) });
      if (!named.ok) return jsonError(400, named.error);
      return NextResponse.json({ companion: named.companion });
    }
    const updated = input.manner !== undefined ? await setCompanionManner(auth.value, input.manner) : current;
    return NextResponse.json({ companion: updated ?? current });
  } catch (error) {
    return errorResponse(error);
  }
}
