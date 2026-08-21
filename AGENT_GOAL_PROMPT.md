# Agent Goal Prompt: Complete Price Gap Resolution for Handleplan

## Your Mission

You are continuing work on Handleplan (Kassalappen), a Norwegian grocery price comparison app. The goal is to ensure Bunnpris, Coop Extra, and REMA 1000 prices are visible on the Oppdag (discovery) page.

**Read the handoff document first**: `/Users/reidar/Documents/Kassalappen/HANDOFF_PRICE_GAP_RESOLUTION.md`

## Current State (Verified 2026-08-21)

- **Production**: All 5 containers running on VPS `deploy@198.23.137.16`
- **Tjek Pipeline**: WORKING — 3 catalogs discovered, 1 Bunnpris offer extracted
- **Open Prices Pipeline**: WORKING — 5 accepted prices
- **Kassalapp Pipeline**: WORKING — 6138 fetched, 477 accepted
- **Git Repo**: Clean, all changes on main branch
- **Debug code**: Removed in commit `8ebf26e`

## What You Need To Do

### Task 1: Deploy Clean Version (Priority: HIGH)

The current production is running code with debug logging. Deploy the clean version:

```bash
# From local machine
VPS="deploy@198.23.137.16"
SSH="ssh -i ~/.ssh/id_rsa_racknerd -o IdentitiesOnly=yes"
SHA=$(cd /Users/reidar/Documents/Kassalappen && git rev-parse HEAD)

# Pull latest (should already be clean)
$SSH $VPS "cd /opt/apps/handleplan/source && git pull origin main"

# Build
$SSH $VPS "cd /opt/apps/handleplan/source && docker build --build-arg APP_COMMIT_SHA=$SHA -t handleplan:$SHA ."

# Stop all containers
$SSH $VPS "for c in handleplan-worker-1 handleplan-app-1 handleplan-review-1 handleplan-operations-1 handleplan-migrate-1; do docker stop \$c 2>/dev/null; docker rm \$c 2>/dev/null; done"

# Setup release
$SSH $VPS "mkdir -p /opt/apps/handleplan/operations/releases/$SHA/deploy && cp /opt/apps/handleplan/source/deploy/compose.production.yml /opt/apps/handleplan/operations/releases/$SHA/deploy/ && ln -sfn releases/$SHA /opt/apps/handleplan/operations/current"

# Deploy (note: use the release compose, not source)
$SSH $VPS "cd /opt/apps/handleplan/operations/current/deploy && HANDLEPLAN_IMAGE=handleplan:$SHA HANDLEPLAN_MIGRATION_IMAGE=handleplan:$SHA APP_COMMIT_SHA=$SHA docker compose --env-file /opt/apps/handleplan/shared/production.env -f compose.production.yml up -d --remove-orphans"
```

**IMPORTANT**: Docker Compose v5.1.3 always tries to pull images. You MUST stop containers first, then recreate. The `pull_policy: never` directive doesn't work reliably.

### Task 2: Fix Publication Titles (Priority: MEDIUM)

**Problem**: Publications show `title: "undefined 2026-08-21"` instead of actual catalog titles.

**Location**: `apps/worker/src/tjek-handlers.ts`, line ~102

**Current code**:
```typescript
const title = catalog.brand + " " + (catalog.publication_date || now.toISOString().slice(0, 10));
```

**Fix**: Handle undefined brand:
```typescript
const brand = catalog.brand || catalog.dealer?.name || chain;
const title = brand + " " + (catalog.publication_date || now.toISOString().slice(0, 10));
```

### Task 3: Add Source Provenance Display (Priority: MEDIUM)

**Goal**: Show which source provided each price in the Oppdag UI.

**Steps**:
1. Check if `price_observations` table has a `source_id` column (it should)
2. Update the Oppdag API to include source information
3. Update the UI to display source badges (Kassalapp, Open Prices, Tjek)

**Files to check**:
- `apps/web/src/app/oppdag/page.tsx` or similar
- `packages/db/src/price-read-model.ts`
- Any API routes under `apps/web/src/app/api/`

### Task 4: Evaluate Extra/REMA Offer Extraction (Priority: LOW)

**Problem**: Extra and REMA catalogs are paged format (images), not incito (structured). Tjek API cannot extract offers from paged catalogs.

**Options**:
1. **Accept limitation** — Leave Extra/REMA without offers (recommended for now)
2. **OCR Pipeline** — Use Tesseract to extract text from catalog images (complex, costly)
3. **Alternative source** — Find another data source for Extra/REMA prices

**Recommendation**: Document this limitation in the app UI and move on.

### Task 5: Set Up Monitoring (Priority: LOW)

**Goal**: Alert on failed jobs, track extraction rates.

