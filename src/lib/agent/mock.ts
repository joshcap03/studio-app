import { AgentError, type AgentAdapter, type AgentEvent, type AgentRunInput } from "./types";
import type { Artifact } from "@/lib/types";

// MOCK AGENT — for development only. Simulated responses, tool activity, and artifacts that
// exercise exactly the same AgentAdapter interface as the real backend. Every mock reply is
// labeled in the UI as not coming from the real agent. All data below is illustrative.

export interface MockOptions {
  /** Emit text incrementally (true) or as a single message event (false). */
  streaming: boolean;
  /** Multiplier for simulated latency. 0 makes the mock instant (tests). */
  pace?: number;
}

type Step =
  | { kind: "activity"; id: string; running: string; done: string; ms: number; detail?: string; fail?: string }
  | { kind: "artifact"; artifact: Artifact }
  | { kind: "text"; text: string }
  | { kind: "error"; message: string };

interface Scenario {
  match: RegExp;
  steps: Step[];
}

const SCENARIOS: Scenario[] = [
  {
    match: /simulate (a )?failure/i,
    steps: [
      { kind: "activity", id: "connect", running: "Connecting to Shopify", done: "Connected to Shopify", ms: 700 },
      {
        kind: "activity",
        id: "orders",
        running: "Retrieving recent orders",
        done: "Retrieved recent orders",
        ms: 1600,
        fail: "Shopify didn't respond within 30 seconds",
      },
      { kind: "error", message: "The agent couldn't finish: Shopify timed out. Nothing was changed." },
    ],
  },
  {
    match: /inventory|stock/i,
    steps: [
      { kind: "activity", id: "catalog", running: "Retrieving product catalog", done: "Retrieved product catalog", ms: 1100, detail: "148 products from Shopify" },
      { kind: "activity", id: "variants", running: "Processing variants", done: "Processed 629 variants", ms: 1400 },
      { kind: "activity", id: "velocity", running: "Comparing against 90-day sales", done: "Compared against 90-day sales", ms: 1200 },
      {
        kind: "text",
        text: `Here's where inventory stands across **629 variants**.

### What needs attention

| Product | Variant | On hand | 90-day sales | Weeks of cover |
| --- | --- | ---: | ---: | ---: |
| Pavé Huggie Hoops | 14k Yellow | 3 | 41 | 1.0 |
| Solitaire Pendant | 0.25 ct · White | 2 | 18 | 1.4 |
| Signet Ring | Size 6 | 1 | 9 | 1.4 |
| Tennis Bracelet | 6.5 in | 4 | 11 | 4.7 |

**Three variants will likely sell out within two weeks.** The huggie hoops are the most urgent: at the current pace you have about a week left.

### Slow movers

- 37 variants haven't sold in 90 days, mostly larger ring sizes (9–11).
- They hold roughly **$18,400** of inventory at cost.

Want me to put the reorder list in a spreadsheet, or draft a note to your casting house?`,
      },
    ],
  },
  {
    match: /spreadsheet|sheet/i,
    steps: [
      { kind: "activity", id: "gather", running: "Gathering order data", done: "Gathered 1,284 orders", ms: 1200 },
      { kind: "activity", id: "create", running: "Creating Google Sheet", done: "Created Google Sheet", ms: 1500 },
      { kind: "activity", id: "write", running: "Writing rows", done: "Wrote 1,284 rows", ms: 1100 },
      { kind: "activity", id: "verify", running: "Verifying results", done: "Verified totals match Shopify", ms: 800 },
      {
        kind: "artifact",
        artifact: {
          id: "mock-sheet-1",
          kind: "spreadsheet",
          title: "Orders by month — 2026",
          description: "1,284 rows · 6 columns",
          source: "Google Sheets",
          url: "https://example.com/mock-artifact",
        },
      },
      {
        kind: "text",
        text: `I created **Orders by month — 2026** with one row per order and a monthly summary tab.

- Columns: date, order number, channel, items, subtotal, and discount
- The summary tab totals revenue and order count by month
- Totals were checked against Shopify and match`,
      },
    ],
  },
  {
    match: /competitor|research/i,
    steps: [
      { kind: "activity", id: "search", running: "Searching the web", done: "Searched the web", ms: 1300, detail: "6 queries" },
      { kind: "activity", id: "read", running: "Reading sources", done: "Read 9 sources", ms: 1800 },
      { kind: "activity", id: "compare", running: "Comparing pricing", done: "Compared pricing", ms: 900 },
      {
        kind: "text",
        text: `Here's a quick read on the competitive set for fine gold huggies in the $300–$900 range.

### Pricing

| Brand | Entry huggie | Diamond huggie | Free shipping |
| --- | ---: | ---: | --- |
| Brand A | $295 | $850 | Over $150 |
| Brand B | $340 | $920 | Always |
| Brand C | $260 | $780 | Over $250 |

### Takeaways

1. Everyone leads with **recycled gold** in their messaging; it's table stakes now.
2. Brand B wins on service: lifetime cleaning and free resizing.
3. Nobody publishes lead times for custom work. That's an opening.

Sources: [example.com/brand-a](https://example.com/brand-a), [example.com/brand-b](https://example.com/brand-b), [example.com/brand-c](https://example.com/brand-c).`,
      },
    ],
  },
  {
    match: /long|slow/i,
    steps: [
      { kind: "activity", id: "s1", running: "Searching Gmail", done: "Found 212 vendor emails", ms: 1800 },
      { kind: "activity", id: "s2", running: "Extracting invoices", done: "Extracted 64 invoices", ms: 2600 },
      { kind: "activity", id: "s3", running: "Matching invoices to payments", done: "Matched 61 of 64 invoices", ms: 2400 },
      { kind: "activity", id: "s4", running: "Checking the 3 unmatched invoices", done: "Checked unmatched invoices", ms: 2000 },
      {
        kind: "text",
        text: `Done. **61 of 64 vendor invoices** from the last quarter match a payment.

The three that don't:

1. Casting invoice #4471 — $1,240, paid twice
2. Stone setter, March — $380, no payment found
3. Packaging order — $96, paid to a different vendor name

Want me to draft emails asking each vendor to confirm?`,
      },
    ],
  },
  {
    match: /code|script|formula/i,
    steps: [
      {
        kind: "text",
        text: `Here's a Google Sheets formula that totals revenue per month from an orders tab:

\`\`\`text
=QUERY(Orders!A:F, "select month(A)+1, sum(E) where A is not null group by month(A)+1 label month(A)+1 'Month', sum(E) 'Revenue'", 1)
\`\`\`

And the same thing as a small script, if you'd rather automate it:

\`\`\`ts
function revenueByMonth(orders: { date: Date; subtotal: number }[]) {
  const totals = new Map<string, number>();
  for (const { date, subtotal } of orders) {
    const key = date.toISOString().slice(0, 7);
    totals.set(key, (totals.get(key) ?? 0) + subtotal);
  }
  return totals;
}
\`\`\``,
      },
    ],
  },
  {
    match: /operations|help/i,
    steps: [
      {
        kind: "text",
        text: `Happy to help. Here's where I'm most useful day to day:

- **Inventory** — what's low, what's slow, and what to reorder
- **Orders and sales** — trends, top products, and channel performance
- **Spreadsheets** — build or update Google Sheets from your data
- **Email** — find vendor threads, summarize them, and draft replies
- **Research** — competitors, suppliers, pricing, and materials

What's on your plate today?`,
      },
    ],
  },
];

