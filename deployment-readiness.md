# Deployment Readiness Checklist (warehouse-test2)

Scope: separate preview unit for `https://github.com/tekstilesilko-jpg/warehouse-test2`, isolated from `Warehouse Automation (+AIVA)`.

## 1) Pre-merge checks (local)
- Confirm working tree clean and expected latest commit is on `master`.
- Verify project spec is copied and identical:
  - `docs/superpowers/specs/2026-09-07-digital-warehouse-product-design.md`
- Run local D1 setup:
  - `npm run ci:check-deploy-secrets` (deploy secrets)
  - `npm run db:migrate`
  - `npm run db:seed`
  - `npm run dev` and test:
    - `curl http://127.0.0.1:8787/api/health`
    - `curl -H "x-user-email: admin@demo.local" http://127.0.0.1:8787/api/inventory`

## 2) CI secrets
- In GitHub → Settings → Secrets and variables → Actions, add:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
  - `WRANGLER_D1_DATABASE_ID` (required only when running `workflow_dispatch` with `run_migrations=true`)

## 3) Deployment
- Push to `master` and check workflow run status succeeds.
- Expected pass path:
  - `Validate Cloudflare deployment secrets` succeeds
  - `Deploy to Cloudflare Workers` succeeds
  - `Provision initial tables (first run)` optional on workflow_dispatch path

## 4) Post-deploy validation
- Open Worker URL from deployment output and verify:
  - `/api/health` returns `{ "ok": true }`
  - `/` renders the preview UI
  - `GET /api/me` with header `x-user-email: admin@demo.local` returns authenticated user payload
