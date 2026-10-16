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
