"""Installs the Studio components into a Langflow flow, in place, after backing it up.

    python3 langflow/install.py <flow-id> [--copy "Name"] [--strip-apps] [--keep-python]

Reads LANGFLOW_BASE_URL and LANGFLOW_API_KEY from the environment. Does these things:
  1. Replaces the Tool Gateway's code with langflow/components/tool_gateway.py (adds the
     approval-gated take_action and remember).
  2. Adds a Workspace Context node feeding the Agent's instructions, with
     langflow/agent_instructions.md as its base, so the app's settings and confirmed memories
     reach the agent.
  3. Marks the per-run fields (workspace context, chat input files) as API-editable.
  4. Removes Supermemory MCP nodes. One connection would be shared by every workspace; the
     app keeps memory per workspace and member instead, and the agent saves via remember.
  5. Replaces shared Composio MCP nodes (one account for everyone) with a Member Apps node
     that opens a Composio session for the calling member only. It reads the Langflow
     global variable COMPOSIO_API_KEY, which must be a Composio *project* key.
  6. Replaces shared Browserbase MCP nodes (one browser for every tenant: the hosted server
     keeps one browser per MCP connection, and Langflow reuses one connection per URL and
     key) with a Studio Browser node that opens a connection, and so a browser, per
     conversation. It sends the same credential header, from the same Langflow global
     variable, as the shared node's server config.
  7. Installs Load Skill from langflow/components/load_skill.py if the flow has one.
  8. Moves a literal Exa key into the Langflow global variable EXA_API_KEY, and has each Exa
     search return at least 10 results, so research (a job search, a market scan) draws on
     more than a handful of sources.
  9. Removes Python REPL nodes: they run code inside the Langflow server, next to every
     tenant's keys. Pass --keep-python only if the server has LANGFLOW_SANDBOX_BACKEND set.
     (Members' code runs in their own Composio workbench instead.)
 10. Turns on "Use Cached Server" for the remaining MCP nodes (shared services with one
     service key that hold no per-tenant state), so their tools aren't re-listed on every run.
 11. Lets the Agent read at least the last 20 messages of the conversation, so it keeps
     the topic of a longer chat instead of falling back on the business profile.
Then prints the LANGFLOW_TWEAKS value the app needs.

--copy saves the result as a new flow instead of changing this one. --strip-apps (with
--copy) drops MCP and search tool nodes, for a test flow that can't act on real accounts.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ["LANGFLOW_BASE_URL"].rstrip("/")
KEY = os.environ["LANGFLOW_API_KEY"]
MIN_HISTORY = 20
MIN_SEARCH_RESULTS = 10


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
        drop = {n["data"]["id"] for n in data["nodes"] if n["data"].get("type") in ("MCPTools", "MCP", "StudioBrowser") or n["data"]["id"].startswith("ext:exa")}
        data["nodes"] = [n for n in data["nodes"] if n["data"]["id"] not in drop]
        data["edges"] = [e for e in data["edges"] if e["source"] not in drop and e["target"] not in drop]

    def is_supermemory(n):
        server = (n["data"].get("node", {}).get("template", {}).get("mcp_server") or {}).get("value") or {}
        return isinstance(server, dict) and "supermemory" in json.dumps(server).lower()

    drop = {n["data"]["id"] for n in data["nodes"] if is_supermemory(n)}
    if drop:
        print("removing shared Supermemory connection:", ", ".join(sorted(drop)))
        data["nodes"] = [n for n in data["nodes"] if n["data"]["id"] not in drop]
        data["edges"] = [e for e in data["edges"] if e["source"] not in drop and e["target"] not in drop]

    enc = lambda d: json.dumps(d, separators=(",", ":")).replace('"', "œ")

    def connect(source_id, source_type, output, target_id, field, input_types, field_type):
        source = {"dataType": source_type, "id": source_id, "name": output, "output_types": input_types}
        target = {"fieldName": field, "id": target_id, "inputTypes": input_types, "type": field_type}
        data["edges"].append({
            "source": source_id,
            "target": target_id,
            "sourceHandle": enc(source),
            "targetHandle": enc(target),
            "data": {"sourceHandle": source, "targetHandle": target},
            "id": f"xy-edge__{source_id}{enc(source)}-{target_id}{enc(target)}",
            "selected": False,
            "animated": False,
            "className": "",
        })

    def mcp_url(n):
        server = (n["data"].get("node", {}).get("template", {}).get("mcp_server") or {}).get("value") or {}
        return json.dumps(server).lower() if isinstance(server, dict) else ""

    gateway_id = gateway["data"]["id"]
    shared = [n for n in data["nodes"] if n["data"].get("type") in ("MCPTools", "MCP") and "composio" in mcp_url(n)]
    member_apps_id = None
    if not strip and (shared or by_type("MemberApps")):
        drop = {n["data"]["id"] for n in shared}
        existing = by_type("MemberApps")
        if existing:
            drop.add(existing["data"]["id"])
        if shared:
            print("replacing shared Composio connection:", ", ".join(sorted(n["data"]["id"] for n in shared)))
        anchor = (existing or shared[0])["position"]
        data["nodes"] = [n for n in data["nodes"] if n["data"]["id"] not in drop]
        data["edges"] = [e for e in data["edges"] if e["source"] not in drop and e["target"] not in drop]
        apps = call("POST", "/api/v1/custom_component", {"code": open(os.path.join(HERE, "components/composio_member.py")).read()})["data"]
        apps["template"]["api_key"]["load_from_db"] = True
        apps["template"]["api_key"]["value"] = "COMPOSIO_API_KEY"
        for field in ("member_id", "toolkits"):
            apps["template"][field]["api_editable"] = True
        member_apps_id = "MemberApps-studio"
        data["nodes"].append({
            "id": member_apps_id,
            "type": "genericNode",
            "position": anchor,
            "data": {"id": member_apps_id, "type": "MemberApps", "node": apps, "showNode": True},
        })
        connect(member_apps_id, "MemberApps", "tools", gateway_id, "tools", ["Tool"], "other")

    def mcp_server(n):
        server = (n["data"].get("node", {}).get("template", {}).get("mcp_server") or {}).get("value") or {}
        return server if isinstance(server, dict) else {}

    shared = [n for n in data["nodes"] if n["data"].get("type") in ("MCPTools", "MCP") and "browserbase" in mcp_url(n)]
    existing = by_type("StudioBrowser")
    browser_id = None
    if not strip and (shared or existing):
        proxies = False
        if existing:
            template = existing["data"]["node"]["template"]
            auth_header, auth_var = template["auth_header"].get("value"), template["auth_value"].get("value")
            proxies = bool((template.get("proxies") or {}).get("value"))
        else:
            # The node's server may be registered in Langflow's MCP settings, which win over
            # the config embedded in the flow; take the credential from whichever is used.
            server = mcp_server(shared[0])
            config = server.get("config") or {}
            try:
                config = call("GET", f"/api/v2/mcp/servers/{urllib.parse.quote(server.get('name') or '')}") or config
            except urllib.error.HTTPError:
                pass
            auth_header, auth_var = next(((k, v) for k, v in (config.get("headers") or {}).items()
                                          if k.lower() in ("authorization", "x-bb-api-key")), (None, None))
        names = {v["name"] for v in call("GET", "/api/v1/variables/")}
        if auth_var not in names:
            sys.exit(f"the Browserbase credential header must come from a Langflow global variable (found {auth_header!r})")
        drop = {n["data"]["id"] for n in shared} | ({existing["data"]["id"]} if existing else set())
        if shared:
            print("replacing shared Browserbase connection:", ", ".join(sorted(n["data"]["id"] for n in shared)))
        anchor = (existing or shared[0])["position"]
        data["nodes"] = [n for n in data["nodes"] if n["data"]["id"] not in drop]
        data["edges"] = [e for e in data["edges"] if e["source"] not in drop and e["target"] not in drop]
        browser = call("POST", "/api/v1/custom_component", {"code": open(os.path.join(HERE, "components/studio_browser.py")).read()})["data"]
        browser["template"]["auth_value"]["load_from_db"] = True
        browser["template"]["auth_value"]["value"] = auth_var
        browser["template"]["auth_header"]["value"] = auth_header
        browser["template"]["proxies"]["value"] = proxies  # The flow's own setting outlives a reinstall.
        browser_id = "StudioBrowser-studio"
        data["nodes"].append({
            "id": browser_id,
            "type": "genericNode",
            "position": anchor,
            "data": {"id": browser_id, "type": "StudioBrowser", "node": browser, "showNode": True},
        })
        connect(browser_id, "StudioBrowser", "tools", gateway_id, "tools", ["Tool"], "other")

    if "--keep-python" not in argv:
        drop = {n["data"]["id"] for n in data["nodes"] if n["data"].get("type") == "PythonREPLComponent"}
        if drop:
            print("removing in-process Python REPL:", ", ".join(sorted(drop)))
            data["nodes"] = [n for n in data["nodes"] if n["data"]["id"] not in drop]
            data["edges"] = [e for e in data["edges"] if e["source"] not in drop and e["target"] not in drop]

    for n in data["nodes"]:
        if n["data"].get("type") in ("MCPTools", "MCP"):
            field = n["data"].get("node", {}).get("template", {}).get("use_cache")
            if isinstance(field, dict) and not field.get("value"):
                field["value"] = True
                print("caching MCP server tools:", n["data"]["id"])

    history = agent["data"]["node"]["template"].get("n_messages")
    if isinstance(history, dict) and int(history.get("value") or 0) < MIN_HISTORY:
        history["value"] = MIN_HISTORY
        print("agent now reads the last", MIN_HISTORY, "messages")

    load_skill = by_type("LoadSkill")
    if load_skill:
        load_skill["data"]["node"]["template"]["code"]["value"] = open(os.path.join(HERE, "components/load_skill.py")).read()

    for n in data["nodes"]:
        field = n["data"].get("node", {}).get("template", {}).get("exa_api_key")
        if isinstance(field, dict) and field.get("value") and not field.get("load_from_db"):
            names = {v["name"] for v in call("GET", "/api/v1/variables/")}
            if "EXA_API_KEY" not in names:
                call("POST", "/api/v1/variables/", {"name": "EXA_API_KEY", "value": field["value"], "type": "Credential", "default_fields": []})
            field["value"], field["load_from_db"] = "EXA_API_KEY", True
            print("moved the Exa key into the global variable EXA_API_KEY")
        results = n["data"].get("node", {}).get("template", {}).get("search_num_results")
        if isinstance(results, dict) and int(results.get("value") or 0) < MIN_SEARCH_RESULTS:
            results["value"] = MIN_SEARCH_RESULTS
            print("Exa search now returns", MIN_SEARCH_RESULTS, "results:", n["data"]["id"])

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
    node["template"]["base_prompt"]["value"] = open(os.path.join(HERE, "agent_instructions.md")).read() or base_prompt
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
    connect(context_id, "WorkspaceContext", "system_prompt", agent_id, "system_prompt", ["Message"], "str")

    if copy_name:
        result = call("POST", "/api/v1/flows/", {"name": copy_name, "data": data, "folder_id": flow.get("folder_id")})
        print("created flow", result["id"])
    else:
        call("PATCH", f"/api/v1/flows/{flow_id}", {"data": data})
        print("updated flow", flow_id)

    # The gateway hears when an event in the member's app started the run (docs/watches.md).
    tweaks = {context_id: {"workspace_context": "{{system_context}}"}, chat_input["data"]["id"]: {"files": "{{files}}"},
              gateway["data"]["id"]: {"run_cause": "{{run_cause}}"}}
    if member_apps_id:
        tweaks[member_apps_id] = {"member_id": "{{composio_user_id}}", "toolkits": "{{composio_toolkits}}"}
    if browser_id:
        tweaks[browser_id] = {"context_id": "{{browser_context}}"}
    print("\nSet in the app's environment:\nLANGFLOW_TWEAKS=" + json.dumps(tweaks, separators=(",", ":")))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
