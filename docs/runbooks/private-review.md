# Private offer review boundary (V1-10)

## Status

The repository contains the private `/review` workspace, protected review APIs,
strict review contracts, an append-only PostgreSQL repository, migration guards,
and a dedicated least-privilege `handleplan_review` role. Migration 025 adds a
source-neutral, candidate-bound evidence renderer proof and one-time SQL
consumption boundary. Migration 028 refuses to upgrade over any historical PDF
render receipt and narrows receipt creation and approval to JPEG, PNG, or WebP.
Production Compose
also defines separate public and review processes from the same immutable image,
with disjoint database credentials and loopback upstreams. This is a
source-neutral foundation. It does not activate official offers, configure a
real Cloudflare Access application, grant retailer rights, seed a production
review queue or private capture, deploy the split runtime, or prove the
VPS/Caddy/volume state.

## Authentication boundary

Cloudflare must enforce a separate Access application/policy for `/review`,
`/review/*`, `/api/review`, and `/api/review/*`. The application then
independently verifies the
`Cf-Access-Jwt-Assertion` signature and never trusts the authenticated-email
header. Access and renderer configuration is fail closed and uses these server
variables; the separate least-privilege database URL is covered under the
database boundary below:

- `REVIEW_ACCESS_AUDIENCE`
- `REVIEW_ACCESS_ISSUER`
- `REVIEW_ACCESS_TEAM_DOMAIN`
- `REVIEW_BASE_URL`
- `REVIEW_EVIDENCE_PROOF_SECRET`
- `REVIEW_PRIVATE_CAPTURE_ROOT`

Issuer and team domain must be the same fixed
`https://<team>.cloudflareaccess.com` origin. The base URL must be a fixed HTTPS
origin. JWKS retrieval permits no redirects, has a three-second deadline, reads
at most 128 KiB as a stream, accepts only bounded unique RSA/RS256 signing keys,
and caches the validated key set for five minutes. Fetches are single-flight. A
cached unknown key ID permits one shared forced refresh per minute so legitimate
Access key rotation works without allowing an unknown-key flood to create an
unbounded request stream. After import, the verifier requires an RSA PKCS#1 v1.5
SHA-256 public verification key with a modulus of at least 2048 bits. Assertions
are bound to the configured issuer/audience, expiration, issued/not-before
clocks, a maximum 24-hour lifetime, RS256, and the exact review origin/path.

The Next.js 16 `proxy.ts` boundary authenticates `/review*` against the actual
inbound request URL before the page renders. It must not reconstruct a request
from `REVIEW_BASE_URL`; that would hide an alternate `Host`/origin from the
verifier. Review API routes retain their own auth-first verification at the
route boundary before parsing or service resolution.

The audit actor is `access:sha256(issuer + NUL + subject)`. A separate
`access-session:sha256(assertion)` binds a render proof to the current signed
Access assertion. Email, the assertion, and other Access claims are not stored
in the review action or returned to the browser.

Every missing, malformed, expired, wrongly signed, or wrongly scoped assertion
gets the same `404 {"code":"NOT_FOUND"}` with `Cache-Control: private,
no-store`. Authentication runs before query/body parsing and before the review
container or database is resolved, so an unauthorized caller cannot enumerate
queue size, candidate existence, capture existence, or backend health.

## Runtime process and proxy boundary

Production uses one commit-tagged image for two independent Next.js containers:

- `app` receives `DATABASE_URL` for `handleplan_web`, but receives no
  `REVIEW_DATABASE_URL`, `REVIEW_ACCESS_*`, or `REVIEW_BASE_URL` value;
- `review` receives `REVIEW_DATABASE_URL` for `handleplan_review`, the fixed
  Access/base-URL values, a distinct proof secret, and the private-capture
  root, but receives no public `DATABASE_URL`;
- the `private-captures` volume is read-write only in `worker`, read-only in
  `review`, and absent from public `app`; and
- both publish only to loopback (`127.0.0.1:3004` and `127.0.0.1:3006`).

