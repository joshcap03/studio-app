import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { pushPublicKey, removeSubscription, saveSubscription } from "@/lib/push";
import { authorizeSession, jsonError } from "@/lib/tenant";

// Notifications on this device: the key a browser subscribes with, and saving or removing
// the caller's own subscription.

const subscription = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});
const removal = z.object({ endpoint: z.string().min(1).max(2000) });

export async function GET(request: NextRequest) {
  const auth = await authorizeSession(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ publicKey: pushPublicKey() }, noStore);
}

export async function POST(request: NextRequest) {
  const auth = await authorizeSession(request);
  if (!auth.ok) return auth.response;
  if (!pushPublicKey()) return jsonError(503, "Notifications aren't set up on this server.", "push_unavailable");
  const input = await parseBody(request, subscription);
  if (input instanceof NextResponse) return input;
  try {
    await saveSubscription(auth.value, input, request.headers.get("user-agent"));
    return NextResponse.json({ ok: true }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await authorizeSession(request);
  if (!auth.ok) return auth.response;
  const input = await parseBody(request, removal);
  if (input instanceof NextResponse) return input;
  try {
    await removeSubscription(auth.value, input.endpoint);
    return NextResponse.json({ ok: true }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}
