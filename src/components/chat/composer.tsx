"use client";

import { ArrowUp, AudioLines, Paperclip, Sparkles, X } from "lucide-react";
import { forwardRef, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Tooltip } from "radix-ui";
import { TooltipContent } from "@/components/ui/icon-button";
import { useMedia } from "@/components/ui/use-media";
import { usePlayerControls } from "@/components/voice/player";
import { ApiError, api, uploadAttachment } from "@/lib/client/api";
import {
  ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_MESSAGE_LENGTH,
  type Attachment,
  type MessageSkill,
  type Modality,
  type WorkspaceSkill,
} from "@/lib/types";
import { draftSpoken, heldGoesTo, insertWords, type MicMode } from "@/lib/voice/mic";
import type { VoiceStatus } from "@/lib/voice/types";
import { noteTyping } from "@/components/ui/presence";
import { PendingFiles, type PendingFile } from "./attachments";
import { DictationContext, MicButton, MicStatus, useMic } from "./mic";

export interface ComposerHandle {
  focus(): void;
  /** Replace the draft and place the caret at the end. */
  setValue(value: string): void;
  /** Attach a skill to the next message. */
  attachSkill(skill: MessageSkill): void;
  /** Attach files, e.g. dropped anywhere on the chat. */
  addFiles(files: FileList | File[]): void;
  /** Starts dictating into the draft; false where there's no mic. */
  dictate(): boolean;
}

/** What goes with a message besides its text, and how it was said (held to the mic: a voice message). */
export interface MessageExtras {
  skill: MessageSkill | null;
  attachments: Attachment[];
  modality?: Modality;
}

interface Props {
  initialValue?: string;
  onDraftChange?: (value: string) => void;
  onSubmit: (text: string, extras: MessageExtras) => void;
  onStop: () => void;
  running: boolean;
  placeholder: string;
  autoFocus?: boolean;
  variant?: "hero" | "default";
  /** The workspace's skills, offered when the message starts with "/". */
  skills?: WorkspaceSkill[];
  /** Whether files can be attached (the agent can read them). */
  allowFiles?: boolean;
  /** Replaces the placeholder, e.g. while the agent waits for an approval. */
  hint?: string;
  /** Voice for this member: with speech to text, holding the mic sends a voice message (dictation is DictationContext). */
  voice?: VoiceStatus | null;
  /**
   * Sending now would change the agent's course (a run going, or an approval waiting, which a
   * message declines), so a held voice message goes into the draft instead. Defaults to `running`.
   */
  redirects?: boolean;
  /** A call with the agent from here, beside the mic, when the member has calls ("Call Rowan"). */
  call?: { label: string; onCall: () => void; busy?: boolean };
}