Caddy rejects non-Cloudflare source ranges before selecting an upstream. While
the VPS remains an owner-only preview, it also rejects a missing Access assertion
for every path; the runtime split must not silently make the preview public. Its
exact privileged matcher contains only `/review`, `/review/*`, `/api/review`,
and `/api/review/*`. Those requests go to port 3006, while every other path goes
to the public app on port 3004. Therefore `/reviewed`, `/api/reviewer`, and
similar prefixes do not enter the privileged process. Header presence is only
an edge precondition: the review process performs the cryptographic
issuer/audience/origin/path check and returns the indistinguishable private 404
on invalid assertions. Caddy forwards that signed assertion only to review,
after first deleting every `Cf-Access-*` field and restoring only the assertion.
Both upstreams receive no Cookie, Authorization/Proxy-Authorization, Access
service token, Cloudflare identity/geography/correlation/client-IP, conventional
forwarded client-IP, or convenience user/email header. The public process also
receives no Access assertion. `X-Forwarded-Host` and `X-Forwarded-Proto` remain
available for origin/scheme handling; neither is accepted as reviewer identity.
Removing the hostname-wide preview gate requires a
separate, explicitly authorized public-release configuration change.

The review-container healthcheck calls its loopback API without an assertion
and requires a non-success 4xx response. On a deployed container, that provides
a liveness/fail-closed check without minting or embedding an Access credential,
while allowing rollback to a pre-review image to keep the privileged route closed.
Route-level tests separately require the exact private 404 body and
`private, no-store` cache policy. Neither check proves the external Cloudflare
policy or Caddy configuration running on the VPS.

## Database and rights boundary

Production requires a separately generated `REVIEW_DATABASE_PASSWORD` and a
`REVIEW_DATABASE_URL` whose username is exactly `handleplan_review`. The
migrator creates the role with no inheritance, ownership, role membership,
superuser, bypass-RLS, create-role, or create-database capability.

After migration 025, the role has no direct table or sequence privilege and can
no longer execute migration 021's v1 decision function. It may execute only a
bounded `SECURITY DEFINER` queue/detail/capture-locator reader, the exact render
receipt function, and the v2 decision function. The reader owns the complete
eligibility predicate; the render function repeats it after verifying exact
candidate/version/checksum/crop-reference/rights bindings; the decision function
owns every permitted append. The role therefore cannot
bypass eligibility with direct table reads, forge approved-offer rows or review
actions, update/delete evidence, publish an offer, inspect private
source-permission notes/keys, or read unrelated shopper/price-cache state.
Upgrade proofs capped before migration 021 retain only the historical grants
needed to reproduce those older database states.

Migration 028 locks the append-only receipt table, fails before changing schema
or ledger when any pre-existing PDF receipt exists, then installs a validated
image-only MIME constraint. It also narrows the render function and adds an
independent image MIME check to the v2 decision function. Thus a PDF capture
cannot create a receipt, while even an owner-injected non-image receipt cannot
authorize approval. Existing publication-capture metadata may still identify a
PDF for audit and rejection; migration 028 does not rewrite or delete it.

Queue, candidate, crop-locator, and decision reads require all of the following
at the captured evaluation clock:

- source runtime state is approved and its database-owned public-state clock is
  not in the future;
- the latest non-future permission is approved and unexpired;
- permission capabilities explicitly include `capture`, `officialOffers`, and
  `privateReview`; and
- capture rights are `private_review` or `public_display`—never `extract_only`.

Review decisions first lock the candidate, acquire the same per-source
transaction advisory lock used by permission/state changes, and then repeat the
rights check. This serializes a concurrent revocation with the decision. The
browser cannot provide source, chain, or scope; those values are derived from
the immutable database rows.

## Review actions

The queue supports chain, scope, age, confidence, and anomaly filters with a
bounded keyset cursor and no total-count response. A reviewer may always reject
a candidate with a reason. Approval and `correct_and_approve` remain disabled
until that reviewer has loaded the current candidate's verified evidence.

