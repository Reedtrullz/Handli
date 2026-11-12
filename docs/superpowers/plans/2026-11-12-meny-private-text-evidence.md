# MENY Private Text Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare a protected MENY text-evidence review path without executing source HTML or enabling production review.

**Architecture:** Reuse checksum-bound full-capture delivery and the existing challenge/proof lifecycle. Render bounded, validated UTF-8 bytes as escaped text, with an explicit reviewer acknowledgement. Add a forward migration with independent MENY-only receipt and decision fences.

**Tech Stack:** Existing Node22, TypeScript, React19, Next16, PostgreSQL16 and Vitest; no dependencies.

**Spec:** ../specs/2026-11-12-meny-private-text-evidence-design.md

## Global Constraints

- Preserve original-byte SHA-256 and all Access, filesystem, source rights, permission, candidate/version/session, expiry and one-use proof checks.
- Text evidence limited to MENY text/html captures, at most1MiB and valid UTF-8 without NUL; serve only text/plain;charset=utf-8.
- No production source grants, deployments, ingestion or offer decisions; Tjek and portfolio holds remain unchanged.

## Review Focus

- Script/iframe/markup stays literal text, never creates active DOM or source requests.
- Other-source HTML, PDF, invalid encoding and oversized text fail closed.
- Wrong digest, candidate, session, version, stale/replayed proofs remain denied.
- Database receipt insertion and approval each independently reject mismatched text capture bindings.
- Images keep decode-before-ack behavior, private headers, and current proof semantics.

### Task 1: Verified text transport

- [x] Add failing bounded UTF-8/domain, reader, service and response-route tests.
- [x] Add shared text byte limit/decoder, MENY namespace guard, plain-text MIME translation; preserve filesystem controls.
- [x] Verify focused tests and types.

Files: packages/domain/src/review-contracts*, apps/web/lib/server/review-evidence-reader*, review-evidence-service*, apps/web/app/api/review/candidates/[candidateId]/evidence/route*.

### Task 2: Receipt and decision boundary

- [x] Add failing migration/SQL integration coverage for valid MENY text, wrong source/capture, PDF, oversize, expiry/session/replay and missing privateReview.
- [x] Add migration047 with drift-checked forward function changes plus an independent original-capture constraint/trigger; no source grant or history rewrite.
- [x] Verify real PostgreSQL integration in local test service or fresh native CI.

Files: deploy/migrations/047_meny_private_review_text_evidence.sql, packages/db/src/private-review-meny-text-evidence*, existing review integration fixtures where relevant.

### Task 3: Escaped review UI and delivery

- [x] Add failing UI tests for literal hostile markup, explicit acknowledgement before approval, unsupported source and failed/expired acknowledgement.
- [x] Render full UTF-8 source in an accessible preformatted text view; preserve image loading, cancellation and object URL cleanup.
- [ ] Update private-review runbook; run focused suites, typecheck/lint and fresh CI; open a reviewable PR without merge/deploy.

Files: apps/web/components/review/review-workspace*, docs/runbooks/private-review.md.

## Current acceptance

Local checks and synthetic real-browser QA passed. Fresh branch CI and independent review remain separate gates. The current-chat OmO preflight reports adoption/toolAcceptance pending, so no reviewer was dispatched and no independent review is claimed. No setup probes, role changes, production review grants, deployments, ingestion or offer approvals are part of this prepared change.
