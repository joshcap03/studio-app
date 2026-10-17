import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, noStore } from "@/lib/api";
import { addAgentFile, listAgentFiles } from "@/lib/agent-files";
import { authorizeTenant, jsonError } from "@/lib/tenant";

// The caller's files for the active agent. The agent gets them with every message, in every
// conversation. Private to the caller, like their projects.

export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ files: await listAgentFiles(auth.value) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

/** Adds one file (multipart field "file"). */
export async function POST(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return jsonError(400, "Choose a file to add.");
  try {
    return NextResponse.json({ file: await addAgentFile(auth.value, file) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
