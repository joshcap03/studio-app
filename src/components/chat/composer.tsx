"use client";

import { ArrowUp, Paperclip } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Tooltip } from "radix-ui";
import { TooltipContent } from "@/components/ui/icon-button";
import { useMedia } from "@/components/ui/use-media";
import { ApiError, api, uploadAttachment } from "@/lib/client/api";
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_MESSAGE_LENGTH, type Attachment } from "@/lib/types";
import { PendingFiles, type PendingFile } from "./attachments";

export interface ComposerHandle {
  focus(): void;
  /** Replace the draft and place the caret at the end. */
  setValue(value: string): void;
}

interface Props {
  initialValue?: string;
  onDraftChange?: (value: string) => void;
  onSubmit: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  running: boolean;
  placeholder: string;
  autoFocus?: boolean;
  variant?: "hero" | "default";
  /** Whether files can be attached (the agent can read them). */
  allowFiles?: boolean;
  /** Why sending is paused, e.g. while the agent waits for an approval. */
  blocked?: string;
}

const MAX_HEIGHT = 240;
const ACCEPT = Object.keys(ATTACHMENT_TYPES)
  .map((ext) => `.${ext}`)
  .join(",");

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { initialValue = "", onDraftChange, onSubmit, onStop, running, placeholder, autoFocus, variant = "default", allowFiles = false, blocked },
  ref,
) {
  const [value, setValue] = useState(initialValue);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const sent = useRef(new Set<string>());
  const filesRef = useRef(files);
  filesRef.current = files;
  // On touch devices Return inserts a newline; sending is done with the button.
  const coarse = useMedia("(pointer: coarse)");
  const uploading = files.some((f) => f.status === "uploading");
  const canSend = value.trim().length > 0 && !running && !blocked && !uploading;

  useImperativeHandle(ref, () => ({
    focus: () => textarea.current?.focus(),
    setValue: (next) => {
      update(next);
      requestAnimationFrame(() => {
        const el = textarea.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(next.length, next.length);
      });
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
    setValue(next);
    onDraftChange?.(next);
  }

  function addFiles(list: FileList | File[]) {
    if (!allowFiles) return;
    const room = MAX_ATTACHMENTS - filesRef.current.length;
    const incoming = [...list].slice(0, Math.max(0, room));
    for (const file of incoming) {
      const key = crypto.randomUUID();
      const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
      const problem = !ext || !ATTACHMENT_TYPES[ext]
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

  function submit() {
    if (!canSend) return;
    const ready = files.flatMap((f) => (f.status === "ready" && f.attachment ? [f.attachment] : []));
    for (const a of ready) sent.current.add(a.id);
    onSubmit(value.trim(), ready);
    update("");
    setFiles([]);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !coarse) {
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
      onDragOver={(e) => {
        if (!allowFiles || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!allowFiles || e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer.files);
      }}
      className={`group/composer relative flex cursor-text flex-col border bg-surface shadow-composer transition-[border-color,box-shadow] duration-200 focus-within:border-line-strong ${
        dragging ? "border-accent" : "border-line"
      } ${hero ? "rounded-[20px] p-2.5 pl-[18px]" : "rounded-[18px] p-2 pl-4"}`}
      onMouseDown={(e) => {
        // Clicking the padding focuses the field, like a native input.
        if (e.target === e.currentTarget) {
          e.preventDefault();
          textarea.current?.focus();
        }
      }}
    >
      <PendingFiles files={files} onRemove={removeFile} />
      <div className="flex items-end gap-2">
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
          placeholder={blocked ?? placeholder}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (allowFiles && e.clipboardData.files.length > 0) {
              e.preventDefault();
              addFiles(e.clipboardData.files);
            }
          }}
          enterKeyHint={coarse ? "enter" : "send"}
          className={`scroll-quiet block w-full flex-1 resize-none bg-transparent leading-6 text-fg outline-none focus-visible:outline-none placeholder:text-fg-4 max-md:text-[16px] ${
            hero ? "min-h-[56px] py-1.5 text-[16px]" : "min-h-8 py-1 text-[15px]"
          }`}
        />
        {running ? (
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
      </div>
    </form>
  );
});
