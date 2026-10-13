"""Installs the Studio components into a Langflow flow, in place, after backing it up.

    python3 langflow/install.py <flow-id> [--copy "Name"] [--strip-apps]

Reads LANGFLOW_BASE_URL and LANGFLOW_API_KEY from the environment. Does three things:
  1. Replaces the Tool Gateway's code with langflow/components/tool_gateway.py (adds the
     approval-gated take_action and propose_memory).
  2. Adds a Workspace Context node feeding the Agent's instructions, carrying the Agent's
     current prompt as its base, so the app's settings and confirmed memories reach the agent.
  3. Marks the per-run fields (workspace context, chat input files) as API-editable.
Then prints the LANGFLOW_TWEAKS value the app needs.

--copy saves the result as a new flow instead of changing this one. --strip-apps (with
--copy) drops MCP and search tool nodes, for a test flow that can't act on real accounts.
"""

import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ["LANGFLOW_BASE_URL"].rstrip("/")
KEY = os.environ["LANGFLOW_API_KEY"]


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"Content-Type": "application/json", "x-api-key": KEY})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def main(argv):
    flow_id = argv[0]
    copy_name = argv[argv.index("--copy") + 1] if "--copy" in argv else None
    strip = "--strip-apps" in argv
    if strip and not copy_name:
        sys.exit("--strip-apps only makes sense with --copy")

    flow = call("GET", f"/api/v1/flows/{flow_id}")
    backup = os.path.join(HERE, f"backup-{flow_id}-{int(time.time())}.json")
    with open(backup, "w") as f:
        json.dump(flow, f)
    print("backed up to", backup)

    data = flow["data"]
    by_type = lambda t: next((n for n in data["nodes"] if n["data"].get("type") == t), None)
    agent, gateway, chat_input = by_type("Agent"), by_type("ToolGatewayComponent"), by_type("ChatInput")
    if not (agent and gateway and chat_input):
        sys.exit("the flow needs an Agent, a Tool Gateway, and a Chat Input")

    if strip:
        drop = {n["data"]["id"] for n in data["nodes"] if n["data"].get("type") in ("MCPTools", "MCP") or n["data"]["id"].startswith("ext:exa")}
        data["nodes"] = [n for n in data["nodes"] if n["data"]["id"] not in drop]
        data["edges"] = [e for e in data["edges"] if e["source"] not in drop and e["target"] not in drop]

    gateway["data"]["node"]["template"]["code"]["value"] = open(os.path.join(HERE, "components/tool_gateway.py")).read()
    chat_input["data"]["node"]["template"]["files"]["api_editable"] = True

    node = call("POST", "/api/v1/custom_component", {"code": open(os.path.join(HERE, "components/workspace_context.py")).read()})["data"]
    existing = by_type("WorkspaceContext")
    prompt_field = agent["data"]["node"]["template"]["system_prompt"]
    if existing:
        context_id = existing["data"]["id"]
        base_prompt = existing["data"]["node"]["template"]["base_prompt"]["value"]
        data["nodes"].remove(existing)
    else:
        context_id = "WorkspaceContext-studio"
        base_prompt = prompt_field.get("value") or ""
    node["template"]["base_prompt"]["value"] = base_prompt
    node["template"]["workspace_context"]["api_editable"] = True
    pos = agent["position"]
    data["nodes"].append({
        "id": context_id,
        "type": "genericNode",
        "position": {"x": pos["x"] - 450, "y": pos["y"] + 380},
        "data": {"id": context_id, "type": "WorkspaceContext", "node": node, "showNode": True},
    })
    prompt_field["value"] = ""
    agent_id = agent["data"]["id"]
    data["edges"] = [e for e in data["edges"] if not (e["target"] == agent_id and e["data"]["targetHandle"]["fieldName"] == "system_prompt")]
    source = {"dataType": "WorkspaceContext", "id": context_id, "name": "system_prompt", "output_types": ["Message"]}
    target = {"fieldName": "system_prompt", "id": agent_id, "inputTypes": ["Message"], "type": "str"}
    enc = lambda d: json.dumps(d, separators=(",", ":")).replace('"', "œ")
    data["edges"].append({
        "source": context_id,
        "target": agent_id,
        "sourceHandle": enc(source),
        "targetHandle": enc(target),
        "data": {"sourceHandle": source, "targetHandle": target},
        "id": f"xy-edge__{context_id}{enc(source)}-{agent_id}{enc(target)}",
        "selected": False,
        "animated": False,
        "className": "",
    })

    if copy_name:
        result = call("POST", "/api/v1/flows/", {"name": copy_name, "data": data, "folder_id": flow.get("folder_id")})
        print("created flow", result["id"])
    else:
        call("PATCH", f"/api/v1/flows/{flow_id}", {"data": data})
        print("updated flow", flow_id)

    tweaks = {context_id: {"workspace_context": "{{system_context}}"}, chat_input["data"]["id"]: {"files": "{{files}}"}}
    print("\nSet in the app's environment:\nLANGFLOW_TWEAKS=" + json.dumps(tweaks, separators=(",", ":")))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
