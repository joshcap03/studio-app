"""Load Skill: the agent's built-in procedures (data-tasks, workbooks), returned by name.

Shared by every workspace, so nothing here names a business; the business, its store, and
its sources come from the workspace context and memory. Source of truth:
langflow/components/load_skill.py in the Studio repo.
"""

from langflow.custom import Component
from langflow.io import MessageTextInput, Output
from langflow.schema import Data

# Raw URL of your sheet_helpers.py gist. Use the gist's "Raw" button so the URL
# includes the revision hash; that pins the exact code the agent runs.
HELPERS_URL = "https://gist.githubusercontent.com/jcapcodes/a16813fc535b47bf0b46cd88cbae070a/raw/a44ddc0d9c8320f3bbb2ce3d66b55d3e41a4ac67/sheet_helpers.py"

MEMORY_RULES = """## Memory

Save the method, never the results. Links, row counts, and dates go
stale and don't help the next run.

- Save only when you had to work out the method this run: probing a
  source, searching for tools, or finding a new endpoint. If a skill or
  memory already gave you the method, save nothing. A workbooks
  template run never saves.
- To save, use the remember tool (scope "workspace") with one line in this form:
  Method: <data> → <source and how to fetch it>. Limits: <what the source can't give>.
  Example: Method: product catalog → fetch_shopify_products("example-store.com")
  from the workbooks helpers (public Shopify feed). Limits: no stock counts or costs.
  The owner confirms it before it's kept.
- For other sources, include the endpoint or the Composio tool slugs
  that worked."""

DATA_TASKS = """# Data tasks

Use this for any task that pulls, exports, compares, or reorganizes
more than about 20 records: catalogs, inventory, orders, customers,
expenses, contact lists.

If the deliverable is a Google Sheet, use the workbooks skill instead.
It has a ready-made script. You only need section 1 here when the
source isn't a Shopify store.

The rule: the data moves through code, not through you. Every row you
read or write yourself costs tokens twice and can be mistranscribed.
Your job is to pick the source, write the script, and check the result.
You should only ever see a short summary, never the records.

## 1. Pick the source

If memory has a method for this source, use it and skip to step 4.
Otherwise use the first of these that works:

1. A connected app. A website is usually a view of a system the
   business has an account in. A store's catalog, stock counts, and
   costs live in its commerce platform, so check Composio for that
   platform before touching the site.
2. A structured feed from the site: JSON endpoints, product feeds,
   sitemaps. (Shopify stores serve /products.json, for example.)
   Public feeds usually carry the catalog and availability, not stock
   counts or costs. If the user needs those and no app is connected,
   say so.
3. Scraping pages with the browser. Last resort, and tell the user
   that's what you did.

If the request doesn't say which fields it wants, choose the obvious
set, proceed, and list the columns in your report.

## 2. Pick the code tool

- The job ends in a write to an app connected through Composio (a
  Google Sheet, Shopify, Gmail): do the whole job in
  COMPOSIO_REMOTE_WORKBENCH. Fetch, process, write, and check there,
  in code.
- No write to a connected app (calculations, parsing, transforms,
  public fetches, making a file): use the Python Interpreter tool.
  math, json, and requests are preloaded. Never write import lines;
  the tool rejects them.
- Do not use COMPOSIO_REMOTE_BASH_TOOL.

## 3. Probe before you loop

Fetch one record or one page. Look at the field names and how
pagination works. Then write the full job.

## 4. Run it as one script

Write one script that fetches every page, parses the records, and
writes the output in a single bulk operation (a file, or one batch
write to the sheet or table). Do not page results through the
conversation or write rows one call at a time. If the destination is
the database, match on existing IDs and update rather than duplicate.

In the workbench:

- Do the whole job in one workbench call: fetch, process, write, and
  check. Every extra call re-sends the whole conversation.
- Search for tool slugs only when neither memory nor a skill names
  them. Search once, for the one app you need, then confirm arguments
  with COMPOSIO_GET_TOOL_SCHEMAS. Never invent slugs or argument
  fields.
- Call app tools from the script with run_composio_tool(tool_slug,
  arguments). Use proxy_execute only when no Composio tool exists. Do
  not call COMPOSIO_* meta tools from inside the script.
- Composio already prints every tool response. Don't print responses
  yourself.
- Paginate until no next-page token or cursor remains.
- Split long jobs into cells that finish within the 180-second limit,
  and save checkpoints to /mnt/files/.
- For a file the user will download, use upload_local_file.

Never put credentials, tokens, or auth headers in a script or in the
conversation. Authenticated calls go only through Composio.

## 5. Check it

Print only counts and at most three sample rows. Compare rows written
to the source's total. Look for duplicate IDs and blank key columns.

## 6. Report

Give the row count, the link or file, the source you used, the
columns, and anything missing or uncertain.

## When it goes wrong

If the same approach fails twice, stop and report what blocked it.
If no code tool is available, say so instead of doing the job by hand.

""" + MEMORY_RULES

