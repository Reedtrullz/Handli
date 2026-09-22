# Security, legal and public-governance evidence (Task 22)

Date: 2026-09-22. Branch: `codex/prices-and-discounts`.

## Step 1: Repository supply-chain checks (verified 2026-09-22)

```bash
corepack pnpm security:audit
corepack pnpm security:licenses
corepack pnpm security:secrets
corepack pnpm security:scripts:test
```

Results:

- `security:audit`: exit 0; **2 moderate advisories remain, 0 high/critical** (high advisories were closed in commit `ba26bb1`).
- `security:licenses`: `license-policy-ok packages=451 digest=08b6adec392a76d22a4d0a86bc8f0664156b97b6ce14570fd56a652f24f0172d`.
- `security:secrets`: `secret-scan-ok files=724`.
- `security:scripts:test`: **10 pass / 0 fail**.

## Step 2: Final shipment and prior key exposure — EXTERNAL GATES (not performed this session)

- Container/history scans on the exact candidate image are not performed here; the image does not exist yet (Task 23 builds the candidate).
- The previously committed Tjek key classification/rotation decision with the source owner has not been obtained this session. The working-tree secret scan passing does not erase Git history; the key remains treated as exposed until the owner states otherwise.

## Step 3: Operator facts — EXTERNAL GATE (not performed)

Named operator/data-controller, processors, retention/logging policy acceptance, confidential contacts, funding/conflict ledger, and correction/appeal ownership were not changed in this session. No names were invented and no contacts were tested (that requires explicit authorization).

## Step 4: Gate ledger re-assessment

`docs/release/v1-release-gates.md` was re-assessed on 2026-09-22: statuses remain `partial`/`blocked`; the 2026-07-18 assessment is explicitly retained as historical; no row was blanket-converted to `passed`.

## Non-claims

- Supply-chain script passes prove repository checks only — not image-layer cleanliness, live logging behavior, or legal acceptance.
- No source-rights decision was fabricated: SPAR/Joker/Europris ingestion remains BLOCKED pending authorized structured feeds, and G1 stays `blocked`.
