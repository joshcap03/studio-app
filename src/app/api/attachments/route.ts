import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api";
import { uploadAttachment } from "@/lib/attachments";
import { authorizeTenant, jsonError } from "@/lib/tenant";

// Uploads one file (multipart field "file") for the caller to attach to their next message.
// The file is stored under the caller's own workspace folder; it is linked to a message
// only when that message is sent.

export async function POST(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return jsonError(400, "Choose a file to attach.");
  try {
    return NextResponse.json({ attachment: await uploadAttachment(auth.value, file) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
