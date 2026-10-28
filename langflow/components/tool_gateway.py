"""Dynamic Tool Gateway for Langflow: discover_tools, execute_tool, take_action, remember, ask_user, show_form, propose_agent, merge_memories, offer_call, request_secret, hand_browser, watch_me, save_file.

Connect existing executable Tool outputs to Tools and Gateway Tools to Agent.Tools.
No additional LLM router. Original tools remain connected behind the gateway.

Approvals: only what moves money or deletes for good (paying, buying, refunds, transfers, a
browser step that places an order, permanent deletes) must go through take_action, which carries
``approval_actions`` metadata so the Agent's human-in-the-loop middleware pauses the run
until the owner approves or declines it; the app approves a kind itself once they've OK'd it
(src/lib/approvals/standing.ts). execute_tool refuses those calls and runs everything else.
In a run an event started (run_cause "watch"), anything that changes their accounts still asks. Source of truth:
langflow/components/tool_gateway.py in the Studio repo.
"""

import asyncio
import difflib
import json
import re
import time
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool, StructuredTool
from pydantic import BaseModel, Field, ValidationError
from lfx.custom.custom_component.component import Component
from lfx.io import HandleInput, IntInput, MessageTextInput, Output


class DiscoverArgs(BaseModel):
    query: str = Field(description="Describe the action needed, e.g. 'read Gmail'.")


class ReadResultArgs(BaseModel):
    result_id: str = Field(description="The id a partial result gave, e.g. 'r1'.")
    offset: int = Field(default=0, description="Where to start reading, in characters; the partial result says where.")


class ExecuteArgs(BaseModel):
    tool_name: str = Field(description="Exact name from discover_tools.")
    arguments: dict | str | None = Field(default=None, description="Tool arguments, following the discovered schema.")


class ActionArgs(BaseModel):
    tool_name: str = Field(description="Exact name from discover_tools.")
    arguments: dict | str | None = Field(default=None, description="Tool arguments, following the discovered schema.")
    summary: str = Field(description="One plain-English sentence the owner reads before approving, e.g. 'Send the March invoice to jo@acme.com'.")


MEMORY_CATEGORIES = {"customers", "suppliers", "products", "policies", "voice", "team", "other"}


class MemoryArgs(BaseModel):
    content: str = Field(description="The fact to remember, as one short self-contained sentence.")
    scope: str = Field(default="workspace", description="'workspace' for facts about what this workspace is for (its work, people, and goals); 'personal' for this user's own preferences.")
    category: str = Field(default="other", description="What the fact is about: customers (people and contacts), suppliers (companies and organizations), products (work, offerings, and pricing), policies (rules and standing preferences), voice (tone and style), team, or other.")
    replaces: list[str] = Field(default_factory=list, description="Ids of facts you saved (listed in your context as [id]) that this one updates, corrects, or restates; this fact takes their place. Leave empty for a new fact.")


PLAN_STEP_SCHEMA = {
    "type": "object",
    "properties": {
        "text": {"type": "string", "description": ("The step, in a short plain sentence the owner would say: what "
                                                     "gets done for them ('Read the last 90 days of email'), never how. "
                                                     "No tools, apps' APIs, or cards ('Find Gmail read tools', 'Show "
                                                     "results in a verdict form'), and no step for getting your own "
                                                     "tools ready.")},
        "status": {"type": "string", "description": "todo, doing, done, blocked, or needs_you (waiting on the owner)."},
        "note": {"type": "string", "description": "Optional: what happened or what's blocking it, in one line."},
    },
    "required": ["text", "status"],
}


class PlanArgs(BaseModel):
    steps: list[dict] = Field(description=("The whole plan, in order, replacing the old one: each step an object "
                                           "with text, status (todo, doing, done, blocked, needs_you), and an optional note."),
                              json_schema_extra={"items": PLAN_STEP_SCHEMA})
    goal: str = Field(default="", description=("What done looks like, in one line the owner would agree with: the words you "
                                               "said after 'Done means', e.g. 'three caterers under $40 a head, with a quote "
                                               "request ready for you'. What they get, never the card or tool that shows it. Leave it empty to keep the current one for the same "
                                               "work (a task's stays until the owner asks to change it)."))


class RecordArgs(BaseModel):
    collection: str = Field(description="Which list it belongs to, a short lowercase name, e.g. applications, contacts, companies.")
    key: str = Field(description=("What makes it unique in that list, so saving it again updates it: e.g. the job "
                                  "posting's link, a person's profile link or email, a company's domain."))
    title: str = Field(default="", description="What the owner sees, e.g. 'Senior PM, Payments — Acme'.")
    status: str = Field(default="", description="Where it stands, one or two words, e.g. discovered, applied, replied.")
    url: str = Field(default="", description="Its http(s) link exactly as a tool returned it, if any.")
    fields: dict = Field(default_factory=dict, description="Any other details as short key-value pairs, e.g. {'score': 4, 'location': 'Remote'}.")


LIBRARY_KINDS = ("document", "spreadsheet", "presentation", "pdf", "image", "data", "file", "link")


class LibraryArgs(BaseModel):
    url: str = Field(description="Its https link exactly as the owner gave it or a tool returned it.")
    title: str = Field(description="What the owner sees in their Library, e.g. 'Q3 pricing plan'.")
    kind: str = Field(default="", description=("Optional: document, spreadsheet, presentation, pdf, image, data, file, or "
                                               "link. Left out, it's guessed from the link."))


class KeepGoingArgs(BaseModel):
    remaining: str = Field(description=("What's left of the job, in a line, so your next reply picks it up, e.g. "
                                        "'label the remaining 400 threads, then list what waits on a reply'."))


class RunReportArgs(BaseModel):
    outcome: str = Field(description=("nothing_new if this run found nothing worth the owner's attention, update if "
                                      "there's something for them to read, needs_you if they must decide or act."))
    summary: str = Field(default="", description="One short sentence for the notification, e.g. '3 new roles match; 1 recruiter replied'.")


# Nested argument shapes are plain JSON schema rather than nested models: LangChain rebuilds
# a tool's argument model where nested model names can't be resolved inside Langflow, and the
# agent then sees the tool with no arguments at all.
TIMELINE_ENTRY_SCHEMA = {
    "type": "object",
    "properties": {
        "when": {"type": "string", "description": "When it happened, from the record: ISO date or date-time, e.g. 2026-10-06."},
        "what": {"type": "string", "description": "What happened, in one plain sentence, e.g. 'Stripe refunded 4 orders ($612)'."},
        "app": {"type": "string", "description": "The app's toolkit slug in lower case, e.g. stripe, shopify, gmail, googlecalendar."},
        "url": {"type": "string", "description": "The record's https link exactly as a tool result returned it; empty if none."},
    },
    "required": ["when", "what"],
}
TIMELINE_CAUSE_SCHEMA = {
    "type": "object",
    "properties": {
        "text": {"type": "string", "description": "One likely cause, in a plain sentence."},
        "entries": {"type": "array", "items": {"type": "integer"}, "description": "Indexes into entries that support this cause."},
    },
    "required": ["text"],
}


class TimelineArgs(BaseModel):
    question: str = Field(description="What was investigated, e.g. 'Why revenue dipped on Tue Oct 6' or 'Trip plans for December'.")
    entries: list[dict] = Field(description=("Dated records found in the owner's apps, one per record, each an object "
                                             "with keys when (ISO date), what (one sentence), app (toolkit slug), and "
                                             "url (the record's link)."),
                                json_schema_extra={"items": TIMELINE_ENTRY_SCHEMA})
    causes: list[dict] = Field(default_factory=list, description="For a why question, likely causes, most likely first. Empty otherwise.",
                               json_schema_extra={"items": TIMELINE_CAUSE_SCHEMA})


CITATION_SCHEMA = {
    "type": "object",
    "properties": {
        "n": {"type": "integer", "description": "The citation number you'll write as [n] in your answer, starting at 1."},
        "url": {"type": "string", "description": "The source's https link exactly as a tool result returned it."},
        "quote": {"type": "string", "description": "A short passage (a phrase or sentence, under 300 characters) copied word for word from that tool result, containing the fact."},
    },
    "required": ["n", "url", "quote"],
}


class CiteArgs(BaseModel):
    sources: list[dict] = Field(description="One entry per fact you'll cite, numbered from 1. Reuse a number for the same passage.",
                                json_schema_extra={"items": CITATION_SCHEMA, "minItems": 1, "maxItems": 30})
VISUAL_SERIES_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "description": "What the series measures, e.g. 'Revenue' or '2025'."},
        "values": {"type": "array", "items": {"type": "number"}, "description": "One number per label, in label order; null where unknown."},
    },
    "required": ["name", "values"],
}
VISUAL_STAT_SCHEMA = {
    "type": "object",
    "properties": {
        "label": {"type": "string", "description": "What the number is, e.g. 'Orders this week'."},
        "value": {"type": "string", "description": "The number as people say it, e.g. '$4,120' or '5 days'."},
        "change": {"type": "string", "description": "Optional change against what, e.g. '-18% vs last week'."},
        "tone": {"type": "string", "enum": ["good", "bad", "neutral"], "description": "Whether the change is good or bad news."},
    },
    "required": ["label", "value"],
}


class VisualArgs(BaseModel):
    kind: str = Field(description=("chart (numbers across dates or categories), stats (2-6 key numbers), or table "
                                   "(things compared side by side, e.g. options, bookings, people)."))
    title: str = Field(description="What it shows, e.g. 'Daily revenue, Oct 1-14' or 'Trip bookings'.")
    app: str = Field(default="", description="The app the data came from, as a lower-case toolkit slug (e.g. shopify), if one.")
    chart: str = Field(default="bar", description="For kind=chart: bar or line (line for trends over time).")
    unit: str = Field(default="", description="For kind=chart: the values' unit, e.g. '$', 'orders', '%'.")
    labels: list[str] = Field(default_factory=list, description="For kind=chart: the x-axis labels (dates or categories), 2-31 of them.")
    series: list[dict] = Field(default_factory=list, description=("For kind=chart: 1-4 series, each an object with keys "
                                                                  "name and values (one number per label)."),
                               json_schema_extra={"items": VISUAL_SERIES_SCHEMA})
    items: list[dict] = Field(default_factory=list, description=("For kind=stats: 2-6 objects with keys label, value, "
                                                                 "and optionally change and tone (good, bad, neutral)."),
                              json_schema_extra={"items": VISUAL_STAT_SCHEMA})
    columns: list[str] = Field(default_factory=list, description="For kind=table: 2-6 column headings.")
    rows: list[list[str]] = Field(default_factory=list, description="For kind=table: up to 20 rows, one cell per column.")


QUESTION_SCHEMA = {
    "type": "object",
    "properties": {
        "question": {"type": "string", "description": "The question, one short sentence ending in a question mark. Put any plan or details it asks about in your reply text before the call, not here."},
        "header": {"type": "string", "description": "A 1-3 word label for it, e.g. 'Tone' or 'Date range'."},
        "options": {
            "type": "array", "minItems": 2, "maxItems": 4,
            "description": "2-4 distinct choices, your recommendation first. Don't add 'Other'; the owner can always type their own answer.",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string", "description": "The choice as the owner would say it, 1-6 words."},
                    "description": {"type": "string", "description": "Optional: what picking it means, one short sentence."},
                },
                "required": ["label"],
            },
        },
        "multi_select": {"type": "boolean", "description": ("True when more than one choice could be true at once "
                                                           "(what counts, which ones, what matters). False only "
                                                           "when the choices rule each other out.")},
    },
    "required": ["question", "options"],
}


class AskArgs(BaseModel):
    questions: list[dict] = Field(description="1-3 questions, asked together.",
                                  json_schema_extra={"items": QUESTION_SCHEMA, "minItems": 1, "maxItems": 3})


