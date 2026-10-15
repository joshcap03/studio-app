# Hosting Langflow for Studio

The deployed app needs a Langflow server it can reach over HTTPS. This directory has a
container (`Dockerfile`, official `langflowai/langflow:1.12.4`, API only, no editor UI),
blueprints for Railway (`railway.json`) and Render (`render.yaml`), and `export_flow.py` to
copy the flow off your laptop.

**Only the app should call this server.** It holds every tenant's run traffic and the
shared service keys. Sign-up is off, auto-login is off, and there's no editor UI; keep the
API key in Vercel only.

**Size:** at least 1 GB RAM (2 GB is comfortable), one instance, one worker. Postgres can be
the smallest managed plan.

## 1. Deploy the service

The container refuses to start without these four variables:

| Variable | Value |
| --- | --- |
| `LANGFLOW_DATABASE_URL` | the managed Postgres URL (`postgresql://…`) |
| `LANGFLOW_SECRET_KEY` | 32+ random bytes, e.g. `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`. Set once and **never change it**: it encrypts global variables and background-job state, so a new key makes them unreadable. |
| `LANGFLOW_SUPERUSER` | an admin username |
| `LANGFLOW_SUPERUSER_PASSWORD` | a strong password (store it in your password manager) |

The Dockerfile fixes the rest (backend only, `AUTO_LOGIN=false`, sign-up off, config dir
`/app/data/langflow`). Leave `LANGFLOW_SANDBOX_BACKEND` unset: the flow has no in-process
Python.

- **Render:** New → Blueprint, pick the repo, Blueprint Path `langflow/deploy/render.yaml`.
  It creates the web service (Standard, 2 GB), a 1 GB disk, and Postgres, wires the database
  URL, and generates the secret key. It asks for the superuser name and password.
- **Railway:** New project → Deploy from repo. In the service's settings set the config file
  path to `/langflow/deploy/railway.json`. Add a Postgres service and set
  `LANGFLOW_DATABASE_URL=${{Postgres.DATABASE_URL}}`; add a volume mounted at
  `/app/data/langflow` (the image runs as a non-root user; if Langflow can't write there, set
  `RAILWAY_RUN_UID=0`); set the other three variables; generate a public domain.
- **Google Cloud Run** (free tier covers light use; needs a billing account) with an external
  Postgres such as Neon (use the **direct**, non-pooled connection string). Its disk is
  in-memory and resets with the instance; everything that matters is in Postgres. Keep the
  four variables in Secret Manager, piping values in so they never land in a file:

  ```sh
  gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
    artifactregistry.googleapis.com secretmanager.googleapis.com
  pbpaste | gcloud secrets create langflow-database-url --data-file=-
  python3 -c "import secrets;print(secrets.token_urlsafe(32),end='')" \
    | gcloud secrets create langflow-secret-key --data-file=-
  printf %s '<superuser>' | gcloud secrets create langflow-superuser --data-file=-
  read -rs P && printf %s "$P" | gcloud secrets create langflow-superuser-password --data-file=-; unset P
  gcloud projects add-iam-policy-binding "$(gcloud config get project)" \
    --member="serviceAccount:$(gcloud projects describe "$(gcloud config get project)" --format='value(projectNumber)')-compute@developer.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor
  gcloud run deploy studio-langflow --source langflow/deploy --region us-central1 \
    --memory 4Gi --cpu 1 --cpu-boost --min-instances 1 --max-instances 1 --no-cpu-throttling \
    --timeout 3600 \
    --startup-probe=httpGet.path=/health,httpGet.port=8080,periodSeconds=10,timeoutSeconds=5,failureThreshold=60 \
    --allow-unauthenticated \
    --set-secrets LANGFLOW_DATABASE_URL=langflow-database-url:latest,LANGFLOW_SECRET_KEY=langflow-secret-key:latest,LANGFLOW_SUPERUSER=langflow-superuser:latest,LANGFLOW_SUPERUSER_PASSWORD=langflow-superuser-password:latest
  ```

  One instance at most: paused approvals live with a single Langflow worker.
  Give it 4 GiB: at 2 GiB a run with an uploaded image ran out of memory, and Cloud Run
  killed the instance mid-run and cold-started a new one.
  `--allow-unauthenticated` only opens the network path; Langflow still requires its API
  key. `--min-instances 1` keeps one instance up (booting takes over a minute), and
  `--no-cpu-throttling` keeps its CPU between requests so it doesn't stall when traffic
  returns. Both bill for an always-on instance; drop them to scale to zero and accept a
  cold start after a quiet spell. The first run after an hour or so still spends a few
  seconds reconnecting to MCP servers, whose tool cache expires.

  The HTTP startup probe matters: gunicorn opens the port well before Langflow finishes
  starting (about 1.5 minutes), so the default TCP probe sends traffic to an instance that
  can't answer yet and shuts the old revision down early. Probing `/health` keeps the old
  revision serving until the new one is ready.

