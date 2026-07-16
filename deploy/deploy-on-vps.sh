#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_dir/deployment-state.sh"

app_root=${HANDLEPLAN_APP_ROOT:-/opt/apps/handleplan}
repository_url=${HANDLEPLAN_REPOSITORY_URL:-https://github.com/Reedtrullz/Handli.git}
revision=${1:-}

case "$revision" in
  ''|*[!0-9a-f]*)
    echo "Usage: $0 <40-character commit SHA>" >&2
    exit 2
    ;;
esac
if [ "${#revision}" -ne 40 ]; then
  echo "Revision must be a full 40-character commit SHA" >&2
  exit 2
fi

shared="$app_root/shared"
source_dir="$app_root/source"
state_dir="$app_root/state"
env_file="$shared/production.env"

test -f "$env_file" || { echo "Missing $env_file" >&2; exit 1; }
mkdir -p "$shared" "$state_dir"
load_deployment_state "$state_dir"

if [ ! -d "$source_dir/.git" ]; then
  git clone --filter=blob:none "$repository_url" "$source_dir"
fi

git -C "$source_dir" fetch --prune origin main
git -C "$source_dir" cat-file -e "$revision^{commit}"
git -C "$source_dir" checkout --detach "$revision"

image="handleplan:$revision"

docker build --pull --build-arg "APP_COMMIT_SHA=$revision" --tag "$image" "$source_dir"

deploy() {
  target_revision=$1
  migration_revision=$2
  compatibility_mode=${3:-current}
  target_image="handleplan:$target_revision"
  migration_image="handleplan:$migration_revision"
  if [ "$compatibility_mode" = "legacy" ]; then
    docker compose --env-file "$env_file" \
      -f "$source_dir/deploy/compose.production.yml" stop worker || true
    docker compose --env-file "$env_file" \
      -f "$source_dir/deploy/compose.production.yml" rm -f worker || true
    APP_COMMIT_SHA="$target_revision" HANDLEPLAN_IMAGE="$target_image" \
      HANDLEPLAN_MIGRATION_IMAGE="$migration_image" \
      docker compose --env-file "$env_file" \
        -f "$source_dir/deploy/compose.production.yml" \
        -f "$source_dir/deploy/compose.rollback-legacy.yml" \
        up -d --wait --remove-orphans app
    return
  fi
  test "$compatibility_mode" = "current" || {
    echo "Unknown deployment compatibility mode: $compatibility_mode" >&2
    return 2
  }
  APP_COMMIT_SHA="$target_revision" HANDLEPLAN_IMAGE="$target_image" \
    HANDLEPLAN_MIGRATION_IMAGE="$migration_image" \
    docker compose --env-file "$env_file" \
      -f "$source_dir/deploy/compose.production.yml" \
      up -d --wait --remove-orphans
}

health=""
worker_health=""

read_worker_health() {
  target_revision=$1
  target_image="handleplan:$target_revision"
  APP_COMMIT_SHA="$target_revision" HANDLEPLAN_IMAGE="$target_image" \
    HANDLEPLAN_MIGRATION_IMAGE="$target_image" \
    docker compose --env-file "$env_file" \
      -f "$source_dir/deploy/compose.production.yml" \
      exec -T worker wget -qO- http://127.0.0.1:3005/health
}

verify_current_deployment() {
  target_revision=$1
  target_image="handleplan:$target_revision"
  health=$(curl --fail --silent --show-error http://127.0.0.1:3004/api/health) || return 1
  printf '%s' "$health" | grep -F "\"commit\":\"$target_revision\"" >/dev/null \
    || return 1

  attempts=0
  while [ "$attempts" -lt 660 ]; do
    worker_container=$(APP_COMMIT_SHA="$target_revision" HANDLEPLAN_IMAGE="$target_image" \
      HANDLEPLAN_MIGRATION_IMAGE="$target_image" \
      docker compose --env-file "$env_file" \
        -f "$source_dir/deploy/compose.production.yml" ps -q worker) || return 1
    test -n "$worker_container" || return 1
    worker_state=$(docker inspect --format '{{.State.Status}}' "$worker_container") || return 1
    worker_restarts=$(docker inspect --format '{{.RestartCount}}' "$worker_container") || return 1
    worker_container_health=$(docker inspect \
      --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
      "$worker_container") || return 1
    test "$worker_state" = "running" || return 1
    test "$worker_restarts" = "0" || return 1
    case "$worker_container_health" in
      healthy|starting) ;;
      *) return 1 ;;
    esac

    worker_health=$(read_worker_health "$target_revision" 2>/dev/null || true)
    if [ -n "$worker_health" ]; then
      printf '%s' "$worker_health" \
        | grep -F "\"revision\":\"$target_revision\"" >/dev/null \
        || return 1
      printf '%s' "$worker_health" | grep -F '"ready":true' >/dev/null \
        || return 1
      if printf '%s' "$worker_health" | grep -E '"completedCycles":[1-9][0-9]*' >/dev/null \
        && printf '%s' "$worker_health" | grep -F '"lastCycle":{' >/dev/null \
        && printf '%s' "$worker_health" | grep -F '"leaseAcquired":true' >/dev/null \
        && printf '%s' "$worker_health" | grep -E '"durationMs":[0-9]+' >/dev/null; then
        return 0
      fi
    fi
    attempts=$((attempts + 1))
    sleep 5
  done
  echo "Worker did not complete a bounded scheduler cycle before the deployment deadline" >&2
  return 1
}

deployment_ok=0
if deploy "$revision" "$revision"; then
  if verify_current_deployment "$revision"; then
    deployment_ok=1
  else
    echo "Deployment readback failed; candidate revision was not recorded" >&2
  fi
else
  echo "Deployment failed before readback" >&2
fi

if [ "$deployment_ok" -ne 1 ]; then
  if [ -n "$previous_revision" ] && docker image inspect "handleplan:$previous_revision" >/dev/null 2>&1; then
    echo "Deployment failed; restoring $previous_revision" >&2
    deploy "$previous_revision" "$revision" "$previous_compatibility_mode"
  fi
  exit 1
fi

record_deployment_state "$state_dir" "$revision" current
printf '%s\n' "$health"
printf '%s\n' "$worker_health"
