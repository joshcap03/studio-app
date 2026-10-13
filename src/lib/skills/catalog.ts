import type { AppId } from "@/lib/apps";

// The library of ready-made skills a workspace can add. Adding one copies it into the
// workspace (see src/lib/skills/index.ts), where the owner can adapt it; the agent only ever
// sees the workspace's copy, and only on a message it's attached to. Entries stay generic:
// business specifics come from each workspace's own settings and memory, never from here.
// Anything that would contact a customer or move money produces drafts, not sends.

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  category: CatalogCategory;
  /** Apps the skill works in, for display. */
  apps: AppId[];
  instructions: string;
}

export const CATALOG_CATEGORIES = ["Customers", "Sales", "Inventory", "Finance", "Operations", "Marketing"] as const;
export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

export const CATALOG: CatalogEntry[] = [
  {
    id: "weekly-sales-report",
    name: "Weekly sales report",
    description: "Orders, revenue, and top products for a week, in a spreadsheet.",
    category: "Sales",
    apps: ["shopify", "sheets"],
    instructions: `Build a sales report for the period the user names (last week if they don't say).
1. Pull all orders for the period from the store.
2. Compute order count, revenue, average order value, refunds, and the top 10 products by revenue.
3. Compare each number with the period before and note changes over 10%.
4. Create a spreadsheet with a summary tab and an orders tab.
5. Reply with the three most important takeaways and a link to the sheet.`,
  },
  {
    id: "reorder-list",
    name: "Low-stock reorder list",
    description: "Finds items running low and suggests how many to reorder.",
    category: "Inventory",
    apps: ["shopify", "sheets"],
    instructions: `1. Get current stock and the last 60 days of sales for every active product.
2. Find items with less than 2 weeks of cover at the current sales rate.
3. For each, suggest a reorder quantity to reach 6 weeks of cover (or what the user asks for).
4. Put the list in a spreadsheet: product, SKU, on hand, weekly sales, weeks of cover, suggested quantity.
5. Reply with the most urgent items first. Do not place any orders.`,
  },
  {
    id: "inventory-health",
    name: "Inventory health check",
    description: "Flags low stock, oversold items, and slow movers.",
    category: "Inventory",
    apps: ["shopify"],
    instructions: `Review the store's products and inventory.
- Flag items at or below 2 weeks of cover, based on the last 30 days of sales.
- Flag items with zero or negative stock that are still published.
- List slow movers: no sales in 60 days.
- Give counts and dates, not adjectives. Lead with what needs action today.`,
  },
  {
    id: "customer-email-replies",
    name: "Reply to customer emails",
    description: "Drafts replies to unanswered customer emails, ready to review and send.",
    category: "Customers",
    apps: ["gmail", "outlook"],
    instructions: `Draft replies to customer emails (the ones the user points to, or unanswered ones from the last 2 days).
- Read each whole thread first, and check order history if the customer mentions an order.
- Match the tone in the business context; if none is given, be warm, brief, and specific.
- Answer the actual question in the first two sentences. Offer one clear next step.
- Never promise refunds, discounts, or dates the business hasn't confirmed; say a person will follow up.
- Save replies as drafts; do not send. Reply with a list of the drafts created.`,
  },
  {
    id: "new-customer-welcome",
    name: "Welcome new customers",
    description: "Drafts a personal thank-you to each first-time customer.",
    category: "Customers",
    apps: ["shopify", "gmail"],
    instructions: `1. Find customers whose first order was in the period the user names (the last 7 days if they don't say).
2. For each, note what they bought.
3. Draft a short, personal thank-you email mentioning their purchase. No discount codes unless the business context provides one.
4. Save as drafts; do not send.
5. Reply with how many drafts were created and who they're for.`,
  },
  {
    id: "overdue-invoices",
    name: "Chase overdue invoices",
    description: "Lists overdue invoices and drafts a polite reminder for each customer.",
    category: "Finance",
    apps: ["quickbooks", "stripe", "gmail"],
    instructions: `1. Find unpaid invoices overdue by at least 7 days (or what the user asks for).
2. Group them by customer, with invoice numbers, amounts, and due dates quoted exactly.
3. Draft one reminder per customer: friendly under 14 days overdue, firm after, and suggest a call after 30.
4. Never threaten fees or collections unless the business context says to. Save as drafts; do not send.
5. Reply with a table of customers, totals owed, and which drafts were created.`,
  },
  {
    id: "monthly-expenses",
    name: "Monthly expense summary",
    description: "Spending by category and vendor, with anything unusual flagged.",
    category: "Finance",
    apps: ["quickbooks", "sheets"],
    instructions: `1. Pull all expenses for the month the user names (last month if they don't say).
2. Total them by category and by vendor; compare with the month before.
3. Flag new vendors, duplicate-looking charges, and categories up more than 20%.
4. Put the breakdown in a spreadsheet.
5. Reply with the total, the top 3 categories, and anything flagged.`,
  },
  {
    id: "inbox-triage",
    name: "Inbox triage",
    description: "Sorts recent email into needs-reply, FYI, and noise, and drafts the easy replies.",
    category: "Operations",
    apps: ["gmail", "outlook"],
    instructions: `1. Read unread emails from the last 24 hours.
2. Sort them into: needs a reply, FYI, and noise (newsletters, notifications).
3. For each "needs a reply", write a one-line summary and draft a reply when the answer is clear.
4. Do not archive, delete, or send anything.
5. Reply with the needs-a-reply list first, noting which have drafts ready.`,
  },
  {
    id: "meeting-follow-up",
    name: "Meeting follow-up",
    description: "Turns a meeting's notes into action items and a recap email draft.",
    category: "Operations",
    apps: ["granola", "calendar", "gmail"],
    instructions: `1. Find the notes or transcript for the meeting the user names (their most recent one if they don't say), and its attendees.
2. Write a recap: decisions, then action items as "Owner — task — due date", then open questions. Write "unassigned" or "no date" rather than guessing.
3. Draft one email to the attendees with the recap. Do not send.
4. Reply with the recap and confirm the draft was created.`,
  },
  {
    id: "tidy-spreadsheet",
    name: "Tidy a spreadsheet",
    description: "Cleans up a messy sheet: headers, units, dates, totals.",
    category: "Operations",
    apps: ["sheets"],
    instructions: `Clean up the spreadsheet the user points to, in a new tab so nothing is lost.
- One header row, frozen. Column names include units (e.g. "Revenue (USD)").
- Dates as YYYY-MM-DD. Currency to 2 decimals. No merged cells. Remove empty rows and columns.
- Add a final "Total" row where totals make sense.
- Reply with what changed and anything that looked wrong in the data.`,
  },
  {
    id: "competitor-price-check",
    name: "Competitor price check",
    description: "Researches competitors' prices for a product and compares them with yours.",
    category: "Marketing",
    apps: ["web", "shopify", "sheets"],
    instructions: `1. Look up our current price for the product the user names.
2. Research comparable products from the competitors they name (or find 3–5 relevant ones).
3. Record each with product name, price, size or variant, shipping notes, and source link.
4. Put the comparison in a spreadsheet.
5. Reply with where we sit (below, in line, above) and notable positioning differences. Cite sources.`,
  },
  {
    id: "content-calendar",
    name: "Content calendar",
    description: "Plans a few weeks of social posts around products and dates that matter.",
    category: "Marketing",
    apps: ["instagram", "shopify", "sheets"],
    instructions: `1. Review recent posts and their engagement, and current best-selling products.
2. Plan 3 posts a week for the number of weeks the user asks for (4 if they don't say), around their focus if they give one, otherwise best sellers and upcoming holidays.
3. For each post: date, product, caption draft, and image idea.
4. Put the plan in a spreadsheet. Do not publish anything.
5. Reply with the plan's themes and a link to the sheet.`,
  },
  {
    id: "product-descriptions",
    name: "Write product descriptions",
    description: "Drafts product descriptions in the business's voice.",
    category: "Marketing",
    apps: ["shopify"],
    instructions: `Write descriptions for the products the user names (or products with missing or very short descriptions).
- Follow the voice in the business context. Lead with what the product is for, then materials, size, and care.
- Keep each under 120 words. Don't invent facts; ask about anything you can't find.
- Do not update the store. Reply with the drafts, one per product.`,
  },
  {
    id: "business-snapshot",
    name: "Business snapshot",
    description: "A one-page check-in: sales, cash, stock, and what needs attention.",
    category: "Sales",
    apps: ["shopify", "quickbooks", "gmail"],
    instructions: `Give a short snapshot of the business for the period the user names (the last 7 days if they don't say).
- Sales: orders and revenue vs the period before.
- Money: unpaid invoices and notable expenses, if accounting is connected.
- Stock: anything about to run out.
- Inbox: customer emails waiting on a reply.
Skip any section whose app isn't connected and say so. End with the 3 things worth doing next.`,
  },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}
