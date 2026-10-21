"use client";

import { Check, CreditCard, KeyRound, Lock, MousePointerClick } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useBrowserFrames } from "@/components/voice/browser-view";
import { api, ApiError } from "@/lib/client/api";
import type { DriveInput } from "@/lib/browser-fill";
import type { CredentialSummary } from "@/lib/secrets";
import type { UiResponse, UiSecret } from "@/lib/types";

// The secure card for a login or card the agent asked for at its browser (request_secret). The
// member picks one they saved or types one, and Studio types it into the browser's page
// server-side (src/app/api/conversations/[id]/secrets): it never goes into the chat, the card's
// drafts, or anything a call can fill, and the agent hears only what was filled. Or they take the
// browser over and do it themselves (a 2FA code, a CAPTCHA, a form the fill can't find).

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
  const Icon = isCard ? CreditCard : KeyRound;
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

  if (!live) {
    const filled = response?.status === "filled" ? response : null;
    return (
      <section aria-label={isCard ? "Card for the agent's browser" : "Sign-in for the agent's browser"} className="mt-3 flex items-start gap-2 text-[13px] leading-[1.5] text-fg-3 animate-fade-up">
        {filled ? <Check size={14} className="settle-check mt-[3px] shrink-0 text-success" /> : <Icon size={14} className="mt-[3px] shrink-0 text-fg-4" />}
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {isCard ? "Asked for a card" : "Asked you to sign in"}
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
  const savedPick = lookup?.saved.find((c) => c.id === picked) ?? null;

  async function send(body: Parameters<typeof api.fillSecret>[2]) {
    setBusy(true);
    setError(null);
    try {
      const done = await api.fillSecret(conversationId, request.id, body);
      setPassword("");
      setNumber("");
      setCvv("");
      onResponse?.(messageId, request.id, done.response);
      onAnswer?.(done.message);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't fill that in. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function fill() {
    if (savedPick) return void send({ use: "saved", credentialId: savedPick.id, ...(isCard ? { cvv } : {}) });
    if (isCard) return void send({ use: "card", number, name, expiry, cvv, save: save && Boolean(lookup?.canSave) });
    return void send({ use: "login", username, password, save: save && Boolean(lookup?.canSave) });
  }

  const ready = savedPick ? !isCard || /^[0-9]{3,4}$/.test(cvv) : isCard ? Boolean(number && name && expiry && cvv) : Boolean(password);

  return (
    <section aria-label={isCard ? "Card for the agent's browser" : "Sign-in for the agent's browser"} className={card}>
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <Icon size={17} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] font-medium leading-[1.45] text-fg">
            {isCard ? "Pay with a card" : "Sign in"}
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
            <p className="text-[13px] text-fg-3">There&apos;s no browser open here right now. Ask the agent to open the page again.</p>
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

              {savedPick && isCard ? (
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
                  {isCard ? "Save card on file (not the security code)" : "Save for next time"}
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
          <button type="button" onClick={() => setTakingOver(true)} disabled={busy || noBrowser || lookup === null} className={secondary}>
            Do it myself
          </button>
          <button type="button" onClick={fill} disabled={busy || !ready || noBrowser || insecure || lookup === null} className={primary}>
            {busy ? <span className="spinner size-3.5" aria-hidden="true" /> : <Lock size={14} />}
            Fill in
          </button>
        </div>
      )}
    </section>
  );
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
}: { label: string; value: string; onChange: (v: string) => void; masked?: boolean } & Pick<React.InputHTMLAttributes<HTMLInputElement>, "autoComplete" | "inputMode" | "maxLength">) {
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
 * Taking the agent's browser over: a live picture of the page, where a click or scroll on the
 * picture happens on the page, and what's typed in the box below is typed there. The browser's
 * connection stays on the server; Done hands it back to the agent.
 */
function TakeOver({ conversationId, busy, onDone, onCancel }: { conversationId: string; busy: boolean; onDone: () => void; onCancel: () => void }) {
  const frames = useBrowserFrames(conversationId, true, 700);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  // One at a time, in order: a click has to land before the typing meant for the field it picks.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const drive = (input: DriveInput) =>
    (queue.current = queue.current.then(() =>
      api.driveBrowser(conversationId, input).then(
        () => setError(null),
        (e: unknown) => setError(e instanceof ApiError ? e.message : "Couldn't reach the browser just now."),
      ),
    ));
  const at = (e: React.MouseEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)) };
  };

  return (
    <div className="flex flex-col gap-2.5 px-4 pt-3 pb-3">
      <div className="overflow-hidden rounded-lg border border-line bg-subtle">
        {frames.kind === "showing" ? (
          // eslint-disable-next-line @next/next/no-img-element -- a live picture from our own route, not a static asset
          <img
            src={frames.url}
            alt="The agent's browser. Click to click there."
            draggable={false}
            className="block w-full cursor-pointer select-none"
            onClick={(e) => void drive({ type: "click", ...at(e) })}
            onWheel={(e) => void drive({ type: "scroll", ...at(e), dy: Math.max(-2000, Math.min(2000, e.deltaY)) })}
          />
        ) : (
          <p className="px-3 py-6 text-center text-[13px] text-fg-3">{frames.kind === "gone" ? "The browser has closed." : "Opening the browser…"}</p>
        )}
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text) return;
          const typed = text;
          setText("");
          void drive({ type: "text", text: typed });
        }}
      >
        <input
          type="password"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Click a field above, then type here"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          aria-label="Type into the page"
          className={input}
        />
        <button type="submit" disabled={!text} className={secondary}>
          Type
        </button>
      </form>
      <div className="flex flex-wrap items-center gap-1.5">
        {(["Tab", "Enter", "Backspace"] as const).map((key) => (
          <button key={key} type="button" onClick={() => void drive({ type: "key", key })} className="inline-flex h-7 items-center rounded-md border border-line px-2 text-[12px] text-fg-2 hover:bg-hover hover:text-fg">
            {key}
          </button>
        ))}
        <span className={`ml-auto flex items-center gap-1.5 text-[12px] ${error ? "text-danger" : "text-fg-3"}`}>
          {error ? null : <MousePointerClick size={12} aria-hidden="true" />}
          {error ?? "You're driving. The agent waits."}
        </span>
      </div>
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
