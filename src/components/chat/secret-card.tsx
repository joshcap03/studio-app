"use client";

import { Check, CreditCard, KeyRound, Lock, MessageSquareLock, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import type { CredentialSummary } from "@/lib/secrets";
import type { UiResponse, UiSecret } from "@/lib/types";
import { BrowserDrive } from "./browser-drive";

// The secure card for a login, card, or one-time code (2FA) the agent asked for at its browser
// (request_secret). The member picks one they saved or types one, and Studio types it into the
// browser's page server-side (src/app/api/conversations/[id]/secrets): it never goes into the chat,
// the card's drafts, or anything a call can fill, and the agent hears only what was filled. Or they
// take the browser over and do it themselves (a CAPTCHA, a form the fill can't find). If the
// browser has closed, or is open on no page yet (the agent asked before opening one), one tap
// asks the agent to open the page and ask once more.

const card = "mt-4 overflow-hidden rounded-xl border border-line-strong bg-surface shadow-composer animate-fade-up";
const input =
  "w-full rounded-lg border border-line bg-transparent px-3 py-2 text-[14px] leading-[1.5] text-fg placeholder:text-fg-4 focus:border-line-strong focus:outline-none";
const primary =
  "inline-flex h-8 items-center gap-1.5 rounded-lg bg-inverse px-3.5 text-[13px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:bg-press disabled:text-fg-4";
const secondary = "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg disabled:opacity-60";

const host = (site: string | null) => {
  if (!site) return null;
  try {
    return new URL(site).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};

interface Props {
  request: UiSecret;
  response?: UiResponse;
  conversationId: string;
  messageId: string;
  /** Present while the card can be used (the latest reply, agent idle): sends the agent the words that say what was filled. */
  onAnswer?: (text: string) => void;
  onResponse?: (messageId: string, blockId: string, response: UiResponse) => void;
}

type Lookup = Awaited<ReturnType<typeof api.secretRequest>>;

export function SecretCard({ request, response, conversationId, messageId, onAnswer, onResponse }: Props) {
  const isCard = request.secret === "card";
  const isCode = request.secret === "code";
  const Icon = isCard ? CreditCard : isCode ? MessageSquareLock : KeyRound;
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [picked, setPicked] = useState<string | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [takingOver, setTakingOver] = useState(false);
  // What the member types lives only here, and is cleared once it's sent.
  const [username, setUsername] = useState(request.usernameHint ?? "");
  const [password, setPassword] = useState("");
  const [number, setNumber] = useState("");
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvv, setCvv] = useState("");
  const [code, setCode] = useState("");
  const [save, setSave] = useState(true);
  const live = Boolean(onAnswer && !response);

  useEffect(() => {
    if (!live) return;
    let stopped = false;
    api
      .secretRequest(conversationId, request.id)
      .then((found) => {
        if (stopped) return;
        setLookup(found);
        setPicked((p) => p ?? (found.saved[0]?.id || "new"));
      })
      .catch(() => !stopped && setLookup({ site: null, browser: "failed", saved: [], canSave: false }));
    return () => {
      stopped = true;
    };
  }, [live, conversationId, request.id]);

  const asked = isCard ? "Asked for a card" : isCode ? "Asked for a code" : "Asked you to sign in";

  if (!live) {
    const filled = response?.status === "filled" ? response : null;
    return (
      <section aria-label={label(request.secret)} className="mt-3 flex items-start gap-2 text-[13px] leading-[1.5] text-fg-3 animate-fade-up">
        {filled ? <Check size={14} className="settle-check mt-[3px] shrink-0 text-success" /> : <Icon size={14} className="mt-[3px] shrink-0 text-fg-4" />}
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {asked}
          {filled ? (
            <span className="text-fg-4">
              {" "}
              · {filled.via === "takeover" ? "You did it yourself" : `Filled in${filled.label ? ` with ${filled.label}` : ""}`}
              {host(filled.site) ? ` on ${host(filled.site)}` : ""}
              {filled.saved ? " · Saved" : ""}
            </span>
          ) : null}
        </span>
      </section>
    );
  }

  const site = host(lookup?.site ?? null);
  const insecure = Boolean(lookup?.site && !lookup.site.startsWith("https://"));
  const noBrowser = lookup !== null && lookup.browser !== "open";
  // The browser is open on no page yet: the agent asked before opening one.
  const blank = lookup !== null && lookup.browser === "blank";
  // It was open and isn't now (or never was), or is on no page: the agent can open the page from a tap.
  const closed = blank || (lookup !== null && (lookup.browser === "ended" || lookup.browser === "none"));
  const savedPick = lookup?.saved.find((c) => c.id === picked) ?? null;
  // A card saved before its security code was kept asks for it once; after that it's on file.
  const askCode = Boolean(savedPick && isCard && !savedPick.codeSaved);

  async function send(body: Parameters<typeof api.fillSecret>[2]) {
    setBusy(true);
    setError(null);
    try {
      const done = await api.fillSecret(conversationId, request.id, body);
      setPassword("");
      setNumber("");
      setCvv("");
      setCode("");
      onResponse?.(messageId, request.id, done.response);
      onAnswer?.(done.message);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't fill that in. Try again.");
      // The browser may have closed while they typed: look again, so the card offers to reopen it.
      if (e instanceof ApiError && e.status === 409) {
        api.secretRequest(conversationId, request.id).then(setLookup, () => undefined);
      }
    } finally {
      setBusy(false);
    }
  }

  function fill() {
    if (isCode) return void send({ use: "code", code });
    if (savedPick) return void send({ use: "saved", credentialId: savedPick.id, ...(isCard && askCode ? { cvv } : {}) });
    if (isCard) return void send({ use: "card", number, name, expiry, cvv, save: save && Boolean(lookup?.canSave) });
    return void send({ use: "login", username, password, save: save && Boolean(lookup?.canSave) });
  }

  const ready = isCode
    ? /^[A-Za-z0-9]{3,12}$/.test(code.replace(/[\s-]/g, ""))
    : savedPick
      ? !isCard || !askCode || /^[0-9]{3,4}$/.test(cvv)
      : isCard
        ? Boolean(number && name && expiry && cvv)
        : Boolean(password);

  function reopen() {
    setPassword("");
    setNumber("");
    setCvv("");
    setCode("");
    onAnswer?.(
      blank
        ? "Your browser isn't on a page yet, so there was nowhere to fill that in. Open the page it goes on (navigate to it), and ask me again once the form is showing."
        : isCode
          ? "Your browser closed before I could put the code in. Open the page again where you were, and ask me for a new code if the site sends one."
          : "Your browser closed before I could fill that in. Open the page again where you were and ask me again.",
    );
  }

  return (
    <section aria-label={label(request.secret)} className={card}>
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <Icon size={17} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] font-medium leading-[1.45] text-fg">
            {isCard ? "Pay with a card" : isCode ? "Enter the code" : "Sign in"}
            {site ? <span className="font-normal text-fg-3"> on {site}</span> : null}
          </p>
          <p className="mt-0.5 text-[13.5px] leading-[1.5] text-fg-2 [overflow-wrap:anywhere]">{request.reason}</p>
        </div>
      </div>

      {takingOver ? (
        <TakeOver conversationId={conversationId} busy={busy} onDone={() => void send({ use: "self" })} onCancel={() => setTakingOver(false)} />
      ) : (
        <div className="flex flex-col gap-3 px-4 pt-3 pb-4">
          {lookup === null ? (
            <p className="text-[13px] text-fg-3">Checking the page…</p>
          ) : noBrowser ? (
            <p className="text-[13px] text-fg-3">
              {blank
                ? "The browser isn't on a page yet. Open it and the agent will go to the page this goes on, then ask again."
                : closed
                  ? "The browser closed before this was filled in. Open it again and the agent will go back to this page."
                  : "Couldn't reach the browser just now."}
            </p>
          ) : isCode ? (
            <>
              <SecretInput label="Code" value={code} onChange={setCode} autoComplete="one-time-code" maxLength={20} autoFocus />
              {insecure ? <p className="text-[12.5px] text-danger">This page isn&apos;t secure (https), so nothing can be filled in here.</p> : null}
            </>
          ) : (
            <>
              {lookup.saved.length ? (
                <div role="radiogroup" aria-label={isCard ? "Cards on file" : "Saved logins"} className="flex flex-col gap-1.5">
                  {lookup.saved.map((c) => (
                    <SavedOption key={c.id} group={`secret-${request.id}`} credential={c} checked={picked === c.id} onPick={() => setPicked(c.id)} />
                  ))}
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-[13.5px] text-fg-2 has-[:checked]:border-line-strong has-[:checked]:text-fg">
                    <input type="radio" name={`secret-${request.id}`} checked={picked === "new"} onChange={() => setPicked("new")} className="accent-current" />
                    {isCard ? "Another card" : "Another login"}
                  </label>
                </div>
              ) : null}

              {askCode ? (
                <SecretInput label="Security code" value={cvv} onChange={setCvv} autoComplete="off" inputMode="numeric" maxLength={4} masked />
              ) : null}

              {!savedPick && !isCard ? (
                <>
                  <SecretInput label="Username or email" value={username} onChange={setUsername} autoComplete="off" />
                  <SecretInput label="Password" value={password} onChange={setPassword} autoComplete="off" masked />
                </>
              ) : null}
              {!savedPick && isCard ? (
                <>
                  <SecretInput label="Card number" value={number} onChange={setNumber} autoComplete="off" inputMode="numeric" maxLength={23} masked />
                  <SecretInput label="Name on card" value={name} onChange={setName} autoComplete="off" />
                  <div className="grid grid-cols-2 gap-3">
                    <SecretInput label="Expiry (MM/YY)" value={expiry} onChange={setExpiry} autoComplete="off" maxLength={7} />
                    <SecretInput label="Security code" value={cvv} onChange={setCvv} autoComplete="off" inputMode="numeric" maxLength={4} masked />
                  </div>
                </>
              ) : null}
              {!savedPick && lookup.canSave ? (
                <label className="flex items-center gap-2 text-[13px] text-fg-2">
                  <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} className="accent-current" />
                  {isCard ? "Save card on file" : "Save for next time"}
                </label>
              ) : null}
              {insecure ? <p className="text-[12.5px] text-danger">This page isn&apos;t secure (https), so nothing can be filled in here.</p> : null}
            </>
          )}
        </div>
      )}

      {takingOver ? null : (
        <div className="flex items-center justify-end gap-2 border-t border-line px-3 py-2.5">
          <span className={`mr-auto flex min-w-0 items-center gap-1.5 pl-1 text-[12px] ${error ? "text-danger" : "text-fg-3"}`}>
            {error ? null : <Lock size={12} className="shrink-0" aria-hidden="true" />}
            {error ?? "Studio types this into the page. Your agent never sees it."}
          </span>
          {closed ? (
            <button type="button" onClick={reopen} className={primary}>
              <RotateCcw size={14} />
              {blank ? "Open the page" : "Open it again"}
            </button>
          ) : (
            <>
              <button type="button" onClick={() => setTakingOver(true)} disabled={busy || noBrowser || lookup === null} className={secondary}>
                Do it myself
              </button>
              <button type="button" onClick={fill} disabled={busy || !ready || noBrowser || insecure || lookup === null} className={primary}>
                {busy ? <span className="spinner size-3.5" aria-hidden="true" /> : <Lock size={14} />}
                Fill in
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function label(secret: UiSecret["secret"]): string {
  return secret === "card" ? "Card for the agent's browser" : secret === "code" ? "Code for the agent's browser" : "Sign-in for the agent's browser";
}

function SavedOption({ group, credential, checked, onPick }: { group: string; credential: CredentialSummary; checked: boolean; onPick: () => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-[13.5px] text-fg-2 has-[:checked]:border-line-strong has-[:checked]:text-fg">
      <input type="radio" name={group} checked={checked} onChange={onPick} className="accent-current" />
      <span className="min-w-0 flex-1 truncate">
        {credential.kind === "card" ? `${credential.brand ?? "Card"} •••• ${credential.last4}` : (credential.username ?? credential.label)}
      </span>
      {credential.kind === "card" ? <span className="shrink-0 text-[12px] text-fg-4">{credential.exp}</span> : null}
    </label>
  );
}

function SecretInput({
  label,
  value,
  onChange,
  masked = false,
  ...rest
}: { label: string; value: string; onChange: (v: string) => void; masked?: boolean } & Pick<React.InputHTMLAttributes<HTMLInputElement>, "autoComplete" | "inputMode" | "maxLength" | "autoFocus">) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[13px] font-medium text-fg">{label}</span>
      <input
        type={masked ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        // Keeps password managers from offering to save this as a Studio login.
        data-1p-ignore
        data-lpignore="true"
        className={input}
        {...rest}
      />
    </label>
  );
}

/**
 * Taking the agent's browser over (see BrowserDrive); Done hands it back to the agent.
 */
function TakeOver({ conversationId, busy, onDone, onCancel }: { conversationId: string; busy: boolean; onDone: () => void; onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-2.5 px-4 pt-3 pb-3">
      <BrowserDrive conversationId={conversationId} />
      <div className="flex items-center justify-end gap-2 border-t border-line pt-2.5">
        <button type="button" onClick={onCancel} disabled={busy} className={secondary}>
          Back
        </button>
        <button type="button" onClick={onDone} disabled={busy} className={primary}>
          {busy ? <span className="spinner size-3.5" aria-hidden="true" /> : <Check size={14} />}
          Done, hand back
        </button>
      </div>
    </div>
  );
}
