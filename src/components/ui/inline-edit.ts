import { useRef } from "react";

// A text field edited in place: it saves when it loses focus (Enter does that too), and Escape
// puts back what was saved without saving. Escape leaves the field by blurring it, and that blur
// runs inside the keydown, before React re-renders with the saved text back, so the blur still
// holds the edit: it's told to skip the save.

export interface InlineEditHandlers {
  onFocus: () => void;
  onBlur: () => void;
  onKeyDown: (event: { key: string; currentTarget: { blur(): void } }) => void;
}

/**
 * The field's handlers: `commit` saves what's typed (if it changed), `revert` puts the saved text
 * back. `cancelled` carries an Escape to the blur it causes.
 */
export function inlineEditHandlers(cancelled: { current: boolean }, { commit, revert }: { commit: () => void; revert: () => void }): InlineEditHandlers {
  return {
    onFocus() {
      cancelled.current = false;
    },
    onBlur() {
      if (cancelled.current) {
        cancelled.current = false;
        return;
      }
      commit();
    },
    onKeyDown(event) {
      if (event.key === "Enter") event.currentTarget.blur();
      if (event.key === "Escape") {
        cancelled.current = true;
        revert();
        event.currentTarget.blur();
      }
    },
  };
}

/** inlineEditHandlers for a component's field. */
export function useInlineEdit(actions: { commit: () => void; revert: () => void }): InlineEditHandlers {
  const cancelled = useRef(false);
  return inlineEditHandlers(cancelled, actions);
}