FORM_FIELD_SCHEMA = {
    "type": "object",
    "properties": {
        "kind": {"type": "string", "enum": ["choice", "multi_choice", "rank", "scale", "verdict", "text", "long_text", "file", "list", "connect"],
                 "description": ("choice (2-8 options, they pick one: only when the options rule each other out, "
                                 "e.g. 'How often?') or multi_choice (2-8 options, they pick any number: whenever "
                                 "more than one could be true, e.g. what counts, which ones, what matters; if unsure, "
                                 "multi_choice), rank (the owner puts 2-8 options in order, "
                                 "most important first), scale (one point between two labelled ends, e.g. 'Ask me "
                                 "first' to 'Just do it'), verdict (results you found or drafted for the owner to "
                                 "keep or pass on, a pass with a reason), text (one line), long_text (a paragraph), "
                                 "file (the owner drops in files, e.g. a resume), list (repeatable entries with the "
                                 "same parts, e.g. stories), connect (apps to connect, shown as Connect buttons). "
                                 "Prefer something the owner can react to (choices drafted from what you know, a "
                                 "rank, a scale, a verdict) over an empty text box.")},
        "id": {"type": "string", "description": "A short snake_case id, unique in the form, e.g. 'target_roles'."},
        "label": {"type": "string", "description": "The question or label, as the owner would read it."},
        "help": {"type": "string", "description": "Optional: one short line on what to put, or why you ask."},
        "required": {"type": "boolean", "description": "True only when you can't go on without it."},
        "options": {"type": "array", "items": {"type": "string"}, "description": "For choice, multi_choice, and rank: 2-8 choices."},
        "allow_other": {"type": "boolean", "description": ("For choice and multi_choice: a 'Something else' choice they can type is "
                                                         "on by default; false only for a truly closed question (e.g. yes/no).")},
        "steps": {"type": "integer", "description": "For scale: how many points, 3-7 (default 5)."},
        "low": {"type": "string", "description": "For scale: what the first point means, e.g. 'Ask me first'."},
        "high": {"type": "string", "description": "For scale: what the last point means, e.g. 'Just do it'."},
        "items": {"type": "array", "description": ("For verdict: 1-8 real results in ONE field, each an object with title, body "
                                                   "(one or two lines on why it might fit), link (its URL, if it has one), and "
                                                   "record ({collection, key}) when it's a tracker row. The card adds the Keep "
                                                   "and Pass buttons itself; don't list them."),
                  "items": {"type": "object", "properties": {"title": {"type": "string"}, "body": {"type": "string"}, "link": {"type": "string"},
                                                             "record": {"type": "object", "properties": {"collection": {"type": "string"}, "key": {"type": "string"}}}},
                            "required": ["title"]}},
        "reasons": {"type": "array", "items": {"type": "string"}, "description": "For verdict: 2-6 short reasons someone might pass, e.g. 'Too junior', 'Not remote'."},
        "placeholder": {"type": "string", "description": "For text and long_text: an example answer."},
        "prefill": {"description": ("What you already know, for the owner to confirm or fix: a string for text and "
                                    "long_text, a list of option labels for choices, every option label in your "
                                    "suggested order for rank, a number for scale, or for list a list of objects "
                                    "keyed by part id (your drafts).")},
        "accept": {"type": "array", "items": {"type": "string"}, "description": "For file: allowed extensions, e.g. ['pdf', 'docx']."},
        "keep": {"type": "boolean", "description": ("For file: true to keep the files in this agent's files, so they come with "
                                                    "every future conversation (e.g. a resume). False for a one-off file.")},
        "max": {"type": "integer", "description": "For file and list: the most files or entries (1-8)."},
        "parts": {"type": "array", "description": "For list: 1-5 parts of each entry, each an object with id, label, and long (true for a paragraph).",
                  "items": {"type": "object", "properties": {"id": {"type": "string"}, "label": {"type": "string"}, "long": {"type": "boolean"}},
                            "required": ["label"]}},
        "item_label": {"type": "string", "description": "For list: what one entry is called, e.g. 'Story'."},
        "apps": {"type": "array", "items": {"type": "string"}, "description": "For connect: app ids, e.g. ['gmail', 'apollo', 'hunter']."},
    },
    "required": ["kind", "label"],
}


class FormArgs(BaseModel):
    title: str = Field(description="What the form is for, 2-6 words, e.g. 'Your search'.")
    intro: str = Field(default="", description="Optional: one or two sentences on why you're asking.")
    fields: list[dict] = Field(description="1-8 fields, in the order the owner fills them in.",
                               json_schema_extra={"items": FORM_FIELD_SCHEMA, "minItems": 1, "maxItems": 8})
    submit_label: str = Field(default="", description="Optional button text, e.g. 'Next' or 'Save stories'.")


PROPOSED_TASK_SCHEMA = {
    "type": "object",
    "properties": {
        "template_task_id": {"type": "string", "description": "The id of a task CONTEXT lists as already set up (paused), to switch it on."},
        "title": {"type": "string", "description": "The task, 2-6 words."},
        "instructions": {"type": "string", "description": "What to do each run, in the owner's terms."},
        "skill": {"type": "string", "description": "Optional: a library skill id it runs with."},
        "schedule": {"type": "object", "description": ("When it runs: {every: 'day'|'weekdays', at: 'HH:MM'}, "
                                                        "{every: 'week', at: 'HH:MM', weekday: 0-6 (0 = Sunday)}, "
                                                        "{every: 'hours', hours: 1-24}, or null for on demand.")},
    },
    "required": ["title", "instructions"],
}


class ProposeArgs(BaseModel):
    summary: str = Field(description="Two or three sentences: what this agent will do for the owner, in their words.")
    profile: str = Field(default="", description="The agent's 'What this agent is for', rewritten from what the owner told you.")
    instructions: str = Field(default="", description="Standing instructions for the agent, tuned to the owner's answers. The whole text.")
    skills: list = Field(default_factory=list, description=("Library skill ids to add, or new skills as objects with name, "
                                                           "description, and instructions."))
    tasks: list[dict] = Field(default_factory=list, description="Recurring or on-demand tasks to switch on.",
                              json_schema_extra={"items": PROPOSED_TASK_SCHEMA, "maxItems": 8})
    memories: list[str] = Field(default_factory=list, description="Lasting facts to remember about the owner, one sentence each.")
    identity: dict = Field(default_factory=dict, description=("Optional: who you are to the member, once you know them, or when "
                                                             "they offer you a name. A short first name and, in two first-person "
                                                             "sentences, how you talk with them."),
                           json_schema_extra={"properties": {"name": {"type": "string"}, "manner": {"type": "string"}}})
    sound: list[dict] = Field(default_factory=list, description=("Optional, when your context lists voices: two or three ways "
                                                                "you could sound on calls and in voice notes, side by side, "
                                                                "each a voice id from that list and, in two first-person "
                                                                "sentences, how you'd talk with them. Don't mark one as yours: "
                                                                "they choose one or none."),
                              json_schema_extra={"items": {"type": "object", "properties": {"voice": {"type": "string"},
                                                                                            "manner": {"type": "string"}},
                                                           "required": ["voice"]}, "maxItems": 3})
    assumptions: list[str] = Field(default_factory=list, description=("Optional: the guesses you made writing this that the "
                                                                      "owner should check, one sentence each, the way you'd "
                                                                      "say it ('I assumed you always pick the cheapest "
                                                                      "option.'), most important first. They confirm or fix "
                                                                      "each one before applying."),
                                   json_schema_extra={"maxItems": 6})


MERGE_SCHEMA = {
    "type": "object",
    "properties": {
        "replaces": {"type": "array", "items": {"type": "string"},
                     "description": "The ids of the facts this one replaces, exactly as listed (at least two)."},
        "text": {"type": "string", "description": ("The merged fact: one or two self-contained sentences that keep every "
                                                   "detail of the facts it replaces, at most 500 characters.")},
        "category": {"type": "string", "description": "Optional: its topic (customers, suppliers, products, policies, voice, team, or other)."},
    },
    "required": ["replaces", "text"],
}


class MergeArgs(BaseModel):
    summary: str = Field(default="", description="One short sentence on what you'd combine, e.g. '7 facts about pricing become 3'.")
    merges: list[dict] = Field(description="Each merge: the facts it replaces and the one fact that replaces them.",
                               json_schema_extra={"items": MERGE_SCHEMA, "minItems": 1, "maxItems": 8})


class OfferCallArgs(BaseModel):
    reason: str = Field(description=("Why a call would help, in one sentence as you'd say it, e.g. 'This one's worth five "
                                     "minutes: there are three trade-offs to weigh.'"))
    topic: str = Field(default="", description="Optional: what the call would be about, 2-6 words, e.g. 'Which offer to take'.")


class SecretArgs(BaseModel):
    kind: str = Field(description=("'login' for a sign-in (username and password), 'card' for a payment card, 'code' for a "
                                   "one-time code the site sent them (by text, email, or an authenticator app) to finish "
                                   "signing in."))
    reason: str = Field(description=("Why, in one short sentence as you'd say it, e.g. 'To sign in to your Acme account and "
                                     "download the March invoice.'"))
    username_hint: str = Field(default="", description="Optional: the username or email the site seems to expect, if you know it.")
class SaveFileArgs(BaseModel):
    name: str = Field(description="The file's name for the owner, e.g. 'Label - Jane Doe.pdf'.")
    link: str = Field(default="", description=("Optional: the file's address as your browser's page has it (a Download "
                                              "or Print label link's href, found with observe or extract). Left out, "
                                              "the page you have open is saved as a PDF."))


class WatchArgs(BaseModel):
    job: str = Field(description=("The job they'll show you, in one sentence in their words, e.g. 'Book the cheapest nonstop "
                                  "flight to see my parents.'"))
    site: str = Field(default="", description="Optional: the site it starts on, 1-3 words, e.g. 'Google Flights'.")


class HandBrowserArgs(BaseModel):
    reason: str = Field(description=("What the owner needs to do in the browser, in one sentence as you'd say it, e.g. "
                                     "'Solve the robot check on the USPS page, then tap Done and I'll make the label.'"))
    site: str = Field(default="", description="Optional: the site, 1-3 words, e.g. 'USPS'.")


# Explicit rebuild prevents some custom-component code evaluators from losing namespaces.
DiscoverArgs.model_rebuild()
ExecuteArgs.model_rebuild()
ActionArgs.model_rebuild()
MemoryArgs.model_rebuild()
TimelineArgs.model_rebuild()
CiteArgs.model_rebuild()
VisualArgs.model_rebuild()
AskArgs.model_rebuild()
FormArgs.model_rebuild()
ProposeArgs.model_rebuild()
MergeArgs.model_rebuild()
OfferCallArgs.model_rebuild()
SecretArgs.model_rebuild()
HandBrowserArgs.model_rebuild()
WatchArgs.model_rebuild()


def words(s):
    return set(re.findall(r"[a-z0-9]+", str(s or "").lower()))


ALIASES = {
    "email": {"gmail", "inbox", "mail"}, "gmail": {"email", "mail"},
    "website": {"web", "search", "exa"}, "browse": {"web", "search", "exa"},
    "research": {"web", "search", "exa"}, "memory": {"profile", "supermemory", "remember"},
    "remember": {"memory", "supermemory"}, "profile": {"memory", "supermemory"},
    "calculation": {"python", "evaluate", "expression"},
    "spreadsheet": {"sheets", "composio", "workbooks"},
    "file": {"drive", "composio"}, "app": {"composio", "tools"},
}


def capabilities(registry):
    """Plain names for what sits behind the gateway, so the agent knows what discover_tools can find."""
    found = []
    def has(test):
        return any(test(name.lower(), words(name) | words((tool.description or "")[:400])) for name, tool in registry.items())
    if has(lambda name, w: "exa" in w or {"web", "search"} <= w or "internet" in w):
        found.append("web search")
    if has(lambda name, w: name.startswith("composio_")):
        found.append("the owner's connected apps")
    if has(lambda name, w: "python" in w or "repl" in w):
        found.append("running Python")
    if has(lambda name, w: name == "load_skill"):
        found.append("skills")
    return found