const FALLBACK: Step[] = [
  {
    kind: "text",
    text: `This is a **mock response**: the real agent isn't connected, so nothing was looked up or changed.

Try one of these to see how the workspace handles real work:

- *Analyze my inventory* — tool activity and a table
- *Create a spreadsheet of orders by month* — an artifact
- *Research a competitor* — sources and links
- *Run a long reconciliation* — a longer multi-step task
- *Simulate a failure* — error handling and retry`,
  },
];

export function createMockAdapter(options: MockOptions): AgentAdapter {
  const pace = options.pace ?? 1;
  return {
    id: "mock",
    live: false,
    label: "Mock agent",
    capabilities: {
      streaming: options.streaming,
      cancellation: "abort",
      toolEvents: true,
      artifacts: true,
      runStatus: false,
    },
    async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
      const { signal } = input;
      yield { type: "thread", threadId: input.threadId ?? `mock-${input.tenant.workspaceId}.${input.conversationId}` };
      await wait(350 * pace, signal);

      const steps = SCENARIOS.find((s) => s.match.test(input.message))?.steps ?? FALLBACK;
      const streaming = options.streaming && !/non-?streaming/i.test(input.message);

      for (const step of steps) {
        if (step.kind === "activity") {
          yield { type: "activity", id: step.id, label: step.running, status: "running" };
          await wait(step.ms * pace, signal);
          if (step.fail) {
            yield { type: "activity", id: step.id, label: step.running, status: "failed", detail: step.fail };
          } else {
            yield { type: "activity", id: step.id, label: step.done, status: "done", detail: step.detail };
          }
        } else if (step.kind === "artifact") {
          yield { type: "artifact", artifact: step.artifact };
        } else if (step.kind === "error") {
          throw new AgentError(step.message);
        } else if (!streaming) {
          await wait(600 * pace, signal);
          yield { type: "message", text: step.text };
        } else {
          for (const chunk of chunks(step.text)) {
            yield { type: "text-delta", text: chunk };
            await wait(14 * pace, signal);
          }
        }
      }
    },
  };
}

/** Split text into small word-ish pieces, roughly how token streams arrive. */
function chunks(text: string): string[] {
  return text.match(/\s*\S{1,6}|\s+/g) ?? [text];
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return signal.aborted ? Promise.reject(signal.reason) : Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
