# Warehouse Test2 — Preview Unit (Round 2A)

This is an isolated development unit for the `warehouse-test2` GitHub repository link you shared.  
It is intentionally separate from the existing `Warehouse Automation` folder and includes:

- Cloudflare Worker + D1 persistence
- Lithuanian-first responsive preview UI
- Role-based preview workflows for Warehouse / Sales / Admin
- Human review screen with editable invoice lines
- Immutable approvals, movement posting, and stock balance projection
- Synthetic document fixtures and demo users
- Deployment and outbox-ready API skeleton for later rounds

Source specification file copied into this repository:

- `docs/superpowers/specs/2026-09-07-digital-warehouse-product-design.md`

## Runbook

1. Ensure Node.js 16.13+ (recommended Node 20) is active.

   Wrangler v3 and Worker local tooling require this minimum runtime.

2. Install dependencies

   ```powershell
   # after activating Node 16+
   npm install
   ```

3. Configure Cloudflare D1 local database in your environment (`wrangler` handles local binding with `local` mode).

4. Apply schema and seed data:

   ```powershell
   npm run db:migrate
   npm run db:seed
   ```

5. Start local dev server:

   ```powershell
   npm run dev
   ```

6. Open in browser:
   - `http://127.0.0.1:8787/`
   - Demo credentials by header query/`X-User-Email`:
     - `warehouse@demo.local`
     - `sales@demo.local`
     - `admin@demo.local`

7. Optional quick smoke check (while dev server is running):

   ```powershell
   npm run smoke:api
   ```

## Deployment

### Manual deploy (local machine)

When credentials are configured and bindings are set, deploy with:

```powershell
npm run deploy
```

For post-push quick verification:

```powershell
$env:WORKER_BASE_URL="https://<your-worker-subdomain>.workers.dev"
npm run smoke:api
```

`wrangler.toml` already defines:

- Worker entry point: `src/index.ts`
- Preview D1 DB binding name: `WAREHOUSE_DB`
- Cron trigger placeholder for future orchestration rounds: daily `03:00`

To run remote DB setup from the terminal, pass `WRANGLER_D1_DATABASE_ID`:

```powershell
$env:WRANGLER_D1_DATABASE_ID="your-d1-id"
npm run db:remote:migrate
npm run db:remote:seed
```

Environment requirements:

- `WRANGLER_D1_DATABASE_ID`
- `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (for deploy)
- `npm run deploy` uses Cloudflare `production` env and requires `WRANGLER_D1_DATABASE_ID` to be set in GitHub for remote D1 binding.

### GitHub auto-deploy

The repository includes `.github/workflows/deploy-preview.yml` with one-click deployment for this unit.

Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `WRANGLER_D1_DATABASE_ID`

### Post-deploy verification

After a successful push/deploy run, verify the production URL from Cloudflare Workers:

1. Open the worker URL and check:

   - `https://<your-worker>/api/health` should return `{ "ok": true }`.
   - `https://<your-worker>/` should render the preview UI.
   - Use header `x-user-email: admin@demo.local` on API routes (for example `/api/me`) to confirm auth boundary.

2. If you do not use an existing worker route yet, the latest deployment log contains the worker URL in the Wrangler output.

Deployment failures after secrets are configured are usually actionable in the workflow step log:

- If `Validate Cloudflare deployment secrets` fails, add the two required values in:
  `Settings > Secrets and variables > Actions > Repository secrets`.
- If `Deploy to Cloudflare Workers` fails, rerun the failed run after secrets are corrected and check the deploy action output.

## Admin functions

- `POST /api/admin/preview/reset` reinitializes seeded fixtures for demonstration.
- `GET /api/reports/stock` exports current stock projection as CSV payload.

## Current boundary

This is the production-shaped preview baseline (approved next stage boundary from your spec), which means:

- No live Gmail / Drive / AIVA integration in this unit yet
- No external payment or notification dependencies
- Manual and synthetic review cases are fully supported
- Preview-boundary and role controls are in place to support later full rounds
