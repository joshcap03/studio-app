import { AgentError, type AgentAdapter, type AgentEvent, type AgentRunInput, type ApprovalAction } from "./types";
import type { Artifact, StepAction, StepPreview } from "@/lib/types";
import type { Evidence } from "./tools/evidence";

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
  | {
      kind: "activity";
      id: string;
      running: string;
      done: string;
      ms: number;
      detail?: string;
      fail?: string;
      app?: string;
      action?: StepAction;
      preview?: StepPreview;
    }
  | { kind: "note"; text: string; ms?: number }
  /** An opening line that turned out to be part of the reply after all (only books kept since). */
  | { kind: "released"; text: string }
  | { kind: "artifact"; artifact: Artifact }
  | { kind: "text"; text: string }
  | { kind: "error"; message: string }
  /** `actions`: what approving it would run, as a real provider reports it, for deciding whether it may be approved by voice. */
  | { kind: "approval"; summary: string; app: string; details: [string, string][]; actions?: ApprovalAction[]; after?: "payment" | "labels" }
  | { kind: "remember"; content: string }
  | { kind: "timeline"; timeline: unknown }
  | { kind: "visual"; visual: unknown }
  | { kind: "questions"; questions: unknown }
  | { kind: "ui"; block: unknown }
  | { kind: "evidence"; items: Evidence[] }
  | { kind: "citations"; citations: unknown }
  | { kind: "plan"; plan: unknown; goal?: string }
  | { kind: "record"; record: unknown }
  /** Out of time with the job unfinished: the next reply carries it on (keep_going). */
  | { kind: "keep-going"; remaining: string }
  | { kind: "report"; report: unknown };

interface Scenario {
  match: RegExp;
  steps: Step[];
}

const CITE_PAGE = "https://reviews.example/acme-atelier";
const CITE_JOBS = "https://acme-atelier.example/careers";

