import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { listRecords, upsertRecord } from "@/lib/tasks/records";
import { collectionSchema, createRecordBody } from "@/lib/tasks/schema";
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

/** A row the member adds to a tracker themself, under a key of its own so it never takes an agent row's place. */
export async function POST(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const body = await parseBody(request, createRecordBody);
  if (body instanceof NextResponse) return body;
  try {
    const record = await upsertRecord(auth.value, { ...body, key: `member-${crypto.randomUUID()}` });
    return NextResponse.json({ record }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