An opaque `review-crop:<sha256>` reference alone does not prove that an operator
saw the source. The queue therefore declares a `full_capture` render requirement
and explicitly states that crop geometry is unavailable. The renderer never
invents coordinates: it pins and revalidates the canonical parent-directory
descriptor chain, opens only the content-addressed file beneath the private
root, refuses symlinks and hardlinks, checks owner-only directory and file
modes, enforces a 50 MiB ceiling and MIME allowlist/signature, then verifies the
complete SHA-256 before returning bounded bytes with private no-store headers.
Production rendering is Linux-only and fails configuration closed elsewhere,
because descriptor-relative child lookup depends on `/proc/self/fd`; the
non-Linux pathname/snapshot fallback exists only for local development and tests.
The GET response contains no actionable approval proof. It carries only a
short-lived, candidate/session-bound challenge that cannot disclose the capture
checksum or authorize a decision by itself.

The browser must fetch the complete body, compute its SHA-256, and successfully
decode a supported JPEG, PNG, or WebP blob before sending the bounded challenge
acknowledgement. The server re-reads the current locator, verifies the challenge
and submitted digest against the database checksum, and only then records the
render receipt and returns the approval proof. PDF captures are rejected by the
evidence service and route and are neither fetched nor framed by the v1 browser
UI because a bounded structural page renderer does not exist; direct navigation
returns `EVIDENCE_UNAVAILABLE`, PDF approval and correction remain fail-closed,
and rejection stays available. The UI labels a supported image view honestly as
the full verified capture, not a crop. This proves a
complete byte delivery and browser decode event in the cooperative UI, not that
a human actually inspected every part of the artwork.

The acknowledgement proof expires within two minutes and is bound to candidate,
version, capture checksum, crop reference, rights classification, full-capture
presentation, pseudonymous actor, and current Access session. PostgreSQL stores
only its SHA-256 digest. Migration 025 rechecks the current rights/locator,
appends an immutable render receipt, and lets v2 approve/correct only with one
unexpired, unconsumed receipt. Migration 028 additionally requires the receipt
to be JPEG, PNG, or WebP at the table, recorder, and decision boundaries.
Consumption is appended in the same transaction as the review action.
Renderer-gated actions carry
`decision_boundary_version = 2`; legacy/direct v1-shaped actions retain marker 1
and are excluded by the migration-026 public-offer lifecycle. Forged, stale,
cross-candidate, cross-version, cross-session, wrong-digest, PDF,
revoked-rights, and reused proof attempts fail as
`EVIDENCE_UNAVAILABLE`; rejection requires no evidence proof.

Each request supplies the displayed candidate version. The repository locks
the candidate and rejects a stale writer before any projection/action insert.
Approval cannot
silently alter extracted fields; any difference requires the explicit
`correct_and_approve` action. Candidate and capture rows remain unchanged.
Successful review actions record bounded structured before/after audit data,
the pseudonymous actor, reason, action, version, and database timestamp and is
protected against update/delete.

Queue/detail API responses may contain typed candidate provenance and a
deterministic `review-crop:<sha256>` reference. They never contain the blob key,
capture checksum, byte length, reviewer email, raw proof token, or raw capture
bytes. Supported image bytes are available only from the exact Access-protected
candidate evidence endpoint, with no range/conditional response, redirect,
proxy, or cache path. PDF bytes are not returned in v1. The public app has
neither renderer secret nor capture mount. Do not expose
this endpoint, artwork, or proof through public catalog, discovery, plan, status,
or operations APIs.

## Deployment checklist

1. Keep official-offer public activation disabled.
2. Create a separate Cloudflare Access application and least-privilege reviewer
   group; record its exact team origin and bare, unquoted audience without
   copying tokens into the repository. Its audience must differ from the
   operations application audience. The two applications may share the same
   canonical HTTPS origin because their accepted path sets remain disjoint.
3. Generate a new 32–128 character URL-safe `REVIEW_DATABASE_PASSWORD` distinct
   from admin, worker, and web passwords.
4. Generate a distinct canonical base64url `REVIEW_EVIDENCE_PROOF_SECRET` from
   32–128 random bytes. Do not print or reuse it as a database/Access secret.
