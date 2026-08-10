#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$script_dir/deployment-state.sh"

app_root=${HANDLEPLAN_APP_ROOT:-/opt/apps/handleplan}
repository_url=${HANDLEPLAN_REPOSITORY_URL:-https://github.com/Reedtrullz/Handli.git}
if [ "$#" -ne 7 ]; then
  echo "Usage: $0 <40-character commit SHA> <CI run ID> <CI run attempt> <bundle manifest SHA-256> <pending token> <previous SHA> <previous image ID>" >&2
  exit 2
fi
revision=$1
ci_run_id=$2
ci_run_attempt=$3
expected_bundle_manifest_sha256=$4
pending_deployment_token=$5
expected_previous_revision=$6
expected_previous_image_id=$7
max_source_archive_bytes=134217728
max_image_archive_bytes=2147483648
max_provenance_bytes=16777216
max_sbom_bytes=67108864
pending_deployment_timeout_seconds=900

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
valid_pending_deployment_token "$pending_deployment_token" || {
  echo "Usage: $0 <40-character commit SHA> <CI run ID> <CI run attempt> <bundle manifest SHA-256> <pending token> <previous SHA> <previous image ID>" >&2
  exit 2
}
valid_deployment_revision "$expected_previous_revision" \
  && valid_deployment_image_id "$expected_previous_image_id" \
  && [ "$expected_previous_revision" != "$revision" ] || {
  echo "Deployment requires a distinct immutable predecessor guard" >&2
  exit 2
}

shared="$app_root/shared"
source_dir="$app_root/source"
state_dir="$app_root/state"
env_file="$shared/production.env"
deploy_bundle_root=${HANDLEPLAN_DEPLOY_BUNDLE_ROOT:-$app_root/deploy-bundles}
bundle_dir="$script_dir/image"
bundle_manifest="$bundle_dir/handleplan-image-bundle.v1"
image_archive="$bundle_dir/handleplan-image.docker.tar"
source_archive="$bundle_dir/handleplan-source.tar"
provenance_artifact="$bundle_dir/handleplan.provenance.json"
sbom_artifact="$bundle_dir/handleplan.spdx.json"
deployment_bundle_lease="$script_dir/.lease.v1"

valid_positive_decimal() {
  case "$1" in
    ''|0|0[0-9]*|*[!0-9]*) return 1 ;;
  esac
}

split_deploy_bundle_pair() {
  deploy_bundle_pair=$1
  case "$deploy_bundle_pair" in
    *-*) ;;
    *) return 1 ;;
  esac
  deploy_bundle_pair_run=${deploy_bundle_pair%%-*}
  deploy_bundle_pair_attempt=${deploy_bundle_pair#*-}
  valid_positive_decimal "$deploy_bundle_pair_run" \
    && valid_positive_decimal "$deploy_bundle_pair_attempt" \
    && [ "$deploy_bundle_pair" = \
      "$deploy_bundle_pair_run-$deploy_bundle_pair_attempt" ]
}

