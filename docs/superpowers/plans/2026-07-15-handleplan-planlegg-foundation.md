# Handleplan Foundation and Planlegg Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a locally runnable anonymous Planlegg slice that searches Kassalapp products, preserves explicit matching rules, and returns complete non-dominated one-to-three-chain basket plans in the approved workspace UI.

**Architecture:** Use a pnpm TypeScript monorepo with a Next.js App Router web application and focused domain, Kassalapp, and PostgreSQL packages. All optimization remains pure and deterministic in `packages/domain`; `KASSAL_API_KEY` is read only by server code. The browser persists the anonymous basket and preferences locally, while the backend persists only price cache and operational source data.

**Tech Stack:** Node.js 22, pnpm 10, TypeScript strict mode, Next.js App Router, React, Tailwind CSS, Zod, Drizzle ORM with PostgreSQL 16, Vitest, Testing Library, and Playwright.

## Global Constraints

- Core use is anonymous; no account or consent wall.
- Never expose `KASSAL_API_KEY` to browser bundles, JSON responses, logs, fixtures, or committed files.
- Return only complete required-item plans and never recommend more than three chains.
- Exact, constrained, and flexible product matches remain explicit and user-approved.
- Kassalapp chain prices do not imply branch inventory or branch-specific shelf prices.
- Base prices are eligible through 72 hours, visible but ineligible from over 72 hours through 14 days, and historical only after 14 days.
- Member-only and flyer prices are outside this slice; the interfaces reserve those conditions for later plans.
- Use Norwegian copy and Norwegian currency formatting.
- Target WCAG 2.2 AA; the plan selector must be operable as a named radio list without a pointer.
- Follow the approved Superdesign workspace direction and tokens in `.superdesign/design-system.md`.

## File Structure

```text
apps/web/
  app/api/health/route.ts                 readiness response
  app/api/products/search/route.ts        server-side product search
  app/api/plans/route.ts                  validated plan calculation
  app/planlegg/page.tsx                   basket builder
  app/planlegg/resultat/page.tsx          approved result workspace
  components/planlegg/*                   focused Planlegg components
  lib/browser-basket.ts                   versioned local persistence
  lib/server/container.ts                 server dependency wiring
packages/domain/src/
  contracts.ts                            stable domain types and schemas
  price-eligibility.ts                    centralized freshness policy
  matching.ts                             explicit matching-rule evaluation
  planner.ts                              complete-plan enumeration/frontier
  money.ts                                integer-øre arithmetic/formatting
packages/kassalapp/src/
  client.ts                               authenticated upstream adapter
  schemas.ts                              upstream validation/normalization
  fake.ts                                 deterministic test double
packages/db/src/
  schema.ts                               price-cache tables only
  price-cache.ts                          cache repository
  client.ts                               Drizzle/Postgres connection
tests/e2e/planlegg.spec.ts                browser journey
```

---

### Task 1: Bootstrap the runnable monorepo and health boundary

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.env.example`, `docker-compose.yml`
- Create: `apps/web/package.json`, `apps/web/app/layout.tsx`, `apps/web/app/globals.css`, `apps/web/app/api/health/route.ts`
- Test: `apps/web/app/api/health/route.test.ts`

**Interfaces:**
- Produces: `GET /api/health -> { status: "ok", version: 1 }` and workspace scripts `test`, `typecheck`, `lint`, `dev`.

- [ ] **Step 1: Write the failing health-route test**

```ts
import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/health", () => {
  it("returns a versioned readiness contract", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok", version: 1 });
  });
});
```

- [ ] **Step 2: Run the test and verify the red state**

Run: `pnpm --filter web test app/api/health/route.test.ts`
Expected: FAIL because `route.ts` does not exist.

- [ ] **Step 3: Create the workspace and minimal route**

```ts
// apps/web/app/api/health/route.ts
export function GET(): Response {
  return Response.json({ status: "ok", version: 1 });
}
```

Set root scripts to `pnpm -r test`, `pnpm -r typecheck`, and `pnpm --filter web dev`; configure strict TypeScript and copy the approved CSS variables from `.superdesign/context/globals.css` into `apps/web/app/globals.css`.

- [ ] **Step 4: Verify the workspace**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all commands exit 0 and the health test reports 1 passed.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .env.example docker-compose.yml apps/web
git commit -m "chore: bootstrap Handleplan workspace"
```

