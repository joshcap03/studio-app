#!/bin/sh
# Creates (or updates) a Cloud Run job that runs prune.sql against Langflow's Postgres, and a
# Cloud Scheduler trigger that runs it daily. Idempotent; rerun after editing prune.sql.
# The database URL stays in Secret Manager (langflow-database-url) and never prints.
#   sh langflow/deploy/prune.sh            set up, then run once
set -eu
cd "$(dirname "$0")"

PROJECT="${PROJECT:-$(gcloud config get project)}"
REGION="${REGION:-us-central1}"
JOB=studio-langflow-prune
SA="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"

gcloud services enable cloudscheduler.googleapis.com --project "$PROJECT"

# "^@^" makes @ the list delimiter so the SQL's commas survive.
gcloud run jobs deploy "$JOB" --project "$PROJECT" --region "$REGION" \
  --image docker.io/library/postgres:17-alpine \
  --command sh \
  --args='-c,printf %s "$PRUNE_SQL" | psql "$LANGFLOW_DATABASE_URL" -v ON_ERROR_STOP=1 -f -' \
  --set-secrets LANGFLOW_DATABASE_URL=langflow-database-url:latest \
  --set-env-vars "^@^PRUNE_SQL=$(cat prune.sql)" \
  --memory 512Mi --task-timeout 10m --max-retries 1

URI="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/$JOB:run"
if gcloud scheduler jobs describe "$JOB" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
  ACTION=update
else
  ACTION=create
fi
gcloud scheduler jobs "$ACTION" http "$JOB" --project "$PROJECT" --location "$REGION" \
  --schedule "17 9 * * *" --time-zone UTC \
  --uri "$URI" --http-method POST \
  --oauth-service-account-email "$SA"

gcloud run jobs execute "$JOB" --project "$PROJECT" --region "$REGION" --wait
