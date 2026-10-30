import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

const citation = { n: 1, url: "https://reviews.example/a", quote: "4.5 from 9 reviews", quoteVerified: true, title: "Reviews", app: "web" };

describe("Markdown citations", () => {
  it("turns verified [n] into a citation mark and removes markers that didn't hold up", () => {
    const html = renderToStaticMarkup(<Markdown content={"Rated 4.5 [1]. Hours are long [2].\n\n`a[1]`"} citations={[citation]} />);
    expect(html).toContain('aria-label="Source 1: Reviews"');
    expect(html).not.toContain("[1]</p>");
    expect(html).not.toContain("[2]");
    expect(html).toContain("Hours are long.");
    expect(html).toContain("<code>a[1]</code>");
  });

  it("leaves text alone when a reply has no citations", () => {
    expect(renderToStaticMarkup(<Markdown content="See [1]." />)).toContain("See [1].");
  });
});

describe("SourceList", () => {
  it("lists only the sources the answer points to", async () => {
    const { SourceList } = await import("./citation");
    const two = { ...citation, n: 2, title: "Unused" };
    const html = renderToStaticMarkup(<SourceList citations={[citation, two]} content="Rated 4.5 [1]." />);
    expect(html).toContain("1 source");
    expect(html).not.toContain("Unused");
  });

  it("starts folded", async () => {
    const { SourceList } = await import("./citation");
    const html = renderToStaticMarkup(<SourceList citations={[citation]} content="Rated 4.5 [1]." />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Reviews");
  });
});
