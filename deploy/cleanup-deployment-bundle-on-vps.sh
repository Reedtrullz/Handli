#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$script_dir/deployment-state.sh"

if [ "$#" -ne 5 ]; then
  echo "Usage: $0 <revision> <CI run ID> <CI run attempt> <deploy run ID> <deploy run attempt>" >&2
  exit 2
fi
revision=$1
ci_run_id=$2
ci_run_attempt=$3
deploy_run_id=$4
deploy_run_attempt=$5
app_root=${HANDLEPLAN_APP_ROOT:-/opt/apps/handleplan}
state_dir="$app_root/state"
deploy_bundle_root=${HANDLEPLAN_DEPLOY_BUNDLE_ROOT:-$app_root/deploy-bundles}

valid_positive_decimal() {
  case "$1" in
    ''|0|0[0-9]*|*[!0-9]*) return 1 ;;
  esac
}

valid_deployment_revision "$revision" \
  && valid_positive_decimal "$ci_run_id" \
  && valid_positive_decimal "$ci_run_attempt" \
  && valid_positive_decimal "$deploy_run_id" \
  && valid_positive_decimal "$deploy_run_attempt" || {
  echo "Deployment transfer-bundle cleanup identifiers are invalid" >&2
  exit 2
}
test -d "$app_root" && test ! -L "$app_root" \
  && [ "$(CDPATH= cd -- "$app_root" && pwd -P)" = "$app_root" ] \
  && test -d "$state_dir" && test ! -L "$state_dir" || {
  echo "Deployment cleanup roots are not canonical regular directories" >&2
  exit 1
}

cleanup_lock() {
  release_deployment_operation_lock || true
}
trap cleanup_lock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap '' HUP INT TERM
acquire_deployment_operation_lock "$state_dir"
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

test -d "$deploy_bundle_root" && test ! -L "$deploy_bundle_root" || {
  echo "Deployment transfer-bundle root must be a regular directory" >&2
  exit 1
}
bundle_root_physical=$(CDPATH= cd -- "$deploy_bundle_root" && pwd -P)
[ "$bundle_root_physical" = "$deploy_bundle_root" ] || {
  echo "Deployment transfer-bundle root must use its canonical absolute path" >&2
  exit 1
}
revision_dir="$bundle_root_physical/$revision"
ci_dir="$revision_dir/$ci_run_id-$ci_run_attempt"
bundle_leaf="$ci_dir/$deploy_run_id-$deploy_run_attempt"

if [ ! -e "$bundle_leaf" ] && [ ! -L "$bundle_leaf" ]; then
  release_deployment_operation_lock
  trap - EXIT HUP INT TERM
  exit 0
fi
test -d "$revision_dir" && test ! -L "$revision_dir" \
  && test -d "$ci_dir" && test ! -L "$ci_dir" \
  && test -d "$bundle_leaf" && test ! -L "$bundle_leaf" \
  && [ "$(CDPATH= cd -- "$bundle_leaf" && pwd -P)" = "$bundle_leaf" ] || {
  echo "Refusing to clean a non-canonical deployment transfer-bundle leaf" >&2
  exit 1
}
test ! -e "$bundle_leaf/.lease.v1" \
  && test ! -L "$bundle_leaf/.lease.v1" || {
  echo "Refusing to clean a leased deployment transfer bundle" >&2
  exit 1
}

# Validation and deletion remain under the same shared lock. Delete the exact
# validated relative leaf so no untrusted absolute path is passed to rm.
cd "$ci_dir"
rm -rf -- "$deploy_run_id-$deploy_run_attempt"
cd "$bundle_root_physical"
rmdir "$ci_dir" 2>/dev/null || true
rmdir "$revision_dir" 2>/dev/null || true

trap '' HUP INT TERM
release_deployment_operation_lock
trap - EXIT HUP INT TERM
