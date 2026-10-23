import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The webhook Composio delivers watch events to: only a correctly signed, fresh trigger event
// reaches the worker, once per delivery id, with what a run needs of it; nothing else does.

const SECRET = "whsec_test_secret";
const trigger = vi.fn();
let watchesOn = true;

vi.mock("@trigger.dev/sdk", () => ({ configure: vi.fn(), tasks: { trigger: (...args: unknown[]) => trigger(...args) } }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    composio: { apiKey: "ak_test", toolkits: [] },
    watches: watchesOn ? { webhookSecret: SECRET, triggerKey: "tr_dev_test" } : undefined,
  }),
}));
// The real SDK verifies; it just doesn't send analytics from a test.
vi.mock("@composio/core", async (original) => {
  const real = await original<typeof import("@composio/core")>();
  const Composio = function (config: Record<string, unknown>) {
    return new real.Composio({ ...config, allowTracking: false } as never);
  };
  return { ...real, Composio };
});

const { POST } = await import("./route");

const event = {
  id: "evt_1",
  timestamp: new Date().toISOString(),
  type: "composio.trigger.message",
  metadata: {
    log_id: "log_1",
    trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE",
    trigger_id: "ti_abc",
    connected_account_id: "ca_1",
    auth_config_id: "ac_1",
    user_id: "lj_member",
  },
  data: { sender: "Dana Lee <dana@acme.example>", subject: "Intro call?", messageText: "Free Thursday?" },
};

function signed(body: string, { id = "msg_1", at = Math.floor(Date.now() / 1000), secret = SECRET } = {}) {
  const signature = createHmac("sha256", secret).update(`${id}.${at}.${body}`).digest("base64");
  return new Request("http://app.test/api/watches/composio", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(at), "webhook-signature": `v1,${signature}` },
  });
}

beforeEach(() => {
  trigger.mockReset();
  trigger.mockResolvedValue({ id: "run_1" });
  watchesOn = true;
});

describe("POST /api/watches/composio", () => {
  it("hands a signed trigger event to the worker, keyed by its delivery", async () => {
    const res = await POST(signed(JSON.stringify(event)) as never);
    expect(res.status).toBe(200);
    expect(trigger).toHaveBeenCalledTimes(1);
    const [id, payload, options] = trigger.mock.calls[0];
    expect(id).toBe("watch-event");
    expect(payload).toMatchObject({
      eventId: "msg_1",
      triggerId: "ti_abc",
      composioUserId: "lj_member",
      event: { id: "msg_1", summary: "New email from Dana Lee: Intro call?", data: event.data },
    });
    expect(options).toMatchObject({ idempotencyKey: "watch-event:msg_1" });
  });

  it("refuses a wrong signature, another secret's, or a stale one, and hands nothing on", async () => {
    const body = JSON.stringify(event);
    const forged = signed(body);
    forged.headers.set("webhook-signature", "v1,AAAA");
    for (const request of [forged, signed(body, { secret: "whsec_other" }), signed(body, { at: Math.floor(Date.now() / 1000) - 3600 })]) {
      expect((await POST(request as never)).status).toBe(401);
    }
    // A body changed after signing.
    const tampered = signed(body);
    const changed = new Request(tampered.url, { method: "POST", headers: tampered.headers, body: body.replace("lj_member", "lj_someone_else") });
    expect((await POST(changed as never)).status).toBe(401);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("does nothing with a signed notice that isn't a trigger's", async () => {
    const notice = { id: "evt_2", timestamp: new Date().toISOString(), type: "composio.connected_account.expired", metadata: {}, data: {} };
    expect((await POST(signed(JSON.stringify(notice)) as never)).status).toBe(200);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("asks Composio to deliver again when the worker can't take it", async () => {
    trigger.mockRejectedValueOnce(new Error("down"));
    expect((await POST(signed(JSON.stringify(event)) as never)).status).toBe(503);
  });

  it("isn't there when watches aren't set up", async () => {
    watchesOn = false;
    expect((await POST(signed(JSON.stringify(event)) as never)).status).toBe(404);
    expect(trigger).not.toHaveBeenCalled();
  });
});
