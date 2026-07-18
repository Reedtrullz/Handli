# Explicit immutable image rollback

**Operational state:** implemented and test-covered; no live VPS rollback is
claimed.

`deploy/rollback-on-vps.sh` is the supported post-commit rollback command. It
moves application runtimes to an older image without reversing database
migrations. It is separate from automatic failed-candidate recovery, which may
restore only a source-disabled public shell.

## Preconditions

Use the command only when all of these are true:

- the target is an ancestor of the currently committed revision on fetched
  `origin/main`;
- both the target and current revision have create-once records under
  `state/verified-images/` that bind the full commit SHA to a local Docker
  `sha256:<64 hex>` image ID;
- `state/current-image-id`, `state/current-deployment`, `state/current-revision`,
  and `state/deployment-high-water` pass the fail-closed state parser;
- the target image is still present and its exact image ID and OCI revision
  label match the stored record;
- neither a regular nor symlink-shaped `state/pending-deployment` path exists;
  this is checked after the command owns the shared operation lock;
- `/opt/apps/handleplan/operations/current` is the exact controls release for
  the newest migration attempt. It may intentionally be newer than the current
  application after a post-migration candidate failure; and
- the incident owner has reviewed whether the worker should retain source
  access. Revoke source governance before rollback when the incident concerns
  upstream access or rights.

The command requires the target SHA and the exact current SHA as a compare-and-
swap guard:

```sh
sudo -u deploy \
  /opt/apps/handleplan/operations/current/deploy/rollback-on-vps.sh \
  <target-full-sha> <expected-current-full-sha>
```

Do not infer either argument from a mutable tag. Read the current full SHA from
the authoritative state manifest, select only an already verified target, and
record the operator/change approval outside command output. The command accepts
no database credential or image tag argument.

## State and execution contract

Normal deployments advance `state/deployment-high-water` and create an
immutable revision-to-image-ID record after exact runtime readback. An explicit
rollback changes the current revision/image fields but deliberately leaves the
high-water revision unchanged. The normal deploy path compares every candidate
to that high-water mark, so a delayed CI completion cannot use the rollback to
deploy an intermediate older commit. Re-deploying the high-water revision or a
descendant is the supported forward recovery.

The rollback acquires the same create-only operation lock as normal deployment,
renders the latest Compose controls with the target image ID, and validates the
model before stopping anything. It then stops, removes, and proves all app,
review, operations, and worker containers absent. It runs `docker compose up
--no-deps` with the old image ID and never starts `migrate`, calls
`deploy/migrate.mjs`, or runs a down migration. Readback requires:

- public health reports the target full SHA;
- all four containers are running, healthy, restart-free, and use the exact
  target image ID and revision label; and
- the private worker health endpoint is ready and reports the target SHA.

Only after those checks pass does the signal-masked state transition record the
target as current while preserving the high-water revision.

## Failure behavior

An error or catchable signal after quiescing starts causes the command to remove
the target containers, restore the previously committed image by its immutable
ID under the same current controls, and verify it. Failures before the final
state commit leave state unchanged. The manifest, compatibility marker, image
ID, and high-water files are individually atomic but not one filesystem
transaction; an I/O failure during their signal-masked commit can leave a
deliberately invalid cross-file state that blocks the next operation until
reviewed repair. If
either cleanup or restoration cannot be proven, it removes the prior runtime as
well and leaves all four services down. It never records a partially verified
target and never falls back to a mutable image tag.

The token-bound pending-deployment resolver does not invoke this operator path.
It uses a dedicated, network-independent transition under the same operation
lock because the forward deploy already proved and recorded the exact
predecessor. It atomically revalidates the pending token and current candidate,
bounds every Docker operation, and arms closed cleanup before any further
preflight. If the predecessor cannot pass exact runtime readback, it removes all
application runtimes and preserves both pending and current state for review
instead of putting the rejected candidate back online. This narrower resolver
path must not be used to bypass the explicit operator rollback preconditions.

The operation lock is a directory, so an uncatchable kill or host failure can
leave it behind. Never delete a stale lock until process state, open handles,
container state, and the authoritative deployment files have been reviewed.
Concurrent deploy/rollback execution is intentionally refused.

Detached pending watchdogs are capacity-bound by exact leases in
`state/pending-watchdogs/`. Do not remove a stale, malformed, or symlink-shaped
lease merely to admit another deployment: the lease is the fail-closed evidence
that a watchdog may still exist, and PID identity is deliberately not used.
Reconcile the lease's full candidate, predecessor, deadline, and token tuple
with pending/accepted/current state before any operator repair.

An exact `state/pending-deployment` record means external promotion has not
finished. Do not clear it or start an unrelated rollback to bypass the pending
resolver. The deploy workflow's token-bound reject path (or its detached
deadline watchdog) must either restore the recorded predecessor and clear the
record, or leave it in place for incident review when current state differs.
Because a pending record blocks newer automated deployment, its presence is a
safety signal rather than stale scratch state.

The command enforces this rule rather than relying on operator discipline: any
path at `state/pending-deployment`, including a broken symlink, aborts before
state loading, Git, Docker, or runtime mutation. Resolve or investigate it
through the pending-deployment protocol; never remove it to force rollback.

## Evidence and non-claims

Retain the command exit status, redacted stdout health summaries, exact before
and after state files, target/current image IDs, and local container readback.
Do not retain secrets or the protected environment file.

Repository tests cover successful state rollback, preserved high-water state,
missing/conflicting immutable bindings, target-start failure, restoration of
the committed runtime, absence of migration invocation, and shell syntax. They
do not prove a real VPS rollback, old-image compatibility with every newer
schema, host power-loss recovery, Cloudflare/Caddy behavior, source rights, or
public availability. A separately retained exact-parent-image boot proof is a
compatibility gate; it is not replaced by the rollback command itself.
