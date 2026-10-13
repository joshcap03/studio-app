import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api";
import { readAttachment, removeUnsentAttachment } from "@/lib/attachments";
import { storeFor } from "@/lib/chat/store-for";
import { authorizeTenant, jsonError } from "@/lib/tenant";

type Context = { params: Promise<{ id: string }> };

// A file that isn't the caller's is indistinguishable from one that doesn't exist: 404.

/** Downloads one of the caller's attached files. Always as a download, never rendered here. */
export async function GET(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "File not found.");
  try {
    const attachment = await storeFor(auth.value).getAttachment(id.data);
    if (!attachment) return jsonError(404, "File not found.");
    const blob = await readAttachment(auth.value, attachment);
    return new NextResponse(blob, {
      headers: {
        "Content-Type": attachment.mimeType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Removes a file the caller attached but hasn't sent. Sent files stay with their message. */
export async function DELETE(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "File not found.");
  try {
    if (!(await removeUnsentAttachment(auth.value, id.data))) return jsonError(404, "File not found.");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