const SCENARIOS: Scenario[] = [
  {
    // The next reply, carrying on a job the last one ran out of time for.
    match: /^\[Carry on with the job/,
    steps: [
      { kind: "activity", id: "rest", running: "Labeling the rest of the threads", done: "Labeled the rest of the threads", ms: 700, app: "gmail", action: "write" },
      { kind: "text", text: "Done: the rest of the threads are labeled too (demo)." },
    ],
  },
  {
    // A long job that doesn't fit in one reply: the first piece, then the next reply carries on.
    match: /\bkeep going\b/i,
    steps: [
      { kind: "activity", id: "first", running: "Labeling the first threads", done: "Labeled the first threads", ms: 700, app: "gmail", action: "write" },
      { kind: "keep-going", remaining: "label the remaining threads (demo)" },
      { kind: "text", text: "Labeled the first 200 threads (demo). Carrying on with the rest." },
    ],
  },
  {
    // A setup form with every kind of field; the answers arrive as the member's next message.
    // First: the setup skill's own instructions mention sources and a trial run.
    match: /\b(set (me|you) up|set up this agent|show me a form)\b/i,
    steps: [
      { kind: "text", text: "Let's get you set up (mock)." },
      {
        kind: "plan",
        plan: [
          { text: "What success looks like", status: "done", note: "Bar set: 5 criteria, 2 deal-breakers (mock)" },
          { text: "Your résumé", status: "done", note: "Read it: 8 years in B2B SaaS design (mock)" },
          { text: "Your search", status: "doing" },
          { text: "Your stories", status: "todo" },
          { text: "Your apps", status: "todo" },
          { text: "How I'll work", status: "todo" },
        ],
      },
      {
        kind: "ui",
        block: {
          form: {
            title: "Your search (mock)",
            intro: "A few things so I can look in the right places. I filled in what I could guess.",
            submit_label: "Next",
            fields: [
              { kind: "choice", id: "job", label: "The one thing you most want from me", options: ["Find roles that fit", "Tailor applications", "Reach out to people"], allow_other: true, required: true },
              { kind: "text", id: "roles", label: "Target roles", placeholder: "e.g. Product manager, growth", prefill: "Product manager" },
              { kind: "multi_choice", id: "where", label: "Where", options: ["Remote", "Hybrid", "On-site"] },
              { kind: "scale", id: "hands_on", label: "How hands-on should I be?", low: "Ask me first", high: "Just do it", prefill: 2 },
              { kind: "rank", id: "matters", label: "What matters most?", options: ["Pay", "Remote", "Seniority", "Industry"] },
              { kind: "file", id: "resume", label: "Your résumé", accept: ["pdf", "docx"], max: 1, keep: true },
              {
                kind: "list",
                id: "stories",
                label: "Stories for interviews",
                item_label: "Story",
                max: 4,
                parts: [
                  { id: "situation", label: "Situation", long: true },
                  { id: "action", label: "What you did", long: true },
                  { id: "result", label: "Result" },
                ],
                prefill: [{ situation: "Signups had stalled for two quarters.", action: "Rebuilt onboarding with the design team.", result: "Activation up 18%." }],
              },
              { kind: "connect", id: "apps", label: "Apps I'll work in", apps: ["gmail", "apollo", "hunter"] },
            ],
          },
        },
      },
    ],
  },
  {
    // The agent at a sign-in or payment form in its browser, asking for the login or card on the
    // secure card (the app fills it in; the agent never sees it).
    match: /\bsign me in\b/i,
    steps: [
      { kind: "text", text: "I'm on the page with the form open (mock)." },
      {
        kind: "ui",
        block: { secret_request: { kind: "login", reason: "To sign in and pull your latest invoice (mock).", username_hint: "" } },
      },
    ],
  },
  {
    match: /\bask me for the code\b/i,
    steps: [
      { kind: "text", text: "The site sent you a code (mock)." },
      { kind: "ui", block: { secret_request: { kind: "code", reason: "To finish signing in: the code the site just texted you (mock)." } } },
    ],
  },
  {
    match: /\bpay with my card\b/i,
    steps: [
      { kind: "text", text: "I'm at checkout (mock)." },
      { kind: "ui", block: { secret_request: { kind: "card", reason: "To pay for the order in your cart (mock)." } } },
    ],
  },
  {
    // A reply with an offer to talk it through on a call; the card shows only to members who
    // could take one (the turn drops it otherwise).
    match: /\b(hop on a call|offer (me )?a call)\b/i,
    steps: [
      { kind: "text", text: "There are a few trade-offs here: pay against growth, and remote against a team you'd see every day (mock)." },
      { kind: "ui", block: { offer_call: { reason: "This one's worth five minutes: three trade-offs to weigh (mock).", topic: "Which offer to take (mock)" } } },
    ],
  },
  {
    // A page with a CAPTCHA: the browser handed to the member as a card (shown only where the app
    // can reach a hosted browser; the turn drops it otherwise).
    match: /\b(robot check|take over the browser)\b/i,
    steps: [
      { kind: "text", text: "The label page wants a robot check, so it's your turn (mock)." },
      { kind: "ui", block: { hand_browser: { reason: "Solve the robot check, then tap Done and I'll finish the label (mock).", site: "USPS" } } },
    ],
  },
  {
    // "Show me once": the member shows the agent a job in its browser, and it writes it up as a
    // skill with its guesses to check (the steps come back as their next message).
    match: /^I've shown you how I do it/i,
    steps: [
      { kind: "text", text: "Got it. Here's how I'd write that up (mock)." },
      {
        kind: "ui",
        block: {
          proposal: {
            summary: "A skill for the job you just showed me (mock).",
            skills: [
              {
                name: "Order more coffee beans",
                description: "Reorder the usual beans when we're running low (mock).",
                instructions: "1. Open the supplier's site and find the usual beans.\n2. Pick the 5 lb bag.\n3. Add it to the cart and stop at checkout for your OK (mock).",
              },
            ],
            assumptions: ["I assumed you always want the 5 lb bag (mock).", "I assumed you stop at checkout and pay yourself (mock)."],
          },
        },
      },
      { kind: "text", text: "Check my guesses before you save it (mock)." },
    ],
  },
  {
    match: /\b(show you how|watch me)\b/i,
    steps: [
      { kind: "text", text: "I've opened the page where it starts (mock)." },
      { kind: "ui", block: { hand_browser: { reason: "Reorder the usual coffee beans (mock).", site: "Example", watch: true } } },
    ],
  },
  {
    // A job that runs for over a minute with nothing new after it starts, so a call following it
    // asks whether to hang on or leave a voice note when it's done.
    match: /\b(takes a few minutes|very slow job)\b/i,
    steps: [
      { kind: "note", text: "I'll go through the whole quarter, one vendor at a time (mock).", ms: 600 },
      { kind: "activity", id: "slow", running: "Going through every vendor", done: "Went through 42 vendors", ms: 70_000, app: "code", action: "run" },
      { kind: "text", text: "Done (mock). All 42 vendors are paid up except Casting Co, who's owed $1,240." },
    ],
  },
  {
    // Numbered citations: two verified quotes, one link-only, and one link no tool returned.
    match: /\b(cite|citations|sources)\b/i,
    steps: [
      { kind: "note", text: "Let me look up reviews and open roles (mock)." },
      {
        kind: "activity",
        id: "web",
        running: "Searching the web",
        done: "Searched the web",
        ms: 900,
        app: "web",
        action: "search",
        preview: {
          type: "sources",
          items: [
            { title: "Acme Atelier reviews", url: CITE_PAGE, domain: "reviews.example" },
            { title: "Careers at Acme Atelier", url: CITE_JOBS, domain: "acme-atelier.example" },
          ],
        },
      },
      {
        kind: "evidence",
        items: [
          { url: CITE_PAGE, app: "web", title: "Acme Atelier reviews", text: "Acme Atelier is rated 4.5 out of 5 from 9 reviews. 88% would recommend to a friend. Work/Life Balance 3.4" },
          { url: CITE_JOBS, app: "web", title: "Careers at Acme Atelier", text: "We're hiring for 40 open roles in New York and London." },
        ],
      },
      {
        kind: "citations",
        citations: {
          sources: [
            { n: 1, url: CITE_JOBS, quote: "40 open roles in New York and London" },
            { n: 2, url: CITE_PAGE, quote: "rated 4.5 out of 5 from 9 reviews. 88% would recommend to a friend" },
            { n: 3, url: CITE_PAGE, quote: "long hours and a fast pace" },
            { n: 4, url: "https://never-read.example/post", quote: "made up" },
          ],
        },
      },
      {
        kind: "text",
        text: "This is a mock answer with citations. Acme Atelier lists about 40 open roles, mostly in New York and London [1]. Reviewers rate it 4.5/5 from 9 reviews, and 88% would recommend it [2]. Recurring complaints mention long hours [3] and pay [4].",
      },
    ],
  },
  {
    // The built-in "Investigate" skill. Its instructions mention email, so this goes first.
    match: /Investigate what the user asks/,
    steps: [
      { kind: "note", text: "I'll check sales, payments, inventory, and email around that date." },
      {
        kind: "activity",
        id: "orders",
        running: "Reading orders in Shopify",
        done: "Read orders in Shopify",
        ms: 900,
        app: "shopify",
        action: "read",
        preview: {
          type: "items",
          items: [
            { primary: "Huggie hoops, gold: out of stock", secondary: "Since Oct 5", url: "https://shop.example/products/huggie-gold" },
            { primary: "Order #1042 refunded", secondary: "$212", url: "https://shop.example/orders/1042" },
          ],
        },
      },
      {
        kind: "activity",
        id: "mail",
        running: "Searching Gmail",
        done: "Searched Gmail",
        ms: 800,
        app: "gmail",
        action: "search",
        preview: { type: "items", items: [{ primary: "Clasp shipment delayed a week", secondary: "Casting Co", url: "https://mail.example/thread/88" }] },
      },
      {
        kind: "timeline",
        timeline: {
          question: "Why sales dipped on Tue Oct 6 (mock)",
          entries: [
            { when: "2026-10-05", what: "Huggie hoops (gold), the top seller, went out of stock", app: "shopify", url: "https://shop.example/products/huggie-gold" },
            { when: "2026-10-04", what: "Casting Co said the clasp shipment is a week late", app: "gmail", url: "https://mail.example/thread/88" },
            { when: "2026-10-06", what: "Order #1042 was refunded ($212)", app: "shopify", url: "https://shop.example/orders/1042" },
            { when: "2026-10-06", what: "Weekend email campaign ended", app: "klaviyo", url: "https://mail.example/campaign/not-read-this-run" },
          ],
          causes: [
            { text: "The best-selling huggies were out of stock after the clasp delay.", entries: [0, 1] },
            { text: "A $212 refund landed the same day.", entries: [2] },
          ],
        },
      },
      {
        kind: "visual",
        visual: {
          kind: "stats",
          title: "Tue Oct 6 vs a usual Tuesday (mock)",
          app: "shopify",
          items: [
            { label: "Revenue", value: "$1,840", change: "-38% vs avg", tone: "bad" },
            { label: "Orders", value: "23", change: "-31% vs avg", tone: "bad" },
            { label: "Refunds", value: "$212", change: "1 order", tone: "neutral" },
            { label: "Top seller in stock", value: "No", change: "Since Oct 5", tone: "bad" },
          ],
        },
      },
      {
        kind: "visual",
        visual: {
          kind: "chart",
          title: "Daily revenue, Sep 30 - Oct 8 (mock)",
          app: "shopify",
          chart: "bar",
          unit: "$",
          labels: ["Sep 30", "Oct 1", "Oct 2", "Oct 3", "Oct 4", "Oct 5", "Oct 6", "Oct 7", "Oct 8"],
          series: [
            { name: "This week", values: [2980, 3120, 2870, 3310, 3050, 2210, 1840, 1990, 2060] },
            { name: "Huggies (gold)", values: [910, 980, 870, 1020, 940, 120, 0, 0, 0] },
          ],
        },
      },
      {
        kind: "visual",
        visual: {
          kind: "table",
          title: "What changed around Oct 5 (mock)",
          columns: ["Date", "App", "What"],
          rows: [
            ["Oct 4", "Gmail", "Clasp shipment a week late"],
            ["Oct 5", "Shopify", "Gold huggies out of stock"],
            ["Oct 6", "Shopify", "Order #1042 refunded ($212)"],
          ],
        },
      },
      {
        kind: "text",
        text: "This is a mock investigation. Most likely, the gold huggies (your top seller) were out of stock from Oct 5 because the clasp shipment slipped, and a $212 refund landed the same day. I couldn't check ad spend; no ads app is connected.",
      },
    ],
  },
  {
    // "Say hello": the agent introduces itself and suggests a name; nothing changes until the
    // member keeps one.
    match: /^Introduce yourself to /m,
    steps: [
      {
        kind: "text",
        text: "Hi Sam (mock). We've been working through your search together, a short list at a time. I'd like to go by Juniper, if that suits you.",
      },
      {
        kind: "ui",
        block: {
          proposal: {
            summary: "How I'd like you to know me (mock).",
            identity: { name: "Juniper", manner: "I keep it short and lead with what I found. I tell you plainly when something misses your bar." },
          },
        },
      },
    ],
  },
  {
    // Results to keep or pass on, the way a trial run or a task run asks for a verdict.
    match: /\b(trial run|keep or pass|judge (these|them))\b/i,
    steps: [
      { kind: "text", text: "Here's a trial run (mock): four made-up results. Keep the ones you'd want, pass on the rest." },
      {
        kind: "visual",
        visual: {
          kind: "table",
          title: "The four side by side (mock)",
          columns: ["Role", "Where", "Pay", "Team"],
          rows: [
            ["Senior Product Designer · Example Co", "Remote US", "$185k", "Design systems"],
            ["Product Designer II · Sample Labs", "Hybrid, NYC", "$140k", "Not listed"],
            ["Staff Designer · Placeholder Inc", "Remote US", "$210k", "B2B analytics"],
            ["Design Lead · Demo Systems", "On-site, Austin", "Not listed", "Manages 4"],
          ],
        },
      },
      {
        kind: "ui",
        block: {
          form: {
            title: "Trial run (mock)",
            submit_label: "Send verdicts",
            fields: [
              {
                kind: "verdict",
                id: "roles",
                label: "Would you go for these?",
                required: true,
                reasons: ["Too junior", "Not remote", "Pay too low", "Wrong industry"],
                items: [
                  { title: "Senior Product Designer · Example Co (mock)", body: "Remote US, $185k. Design systems team.", link: "https://example.com/jobs/1" },
                  { title: "Product Designer II · Sample Labs (mock)", body: "Hybrid, NYC. $140k." },
                  { title: "Staff Designer · Placeholder Inc (mock)", body: "Remote US, $210k. B2B analytics." },
                  { title: "Design Lead · Demo Systems (mock)", body: "On-site, Austin. Manages 4." },
                ],
              },
            ],
          },
        },
      },
    ],
  },
  {
    // A proposed setup with ways it could sound, side by side; the member picks one or none.
    match: /\bhow (?:you'?ll|you would|you'd) sound\b/i,
    steps: [
      { kind: "text", text: "Here's how I'd work for you, and three ways I could sound on calls (mock)." },
      {
        kind: "ui",
        block: {
          proposal: {
            summary: "I'll bring you a short list each morning and check in before anything goes out (mock).",
            instructions: "Lead with the best two or three results. Ask before sending anything.",
            sound: [
              { voice: "steady", manner: "I keep it brief and even. I give you the result first, then the why (mock)." },
              { voice: "warm", manner: "I take it slowly and check how it lands. I say plainly when something misses (mock)." },
              { voice: "bright", manner: "I keep the pace up and get to the point. I flag what needs you right away (mock)." },
            ],
          },
        },
      },
    ],
  },
  {
    // A proposed setup; nothing changes until the member applies it.
    match: /\bpropose\b/i,
    steps: [
      { kind: "text", text: "Here's how I'd work for you (mock)." },
      {
        kind: "ui",
        block: {
          proposal: {
            summary: "I'll look for remote product roles every weekday morning, keep your tracker current, and prep you before interviews (mock).",
            profile: "Job search for remote senior product manager roles, $180k floor, no ad-tech.",
            instructions: "Shortlist at most five roles a day. Draft outreach but never send without approval.",
            skills: ["find-roles", "interview-prep"],
            tasks: [
              { template_task_id: "find-new-roles", title: "Find new roles", instructions: "Look for new remote PM roles that match.", skill: "find-roles", schedule: { every: "weekdays", at: "08:00" } },
              { title: "Weekly review", instructions: "Summarize the week's pipeline.", schedule: { every: "week", at: "09:00", weekday: 1 } },
            ],
            memories: ["Prefers remote roles.", "Won't work in ad-tech."],
          },
        },
      },
    ],
  },
  {
    // Asks before going on; the member's pick arrives as their next message.
    match: /\bask me\b/i,
    steps: [
      { kind: "text", text: "A couple of quick questions first (mock)." },
      {
        kind: "questions",
        questions: [
          {
            question: "Which customers should this go to?",
            header: "Audience",
            options: [
              { label: "Everyone", description: "All 1,240 subscribers" },
              { label: "Repeat buyers", description: "Ordered at least twice" },
              { label: "Lapsed customers", description: "No order in 6 months" },
            ],
          },
          {
            question: "What should it cover?",
            header: "Topics",
            multi_select: true,
            options: [{ label: "New arrivals" }, { label: "Restocks" }, { label: "A discount code" }],
          },
        ],
      },
    ],
  },
  {
    // The agent's opening line, its plan, then that line released into its reply, the way the
    // Langflow adapter sends it: a call says the line once.
    match: /\bnetwork(ing)?\b/i,
    steps: [
      { kind: "note", text: "Let me start a checklist for us (mock). What's been the hardest part of your search lately?" },
      { kind: "activity", id: "plan", running: "Updating the plan", done: "Updated the plan", ms: 700, app: "tracker", action: "write" },
      { kind: "plan", plan: [{ text: "What you're after (mock)", status: "doing" }, { text: "Your network (mock)", status: "todo" }] },
      { kind: "released", text: "Let me start a checklist for us (mock). What's been the hardest part of your search lately?" },
      { kind: "text", text: "Got it (mock): you want to meet people at companies that are hiring. Which is harder right now, finding the roles or reaching the people?" },
    ],
  },
  {
    match: /\b(send|email|reply)\b/i,
    steps: [
      {
        kind: "activity",
        id: "thread",
        running: "Finding the vendor thread in Gmail",
        done: "Found the vendor thread in Gmail",
        ms: 900,
        app: "gmail",
        action: "search",
        preview: { type: "items", items: [{ primary: "Invoice #4471", secondary: "Casting Co" }] },
      },
      { kind: "activity", id: "draft", running: "Writing the reply", done: "Wrote the reply", ms: 900, app: "agent", action: "other" },
      {
        kind: "approval",
        summary: "Send a reply to Casting Co asking them to refund the duplicate $1,240 payment",
        app: "gmail",
        details: [
          ["To", "billing@casting.example"],
          ["Subject", "Re: Invoice #4471"],
          ["Body", "Hi, it looks like invoice #4471 was paid twice. Could you refund the second $1,240 payment? Thanks!"],
        ],
        // A reply to one person: it may be approved by voice on a call (the summary's talk of a
        // refund doesn't make it a payment; what it runs does).
        actions: [
          {
            tool: "GMAIL_REPLY_TO_THREAD",
            arguments: {
              thread_id: "mock-thread-4471",
              recipient_email: "billing@casting.example",
              message_body: "Hi, it looks like invoice #4471 was paid twice. Could you refund the second $1,240 payment? Thanks!",
            },
          },
        ],
      },
    ],
  },
  {
    // A payment: always a tap, on a call too.
    match: /\bpay (?:the )?(?:casting|invoice)\b/i,
    steps: [
      { kind: "activity", id: "invoice", running: "Finding the invoice in QuickBooks", done: "Found the invoice in QuickBooks", ms: 800, app: "quickbooks", action: "search" },
      {
        kind: "approval",
        summary: "Pay Casting Co's invoice #4471 ($1,240) from the business account",
        app: "quickbooks",
        details: [
          ["Vendor", "Casting Co"],
          ["Amount", "$1,240.00"],
        ],
        actions: [{ tool: "QUICKBOOKS_CREATE_BILL_PAYMENT", arguments: { vendor: "Casting Co", amount: 1240, bill_id: "mock-4471" } }],
        after: "payment",
      },
    ],
  },
  {
    // Sorting the inbox with labels: a change a member may OK for good on a task.
    match: /\blabel (?:my )?(?:inbox|mail|email)\b/i,
    steps: [
      { kind: "activity", id: "inbox", running: "Reading new mail in Gmail", done: "Read new mail in Gmail", ms: 600, app: "gmail", action: "read" },
      {
        kind: "approval",
        summary: "Label 3 new threads Priority in Gmail (demo)",
        app: "gmail",
        details: [["Label", "Priority"]],
        actions: [{ tool: "GMAIL_BATCH_MODIFY_MESSAGES", arguments: { messageIds: ["mock-1", "mock-2", "mock-3"], addLabelIds: ["Label_mock"] } }],
        after: "labels",
      },
    ],
  },
  {
    // A task's run that turns up nothing: reported quietly, so no notification.
    match: /nothing new/i,
    steps: [
      { kind: "activity", id: "check", running: "Checking for replies", done: "Checked for replies", ms: 500, app: "gmail", action: "read" },
      { kind: "report", report: { outcome: "nothing_new", summary: "No new replies (demo)" } },
      { kind: "text", text: "Demo run: nothing new since last time." },
    ],
  },
  {
    // A task's run (or "track" in chat): say what done looks like and plan the work, search,
    // update the plan, then add rows to the tracker.
    match: /\b(track|roles?)\b/i,
    steps: [
      { kind: "note", text: "Done means two roles worth your time in your tracker, with outreach drafted (demo)." },
      {
        kind: "plan",
        goal: "two roles worth your time in your tracker, with outreach drafted (demo)",
        plan: [
          { text: "Search for matching roles", status: "doing" },
          { text: "Shortlist the best fits", status: "todo" },
          { text: "Draft outreach for the top 2", status: "todo" },
        ],
      },
      ...[
        ["search", "jobs.example", "boards.example"],
        ["search-2", "jobs.example", "careers.example"],
        ["search-3", "boards.example", "news.example"],
      ].map(([id, ...domains]) => ({
        kind: "activity" as const,
        id,
        running: "Searching job boards",
        done: "Searched job boards",
        ms: 500,
        app: "web",
        action: "search" as const,
        preview: {
          type: "sources" as const,
          items: domains.map((domain, i) => ({ title: `Product roles (demo ${i + 1})`, url: `https://${domain}/${id}`, domain })),
          total: 10,
        },
      })),
      {
        kind: "plan",
        plan: [
          { text: "Search for matching roles", status: "done" },
          { text: "Shortlist the best fits", status: "doing" },
          { text: "Draft outreach for the top 2", status: "todo" },
        ],
      },
      { kind: "record", record: { collection: "applications", key: "https://jobs.example/acme-pm", title: "Senior PM — Acme (demo)", status: "discovered", url: "https://jobs.example/acme-pm", fields: { score: 4 } } },
      { kind: "record", record: { collection: "applications", key: "https://jobs.example/globex-pm", title: "Product Lead — Globex (demo)", status: "discovered", url: "https://jobs.example/globex-pm", fields: { score: 3 } } },
      { kind: "report", report: { outcome: "update", summary: "2 new roles added to your tracker (demo)" } },
      { kind: "text", text: "Demo run: I found two roles and added them to your tracker. The plan is updated." },
    ],
  },
  {
    match: /\bremember\b/i,
    steps: [
      { kind: "remember", content: "Casting Co invoices are due net 30." },
      {
        kind: "text",
        text: "Got it. I'll remember that for next time.",
      },
    ],
  },
  {
    match: /simulate (a )?failure/i,
    steps: [
      { kind: "activity", id: "connect", running: "Connecting to Shopify", done: "Connected to Shopify", ms: 700, app: "shopify" },
      {
        kind: "activity",
        id: "orders",
        running: "Retrieving recent orders",
        done: "Retrieved recent orders",
        ms: 1600,
        app: "shopify",
        fail: "Shopify didn't respond within 30 seconds",
      },
      { kind: "error", message: "The agent couldn't finish: Shopify timed out. Nothing was changed." },
    ],
  },
  {
    match: /inventory|stock/i,
    steps: [
      {
        kind: "activity",
        id: "catalog",
        running: "Checking Shopify products",
        done: "Checked 148 Shopify products",
        ms: 1100,
        app: "shopify",
        action: "read",
        preview: {
          type: "items",
          items: [
            { primary: "Pavé Huggie Hoops", secondary: "12 variants" },
            { primary: "Solitaire Pendant", secondary: "8 variants" },
            { primary: "Signet Ring", secondary: "14 variants" },
          ],
          total: 148,
        },
      },
      {
        kind: "activity",
        id: "variants",
        running: "Totaling stock by variant",
        done: "Totaled stock for 629 variants",
        ms: 1400,
        app: "code",
        action: "run",
        preview: { type: "code", language: "python", code: "low = [v for v in variants if v.on_hand / max(v.weekly_sales, 1) < 2]\nprint(len(low))", output: "3" },
      },
      { kind: "activity", id: "velocity", running: "Checking 90-day sales in Shopify", done: "Checked 90-day sales in Shopify", ms: 1200, app: "shopify", action: "read" },
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
      { kind: "activity", id: "gather", running: "Checking Shopify orders", done: "Checked 1,284 Shopify orders", ms: 1200, app: "shopify", action: "read" },
      { kind: "activity", id: "create", running: "Creating a spreadsheet", done: "Created a spreadsheet", ms: 1500, app: "sheets", action: "write" },
      {
        kind: "activity",
        id: "write",
        running: "Updating Google Sheets",
        done: "Updated Google Sheets",
        ms: 1100,
        app: "sheets",
        action: "write",
        preview: {
          type: "table",
          title: "Summary",
          columns: ["Month", "Orders", "Revenue"],
          rows: [
            ["Jan", "96", "$41,220"],
            ["Feb", "88", "$38,410"],
            ["Mar", "121", "$52,900"],
          ],
        },
      },
      { kind: "activity", id: "verify", running: "Checking totals against Shopify", done: "Totals match Shopify", ms: 800, app: "code", action: "run" },
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
      { kind: "note", text: "Let me see what other fine-jewelry brands charge for huggies.", ms: 900 },
      {
        kind: "activity",
        id: "search",
        running: "Searching the web for “fine gold huggies pricing”",
        done: "Searched the web for “fine gold huggies pricing”",
        ms: 1300,
        app: "web",
        action: "search",
        preview: {
          type: "sources",
          items: [
            { title: "Brand A · Huggies", url: "https://example.com/brand-a", domain: "example.com" },
            { title: "Brand B · Diamond huggies", url: "https://example.com/brand-b", domain: "example.com" },
            { title: "Brand C · Shipping & returns", url: "https://example.com/brand-c", domain: "example.com" },
          ],
          total: 9,
        },
      },
      { kind: "activity", id: "memory", running: "Checking what I know about huggie pricing", done: "Checked what I know about huggie pricing", ms: 700, app: "memory", action: "remember", preview: { type: "text", text: "Entry huggies retail at $320; diamond huggies at $880." } },
      { kind: "activity", id: "compare", running: "Comparing pricing", done: "Compared pricing", ms: 900, app: "code", action: "run" },
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
      { kind: "note", text: "I'll go through last quarter's vendor emails and match them to payments.", ms: 900 },
      {
        kind: "activity",
        id: "s1",
        running: "Searching Gmail",
        done: "Searched Gmail",
        ms: 1800,
        app: "gmail",
        action: "search",
        preview: {
          type: "items",
          items: [
            { primary: "Invoice #4471", secondary: "Casting Co" },
            { primary: "March setting work", secondary: "Stone Setter" },
            { primary: "Packaging order confirmation", secondary: "Box Supply" },
          ],
          total: 212,
        },
      },
      { kind: "activity", id: "s2", running: "Pulling the invoices out of those emails", done: "Pulled out 64 invoices", ms: 2600, app: "code", action: "run" },
      { kind: "activity", id: "s3", running: "Checking QuickBooks payments", done: "Checked QuickBooks payments", ms: 2400, app: "quickbooks", action: "read" },
      { kind: "activity", id: "s4", running: "Matching invoices to payments", done: "Matched 61 of 64 invoices", ms: 2000, app: "code", action: "run" },
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
- *Email Casting Co about the duplicate payment* — an action that waits for your approval
- *Pay the Casting Co invoice* — a payment, which always waits for a tap
- *Remember that Casting Co invoices are net 30* — a memory to confirm
- *Simulate a failure* — error handling and retry

You can also attach a file with the paperclip.`,
  },
];

const AFTER_APPROVAL: Step[] = [
  { kind: "activity", id: "send", running: "Sending the reply in Gmail", done: "Sent the reply in Gmail", ms: 900, app: "gmail", action: "write" },
  { kind: "text", text: "Sent (mock — nothing actually left your account). I'll watch for Casting Co's answer." },
];

const AFTER_LABELS: Step[] = [
  { kind: "activity", id: "label", running: "Labeling threads in Gmail", done: "Labeled 3 threads in Gmail", ms: 700, app: "gmail", action: "write" },
  { kind: "text", text: "Labeled 3 threads Priority (mock — nothing changed in your inbox)." },
];

const AFTER_PAYMENT: Step[] = [
  { kind: "activity", id: "pay", running: "Paying the invoice in QuickBooks", done: "Paid the invoice in QuickBooks", ms: 900, app: "quickbooks", action: "write" },
  { kind: "text", text: "Paid (mock — no money moved). Casting Co's invoice #4471 is settled." },
];

const AFTER_DECLINE: Step[] = [{ kind: "text", text: "Okay, I didn't send anything. Want me to change the wording instead?" }];

const ATTACHMENTS_ONLY: Step[] = [
  { kind: "text", text: "This is a **mock response**: I listed the files you attached, but the real agent isn't connected to read them." },
];

/** A labeled step listing the attached files, with the first lines of text files. */
async function readAttachments(input: AgentRunInput): Promise<Step[]> {
  const items = await Promise.all(
    input.attachments.map(async (file) => {
      const textual = /^text\/|json|xml|yaml/.test(file.mimeType);
      const firstLine = textual ? (await (await file.read()).text()).split("\n")[0].slice(0, 120) : undefined;
      return { primary: file.name, secondary: firstLine ?? `${Math.max(1, Math.round(file.size / 1024))} KB` };
    }),
  );
  return [
    {
      kind: "activity",
      id: "files",
      running: `Opening ${input.attachments.length === 1 ? "your file" : `${input.attachments.length} files`}`,
      done: `Opened ${input.attachments.length === 1 ? "your file" : `${input.attachments.length} files`}`,
      ms: 700,
      app: "agent",
      action: "read",
      preview: { type: "items", items },
    },
  ];
}

/**
 * The "Tidy up" skill: merges the first few facts it lists in each scope (shared, then the
 * member's own), using the ids and text the skill sent. Null for any other message.
 */
function tidySteps(message: string): Step[] | null {
  if (!message.includes("Tidy up what this agent remembers in one topic")) return null;
  const facts = [...message.matchAll(/^- \[((workspace|personal|legacy):[A-Za-z0-9_-]+)\](?: \(pinned\))? (.+)$/gm)].map((m) => ({
    id: m[1],
    shared: m[2] === "workspace",
    text: m[3].replace(/\.$/, ""),
  }));
  const merges = [true, false].flatMap((shared) => {
    const group = facts.filter((f) => f.shared === shared).slice(0, 3);
    return group.length >= 2 ? [{ replaces: group.map((f) => f.id), text: `${group.map((f) => f.text).join("; ")}.`.slice(0, 500) }] : [];
  });
  if (merges.length === 0) return [{ kind: "text", text: "This topic is already tidy (mock)." }];
  const count = merges.reduce((n, m) => n + m.replaces.length, 0);
  return [
    { kind: "text", text: `${count} facts could be ${merges.length} (mock).` },
    { kind: "ui", block: { memory_merge: { summary: `${count} overlapping facts become ${merges.length} (mock).`, merges } } },
  ];
}

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
      approvals: true,
      attachments: true,
      rewind: false,
    },
    async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
      const { signal } = input;
      yield { type: "thread", threadId: input.threadId ?? `mock-${input.tenant.workspaceId}.${input.conversationId}` };
      await wait(350 * pace, signal);

      let steps: Step[];
      if (input.resume) {
        const after = (input.resume.state as { after?: string } | null)?.after;
        steps = input.resume.decision !== "approve" ? AFTER_DECLINE : after === "payment" ? AFTER_PAYMENT : after === "labels" ? AFTER_LABELS : AFTER_APPROVAL;
      } else {
        steps = tidySteps(input.message) ?? SCENARIOS.find((s) => s.match.test(input.message))?.steps ?? FALLBACK;
        if (input.attachments.length > 0) steps = [...(await readAttachments(input)), ...(steps === FALLBACK ? ATTACHMENTS_ONLY : steps)];
      }
      const streaming = options.streaming && !/non-?streaming/i.test(input.message);

      for (const step of steps) {
        if (step.kind === "activity") {
          const base = { type: "activity", id: step.id, app: step.app ?? "agent", action: step.action } as const;
          yield { ...base, label: step.running, status: "running" };
          await wait(step.ms * pace, signal);
          if (step.fail) {
            yield { ...base, label: step.running, status: "failed", detail: step.fail };
          } else {
            yield { ...base, label: step.done, status: "done", detail: step.detail, preview: step.preview };
          }
        } else if (step.kind === "note") {
          await wait((step.ms ?? 600) * pace, signal);
          yield { type: "note", text: step.text };
        } else if (step.kind === "released") {
          yield { type: "note-reply", text: step.text };
          yield { type: "text-delta", text: `${step.text}\n\n` };
        } else if (step.kind === "artifact") {
          yield { type: "artifact", artifact: step.artifact };
        } else if (step.kind === "error") {
          throw new AgentError(step.message);
        } else if (step.kind === "approval") {
          yield {
            type: "approval",
            summary: step.summary,
            app: step.app,
            details: step.details,
            ...(step.actions ? { actions: step.actions } : {}),
            state: { mock: true, ...(step.after ? { after: step.after } : {}) },
          };
          return;
        } else if (step.kind === "timeline") {
          await wait(500 * pace, signal);
          yield { type: "timeline", timeline: step.timeline };
        } else if (step.kind === "evidence") {
          yield { type: "evidence", items: step.items };
        } else if (step.kind === "citations") {
          yield { type: "citations", citations: step.citations };
        } else if (step.kind === "visual") {
          await wait(400 * pace, signal);
          yield { type: "visual", visual: step.visual };
        } else if (step.kind === "questions") {
          await wait(400 * pace, signal);
          yield { type: "questions", questions: step.questions };
        } else if (step.kind === "ui") {
          await wait(400 * pace, signal);
          yield { type: "ui", block: step.block };
        } else if (step.kind === "plan") {
          yield { type: "plan-update", plan: step.plan, ...(step.goal ? { goal: step.goal } : {}) };
        } else if (step.kind === "record") {
          yield { type: "record", record: step.record };
        } else if (step.kind === "report") {
          yield { type: "run-report", report: step.report };
        } else if (step.kind === "keep-going") {
          yield { type: "keep-going", remaining: step.remaining };
        } else if (step.kind === "remember") {
          yield { type: "memory-proposal", content: step.content, scope: "workspace", category: "suppliers" };
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