### Task 2: Define money, basket, price, and plan contracts

**Files:**
- Create: `packages/domain/package.json`, `packages/domain/src/contracts.ts`, `packages/domain/src/money.ts`, `packages/domain/src/price-eligibility.ts`, `packages/domain/src/index.ts`
- Test: `packages/domain/src/money.test.ts`, `packages/domain/src/price-eligibility.test.ts`, `packages/domain/src/contracts.test.ts`

**Interfaces:**
- Produces: `MoneyOre`, `Need`, `MatchRule`, `Product`, `PriceObservation`, `PlanRequest`, `PlanResult`, `formatNok`, and `classifyFreshness`.

- [ ] **Step 1: Write failing arithmetic and freshness tests**

```ts
expect(formatNok(82460)).toBe("824,60 kr");
expect(classifyFreshness(now, hoursAgo(now, 72))).toBe("eligible");
expect(classifyFreshness(now, hoursAgo(now, 73))).toBe("stale-visible");
expect(classifyFreshness(now, daysAgo(now, 15))).toBe("historical");
```

- [ ] **Step 2: Run the focused tests**

Run: `pnpm --filter @handleplan/domain test`
Expected: FAIL because the exports do not exist.

- [ ] **Step 3: Implement integer-øre and schema contracts**

```ts
export type MoneyOre = number & { readonly __moneyOre: unique symbol };
export type MatchMode = "exact" | "constrained" | "flexible";
export interface Need { id: string; query: string; quantity: number; quantityUnit: "each" | "g" | "ml"; matchRuleId: string; required: boolean }
export interface MatchRule { id: string; mode: MatchMode; exactEan?: string; productFamily?: string; allowedBrands?: string[]; sizeRange?: { min: number; max: number; unit: "g" | "ml" }; userApproved: boolean; explanation: string }
export interface Product { ean: string; name: string; brand?: string; packageQuantity?: number; packageUnit?: "g" | "ml" | "each"; productFamily?: string }
export interface PriceObservation { ean: string; chain: "bunnpris" | "rema-1000" | "extra"; amountOre: MoneyOre; observedAt: string; source: "kassalapp" }
export interface PlanRequest { needs: Need[]; matchingRules: MatchRule[]; products: Product[]; prices: PriceObservation[]; maxStores: 1 | 2 | 3 }
export interface PlanResult { id: string; assignments: Array<{ needId: string; ean: string; chain: PriceObservation["chain"]; quantity: number; costOre: MoneyOre }>; totalOre: MoneyOre; chains: PriceObservation["chain"][]; substitutions: string[]; coverage: 1; freshness: Record<string, string> }
```

Implement `formatNok` with `Intl.NumberFormat("nb-NO", { style: "currency", currency: "NOK" })` and normalize its non-breaking spaces to ordinary spaces for stable UI/tests. Implement freshness using elapsed milliseconds with inclusive 72-hour eligibility.

- [ ] **Step 4: Prove schemas reject unsafe input**

Add Zod tests rejecting zero quantity, `maxStores: 4`, an unapproved flexible rule, negative price, and an invalid EAN. Run: `pnpm --filter @handleplan/domain test`; expected: all domain tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat: define Handleplan domain contracts"
```

### Task 3: Add PostgreSQL price cache and server-only environment validation

**Files:**
- Create: `packages/db/package.json`, `packages/db/src/schema.ts`, `packages/db/src/client.ts`, `packages/db/src/price-cache.ts`, `packages/db/drizzle.config.ts`
- Create: `apps/web/lib/server/env.ts`
- Test: `packages/db/src/price-cache.integration.test.ts`, `apps/web/lib/server/env.test.ts`

**Interfaces:**
- Consumes: `PriceObservation`.
- Produces: `PriceCache.getMany(eans: string[]): Promise<PriceObservation[]>` and `PriceCache.putMany(rows: PriceObservation[]): Promise<void>`.

- [ ] **Step 1: Write failing cache and secret-boundary tests**

```ts
await cache.putMany([observation]);
expect(await cache.getMany([observation.ean])).toEqual([observation]);
expect(() => readServerEnv({})).toThrow(/KASSAL_API_KEY/);
```

- [ ] **Step 2: Start PostgreSQL and verify red state**

Run: `docker compose up -d postgres && pnpm --filter @handleplan/db test`
Expected: FAIL because schema and repository are missing.

- [ ] **Step 3: Implement the focused schema**

```ts
export const priceCache = pgTable("price_cache", {
  ean: varchar("ean", { length: 14 }).notNull(),
  chain: varchar("chain", { length: 32 }).notNull(),
  amountOre: integer("amount_ore").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.ean, t.chain] })]);
