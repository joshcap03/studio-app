// Apps the agent can work in, as shown to the business owner. Shared by the server (tool
// interpretation) and the browser (glyphs). Unknown apps fall back to a generic entry.

export const APPS = {
  gmail: "Gmail",
  outlook: "Outlook",
  sheets: "Google Sheets",
  docs: "Google Docs",
  drive: "Google Drive",
  calendar: "Google Calendar",
  shopify: "Shopify",
  slack: "Slack",
  notion: "Notion",
  airtable: "Airtable",
  hubspot: "HubSpot",
  quickbooks: "QuickBooks",
  stripe: "Stripe",
  instagram: "Instagram",
  web: "Web",
  browser: "Browser",
  memory: "Memory",
  code: "Analysis",
  calculator: "Calculator",
  agent: "Agent",
} as const;

export type AppId = keyof typeof APPS | (string & {});

export function appName(id: AppId | undefined): string {
  if (!id) return APPS.agent;
  return (APPS as Record<string, string>)[id] ?? titleCase(id);
}

/** Composio toolkit slug prefix → app. */
const COMPOSIO_TOOLKITS: Record<string, AppId> = {
  GMAIL: "gmail",
  OUTLOOK: "outlook",
  GOOGLESHEETS: "sheets",
  GOOGLEDOCS: "docs",
  GOOGLEDRIVE: "drive",
  GOOGLECALENDAR: "calendar",
  SHOPIFY: "shopify",
  SLACK: "slack",
  NOTION: "notion",
  AIRTABLE: "airtable",
  HUBSPOT: "hubspot",
  QUICKBOOKS: "quickbooks",
  STRIPE: "stripe",
  INSTAGRAM: "instagram",
  BROWSERBASE: "browser",
  BROWSERBASE_TOOL: "browser",
  EXA: "web",
};

/** True when the name starts with a known Composio toolkit prefix (any case). */
export function isKnownToolkit(slugOrToolkit: string): boolean {
  const upper = slugOrToolkit.toUpperCase();
  return Object.keys(COMPOSIO_TOOLKITS).some((prefix) => upper.startsWith(`${prefix}_`));
}

/** Maps a Composio toolkit name or tool slug (e.g. "GMAIL_FETCH_EMAILS", "gmail") to an app. */
export function appForToolkit(slugOrToolkit: string): AppId {
  const upper = slugOrToolkit.toUpperCase();
  const match = Object.keys(COMPOSIO_TOOLKITS)
    .sort((a, b) => b.length - a.length)
    .find((prefix) => upper === prefix || upper.startsWith(`${prefix}_`));
  if (match) return COMPOSIO_TOOLKITS[match];
  return upper.split("_")[0].toLowerCase();
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
