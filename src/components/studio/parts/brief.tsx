"use client";

import { useEffect, useState, type RefObject } from "react";
import { OnHomeSwitch } from "@/components/ui/on-home-switch";
import { api } from "@/lib/client/api";
import { ASKS } from "@/lib/studio";
import type { AgentTemplate } from "@/lib/templates";
import { MAX_CONTEXT_LENGTH, type MessageSkill, type WorkspaceSettings } from "@/lib/types";
import { DescribeBar, quietLink } from "../ask-link";
import { saveLine, useAutosave } from "../use-autosave";
import { fieldClass, PartHead, Unread } from "./shared";

// What the agent reads before every reply, in two editors. Saved as they're typed; History holds
// what they said before.

export function BriefPart({
  settings,
  owner,
  template,
  several,
  onHome,
  onOnHome,
  saveNow,
  onDescribe,
  onSaved,
  onSetup,
}: {
  settings: WorkspaceSettings | null;
  owner: boolean;
  template: AgentTemplate | undefined | null;
  several: boolean;
  onHome: boolean;
  onOnHome: (on: boolean) => Promise<void>;
  saveNow: RefObject<(() => void) | null>;
  onDescribe: (text: string | null, skill?: MessageSkill | null) => void;
  onSaved: (settings: WorkspaceSettings) => void;
  onSetup: () => void;
}) {
  const [profile, setProfile] = useState(settings?.profile ?? "");
  const [instructions, setInstructions] = useState(settings?.agentInstructions ?? "");
  const value = { profile, instructions };
  const { status, error, flush } = useAutosave(value, async (next) => {
    const { settings: saved } = await api.updateSettings({ profile: next.profile, agentInstructions: next.instructions });
    onSaved(saved);
  });
  useEffect(() => {
    saveNow.current = flush;
    return () => {
      saveNow.current = null;
    };
  }, [flush, saveNow]);
  const [homeBusy, setHomeBusy] = useState(false);

  if (!settings) return <Unread>The brief couldn&apos;t be read just now.</Unread>;

  return (
    <>
      <PartHead title="Brief" hint={owner ? "What it reads before every reply. Change a line, then try it." : "What it reads before every reply."}>
        <span role="status" className={`text-[12px] ${status === "error" ? "text-danger" : "text-fg-3"}`}>
          {saveLine(status, error)}
        </span>
      </PartHead>

      <label className="block">
        <span className="text-[13px] font-medium text-fg-2">What it&apos;s for</span>
        {owner ? (
          <textarea
            value={profile}
            maxLength={MAX_CONTEXT_LENGTH}
            rows={4}
            onChange={(e) => setProfile(e.target.value)}
            onBlur={flush}
            placeholder="Who it works for and what they want from it."
            className={`mt-1.5 max-h-[50vh] resize-none py-2.5 text-[14px] leading-relaxed [field-sizing:content] ${fieldClass}`}
          />
        ) : (
          <p className="mt-1.5 whitespace-pre-wrap text-[14px] leading-relaxed text-fg-2 [overflow-wrap:anywhere]">{profile || "Nothing yet."}</p>
        )}
      </label>

      <label className="mt-4 block">
        <span className="text-[13px] font-medium text-fg-2">How it works</span>
        {owner ? (
          <textarea
            value={instructions}
            maxLength={MAX_CONTEXT_LENGTH}
            rows={8}
            onChange={(e) => setInstructions(e.target.value)}
            onBlur={flush}
            placeholder={"Keep replies short.\nNever email a customer without saying so."}
            className={`mt-1.5 max-h-[60vh] resize-none py-2.5 font-mono text-[12.5px] leading-relaxed [field-sizing:content] ${fieldClass}`}
          />
        ) : (
          <p className="mt-1.5 whitespace-pre-wrap font-mono text-[12.5px] leading-relaxed text-fg-2 [overflow-wrap:anywhere]">{instructions || "Nothing yet."}</p>
        )}
      </label>

      {owner ? (
        <div className="mt-4">
          <DescribeBar lead={ASKS.brief} placeholder="Or describe the change, and it drafts it" onDescribe={onDescribe} />
        </div>
      ) : (
        <p className="mt-4 text-[13px] text-fg-3">Only the owner can change the brief.</p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3 text-[13px] text-fg-3">
        <span>{template && template.id !== "blank" ? `Started from ${template.name}` : "Started from scratch"}</span>
        <a href="/agent" className={quietLink}>
          Name and voice
        </a>
        {owner ? (
          <button type="button" onClick={onSetup} className={quietLink}>
            Run setup
          </button>
        ) : null}
        {owner && several ? (
          <label className="ml-auto flex items-center gap-2.5 font-medium text-fg-2">
            On Home
            <OnHomeSwitch
              on={onHome}
              busy={homeBusy}
              onToggle={() => {
                setHomeBusy(true);
                void onOnHome(!onHome).finally(() => setHomeBusy(false));
              }}
              label="On Home"
            />
          </label>
        ) : null}
      </div>
    </>
  );
}
