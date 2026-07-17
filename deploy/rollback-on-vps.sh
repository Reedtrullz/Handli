#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_dir/deployment-state.sh"

app_root=${HANDLEPLAN_APP_ROOT:-/opt/apps/handleplan}
repository_url=${HANDLEPLAN_REPOSITORY_URL:-https://github.com/Reedtrullz/Handli.git}
target_revision=${1:-}
expected_current_revision=${2:-}

valid_deployment_revision "$target_revision" || {
  echo "Usage: $0 <previously-verified target SHA> <expected current SHA>" >&2
  exit 2
}
valid_deployment_revision "$expected_current_revision" || {
  echo "Usage: $0 <previously-verified target SHA> <expected current SHA>" >&2
  exit 2
}

shared="$app_root/shared"
source_dir="$app_root/source"
state_dir="$app_root/state"
operations_root="$app_root/operations"
env_file="$shared/production.env"
compose_file="$operations_root/current/deploy/compose.production.yml"

test -f "$env_file" || { echo "Missing $env_file" >&2; exit 1; }
test -d "$state_dir" || { echo "Missing deployment state directory" >&2; exit 1; }
test -L "$operations_root/current" \
  && test -f "$compose_file" && test ! -L "$compose_file" || {
  echo "Missing exact current operations release" >&2
  exit 1
}
acquire_deployment_operation_lock "$state_dir"
cleanup_early_deployment_lock() {
  release_deployment_operation_lock || true
}
trap cleanup_early_deployment_lock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
load_deployment_state "$state_dir"
test "$previous_revision" = "$expected_current_revision" || {
  echo "Rollback expected-current guard does not match committed deployment state" >&2
  exit 1
}
test "$previous_compatibility_mode" = "current" || {
  echo "Explicit rollback requires a current-mode committed deployment" >&2
  exit 1
}
test -n "$previous_image_id" || {
  echo "Explicit rollback requires immutable image state from a verified deployment" >&2
  exit 1
}
test "$target_revision" != "$previous_revision" || {
  echo "Rollback target is already the committed deployment" >&2
  exit 1
}
target_image_id=$(load_verified_deployment_image "$state_dir" "$target_revision")
valid_deployment_image_id "$target_image_id" || {
  echo "Rollback target does not have a valid immutable image binding" >&2
  exit 1
}

if [ ! -d "$source_dir/.git" ]; then
  echo "Missing deployment source repository for rollback ancestry proof" >&2
  exit 1
fi
git -C "$source_dir" remote set-url origin "$repository_url"
git -C "$source_dir" fetch --no-tags --prune origin \
  '+refs/heads/main:refs/remotes/origin/main'
for rollback_revision in \
  "$target_revision" \
  "$previous_revision" \
  "$deployment_high_water_revision"
do
  resolved_rollback_revision=$(git -C "$source_dir" rev-parse --verify \
    "$rollback_revision^{commit}")
  test "$resolved_rollback_revision" = "$rollback_revision" || {
    echo "Rollback state contains a revision that does not resolve exactly" >&2
    exit 1
  }
  git -C "$source_dir" merge-base --is-ancestor \
    "$rollback_revision" refs/remotes/origin/main || {
    echo "Rollback state contains a revision no longer reachable from origin/main" >&2
    exit 1
  }
done
git -C "$source_dir" merge-base --is-ancestor \
  "$target_revision" "$previous_revision" || {
  echo "Rollback target is not an ancestor of the committed deployment" >&2
  exit 1
}
git -C "$source_dir" merge-base --is-ancestor \
  "$previous_revision" "$deployment_high_water_revision" || {
  echo "Committed deployment is inconsistent with its monotonic high-water mark" >&2
  exit 1
}

verify_image_binding() {
  binding_revision=$1
  binding_image_id=$2
  inspected_image_id=$(docker image inspect --format '{{.Id}}' "$binding_image_id") \
    || return 1
  inspected_revision=$(docker image inspect \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
    "$binding_image_id") || return 1
  test "$inspected_image_id" = "$binding_image_id" \
    && test "$inspected_revision" = "$binding_revision"
}

verify_image_binding "$previous_revision" "$previous_image_id" || {
  echo "Committed deployment image is missing or no longer matches its immutable binding" >&2
  exit 1
}
verify_image_binding "$target_revision" "$target_image_id" || {
  echo "Rollback target image is missing or no longer matches its immutable binding" >&2
  exit 1
}

# Render the exact current controls with the old immutable image before any
# runtime is stopped. A rollback never invokes the migrator or a down migration.
APP_COMMIT_SHA="$target_revision" HANDLEPLAN_IMAGE="$target_image_id" \
  HANDLEPLAN_MIGRATION_IMAGE="$previous_image_id" \
  docker compose --env-file "$env_file" -f "$compose_file" config >/dev/null

remove_all_runtimes() {
  cleanup_revision=$1
  cleanup_image_id=$2
  cleanup_failed=0
  for runtime_service in review operations worker app; do
    APP_COMMIT_SHA="$cleanup_revision" HANDLEPLAN_IMAGE="$cleanup_image_id" \
      HANDLEPLAN_MIGRATION_IMAGE="$previous_image_id" \
      docker compose --env-file "$env_file" -f "$compose_file" \
        stop "$runtime_service" || cleanup_failed=1
    APP_COMMIT_SHA="$cleanup_revision" HANDLEPLAN_IMAGE="$cleanup_image_id" \
      HANDLEPLAN_MIGRATION_IMAGE="$previous_image_id" \
      docker compose --env-file "$env_file" -f "$compose_file" \
        rm -f "$runtime_service" || cleanup_failed=1
    remaining_runtime=""
    remaining_runtime=$(APP_COMMIT_SHA="$cleanup_revision" \
      HANDLEPLAN_IMAGE="$cleanup_image_id" \
      HANDLEPLAN_MIGRATION_IMAGE="$previous_image_id" \
      docker compose --env-file "$env_file" -f "$compose_file" \
        ps -aq "$runtime_service") || cleanup_failed=1
    test -z "${remaining_runtime:-}" || cleanup_failed=1
  done
  test "$cleanup_failed" -eq 0
}

start_all_runtimes() {
  start_revision=$1
  start_image_id=$2
  APP_COMMIT_SHA="$start_revision" HANDLEPLAN_IMAGE="$start_image_id" \
    HANDLEPLAN_MIGRATION_IMAGE="$previous_image_id" \
    docker compose --env-file "$env_file" -f "$compose_file" \
      up -d --wait --remove-orphans --no-deps app review operations worker
}

verify_runtime_container() {
  verify_revision=$1
  verify_image_id=$2
  verify_service=$3
  container=$(APP_COMMIT_SHA="$verify_revision" HANDLEPLAN_IMAGE="$verify_image_id" \
    HANDLEPLAN_MIGRATION_IMAGE="$previous_image_id" \
    docker compose --env-file "$env_file" -f "$compose_file" \
      ps -q "$verify_service") || return 1
  test -n "$container" || return 1
  state=$(docker inspect --format '{{.State.Status}}' "$container") || return 1
  restarts=$(docker inspect --format '{{.RestartCount}}' "$container") || return 1
  health=$(docker inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
    "$container") || return 1
  image_id=$(docker inspect --format '{{.Image}}' "$container") || return 1
  revision_label=$(docker inspect \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
    "$container") || return 1
  test "$state" = "running" && test "$restarts" = "0" \
    && test "$health" = "healthy" && test "$image_id" = "$verify_image_id" \
    && test "$revision_label" = "$verify_revision"
}

verify_all_runtimes() {
  verify_revision=$1
  verify_image_id=$2
  rollback_health=$(curl --fail --silent --show-error \
    http://127.0.0.1:3004/api/health) || return 1
  printf '%s' "$rollback_health" \
    | grep -F "\"commit\":\"$verify_revision\"" >/dev/null || return 1
  for runtime_service in app review operations worker; do
    verify_runtime_container \
      "$verify_revision" "$verify_image_id" "$runtime_service" || return 1
  done
  rollback_worker_health=$(APP_COMMIT_SHA="$verify_revision" \
    HANDLEPLAN_IMAGE="$verify_image_id" HANDLEPLAN_MIGRATION_IMAGE="$previous_image_id" \
    docker compose --env-file "$env_file" -f "$compose_file" \
      exec -T worker wget -qO- http://127.0.0.1:3005/health) || return 1
  printf '%s' "$rollback_worker_health" \
    | grep -F "\"revision\":\"$verify_revision\"" >/dev/null || return 1
  printf '%s' "$rollback_worker_health" | grep -F '"ready":true' >/dev/null
}

rollback_candidate_may_exist=0
rollback_committed=0
exit_cleanup_running=0
restore_committed_runtime() {
  remove_all_runtimes "$target_revision" "$target_image_id" || {
    echo "Rollback cleanup could not prove all target runtimes absent" >&2
    return 1
  }
  rollback_candidate_may_exist=0
  start_all_runtimes "$previous_revision" "$previous_image_id" \
    && verify_all_runtimes "$previous_revision" "$previous_image_id" || {
    remove_all_runtimes "$previous_revision" "$previous_image_id" || true
    echo "Rollback failed and the previously committed runtime could not be restored; all runtimes were left down" >&2
    return 1
  }
  echo "Rollback failed; restored the previously committed immutable runtime" >&2
}
cleanup_on_exit() {
  exit_status=$?
  trap - EXIT
  trap '' HUP INT TERM
  if [ "$exit_cleanup_running" -eq 0 ] \
    && [ "$rollback_candidate_may_exist" -eq 1 ] \
    && [ "$rollback_committed" -ne 1 ]; then
    exit_cleanup_running=1
    restore_committed_runtime || true
  fi
  if ! release_deployment_operation_lock; then
    exit_status=1
  fi
  exit "$exit_status"
}
trap cleanup_on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

rollback_candidate_may_exist=1
remove_all_runtimes "$previous_revision" "$previous_image_id" || {
  echo "Rollback refused because the committed runtimes could not be proven absent" >&2
  exit 1
}
if ! start_all_runtimes "$target_revision" "$target_image_id" \
  || ! verify_all_runtimes "$target_revision" "$target_image_id"; then
  echo "Rollback target failed exact runtime readback" >&2
  exit 1
fi

trap '' HUP INT TERM
record_immutable_deployment_state "$state_dir" "$target_revision" current \
  "$target_image_id" "$deployment_high_water_revision"
rollback_committed=1
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "$rollback_health"
printf '%s\n' "$rollback_worker_health"
