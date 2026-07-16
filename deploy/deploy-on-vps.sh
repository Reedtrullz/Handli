#!/bin/sh
set -eu

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

if [ ! -d "$source_dir/.git" ]; then
  git clone --filter=blob:none "$repository_url" "$source_dir"
fi

git -C "$source_dir" fetch --prune origin main
git -C "$source_dir" cat-file -e "$revision^{commit}"
git -C "$source_dir" checkout --detach "$revision"

image="handleplan:$revision"
previous_revision=""
if [ -f "$state_dir/current-revision" ]; then
  previous_revision=$(cat "$state_dir/current-revision")
fi

docker build --pull --build-arg "APP_COMMIT_SHA=$revision" --tag "$image" "$source_dir"

deploy() {
  target_revision=$1
  migration_revision=$2
  target_image="handleplan:$target_revision"
  migration_image="handleplan:$migration_revision"
  APP_COMMIT_SHA="$target_revision" HANDLEPLAN_IMAGE="$target_image" \
    HANDLEPLAN_MIGRATION_IMAGE="$migration_image" \
    docker compose --env-file "$env_file" -f "$source_dir/deploy/compose.production.yml" up -d --wait --remove-orphans
}

if ! deploy "$revision" "$revision"; then
  if [ -n "$previous_revision" ] && docker image inspect "handleplan:$previous_revision" >/dev/null 2>&1; then
    echo "Deployment failed; restoring $previous_revision" >&2
    deploy "$previous_revision" "$revision"
  fi
  exit 1
fi

health=$(curl --fail --silent --show-error http://127.0.0.1:3004/api/health)
printf '%s' "$health" | grep -F "\"commit\":\"$revision\"" >/dev/null
printf '%s\n' "$revision" > "$state_dir/current-revision"
printf '%s\n' "$health"
