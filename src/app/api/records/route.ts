import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, noStore } from "@/lib/api";
import { listRecords } from "@/lib/tasks/records";
import { collectionSchema } from "@/lib/tasks/schema";
import { authorizeTenant, jsonError } from "@/lib/tenant";

/** The member's tracked records, optionally in one collection (?collection=job-applications). */
export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const param = request.nextUrl.searchParams.get("collection");
  const collection = param === null ? undefined : collectionSchema.safeParse(param);
  if (collection && !collection.success) return jsonError(400, collection.error.issues[0]?.message ?? "Invalid collection.");
  try {
    return NextResponse.json({ records: await listRecords(auth.value, collection?.data) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}