def original_schema(tool):
    schema = getattr(tool, "args_schema", None)
    if isinstance(schema, dict):
        return schema
    if schema is not None and hasattr(schema, "model_json_schema"):
        return schema.model_json_schema()
    return {"type": "object", "properties": getattr(tool, "args", {}) or {}}


def compact_schema(schema):
    """Remove schema verbosity without losing property names or nested argument shapes."""
    structural = {"type", "properties", "required", "items", "$ref", "$defs",
                  "anyOf", "oneOf", "allOf", "additionalProperties", "enum",
                  "default", "format", "minItems", "maxItems", "minimum", "maximum",
                  "minLength", "maxLength", "pattern"}

    def visit(value, mapping=False):
        if isinstance(value, list):
            return [visit(v) for v in value]
        if not isinstance(value, dict):
            return value
        if mapping:
            # Field names and $defs model names are arbitrary, NOT schema keywords.
            return {key: visit(child) for key, child in value.items()}
        out = {}
        for key, child in value.items():
            if key in ("properties", "$defs") and isinstance(child, dict):
                out[key] = visit(child, mapping=True)
            elif key in structural:
                out[key] = visit(child)
            elif key == "description":
                desc = str(child)
                out[key] = desc[:150] + ("…" if len(desc) > 150 else "")
        return out

    return visit(schema)


# Web search results get a bigger budget than other tools, shared across every source, so a
# search reads all the sources it found instead of the first few in full.
WEB_RESULT_CHARS = 12000


def web_results(payload):
    """The sources in a list of web results (e.g. Exa's search), or None for anything else."""
    items = getattr(payload, "results", None)
    if items is None and isinstance(payload, dict):
        items = payload.get("results")
    if not isinstance(items, list) or not items:
        return None
    field = lambda item, key: item.get(key) if isinstance(item, dict) else getattr(item, key, None)
    sources = []
    for item in items:
        url = field(item, "url")
        if not isinstance(url, str) or not url.startswith("http"):
            return None
        body = next((v for k in ("highlights", "summary", "text", "snippet", "description", "content") if (v := field(item, k))), "")
        if isinstance(body, list):
            body = " … ".join(str(b) for b in body)
        body = " ".join(str(body).split())
        # The page's own text, when the reader sent it: kept so it can be read whole (read_result).
        text = field(item, "text")
        text = " ".join(text.split()) if isinstance(text, str) else ""
        sources.append({"title": " ".join(str(field(item, "title") or "").split()), "url": url,
                        "published": str(field(item, "published_date") or field(item, "publishedDate") or "")[:10],
                        "body": body, "full": text if len(text) > len(body) else body})
    return sources


def compact_web_results(sources, limit, keep=None):
    """Every source as Title/URL/Published/text, each trimmed to its share of the budget. When a
    page's full text is longer than what's shown, all of it is handed to keep(), when given, so
    it can be read whole with read_result."""
    budget = max(limit, WEB_RESULT_CHARS)
    share = max(300, budget // len(sources))
    blocks = []
    full_blocks = []
    cut = False
    for s in sources:
        head = f"Title: {s['title']}\nURL: {s['url']}" + (f"\nPublished: {s['published']}" if s["published"] else "")
        room = max(150, share - len(head))
        full = s.get("full") or s["body"]
        # A page's own text that fits is shown instead of its highlights.
        shown = full if len(full) <= room else s["body"]
        body = shown if len(shown) <= room else shown[:room].rsplit(" ", 1)[0] + " …"
        blocks.append(head + (f"\n{body}" if body else ""))
        full_blocks.append(head + (f"\n{full}" if full else ""))
        # Only a page's own text is worth reading on; trimmed search highlights aren't.
        cut = cut or (full != s["body"] and len(full) > room)
    out = f"{len(sources)} results\n\n" + "\n\n".join(blocks)
    rid = keep(f"{len(sources)} results\n\n" + "\n\n".join(full_blocks)) if cut and keep else None
    if rid:
        total = sum(len(b) for b in full_blocks)
        out += (f"\n[PARTIAL RESULT: these pages' full text ({total} chars) can be read with read_result(result_id=\"{rid}\", "
                f"offset=0), {RESULT_PAGE} chars at a time; it needs no approval. The web reader sends at most about "
                "10,000 chars of a page; for a longer page you need whole, fetch it in one code call.]")
    return out


# How much of a kept result one read_result call returns, how many results a run keeps, and
# the most it keeps of one.
RESULT_PAGE = 20000
KEPT_RESULTS = 8
KEPT_CHARS = 1000000


def compact_result(result, limit, keep=None):
    """Prefer structured MCP payloads; avoid duplicating text/structured representations.
    A result cut to the limit is handed to keep(), when given, so the rest can be read with
    read_result instead of being lost."""
    structured = getattr(result, "structuredContent", None)
    if structured is None and isinstance(result, dict):
        structured = result.get("structuredContent") or result.get("structured_content")
    if structured is not None:
        payload = structured
    else:
        content = getattr(result, "content", None)
        if content is None and isinstance(result, dict):
            content = result.get("content")
        if isinstance(content, list):
            text_parts = []
            for part in content:
                txt = part.get("text") if isinstance(part, dict) else getattr(part, "text", None)
                if txt is not None:
                    text_parts.append(txt)
            payload = "\n".join(text_parts) if text_parts else content
        else:
            payload = content if content is not None else result
    sources = web_results(payload)
    if sources:
        return compact_web_results(sources, limit, keep)
    out = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, default=str)
    if len(out) > limit:
        # Explicit warning so the agent doesn't mistake the excerpt for complete data.
        rid = keep(out) if keep else None
        if rid:
            return out[:limit] + (f"\n[PARTIAL RESULT: {len(out)} chars total, {len(out)-limit} omitted. Read the rest with "
                                  f"read_result(result_id=\"{rid}\", offset={limit}), {RESULT_PAGE} chars at a time; it needs no "
                                  "approval. Do not treat this part as complete.]")
        return out[:limit] + f"\n[PARTIAL RESULT: {len(out)} chars total, {len(out)-limit} omitted. Do not treat as complete; narrow the query or use an execution/data-processing tool for the full dataset.]"
    return out


def read_page(kept, result_id, offset):
    """One page of a result this run kept, with where the next page starts."""
    full = kept.get(str(result_id or "").strip())
    if full is None:
        return ("That result isn't kept anymore: results are kept only while this run lasts. Run the step again, and "
                "process the data in that call so it prints only what you need.")
    start = max(0, int(offset or 0))
    if start >= len(full):
        return f"[End of result: it is {len(full)} chars long.]"
    end = min(len(full), start + RESULT_PAGE)
    footer = (f"[chars {start}-{end} of {len(full)}. Next: read_result(result_id=\"{result_id}\", offset={end}).]"
              if end < len(full) else f"[chars {start}-{end} of {len(full)}. End of result.]")
    return full[start:end] + "\n" + footer


COMPOSIO_SLUG = re.compile(r"^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$")


def own_tool(name, arguments, registry):
    """Composio's own tools (the workbench, search, connections) run only by their own name;
    its executor refuses them. An agent that names one as a slug (COMPOSIO_REMOTE_WORKBENCH)
    or puts it alone in a batch gets it called directly."""
    if isinstance(name, str) and name not in registry and name.lower().startswith("composio_") and name.lower() in registry:
        return name.lower(), arguments
    if name == "composio_multi_execute_tool":
        batch = arguments
        if isinstance(batch, str):
            try:
                batch = json.loads(batch) if batch.strip() else {}
            except json.JSONDecodeError:
                return name, arguments
        calls = batch.get("tools") if isinstance(batch, dict) else None
        if isinstance(calls, list) and len(calls) == 1 and isinstance(calls[0], dict):
            slug = str(calls[0].get("tool_slug") or "").lower()
            if slug.startswith("composio_") and slug != name and slug in registry:
                return slug, calls[0].get("arguments") or {}
    return name, arguments

# Read-only tools: safe to retry, and they should answer within seconds.
LOOKUP_TOOLS = {
    "composio_search_tools", "composio_get_tool_schemas", "composio_wait_for_connections",
    "composio_search_skills", "composio_use_skill", "load_skill",
    "search", "search_memory", "list_memories", "list_documents", "get_document", "get_profile",
}

# Composio slugs read TOOLKIT_VERB_OBJECT. A slug with a changing verb changes the owner's accounts;
# one with only reading verbs doesn't; anything unrecognized counts as changing (fail closed).
WRITE_WORDS = {
    "SEND", "CREATE", "UPDATE", "DELETE", "REMOVE", "ADD", "INSERT", "APPEND", "MODIFY", "PATCH",
    "PUT", "POST", "REPLY", "FORWARD", "MOVE", "ARCHIVE", "TRASH", "UNTRASH", "UPLOAD", "SET",
    "CLEAR", "CANCEL", "REFUND", "FULFILL", "PUBLISH", "SHARE", "INVITE", "MARK", "LABEL",
    "UNLABEL", "WRITE", "EDIT", "RENAME", "COPY", "DUPLICATE", "MERGE", "SUBMIT", "PAY",
    "CHARGE", "TRANSFER", "APPROVE", "REJECT", "ASSIGN", "SCHEDULE", "BOOK", "ENABLE",
    "DISABLE", "START", "STOP", "RUN", "EXECUTE", "TRIGGER", "IMPORT", "SYNC", "SUBSCRIBE",
    "UNSUBSCRIBE", "ACCEPT", "DECLINE", "RESPOND", "CLOSE", "RESTORE", "EMPTY", "PIN", "STAR",
    "MUTE", "REPLACE", "ADJUST", "COMPLETE", "RESOLVE", "INVOKE", "SAVE", "DRAFT",
}
READ_WORDS = {
    "GET", "LIST", "FETCH", "SEARCH", "FIND", "READ", "QUERY", "RETRIEVE", "LOOKUP", "COUNT",
    "DOWNLOAD", "EXPORT", "VIEW", "DESCRIBE", "CHECK", "PREVIEW", "ANALYZE", "SUMMARIZE",
}
# Tools that act in the world without a Composio slug to read.
ACTION_TOOLS = {"act"}
# What asks the owner first: only what moves money, or deletes for good. Everything else the agent
# does in their accounts runs, and the app OKs a kind for good the first time they approve it
# (src/lib/approvals/standing.ts), so each use case asks once.
MONEY_WORDS = {
    "PAY", "PAYS", "PAYMENT", "PAYMENTS", "PAYOUT", "PAYOUTS", "CHARGE", "CHARGES", "TRANSFER", "TRANSFERS",
    "REFUND", "REFUNDS", "PURCHASE", "BUY", "CHECKOUT", "WITHDRAW", "WITHDRAWAL", "DEPOSIT", "CAPTURE",
    "DONATE", "DONATION", "TIP", "PLACE", "ORDER", "ORDERS", "PAYPAL", "WIRE", "REMIT",
}
GONE_WORDS = {"DELETE", "PURGE", "DESTROY", "EMPTY", "ERASE", "WIPE"}
# Apps that hold or move money: anything in them that changes something asks.
MONEY_APPS = {
    "STRIPE", "SQUARE", "PAYPAL", "BRAINTREE", "ADYEN", "WISE", "PLAID", "COINBASE", "BREX", "RAMP", "MERCURY",
    "VENMO", "CASHAPP", "REVOLUT", "CHARGEBEE", "RECURLY", "PADDLE", "LEMONSQUEEZY", "GUMROAD", "RAZORPAY",
    "MOLLIE", "KLARNA", "BILLCOM", "PAYONEER", "ALPACA", "ROBINHOOD", "KRAKEN", "BINANCE",
}
# A browser step that pays, buys, or places an order, read from its words.
MONEY_STEP = re.compile(
    r"(?i)\b(?:pay|pays|paying|payment|purchase|purchasing|buy|buying|check\s*out|checkout|donate|subscribe|"
    r"transfer|withdraw|place\s+(?:the\s+|my\s+|your\s+|this\s+)?order|(?:submit|confirm|complete|finish)\s+"
    r"(?:the\s+|my\s+|your\s+|this\s+)?(?:order|purchase|payment|booking|checkout))\b"
)
# Tools that run arbitrary code in Composio's sandbox.
CODE_TOOLS = {"composio_remote_workbench", "composio_remote_bash_tool"}
# The sandbox reaches the owner's accounts only through Composio: run_composio_tool, proxy_execute,
# or its key in the environment. Workbench code that calls run_composio_tool only with literal
# read-only slugs, and touches nothing else that could reach Composio or hide what runs, can't
# change their accounts, so it runs without approval. Anything else asks (fail closed).
CALLED_SLUG = re.compile(r"""\brun_composio_tool\s*\(\s*(?:tool_slug\s*=\s*)?(['"])([A-Za-z0-9_]+)\1""")
# Python's own compile() is caught, not a module's (re.compile, which sorting mail by pattern uses);
# builtins is caught so compile can't be reached through it.
HIDDEN_CODE = re.compile(
    r"proxy_execute|environ|getenv|\bexec\b|\beval\b|(?<![.\w])compile\s*\(|\bbuiltins\b|__import__|importlib|getattr|setattr|"
    r"\bglobals\b|\blocals\b|\bvars\s*\(|__builtins__|__dict__|sys\.modules|subprocess|\bos\.(system|popen|exec|spawn)|"
    r"\bpty\b|ctypes|marshal|pickle|base64|codecs",
    re.IGNORECASE,
)
CODE_ARGS = ("code_to_execute", "code")