```

Validate `KASSAL_API_KEY`, `DATABASE_URL`, and `KASSAL_BASE_URL` in a `server-only` module; `.env.example` contains names and non-secret defaults only.

- [ ] **Step 4: Run migration and tests**

Run: `pnpm --filter @handleplan/db db:migrate && pnpm --filter @handleplan/db test && pnpm --filter web test lib/server/env.test.ts`
Expected: cache round-trip and secret-boundary tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/db apps/web/lib/server/env.ts apps/web/lib/server/env.test.ts docker-compose.yml .env.example
git commit -m "feat: add server price cache"
```

### Task 4: Implement the Kassalapp adapter behind a deterministic contract

**Files:**
- Create: `packages/kassalapp/package.json`, `packages/kassalapp/src/schemas.ts`, `packages/kassalapp/src/client.ts`, `packages/kassalapp/src/fake.ts`, `packages/kassalapp/src/index.ts`
- Test: `packages/kassalapp/src/client.test.ts`
- Fixture: `packages/kassalapp/test/fixtures/search.json`, `packages/kassalapp/test/fixtures/prices-bulk.json`

**Interfaces:**
- Produces: `KassalappGateway.searchProducts(query, limit)` and `KassalappGateway.getBulkPrices(eans)` returning normalized domain objects.

- [ ] **Step 1: Write failing adapter contract tests**

```ts
expect(await gateway.searchProducts("lettmelk", 10)).toEqual([expectedProduct]);
expect(await gateway.getBulkPrices([ean])).toEqual([expectedExtra, expectedRema]);
expect(seenAuthorization).toBe("Bearer test-key");
```

- [ ] **Step 2: Verify failures**

Run: `pnpm --filter @handleplan/kassalapp test`
Expected: FAIL because `KassalappClient` is undefined.

- [ ] **Step 3: Implement validated requests**

```ts
export interface KassalappGateway {
  searchProducts(query: string, limit: number): Promise<Product[]>;
  getBulkPrices(eans: string[]): Promise<PriceObservation[]>;
}

export class KassalappClient implements KassalappGateway {
  constructor(private readonly options: { baseUrl: string; apiKey: string; fetch: typeof fetch }) {}
  // GET product search; POST /products/prices-bulk in chunks of at most 100 EANs.
}
```

Use Zod to parse upstream responses, an 8-second abort timeout, one retry only for `429`, `502`, `503`, and `504`, and never include headers or response bodies in thrown public errors.

- [ ] **Step 4: Test batching and failures**

Add tests for 101 EANs producing two calls, malformed JSON failing closed, timeout, `429` retry, and an upstream error whose message contains no API key. Run the package tests; expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/kassalapp
git commit -m "feat: add Kassalapp gateway"
```

### Task 5: Implement explicit matching and complete-plan optimization

**Files:**
- Create: `packages/domain/src/matching.ts`, `packages/domain/src/planner.ts`
- Test: `packages/domain/src/matching.test.ts`, `packages/domain/src/planner.test.ts`, `packages/domain/src/planner.property.test.ts`

**Interfaces:**
- Produces: `matchProducts(need, rule, products): Product[]` and `calculatePlans(request, now): PlanResult[]`.

- [ ] **Step 1: Write failing matching and invariant tests**

```ts
expect(matchProducts(need, exactRule, products).map(p => p.ean)).toEqual([exactRule.exactEan]);
expect(calculatePlans(requestWithMissingRequiredItem, now)).toEqual([]);
expect(calculatePlans(request, now).every(p => p.coverage === 1 && p.chains.length <= 3)).toBe(true);
```

- [ ] **Step 2: Verify red state**

Run: `pnpm --filter @handleplan/domain test matching planner`
Expected: FAIL because matching and planning functions are absent.

- [ ] **Step 3: Implement matching and plan enumeration**

Filter exact EANs exactly; constrained matches must satisfy every brand/size/family constraint; flexible matches require `userApproved`. For each one-, two-, and three-chain subset, choose the lowest eligible quantity-aware assignment for every need. Sum integer øre, reject incomplete assignments, then remove a plan when another has no higher total, no more chains, and no more substitutions with at least one strict improvement.

```ts
export function calculatePlans(request: PlanRequest, now: Date): PlanResult[] {
  const eligible = request.prices.filter(p => classifyFreshness(now, new Date(p.observedAt)) === "eligible");
  return paretoFrontier(enumerateCompleteAssignments(request, eligible));
}
```

- [ ] **Step 4: Add property tests**

Generate random baskets and assert deterministic IDs, exact coverage, no plan over `maxStores`, non-negative totals, and no returned dominated pair. Run: `pnpm --filter @handleplan/domain test`; expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/matching.ts packages/domain/src/matching.test.ts packages/domain/src/planner.ts packages/domain/src/planner.test.ts packages/domain/src/planner.property.test.ts
git commit -m "feat: calculate complete basket plans"
```

