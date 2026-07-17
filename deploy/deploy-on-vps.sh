#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_dir/deployment-state.sh"

app_root=${HANDLEPLAN_APP_ROOT:-/opt/apps/handleplan}
repository_url=${HANDLEPLAN_REPOSITORY_URL:-https://github.com/Reedtrullz/Handli.git}
revision=${1:-}
ci_run_id=${2:-}
ci_run_attempt=${3:-}
expected_bundle_manifest_sha256=${4:-}
max_source_archive_bytes=134217728
max_image_archive_bytes=2147483648

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
case "$ci_run_id" in
  ''|0|*[!0-9]*)
    echo "Usage: $0 <40-character commit SHA> <CI run ID> <CI run attempt>" >&2
    exit 2
    ;;
esac
case "$ci_run_attempt" in
  ''|0|*[!0-9]*)
    echo "Usage: $0 <40-character commit SHA> <CI run ID> <CI run attempt>" >&2
    exit 2
    ;;
esac
case "$expected_bundle_manifest_sha256" in
  ''|*[!0-9a-f]*)
    echo "Usage: $0 <40-character commit SHA> <CI run ID> <CI run attempt> <bundle manifest SHA-256>" >&2
    exit 2
    ;;
esac
if [ "${#expected_bundle_manifest_sha256}" -ne 64 ]; then
  echo "Bundle manifest SHA-256 must be 64 lowercase hexadecimal characters" >&2
  exit 2
fi

shared="$app_root/shared"
source_dir="$app_root/source"
state_dir="$app_root/state"
env_file="$shared/production.env"
bundle_dir="$script_dir/image"
bundle_manifest="$bundle_dir/handleplan-image-bundle.v1"
image_archive="$bundle_dir/handleplan-image.docker.tar"
source_archive="$bundle_dir/handleplan-source.tar"
provenance_artifact="$bundle_dir/handleplan.provenance.json"
sbom_artifact="$bundle_dir/handleplan.spdx.json"

test -f "$env_file" || { echo "Missing $env_file" >&2; exit 1; }

# Review and operations are separate Cloudflare Access applications even when
# their exact path families share one public origin. Compose validates each
# process in isolation, so compare the two canonical, unquoted audience tags at
# the deploy boundary without sourcing or printing the protected env file.
read_private_access_audience() {
  audience_name=$1
  audience_value=$(awk -v audience_name="$audience_name" '
    index($0, audience_name "=") == 1 {
      matches += 1
      value = substr($0, length(audience_name) + 2)
    }
    END {
      if (matches != 1) exit 1
      printf "%s", value
    }
  ' "$env_file") || {
    echo "Protected production env must contain one canonical $audience_name assignment" >&2
    return 1
  }
  case "$audience_value" in
    ''|*[!A-Za-z0-9_-]*)
      echo "Protected production env contains an invalid $audience_name" >&2
      return 1
      ;;
  esac
  if [ "${#audience_value}" -lt 16 ] || [ "${#audience_value}" -gt 200 ]; then
    echo "Protected production env contains an invalid $audience_name" >&2
    return 1
  fi
  printf '%s' "$audience_value"
}

review_access_audience=$(read_private_access_audience REVIEW_ACCESS_AUDIENCE)
operations_access_audience=$(read_private_access_audience OPERATIONS_ACCESS_AUDIENCE)
test "$review_access_audience" != "$operations_access_audience" || {
  echo "Review and operations Cloudflare Access audiences must be distinct" >&2
  exit 1
}
unset review_access_audience operations_access_audience

mkdir -p "$shared" "$state_dir"
acquire_deployment_operation_lock "$state_dir"
cleanup_early_deployment_lock() {
  release_deployment_operation_lock || true
}
trap cleanup_early_deployment_lock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
load_deployment_state "$state_dir"