def slug_changes_things(slug):
    tokens = str(slug or "").upper().split("_")[1:]
    if any(t in WRITE_WORDS for t in tokens):
        return True
    return not any(t in READ_WORDS for t in tokens)


def slug_is_sensitive(slug):
    """Whether an app tool moves money or deletes for good: the only app tools that ask."""
    parts = str(slug or "").upper().split("_")
    if len(parts) < 2:
        return True
    if not slug_changes_things(slug):
        return False
    return parts[0] in MONEY_APPS or any(t in MONEY_WORDS or t in GONE_WORDS for t in parts[1:])


def code_changes_things(name, arguments, changes=None):
    """Whether a code run could change something in the owner's accounts (with `changes`, something sensitive)."""
    changes = changes or slug_changes_things
    if name != "composio_remote_workbench" or not isinstance(arguments, dict):
        return True
    code = next((arguments[k] for k in CODE_ARGS if isinstance(arguments.get(k), str)), None)
    if code is None or HIDDEN_CODE.search(code):
        return True
    called = [m.group(2) for m in CALLED_SLUG.finditer(code)]
    # Every other mention of Composio (an aliased helper, a slug built at runtime, its API) asks.
    if len(re.findall(r"composio", code, re.IGNORECASE)) != len(called):
        return True
    return any(changes(slug) for slug in called)


def changes_accounts(name, arguments):
    """Whether a routed call changes something in the owner's accounts."""
    if name in ACTION_TOOLS:
        return True
    if name == "composio_multi_execute_tool":
        calls = arguments.get("tools") if isinstance(arguments, dict) else None
        if not isinstance(calls, list):
            return True
        return any(not isinstance(c, dict) or slug_changes_things(c.get("tool_slug")) for c in calls)
    if name in CODE_TOOLS:
        return code_changes_things(name, arguments)
    # Composio's own meta tools (connections, skills, feedback) change or send things unless
    # listed as lookups; new ones fail closed.
    if name.startswith("composio_") and name not in LOOKUP_TOOLS:
        return True
    return False


def needs_approval(name, arguments):
    """Whether a routed call must ask the owner first: it moves money or deletes for good.

    Fail closed on what can't be read: the shell, code that hides what it runs, and a browser
    step that pays, buys, or places an order."""
    if name in ACTION_TOOLS:
        return bool(MONEY_STEP.search(json.dumps(arguments, default=str) if not isinstance(arguments, str) else arguments))
    if name == "composio_multi_execute_tool":
        calls = arguments.get("tools") if isinstance(arguments, dict) else None
        if not isinstance(calls, list):
            return True
        return any(not isinstance(c, dict) or slug_is_sensitive(c.get("tool_slug")) for c in calls)
    if name in CODE_TOOLS:
        return code_changes_things(name, arguments, slug_is_sensitive)
    if COMPOSIO_SLUG.match(name or "") and not name.lower().startswith("composio_"):
        return slug_is_sensitive(name)
    return False


# A run an event in a connected app started (run_cause "watch", docs/watches.md) reads other
# people's words: an email can try to steer the agent into sending what it knows somewhere. So
# in those runs anything that can reach an address the agent chose asks the owner first: code,
# the browser, and any call with a link in its arguments. Reading the owner's apps through
# Composio by slug, and web search by words, still runs.
BROWSER_TOOLS = {"start", "navigate", "act", "observe", "extract"}
LINK = re.compile(r"(?i)\b(?:https?|wss?|ftp)://|\bwww\.")


def has_link(value):
    if isinstance(value, str):
        return bool(LINK.search(value))
    if isinstance(value, dict):
        return any(has_link(v) for v in value.values())
    if isinstance(value, (list, tuple)):
        return any(has_link(v) for v in value)
    return False


def watch_needs_approval(name, arguments):
    """Whether, in a run an event started, a routed call must ask the owner first: anything that
    changes their accounts, as before, since other people's words started it."""
    return name in CODE_TOOLS or name in BROWSER_TOOLS or has_link(arguments) or changes_accounts(name, arguments)


# Seconds a run's tools may take in all (see run_budget). The app's request lasts 300: this leaves
# time for the run to start, for the agent to write its answer, and for the app to save it.
RUN_BUDGET = 210
# How many of the agent's tool calls go by with plan steps left before it's reminded to move the
# plan on, so the owner sees the work go step by step rather than stay on the first.
PLAN_NUDGE_CALLS = 4
# A tool isn't started with less time than this left in the budget.
MIN_TOOL_SECONDS = 15
WRAP_UP = ("Don't call more tools except keep_going. If the rest of the job needs nothing from the owner, "
           "call keep_going with what's left, then end this reply with a line or two on what's done so far: "
           "Studio starts your next reply at once to carry on, so never ask them to say carry on. If the rest "
           "needs them (a decision, an answer, an approval), answer now with what you have and ask for just "
           "that. Don't explain how you got it: no fetches, pages, counts of what you pulled, or running out of time.")
# After a step that used up the reply: the next reply has no more time, so the same step whole
# would run out again.
TOO_BIG = ("Your next reply gets no more time than this one, so that step won't fit whole there either: in "
           "keep_going's remaining, say to do it in smaller pieces (a shorter date range or fewer items per call), "
           "keeping what each piece finds.")
# Seconds left in a run's budget when the agent is told to wrap up the step it's on.
TIME_NOTICE_SECONDS = 50
TIME_NOTICE = ("Under a minute is left in this reply. Finish the step you're on; if the job won't be done by "
               "then and the rest needs nothing from the owner, call keep_going with what's left.")


