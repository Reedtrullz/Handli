# MENY Offer Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver MENY customer-magazine offers into the official-offer foundation through a reviewed embedded-text extractor, without inventing scope, validity, currency or identity the payload does not carry.

**Architecture:** Two-request intake (discovery API for the official viewer destination, then viewer HTML), parse `window.staticSettings.pageTexts` with text anchors, emit candidates through the existing `OfficialOfferExtractor` embedded-text port for foundation review. No new publication path, no OCR, no enrichment-JSON use for offers.

**Tech Stack:** Node 22, TypeScript, Vitest, existing official-offer foundation and zod contracts.

**Spec:** `docs/evidence/release-readiness/meny-source.md` (qualification) and `docs/superpowers/plans/2026-09-08-handleplan-full-release.md` Task 10.

## Global Constraints

- Candidates conform to `extractedOfficialOfferCandidateV1Schema`; envelope to `officialOfferExtractionEnvelopeV1Schema`.
- Do not fabricate prices, before-price savings, scope, validity, currency, EANs or review decisions.
- No production wiring in this task; ingestion into the trust fence stays blocked until the scope-authority decision (see "Blocked" below).
- Text-anchor fixtures only: committed fixtures quote anchors from the qualified capture; raw viewer bytes stay private (image rights unproven).

## Review Focus

- Scrambled page-3 layouts where the product name follows the price: must fail closed, never pair a price with the wrong name.
- Comparison unit prices (`(141,43/KG)`) and before-prices (`FØRPRIS72,90`) must never become offer prices.
- Percentage-only blocks (50 %, 30 %) and footnote blocks must skip, never price.
- Geographic scope stays `unknown` per candidate; the publication fence will reject it until a scope decision exists.

## Tasks

### Task A: Extractor implementation (done — this commit)

- [x] Fixtures from real text anchors: split-digit price, before-price, multi-pack decimal, comparison prices, percentage-only, footnote, scrambled before-price layout.
- [x] `parseMenyStaticSettings` with strict payload validation.
- [x] `parseMenyOffers` block parser: one candidate per UKENS TILBUD block with an absolute price; label-before-price; package parse incl. `PK 8X1,5L` = 1500 ml × 8; Trumf member detection; comparison/before-price/footnote guards; skip counters.
- [x] `createMenyEmbeddedTextExtractor` returning outcome `{state:"available", envelope}` with schema-valid envelope bound to capture checksum.
- [x] Layout fingerprint derived from a stable review marker (createHash sha256 of "meny-page-texts-review-v1"), matching the Tjek fingerprint convention.
- [x] 9 vitest tests green; worker typecheck clean.

### Task B: Production wiring (scope decision applied; protected staging capture remains)

- [x] Add `meny` `data_sources` row + `source_permissions` migration: `deploy/migrations/043_meny_official_offer_source.sql` (approved offer source, officialOffers/capture/discover/extract + public_display, permission_reviewed_at).
- [x] Wire extractor into runtime dispatch — implemented as the sourceId-routed `officialOfferDiscovery` branch in `production.ts` (`context.sourceId === "meny"` routes to the MENY handler; the kind-keyed Tjek map is untouched), plus `meny-handlers.ts`, `meny-production.ts`, bootstrap schedulers and `MENY_ENABLED` (commit `825eb55`).
- [ ] Protected staging capture under worker credentials; representative review; public inclusion/exclusion proof by scope. (Still open — belongs with Task 15 lifecycle observation; requires live worker credentials and the current MENY edition, which rotates: Uke 39 expires 2026-09-26.)
- [x] Scope fence resolved: reviewed national NO permission recorded in migration 043, using external evidence (meny.no/om-meny states "landsdekkende kjede", HTTP 200, 2026-09-22) per the Extra/Tjek national precedent. Payload itself still carries no scope field; candidates keep `unknown` scope and the foundation review fence governs inclusion.

## Explicit failures and limits

- Validity is unreadable in the payload (headline text only): every candidate carries `validity: unreadable/MISSING` and `UNREADABLE_DATE`.
- Currency is fixed to NOK by adapter convention; no source-field proof exists (license says DKK — untrusted).
- Multibuy ("PLUKK & MIKS 3 2") blocks carry no absolute price in the text layer; no multibuy pricing is emitted. Automated multibuy extraction requires a new reviewed anchor.
- Name-after-price layouts skip instead of pairing; future improvement only with a reviewed anchor proving the pairing.
- Percentage-only and percentage-plus-member-bonus blocks are marketing labels, not savings; skipped.
- Expired-edition behavior unobserved during qualification; remains an open item before runtime wiring.
