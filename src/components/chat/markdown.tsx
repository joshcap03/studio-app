"use client";

import { Check, Copy } from "lucide-react";
import { memo, useContext, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { useCopy } from "@/components/ui/use-copy";
import type { Citation } from "@/lib/types";
import { CitationCard, CitationChip, CitationContext } from "./citation";

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

function textOf(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

function CodeBlock({ node, children }: { node?: HastNode; children?: React.ReactNode }) {
  const code = node?.children?.find((c) => c.tagName === "code");
  const classes = code?.properties?.className;
  const language = Array.isArray(classes)
    ? classes.map(String).find((c) => c.startsWith("language-"))?.slice("language-".length)
    : undefined;
  const [copied, copy] = useCopy();

  return (
    <div className="group/code my-1 mb-[1.1em] overflow-hidden rounded-[10px] border border-line bg-subtle/60">
      <div className="flex h-9 items-center justify-between border-b border-line pr-1.5 pl-3.5">
        <span className="font-mono text-[11.5px] text-fg-3">{language ?? "code"}</span>
        <button
          type="button"
          onClick={() => copy(textOf(code).replace(/\n$/, ""))}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-fg-3 transition-colors hover:bg-hover hover:text-fg"
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

/** The open citation's card goes right after the paragraph or list item that cites it. */
function WithCitationCard({ node, children }: { node?: HastNode; children: React.ReactNode }) {
  const state = useContext(CitationContext);
  const open = state?.open != null && cites(node, state.open) ? state.citations.get(state.open) : undefined;
  return (
    <>
      {children}
      {open ? <CitationCard citation={open} /> : null}
    </>
  );
}

function cites(node: HastNode | undefined, n: number): boolean {
  if (!node) return false;
  if (node.tagName === "cite" && Number((node.properties as { dataN?: unknown } | undefined)?.dataN) === n) return true;
  // A list item's own text only; nested lists show the card under their own items.
  return (node.children ?? []).some((c) => c.tagName !== "ul" && c.tagName !== "ol" && cites(c, n));
}

const components: Components = {
  pre: ({ node, children }) => <CodeBlock node={node as HastNode | undefined}>{children}</CodeBlock>,
  a: ({ node: _node, href, children, ...props }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
  p: ({ node, children, ...props }) => (
    <WithCitationCard node={node as HastNode | undefined}>
      <p {...props}>{children}</p>
    </WithCitationCard>
  ),
  li: ({ node, children, ...props }) => (
    <li {...props}>
      <WithCitationCard node={node as HastNode | undefined}>{children}</WithCitationCard>
    </li>
  ),
  cite: ({ node }) => <CitationChip n={Number((node?.properties as { dataN?: unknown } | undefined)?.dataN)} />,
  table: ({ node: _node, children, ...props }) => (
    <div className="table-wrap scroll-quiet">
      <table {...props}>{children}</table>
    </div>
  ),
};

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/**
 * Turns each [n] in the answer's text into a citation mark, but only for numbers the server
 * verified. Any other [n] is the agent citing something that didn't hold up, so it's removed.
 * Code is left alone. Only runs when the reply has citations.
 */
function remarkCitations(known: Set<number>) {
  const marker = /\s?\[(\d{1,2})\]/g;
  const visit = (node: MdNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child): MdNode[] => {
      if (child.type !== "text" || !child.value?.includes("[")) {
        visit(child);
        return [child];
      }
      const out: MdNode[] = [];
      let last = 0;
      for (const match of child.value.matchAll(marker)) {
        const n = Number(match[1]);
        out.push({ type: "text", value: child.value.slice(last, match.index) });
        if (known.has(n)) out.push({ type: "citation", data: { hName: "cite", hProperties: { dataN: n } } });
        last = match.index! + match[0].length;
      }
      out.push({ type: "text", value: child.value.slice(last) });
      return out.filter((n) => n.type !== "text" || n.value);
    });
  };
  return () => (tree: MdNode) => visit(tree);
}

const remarkPlugins = [remarkGfm];
const rehypePlugins = [[rehypeHighlight, { detect: false }]] as never;

/** Renders assistant markdown. Raw HTML in the source is ignored, and unsafe URLs are dropped. */
export const Markdown = memo(function Markdown({ content, citations }: { content: string; citations?: Citation[] | null }) {
  const [open, setOpen] = useState<number | null>(null);
  const byNumber = useMemo(() => new Map((citations ?? []).map((c) => [c.n, c])), [citations]);
  const plugins = useMemo(
    () => (byNumber.size > 0 ? [remarkGfm, remarkCitations(new Set(byNumber.keys()))] : remarkPlugins),
    [byNumber],
  );
  const state = useMemo(() => ({ citations: byNumber, open, setOpen }), [byNumber, open]);
  return (
    <CitationContext.Provider value={state}>
      <div className="prose-lj">
        <ReactMarkdown remarkPlugins={plugins} rehypePlugins={rehypePlugins} components={components}>
          {content}
        </ReactMarkdown>
      </div>
    </CitationContext.Provider>
  );
});