Health check: `GET /health` (liveness). `GET /health_check` also probes the database.

## 2. Create an API key

With no UI, use the API (the password stays in your shell, not in a file):

```sh
export TARGET_LANGFLOW_BASE_URL=https://<your-langflow-host>
TOKEN=$(curl -s -X POST "$TARGET_LANGFLOW_BASE_URL/api/v1/login" \
  --data-urlencode "username=<superuser>" --data-urlencode "password=<password>" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
curl -s -X POST "$TARGET_LANGFLOW_BASE_URL/api/v1/api_key/" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"studio-app"}'
```

The response's `api_key` is shown once. Use it as `TARGET_LANGFLOW_API_KEY` below and as
`LANGFLOW_API_KEY` in Vercel. Everything below runs as this user, so the flow and its global
variables share one owner.

## 3. Copy the flow

With Langflow desktop running locally:

```sh
LANGFLOW_BASE_URL=http://127.0.0.1:7860 LANGFLOW_API_KEY=<desktop key> \
TARGET_LANGFLOW_BASE_URL=... TARGET_LANGFLOW_API_KEY=... \
python3 langflow/deploy/export_flow.py <desktop-flow-id>
```

It prints the new flow id and the global variables the flow reads. Secrets are not copied;
if a field holds a literal key, it stops and names it (run `langflow/install.py` on the
source first, or move it into a variable).

## 4. Install the Studio components on the target

```sh
LANGFLOW_BASE_URL=$TARGET_LANGFLOW_BASE_URL LANGFLOW_API_KEY=$TARGET_LANGFLOW_API_KEY \
python3 langflow/install.py <new-flow-id>
```

Keep the `LANGFLOW_TWEAKS=…` line it prints.

## 5. Create the global variables

Create each one the export listed, as a Credential, on the target:

```sh
curl -s -X POST "$TARGET_LANGFLOW_BASE_URL/api/v1/variables/" -H "x-api-key: $TARGET_LANGFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"EXA_API_KEY","type":"Credential","value":"<value>","default_fields":[]}'
```

Typically:

- `COMPOSIO_API_KEY`: the Composio **project** key (`ak_…`), the same one the app uses.
- `EXA_API_KEY`: web search.
- The model provider's key, e.g. `OPENAI_API_KEY` (plus `OPENAI_BASE_URL` for an
  OpenAI-compatible endpoint) or `ANTHROPIC_API_KEY`.
- Browserbase variables, if the export lists them.

Type the values in your shell; don't paste them into files in the repo.

## 6. Point the app at it

In Vercel (Production): `LANGFLOW_BASE_URL` (the https host, no trailing slash),
`LANGFLOW_API_KEY`, `LANGFLOW_FLOW_ID` (the new id), `LANGFLOW_TWEAKS` (from step 4). Then
run the smoke test in docs/development.md.
