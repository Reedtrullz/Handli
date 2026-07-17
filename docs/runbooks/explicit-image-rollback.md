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

The operation lock is a directory, so an uncatchable kill or host failure can
leave it behind. Never delete a stale lock until process state, open handles,
container state, and the authoritative deployment files have been reviewed.
Concurrent deploy/rollback execution is intentionally refused.

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
