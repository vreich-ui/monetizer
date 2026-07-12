# Deploying to Google Cloud

Target shape: **Cloud Run** (engine, always-on worker) + **Cloud SQL Postgres**. No custom domain needed — the default `https://monetizer-….run.app` URL serves the resolve API, the redirect click path, the beacon, and webhooks. `REDIRECT_BASE_URL` is optional and defaults to `PUBLIC_BASE_URL`; map `go.<domain>` later via Cloud Run domain mapping if you ever want prettier click URLs.

One-time setup (after creating the GCP project):

```bash
gcloud config set project <PROJECT_ID>
gcloud services enable run.googleapis.com sqladmin.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com

# --- Cloud SQL (smallest tier is fine for years at this volume) ---
gcloud sql instances create monetizer-pg --database-version=POSTGRES_16 \
  --tier=db-f1-micro --region=us-central1
gcloud sql users create monetizer --instance=monetizer-pg --password='<DB_PASSWORD>'
gcloud sql databases create monetizer --instance=monetizer-pg
# note the connection name: <PROJECT_ID>:us-central1:monetizer-pg

# --- Secrets ---
openssl rand -base64 32 | gcloud secrets create cred-master-key --data-file=-   # BACK THIS UP
openssl rand -hex 32    | gcloud secrets create admin-token --data-file=-

# --- Build & deploy ---
gcloud artifacts repositories create monetizer --repository-format=docker --location=us-central1
gcloud builds submit --tag us-central1-docker.pkg.dev/<PROJECT_ID>/monetizer/engine:latest .

gcloud run deploy monetizer \
  --image us-central1-docker.pkg.dev/<PROJECT_ID>/monetizer/engine:latest \
  --region us-central1 --allow-unauthenticated \
  --add-cloudsql-instances <PROJECT_ID>:us-central1:monetizer-pg \
  --min-instances=1 --no-cpu-throttling --memory=512Mi \
  --set-secrets CRED_MASTER_KEY=cred-master-key:latest,ADMIN_TOKEN=admin-token:latest \
  --set-env-vars 'DATABASE_URL=postgres://monetizer:<DB_PASSWORD>@/monetizer?host=/cloudsql/<PROJECT_ID>:us-central1:monetizer-pg'

# First deploy prints the service URL. Pin it as the public base:
gcloud run services update monetizer --region us-central1 \
  --update-env-vars PUBLIC_BASE_URL=https://monetizer-<hash>-uc.a.run.app
```

Notes that matter:

- **`--min-instances=1 --no-cpu-throttling` is required**, not an optimization: the job worker (report polls, attribution runs, CSV drops, liveness) runs inside the service loop and needs an always-on, CPU-allocated instance. Scale-to-zero would silently stop all background monetization work.
- The unix-socket `DATABASE_URL` (`?host=/cloudsql/...`) is the Cloud Run ↔ Cloud SQL path; no IP allowlisting needed.
- Migrations run automatically on boot.
- **MCP control plane** (credential handoff etc.) runs from your machine, not Cloud Run:
  ```bash
  cloud-sql-proxy <PROJECT_ID>:us-central1:monetizer-pg --port 5433 &
  DATABASE_URL='postgres://monetizer:<DB_PASSWORD>@localhost:5433/monetizer' \
  CRED_MASTER_KEY='<from secret manager>' \
  PUBLIC_BASE_URL='https://monetizer-<hash>-uc.a.run.app' \
  pnpm mcp
  ```
- Redeploy = `gcloud builds submit … && gcloud run deploy …` with the same flags (or wire a Cloud Build trigger on the repo later).
- Dashboards: point Metabase/whatever at Cloud SQL and use the `v_*` views (they carry the mandatory status + resolution qualifiers).