### Task 6: Expose search and plan APIs with cache fallback

**Files:**
- Create: `apps/web/lib/server/container.ts`, `apps/web/lib/server/plan-service.ts`, `apps/web/app/api/products/search/route.ts`, `apps/web/app/api/plans/route.ts`
- Test: matching `*.test.ts` files beside routes and service

**Interfaces:**
- Consumes: `KassalappGateway`, `PriceCache`, `calculatePlans`.
- Produces: `GET /api/products/search?q=` and `POST /api/plans` returning `{ plans, generatedAt, caveats }`.

- [ ] **Step 1: Write failing route tests**

```ts
expect(await searchJson("melk")).toMatchObject({ products: expect.any(Array) });
expect(await planJson(validBody)).toMatchObject({ plans: [{ coverage: 1 }], caveats: expect.arrayContaining([expect.stringMatching(/lagerstatus/)]) });
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter web test app/api lib/server/plan-service.test.ts`
Expected: FAIL because routes and service are missing.

- [ ] **Step 3: Implement orchestration**

Validate request bodies with shared Zod schemas, fetch prices in bulk, write normalized observations to cache, and calculate plans. If Kassalapp fails, use cached observations only when each required product has an eligible cached price; otherwise return `503` with `{ code: "PRICE_DATA_UNAVAILABLE" }`. Return no upstream body, URL query, credential, or stack trace.

- [ ] **Step 4: Test fail-closed behavior**

Cover fresh cache success, stale cache rejection, missing item returning no “best” plan, search query below two characters returning `400`, and three-store maximum. Run focused tests; expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api apps/web/lib/server
git commit -m "feat: expose product and plan APIs"
```

### Task 7: Build anonymous Planlegg and local basket persistence

**Files:**
- Create: `apps/web/lib/browser-basket.ts`, `apps/web/components/planlegg/need-composer.tsx`, `basket-row.tsx`, `basket-workspace.tsx`, `travel-preference.tsx`
- Create: `apps/web/app/planlegg/page.tsx`
- Test: component and persistence tests beside files

**Interfaces:**
- Produces: `loadBasket(): BrowserBasket`, `saveBasket(basket): void`, and the `/planlegg` UI.

- [ ] **Step 1: Write failing browser-state and accessibility tests**

```tsx
expect(loadBasket(storage)).toEqual(emptyBasketV1);
await user.type(screen.getByLabelText("Hva skal du handle?"), "lettmelk");
expect(await screen.findByRole("option", { name: /TINE Lettmelk/ })).toBeVisible();
```

- [ ] **Step 2: Verify red state**

Run: `pnpm --filter web test components/planlegg lib/browser-basket.test.ts`
Expected: FAIL because components and storage adapter are missing.

- [ ] **Step 3: Implement versioned local state and the approved layout**

Use key `handleplan:basket:v1`; parse stored data with Zod and reset invalid data without throwing. Implement the flat two-column workspace from draft `e70c7978-04ed-4f97-809b-bfd215864238`. Search is a keyboard-operable combobox; selecting a product creates an exact rule, while a generic need opens constrained/flexible choices requiring explicit approval.

- [ ] **Step 4: Verify UI behaviors**

Test add, quantity edit, delete, exact lock, flexible approval, reload persistence, corrupt storage recovery, no account prompt, and that origin is absent from persisted JSON. Run focused tests; expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/planlegg apps/web/components/planlegg apps/web/lib/browser-basket.ts apps/web/lib/browser-basket.test.ts
git commit -m "feat: build anonymous Planlegg basket"
```

