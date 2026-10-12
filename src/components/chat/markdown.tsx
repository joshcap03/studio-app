"use client";

import { Check, Copy } from "lucide-react";
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { useCopy } from "@/components/ui/use-copy";

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

const components: Components = {
  pre: ({ node, children }) => <CodeBlock node={node as HastNode | undefined}>{children}</CodeBlock>,
  a: ({ node: _node, href, children, ...props }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
  table: ({ node: _node, children, ...props }) => (
    <div className="table-wrap scroll-quiet">
      <table {...props}>{children}</table>
    </div>
  ),
};

const remarkPlugins = [remarkGfm];
const rehypePlugins = [[rehypeHighlight, { detect: false }]] as never;

/** Renders assistant markdown. Raw HTML in the source is ignored, and unsafe URLs are dropped. */
export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <div className="prose-lj">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
