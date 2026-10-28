import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { browserSite, fillBrowser, type FillResult, type FillValues } from "@/lib/browser-fill";
import { storeFor } from "@/lib/chat/store-for";
import { credentialsEnabled, listCredentials, revealCredential, saveCard, saveLogin, type CredentialSummary } from "@/lib/secrets";
import { cardBrand, cardDigits, cardExpiry } from "@/lib/secrets/card";
import { authorizeTenant, jsonError, type Tenant } from "@/lib/tenant";
import type { SecretField, UiResponse, UiSecret } from "@/lib/types";

// The secure card for a login, card, or one-time code the agent asked for at its browser (request_secret). What
// the member picks or types comes here, never into the chat: the server types it into this
// conversation's own browser (src/lib/browser-fill.ts), saves it if asked (src/lib/secrets), and
// answers with the words the member's next message says to the agent, which name what was filled
// and never a value. Nothing here logs a request body or puts a value in a response or an error.

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; blockId: string }> };

const ids = z.object({ id: z.uuid(), blockId: z.uuid() });
const cvv = z.string().regex(/^[0-9]{3,4}$/, "Enter the 3 or 4 digit security code.");

const body = z.discriminatedUnion("use", [
  // A saved login (for this site) or card on file; a card saved without its security code needs it typed.
  z.strictObject({ use: z.literal("saved"), credentialId: z.uuid(), cvv: cvv.optional() }),
  z.strictObject({
    use: z.literal("login"),
    username: z.string().trim().max(200),
    password: z.string().min(1, "Enter the password.").max(500),
    save: z.boolean(),
  }),
  z.strictObject({
    use: z.literal("card"),
    number: z.string().max(30),
    name: z.string().trim().min(1, "Enter the name on the card.").max(100),
    expiry: z.string().max(10),
    cvv,
    save: z.boolean(),
  }),
  // A one-time code the site sent them (2FA), as they read it: spaces and dashes are dropped.
  z.strictObject({
    use: z.literal("code"),
    code: z
      .string()
      .max(40)
      .transform((c) => c.replace(/[\s-]/g, ""))
      .pipe(z.string().regex(/^[A-Za-z0-9]{3,12}$/, "Enter the code as the site sent it.")),
  }),
  // The member did it themself, taking over the browser.
  z.strictObject({ use: z.literal("self") }),
]);

const host = (site: string) => {
  try {
    return new URL(site).hostname.replace(/^www\./, "");
  } catch {
    return site;
  }
};

const FIELD_WORDS: Record<SecretField, string> = {
  username: "username",
  password: "password",
  card_name: "name on card",
  card_number: "card number",
  card_expiry: "expiry",
  card_code: "security code",
  one_time_code: "code",
};

const ASKS: Record<UiSecret["secret"], string> = { login: "a sign-in", card: "a payment card", code: "a code" };

const list = (words: string[]) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : (words[0] ?? ""));

/** What the member's next message tells the agent: what was filled where, never a value. */
function filledMessage(request: UiSecret, response: Extract<UiResponse, { status: "filled" }>): string {
  const where = host(response.site);
  if (response.via === "takeover") return `I took over your browser on ${where} and did that part myself. Carry on from the page it's on now.`;
  if (request.secret === "code") return `I filled in the code on ${where}. You can't see it. Carry on, e.g. press Verify.`;
  const what = request.secret === "card" ? `my card${response.label ? ` (${response.label})` : ""}` : `my sign-in${response.label ? ` (${response.label})` : ""}`;
  return `I filled in ${what} on ${where}: ${list(response.fields.map((f) => FIELD_WORDS[f]))}. You can't see the values. Carry on, e.g. submit the form.`;
}

const REFUSALS: Record<Exclude<FillResult, { ok: true }>["reason"], [number, string]> = {
  off: [404, "The browser isn't available here."],
  none: [409, "There's no browser open in this conversation."],
  ended: [409, "The browser has closed. Ask the agent to open the page again."],
  failed: [503, "Couldn't reach the browser just now. Try again."],
  not_https: [409, "That page isn't secure (https), so nothing was filled in."],
  wrong_site: [409, "The browser isn't on the site this login is for, so nothing was filled in."],
  no_fields: [409, "Couldn't find where that goes on this page. Try Do it myself."],
};

async function findRequest(tenant: Tenant, conversationId: string, blockId: string) {
  const store = storeFor(tenant);
  const messages = await store.listMessages(conversationId);
  const message = messages.find((m) => m.ui?.some((b) => b.id === blockId));
  const block = message?.ui?.find((b) => b.id === blockId);
  return message && block?.kind === "secret" ? { store, message, block } : null;
}

