# External public monitoring

The repository contains an external, read-only monitor in
`.github/workflows/external-public-monitor.yml`. GitHub-hosted Actions keeps the
probe outside the Handleplan VPS failure domain. The scheduled job performs
three bounded `GET` requests:

1. `/api/health` must return the exact process-liveness contract and the
   configured deployed revision.
2. `/api/ready` must return the exact database-readiness contract and the
   configured required migration.
3. `/api/source-status` must return the strict public source-status contract,
   a response clock no more than five minutes old, and `overall: operational`.

Each request has a five-second attempt timeout, at most three attempts, a
bounded response body, manual redirect handling, and a small bounded retry
delay. A source status of `degraded`, `unknown`, or `no-approved-sources` fails
the monitoring job. This creates an alert signal; it does not restart, deploy,
or otherwise mutate the application. The workflow has only `contents: read`
permission and contains no VPS credential, SSH step, deployment command, or
recovery action. Source degradation should qualify or remove affected claims
through the application data boundary, not create a web restart loop.

This scheduled monitor is separate from the deployment-time external promotion
probe in `.github/workflows/deploy-preview.yml`. That probe uses the `preview`
Environment's Access service token, refuses redirects, and requires the exact
`/` to `/planlegg` temporary redirect, candidate public-build marker, health
revision, and readiness migration. A candidate remains token-bound in
`state/pending-deployment` until the probe succeeds. Immediately before any
external request, the workflow revalidates its exact seven-field tuple,
candidate and predecessor images, fresh token, current/high-water state, and
bounded remaining deadline under the shared VPS lock. Failure triggers the exact
predecessor rollback through a token-bound, network-independent, bounded VPS
resolver; runner cancellation or loss is covered by the VPS deadline watchdog.
Acceptance records that tuple in `state/accepted-deployment` before consuming
pending state. A lost runner response therefore reconciles as already accepted
instead of rolling back a publicly verified candidate. Missing or malformed
pending state without the exact accepted receipt closes candidate runtimes and
preserves uncertain state; workflow arguments alone do not create rollback
authority. If a newer acceptance has replaced an older receipt, the older
watchdog may close its candidate only while that candidate still owns the
deployment high-water mark. An authorized explicit rollback preserves the newer
high-water mark, so a superseded watchdog cannot take the rollback target
offline. Every detached watchdog also holds one token-named, seven-field lease
under `state/pending-watchdogs/`. Admission validates the whole ledger and
allows at most four leases; stale leases consume capacity, while malformed or
symlink-shaped entries fail closed. The owning watchdog polls the locked
resolver every two seconds, retires its exact lease promptly after acceptance,
or consumes that same lease when its terminal rejection path exits. No PID is
stored, killed, or trusted as cleanup authority.

The shell marker is accepted only as one exact direct child of the parsed HTML
head, so raw comment, script-text, body, or duplicate decoys fail promotion.
These checks do not make the scheduled monitor, alert
delivery, or dead-man chain active.

## Required GitHub configuration

Create a GitHub Environment named `external-public-monitor`. Limit its
deployment branches and tags to the protected default branch only. Do not add a
required-reviewer approval gate, because that would leave scheduled probes
waiting for manual approval. Treat environment administrator access as a
credential-management boundary and audit changes to its policy.

The monitored origin is pinned in reviewed code and workflow configuration to
`https://handle.reidar.tech/`. The checker rejects every other origin before it
constructs a request carrying Access credentials. A domain change therefore
requires a reviewed source change; do not turn the origin back into a GitHub
variable.

Configure these environment variables (not repository variables):

- `HANDLEPLAN_MONITOR_EXPECTED_REVISION`: the full 40-character lowercase Git
  revision currently deployed.
- `HANDLEPLAN_MONITOR_EXPECTED_MIGRATION`: the migration filename the deployed
  readiness contract must report, for example
  `028_private_review_image_evidence_only.sql`. Update this environment variable
  in deployment lockstep with the application/readiness promotion; a stale
  value must alert rather than teaching the monitor to accept either version.

Configure these environment secrets for a least-privilege Cloudflare Access
service token restricted to the three monitoring paths:

- `HANDLEPLAN_MONITOR_CF_ACCESS_CLIENT_ID`
- `HANDLEPLAN_MONITOR_CF_ACCESS_CLIENT_SECRET`

Do not place either value in repository variables, workflow inputs, command
arguments, issue text, artifacts, or run summaries. Rotate the token after any
suspected exposure and at the operator's documented credential interval.

The checker sends the values only in Cloudflare Access request headers. It
never prints headers, response bodies, endpoint URLs, request metadata,
provider or source error details, addresses, coordinates, queries, or baskets.
Its only output is an allowlisted JSON outcome containing contract version,
probe states, or a fixed failure code. Do not add `curl --verbose`, shell
tracing, request dumps, or dynamic exception messages to this workflow.

