"""Copies a flow from one Langflow server to another, under the same name.

    python3 langflow/deploy/export_flow.py <flow-id>

Reads LANGFLOW_BASE_URL and LANGFLOW_API_KEY (the source, e.g. Langflow desktop) and
TARGET_LANGFLOW_BASE_URL and TARGET_LANGFLOW_API_KEY (the hosted server) from the
environment. Prints the new flow's id.

Global variables are not copied: they hold secrets, and a flow only names them. The script
lists the names the flow references so you can create them on the target. A secret typed
straight into a field (not a global variable) would travel with the flow, so it is reported
too; move it into a global variable before exporting.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request

SOURCE = (os.environ["LANGFLOW_BASE_URL"].rstrip("/"), os.environ["LANGFLOW_API_KEY"])
TARGET = (os.environ["TARGET_LANGFLOW_BASE_URL"].rstrip("/"), os.environ["TARGET_LANGFLOW_API_KEY"])

# Server-specific: the target assigns its own ids, owner, and folder.
DROP = {"id", "user_id", "folder_id", "workspace_id", "fs_path", "updated_at", "created_at", "name_key"}

# Model fields don't name their key; Langflow reads it from the provider's global variable.
PROVIDER_VARIABLES = {
    "OpenAI": ["OPENAI_API_KEY"],
    # The lfx-openai-compatible extension (OpenRouter, Together, vLLM, ...), not plain OpenAI.
    "OpenAI Compatible": ["OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_BASE_URL"],
    "Anthropic": ["ANTHROPIC_API_KEY"],
    "Google Generative AI": ["GOOGLE_API_KEY"],
    "Groq": ["GROQ_API_KEY"],
    "OpenRouter": ["OPENROUTER_API_KEY"],
    "Azure OpenAI": ["AZURE_OPENAI_API_KEY"],
    "Ollama": ["OLLAMA_BASE_URL"],
}


def call(server, method, path, body=None):
    base, key = server
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method, headers={"Content-Type": "application/json", "x-api-key": key})
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {base}{path} failed: {e.code} {e.read().decode(errors='replace')[:500]}")


def referenced(data):
    """(global variable names, node.field pairs holding a literal secret)."""
    names, literals = set(), []
    for n in data.get("nodes", []):
        node = n.get("data", {})
        for field, spec in (node.get("node", {}).get("template") or {}).items():
            if not isinstance(spec, dict):
                continue
            if spec.get("load_from_db") and spec.get("value"):
                names.add(spec["value"])
            elif field == "model" and isinstance(spec.get("value"), list):
                for model in spec["value"]:
                    provider = isinstance(model, dict) and model.get("provider")
                    names.update(PROVIDER_VARIABLES.get(provider, [f"<the {provider} provider's key>"] if provider else []))
            elif field == "mcp_server" and isinstance(spec.get("value"), dict):
                # An MCP server's headers and env name global variables Langflow created for
                # them (e.g. MCP_BROWSERBASE_AUTHORIZATION_<hash>).
                config = spec["value"].get("config") or {}
                for value in [*(config.get("headers") or {}).values(), *(config.get("env") or {}).values()]:
                    if isinstance(value, str) and re.fullmatch(r"[A-Z][A-Z0-9_]+", value):
                        names.add(value)
            elif spec.get("password") and spec.get("value"):
                literals.append(f"{node.get('id')}.{field}")
    return sorted(names), literals


def main(argv):
    if SOURCE[0] == TARGET[0]:
        sys.exit("source and target are the same server")
    flow_id = argv[0]
    flow = call(SOURCE, "GET", f"/api/v1/flows/{flow_id}")
    names, literals = referenced(flow.get("data") or {})
    if literals:
        sys.exit("these fields hold a literal secret; move them into global variables first:\n  " + "\n  ".join(literals))

    body = {k: v for k, v in flow.items() if k not in DROP and v is not None}
    created = call(TARGET, "POST", "/api/v1/flows/", body)
    if created.get("name") != flow["name"]:
        print(f"note: the target already had a flow named {flow['name']!r}; saved as {created.get('name')!r}")
    print("created flow", created["id"])

    existing = {v["name"] for v in call(TARGET, "GET", "/api/v1/variables/")}
    missing = [n for n in names if n not in existing]
    if names:
        print("\nThe flow reads these global variables (not copied; create them on the target as Credential):")
        for n in names:
            print(f"  {n}{'' if n in missing else '  (already exists)'}")
    print(f"\nNext: LANGFLOW_BASE_URL={TARGET[0]} LANGFLOW_API_KEY=<target key> python3 langflow/install.py {created['id']}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