# CI is the only image builder. The VPS accepts a fixed five-file bundle from
# the exact successful workflow run and never rebuilds the image. The source
# archive remains necessary for the exact Compose/migration definitions, but it
# is not a Docker build context on this host.
build_root=$(mktemp -d "$app_root/.deploy-load.XXXXXX")
deployment_source_dir="$build_root/source"
candidate_runtime_may_exist=0
deployment_committed=0
exit_cleanup_running=0
operations_release_activation_required=0
operations_release_activated=0
cleanup_build_root() {
  rm -rf "$build_root"
}
cleanup_on_exit() {
  exit_status=$?
  trap - EXIT
  # A lost SSH session must not interrupt the cleanup that its own signal
  # initiated. Any hard kill remains outside what a shell trap can guarantee.
  trap '' HUP INT TERM
  if [ "$exit_cleanup_running" -eq 0 ]; then
    exit_cleanup_running=1
    # A migration file may have committed before the migrator failed or the
    # deploy shell received a catchable signal. Keep the checksum-bound backup
    # and rollback controls at the attempted forward revision even when no
    # application candidate can be recorded.
    if [ "$operations_release_activation_required" -eq 1 ] \
      && [ "$operations_release_activated" -ne 1 ]; then
      echo "Migration may have advanced; activating the prepared operations release" >&2
      if activate_operations_release; then
        operations_release_activated=1
      else
        echo "Could not activate schema-matched operations controls after migration began" >&2
        exit_status=1
      fi
    fi
    if [ "$candidate_runtime_may_exist" -eq 1 ] \
      && [ "$deployment_committed" -ne 1 ]; then
      echo "Deployment interrupted after candidate startup; removing every candidate runtime" >&2
      if cleanup_failed_candidate_runtime; then
        :
      else
        echo "Interrupted deployment cleanup could not prove a closed candidate state" >&2
      fi
    fi
    cleanup_build_root
    if ! release_deployment_operation_lock; then
      exit_status=1
    fi
  fi
  exit "$exit_status"
}
trap cleanup_on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -m 700 "$deployment_source_dir"