/** The site the browser is on now, and what the member has saved that fits it. */
export async function GET(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request, { writes: true });
  if (!auth.ok) return auth.response;
  const parsed = ids.safeParse(await params);
  if (!parsed.success) return jsonError(404, "That card wasn't found.");
  try {
    const found = await findRequest(auth.value, parsed.data.id, parsed.data.blockId);
    if (!found) return jsonError(404, "That card wasn't found.");
    const page = await browserSite(auth.value, parsed.data.id);
    const site = page.ok ? page.site : null;
    let saved: CredentialSummary[] = [];
    // A code is used once: nothing is saved or offered for it.
    const keeps = found.block.secret !== "code" && credentialsEnabled();
    if (keeps && (found.block.secret === "card" || site?.startsWith("https://"))) {
      saved = await listCredentials(auth.value, found.block.secret === "card" ? { kind: "card" } : { kind: "login", origin: site! });
    }
    return NextResponse.json({ site, browser: page.ok ? "open" : page.reason, saved, canSave: keeps }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

/** Fills the login, card, or code into the browser (or records that the member did it themself). */
export async function POST(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const parsed = ids.safeParse(await params);
  if (!parsed.success) return jsonError(404, "That card wasn't found.");
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;
  try {
    const tenant = auth.value;
    const found = await findRequest(tenant, parsed.data.id, parsed.data.blockId);
    if (!found) return jsonError(404, "That card wasn't found.");
    const { store, message, block } = found;
    if (message.uiResponse?.[block.id]) return jsonError(409, "That's already filled in.");

    let response: Extract<UiResponse, { status: "filled" }>;
    if (input.use === "self") {
      const page = await browserSite(tenant, parsed.data.id);
      response = { status: "filled", at: Date.now(), site: page.ok ? page.site : "", via: "takeover", fields: [] };
    } else {
      let values: FillValues;
      let origin: string | undefined;
      let label: string | undefined;
      let save: ((site: string) => Promise<unknown>) | null = null;
      if (input.use === "saved") {
        const saved = await revealCredential(tenant, input.credentialId);
        if (!saved || saved.credential.kind !== block.secret) return jsonError(404, "That saved login or card wasn't found.");
        // A login is named by its username (the site is said anyway), a card by its brand and last four.
        label = saved.credential.username ?? saved.credential.label;
        if ("login" in saved) {
          values = { ...(saved.credential.username ? { username: saved.credential.username } : {}), password: saved.login.password };
          // A saved login fills only on the exact site it was saved for.
          origin = saved.credential.origin;
        } else {
          const { number, name, expMonth, expYear, code } = saved.card;
          const cardCode = input.cvv ?? code;
          if (!cardCode) return jsonError(400, "Enter the 3 or 4 digit security code.");
          values = { card_name: name, card_number: number, card_expiry: `${expMonth}/${expYear}`, card_code: cardCode };
          // A card saved before its code was kept gets it now, so it isn't asked for again.
          if (!code && credentialsEnabled()) save = () => saveCard(tenant, { number, name, expMonth, expYear, code: cardCode, label: saved.credential.label });
        }
      } else if (input.use === "code") {
        if (block.secret !== "code") return jsonError(400, `This card asks for ${ASKS[block.secret]}.`);
        values = { one_time_code: input.code };
      } else if (input.use === "login") {
        if (block.secret !== "login") return jsonError(400, `This card asks for ${ASKS[block.secret]}.`);
        values = { ...(input.username ? { username: input.username } : {}), password: input.password };
        const { username, password } = input;
        if (input.save && credentialsEnabled()) save = (site) => saveLogin(tenant, { origin: site, username, password });
      } else {
        if (block.secret !== "card") return jsonError(400, `This card asks for ${ASKS[block.secret]}.`);
        const number = cardDigits(input.number);
        if (!number) return jsonError(400, "That card number doesn't look right.");
        const exp = cardExpiry(input.expiry);
        if (!exp) return jsonError(400, "Enter the expiry as MM/YY.");
        values = { card_name: input.name, card_number: number, card_expiry: `${exp.month}/${exp.year}`, card_code: input.cvv };
        label = `${cardBrand(number)} ending ${number.slice(-4)}`;
        const { name, cvv: code } = input;
        if (input.save && credentialsEnabled()) save = () => saveCard(tenant, { number, name, expMonth: exp.month, expYear: exp.year, code });
      }

      const result = await fillBrowser(tenant, parsed.data.id, values, origin ? { origin } : {});
      if (!result.ok) {
        const [status, text] = REFUSALS[result.reason];
        return jsonError(status, text, `fill_${result.reason}`);
      }
      // Saved only once it went in, for the site it went in on (https, checked by the fill).
      let saved = false;
      if (save) {
        try {
          await save(result.site);
          saved = true;
        } catch {
          // Filled all the same; the card says it wasn't saved.
          console.error("[secrets] couldn't save a credential");
        }
      }
      response = { status: "filled", at: Date.now(), site: result.site, via: "card", fields: result.fields, ...(label ? { label } : {}), ...(save ? { saved } : {}) };
    }

    await store.updateMessage(message.id, { uiResponse: { ...(message.uiResponse ?? {}), [block.id]: response } });
    return NextResponse.json({ response, message: filledMessage(block, response) });
  } catch {
    // Never echo or log what went wrong in detail: the request held a secret.
    console.error("[secrets] fill failed");
    return jsonError(500, "Something went wrong. Try again.");
  }
}