class ToolGatewayComponent(Component):
    display_name = "Tool Gateway"
    description = "Dynamic discovery and execution of connected tools with compact tool context."
    icon = "waypoints"
    name = "ToolGatewayComponent"

    inputs = [
        HandleInput(name="tools", display_name="Tools", input_types=["Tool"], is_list=True, required=True),
        IntInput(name="max_results", display_name="Max Discovery Results", value=3, advanced=True),
        IntInput(name="max_result_chars", display_name="Max Result Characters", value=4000, advanced=True),
        IntInput(name="lookup_timeout", display_name="Lookup Timeout (seconds)", value=45, advanced=True,
                 info="Read-only lookups (tool search, schemas, memory, web search). Retried once on timeout."),
        IntInput(name="work_timeout", display_name="Work Timeout (seconds)", value=200, advanced=True,
                 info="Everything else (workbench, browser, app actions). Never retried automatically."),
        IntInput(name="run_budget", display_name="Run Budget (seconds)", value=RUN_BUDGET, advanced=True,
                 info=("How long this run's tools may take in all, from the start of the run (a resumed run "
                       "starts again), so the agent still has time to answer before the app's request ends "
                       "(5 minutes). Approved actions always run. 0 turns it off.")),
        MessageTextInput(name="run_cause", display_name="Run Cause", value="", advanced=True,
                         info=("Filled per run by the app ({{run_cause}}): 'watch' when an event in a connected app "
                               "started it, so code, the browser, and calls with links ask the owner first.")),
    ]
    outputs = [Output(display_name="Gateway Tools", name="gateway_tools", method="build_gateway_tools", types=["Tool"])]

    def build_gateway_tools(self):
        registry = {}
        def add(value):
            if isinstance(value, (list, tuple)):
                for child in value:
                    add(child)
            elif isinstance(value, BaseTool):
                key = value.name
                n = 2
                while key in registry:
                    key = f"{value.name}_{n}"
                    n += 1
                registry[key] = value
        add(self.tools)
        if not registry:
            raise ValueError("No executable Tool objects received by gateway. Connect Tool outputs to Tools input.")
        max_hits = max(1, min(5, int(self.max_results or 3)))
        max_chars = max(500, int(self.max_result_chars or 4000))
        cache = {}
        # Results cut to max_chars, kept whole while this build lives, so the agent can read a long
        # one (a transcript) in pages. Each run's results are kept apart under its own thread
        # (one conversation's), so one conversation can never read another's, even if a build
        # were reused.
        kept = {}
        kept_count = [0]

        def thread_of(config):
            return str(((config or {}).get("configurable") or {}).get("thread_id") or "")

        def keeper(config):
            def keep(full):
                kept_count[0] += 1
                rid = f"r{kept_count[0]}"
                mine = kept.setdefault(thread_of(config), {})
                mine[rid] = full[:KEPT_CHARS]
                while len(mine) > KEPT_RESULTS:
                    mine.pop(next(iter(mine)))
                return rid
            return keep

        def read_result(result_id: str, offset: int = 0, config: RunnableConfig = None) -> str:
            return read_page(kept.get(thread_of(config), {}), result_id, offset)

        async def read_result_async(result_id: str, offset: int = 0, config: RunnableConfig = None) -> str:
            return read_result(result_id, offset, config)

        def discover(query: str) -> str:
            key = query.strip().lower()
            if key in cache:
                return cache[key]
            original = words(query)
            expanded = set(original)
            for token in original:
                expanded.update(ALIASES.get(token, set()))
            # User-intent mapping avoids generic "search" outranking a specific profile lookup.
            wants_profile = ("me" in original or "user" in original or "myself" in original) and bool(original & {"know", "profile", "about", "identity"})
            ranked = []
            for name, tool in registry.items():
                n = words(name)
                d = words((tool.description or "")[:400])
                score = 5 * len(original & n) + 2 * len(expanded & n) + len(original & d)
                if wants_profile:
                    if "get_profile" in name.lower():
                        score += 50
                    elif "search_memory" in name.lower():
                        score += 10
                # Avoid irrelevant general-purpose discovery during personal-memory lookups.
                if wants_profile and "composio" in name.lower():
                    score -= 15
                if score > 0:
                    ranked.append((score, name, tool))
            ranked.sort(key=lambda row: (-row[0], row[1]))
            hits = ranked[:max_hits]
            data = [{"name": name, "description": (tool.description or "")[:180],
                     "parameters": compact_schema(original_schema(tool))}
                    for _, name, tool in hits]
            response = json.dumps(data, ensure_ascii=False, default=str)
            if not hits:
                response = json.dumps({"matches": [], "hint": "Try a more specific query or tool name."})
            cache[key] = response
            return response

        def route(name, arguments):
            # Agents sometimes wrap a call in execute_tool twice; unwrap to the inner tool.
            for _ in range(3):
                if name != "execute_tool":
                    break
                inner = arguments
                if isinstance(inner, str):
                    try:
                        inner = json.loads(inner) if inner.strip() else {}
                    except json.JSONDecodeError:
                        break
                if not isinstance(inner, dict) or not isinstance(inner.get("tool_name"), str):
                    break
                name, arguments = inner["tool_name"], inner.get("arguments") or {}
            name, arguments = own_tool(name, arguments, registry)
            # Agents sometimes call a Composio tool slug (e.g. GRANOLA_MCP_QUERY_GRANOLA_MEETINGS)
            # directly. Send it through Composio's executor instead of failing.
            if name not in registry and COMPOSIO_SLUG.match(name or "") and "composio_multi_execute_tool" in registry:
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments) if arguments.strip() else {}
                    except json.JSONDecodeError:
                        return name, arguments
                return "composio_multi_execute_tool", {
                    "tools": [{"tool_slug": name, "arguments": arguments or {}}],
                    "sync_response_to_workbench": False,
                }
            return name, arguments

        def prepare(name, arguments):
            tool = registry.get(name)
            if tool is None:
                return None, None, f"Unknown tool '{name}'. Close matches: {difflib.get_close_matches(name, registry.keys(), n=3)}"
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments) if arguments.strip() else {}
                except json.JSONDecodeError as exc:
                    return None, None, f"Tool arguments must be valid JSON: {exc}"
            if arguments is None:
                arguments = {}
            if not isinstance(arguments, dict):
                return None, None, "Tool arguments must be a JSON object."
            if name == "composio_multi_execute_tool":
                # Required by Composio but irrelevant here; agents leave it out.
                arguments = {"sync_response_to_workbench": False, **arguments}
            try:
                model = getattr(tool, "args_schema", None)
                if isinstance(model, type) and issubclass(model, BaseModel):
                    model.model_validate(arguments)
                elif isinstance(model, dict):
                    missing = [k for k in model.get("required", []) if k not in arguments]
                    if missing:
                        raise ValueError(f"Missing required fields: {missing}")
            except (ValidationError, ValueError) as exc:
                return None, None, f"Invalid arguments for {name}: {exc}. Required fields must be supplied; do not invent IDs or namespaces."
            return tool, arguments, None

        # Per-tool deadlines: a hung lookup fails fast (and is retried once, since it changes
        # nothing); real work gets a long deadline and is never retried automatically.
        lookup_timeout = int(getattr(self, "lookup_timeout", 45) or 45)
        work_timeout = int(getattr(self, "work_timeout", 200) or 200)
        watched = str(getattr(self, "run_cause", "") or "").strip() == "watch"
        # One reply runs inside one app request, which ends after five minutes. Tools share the
        # first part of that, from when this run started, so a slow one can't use it all up and
        # the agent still has time to answer with what it has. Approved actions always run: the
        # owner said yes to them, and a resumed run gets a new request.
        budget = getattr(self, "run_budget", None)
        budget = RUN_BUDGET if budget is None else int(budget)
        started = time.monotonic()

        def time_left():
            return None if budget <= 0 else budget - (time.monotonic() - started)

        def out_of_time(name):
            return f"Tool {name} didn't run: this reply is out of time. {WRAP_UP}"
        asks = watch_needs_approval if watched else needs_approval

        def approval_hint(name, arguments=None):
            if watched and not changes_accounts(name, arguments):
                return ("This run started from an event in the owner's app, which other people wrote, so code, the browser, "
                        "and anything with a link ask the owner first. If it's needed for the job, call take_action now with "
                        "the same tool_name and arguments plus a one-sentence summary that names the link; otherwise do "
                        "without it.")
            if watched and not needs_approval(name, arguments):
                return ("This run started from an event in the owner's app, which other people wrote, so anything that "
                        "changes their accounts asks them first. If the job needs it, call take_action now with the same "
                        "tool_name and arguments plus a one-sentence summary; don't reply first.")
            # Said plainly for code: what made this run ask, so the agent can write code that
            # doesn't, and each approved run should do the whole job.
            if name == "composio_remote_bash_tool":
                return ("Shell commands always need the owner's approval, since Studio can't read what they'd do. Run "
                        "Python in composio_remote_workbench through execute_tool instead: it runs without approval "
                        "unless it moves money or deletes for good. Only if a shell command is truly needed, call "
                        "take_action with the same tool_name and arguments plus a one-sentence summary.")
            if name in CODE_TOOLS:
                return ("This code needs the owner's approval: it calls an app tool that moves money or deletes for good, "
                        "or it hides what it runs (proxy_execute, the environment, exec, eval, getattr, a slug built at "
                        "runtime). Code that calls run_composio_tool with literal slugs runs without approval otherwise, "
                        "sending and changing things included. Call money or deleting tools directly through take_action "
                        "rather than in code, with a one-sentence summary; don't reply first.")
            return ("This moves money or deletes something for good, so it needs the owner's OK the first time. Call "
                    "take_action now with the same tool_name and arguments plus a one-sentence summary naming the "
                    "amount, who it goes to, or what's deleted; don't reply first. Once they approve this kind, "
                    "Studio stops asking.")

        async def execute_async(tool_name: str, arguments=None, config: RunnableConfig = None) -> str:
            return with_reminder(await run_async(tool_name, arguments, config, approved=False), config)

        refused = "Approvals aren't available in this run, so nothing was changed. Tell the owner what you would have done."

        def approvals_active(config):
            # The Agent only gives tools a thread_id when it was built with approval
            # interrupts and a checkpointer; without one, nothing paused before this call.
            return bool(((config or {}).get("configurable") or {}).get("thread_id"))

        async def action_async(tool_name: str, arguments=None, summary: str = "", config: RunnableConfig = None) -> str:
            # Reaching this body with approvals active means the owner approved the call.
            if not approvals_active(config):
                return refused
            return with_reminder(await run_async(tool_name, arguments, config, approved=True), config)

        async def run_async(tool_name, arguments, config, approved):
            tool_name, arguments = route(tool_name, arguments)
            tool, params, error = prepare(tool_name, arguments)
            if error:
                return error
            if not approved and asks(tool_name, params):
                return approval_hint(tool_name, params)
            left = None if approved else time_left()
            if left is not None and left < MIN_TOOL_SECONDS:
                return out_of_time(tool_name)
            lookup = tool_name in LOOKUP_TOOLS
            limit = lookup_timeout if lookup else work_timeout
            attempts = 2 if lookup else 1
            cut = left is not None and left < limit * attempts
            if cut:
                limit, attempts = min(limit, int(left)), 1
            for attempt in range(attempts):
                try:
                    try:
                        result = await asyncio.wait_for(tool.ainvoke(params, config=config), timeout=limit)
                    except NotImplementedError:
                        result = await asyncio.wait_for(asyncio.to_thread(tool.invoke, params, config), timeout=limit)
                    return compact_result(result, max_chars, keeper(config))
                except asyncio.TimeoutError:
                    if attempt + 1 < attempts:
                        continue
                    if cut:
                        return (f"Tool {tool_name} ran out of this reply's time after {limit}s. It may or may not have "
                                f"finished. {WRAP_UP} {TOO_BIG}")
                    tried = " (tried twice)" if attempts > 1 else ""
                    hint = ("The service didn't respond; try another approach or tell the user." if lookup else
                            "It may or may not have finished; check before retrying, and tell the user.")
                    return f"Tool {tool_name} timed out after {limit}s{tried}. {hint}"
                except Exception as exc:
                    return f"Tool {tool_name} failed: {type(exc).__name__}: {exc}. Do not blindly retry writes."

        def run_sync(tool_name, arguments, config, approved):
            tool_name, arguments = route(tool_name, arguments)
            tool, params, error = prepare(tool_name, arguments)
            if error:
                return error
            if not approved and asks(tool_name, params):
                return approval_hint(tool_name, params)
            left = None if approved else time_left()
            if left is not None and left < MIN_TOOL_SECONDS:
                return out_of_time(tool_name)
            try:
                return compact_result(tool.invoke(params, config=config), max_chars, keeper(config))
            except Exception as exc:
                return f"Tool {tool_name} failed: {type(exc).__name__}: {exc}. Do not blindly retry writes."

        def execute_sync(tool_name: str, arguments=None, config: RunnableConfig = None) -> str:
            return with_reminder(run_sync(tool_name, arguments, config, approved=False), config)

        def action_sync(tool_name: str, arguments=None, summary: str = "", config: RunnableConfig = None) -> str:
            if not approvals_active(config):
                return refused
            return with_reminder(run_sync(tool_name, arguments, config, approved=True), config)

        async def discover_async(query: str) -> str:
            return discover(query)

        def remember(content: str, scope: str = "workspace", category: str = "other", replaces: list[str] | None = None) -> str:
            # The app saves this to the caller's own memory (it knows whose; this flow doesn't)
            # and shows it with an Undo. Nothing is stored here; the structured result is what
            # the app reads.
            # `replaces` names facts this one takes the place of; the app checks which it may replace.
            text = " ".join(str(content or "").split())[:500]
            if not text:
                return "Nothing to remember: content is empty."
            proposal = {
                "content": text,
                "scope": "personal" if scope == "personal" else "workspace",
                "category": category if category in MEMORY_CATEGORIES else "other",
            }
            ids = [str(i).strip().strip("[]") for i in (replaces or []) if str(i).strip()] if isinstance(replaces, list) else []
            if ids:
                proposal["replaces"] = list(dict.fromkeys(ids))[:6]
            return json.dumps({
                "memory_proposal": proposal,
                "note": "Updated what you remembered." if ids else "Remembered. The owner sees it and can undo it; no need to mention it.",
            })

        async def remember_async(content: str, scope: str = "workspace", category: str = "other", replaces: list[str] | None = None) -> str:
            return remember(content, scope, category, replaces)

        # The last plan each run's thread gave, and the calls since: the agent is reminded to move
        # it on as it works, and report_run catches one left with steps still to do or under way,
        # or the owner would see the work stuck on its first step after it's done.
        plans = {}
        since_plan = {}

        def open_steps(thread):
            return [r for r in plans.get(thread, []) if r["status"].lower() in ("", "todo", "doing")]

        def plan_reminder(config):
            # Every PLAN_NUDGE_CALLS calls since the plan last changed, while steps are left: where
            # the plan says the work is, so the agent moves it on once it's past that step.
            thread = thread_of(config)
            left = open_steps(thread)
            if not left:
                return ""
            since_plan[thread] = since_plan.get(thread, 0) + 1
            if since_plan[thread] < PLAN_NUDGE_CALLS:
                return ""
            since_plan[thread] = 0
            at = next((r for r in left if r["status"].lower() == "doing"), left[0])
            return (f"Your plan still shows '{at['text']}' as {at['status'] or 'todo'}. If you've finished it or moved "
                    "on, call update_plan now with the whole plan (done steps done, the one you're on doing) so the "
                    "owner sees where the work is.")

        noticed = set()

        def time_notice(config):
            # Once a run, when its budget is nearly spent: the agent wraps up the step it's on and
            # hands the rest to its next reply rather than being cut off mid-way.
            left = time_left()
            thread = thread_of(config)
            if left is None or left > TIME_NOTICE_SECONDS or thread in noticed:
                return ""
            noticed.add(thread)
            return TIME_NOTICE

        def with_reminder(result, config):
            # Into a structured result's note, or after a plain one; anything else structured is
            # left exactly as it is, since the app reads it.
            reminder = " ".join(r for r in (plan_reminder(config), time_notice(config)) if r)
            if not reminder or not isinstance(result, str):
                return result
            try:
                parsed = json.loads(result)
            except ValueError:
                return f"{result}\n[{reminder}]"
            if isinstance(parsed, dict) and isinstance(parsed.get("note"), str):
                parsed["note"] = f"{parsed['note']} {reminder}"
                return json.dumps(parsed)
            return result

        def update_plan(steps: list, goal: str = "", config: RunnableConfig = None) -> str:
            # Like remember, this changes nothing here: the app checks the plan and saves it where
            # the work in this conversation keeps it (its task, the setup checklist, or the
            # conversation), where the owner sees it above the chat.
            def plain(v):
                return v.model_dump() if hasattr(v, "model_dump") else dict(v) if isinstance(v, dict) else {"text": str(v)}
            rows = [plain(s) for s in (steps or [])][:30]
            rows = [{k: " ".join(str(r.get(k) or "").split())[:300] for k in ("text", "status", "note")} for r in rows]
            rows = [r for r in rows if r["text"]]
            if not rows:
                return "No plan to save: give at least one step with text."
            plans[thread_of(config)] = rows
            since_plan[thread_of(config)] = 0
            update = {"steps": rows}
            goal = " ".join(str(goal or "").split())[:200]
            if goal:
                update["goal"] = goal
            return json.dumps({"plan_update": update,
                               "note": "The owner sees it above the chat; no need to mention it."})

        async def update_plan_async(steps: list, goal: str = "", config: RunnableConfig = None) -> str:
            return update_plan(steps, goal, config)

        def save_record(collection: str, key: str, title: str = "", status: str = "", url: str = "", fields: dict | None = None,
                        config: RunnableConfig = None) -> str:
            # The app upserts this into the owner's own tracker (by collection and key). Nothing
            # is stored here and no outside account changes, so it needs no approval.
            collection = "-".join(str(collection or "").lower().split())[:40]
            key = " ".join(str(key or "").split())[:200]
            if not collection or not key:
                return "Not saved: give a collection and a key."
            extra = fields.model_dump() if hasattr(fields, "model_dump") else dict(fields or {})
            record = {"collection": collection, "key": key, "title": " ".join(str(title or "").split())[:200],
                      "status": " ".join(str(status or "").split())[:40], "url": str(url or "").strip()[:2000],
                      "fields": {str(k)[:60]: v for k, v in list(extra.items())[:30]}}
            return with_reminder(json.dumps({"record": record, "note": (
                "Saved to the owner's tracker. If it's a new result you found for them (a role, a lead, an "
                "option), not their own entry or a status change: once all of this reply's results are saved, "
                "end with show_form and one verdict field holding them (each with its record, link, and a line "
                "on why), so they keep or pass each, rather than listing them in your text.")}), config)

        async def save_record_async(collection: str, key: str, title: str = "", status: str = "", url: str = "", fields: dict | None = None,
                                    config: RunnableConfig = None) -> str:
            return save_record(collection, key, title, status, url, fields, config)

        def file_link(url: str, title: str, kind: str = "", config: RunnableConfig = None) -> str:
            # The app files this in the owner's own Library (it knows whose; this flow doesn't).
            # Nothing is stored here and no outside account changes, so it needs no approval.
            url = str(url or "").strip()
            if not url.lower().startswith("https://") or len(url) > 4000 or any(c.isspace() for c in url):
                return "Not saved: give the item's https link exactly as the owner gave it or a tool returned it."
            title = " ".join(str(title or "").split())[:300]
            if not title:
                return "Not saved: give it a title the owner will recognize."
            item = {"url": url, "title": title}
            kind = str(kind or "").strip().lower()
            if kind in LIBRARY_KINDS:
                item["kind"] = kind
            return with_reminder(json.dumps({"library_item": item,
                                             "note": "Saved to the owner's Library. Say so in a few words; they can open it there."}), config)

        async def file_link_async(url: str, title: str, kind: str = "", config: RunnableConfig = None) -> str:
            return file_link(url, title, kind, config)

        def keep_going(remaining: str) -> str:
            # The app reads this and starts the agent's next reply to carry the job on; it changes nothing.
            remaining = re.sub(r"\s+", " ", str(remaining or "")).strip()[:300] or "the rest of the job"
            return json.dumps({"keep_going": {"remaining": remaining},
                               "note": ("Studio starts your next reply right after this one to carry on. End this reply "
                                        "now with a line or two on what's done so far; don't ask the owner to say carry on.")})

        async def keep_going_async(remaining: str) -> str:
            return keep_going(remaining)

        def report_run(outcome: str, summary: str = "", config: RunnableConfig = None) -> str:
            # The app reads this to decide whether to notify the owner; it changes nothing.
            outcome = outcome if outcome in ("nothing_new", "update", "needs_you") else "update"
            note = "Reported. Finish your reply briefly."
            left = open_steps(thread_of(config))
            if left:
                listed = "; ".join(f"'{r['text']}' ({r['status'] or 'todo'})" for r in left[:6])
                note = (f"Reported. Your plan still shows {listed}. Call update_plan now with the whole plan as it "
                        "ended (each step done, blocked, or needs_you, with a note when it isn't done), then finish "
                        "your reply briefly.")
            return json.dumps({"run_report": {"outcome": outcome, "summary": " ".join(str(summary or "").split())[:300]},
                               "note": note})

        async def report_run_async(outcome: str, summary: str = "", config: RunnableConfig = None) -> str:
            return report_run(outcome, summary, config)

        def report_timeline(question: str, entries: list, causes: list | None = None) -> str:
            # Like remember, this changes nothing: the app reads the structured result, checks
            # each link against what this run's tools returned, and shows it as a timeline.
            def plain(v):
                return v.model_dump() if hasattr(v, "model_dump") else dict(v) if isinstance(v, dict) else {}
            # Models sometimes name the keys their own way (date, event, link); keep the record
            # rather than dropping the whole timeline, and refuse rows with no date or text.
            aliases = {"when": ("when", "date", "datetime", "time", "timestamp"),
                       "what": ("what", "event", "title", "description", "summary", "text"),
                       "url": ("url", "link", "href"), "app": ("app", "toolkit", "source")}
            rows = []
            for e in [plain(e) for e in (entries or [])][:80]:
                row = {k: next((e[a] for a in names if e.get(a)), None) for k, names in aliases.items()}
                rows.append({k: v for k, v in row.items() if v is not None})
            if not rows:
                return "Nothing to report: entries is empty."
            if not all(r.get("when") and r.get("what") for r in rows):
                return ("Not shown: every entry needs 'when' (ISO date) and 'what' (one sentence), plus 'app' and "
                        "'url' when known. Call report_timeline again with those keys.")
            return json.dumps({
                "timeline": {
                    "question": " ".join(str(question or "").split())[:300],
                    "entries": rows,
                    "causes": [plain(c) for c in (causes or [])][:10],
                },
                "note": "Timeline shown to the owner. Now answer briefly (the likely causes, for a why question) and say what you couldn't check.",
            })

        async def report_timeline_async(question: str, entries: list, causes: list | None = None) -> str:
            return report_timeline(question, entries, causes)

        def cite(sources: list) -> str:
            # Like report_timeline, this changes nothing: the app checks each link and quote
            # against what this run's tools returned and shows the ones that hold up as
            # numbered citations in the answer.
            def plain(v):
                return v.model_dump() if hasattr(v, "model_dump") else dict(v) if isinstance(v, dict) else {}
            aliases = {"n": ("n", "number", "id", "index"), "url": ("url", "link", "href"),
                       "quote": ("quote", "text", "excerpt", "passage", "snippet")}
            rows = []
            for e in [plain(e) for e in (sources or [])][:60]:
                row = {k: next((e[a] for a in names if e.get(a) not in (None, "")), None) for k, names in aliases.items()}
                rows.append({k: v for k, v in row.items() if v is not None})
            if not rows:
                return "Nothing to cite: sources is empty."
            if not all(r.get("n") is not None and r.get("url") and r.get("quote") for r in rows):
                return ("Not shown: every source needs 'n' (its number), 'url' (the link exactly as a tool returned it) and "
                        "'quote' (a short passage copied word for word from that result). Call cite again with those keys.")
            return json.dumps({
                "citations": {"sources": rows},
                "note": ("Now write your answer. Put [n] right after the sentence or figure each source supports, "
                         "e.g. 'Rated 4.5/5 from 9 reviews [2].' Don't add a list of sources or links at the end: "
                         "the owner sees them under your answer. If you'll end on a question with a few likely "
                         "answers (whether to go ahead, which first), ask it with ask_user after your answer "
                         "instead of writing it out."),
            })

        async def cite_async(sources: list) -> str:
            return cite(sources)
        def report_visual(kind: str, title: str, app: str = "", chart: str = "bar", unit: str = "",
                          labels: list | None = None, series: list | None = None, items: list | None = None,
                          columns: list | None = None, rows: list | None = None) -> str:
            # Like report_timeline, this changes nothing: the app validates the structured result
            # and draws it in Results next to the timeline. Only numbers and text the tools returned.
            def plain(v):
                return v.model_dump() if hasattr(v, "model_dump") else dict(v) if isinstance(v, dict) else {}
            def first(d, *names):
                return next((d[n] for n in names if d.get(n) not in (None, "")), None)
            kind = str(kind or "").strip().lower()
            visual = {"kind": kind, "title": " ".join(str(title or "").split())[:200], "app": str(app or "").strip().lower()}
            if kind == "chart":
                labels = [str(x) for x in (labels or [])][:31]
                lines = []
                for raw in [plain(x) for x in (series or [])][:4]:
                    values = first(raw, "values", "data", "points") or []
                    lines.append({"name": str(first(raw, "name", "label") or ""), "values": list(values)[:len(labels)]})
                if len(labels) < 2 or not lines or any(len(x["values"]) != len(labels) for x in lines):
                    return ("Not shown: a chart needs 2+ labels and 1-4 series, each with one value per label. "
                            "Call report_visual again.")
                visual.update({"chart": "line" if str(chart).lower() == "line" else "bar", "unit": str(unit or "")[:12],
                               "labels": labels, "series": lines})
            elif kind == "stats":
                stats = []
                for raw in [plain(x) for x in (items or [])][:6]:
                    stat = {"label": first(raw, "label", "name", "title"), "value": first(raw, "value", "number", "amount"),
                            "change": first(raw, "change", "delta"), "tone": first(raw, "tone")}
                    stats.append({k: str(v) for k, v in stat.items() if v is not None})
                if not stats or not all(x.get("label") and x.get("value") for x in stats):
                    return "Not shown: stats needs 1-6 items, each with label and value. Call report_visual again."
                visual["items"] = stats
            elif kind == "table":
                columns = [str(c) for c in (columns or [])][:6]
                table = [[str(c) for c in (r if isinstance(r, (list, tuple)) else [])][:len(columns)] for r in (rows or [])][:20]
                if len(columns) < 2 or not table:
                    return "Not shown: a table needs 2-6 columns and at least one row. Call report_visual again."
                visual.update({"columns": columns, "rows": table})
            else:
                return "Not shown: kind must be chart, stats, or table."
            return json.dumps({"visual": visual, "note": "Shown to the owner in Results; don't repeat it in your reply."})

        async def report_visual_async(kind: str, title: str, app: str = "", chart: str = "bar", unit: str = "",
                                      labels: list | None = None, series: list | None = None, items: list | None = None,
                                      columns: list | None = None, rows: list | None = None) -> str:
            return report_visual(kind, title, app, chart, unit, labels, series, items, columns, rows)

        def ask_user(questions: list) -> str:
            # Like remember, this changes nothing and doesn't wait: the app reads the structured
            # result and shows the questions as buttons under the reply. The owner's answer
            # arrives as their next message.
            def plain(v):
                return v.model_dump() if hasattr(v, "model_dump") else dict(v) if isinstance(v, dict) else {}
            items = []
            for q in [plain(q) for q in (questions or [])][:3]:
                # Models sometimes call the options "choices" and the question "text"; ask anyway.
                options = [{"label": o} if isinstance(o, str) else plain(o) for o in (q.get("options") or q.get("choices") or [])][:4]
                question = q.get("question") or q.get("text")
                if question and len(options) >= 2:
                    items.append({**{k: v for k, v in q.items() if k not in ("choices", "text")}, "question": question, "options": options})
            if not items:
                return "Nothing to ask: each question needs text and at least two options."
            return json.dumps({
                "ask_user": {"questions": items},
                "note": ("The owner now sees these questions with the options as buttons. End your reply here: "
                         "at most one short sentence, without repeating the question or listing the options. "
                         "Their answer arrives as their next message."),
            })

        async def ask_user_async(questions: list) -> str:
            return ask_user(questions)

        def show_form(title: str, fields: list, intro: str = "", submit_label: str = "") -> str:
            # Like ask_user, this changes nothing and doesn't wait: the app validates the form and
            # shows it under the reply. The owner's answers arrive as their next message.
            def plain(v):
                return v.model_dump() if hasattr(v, "model_dump") else dict(v) if isinstance(v, dict) else {}
            items = [f for f in (plain(f) for f in (fields or [])[:8]) if f.get("label") and (f.get("kind") or f.get("type"))]
            if not str(title or "").strip() or not items:
                return "Not shown: a form needs a title and at least one field with a kind and a label."
            return json.dumps({
                "form": {"title": " ".join(str(title).split())[:120], "intro": str(intro or "")[:600],
                         "fields": items, "submit_label": " ".join(str(submit_label or "").split())[:30]},
                "note": ("The owner now sees this form. End your reply here: at most one short sentence, without "
                         "repeating the fields. Their answers arrive as their next message."),
            })

        async def show_form_async(title: str, fields: list, intro: str = "", submit_label: str = "") -> str:
            return show_form(title, fields, intro, submit_label)

        def propose_agent(summary: str, profile: str = "", instructions: str = "", skills: list | None = None,
                          tasks: list | None = None, memories: list | None = None, identity: dict | None = None,
                          sound: list | None = None, assumptions: list | None = None) -> str:
            # Changes nothing: the app shows the proposal as a card, and only the owner's Apply
            # changes this agent's setup (or, for a name or a voice, the member's own pick). The
            # app checks each voice against Studio's catalog and drops the rest.
            def plain(v):
                return v.model_dump() if hasattr(v, "model_dump") else dict(v) if isinstance(v, dict) else v
            self_ = plain(identity) if identity else {}
            name = " ".join(str((self_ or {}).get("name") or "").split())[:40]
            proposal = {"summary": str(summary or "")[:600], "profile": str(profile or "")[:8000],
                        "instructions": str(instructions or "")[:8000], "skills": [plain(x) for x in (skills or [])][:8],
                        "tasks": [plain(x) for x in (tasks or [])][:8], "memories": [str(m)[:500] for m in (memories or [])][:8]}
            if name:
                proposal["identity"] = {"name": name, "manner": str(self_.get("manner") or "")[:600]}
            options = []
            for option in (plain(x) for x in (sound or [])):
                voice = " ".join(str((option or {}).get("voice") or "").split()).lower()[:40] if isinstance(option, dict) else ""
                if voice:
                    options.append({"voice": voice, "manner": str(option.get("manner") or "")[:600]})
            if options:
                proposal["sound"] = options[:3]
            guesses = [" ".join(str(a).split())[:300] for a in (assumptions or []) if str(a).strip()]
            if guesses:
                proposal["assumptions"] = guesses[:6]
            if not any(proposal.get(k) for k in ("profile", "instructions", "skills", "tasks", "memories", "identity", "sound")):
                return ("Not shown: propose at least one change (profile, instructions, skills, tasks, memories, identity, "
                        "or sound).")
            # A name alone is its own card, under the reply, with a Keep button: the sentence after
            # the call sits right above it, so it offers the name rather than saying how to keep it.
            only_name = "identity" in proposal and not any(proposal.get(k) for k in ("profile", "instructions", "skills", "tasks", "memories", "sound"))
            return json.dumps({
                "proposal": proposal,
                "note": ("The member sees what you've written, with your name and manner on a card under it and a "
                         "button to keep it; nothing changes until they do. End your reply here with one short "
                         "sentence offering the name in your own words, without repeating what you've written."
                         if only_name else
                         "The owner now sees your proposal and can apply all or part of it; nothing changes until "
                         "they do. " + ("They also see your guesses and can fix any of them; a fix arrives as their "
                                        "next message, so propose again with it. End your reply here with one short "
                                        "sentence asking them to check your guesses."
                                        if guesses else "End your reply here with one short sentence.")),
            })

        async def propose_agent_async(summary: str, profile: str = "", instructions: str = "", skills: list | None = None,
                                      tasks: list | None = None, memories: list | None = None, identity: dict | None = None,
                                      sound: list | None = None, assumptions: list | None = None) -> str:
            return propose_agent(summary, profile, instructions, skills, tasks, memories, identity, sound, assumptions)

        def merge_memories(merges: list, summary: str = "") -> str:
            # Changes nothing: the app checks each fact id against the owner's memory, shows the
            # merges as a card, and only the owner's click merges them (with an Undo).
            def plain(v):
                return v.model_dump() if hasattr(v, "model_dump") else dict(v) if isinstance(v, dict) else {}
            items = []
            for m in (plain(m) for m in (merges or [])[:8]):
                ids = [str(i).strip() for i in (m.get("replaces") or []) if str(i).strip()]
                text = " ".join(str(m.get("text") or "").split())[:500]
                if text and len(set(ids)) >= 2:
                    item = {"replaces": list(dict.fromkeys(ids))[:12], "text": text}
                    if m.get("category") in MEMORY_CATEGORIES:
                        item["category"] = m["category"]
                    items.append(item)
            if not items:
                return "Not shown: each merge needs the merged text and at least two fact ids it replaces."
            return json.dumps({
                "memory_merge": {"summary": " ".join(str(summary or "").split())[:600], "merges": items},
                "note": ("The owner now sees these merges and picks which to make; nothing changes until they do. "
                         "End your reply here with one or two short sentences."),
            })

        async def merge_memories_async(merges: list, summary: str = "") -> str:
            return merge_memories(merges, summary)

        def offer_call(reason: str, topic: str = "") -> str:
            # Changes nothing and rings no one: the app shows a "Hop on a call?" card under the
            # reply (only to members who can take one), and a call starts only if they tap Call.
            reason = " ".join(str(reason or "").split())[:200]
            if not reason:
                return "Not shown: an offer needs one sentence on why a call would help."
            return json.dumps({
                "offer_call": {"reason": reason, "topic": " ".join(str(topic or "").split())[:80]},
                "note": ("The owner now sees a 'Hop on a call?' card with Call and Not now under your reply. Don't "
                         "repeat the offer in your text; if they don't take it, carry on in text. Don't offer again "
                         "in this conversation once they've said Not now."),
            })

        async def offer_call_async(reason: str, topic: str = "") -> str:
            return offer_call(reason, topic)

        def request_secret(kind: str, reason: str, username_hint: str = "") -> str:
            # Changes nothing and carries no secret: the app shows a card where the member picks a
            # saved login or card (or types one, or the code a site sent them), and the app types it
            # into this conversation's browser itself. The agent hears only that it was filled, never the values.
            kind = str(kind or "").strip().lower()
            if kind not in ("login", "card", "code"):
                return "Not shown: kind must be 'login', 'card', or 'code'."
            reason = " ".join(str(reason or "").split())[:200]
            if not reason:
                return "Not shown: say in one sentence why you need it."
            return json.dumps({
                "secret_request": {"kind": kind, "reason": reason, "username_hint": " ".join(str(username_hint or "").split())[:200]},
                "note": ("The owner now sees a secure card that fills this into your browser's current page; you will "
                         "never see the values. End your reply here with one short sentence, without asking for them, "
                         "and leave your browser open while they get it. A message saying what was filled arrives next; "
                         "then carry on (e.g. press Sign in or Verify). If the site then asks for a code it sent them, "
                         "look for it in their connected email if you can, else call request_secret with kind 'code'. "
                         "Never ask for a password, card number, or card security code in chat or a form."),
            })

        async def request_secret_async(kind: str, reason: str, username_hint: str = "") -> str:
            return request_secret(kind, reason, username_hint)

        def save_file(name: str, link: str = "") -> str:
            # Changes nothing: the app fetches the file from this conversation's browser itself (with
            # the page's own sign-in), or prints the open page as a PDF, and saves it for the owner
            # under their own session, shown under the reply. No file passes through this flow.
            name = " ".join(str(name or "").split())[:120].strip(" .")
            if not name:
                return "Not saved: give the file a name the owner will recognize, e.g. 'Label - Jane Doe.pdf'."
            link = str(link or "").strip()
            if link and (len(link) > 4000 or any(c.isspace() for c in link) or
                         not re.match(r"(?i)^(https://|/|\.{0,2}/|blob:https://|[a-z0-9_.~%-]+(/|\?|$))", link)):
                return "Not saved: give the file's link exactly as the page has it, or leave it out to save the page you have open."
            return json.dumps({
                "browser_file": {"name": name, **({"link": link} if link else {})},
                "note": ("Studio is getting this file from your browser for the owner: it shows under your reply as "
                         "a file they can download. " + ("" if link else "It saves the page you have open now, so "
                         "don't leave that page in this reply. ") + "Say so in a few words. From your next reply on, "
                         "CONTEXT lists it with what you need to attach it to an email, if they want it emailed."),
            })

        async def save_file_async(name: str, link: str = "") -> str:
            return save_file(name, link)

        def hand_browser(reason: str, site: str = "") -> str:
            # Changes nothing: the app shows a "Your turn in the browser" card under the reply, and
            # the owner gets the browser only when they tap Take over (for a CAPTCHA, or a page only
            # they can use). You never see what they do there; their Done arrives as their next message.
            reason = " ".join(str(reason or "").split())[:200]
            if not reason:
                return "Not shown: say in one sentence what they need to do in the browser."
            return json.dumps({
                "hand_browser": {"reason": reason, "site": " ".join(str(site or "").split())[:40]},
                "note": ("The owner now sees a card to take over your browser where you left it, and Done to hand it "
                         "back. End your reply here with one short sentence; don't explain how to take over. When "
                         "their Done arrives, look at the page again before going on: they may have gone elsewhere, "
                         "or not finished."),
            })

        async def hand_browser_async(reason: str, site: str = "") -> str:
            return hand_browser(reason, site)

        def watch_me(job: str, site: str = "") -> str:
            # Changes nothing: the app shows a "Show me how" card under the reply. Only on the owner's
            # tap do they drive your browser through Studio, which notes each step (never what goes
            # into a password, card, or code field) and what they say; their Done sends it as their
            # next message. The card is the same kind as hand_browser's, marked to watch.
            job = " ".join(str(job or "").split())[:200]
            if not job:
                return "Not shown: say in one sentence which job they'll show you."
            return json.dumps({
                "hand_browser": {"reason": job, "site": " ".join(str(site or "").split())[:40], "watch": True},
                "note": ("The owner now sees a card to show you the job in your browser, from the page you have "
                         "open. End your reply here with one short sentence inviting them to show you and to say "
                         "why they choose what they choose; don't explain the card. Their steps and notes arrive "
                         "as their next message: write them up as a skill (what they meant, not their clicks) and "
                         "propose it with propose_agent, with your guesses in assumptions."),
            })

        async def watch_me_async(job: str, site: str = "") -> str:
            return watch_me(job, site)

        available = capabilities(registry)
        offers = f"Available behind it: {', '.join(available)}. " if available else ""
        self.status = f"Gateway registered {len(registry)} tools; agent sees discover_tools, execute_tool, take_action, read_result, remember, file_link, keep_going, report_timeline, report_visual, cite, ask_user, show_form, propose_agent, merge_memories, offer_call, request_secret, hand_browser, watch_me, save_file"
        return [
            StructuredTool.from_function(
                func=discover, coroutine=discover_async, name="discover_tools",
                args_schema=DiscoverArgs,
                description=(f"Discover relevant tools. {offers}When the user asks you to look something up, search, "
                             "research, or check something, use a tool rather than answering from memory. Returns exact "
                             "names and compact argument schemas; query again if task changes. Call a returned tool "
                             "through execute_tool or take_action, never by its name directly."),
            ),
            StructuredTool.from_function(
                func=execute_sync, coroutine=execute_async, name="execute_tool",
                args_schema=ExecuteArgs,
                description=("Execute a discovered tool by exact name with schema-valid arguments: looking things up, "
                             "working with data, and doing the job in the owner's accounts (sending, creating, updating, "
                             "browser steps). Only paying, buying, moving money, or deleting for good must use "
                             "take_action instead. Errors are not successful results."),
            ),
            StructuredTool.from_function(
                func=action_sync, coroutine=action_async, name="take_action",
                args_schema=ActionArgs,
                description=("Do something that pays, buys, moves money, or deletes for good in the owner's accounts, "
                             "including a browser step that pays or places an order. The first time for each kind, the "
                             "owner sees your summary and approves or declines before it runs; once they approve a kind, "
                             "it runs without asking. If declined, don't retry it, say what you would have done instead."),
                metadata={"approval_actions": ["approve", "reject"]},
            ),
            StructuredTool.from_function(
                func=read_result, coroutine=read_result_async, name="read_result",
                args_schema=ReadResultArgs,
                description=("Read more of a long result that came back in part (it ends with [PARTIAL RESULT ...] and "
                             "gives a result_id and offset), a page at a time. Needs no approval and changes nothing. "
                             "Use it to read a whole transcript or document instead of running the step again."),
            ),
            StructuredTool.from_function(
                func=remember, coroutine=remember_async, name="remember",
                args_schema=MemoryArgs,
                description=("Remember a lasting fact for future conversations: how the owner works, their goals, the people and "
                             "organizations they deal with, standing preferences, or a correction to something you remembered. Call it on "
                             "your own whenever you learn one, without asking; the owner can undo it. Never one-off "
                             "results, links, or numbers that go stale, and nothing already in what you remember. When it "
                             "changes or restates a fact you saved, pass that fact's id in replaces so the new one takes its "
                             "place rather than adding a copy."),
            ),
            StructuredTool.from_function(
                func=update_plan, coroutine=update_plan_async, name="update_plan",
                args_schema=PlanArgs,
                description=("Keep the plan for work with several steps, or work that spans more than one reply (a "
                             "task's run, the setup interview, or anything else in a conversation): the whole list of "
                             "steps each time, and the goal, what done looks like, in the words you said it in. Not for "
                             "a simple answer. Call it when you make the plan, when the goal or the steps change, and "
                             "when a step is blocked, needs the owner, or is finished. Saved for the owner, who sees it "
                             "above the chat; changes nothing in their accounts."),
            ),
            StructuredTool.from_function(
                func=save_record, coroutine=save_record_async, name="save_record",
                args_schema=RecordArgs,
                description=("Add or update one row in the owner's tracker: a list kept across conversations, e.g. job "
                             "applications, people contacted, companies researched. Saving the same collection and key "
                             "again updates that row, so check the tracker in CONTEXT before adding. Only when "
                             "CONTEXT has a tracker section; otherwise nothing would be kept. Use it for "
                             "things the owner will want to follow over time, not one-off answers. Saved for the owner; "
                             "changes nothing in their accounts."),
            ),
            StructuredTool.from_function(
                func=file_link, coroutine=file_link_async, name="file_link",
                args_schema=LibraryArgs,
                description=("Save a link to the owner's Library when they ask you to keep one there (e.g. 'save this "
                             "doc to my library'), such as a doc they share or one you found. Only a link they gave you "
                             "or a tool returned, never one you made up; docs your tools create are filed on their own. "
                             "Saved for the owner; changes nothing in their accounts."),
            ),
            StructuredTool.from_function(
                func=keep_going, coroutine=keep_going_async, name="keep_going",
                args_schema=KeepGoingArgs,
                description=("When this reply is running out of time (a tool says so) and the job isn't done, but the "
                             "rest needs nothing from the owner: call it last, with what's left, and Studio starts your "
                             "next reply right away to carry on. Use it instead of asking them to say carry on. Not "
                             "when you need their decision, answer, or approval. Changes nothing."),
            ),
            StructuredTool.from_function(
                func=report_run, coroutine=report_run_async, name="report_run",
                args_schema=RunReportArgs,
                description=("Only in a conversation that works on a task: once this run's work is done, say whether "
                             "the owner should hear about it. They get a notification for update and needs_you, none "
                             "for nothing_new. Changes nothing."),
            ),
            StructuredTool.from_function(
                func=report_timeline, coroutine=report_timeline_async, name="report_timeline",
                args_schema=TimelineArgs,
                description=("Only when the request asks you to investigate something: after reading the owner's apps, "
                             "report the dated records you found, each with the record's link exactly as a tool returned "
                             "it, and, for a why question, the likely causes. The owner sees it as a timeline. Changes nothing."),
            ),
            StructuredTool.from_function(
                func=cite, coroutine=cite_async, name="cite",
                args_schema=CiteArgs,
                description=("Before writing an answer that states facts you got from tool results (web pages, emails, "
                             "files, records), list the sources you'll cite: a number, the link exactly as the tool "
                             "returned it, and a short passage copied word for word from that result. Then write [n] "
                             "after each fact in your answer. The owner sees numbered citations they can check. "
                             "Changes nothing."),
            ),
            StructuredTool.from_function(
                func=report_visual, coroutine=report_visual_async, name="report_visual",
                args_schema=VisualArgs,
                description=("Show what you found, in the owner's apps or in your research, as a chart (numbers over "
                             "time or by category), key numbers, or a comparison table (e.g. roles or options side by "
                             "side on what the owner weighs: pay, location, stage, fit), when seeing it beats reading "
                             "it. Call it once per visual, only with numbers and facts a tool returned. Changes nothing."),
            ),
            StructuredTool.from_function(
                func=ask_user, coroutine=ask_user_async, name="ask_user",
                args_schema=AskArgs,
                description=("Ask the owner a question with a few choices to click, when you need their decision or a "
                             "missing detail and can't sensibly pick a default yourself (which of several matching "
                             "records, which way to go, whether to take a next step, a preference). Use it instead of "
                             "ending your reply on such a question in text. Don't use it to confirm a change to their "
                             "accounts (take_action already asks), or for things you can look up. Call it as the last "
                             "thing in your reply; their answer arrives as the next message."),
            ),
            StructuredTool.from_function(
                func=show_form, coroutine=show_form_async, name="show_form",
                args_schema=FormArgs,
                description=("Show the owner a short form when you need several details at once, an order of priorities "
                             "(rank), a point on a scale, their verdict on results you found (verdict), longer "
                             "answers, files (a resume, a price list), repeatable entries (stories, contacts), or "
                             "apps to connect: for example while setting up this agent. Whenever you bring them "
                             "results to act on (roles, leads, options you found), show those in one verdict field "
                             "so they keep or pass each. Draft answers they can react to and prefill what you already know, so "
                             "they mostly pick, order, or fix rather than type. Use ask_user instead for one quick "
                             "choice. Call it as the last thing in your reply; their answers arrive as the next "
                             "message. Changes nothing."),
            ),
            StructuredTool.from_function(
                func=propose_agent, coroutine=propose_agent_async, name="propose_agent",
                args_schema=ProposeArgs,
                description=("Propose how this agent should be set up for the owner: what it's for, its standing "
                             "instructions, skills to add, tasks to switch on (with schedules), facts to remember, "
                             "(identity) a name and manner for yourself when you introduce yourself or they offer one, "
                             "and (sound) ways you could sound, when your context lists voices. "
                             "Use it once you've learned what they want, e.g. at the end of setup or when they ask "
                             "you to change how you work. The owner reviews it and applies what they want; nothing "
                             "changes until they do. Call it as the last thing in your reply."),
            ),
            StructuredTool.from_function(
                func=merge_memories, coroutine=merge_memories_async, name="merge_memories",
                args_schema=MergeArgs,
                description=("Propose combining facts you remember that overlap or repeat into fewer, clearer ones, "
                             "naming each fact by an id you were given (as when tidying up memory). Each merged fact "
                             "keeps every detail of the ones it replaces that's still true (a newer fact wins over an older one). The owner reviews the merges and makes the "
                             "ones they want, and can undo them; nothing changes until they do. Call it once, as the "
                             "last thing in your reply."),
            ),
            StructuredTool.from_function(
                func=offer_call, coroutine=offer_call_async, name="offer_call",
                args_schema=OfferCallArgs,
                description=("Offer to talk something through with the owner on a live call, only when CONTEXT says "
                             "they can talk with you on a call. Your judgment: when a decision trades off several "
                             "things, or typing has gone back and forth a few times without settling. It only "
                             "offers; it never starts a call, and they may say Not now. Never on a call, and not "
                             "again in a conversation where they said Not now. Call it after your reply (and after "
                             "show_form or ask_user, if any). Changes nothing."),
            ),
            StructuredTool.from_function(
                func=request_secret, coroutine=request_secret_async, name="request_secret",
                args_schema=SecretArgs,
                description=("When your browser reaches a sign-in form, a payment form, or a page asking for a one-time "
                             "code the site sent the owner (two-step verification), ask the owner to fill it in "
                             "securely: they pick a saved login or card (or type one, or the code) and Studio types it "
                             "into the page you have open. You never see it. Open the page with the fields first. Never "
                             "ask for passwords, card numbers, or card security codes any other way. Call it as the "
                             "last thing in your reply. Changes nothing."),
            ),
            StructuredTool.from_function(
                func=save_file, coroutine=save_file_async, name="save_file",
                args_schema=SaveFileArgs,
                description=("Give the owner a file from your browser, such as a shipping label, receipt, or invoice "
                             "the site made: Studio fetches it with the page's own sign-in (or, with no link, saves the "
                             "page you have open as a PDF) and puts it under your reply for them to download. Use it "
                             "whenever they need the file itself; a file the site downloads otherwise stays in your "
                             "browser. Saved for the owner; changes nothing in their accounts."),
            ),
            StructuredTool.from_function(
                func=hand_browser, coroutine=hand_browser_async, name="hand_browser",
                args_schema=HandBrowserArgs,
                description=("Hand your browser to the owner only for a CAPTCHA (an 'I'm not a robot' check or picture "
                             "puzzle), or when they have to use the page themself and nothing else will do: signing "
                             "in with Google or another account button, a passkey, or choosing something only they "
                             "can. They take over where you left off and hand it back; you never see what they do. "
                             "Not for a sign-in or payment form (use request_secret), and not for a code sent to "
                             "their phone or email: find the code in their connected email if you can, otherwise "
                             "ask them for it, then type it in yourself. Open the page first, then call it as the "
                             "last thing in your reply; their Done arrives as the next message. Never for something "
                             "you can do yourself, and never to get around their approval of a change. Changes "
                             "nothing."),
            ),
            StructuredTool.from_function(
                func=watch_me, coroutine=watch_me_async, name="watch_me",
                args_schema=WatchArgs,
                description=("When the owner wants to show you how they do a job in a browser so you can learn it "
                             "('let me show you', 'watch me do it', or the Show me once skill): open the page where "
                             "the job starts, then call this. They do the job once in your browser while Studio "
                             "notes each step and what they say (never passwords or card details); their steps "
                             "arrive as their next message, for you to write up as a skill. Don't do the job "
                             "yourself first. Call it as the last thing in your reply. Changes nothing."),
            ),
        ]
