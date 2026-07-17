# V1-18 automated accessibility delta — 2026-07-17

Status: **local source-neutral evidence; G8 remains partial**

This record covers two previously missing automated checks. It is not a
candidate-release accessibility report.

## What is now covered

- The shared Playwright helper represents 400% reflow as the deterministic
  standards-equivalent change from a 1280 CSS px baseline to a 320 CSS px
  viewport. Complete Planlegg results and Oppdag both assert the ratio, semantic
  structure, target sizes, horizontal reflow, and an unfiltered whole-page axe
  scan. The first Chromium run exposed a three-pixel Oppdag overflow in the
  result count; the narrow-layout heading now stacks and the focused rerun is
  clean. The shared helper also fails when any rendered element is positioned
  outside the viewport, even if the root `scrollWidth` remains 320 CSS px; a
  synthetic negative-position regression locks that distinction down.
- An anonymous browser request reaches the real `/review` proxy matcher with no
  Access assertion, review environment, API interception, or private fixture.
  The fail-closed response is a generic Norwegian HTML 404 with one heading,
  `private, no-store`, `noindex, nofollow`, `nosniff`, and no review candidate,
  crop, or source detail. That denied boundary receives the same unfiltered axe
  and structure checks as the public journeys.
- The policy test prevents the Playwright configuration from adding a review
  assertion or review environment and keeps the denial response generic.

## Local verification

Environment: Node.js 22.22.3, pnpm 10.34.5, macOS local worktree.

| Check | Result |
|---|---|
| Focused Vitest: review proxy, reflow-helper negative regression, and V1 accessibility evidence policy | 10/10 passed |
| Focused ESLint for in-app sources | passed with zero errors |
| Web TypeScript | passed |
| Root Playwright discovery | 45 tests discovered: 15 scenarios in Chromium, Firefox, and WebKit |
| Handlemodus Playwright discovery | 9 tests discovered: 3 scenarios in Chromium, Firefox, and WebKit |
| Focused Chromium execution: complete-result 400%-equivalent reflow, Oppdag 400%-equivalent reflow, denied review-boundary axe | 3/3 passed after the overflow fix |

## Explicit nonclaims

- The 1280-to-320 check is a cross-engine viewport equivalent. It does not prove
  that any browser's native zoom UI was operated at 400%.
- Firefox and WebKit were discovered but not executed locally because the
  matching Playwright browser binaries are not installed. Installing them was
  not attempted while the disk safety margin was close to the 30 GiB stop
  threshold.
- The authenticated private review workspace was not opened or axe-scanned.
  This evidence deliberately covers only the generic denied Access boundary;
  it neither bypasses Access nor sends private review data to a browser fixture.
- No VoiceOver, physical iOS/Android, browser-native zoom, candidate-release
  keyboard-only, or manual Norwegian copy report was performed.
- No production build, exact-commit CI run, preview/production deployment, or
  release-gate approval is established by this record.
