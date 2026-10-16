# Deploy checklist (Vercel + Supabase Cloud)

Do these in order. `APP_URL` is the production URL (e.g. `https://studio.example.com`, or the
`*.vercel.app` URL until a domain is attached). Background is in docs/development.md, "Deploying".

## 0. Before you start

- [ ] Langflow is hosted over HTTPS, the flow is imported, and `langflow/install.py` has
      been run against it. Keep the tweaks JSON it prints; you'll need it in step 3.
- [ ] Langflow has the global variables `COMPOSIO_API_KEY`, `EXA_API_KEY`, and the model key,
      `LANGFLOW_AUTO_LOGIN=false`, and a strong API key.
- [ ] Locally green: `npm run typecheck && npm test && npm run build`.

## 1. Supabase project

- [ ] Create the project at supabase.com (pick the region closest to your Vercel region).
      Note the project ref (Project Settings → General).
- [ ] Link and apply migrations from the repo root:

  ```sh
  npx supabase login
  npx supabase link --project-ref <project-ref>
  npx supabase db push --dry-run   # review what will be applied
  npx supabase db push
  ```

  Don't run `supabase config push`: `supabase/config.toml` is the *local* config (local
  Site URL, email confirmation off) and would overwrite the hosted auth settings.

## 2. Supabase auth settings (dashboard)

- [ ] Authentication → Sign In / Providers → Email: sign-ups **on**, **Confirm email on**.
- [ ] Authentication → URL Configuration: Site URL = `APP_URL`. Redirect URLs: add
      `APP_URL/**`.
- [ ] Authentication → Emails → Templates:
  - "Confirm signup": paste `supabase/templates/confirmation.html`
  - "Reset password": paste `supabase/templates/recovery.html`

  (They link to `{{ .SiteURL }}/auth/confirm?token_hash=…`. The defaults use a redirect
  flow that `/auth/confirm` doesn't accept.)
- [ ] Authentication → Emails → SMTP: set up a real sender (Resend, Postmark, SES…) and a
      verified from-address. The built-in sender only reaches team addresses, a few an hour.
- [ ] Project Settings → API: copy the Project URL and the **anon / publishable** key.
      Never the `service_role` / secret key.

## 3. Vercel project

- [ ] Vercel → Add New → Project → import this repo. Framework: Next.js (auto-detected).
      Build command and output: defaults. Node.js version comes from `package.json`
      `engines` (22.x).
- [ ] Settings → Environment Variables, scope **Production** (and Preview if you use it).
      Names and formats are in `.env.example`:

  | Variable | Value |
  |---|---|
  | `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL (`https://<ref>.supabase.co`) |
  | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon / publishable key |
  | `AGENT_PROVIDER` | `langflow` |
  | `LANGFLOW_BASE_URL` | Langflow HTTPS URL |
  | `LANGFLOW_API_KEY` | Langflow API key |
  | `LANGFLOW_FLOW_ID` | flow id |
  | `LANGFLOW_TWEAKS` | JSON printed by `langflow/install.py` |
  | `LANGFLOW_STREAM`, `LANGFLOW_END_USER_HEADER` | optional |
  | `COMPOSIO_API_KEY` | Composio project key (`ak_…`) |
  | `COMPOSIO_TOOLKITS` | JSON of offered apps → auth config ids |
  | `SUPERMEMORY_API_KEY` | Supermemory key |
  | `LANGSMITH_API_KEY` | optional; the key of the LangSmith workspace Langflow traces to. Reply ratings then show on each run's trace as `user_rating` feedback |
  | `AGENT_LIVE_WORKSPACES` | `*` |
  | `LIMIT_RUNS_SERVICE_PER_DAY` | daily cap across all workspaces, e.g. `500` |
  | `LIMIT_RUNS_PER_MINUTE`, `LIMIT_RUNS_PER_WORKSPACE_PER_DAY`, `LIMIT_CONCURRENT_RUNS` | optional; defaults are in `.env.example` |

  The build doesn't need any of these; they're read at request time. A change takes effect
  on the next deploy.
- [ ] Hobby plan: the chat route's `maxDuration` is 300 s, the Hobby ceiling. On Pro you can
      raise it.
- [ ] Composio: add `APP_URL` to each auth config's allowed redirects (connect flow returns
      to `/settings`).

## 4. Check the env

```sh
npx vercel link
npx vercel env pull .env.production.local --environment=production
npm run check:deploy-env    # loads .env.production.local if present, else the shell env
rm .env.production.local
```

It prints PASS / WARN / FAIL per item (never values) and exits 1 on any FAIL. Fix every
FAIL; read every WARN. Variables marked **Sensitive** in Vercel come down empty from
`env pull` and show as "not set"; check those by hand in the dashboard. `.env.*` files are
gitignored; still delete the pulled file when done.

## 5. First deploy

- [ ] Deploy (push to the production branch, or Deployments → Redeploy). Watch the build log.
- [ ] Attach the custom domain if any, then make sure Supabase Site URL / Redirect URLs and
      the Composio redirects use the final `APP_URL`.
- [ ] `curl -sI APP_URL/login` shows `strict-transport-security`, `x-frame-options: DENY`,
      `x-content-type-options: nosniff`.

## 6. Smoke test (fresh `+` addresses on a real inbox)

- [ ] Sign up account A. The confirmation email arrives from your SMTP sender, and the link
      lands on `APP_URL` (not localhost) and signs you in.
- [ ] Create a workspace. No "Mock agent" label anywhere.
- [ ] Ask something simple; the reply streams and finishes.
- [ ] In chat, ask the agent to use an app; connect it when prompted (Composio OAuth returns
      to the app). Ask for a change on that app: an approval card appears; approve it and
      confirm the change happened. Decline a second one and confirm nothing happened.
- [ ] Attach a small file and ask about it.
- [ ] Forgot password from `/login`: the reset email arrives and the link lets you set a
      new password.
- [ ] Sign up account B in a private window. B sees none of A's conversations, memories,
      files, or connected apps (Settings → Connections is empty), and asking B's agent to
      use A's app prompts B to connect their own.
- [ ] Supabase → Logs: no auth or Postgres errors. Vercel → Logs: no 500s.

## 7. Rollback

- App: Vercel → Deployments → pick the last good one → **Instant Rollback** (or
  `npx vercel rollback <deployment-url>`). Env var changes need a redeploy to take or undo.
- Kill switch for the agent: set `AGENT_LIVE_WORKSPACES` to empty (or
  `LIMIT_RUNS_SERVICE_PER_DAY=1`) and redeploy; the rest of the app keeps working.
- Database: migrations only move forward. Undo a bad one with a new corrective migration
  (`supabase/migrations/`, then `npx supabase db push`). For data loss, restore from
  Supabase → Database → Backups (daily on Pro; point-in-time is an add-on). Take a manual
  backup (`npx supabase db dump -f backup.sql --linked`) before pushing risky migrations.
