"use client";

import { Tooltip } from "radix-ui";
import { forwardRef } from "react";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
};

/** Square icon button with an accessible label and a quiet tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton(
  { label, shortcut, side = "bottom", className = "", children, ...rest },
  ref,
) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          ref={ref}
          type="button"
          aria-label={label}
          className={`inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-hover hover:text-fg active:bg-press disabled:pointer-events-none disabled:opacity-40 ${className}`}
          {...rest}
        >
          {children}
        </button>
      </Tooltip.Trigger>
      <TooltipContent side={side} label={label} shortcut={shortcut} />
    </Tooltip.Root>
  );
});

export function TooltipContent({
  label,
  shortcut,
  side = "bottom",
}: {
  label: string;
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <Tooltip.Portal>
      <Tooltip.Content
        side={side}
        sideOffset={6}
        className="z-50 flex items-center gap-2 rounded-md bg-inverse px-2 py-1 text-[12px] font-medium text-on-inverse shadow-pop animate-fade-in"
      >
        {label}
        {shortcut ? <span className="font-normal opacity-60">{shortcut}</span> : null}
      </Tooltip.Content>
    </Tooltip.Portal>
  );
}