## Notification and protection setup

Before treating the monitor as operational:

1. Merge the workflow into the default branch, configure all four names, and
   restrict the `external-public-monitor` Environment to that protected branch.
   A scheduled workflow that exists only on a feature branch does not run on a
   timer. The job also rejects a manual dispatch from any other ref, but the
   Environment restriction is the policy boundary that a branch cannot edit.
2. Run `External public monitor` manually with the exact deployed revision and
   required migration. Confirm one successful run from a GitHub-hosted runner.
3. Subscribe the maintainer or the chosen incident channel to failed runs of
   this workflow using GitHub Actions notifications or an independently
   operated notification integration. Record delivery evidence without secret
   values or request/response data.
4. Make `External public monitor / Verify monitor contracts` a required check
   on the protected default branch. The lightweight static check intentionally
   runs on every pull request so GitHub can always resolve the required check.
   Do not require the scheduled network-probe job; pull requests never execute
   that job and receive no monitoring secrets.
5. Protect `.github/workflows/external-public-monitor.yml`,
   `scripts/operations/check-public-monitor.mjs`, its tests, and this runbook
   with a GitHub ruleset requiring at least one non-author approval. Dismiss
   stale approvals after changes, require approval after the latest push, and
   restrict bypass. Add CODEOWNERS coverage when at least two eligible
   maintainers exist; the author must never be the only effective reviewer of
   code that can receive the monitoring Environment secrets. Retain ruleset
   configuration and one non-author approval as activation evidence.
6. Keep the expected revision variable coupled to the successful production
   promotion/readback procedure. A revision mismatch is an alert, not a reason
   for the monitor to accept whichever revision happens to answer.
7. Configure an independently operated dead-man monitor outside both GitHub
   Actions and the VPS. It must expect a completed scheduled probe at least
   every 15 minutes and alert the maintainer after a bounded missed-heartbeat
   window (initially 45 minutes). The heartbeat must contain only an opaque
   monitor identifier and an allowlisted completion state; it must not contain
   Access credentials, endpoint URLs, headers, response bodies, request
   metadata, addresses, queries, baskets, or source error detail. No heartbeat
   transport/provider is selected or implemented in this repository yet.
8. Drill the missed-heartbeat alert and retain redacted delivery evidence before
   calling the monitoring chain operational. A green scheduled run and a
   successful red-job notification drill do not by themselves prove detection
   of an absent schedule or unavailable GitHub Actions.

GitHub Actions retention is useful execution evidence but is not a substitute
for retained, immutable operational telemetry or an incident record.

## Alert drill

Run the drill from `workflow_dispatch`; never weaken production health or
restart the app to manufacture a failure.

1. Record the current workflow revision, deployed revision, migration, UTC
   start time, and intended recipient in the private drill record.
2. Supply a known non-deployed 40-character revision as the manual
   `expected_revision`. The job must fail with only `REVISION_MISMATCH` in its
   sanitized outcome.
3. Confirm that the configured recipient receives the failed-run notification
   within the agreed alert target. Record a redacted delivery identifier and
   receipt time.
4. Rerun with the exact deployed revision and migration. The job must close
   green without changing the app or VPS.
5. For a source-degradation drill, use a controlled test environment or a
   fixture-backed checker test. The expected failure code is
   `SOURCE_DEGRADED`; the application must remain live and no restart or deploy
   action may occur.
6. File and close any gap found in delivery, ownership, expected-revision
   updates, or recovery documentation.

Drill the dead-man separately in a controlled environment: stop only the test
heartbeat, wait for the documented missed-heartbeat threshold, confirm receipt,
restore the heartbeat, and confirm closure. Do not disable the production
monitor or disturb the application to conduct this drill. Retain the redacted
alert and closure timestamps.

Repeat the app/source alert drill before public v1 and after material changes
to the access boundary or notification route. Backup, disk, certificate, and
clean-host recovery drills are separate V1-17 evidence and are not proven by
this workflow.

## Activation and evidence boundary

Repository presence is scaffolding only. At the time this runbook was added,
there is no repository evidence that the workflow is on the default branch,
that the Environment restriction, variables, or Cloudflare Access secrets are
configured, that a
scheduled probe has run, or that a failure notification reached a maintainer.
There is also no selected or configured independent heartbeat receiver and no
missed-heartbeat delivery evidence, so absence of scheduled runs is not yet
detected.
No repository evidence currently proves the required ruleset, CODEOWNERS
coverage, or a non-author approval for the secret-bearing monitor paths.
Therefore external monitoring and alert delivery are explicitly **not active
or proven**. A public-v1 claim requires links or immutable references to the
successful external probe and completed notification drill, plus the separate
operational evidence listed above.