WORKBOOKS = """# Workbooks

Use this when the deliverable is a Google Sheet. It covers the whole
job, so you don't need data-tasks unless the source is unfamiliar.

The method is fixed. Do not search for tools, fetch tool schemas,
build an .xlsx, or use Google Drive. Do the whole job in ONE
COMPOSIO_REMOTE_WORKBENCH call using the template below.

## 1. Get the source

- A Shopify store (the business's own domain is in the workspace
  context or memory; ask if you don't have it): use
  fetch_shopify_products(domain) and product_row(p) from the helpers.
  This is the public feed, so it has availability but no stock counts
  or costs. If the user needs those, say so.
- Anything else: use the method in memory, or follow data-tasks
  section 1 to find the source. Then build rows here the same way.

## 2. Run this template in one workbench call

```python
import requests
src = requests.get("__HELPERS_URL__", timeout=30).text
assert "SHEET HELPERS v1" in src, "could not load sheet helpers"
exec(src)

# Edit from here down. Example: sold-out products from a Shopify store.
STORE_DOMAIN = "example-store.com"  # the business's own store
BUSINESS = "Business Name"          # from the workspace context
products = [product_row(p) for p in fetch_shopify_products(STORE_DOMAIN)]
picked = sorted((p for p in products if p["status"] == "Sold Out"),
                key=lambda p: (p["type"], p["title"]))

headers = ["Product", "Type", "Variants", "Price (Min)", "Price (Max)", "Status", "Tags", "Link"]
types = ["text", "text", "int", "currency", "currency", "text", "text", "url"]
rows = [[p["title"], p["type"], p["variants"], p["price_min"], p["price_max"],
         p["status"], p["tags"], p["url"]] for p in picked]

if rows:
    out = write_sheet(f"{BUSINESS} - Sold Out Products - {local_date()}", "Sold Out",
                      headers, rows, types, status_col="Status")
    print(f"OK source={len(products)} matched={len(rows)} written={out['rows']} url={out['url']}")
else:
    print(f"OK source={len(products)} matched=0, no sheet created")
```

Rules:

- Keep the first four lines exactly as written, at the top level of
  the script (not inside a function).
- Edit only the fetch, filter, sort, and columns. Don't call
  run_composio_tool or proxy_execute yourself, and don't add prints.
  The OK line is all you need.
- product_row fields: title, type, vendor, variants,
  variants_available, price_min, price_max, status ("In Stock" or
  "Sold Out"), tags, created (YYYY-MM-DD), url.
- types, one per column: text, int, number, currency, percent, date
  (a YYYY-MM-DD string), url (shows as a "View" link).
- status_col colors Sold Out red, In Stock green, Low Stock amber.
  For other values pass status_colors={"Value": ("#bg", "#text")}.
  Leave it out if there's no status column.
- Title: "<Business> - <What> - <YYYY-MM-DD>". Tab: a plain name.
- One tab per sheet. If the user wants totals or splits, put them in
  your reply.
- write_sheet handles the formatting (navy header, banded rows,
  frozen header, filters, number formats, column widths) and raises
  an error if the rows written don't match.

## 3. If it fails

Read the error, fix only the part you edited, and run once more. If
it fails again, stop and report the error. Don't fall back to writing
Sheets API calls by hand.

## 4. Report

Give the link, rows written vs. the source total, the columns, the
source, and anything missing (like stock counts).

""" + MEMORY_RULES

SKILLS = {
    "data-tasks": DATA_TASKS,
    "workbooks": WORKBOOKS.replace("__HELPERS_URL__", HELPERS_URL),
}


class LoadSkill(Component):
    display_name = "Load Skill"
    description = "Returns the full instructions for a named skill."
    icon = "book-open"
    name = "LoadSkill"

    inputs = [
        MessageTextInput(
            name="skill_name",
            display_name="Skill Name",
            info="Exact skill name from the skill list, e.g. data-tasks",
            tool_mode=True,
        ),
    ]

    outputs = [
        Output(display_name="Instructions", name="output", method="load_skill"),
    ]

    def load_skill(self) -> Data:
        name = self.skill_name.strip()
        body = SKILLS.get(name)
        if body is None:
            body = f"No skill named '{name}'. Available: {', '.join(SKILLS)}"
        elif name == "workbooks" and not HELPERS_URL.startswith("https://"):
            body = ("The workbooks skill isn't set up yet (HELPERS_URL is missing in the "
                    "Load Skill component). Tell the user and stop.")
        data = Data(value={"skill": name, "instructions": body})
        self.status = data
        return data