const MAX_HEIGHT = 240;
const ACCEPT = Object.keys(ATTACHMENT_TYPES)
  .map((ext) => `.${ext}`)
  .join(",");

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  {
    initialValue = "",
    onDraftChange,
    onSubmit,
    onStop,
    running,
    placeholder,
    autoFocus,
    variant = "default",
    skills = [],
    allowFiles = false,
    hint,
    voice = null,
    redirects = running,
    call,
  },
  ref,
) {
  const [value, setValue] = useState(initialValue);
  const [skill, setSkill] = useState<MessageSkill | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const sent = useRef(new Set<string>());
  // The draft holds a held voice message, waiting for the member's Send (src/lib/voice/mic.ts).
  const spoken = useRef(false);
  const filesRef = useRef(files);
  filesRef.current = files;
  // Typing stops a voice note or preview that's playing.
  const player = usePlayerControls();
  // On touch devices Return inserts a newline; sending is done with the button.
  const coarse = useMedia("(pointer: coarse)");
  const uploading = files.some((f) => f.status === "uploading");
  const hasDraft = value.trim().length > 0 || skill !== null;
  // While the agent works, sending redirects it (the run stops and answers this instead).
  const canSend = hasDraft && !uploading;

  // "/" at the start of an empty-ish message opens the skill menu, filtered by what follows.
  const matches = useMemo(() => {
    const slash = /^\/(\S*)$/.exec(value);
    if (!slash || skills.length === 0) return [];
    const q = slash[1].toLowerCase();
    return skills.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 8);
  }, [value, skills]);
  const menuOpen = matches.length > 0 && !menuDismissed;

  function focusEnd(next: string) {
    focusAt(next.length);
  }

  function focusAt(caret: number) {
    requestAnimationFrame(() => {
      const el = textarea.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  useImperativeHandle(ref, () => ({
    focus: () => textarea.current?.focus(),
    setValue: (next) => {
      spoken.current = draftSpoken(spoken.current, { replaced: true });
      update(next);
      focusEnd(next);
    },
    attachSkill: (next) => {
      setSkill(next);
      focusEnd(value);
    },
    addFiles: (list) => {
      addFiles(list);
      focusEnd(value);
    },
    dictate: () => {
      if (!hasMic || !mic) return false;
      mic.dictate();
      return true;
    },
  }));

  // Grow with content up to MAX_HEIGHT, then scroll inside.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [value]);

  // Uploaded files that were never sent are removed when the composer goes away.
  useEffect(
    () => () => {
      for (const f of filesRef.current) {
        if (f.attachment && !sent.current.has(f.attachment.id)) void api.deleteAttachment(f.attachment.id).catch(() => {});
      }
    },
    [],
  );

  function update(next: string) {
    spoken.current = draftSpoken(spoken.current, { edited: next });
    setValue(next);
    setHighlight(0);
    setMenuDismissed(false);
    onDraftChange?.(next);
    player?.stop();
  }

  function pick(s: WorkspaceSkill) {
    setSkill({ id: s.id, name: s.name });
    update("");
    focusEnd("");
  }

  function addFiles(list: FileList | File[]) {
    if (!allowFiles) return;
    const room = MAX_ATTACHMENTS - filesRef.current.length;
    const incoming = [...list].slice(0, Math.max(0, room));
    for (const file of incoming) {
      const key = crypto.randomUUID();
      const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
      const problem =
        !ext || !ATTACHMENT_TYPES[ext]
          ? "That kind of file isn't supported. Try PDF, Word, CSV, text, or an image."
          : file.size > MAX_ATTACHMENT_BYTES
            ? "Files can be up to 10 MB."
            : null;
      setFiles((all) => [...all, { key, name: file.name, size: file.size, status: problem ? "error" : "uploading", error: problem ?? undefined }]);
      if (problem) continue;
      uploadAttachment(file)
        .then((attachment) => setFiles((all) => all.map((f) => (f.key === key ? { ...f, status: "ready", attachment } : f))))
        .catch((error: unknown) =>
          setFiles((all) =>
            all.map((f) =>
              f.key === key ? { ...f, status: "error", error: error instanceof ApiError ? error.message : "The file didn't upload. Try again." } : f,
            ),
          ),
        );
    }
  }

  function removeFile(key: string) {
    const file = files.find((f) => f.key === key);
    setFiles((all) => all.filter((f) => f.key !== key));
    if (file?.attachment) void api.deleteAttachment(file.attachment.id).catch(() => {});
  }

  /** Sends the draft (or `text`); a draft holding a held voice message goes as one. */
  function submit(text = value.trim(), modality: Modality | undefined = spoken.current ? "voice_note" : undefined) {
    if (!(text || skill) || uploading) return;
    const ready = files.flatMap((f) => (f.status === "ready" && f.attachment ? [f.attachment] : []));
    for (const a of ready) sent.current.add(a.id);
    onSubmit(text, { skill, attachments: ready, ...(modality ? { modality } : {}) });
    spoken.current = draftSpoken(spoken.current, { replaced: true });
    update("");
    setSkill(null);
    setFiles([]);
  }

  // What the member said into the mic: a held voice message is sent as one (with any skill and
  // files already attached), unless sending now would redirect the agent or leave typed words
  // behind; then it joins the draft, like dictation, where the caret is. Held into an empty
  // draft, it's still a voice message once the member sends it.
  const holdsToDraft = heldGoesTo({ redirects, draft: value, uploading }) === "draft";
  const heard = useRef<(words: string, mode: MicMode) => void>(() => undefined);
  heard.current = (words, mode) => {
    const said = words.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!said) return;
    if (mode === "message" && !holdsToDraft) {
      submit(said, "voice_note");
      return;
    }
    const el = textarea.current;
    const at = el ? [el.selectionStart, el.selectionEnd] : [value.length, value.length];
    const next = insertWords(value, at[0], at[1], said);
    if (mode === "message") spoken.current = draftSpoken(spoken.current, { heldInto: value });
    update(next.value.slice(0, MAX_MESSAGE_LENGTH));
    focusAt(Math.min(next.caret, MAX_MESSAGE_LENGTH));
  };
  // Every member can dictate (tap the mic); with voice on, holding it sends a voice message too.
  const dictation = useContext(DictationContext);
  const hold = Boolean(voice?.speech.stt);
  const mic = useMic({ mock: voice ? !voice.live : Boolean(dictation?.mock), hold, onWords: (words, mode) => heard.current(words, mode) });
  const hasMic = Boolean((hold || dictation) && mic);

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((h) => (h + step + matches.length) % matches.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        event.preventDefault();
        pick(matches[Math.min(highlight, matches.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (event.key === "Backspace" && skill && value === "") {
      setSkill(null);
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !coarse) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape" && running) {
      event.preventDefault();
      onStop();
    }
  }

  const hero = variant === "hero";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={`group/composer relative flex cursor-text flex-wrap items-end gap-2 border border-line bg-surface shadow-composer transition-[border-color,box-shadow] duration-200 focus-within:border-line-strong ${hero ? "rounded-[20px] p-2.5 pl-[18px]" : "rounded-[18px] p-2 pl-4"}`}
      onMouseDown={(e) => {
        // Clicking the padding focuses the field, like a native input.
        if (e.target === e.currentTarget) {
          e.preventDefault();
          textarea.current?.focus();
        }
      }}
    >
      {menuOpen ? (
        <ul
          id="composer-skills"
          role="listbox"
          aria-label="Skills"
          className="absolute right-0 bottom-full left-0 z-30 mb-2 max-h-72 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-pop animate-fade-in"
        >
          {matches.map((s, i) => (
            <li
              key={s.id}
              id={`composer-skill-${s.id}`}
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={`flex cursor-default items-start gap-2.5 rounded-lg px-2.5 py-2 ${i === highlight ? "bg-hover" : ""}`}
            >
              <Sparkles size={14} className="mt-0.5 shrink-0 text-fg-3" />
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] text-fg">{s.name}</span>
                {s.description ? <span className="block truncate text-[12px] text-fg-3">{s.description}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <PendingFiles files={files} onRemove={removeFile} />
      {skill ? (
        <span className="mt-0.5 inline-flex h-7 max-w-full basis-full items-center">
          <span className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-accent-soft pr-1 pl-2.5 text-[13px] font-medium text-accent">
            <Sparkles size={13} className="shrink-0" />
            <span className="truncate">{skill.name}</span>
            <button
              type="button"
              aria-label={`Remove ${skill.name}`}
              onClick={() => {
                setSkill(null);
                textarea.current?.focus();
              }}
              className="flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-accent-soft"
            >
              <X size={12} />
            </button>
          </span>
        </span>
      ) : null}
      {hasMic && mic ? <MicStatus mic={mic} holdsToDraft={holdsToDraft} /> : null}
      {allowFiles ? (
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button
              type="button"
              onClick={() => picker.current?.click()}
              disabled={files.length >= MAX_ATTACHMENTS}
              aria-label="Attach files"
              className="-ml-2 flex size-8 shrink-0 items-center justify-center rounded-full text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
            >
              <Paperclip size={17} strokeWidth={1.75} />
            </button>
          </Tooltip.Trigger>
          <TooltipContent label="Attach files" side="top" />
        </Tooltip.Root>
      ) : null}
      <input
        ref={picker}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        tabIndex={-1}
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <label htmlFor="composer-input" className="sr-only">
        Message
      </label>
      <textarea
        id="composer-input"
        ref={textarea}
        rows={1}
        value={value}
        maxLength={MAX_MESSAGE_LENGTH}
        autoFocus={autoFocus}
        placeholder={skill ? "Add details (optional)" : (hint ?? placeholder)}
        onChange={(e) => {
          noteTyping(e.currentTarget);
          update(e.target.value);
        }}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          if (allowFiles && e.clipboardData.files.length > 0) {
            e.preventDefault();
            addFiles(e.clipboardData.files);
          }
        }}
        enterKeyHint={coarse ? "enter" : "send"}
        role={skills.length > 0 ? "combobox" : undefined}
        aria-expanded={skills.length > 0 ? menuOpen : undefined}
        aria-controls={menuOpen ? "composer-skills" : undefined}
        aria-activedescendant={menuOpen ? `composer-skill-${matches[highlight]?.id}` : undefined}
        aria-autocomplete={skills.length > 0 ? "list" : undefined}
        className={`scroll-quiet block w-full min-w-0 flex-1 resize-none bg-transparent leading-6 text-fg outline-none focus-visible:outline-none placeholder:text-fg-4 max-md:text-[16px] ${
          hero ? "min-h-[56px] py-1.5 text-[16px]" : "min-h-8 py-1 text-[15px]"
        }`}
      />
      {call ? (
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button
              type="button"
              onClick={call.onCall}
              disabled={call.busy}
              aria-label={call.label}
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-fg-3 transition-[background-color,color,transform] duration-150 hover:bg-hover hover:text-fg active:scale-90 disabled:opacity-50"
            >
              {call.busy ? <span className="spinner size-3.5" aria-hidden="true" /> : <AudioLines size={17} strokeWidth={1.75} />}
            </button>
          </Tooltip.Trigger>
          <TooltipContent label={call.label} side="top" />
        </Tooltip.Root>
      ) : null}
      {hasMic && mic ? <MicButton mic={mic} /> : null}
      {running && !hasDraft ? (
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-inverse text-on-inverse transition-transform active:scale-90"
            >
              <span className="size-2.5 rounded-[2px] bg-current" />
            </button>
          </Tooltip.Trigger>
          <TooltipContent label="Stop" shortcut="Esc" side="top" />
        </Tooltip.Root>
      ) : running ? (
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send now and redirect the agent"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-inverse text-on-inverse transition-[background-color,color,transform] duration-150 active:scale-90 disabled:bg-press disabled:text-fg-4"
            >
              <ArrowUp size={17} strokeWidth={2.25} />
            </button>
          </Tooltip.Trigger>
          <TooltipContent label="Stop and send this instead" shortcut="Enter" side="top" />
        </Tooltip.Root>
      ) : (
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send message"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-inverse text-on-inverse transition-[background-color,color,transform] duration-150 active:scale-90 disabled:bg-press disabled:text-fg-4"
        >
          <ArrowUp size={17} strokeWidth={2.25} />
        </button>
      )}
    </form>
  );
});