### Task 8: Build the approved result workspace and discrete plan selector

**Files:**
- Create: `apps/web/app/planlegg/resultat/page.tsx`, `apps/web/components/planlegg/plan-selector.tsx`, `plan-summary.tsx`, `store-assignment.tsx`, `price-provenance.tsx`
- Test: matching component tests

**Interfaces:**
- Consumes: `POST /api/plans` response.
- Produces: selected plan persisted as `selectedPlanId` and a radio-list-based convenience/savings frontier.

- [ ] **Step 1: Write failing result tests**

```tsx
expect(screen.getByRole("radio", { name: /Balansert/ })).toBeChecked();
await user.click(screen.getByRole("radio", { name: /Mest spart/ }));
expect(screen.getByText("793,20 kr")).toBeVisible();
expect(screen.getByText(/garanterer ikke lagerstatus/i)).toBeVisible();
```

- [ ] **Step 2: Verify red state**

Run: `pnpm --filter web test components/planlegg/plan-selector.test.tsx app/planlegg/resultat/page.test.tsx`
Expected: FAIL because result components are missing.

- [ ] **Step 3: Implement the workspace**

Reproduce approved draft `94532647-7d54-49fc-87b8-65ab0423bbe1`: route-grouped assignments on the left, sticky recommendation and vertical discrete alternatives on the right. Sort by fewest stores/lowest total at convenience end and lowest total/fewest substitutions at savings end. Show source timestamps, complete coverage, chain-price caveat, and savings relative to the lowest-cost fewest-stop plan.

- [ ] **Step 4: Verify loading and failure states**

Test complete results, no complete plan, `PRICE_DATA_UNAVAILABLE`, keyboard selection, persisted selection, Norwegian currency, and 320/768/1440 layout snapshots. Run focused tests; expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/planlegg/resultat apps/web/components/planlegg
git commit -m "feat: present complete plan frontier"
```

### Task 9: Prove the vertical slice end to end and document operation

**Files:**
- Create: `tests/e2e/planlegg.spec.ts`, `playwright.config.ts`, `docs/runbooks/local-development.md`, `docs/runbooks/kassalapp.md`
- Modify: `README.md`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the complete Phase 1 application.
- Produces: reproducible local runbook and CI gates.

- [ ] **Step 1: Write the failing Playwright journey**

```ts
test("anonymous shopper chooses a complete balanced plan", async ({ page }) => {
  await page.goto("/planlegg");
  await page.getByLabel("Hva skal du handle?").fill("lettmelk");
  await page.getByRole("option", { name: /TINE Lettmelk/ }).click();
  await page.getByRole("button", { name: "Finn beste handleplan" }).click();
  await expect(page.getByRole("heading", { name: /handleliste fordelt på rute/i })).toBeVisible();
  await expect(page.getByText(/alle varer/i)).toBeVisible();
});
```

- [ ] **Step 2: Run and verify red state**

Run: `pnpm exec playwright test tests/e2e/planlegg.spec.ts`
Expected: FAIL until the test fixture server wiring is added.

- [ ] **Step 3: Add deterministic E2E wiring and runbooks**

Start the web app with `KASSAL_MODE=fake` in Playwright; the fake gateway returns Bunnpris, REMA 1000, and Extra prices with fixed timestamps. Document PostgreSQL startup, 1Password environment-name usage without secret values, migration, dev, test, and cache-failure behavior. CI runs install, typecheck, lint, unit/integration tests, build, then Playwright.

- [ ] **Step 4: Run the full verification gate**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm exec playwright test`
Expected: every command exits 0; Playwright proves anonymous basket creation, complete plans, all three chains in the fixture, keyboard plan selection, stale-price fail-closed behavior, and no precise origin in local storage.

- [ ] **Step 5: Commit**

```bash
git add tests playwright.config.ts docs/runbooks README.md .github/workflows/ci.yml
git commit -m "test: verify Planlegg vertical slice"
```

## Phase 1 Completion Evidence

Phase 1 is complete only when the full Task 9 gate passes from a clean checkout, the browser network log contains no `KASSAL_API_KEY`, an intentionally stale fixture cannot produce a recommendation, and the approved Planlegg/result workspace is visually reviewed at mobile, tablet, and desktop widths. This phase does not claim travel-time routing, branch stock, flyer offers, Oppdag, or public-release readiness; those belong to the subsequent roadmap plans.