validate_deploy_bundle_leaf() {
  deploy_bundle_leaf=$1
  case "$deploy_bundle_leaf" in
    "$deploy_bundle_root_physical"/*) ;;
    *) return 1 ;;
  esac
  deploy_bundle_relative=${deploy_bundle_leaf#"$deploy_bundle_root_physical"/}
  deploy_bundle_leaf_revision=${deploy_bundle_relative%%/*}
  deploy_bundle_remainder=${deploy_bundle_relative#*/}
  [ "$deploy_bundle_remainder" != "$deploy_bundle_relative" ] || return 1
  deploy_bundle_leaf_ci_pair=${deploy_bundle_remainder%%/*}
  deploy_bundle_leaf_deploy_pair=${deploy_bundle_remainder#*/}
  [ "$deploy_bundle_leaf_deploy_pair" != "$deploy_bundle_remainder" ] || return 1
  case "$deploy_bundle_leaf_deploy_pair" in
    */*) return 1 ;;
  esac
  valid_deployment_revision "$deploy_bundle_leaf_revision" || return 1
  split_deploy_bundle_pair "$deploy_bundle_leaf_ci_pair" || return 1
  deploy_bundle_leaf_ci_run=$deploy_bundle_pair_run
  deploy_bundle_leaf_ci_attempt=$deploy_bundle_pair_attempt
  split_deploy_bundle_pair "$deploy_bundle_leaf_deploy_pair" || return 1
  deploy_bundle_leaf_deploy_run=$deploy_bundle_pair_run
  deploy_bundle_leaf_deploy_attempt=$deploy_bundle_pair_attempt
  deploy_bundle_revision_dir="$deploy_bundle_root_physical/$deploy_bundle_leaf_revision"
  deploy_bundle_ci_dir="$deploy_bundle_revision_dir/$deploy_bundle_leaf_ci_pair"
  [ -d "$deploy_bundle_revision_dir" ] \
    && [ ! -L "$deploy_bundle_revision_dir" ] \
    && [ -d "$deploy_bundle_ci_dir" ] \
    && [ ! -L "$deploy_bundle_ci_dir" ] \
    && [ -d "$deploy_bundle_leaf" ] \
    && [ ! -L "$deploy_bundle_leaf" ]
}

read_deploy_bundle_lease() {
  deploy_bundle_lease_path=$1
  [ -f "$deploy_bundle_lease_path" ] \
    && [ ! -L "$deploy_bundle_lease_path" ] || return 1
  deploy_bundle_lease_version=""
  deploy_bundle_lease_revision=""
  deploy_bundle_lease_ci_run=""
  deploy_bundle_lease_ci_attempt=""
  deploy_bundle_lease_deploy_run=""
  deploy_bundle_lease_deploy_attempt=""
  deploy_bundle_lease_expires=""
  deploy_bundle_lease_extra=""
  IFS=' ' read -r \
    deploy_bundle_lease_version \
    deploy_bundle_lease_revision \
    deploy_bundle_lease_ci_run \
    deploy_bundle_lease_ci_attempt \
    deploy_bundle_lease_deploy_run \
    deploy_bundle_lease_deploy_attempt \
    deploy_bundle_lease_expires \
    deploy_bundle_lease_extra < "$deploy_bundle_lease_path" || return 1
  deploy_bundle_lease_contents=$(cat "$deploy_bundle_lease_path") || return 1
  [ "$deploy_bundle_lease_contents" = \
    "$deploy_bundle_lease_version $deploy_bundle_lease_revision $deploy_bundle_lease_ci_run $deploy_bundle_lease_ci_attempt $deploy_bundle_lease_deploy_run $deploy_bundle_lease_deploy_attempt $deploy_bundle_lease_expires" ] \
    && [ "$deploy_bundle_lease_version" = "v1" ] \
    && valid_deployment_revision "$deploy_bundle_lease_revision" \
    && valid_positive_decimal "$deploy_bundle_lease_ci_run" \
    && valid_positive_decimal "$deploy_bundle_lease_ci_attempt" \
    && valid_positive_decimal "$deploy_bundle_lease_deploy_run" \
    && valid_positive_decimal "$deploy_bundle_lease_deploy_attempt" \
    && valid_positive_decimal "$deploy_bundle_lease_expires" \
    && [ "${#deploy_bundle_lease_expires}" -le 12 ] \
    && [ -z "$deploy_bundle_lease_extra" ]
}

remove_deploy_bundle_leaf() {
  deploy_bundle_remove_leaf=$1
  validate_deploy_bundle_leaf "$deploy_bundle_remove_leaf" || {
    echo "Refusing to remove an invalid deployment transfer-bundle path" >&2
    return 1
  }
  [ "$deploy_bundle_remove_leaf" != "$script_dir" ] || return 0
  deploy_bundle_remove_ci_dir=$deploy_bundle_ci_dir
  deploy_bundle_remove_revision_dir=$deploy_bundle_revision_dir
  rm -rf -- "$deploy_bundle_remove_leaf" || return 1
  rmdir "$deploy_bundle_remove_ci_dir" 2>/dev/null || true
  rmdir "$deploy_bundle_remove_revision_dir" 2>/dev/null || true
}

prune_deploy_bundle_staging() {
  deploy_bundle_now=$(date +%s) || return 1
  valid_positive_decimal "$deploy_bundle_now" || return 1
  deploy_bundle_maximum_lease=$((deploy_bundle_now + 10800))
  deploy_bundle_unsafe_link=$(find "$deploy_bundle_root_physical" \
    -mindepth 1 -maxdepth 3 -type l -print -quit) || return 1
  [ -z "$deploy_bundle_unsafe_link" ] || {
    echo "Deployment transfer-bundle root contains an unsafe symbolic link" >&2
    return 1
  }
  # Walk exactly three path components with quoted shell globs. Unlike a
  # newline-delimited `find` result, this cannot split an attacker-controlled
  # filename into a different validated deletion target.
  for deploy_bundle_revision_entry in \
    "$deploy_bundle_root_physical"/* \
    "$deploy_bundle_root_physical"/.[!.]* \
    "$deploy_bundle_root_physical"/..?*
  do
    if [ ! -e "$deploy_bundle_revision_entry" ] \
      && [ ! -L "$deploy_bundle_revision_entry" ]; then
      continue
    fi
    [ -d "$deploy_bundle_revision_entry" ] \
      && [ ! -L "$deploy_bundle_revision_entry" ] || {
      echo "Deployment transfer-bundle root contains an invalid revision entry" >&2
      return 1
    }
    deploy_bundle_revision_name=${deploy_bundle_revision_entry##*/}
    valid_deployment_revision "$deploy_bundle_revision_name" || {
      echo "Deployment transfer-bundle root contains an invalid revision directory" >&2
      return 1
    }
    for deploy_bundle_ci_entry in \
      "$deploy_bundle_revision_entry"/* \
      "$deploy_bundle_revision_entry"/.[!.]* \
      "$deploy_bundle_revision_entry"/..?*
    do
      if [ ! -e "$deploy_bundle_ci_entry" ] && [ ! -L "$deploy_bundle_ci_entry" ]; then
        continue
      fi
      [ -d "$deploy_bundle_ci_entry" ] && [ ! -L "$deploy_bundle_ci_entry" ] || {
        echo "Deployment transfer-bundle revision contains an invalid CI entry" >&2
        return 1
      }
      deploy_bundle_ci_name=${deploy_bundle_ci_entry##*/}
      split_deploy_bundle_pair "$deploy_bundle_ci_name" || {
        echo "Deployment transfer-bundle revision contains an invalid CI directory" >&2
        return 1
      }
      for deploy_bundle_candidate in \
        "$deploy_bundle_ci_entry"/* \
        "$deploy_bundle_ci_entry"/.[!.]* \
        "$deploy_bundle_ci_entry"/..?*
      do
        if [ ! -e "$deploy_bundle_candidate" ] && [ ! -L "$deploy_bundle_candidate" ]; then
          continue
        fi
        validate_deploy_bundle_leaf "$deploy_bundle_candidate" || {
          echo "Deployment transfer-bundle root contains an invalid leaf" >&2
          return 1
        }
        [ "$deploy_bundle_candidate" != "$script_dir" ] || continue
        deploy_bundle_candidate_lease="$deploy_bundle_candidate/.lease.v1"
        if [ -e "$deploy_bundle_candidate_lease" ] \
          || [ -L "$deploy_bundle_candidate_lease" ]; then
          if ! read_deploy_bundle_lease "$deploy_bundle_candidate_lease"; then
            deploy_bundle_stale_invalid_lease=$(find "$deploy_bundle_candidate_lease" \
              -prune -mmin +180 -print -quit) || return 1
            if [ -z "$deploy_bundle_stale_invalid_lease" ]; then
              echo "Preserving a recent invalid deployment transfer-bundle lease" >&2
              continue
            fi
            remove_deploy_bundle_leaf "$deploy_bundle_candidate" || return 1
            continue
          fi
          [ "$deploy_bundle_lease_revision" = "$deploy_bundle_leaf_revision" ] \
            && [ "$deploy_bundle_lease_ci_run" = "$deploy_bundle_leaf_ci_run" ] \
            && [ "$deploy_bundle_lease_ci_attempt" = "$deploy_bundle_leaf_ci_attempt" ] \
            && [ "$deploy_bundle_lease_deploy_run" = "$deploy_bundle_leaf_deploy_run" ] \
            && [ "$deploy_bundle_lease_deploy_attempt" = \
              "$deploy_bundle_leaf_deploy_attempt" ] || {
            echo "Deployment transfer-bundle lease does not match its path" >&2
            return 1
          }
          if [ "$deploy_bundle_lease_expires" -gt "$deploy_bundle_maximum_lease" ]; then
            echo "Deployment transfer-bundle lease exceeds the bounded horizon" >&2
            return 1
          fi
          if [ "$deploy_bundle_lease_expires" -ge "$deploy_bundle_now" ]; then
            continue
          fi
        fi
        remove_deploy_bundle_leaf "$deploy_bundle_candidate" || return 1
      done
      rmdir "$deploy_bundle_ci_entry" 2>/dev/null || true
    done
    rmdir "$deploy_bundle_revision_entry" 2>/dev/null || true
  done
}

test -d "$deploy_bundle_root" && test ! -L "$deploy_bundle_root" || {
  echo "Deployment transfer-bundle root must be a regular directory" >&2
  exit 1
}
deploy_bundle_root_physical=$(CDPATH= cd -- "$deploy_bundle_root" && pwd -P) || exit 1
test "$deploy_bundle_root_physical" = "$deploy_bundle_root" || {
  echo "Deployment transfer-bundle root must use its canonical absolute path" >&2
  exit 1
}
validate_deploy_bundle_leaf "$script_dir" || {
  echo "Deployment script must run from an exact transfer-bundle leaf" >&2
  exit 1
}
test "$deploy_bundle_leaf_revision" = "$revision" \
  && test "$deploy_bundle_leaf_ci_run" = "$ci_run_id" \
  && test "$deploy_bundle_leaf_ci_attempt" = "$ci_run_attempt" || {
  echo "Deployment transfer-bundle path does not match the requested CI candidate" >&2
  exit 1
}
read_deploy_bundle_lease "$deployment_bundle_lease" || {
  echo "Deployment transfer bundle is missing its bounded lease" >&2
  exit 1
}
test "$deploy_bundle_lease_revision" = "$deploy_bundle_leaf_revision" \
  && test "$deploy_bundle_lease_ci_run" = "$deploy_bundle_leaf_ci_run" \
  && test "$deploy_bundle_lease_ci_attempt" = "$deploy_bundle_leaf_ci_attempt" \
  && test "$deploy_bundle_lease_deploy_run" = "$deploy_bundle_leaf_deploy_run" \
  && test "$deploy_bundle_lease_deploy_attempt" = \
    "$deploy_bundle_leaf_deploy_attempt" \
  && test "$deploy_bundle_lease_expires" -ge "$(date +%s)" || {
  echo "Deployment transfer-bundle lease is expired or does not match its path" >&2
  exit 1
}
deployment_bundle_lease_owned=1
remove_current_deploy_bundle_lease() {
  if [ "$deployment_bundle_lease_owned" -eq 1 ]; then
    rm -f -- "$deployment_bundle_lease" || return 1
    deployment_bundle_lease_owned=0
  fi
}
cleanup_initial_deploy_bundle_lease() {
  remove_current_deploy_bundle_lease || true
}
trap cleanup_initial_deploy_bundle_lease EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

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
cleanup_early_deployment_lock() {
  if release_deployment_operation_lock; then
    remove_current_deploy_bundle_lease || true
  fi
}
trap cleanup_early_deployment_lock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap '' HUP INT TERM
acquire_deployment_operation_lock "$state_dir"
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
load_deployment_state "$state_dir"
test -n "$previous_revision" \
  && test "$previous_compatibility_mode" = "current" \
  && test -n "$previous_image_id" || {
  echo "Automated deployment requires one verified immutable predecessor; first deployment fails closed" >&2
  exit 1
}
test "$previous_revision" = "$expected_previous_revision" \
  && test "$previous_image_id" = "$expected_previous_image_id" || {
  echo "Committed deployment changed after the runner captured its rollback guard" >&2
  exit 1
}
test ! -e "$state_dir/pending-deployment" \
  && test ! -L "$state_dir/pending-deployment" || {
  echo "An unresolved pending deployment blocks every newer deployment" >&2
  exit 1
}
assert_pending_watchdog_capacity "$state_dir" || {
  echo "Deployment refused because pending-watchdog capacity is unavailable" >&2
  exit 1
}
prune_deploy_bundle_staging || {
  echo "Could not safely prune deployment transfer-bundle staging" >&2
  exit 1
}

# CI is the only image builder. The VPS accepts a fixed five-file bundle from
# the exact successful workflow run and never rebuilds the image. The source
# archive remains necessary for the exact Compose/migration definitions, but it
# is not a Docker build context on this host.
build_root=$(mktemp -d "$app_root/.deploy-load.XXXXXX")
deployment_source_dir="$build_root/source"
candidate_runtime_may_exist=0
deployment_committed=0
pending_deployment_recorded=0
pending_watchdog_lease_recorded=0
pending_watchdog_launched=0
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
    candidate_cleanup_succeeded=1
    if [ "$candidate_runtime_may_exist" -eq 1 ] \
      && [ "$deployment_committed" -ne 1 ]; then
      echo "Deployment interrupted after candidate startup; removing every candidate runtime" >&2
      if cleanup_failed_candidate_runtime; then
        :
      else
        echo "Interrupted deployment cleanup could not prove a closed candidate state" >&2
        candidate_cleanup_succeeded=0
      fi
    fi
    if [ "$pending_deployment_recorded" -eq 1 ] \
      && [ "$deployment_committed" -ne 1 ] \
      && [ "$candidate_cleanup_succeeded" -eq 1 ]; then
      pending_watchdog_launch_cleanup_ok=1
      if [ "$pending_watchdog_lease_recorded" -eq 1 ] \
        && [ "$pending_watchdog_launched" -ne 1 ]; then
        if clear_pending_watchdog_lease \
          "$state_dir" "$revision" "$loaded_image_id" \
          "$previous_revision" "$previous_image_id" \
          "$pending_deployment_deadline" "$pending_deployment_token"; then
          pending_watchdog_lease_recorded=0
        else
          echo "Could not clear the unlaunched pending-watchdog lease" >&2
          pending_watchdog_launch_cleanup_ok=0
          exit_status=1
        fi
      fi
      if [ "$pending_watchdog_launch_cleanup_ok" -eq 1 ] \
        && clear_pending_deployment_state \
          "$state_dir" "$revision" "$loaded_image_id" \
          "$previous_revision" "$previous_image_id" \
          "$pending_deployment_deadline" "$pending_deployment_token"; then
          pending_deployment_recorded=0
      else
        echo "Could not clear the uncommitted pending-deployment guard" >&2
        exit_status=1
      fi
    fi
    cleanup_build_root
    if release_deployment_operation_lock; then
      if ! remove_current_deploy_bundle_lease; then
        exit_status=1
      fi
    else
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
test "$manifest_lines" -eq 15 || {
  echo "CI image bundle manifest has an invalid shape" >&2
  exit 1
}
test "$(sed -n '1p' "$bundle_manifest")" = \
  'format=handleplan-ci-image-bundle-v3' || {
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
manifest_platform=$(sed -n '5p' "$bundle_manifest")
manifest_runtime_source_digest_sha256=$(sed -n '6p' "$bundle_manifest")
manifest_runtime_source_file_count=$(sed -n '7p' "$bundle_manifest")
manifest_runtime_shipment_digest_sha256=$(sed -n '8p' "$bundle_manifest")
manifest_runtime_shipment_entry_count=$(sed -n '9p' "$bundle_manifest")
manifest_image_archive_sha256=$(sed -n '10p' "$bundle_manifest")
manifest_source_archive_sha256=$(sed -n '11p' "$bundle_manifest")
manifest_provenance_sha256=$(sed -n '12p' "$bundle_manifest")
manifest_sbom_sha256=$(sed -n '13p' "$bundle_manifest")
case "$manifest_image_id" in
  image_id=*) expected_image_id=${manifest_image_id#image_id=} ;;
  *) echo "CI image bundle is missing its image config digest" >&2; exit 1 ;;
esac
test "$manifest_platform" = 'platform=linux/amd64' || {
  echo "CI image bundle platform is not the supported linux/amd64 target" >&2
  exit 1
}
case "$manifest_runtime_source_digest_sha256" in
  runtime_source_digest_sha256=*) runtime_source_digest_sha256=${manifest_runtime_source_digest_sha256#runtime_source_digest_sha256=} ;;
  *) echo "CI image bundle is missing its privileged runtime source digest" >&2; exit 1 ;;
esac
case "$manifest_runtime_source_file_count" in
  runtime_source_file_count=*) runtime_source_file_count=${manifest_runtime_source_file_count#runtime_source_file_count=} ;;
  *) echo "CI image bundle is missing its privileged runtime source count" >&2; exit 1 ;;
esac
case "$manifest_runtime_shipment_digest_sha256" in
  runtime_shipment_digest_sha256=*) runtime_shipment_digest_sha256=${manifest_runtime_shipment_digest_sha256#runtime_shipment_digest_sha256=} ;;
  *) echo "CI image bundle is missing its privileged runtime shipment digest" >&2; exit 1 ;;
esac
case "$manifest_runtime_shipment_entry_count" in
  runtime_shipment_entry_count=*) runtime_shipment_entry_count=${manifest_runtime_shipment_entry_count#runtime_shipment_entry_count=} ;;
  *) echo "CI image bundle is missing its privileged runtime shipment count" >&2; exit 1 ;;
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
test "$(sed -n '14p' "$bundle_manifest")" = "ci_run_id=$ci_run_id" || {
  echo "CI image bundle run ID does not match the invoking workflow" >&2
  exit 1
}
test "$(sed -n '15p' "$bundle_manifest")" = \
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
# A successful CI rerun may rebuild the same revision. Refuse a conflicting
# revision-to-image binding before loading an image or touching any runtime.
verified_candidate_manifest="$state_dir/verified-images/$revision"
if [ -e "$verified_candidate_manifest" ] || [ -L "$verified_candidate_manifest" ]; then
  previously_verified_image_id=$(load_verified_deployment_image \
    "$state_dir" "$revision") || {
    echo "Existing verified image state is invalid" >&2
    exit 1
  }
  test "$previously_verified_image_id" = "$expected_image_id" || {
    echo "Revision is already bound to a different immutable image; refusing CI rerun" >&2
    exit 1
  }
fi
for expected_digest in \
  "$runtime_source_digest_sha256" \
  "$runtime_shipment_digest_sha256" \
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
case "$runtime_source_file_count" in
  ''|0*|*[!0-9]*) echo "CI image bundle contains an invalid privileged runtime source count" >&2; exit 1 ;;
esac
case "$runtime_shipment_entry_count" in
  ''|0*|*[!0-9]*) echo "CI image bundle contains an invalid privileged runtime shipment count" >&2; exit 1 ;;
esac
if [ "${#runtime_source_file_count}" -gt 16 ] \
  || [ "${#runtime_shipment_entry_count}" -gt 16 ]; then
  echo "CI image bundle contains an out-of-range privileged runtime count" >&2
  exit 1
fi

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
provenance_bytes=$(wc -c < "$provenance_artifact" | tr -d '[:space:]')
sbom_bytes=$(wc -c < "$sbom_artifact" | tr -d '[:space:]')
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
case "$provenance_bytes" in
  ''|*[!0-9]*)
    echo "Could not measure the exact CI provenance artifact" >&2
    exit 1
    ;;
esac
case "$sbom_bytes" in
  ''|*[!0-9]*)
    echo "Could not measure the exact CI SBOM artifact" >&2
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
if [ "$provenance_bytes" -le 0 ] \
  || [ "$provenance_bytes" -gt "$max_provenance_bytes" ]; then
  echo "Exact CI provenance artifact is empty or exceeds the 16 MiB limit" >&2
  exit 1
fi
if [ "$sbom_bytes" -le 0 ] \
  || [ "$sbom_bytes" -gt "$max_sbom_bytes" ]; then
  echo "Exact CI SBOM artifact is empty or exceeds the 64 MiB limit" >&2
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
loaded_image_platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")
test "$loaded_image_platform" = 'linux/amd64' || {
  echo "Loaded image platform is not the supported linux/amd64 target" >&2
  exit 1
}
test "$(docker image inspect --format '{{.Id}}' "$previous_image_id")" = \
  "$previous_image_id" \
  && test "$(docker image inspect \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
    "$previous_image_id")" = "$previous_revision" || {
  echo "Verified predecessor image is missing or differs from immutable deployment state" >&2
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
  migration_image=${5:-handleplan:$migration_revision}
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
    deploy "$previous_revision" "$revision" legacy \
      "$previous_fallback_image" "$loaded_image_id"
  else
    echo "Deployment failed; no verified prior image, leaving all candidate runtimes down" >&2
  fi
}

health=""
worker_health=""

verify_review_runtime() {
  target_revision=$1
  target_image=$loaded_image_id
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
  target_image=$loaded_image_id
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
  target_image=$loaded_image_id
  APP_COMMIT_SHA="$target_revision" HANDLEPLAN_IMAGE="$target_image" \
    HANDLEPLAN_MIGRATION_IMAGE="$target_image" \
    docker compose --env-file "$env_file" \
      -f "$deployment_source_dir/deploy/compose.production.yml" \
      exec -T worker wget -qO- http://127.0.0.1:3005/health
}

verify_current_deployment() {
  target_revision=$1
  target_image=$loaded_image_id
  health=$(curl --fail --silent --show-error http://127.0.0.1:3004/api/health) || return 1
  printf '%s' "$health" | grep -F "\"commit\":\"$target_revision\"" >/dev/null \
    || return 1
  app_container=$(APP_COMMIT_SHA="$target_revision" HANDLEPLAN_IMAGE="$target_image" \
    HANDLEPLAN_MIGRATION_IMAGE="$target_image" \
    docker compose --env-file "$env_file" \
      -f "$deployment_source_dir/deploy/compose.production.yml" ps -q app) || return 1
  test -n "$app_container" || return 1
  app_image=$(docker inspect --format '{{.Config.Image}}' "$app_container") || return 1
  app_image_id=$(docker inspect --format '{{.Image}}' "$app_container") || return 1
  test "$app_image" = "$target_image" || return 1
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
    worker_image=$(docker inspect --format '{{.Config.Image}}' "$worker_container") || return 1
    worker_image_id=$(docker inspect --format '{{.Image}}' "$worker_container") || return 1
    worker_container_health=$(docker inspect \
      --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
      "$worker_container") || return 1
    test "$worker_state" = "running" || return 1
    test "$worker_restarts" = "0" || return 1
    test "$worker_image" = "$target_image" || return 1
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
    resolve-pending-deployment-on-vps.sh \
    rollback-on-vps.sh \
    watch-pending-deployment-on-vps.sh
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
      resolve-pending-deployment-on-vps.sh \
      rollback-on-vps.sh \
      watch-pending-deployment-on-vps.sh
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
      "$release_tmp/deploy/resolve-pending-deployment-on-vps.sh" \
      "$release_tmp/deploy/rollback-on-vps.sh" \
      "$release_tmp/deploy/watch-pending-deployment-on-vps.sh"
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
if deploy "$revision" "$revision" current "$loaded_image_id" "$loaded_image_id"; then
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

# External routing is verified by the deploy runner, after this remote command
# returns. Before committing the candidate, create a token-bound pending record
# and start an off-session watchdog from the immutable operations release. A
# cancelled/lost runner therefore cannot strand an externally unverified image:
# absent an exact acceptance, the watchdog invokes the guarded rollback after
# fifteen minutes. This protocol intentionally requires a verified predecessor.
pending_now=$(date +%s)
valid_pending_deployment_deadline "$pending_now" || {
  echo "Could not establish the pending-deployment deadline" >&2
  exit 1
}
pending_deployment_deadline=$((pending_now + pending_deployment_timeout_seconds))
pending_watchdog="$app_root/operations/current/deploy/watch-pending-deployment-on-vps.sh"
test -x "$pending_watchdog" && test ! -L "$pending_watchdog" || {
  echo "Missing exact pending-deployment watchdog control" >&2
  exit 1
}

# Make pending publication, watchdog launch, state commit, and the in-process
# marker one signal-free critical section. A signal in any inverse ordering
# could otherwise leave a candidate live without either rollback ownership or a
# truthful committed-state guard.
trap '' HUP INT TERM
record_pending_deployment_state \
  "$state_dir" "$revision" "$loaded_image_id" \
  "$previous_revision" "$previous_image_id" \
  "$pending_deployment_deadline" "$pending_deployment_token"
pending_deployment_recorded=1
record_pending_watchdog_lease \
  "$state_dir" "$revision" "$loaded_image_id" \
  "$previous_revision" "$previous_image_id" \
  "$pending_deployment_deadline" "$pending_deployment_token"
pending_watchdog_lease_recorded=1
nohup "$pending_watchdog" \
  "$revision" "$loaded_image_id" "$pending_deployment_token" \
  "$previous_revision" "$previous_image_id" "$pending_deployment_deadline" \
  </dev/null >/dev/null 2>&1 &
pending_watchdog_pid=$!
sleep 1
kill -0 "$pending_watchdog_pid" 2>/dev/null || {
  echo "Pending-deployment watchdog did not survive launch" >&2
  exit 1
}
pending_watchdog_launched=1
record_immutable_deployment_state \
  "$state_dir" "$revision" current "$loaded_image_id" "$revision"
deployment_committed=1
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "$health"
printf '%s\n' "$worker_health"
printf 'pending-deployment-deadline=%s\n' "$pending_deployment_deadline"
