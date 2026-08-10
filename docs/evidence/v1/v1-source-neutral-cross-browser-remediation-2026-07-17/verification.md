# Source-neutral v1 cross-browser remediation verification — 2026-07-17

Status: **implementation milestone; public release remains blocked**

Source commit: `29fb91a6ae3e7a9ed79243f6b70007a0d0ce434c`

The adjacent `release-candidate.v1.json` is a new, immutable
`draft_unverified` ledger generated from the signed source commit above. It
does not overwrite the prior
[`v1-source-neutral-typecheck-remediation-2026-07-17`](../v1-source-neutral-typecheck-remediation-2026-07-17/verification.md)
milestone. Its source binding is deliberately `baseline_only`, all twelve
release gates remain incomplete, and no supported launch region is declared.

## Why this milestone exists

The [preceding exact-head CI run](https://github.com/Reedtrullz/Handli/actions/runs/29580367609)
passed the repository, PostgreSQL, restore, least-privilege, previous-image,
typecheck, lint, unit, build, image-handoff, and deploy-asset stages before the
Handlemodus browser job exposed three test-harness differences:

- the production `upgrade-insecure-requests` policy made an HTTP-only harness
  unusable in WebKit;
- Playwright's Firefox offline override replaced the app with Firefox's native
  offline document instead of exercising the service-worker fallback; and
- WebKit did not expose service-worker-originated API traffic to `page.route`,
  allowing a synthetic location request to fall through to the unconfigured
  database route.

The browser harness now exposes the exact production build through an
ephemeral loopback HTTPS proxy while preserving production response headers.
It uses a separate loopback-only, custom-header-protected control plane to drop
the application origin and to serve only three exact, bounded, JSON-only test
API fixtures. Request bodies remain bounded, memory-only, and reset between
single-worker tests. Every outage transition is corroborated in the browser by
a unique uncached `/api/health` request that bypasses the service worker and
must reject promptly.

Chromium, Firefox, and WebKit now execute the same strict, reviewed-family,
travel-privacy, cache-boundary, persisted-checklist, and axe/reflow journeys.
Chromium alone needs a test-scoped certificate-bypass launch flag because its
service-worker process does not inherit the browser-context certificate
exception. No production server, browser, CSP, service-worker, planner, or
privacy behavior was weakened.

## Local diagnostic proof

These checks are source diagnostics, not retained candidate-current Linux,
production, legal, device, or manual release evidence:

| Check | Result |
|---|---|
| Recursive workspace typecheck | passed across all five checked projects on Node.js 22.22.3 |
| Recursive workspace lint | passed across all five checked projects on Node.js 22.22.3 |
| Domain unit suite | 318/318 tests passed |
| Kassalapp unit suite | 104/104 tests passed |
| Database unit suite | 319/319 tests passed; 65 PostgreSQL integration tests were skipped without a configured test database |
| Worker unit suite | 176/176 tests passed |
| Web unit suite | 668/668 tests passed |
| Web production build | passed with 24 generated routes |
| Production-build Handlemodus matrix | 9/9 passed: three identical journeys in Chromium, Firefox, and WebKit |
| Harness lifecycle | no remaining listeners on ports 3115–3117 and no remaining ephemeral TLS directory |
| Source review | two independent read-only reviews reported no remaining correctness, privacy, lifecycle, or evidence-overclaim finding |
| Worktree validation | JavaScript syntax and whitespace validation passed before the source commit |

The browser result proves behavior while the Handleplan application origin is
unavailable. It does **not** prove total device/radio disconnection,
`navigator.onLine === false`, physical-device PWA behavior, or unrelated
network origins. The app's current same-origin CSP and provider-free offline
trip make application-origin outage the relevant automated contract; physical
iOS and Android offline acceptance remains a separate release gate.

The fresh PostgreSQL 16.10 integration proof remains recorded in the prior
[PostgreSQL verification](../v1-source-neutral-pg-remediation-2026-07-17/verification.md).
It was not rerun locally for this browser-only source change. The diagnostic
runs above intentionally retained no screenshots, traces, video, request
bodies, or raw reports; this note does not promote them into release-grade
evidence.

## Explicit nonclaims

- Replacement exact-head GitHub Actions, immutable image, registry, container
  scan, preview, production, and rollback evidence are not embedded in this
  draft. The external workflow result must be evaluated separately.
- Bunnpris, REMA 1000, and Extra still lack rights-approved live ordinary-price
  and official-offer inputs for a selected region. The real 60-run corpus and
  manual basket reconciliations remain absent.
- Live Cloudflare Access, Caddy, VPS, Kartverket, Valhalla, off-host backup,
  alert delivery, clean-host restore, physical-device, VoiceOver, legal, and
  governance acceptance remain unproven.
- No release, merge to `main`, source activation, public launch, or VPS
  deployment is authorized by this milestone.
