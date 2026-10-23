import { configure, tasks } from "@trigger.dev/sdk";
import { NextResponse, type NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { parseTriggerEvent, triggerEventSummary } from "@/lib/integrations/composio";
import { capEventData } from "@/lib/tasks/watches";
import type { watchEvent } from "../../../../../trigger/watch-event";

// Where Composio delivers members' watch events (docs/watches.md). Like the voice front, it takes
// no session and reads or writes no member data: it checks Composio's signature, keeps what a run
// needs of the event, and hands it to the background worker, which matches it to its watch and its
// owner in the database. Answers quickly; Composio retries anything but a 2xx, and the event's
// webhook-id keeps a retry from counting twice.

export const dynamic = "force-dynamic";

let configured = false;

export async function POST(request: NextRequest) {
  const watches = getConfig().watches;
  if (!watches) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let event: Awaited<ReturnType<typeof parseTriggerEvent>>;
  try {
    event = await parseTriggerEvent(request, watches.webhookSecret);
  } catch {
    // A bad or stale signature, or a body that isn't Composio's: say nothing more.
    return NextResponse.json({ error: "Not signed." }, { status: 401 });
  }
  if (!event) return NextResponse.json({ ok: true });

  if (!configured) {
    configure({ accessToken: watches.triggerKey });
    configured = true;
  }
  try {
    await tasks.trigger<typeof watchEvent>(
      "watch-event",
      {
        eventId: event.eventId,
        triggerId: event.triggerId,
        composioUserId: event.composioUserId,
        event: {
          id: event.eventId,
          at: new Date().toISOString(),
          summary: triggerEventSummary(event.toolkit, event.triggerSlug, event.data),
          data: capEventData(event.data),
        },
      },
      { idempotencyKey: `watch-event:${event.eventId}`, idempotencyKeyTTL: "1d" },
    );
  } catch (error) {
    // Composio will deliver it again.
    console.error("[watches] couldn't hand an event to the worker:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Try again." }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