5. Populate these six names in the VPS-only production env:
   `REVIEW_DATABASE_PASSWORD`, `REVIEW_ACCESS_AUDIENCE`,
   `REVIEW_ACCESS_ISSUER`, `REVIEW_ACCESS_TEAM_DOMAIN`, `REVIEW_BASE_URL`,
   and `REVIEW_EVIDENCE_PROOF_SECRET`. Production Compose derives
   `REVIEW_DATABASE_URL` and fixes `REVIEW_PRIVATE_CAPTURE_ROOT` to the private
   read-only mount; never add that URL, secret, or Access value to public `app`.
   The example URL remains useful only for a standalone/local review process.
6. Use the production deployment script to quiesce and remove any existing
   `review` container before migrations start. The script must prove the old
   container absent before migration 021 can revoke its historical direct SQL
   grants; if quiescing, migration, or role reconciliation fails, keep review
   down and leave the already-running public app untouched. Only the normal
   post-migration Compose startup may recreate review. Run the CI ACL/upgrade
   proof as well, and do not infer success from app startup alone.
7. Render Compose and inspect all container environments and mounts: `app` must
   contain no `REVIEW_*` name and no private-capture mount; `review` must contain
   no public `DATABASE_URL` and its capture mount must be read-only; only worker
   may mount the same volume read-write.
8. Verify Caddy sends only the four exact review patterns to port 3006, rejects
   direct-origin traffic, and rejects a missing Access assertion globally before
   either preview upstream. Verify only the signed assertion reaches review.
   Verify neither upstream receives cookies, authorization or Access service
   credentials, convenience identity, Cloudflare/client forwarding IP,
   geography/correlation, or conventional forwarded-user/email headers, and
   verify the public app receives no Access header at all. Do not remove the
   hostname-wide preview gate as part of review-process isolation.
9. Before recording a deployment, require the review container to be running and
   healthy with zero restarts, the exact target image, and its immutable revision
   label equal to the target commit. Repeat this after the bounded worker wait.
   This successful readback is the first point at which review may be considered
   restored after the pre-migration quiesce. Any later startup or readback failure
   must remove and prove review, worker, and app absent before restoring at most
   a prior public image whose embedded revision label exactly matches recorded
   state; it must not restart the previous review or worker image. With no state,
   a pruned/mislabeled prior image, or any cleanup/absence-proof failure, all
   candidate runtimes stay down and rollback is refused. A legacy public-only
   fallback repeats review/worker absence proof before starting the app.
10. Verify unauthenticated, expired, wrong-audience, wrong-origin, and arbitrary-ID
   requests are indistinguishable and do not reach PostgreSQL.
11. Verify concurrent review attempts produce one action and one version conflict.
12. Verify permission revocation during a render/decision prevents a write, and that
   `extract_only` captures never reach the workspace.
13. Inspect browser/proxy/edge caches and logs for assertion, actor, session,
   crop-reference, blob-path, and capture-byte sentinels.
14. Prove that forged, stale, cross-candidate/version/session, bad-checksum,
    wrong-digest, header-only/aborted-body, PDF, revoked-rights, and reused proof
    attempts append neither a render receipt, offer, nor action. Prove
    symlink/hardlink/parent-swap/mode/MIME/size violations return no bytes.
15. Keep the route private until the remaining nonclaims below have evidence.

## Required proof and nonclaims

Local unit/static tests prove the code contracts, not the external system. V1
still requires live PostgreSQL migration/ACL/concurrency proof, deployed
Cloudflare policy and JWKS/key-rotation readback, a rights-approved source,
production private capture storage and a synthetic end-to-end renderer readback,
retention/deletion policy,
backup/restore coverage for private evidence, and an operator incident/offboard
exercise. The split Compose/Caddy configuration has static repository proof but
no deployed container-environment, loopback-port, direct-origin, route-isolation,
or external Access-policy readback. Repository tests do not prove that a real
capture can be rendered or approved on the VPS. Until those gates pass, the
queue is not production-ready and reviewed offers are not a public ranking
input. PDF rendering is intentionally outside v1; adding it requires a new
bounded page-rendering design and a reviewed forward database boundary.
