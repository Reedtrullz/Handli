# Device and accessibility evidence (Task 18)

Date: 2026-09-22. Branch: `codex/prices-and-discounts`. All runs below were executed fresh in this session against the sealed public build:

- build source digest: `e82e322ffe4d5bd4b5d4e5eec8dd8cf9c84f28a01e4d1c3004e3f2fcf3113675`
- build artifact digest: `ee9ec798b88f44098c39d50298d3f54978246f279a8667538c2b9b39ef2759ec` (1643 files, 29 symlinks)

## Step 1: Automated browser journeys (verified 2026-09-22)

Commands:

```bash
corepack pnpm exec playwright test tests/e2e/v1-accessibility.spec.ts tests/e2e/planlegg.spec.ts
corepack pnpm e2e:handlemodus
```

Results:

- `v1-accessibility.spec.ts` + `planlegg.spec.ts`: **45/45 passed** across the configured chromium, firefox and webkit projects (1.2m). The harness used the production-standalone HTTPS server with the source-bound fake capability token and post-run leak-sentinel verification; no development server substitution.
- Handlemodus browser matrix (`offline-trip.spec.ts` + `accessibility-trip.spec.ts`): **12/12 passed** across chromium, firefox, webkit (19.2s), covering install, offline shell start, strict trip with reload while the application origin is unavailable, and mixed exact/reviewed-family plans during outage.

## Step 2: Physical iOS and Android trips — EXTERNAL GATE (not performed)

Installing the PWA on physical devices, disabling the network mid-trip, and verifying touch-target usability on real iOS/Android has not been performed in this session. No evidence file or plan checkbox claims it. This remains an external release gate requiring the reviewer's physical devices.

## Step 3: Accessible completion with assistive technology — EXTERNAL GATE (not performed)

Keyboard-only and VoiceOver completion of browse→list→plan→shopping on macOS/iOS has not been performed in this session. The automated suites include WCAG/axe checks, 200% text-only resize, 320px reflow, forced-colours and reduced-motion coverage (all passing), but automated checks do not substitute for a human screen-reader pass. This remains an external release gate.

## Non-claims

- No physical-device, VoiceOver, or TalkBack acceptance is claimed.
- The automated runs used the fake capability harness by design; they prove UI journeys, a11y wiring and offline shell behavior, not live source prices.
- The sealed build digests above bind this evidence to the exact current source snapshot; any later source change requires a rebuild and rerun before this evidence is current again.