test -d "$bundle_dir" && test ! -L "$bundle_dir" || {
  echo "Missing regular CI image-bundle directory" >&2
  exit 1
}
bundle_entries=0
for bundle_entry in "$bundle_dir"/* "$bundle_dir"/.[!.]* "$bundle_dir"/..?*
do
  if [ -e "$bundle_entry" ] || [ -L "$bundle_entry" ]; then
    bundle_entries=$((bundle_entries + 1))
  fi
done
test "$bundle_entries" -eq 5 || {
  echo "CI image bundle must contain exactly five artifacts" >&2
  exit 1
}
for bundle_artifact in \
  "$bundle_manifest" \
  "$image_archive" \
  "$source_archive" \
  "$provenance_artifact" \
  "$sbom_artifact"
do
  test -f "$bundle_artifact" && test ! -L "$bundle_artifact" || {
    echo "CI image bundle contains a missing or unsafe artifact" >&2
    exit 1
  }
done

manifest_lines=$(wc -l < "$bundle_manifest" | tr -d '[:space:]')
test "$(sha256sum "$bundle_manifest" | awk '{print $1}')" = \
  "$expected_bundle_manifest_sha256" || {
  echo "CI image bundle manifest does not match the digest verified by the deploy runner" >&2
  exit 1
}
test "$manifest_lines" -eq 10 || {
  echo "CI image bundle manifest has an invalid shape" >&2
  exit 1
}
test "$(sed -n '1p' "$bundle_manifest")" = \
  'format=handleplan-ci-image-bundle-v1' || {
  echo "CI image bundle format is unsupported" >&2
  exit 1
}
test "$(sed -n '2p' "$bundle_manifest")" = "revision=$revision" || {
  echo "CI image bundle revision does not match the requested commit" >&2
  exit 1
}
test "$(sed -n '3p' "$bundle_manifest")" = \
  "image_reference=handleplan:$revision" || {
  echo "CI image bundle reference does not match the requested commit" >&2
  exit 1
}
manifest_image_id=$(sed -n '4p' "$bundle_manifest")
manifest_image_archive_sha256=$(sed -n '5p' "$bundle_manifest")
manifest_source_archive_sha256=$(sed -n '6p' "$bundle_manifest")
manifest_provenance_sha256=$(sed -n '7p' "$bundle_manifest")
manifest_sbom_sha256=$(sed -n '8p' "$bundle_manifest")
case "$manifest_image_id" in
  image_id=*) expected_image_id=${manifest_image_id#image_id=} ;;
  *) echo "CI image bundle is missing its image config digest" >&2; exit 1 ;;
esac
case "$manifest_image_archive_sha256" in
  image_archive_sha256=*) image_archive_sha256=${manifest_image_archive_sha256#image_archive_sha256=} ;;
  *) echo "CI image bundle is missing its image archive digest" >&2; exit 1 ;;
esac
case "$manifest_source_archive_sha256" in
  source_archive_sha256=*) source_archive_sha256=${manifest_source_archive_sha256#source_archive_sha256=} ;;
  *) echo "CI image bundle is missing its source archive digest" >&2; exit 1 ;;
esac
case "$manifest_provenance_sha256" in
  provenance_sha256=*) provenance_sha256=${manifest_provenance_sha256#provenance_sha256=} ;;
  *) echo "CI image bundle is missing its provenance digest" >&2; exit 1 ;;
esac
case "$manifest_sbom_sha256" in
  sbom_sha256=*) sbom_sha256=${manifest_sbom_sha256#sbom_sha256=} ;;
  *) echo "CI image bundle is missing its SBOM digest" >&2; exit 1 ;;
esac
test "$(sed -n '9p' "$bundle_manifest")" = "ci_run_id=$ci_run_id" || {
  echo "CI image bundle run ID does not match the invoking workflow" >&2
  exit 1
}
test "$(sed -n '10p' "$bundle_manifest")" = \
  "ci_run_attempt=$ci_run_attempt" || {
  echo "CI image bundle run attempt does not match the invoking workflow" >&2
  exit 1
}

valid_hex_digest() {
  digest_value=$1
  test "${#digest_value}" -eq 64 || return 1
  case "$digest_value" in
    *[!0-9a-f]*) return 1 ;;
  esac
}
case "$expected_image_id" in
  sha256:*) expected_image_digest=${expected_image_id#sha256:} ;;
  *) echo "CI image config digest is invalid" >&2; exit 1 ;;
esac
valid_hex_digest "$expected_image_digest" || {
  echo "CI image config digest is invalid" >&2
  exit 1
}
for expected_digest in \
  "$image_archive_sha256" \
  "$source_archive_sha256" \
  "$provenance_sha256" \
  "$sbom_sha256"
do
  valid_hex_digest "$expected_digest" || {
    echo "CI image bundle contains an invalid SHA-256 digest" >&2
    exit 1
  }
done

test "$(sha256sum "$image_archive" | awk '{print $1}')" = \
  "$image_archive_sha256" || {
  echo "CI Docker archive digest verification failed before image load" >&2
  exit 1
}
test "$(sha256sum "$source_archive" | awk '{print $1}')" = \
  "$source_archive_sha256" || {
  echo "CI source archive digest verification failed before extraction" >&2
  exit 1
}
test "$(sha256sum "$provenance_artifact" | awk '{print $1}')" = \
  "$provenance_sha256" || {
  echo "CI provenance digest verification failed" >&2
  exit 1
}
test "$(sha256sum "$sbom_artifact" | awk '{print $1}')" = "$sbom_sha256" || {
  echo "CI SBOM digest verification failed" >&2
  exit 1
}

image_archive_bytes=$(wc -c < "$image_archive" | tr -d '[:space:]')
source_archive_bytes=$(wc -c < "$source_archive" | tr -d '[:space:]')
case "$image_archive_bytes" in
  ''|*[!0-9]*)
    echo "Could not measure the exact CI Docker archive" >&2
    exit 1
    ;;
esac
case "$source_archive_bytes" in
  ''|*[!0-9]*)
    echo "Could not measure the exact CI source archive" >&2
    exit 1
    ;;
esac
if [ "$image_archive_bytes" -le 0 ] \
  || [ "$image_archive_bytes" -gt "$max_image_archive_bytes" ]; then
  echo "Exact CI Docker archive is empty or exceeds the 2 GiB limit" >&2
  exit 1
fi
if [ "$source_archive_bytes" -le 0 ] \
  || [ "$source_archive_bytes" -gt "$max_source_archive_bytes" ]; then
  echo "Exact CI source archive is empty or exceeds the 128 MiB limit" >&2
  exit 1
fi
tar -tf "$image_archive" >/dev/null || {
  echo "Exact CI Docker archive is unreadable" >&2
  exit 1
}
tar -tf "$source_archive" > "$build_root/source-members"
awk '
  BEGIN { safe = 1; entries = 0 }
  {
    entries += 1
    if ($0 == "" || substr($0, 1, 1) == "/" || $0 ~ /(^|\/)\.\.(\/|$)/) safe = 0
  }
  END { if (!safe || entries == 0) exit 1 }
' "$build_root/source-members" || {
  echo "Exact CI source archive contains an unsafe member" >&2
  exit 1
}
tar -xf "$source_archive" -C "$deployment_source_dir"
test ! -L "$deployment_source_dir/deploy" || {
  echo "Exact CI source archive contains an unsafe deploy symlink" >&2
  exit 1
}
for required_path in \
  Dockerfile \
  deploy/compose.production.yml \
  deploy/compose.rollback-legacy.yml
do
  test -f "$deployment_source_dir/$required_path" \
    && test ! -L "$deployment_source_dir/$required_path" || {
    echo "Exact CI source archive is missing a regular $required_path" >&2
    exit 1
  }
done

if [ ! -d "$source_dir/.git" ]; then
  git clone --filter=blob:none "$repository_url" "$source_dir"
fi

git -C "$source_dir" remote set-url origin "$repository_url"
git -C "$source_dir" fetch --no-tags --prune origin \
  '+refs/heads/main:refs/remotes/origin/main'
resolved_revision=$(git -C "$source_dir" rev-parse --verify "$revision^{commit}")
test "$resolved_revision" = "$revision" || {
  echo "Requested revision did not resolve to the exact full commit SHA" >&2
  exit 1
}
git -C "$source_dir" merge-base --is-ancestor \
  "$revision" refs/remotes/origin/main || {
  echo "Requested revision is not reachable from the fetched origin/main" >&2
  exit 1
}
# Independently reproduce the deterministic Git archive from the fetched
# origin/main commit. The transferred source definitions are not trusted merely
# because the bundle manifest names the revision.
verified_source_archive="$build_root/origin-main-source.tar"
git -C "$source_dir" archive --format=tar \
  --output="$verified_source_archive" "$revision"
test "$(sha256sum "$verified_source_archive" | awk '{print $1}')" = \
  "$source_archive_sha256" || {
  echo "CI source archive is not the exact fetched origin/main commit" >&2
  exit 1
}
if [ -n "$previous_revision" ]; then
  resolved_previous_revision=$(git -C "$source_dir" rev-parse --verify \
    "$previous_revision^{commit}")
  test "$resolved_previous_revision" = "$previous_revision" || {
    echo "Recorded deployment revision did not resolve to its exact commit" >&2
    exit 1
  }
  git -C "$source_dir" merge-base --is-ancestor \
    "$previous_revision" refs/remotes/origin/main || {
    echo "Recorded deployment revision is no longer reachable from origin/main" >&2
    exit 1
  }
  resolved_high_water_revision=$(git -C "$source_dir" rev-parse --verify \
    "$deployment_high_water_revision^{commit}")
  test "$resolved_high_water_revision" = "$deployment_high_water_revision" || {
    echo "Deployment high-water revision did not resolve to its exact commit" >&2
    exit 1
  }
  git -C "$source_dir" merge-base --is-ancestor \
    "$deployment_high_water_revision" refs/remotes/origin/main || {
    echo "Deployment high-water revision is no longer reachable from origin/main" >&2
    exit 1
  }
  git -C "$source_dir" merge-base --is-ancestor \
    "$previous_revision" "$deployment_high_water_revision" || {
    echo "Recorded deployment is inconsistent with its high-water revision" >&2
    exit 1
  }
  git -C "$source_dir" merge-base --is-ancestor \
    "$deployment_high_water_revision" "$revision" || {
    echo "Requested revision is older than the deployment high-water mark; refusing out-of-order CI" >&2
    exit 1
  }
fi

image="handleplan:$revision"

# Resolve the exact candidate Compose model before loading or quiescing any
# runtime. Required secrets remain in the protected env file and rendered output
# is discarded; missing variables or an invalid model fail without exposing
# values or changing the live deployment.
APP_COMMIT_SHA="$revision" HANDLEPLAN_IMAGE="$image" \
  HANDLEPLAN_MIGRATION_IMAGE="$image" \
  docker compose --env-file "$env_file" \
    -f "$deployment_source_dir/deploy/compose.production.yml" \
    config >/dev/null

docker image load --input "$image_archive" >/dev/null
loaded_image_id=$(docker image inspect --format '{{.Id}}' "$image") || {
  echo "Loaded CI image did not create the expected revision tag" >&2
  exit 1
}
test "$loaded_image_id" = "$expected_image_id" || {
  echo "Loaded image config digest does not match the CI bundle" >&2
  exit 1
}
loaded_image_revision=$(docker image inspect \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
test "$loaded_image_revision" = "$revision" || {
  echo "Loaded image revision label does not match the requested commit" >&2
  exit 1
}

private_migration_gate_failed=0
private_runtimes_absent=0
private_runtimes_quiesced_for_deploy=0

remove_runtime_services() {
  target_revision=$1
  migration_revision=$2
  failure_message=$3
  shift 3
  target_image="handleplan:$target_revision"
  migration_image="handleplan:$migration_revision"
  cleanup_failed=0

  for runtime_service in "$@"; do
    if APP_COMMIT_SHA="$target_revision" HANDLEPLAN_IMAGE="$target_image" \
      HANDLEPLAN_MIGRATION_IMAGE="$migration_image" \
      docker compose --env-file "$env_file" \
        -f "$deployment_source_dir/deploy/compose.production.yml" \
        stop "$runtime_service"; then
      :
    else
      cleanup_failed=1
    fi
    if APP_COMMIT_SHA="$target_revision" HANDLEPLAN_IMAGE="$target_image" \
      HANDLEPLAN_MIGRATION_IMAGE="$migration_image" \
      docker compose --env-file "$env_file" \
        -f "$deployment_source_dir/deploy/compose.production.yml" \
        rm -f "$runtime_service"; then
      :
    else
      cleanup_failed=1
    fi
    remaining_runtime=""
    if remaining_runtime=$(APP_COMMIT_SHA="$target_revision" HANDLEPLAN_IMAGE="$target_image" \
      HANDLEPLAN_MIGRATION_IMAGE="$migration_image" \
      docker compose --env-file "$env_file" \
        -f "$deployment_source_dir/deploy/compose.production.yml" \
        ps -aq "$runtime_service"); then
      test -z "$remaining_runtime" || cleanup_failed=1
    else
      cleanup_failed=1
    fi
  done

  test "$cleanup_failed" -eq 0 || {
    echo "$failure_message" >&2
    return 1
  }
}

deploy() {
  target_revision=$1
  migration_revision=$2
  compatibility_mode=${3:-current}
  target_image=${4:-handleplan:$target_revision}
  migration_image="handleplan:$migration_revision"
  if [ "$compatibility_mode" = "legacy" ]; then
    remove_runtime_services "$target_revision" "$migration_revision" \
      "Legacy rollback could not prove private runtimes and worker absent" \
      review operations worker || return 1
    APP_COMMIT_SHA="$target_revision" HANDLEPLAN_IMAGE="$target_image" \
      HANDLEPLAN_MIGRATION_IMAGE="$migration_image" \
      docker compose --env-file "$env_file" \
        -f "$deployment_source_dir/deploy/compose.production.yml" \
        -f "$deployment_source_dir/deploy/compose.rollback-legacy.yml" \
        up -d --wait --remove-orphans app
    return
  fi
  test "$compatibility_mode" = "current" || {
    echo "Unknown deployment compatibility mode: $compatibility_mode" >&2
    return 2
  }
  # A pre-021 review process can hold an already-authorized direct-SQL
  # transaction while the migration waits for table locks. Operations role and
  # function changes have the same upgrade boundary from migration 024 onward,
  # and the worker is the database writer whose grants and lifecycle functions
  # are reconciled by every deploy. Drain all three credential holders before
  # migrations; each migration then revokes historical ACLs in its own commit.
  private_runtimes_quiesced_for_deploy=1
  private_migration_gate_failed=1
  remove_runtime_services "$target_revision" "$migration_revision" \
    "Deployment refused to migrate without proof that review, operations, and worker are absent" \
    review operations worker || return 1
  private_runtimes_absent=1
  operations_release_activation_required=1
  APP_COMMIT_SHA="$target_revision" HANDLEPLAN_IMAGE="$target_image" \
    HANDLEPLAN_MIGRATION_IMAGE="$migration_image" \
    docker compose --env-file "$env_file" \
      -f "$deployment_source_dir/deploy/compose.production.yml" \
      run --rm migrate || return 1
  # migrate.mjs includes role reconciliation. The exact backup, restore, and
  # rollback controls must follow the now-forward database before any candidate
  # runtime or readback can fail and restore only the previous public image.
  activate_operations_release || {
    echo "Migration succeeded but schema-matched operations controls could not be activated" >&2
    return 1
  }
  operations_release_activated=1
  # Only after the migration and operations-control boundary succeeds may
  # Compose recreate the private review and operations runtimes.
  private_migration_gate_failed=0
  # Set this before Compose starts: `up --wait` can be interrupted after it has
  # created only a subset of the four services. EXIT cleanup must then remove
  # the entire candidate set before any prior-public-only fallback.
  candidate_runtime_may_exist=1
  APP_COMMIT_SHA="$target_revision" HANDLEPLAN_IMAGE="$target_image" \
    HANDLEPLAN_MIGRATION_IMAGE="$migration_image" \
    docker compose --env-file "$env_file" \
      -f "$deployment_source_dir/deploy/compose.production.yml" \
      up -d --wait --remove-orphans --no-deps app review operations worker
}

cleanup_failed_candidate_runtime() {
  remove_runtime_services "$revision" "$revision" \
    "Failed deployment could not prove private runtimes, worker, and app absent; fallback refused" \
    review operations worker app || return 1
  candidate_runtime_may_exist=0

  previous_image_revision=""
  previous_fallback_image=""
  if [ -n "$previous_revision" ] && [ -n "$previous_image_id" ] \
    && previous_image_revision=$(docker image inspect \
      --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
      "$previous_image_id" 2>/dev/null) \
    && [ "$previous_image_revision" = "$previous_revision" ] \
    && [ "$(docker image inspect --format '{{.Id}}' "$previous_image_id" 2>/dev/null)" = \
      "$previous_image_id" ]; then
    previous_fallback_image=$previous_image_id
  elif [ -n "$previous_revision" ] && [ -z "$previous_image_id" ] \
    && previous_image_revision=$(docker image inspect \
      --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
      "handleplan:$previous_revision" 2>/dev/null) \
    && [ "$previous_image_revision" = "$previous_revision" ]; then
    # Compatibility for state committed before immutable image IDs existed.
    previous_fallback_image="handleplan:$previous_revision"
  fi
  if [ -n "$previous_fallback_image" ]; then
    echo "Deployment failed; restoring only the public app from $previous_revision" >&2
    deploy "$previous_revision" "$revision" legacy "$previous_fallback_image"
  else
    echo "Deployment failed; no verified prior image, leaving all candidate runtimes down" >&2
  fi
}

health=""
worker_health=""

verify_review_runtime() {
  target_revision=$1
  target_image="handleplan:$target_revision"
  review_container=$(APP_COMMIT_SHA="$target_revision" HANDLEPLAN_IMAGE="$target_image" \
    HANDLEPLAN_MIGRATION_IMAGE="$target_image" \
    docker compose --env-file "$env_file" \
      -f "$deployment_source_dir/deploy/compose.production.yml" ps -q review) || return 1
  test -n "$review_container" || return 1

  review_state=$(docker inspect --format '{{.State.Status}}' "$review_container") || return 1
  review_restarts=$(docker inspect --format '{{.RestartCount}}' "$review_container") || return 1
  review_health=$(docker inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
    "$review_container") || return 1
  review_image=$(docker inspect --format '{{.Config.Image}}' "$review_container") || return 1
  review_image_id=$(docker inspect --format '{{.Image}}' "$review_container") || return 1
  review_revision=$(docker inspect \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
    "$review_container") || return 1

  test "$review_state" = "running" || return 1
  test "$review_restarts" = "0" || return 1
  test "$review_health" = "healthy" || return 1
  test "$review_image" = "$target_image" || return 1
  test "$review_image_id" = "$loaded_image_id" || return 1
  test "$review_revision" = "$target_revision" || return 1
}

verify_operations_runtime() {
  target_revision=$1
  target_image="handleplan:$target_revision"
  operations_container=$(APP_COMMIT_SHA="$target_revision" HANDLEPLAN_IMAGE="$target_image" \
    HANDLEPLAN_MIGRATION_IMAGE="$target_image" \
    docker compose --env-file "$env_file" \
      -f "$deployment_source_dir/deploy/compose.production.yml" ps -q operations) || return 1
  test -n "$operations_container" || return 1

  operations_state=$(docker inspect --format '{{.State.Status}}' "$operations_container") \
    || return 1
  operations_restarts=$(docker inspect --format '{{.RestartCount}}' "$operations_container") \
    || return 1
  operations_health=$(docker inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
    "$operations_container") || return 1
  operations_image=$(docker inspect --format '{{.Config.Image}}' "$operations_container") \
    || return 1
  operations_image_id=$(docker inspect --format '{{.Image}}' "$operations_container") \
    || return 1
  operations_revision=$(docker inspect \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
    "$operations_container") || return 1

  test "$operations_state" = "running" || return 1
  test "$operations_restarts" = "0" || return 1
  test "$operations_health" = "healthy" || return 1
  test "$operations_image" = "$target_image" || return 1
  test "$operations_image_id" = "$loaded_image_id" || return 1
  test "$operations_revision" = "$target_revision" || return 1
}

read_worker_health() {
  target_revision=$1
  target_image="handleplan:$target_revision"
  APP_COMMIT_SHA="$target_revision" HANDLEPLAN_IMAGE="$target_image" \
    HANDLEPLAN_MIGRATION_IMAGE="$target_image" \
    docker compose --env-file "$env_file" \
      -f "$deployment_source_dir/deploy/compose.production.yml" \
      exec -T worker wget -qO- http://127.0.0.1:3005/health
}

verify_current_deployment() {
  target_revision=$1
  target_image="handleplan:$target_revision"
  health=$(curl --fail --silent --show-error http://127.0.0.1:3004/api/health) || return 1
  printf '%s' "$health" | grep -F "\"commit\":\"$target_revision\"" >/dev/null \
    || return 1
  app_container=$(APP_COMMIT_SHA="$target_revision" HANDLEPLAN_IMAGE="$target_image" \
    HANDLEPLAN_MIGRATION_IMAGE="$target_image" \
    docker compose --env-file "$env_file" \
      -f "$deployment_source_dir/deploy/compose.production.yml" ps -q app) || return 1
  test -n "$app_container" || return 1
  app_image_id=$(docker inspect --format '{{.Image}}' "$app_container") || return 1
  test "$app_image_id" = "$loaded_image_id" || return 1
  verify_review_runtime "$target_revision" || return 1
  verify_operations_runtime "$target_revision" || return 1

  attempts=0
  while [ "$attempts" -lt 660 ]; do
    worker_container=$(APP_COMMIT_SHA="$target_revision" HANDLEPLAN_IMAGE="$target_image" \
      HANDLEPLAN_MIGRATION_IMAGE="$target_image" \
      docker compose --env-file "$env_file" \
        -f "$deployment_source_dir/deploy/compose.production.yml" ps -q worker) || return 1
    test -n "$worker_container" || return 1
    worker_state=$(docker inspect --format '{{.State.Status}}' "$worker_container") || return 1
    worker_restarts=$(docker inspect --format '{{.RestartCount}}' "$worker_container") || return 1
    worker_image_id=$(docker inspect --format '{{.Image}}' "$worker_container") || return 1
    worker_container_health=$(docker inspect \
      --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
      "$worker_container") || return 1
    test "$worker_state" = "running" || return 1
    test "$worker_restarts" = "0" || return 1
    test "$worker_image_id" = "$loaded_image_id" || return 1
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
        verify_review_runtime "$target_revision" || return 1
        verify_operations_runtime "$target_revision" || return 1
        return 0
      fi
    fi
    attempts=$((attempts + 1))
    sleep 5
  done
  echo "Worker did not complete a bounded scheduler cycle before the deployment deadline" >&2
  return 1
}

verify_operations_release() (
  operations_root="$app_root/operations"
  releases_root="$operations_root/releases"
  release_dir="$releases_root/$revision"
  release_manifest="$release_dir/release.v1"
  expected_release_manifest="v1 $revision $source_archive_sha256"
  test -d "$operations_root" && test ! -L "$operations_root" \
    && test -d "$releases_root" && test ! -L "$releases_root" \
    && test -d "$release_dir" && test ! -L "$release_dir" \
    && test -f "$release_manifest" && test ! -L "$release_manifest" \
    && test "$(cat "$release_manifest")" = "$expected_release_manifest" || {
    echo "Operations release does not match the exact source archive" >&2
    return 1
  }
  test -z "$(find "$release_dir" -type l -print -quit)" \
    && diff -qr "$deployment_source_dir/deploy/backup" \
      "$release_dir/deploy/backup" >/dev/null \
    && diff -qr "$deployment_source_dir/deploy/migrations" \
      "$release_dir/deploy/migrations" >/dev/null || {
    echo "Operations release bytes do not match the exact source archive" >&2
    return 1
  }
  for operations_file in \
    compose.production.yml \
    compose.rollback-legacy.yml \
    deployment-state.sh \
    rollback-on-vps.sh
  do
    cmp -s "$deployment_source_dir/deploy/$operations_file" \
      "$release_dir/deploy/$operations_file" || {
      echo "Operations release control bytes do not match" >&2
      return 1
    }
  done
)

prepare_operations_release() (
  operations_root="$app_root/operations"
  releases_root="$operations_root/releases"
  release_dir="$releases_root/$revision"
  expected_release_manifest="v1 $revision $source_archive_sha256"
  if [ -e "$operations_root" ]; then
    test -d "$operations_root" && test ! -L "$operations_root" || {
      echo "Operations release root must be a regular directory" >&2
      return 1
    }
  else
    mkdir -m 755 "$operations_root"
  fi
  if [ -e "$releases_root" ]; then
    test -d "$releases_root" && test ! -L "$releases_root" || {
      echo "Operations releases root must be a regular directory" >&2
      return 1
    }
  else
    mkdir -m 755 "$releases_root"
  fi

  if [ -L "$release_dir" ]; then
    echo "Operations release path must not be a symbolic link" >&2
    return 1
  fi
  if [ ! -e "$release_dir" ]; then
    release_tmp=$(mktemp -d "$releases_root/.release-$revision.XXXXXX") || return 1
    cleanup_release_tmp() {
      rm -rf "$release_tmp"
    }
    trap cleanup_release_tmp EXIT HUP INT TERM
    mkdir -m 755 "$release_tmp/deploy"
    cp -R "$deployment_source_dir/deploy/backup" "$release_tmp/deploy/backup"
    cp -R "$deployment_source_dir/deploy/migrations" "$release_tmp/deploy/migrations"
    for operations_file in \
      compose.production.yml \
      compose.rollback-legacy.yml \
      deployment-state.sh \
      rollback-on-vps.sh
    do
      test -f "$deployment_source_dir/deploy/$operations_file" \
        && test ! -L "$deployment_source_dir/deploy/$operations_file" || {
        echo "Exact source archive is missing operations file $operations_file" >&2
        return 1
      }
      cp "$deployment_source_dir/deploy/$operations_file" \
        "$release_tmp/deploy/$operations_file"
    done
    if [ -n "$(find "$release_tmp" -type l -print -quit)" ]; then
      echo "Operations release contains an unsafe symbolic link" >&2
      return 1
    fi
    printf '%s\n' "$expected_release_manifest" > "$release_tmp/release.v1"
    find "$release_tmp" -type d -exec chmod 755 {} \;
    find "$release_tmp" -type f -exec chmod 444 {} \;
    chmod 555 \
      "$release_tmp/deploy/deployment-state.sh" \
      "$release_tmp/deploy/rollback-on-vps.sh"
    mv "$release_tmp" "$release_dir"
    trap - EXIT HUP INT TERM
  fi

  verify_operations_release
)

activate_operations_release() (
  operations_root="$app_root/operations"
  current_path="$operations_root/current"
  expected_release_manifest="v1 $revision $source_archive_sha256"
  verify_operations_release || return 1
  if [ -e "$current_path" ] || [ -L "$current_path" ]; then
    test -L "$current_path" || {
      echo "Operations current path must be an atomic release symlink" >&2
      return 1
    }
  fi
  current_tmp="$operations_root/.current-$revision"
  rm -f "$current_tmp"
  cleanup_current_tmp() {
    rm -f "$current_tmp"
  }
  trap cleanup_current_tmp EXIT HUP INT TERM
  ln -s "releases/$revision" "$current_tmp"
  mv -Tf "$current_tmp" "$current_path"
  trap - EXIT HUP INT TERM
  test -L "$current_path" \
    && test "$(readlink "$current_path")" = "releases/$revision" \
    && test "$(cat "$current_path/release.v1")" = \
    "$expected_release_manifest" || {
    echo "Operations current release readback failed" >&2
    return 1
  }
)

deployment_ok=0
if ! prepare_operations_release; then
  echo "Deployment operations-release preparation failed before runtime quiesce" >&2
  exit 1
fi
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
  if [ "$private_migration_gate_failed" -eq 1 ]; then
    if [ "$private_runtimes_absent" -eq 1 ]; then
      echo "Private runtime migration gate failed; leaving review, operations, and worker down and preserving the running public app" >&2
    else
      echo "Private runtime migration gate failed before absence proof; private runtime state is unproven and migration was not run" >&2
    fi
    exit 1
  fi
  if [ "$private_runtimes_quiesced_for_deploy" -eq 1 ]; then
    # Candidate startup/readback may have recreated all four runtimes after the
    # migration gate succeeded. Remove every candidate process and prove
    # absence before considering a public-only fallback. With no exact prior
    # image, the closed state is all candidate runtimes down.
    cleanup_failed_candidate_runtime || exit 1
    exit 1
  fi
  echo "Deployment failed before runtime quiesce; automatic fallback refused" >&2
  exit 1
fi

# Once readback succeeds, make the state commit and its in-process marker one
# signal-free critical section. Otherwise a signal between the atomic file
# rename and the next shell command could roll back a deployment whose state was
# already committed (or leave an uncommitted candidate live in the inverse
# ordering).
trap '' HUP INT TERM
record_immutable_deployment_state \
  "$state_dir" "$revision" current "$loaded_image_id" "$revision"
deployment_committed=1
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "$health"
printf '%s\n' "$worker_health"