**Steps**:
1. Query `worker_job_results` table for failed jobs
2. Set up a simple cron job or health check endpoint
3. Log to a monitoring service (Sentry, Datadog, etc.)

**SQL to check job health**:
```sql
SELECT job_kind, status, COUNT(*), MAX(completed_at)
FROM worker_job_results
WHERE completed_at > NOW() - INTERVAL '24 hours'
GROUP BY job_kind, status;
```

## Key Constraints

### Docker Compose v5.1.3
- Always tries to pull images from Docker Hub
- Must stop containers before recreating
- `pull_policy: never` doesn't work reliably

### PostgreSQL Migration Runner
- Runs inside a transaction
- Does `REVOKE ALL ON ALL FUNCTIONS/TABLES IN SCHEMA PUBLIC`
- Must re-grant permissions for new objects
- Blanket grants in `deploy/migrate.mjs` handle this

### Worker Logs
- `docker logs handleplan-worker-1` returns empty (Docker logging issue)
- Use file-based logging or query DB for diagnostics
- Job results are in `worker_job_results` table

### Tjek API
- Only `incito` format catalogs support offer extraction
- `paged` catalogs are image-based (no structured data)
- API key required for RPC calls
- Rate limit: 1 req/sec recommended

## Verification Steps

After each task, verify:

```bash
# Check containers are healthy
$SSH $VPS "docker ps --filter name=handleplan --format '{{.Names}}: {{.Status}}'"

# Check job results
$SSH $VPS "docker exec handleplan-postgres-1 psql -U handleplan_app -d handleplan -c \"SELECT id, job_kind, status, counts FROM worker_job_results ORDER BY id DESC LIMIT 5\""

# Check publications
$SSH $VPS "docker exec handleplan-postgres-1 psql -U handleplan_app -d handleplan -c \"SELECT id, chain, title, status FROM publications ORDER BY id DESC LIMIT 5\""

# Check approved offers
$SSH $VPS "docker exec handleplan-postgres-1 psql -U handleplan_app -d handleplan -c \"SELECT chain, COUNT(*) FROM approved_offers GROUP BY chain\""
```

## Files You'll Need

### Core Implementation
- `apps/worker/src/tjek-handlers.ts` — Tjek handler
- `apps/worker/src/open-prices-handlers.ts` — Open Prices handler
- `packages/tjek/src/client.ts` — Tjek API client
- `packages/open-prices/src/client.ts` — Open Prices API client

### Database
- `packages/db/src/ingestion.ts` — Price ingestion
- `deploy/migrate.mjs` — Migration runner
- `deploy/migrations/038_tjek_function_grants.sql` — Function grants

### Configuration
- `apps/worker/src/production.ts` — Production setup
- `apps/worker/src/env.ts` — Environment variables
- `deploy/compose.production.yml` — Docker Compose

### Frontend
- `apps/web/src/app/oppdag/` — Discovery page
- `apps/web/src/app/api/` — API routes

## Environment Variables

```bash
TJEK_ENABLED=true
TJEK_API_KEY=04715502542d2bab0eb51dccd5f33735
OPEN_PRICES_ENABLED=true
OFFICIAL_OFFER_FOUNDATION_ENABLED=true
```

## Git Workflow

```bash
# Create feature branch
git checkout -b fix/your-feature

# Make changes, commit
git add -A
git -c commit.gpgsign=false commit -m 'fix: description'

# Push and deploy
git push origin main
# Then run deployment script from Task 1
```

**Note**: Use `git -c commit.gpgsign=false` to bypass GPG signing (1Password SSH signing is intermittent)

## Success Criteria

1. All 5 containers running and healthy
2. Tjek pipeline: 3 catalogs discovered (Bunnpris/Extra/REMA)
3. Bunnpris offers visible in Oppdag UI
4. Open Prices data visible in Oppdag UI
5. No failed jobs in last 24 hours
6. Publication titles show actual catalog names (not "undefined")

## If You Get Stuck

1. **Check worker logs**: Query `worker_job_results` table
2. **Check container status**: `docker ps --filter name=handleplan`
3. **Check database**: Use `docker exec handleplan-postgres-1 psql -U handleplan_app -d handleplan`
4. **Read handoff document**: `/Users/reidar/Documents/Kassalappen/HANDOFF_PRICE_GAP_RESOLUTION.md`
5. **Check git history**: `git log --oneline -20`

## Time Estimate

- Task 1 (Deploy): 30 minutes
- Task 2 (Fix titles): 15 minutes
- Task 3 (Source provenance): 2-4 hours
- Task 4 (Evaluate Extra/REMA): 1 hour (decision only)
- Task 5 (Monitoring): 2-3 hours

**Total**: 6-10 hours

---

*Prompt generated: 2026-08-21*
*Handoff document: `/Users/reidar/Documents/Kassalappen/HANDOFF_PRICE_GAP_RESOLUTION.md`*
