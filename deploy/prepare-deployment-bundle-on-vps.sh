#!/bin/sh
set -eu

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
operation_lock="$state_dir/.deployment-operation.lock"
operation_lock_owned=0
prepared_leaf_owned=0
# One active transfer is enough because the protected workflow is itself
# serialized. The admitted leaf may grow to 2.25 GiB (the bounded image,
# source, provenance, SBOM, manifest, and controls) while at least 4 GiB stays
# free for PostgreSQL, Docker, and host operations.
maximum_active_bundle_leaves=1
maximum_bundle_kib=2359296
maximum_active_bundle_kib=2359296
minimum_host_free_kib=4194304
active_bundle_leaves=0
active_bundle_kib=0

valid_revision() {
  case "$1" in
    ''|*[!0-9a-f]*) return 1 ;;
  esac
  [ "${#1}" -eq 40 ]
}

valid_positive_decimal() {
  case "$1" in
    ''|0|0[0-9]*|*[!0-9]*) return 1 ;;
  esac
}

valid_nonnegative_decimal() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
}

split_bundle_pair() {
  bundle_pair=$1
  case "$bundle_pair" in
    *-*) ;;
    *) return 1 ;;
  esac
  bundle_pair_run=${bundle_pair%%-*}
  bundle_pair_attempt=${bundle_pair#*-}
  valid_positive_decimal "$bundle_pair_run" \
    && valid_positive_decimal "$bundle_pair_attempt" \
    && [ "$bundle_pair" = "$bundle_pair_run-$bundle_pair_attempt" ]
}

valid_revision "$revision" \
  && valid_positive_decimal "$ci_run_id" \
  && valid_positive_decimal "$ci_run_attempt" \
  && valid_positive_decimal "$deploy_run_id" \
  && valid_positive_decimal "$deploy_run_attempt" || {
  echo "Deployment transfer-bundle identifiers are invalid" >&2
  exit 2
}

test -d "$app_root" && test ! -L "$app_root" \
  && [ "$(CDPATH= cd -- "$app_root" && pwd -P)" = "$app_root" ] || {
  echo "Application root must be a canonical regular directory" >&2
  exit 1
}
test -d "$state_dir" && test ! -L "$state_dir" || {
  echo "Deployment state root must be a regular directory" >&2
  exit 1
}

validate_bundle_leaf() {
  bundle_leaf=$1
  case "$bundle_leaf" in
    "$deploy_bundle_root_physical"/*) ;;
    *) return 1 ;;
  esac
  bundle_relative=${bundle_leaf#"$deploy_bundle_root_physical"/}
  bundle_leaf_revision=${bundle_relative%%/*}
  bundle_remainder=${bundle_relative#*/}
  [ "$bundle_remainder" != "$bundle_relative" ] || return 1
  bundle_leaf_ci_pair=${bundle_remainder%%/*}
  bundle_leaf_deploy_pair=${bundle_remainder#*/}
  [ "$bundle_leaf_deploy_pair" != "$bundle_remainder" ] || return 1
  case "$bundle_leaf_deploy_pair" in
    */*) return 1 ;;
  esac
  valid_revision "$bundle_leaf_revision" || return 1
  split_bundle_pair "$bundle_leaf_ci_pair" || return 1
  bundle_leaf_ci_run=$bundle_pair_run
  bundle_leaf_ci_attempt=$bundle_pair_attempt
  split_bundle_pair "$bundle_leaf_deploy_pair" || return 1
  bundle_leaf_deploy_run=$bundle_pair_run
  bundle_leaf_deploy_attempt=$bundle_pair_attempt
  bundle_revision_dir="$deploy_bundle_root_physical/$bundle_leaf_revision"
  bundle_ci_dir="$bundle_revision_dir/$bundle_leaf_ci_pair"
  [ -d "$bundle_revision_dir" ] && [ ! -L "$bundle_revision_dir" ] \
    && [ -d "$bundle_ci_dir" ] && [ ! -L "$bundle_ci_dir" ] \
    && [ -d "$bundle_leaf" ] && [ ! -L "$bundle_leaf" ]
}

read_bundle_lease() {
  bundle_lease_path=$1
  [ -f "$bundle_lease_path" ] && [ ! -L "$bundle_lease_path" ] || return 1
  bundle_lease_version=""
  bundle_lease_revision=""
  bundle_lease_ci_run=""
  bundle_lease_ci_attempt=""
  bundle_lease_deploy_run=""
  bundle_lease_deploy_attempt=""
  bundle_lease_expires=""
  bundle_lease_extra=""
  IFS=' ' read -r \
    bundle_lease_version \
    bundle_lease_revision \
    bundle_lease_ci_run \
    bundle_lease_ci_attempt \
    bundle_lease_deploy_run \
    bundle_lease_deploy_attempt \
    bundle_lease_expires \
    bundle_lease_extra < "$bundle_lease_path" || return 1
  bundle_lease_contents=$(cat "$bundle_lease_path") || return 1
  [ "$bundle_lease_contents" = \
    "$bundle_lease_version $bundle_lease_revision $bundle_lease_ci_run $bundle_lease_ci_attempt $bundle_lease_deploy_run $bundle_lease_deploy_attempt $bundle_lease_expires" ] \
    && [ "$bundle_lease_version" = "v1" ] \
    && valid_revision "$bundle_lease_revision" \
    && valid_positive_decimal "$bundle_lease_ci_run" \
    && valid_positive_decimal "$bundle_lease_ci_attempt" \
    && valid_positive_decimal "$bundle_lease_deploy_run" \
    && valid_positive_decimal "$bundle_lease_deploy_attempt" \
    && valid_positive_decimal "$bundle_lease_expires" \
    && [ "${#bundle_lease_expires}" -le 12 ] \
    && [ -z "$bundle_lease_extra" ]
}

remove_bundle_leaf() {
  remove_leaf=$1
  validate_bundle_leaf "$remove_leaf" || {
    echo "Refusing to remove an invalid deployment transfer-bundle path" >&2
    return 1
  }
  remove_ci_dir=$bundle_ci_dir
  remove_revision_dir=$bundle_revision_dir
  rm -rf -- "$remove_leaf" || return 1
  rmdir "$remove_ci_dir" 2>/dev/null || true
  rmdir "$remove_revision_dir" 2>/dev/null || true
}

account_active_bundle_leaf() {
  account_leaf=$1
  account_leaf_kib=$(du -sk "$account_leaf" | awk '
    NR == 1 { print $1; next }
    { exit 1 }
  ') || return 1
  valid_nonnegative_decimal "$account_leaf_kib" \
    && [ "${#account_leaf_kib}" -le 12 ] || {
    echo "Could not measure active deployment transfer-bundle bytes" >&2
    return 1
  }
  [ "$account_leaf_kib" -le "$maximum_bundle_kib" ] || {
    echo "Active deployment transfer bundle exceeds its byte bound" >&2
    return 1
  }
  active_bundle_leaves=$((active_bundle_leaves + 1))
  active_bundle_kib=$((active_bundle_kib + account_leaf_kib))
  [ "$active_bundle_leaves" -le "$maximum_active_bundle_leaves" ] || {
    echo "Active deployment transfer-bundle count reached its capacity bound" >&2
    return 1
  }
  [ "$active_bundle_kib" -le "$maximum_active_bundle_kib" ] || {
    echo "Active deployment transfer-bundle bytes reached their capacity bound" >&2
    return 1
  }
}

prune_bundle_staging() {
  bundle_now=$(date +%s) || return 1
  valid_positive_decimal "$bundle_now" || return 1
  bundle_maximum_lease=$((bundle_now + 10800))
  unsafe_link=$(find "$deploy_bundle_root_physical" \
    -mindepth 1 -maxdepth 3 -type l -print -quit) || return 1
  [ -z "$unsafe_link" ] || {
    echo "Deployment transfer-bundle root contains an unsafe symbolic link" >&2
    return 1
  }
  for revision_entry in \
    "$deploy_bundle_root_physical"/* \
    "$deploy_bundle_root_physical"/.[!.]* \
    "$deploy_bundle_root_physical"/..?*
  do
    if [ ! -e "$revision_entry" ] && [ ! -L "$revision_entry" ]; then
      continue
    fi
    [ -d "$revision_entry" ] && [ ! -L "$revision_entry" ] || {
      echo "Deployment transfer-bundle root contains an invalid revision entry" >&2
      return 1
    }
    revision_name=${revision_entry##*/}
    valid_revision "$revision_name" || {
      echo "Deployment transfer-bundle root contains an invalid revision directory" >&2
      return 1
    }
    for ci_entry in \
      "$revision_entry"/* \
      "$revision_entry"/.[!.]* \
      "$revision_entry"/..?*
    do
      if [ ! -e "$ci_entry" ] && [ ! -L "$ci_entry" ]; then
        continue
      fi
      [ -d "$ci_entry" ] && [ ! -L "$ci_entry" ] || {
        echo "Deployment transfer-bundle revision contains an invalid CI entry" >&2
        return 1
      }
      ci_name=${ci_entry##*/}
      split_bundle_pair "$ci_name" || {
        echo "Deployment transfer-bundle revision contains an invalid CI directory" >&2
        return 1
      }
      for bundle_candidate in \
        "$ci_entry"/* \
        "$ci_entry"/.[!.]* \
        "$ci_entry"/..?*
      do
        if [ ! -e "$bundle_candidate" ] && [ ! -L "$bundle_candidate" ]; then
          continue
        fi
        validate_bundle_leaf "$bundle_candidate" || {
          echo "Deployment transfer-bundle root contains an invalid leaf" >&2
          return 1
        }
        candidate_lease="$bundle_candidate/.lease.v1"
        if [ -e "$candidate_lease" ] || [ -L "$candidate_lease" ]; then
          if ! read_bundle_lease "$candidate_lease"; then
            stale_invalid_lease=$(find "$candidate_lease" \
              -prune -mmin +180 -print -quit) || return 1
            if [ -z "$stale_invalid_lease" ]; then
              echo "Preserving a recent invalid deployment transfer-bundle lease" >&2
              account_active_bundle_leaf "$bundle_candidate" || return 1
              continue
            fi
            remove_bundle_leaf "$bundle_candidate" || return 1
            continue
          fi
          [ "$bundle_lease_revision" = "$bundle_leaf_revision" ] \
            && [ "$bundle_lease_ci_run" = "$bundle_leaf_ci_run" ] \
            && [ "$bundle_lease_ci_attempt" = "$bundle_leaf_ci_attempt" ] \
            && [ "$bundle_lease_deploy_run" = "$bundle_leaf_deploy_run" ] \
            && [ "$bundle_lease_deploy_attempt" = \
              "$bundle_leaf_deploy_attempt" ] || {
            echo "Deployment transfer-bundle lease does not match its path" >&2
            return 1
          }
          if [ "$bundle_lease_expires" -gt "$bundle_maximum_lease" ]; then
            echo "Deployment transfer-bundle lease exceeds the bounded horizon" >&2
            return 1
          fi
          if [ "$bundle_lease_expires" -ge "$bundle_now" ]; then
            account_active_bundle_leaf "$bundle_candidate" || return 1
            continue
          fi
        fi
        remove_bundle_leaf "$bundle_candidate" || return 1
      done
      rmdir "$ci_entry" 2>/dev/null || true
    done
    rmdir "$revision_entry" 2>/dev/null || true
  done
}

enforce_bundle_allocation_capacity() {
  prospective_bundle_leaves=$((active_bundle_leaves + 1))
  [ "$prospective_bundle_leaves" -le "$maximum_active_bundle_leaves" ] || {
    echo "Deployment transfer allocation refused while another lease is active" >&2
    return 1
  }
  prospective_bundle_kib=$((active_bundle_kib + maximum_bundle_kib))
  [ "$prospective_bundle_kib" -le "$maximum_active_bundle_kib" ] || {
    echo "Deployment transfer allocation exceeds the aggregate byte bound" >&2
    return 1
  }
  filesystem_free_kib=$(df -Pk "$deploy_bundle_root_physical" | awk '
    NR == 2 { value = $4; rows = 1; next }
    NR > 2 { rows = 2 }
    END { if (rows == 1) print value; else exit 1 }
  ') || {
    echo "Could not measure deployment transfer filesystem capacity" >&2
    return 1
  }
  valid_nonnegative_decimal "$filesystem_free_kib" \
    && [ "${#filesystem_free_kib}" -le 15 ] || {
    echo "Deployment transfer filesystem reported invalid free space" >&2
    return 1
  }
  required_free_kib=$((minimum_host_free_kib + maximum_bundle_kib))
  [ "$filesystem_free_kib" -ge "$required_free_kib" ] || {
    echo "Deployment transfer allocation would violate the host free-space reserve" >&2
    return 1
  }
}

cleanup_prepare() {
  prepare_status=$?
  trap - EXIT
  trap '' HUP INT TERM
  if [ "$prepared_leaf_owned" -eq 1 ]; then
    remove_bundle_leaf "$prepared_leaf" || prepare_status=1
  fi
  if [ "$operation_lock_owned" -eq 1 ]; then
    operation_lock_owned=0
    rmdir "$operation_lock" || prepare_status=1
  fi
  exit "$prepare_status"
}
trap cleanup_prepare EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Mask signals only across mkdir and the ownership flag. EXIT was installed
# first, so every catchable interruption either owns and removes the lock or
# leaves another process's lock untouched.
trap '' HUP INT TERM
mkdir "$operation_lock" 2>/dev/null || {
  echo "Another deploy or rollback operation may be active" >&2
  exit 1
}
operation_lock_owned=1
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 700 "$operation_lock"

if [ ! -e "$deploy_bundle_root" ] && [ ! -L "$deploy_bundle_root" ]; then
  install -d -m 700 "$deploy_bundle_root"
fi
test -d "$deploy_bundle_root" && test ! -L "$deploy_bundle_root" || {
  echo "Deployment transfer-bundle root must be a regular directory" >&2
  exit 1
}
deploy_bundle_root_physical=$(CDPATH= cd -- "$deploy_bundle_root" && pwd -P)
[ "$deploy_bundle_root_physical" = "$deploy_bundle_root" ] || {
  echo "Deployment transfer-bundle root must use its canonical absolute path" >&2
  exit 1
}

# Every allocation performs the expiry sweep. This bounds disk retention even
# when earlier runners repeatedly disappear before deploy-on-vps.sh starts.
prune_bundle_staging
enforce_bundle_allocation_capacity

revision_dir="$deploy_bundle_root_physical/$revision"
ci_dir="$revision_dir/$ci_run_id-$ci_run_attempt"
prepared_leaf="$ci_dir/$deploy_run_id-$deploy_run_attempt"
if [ ! -e "$revision_dir" ] && [ ! -L "$revision_dir" ]; then
  install -d -m 700 "$revision_dir"
fi
test -d "$revision_dir" && test ! -L "$revision_dir" || exit 1
if [ ! -e "$ci_dir" ] && [ ! -L "$ci_dir" ]; then
  install -d -m 700 "$ci_dir"
fi
test -d "$ci_dir" && test ! -L "$ci_dir" || exit 1
test ! -e "$prepared_leaf" && test ! -L "$prepared_leaf" || {
  echo "Exact deployment transfer-bundle leaf already exists" >&2
  exit 1
}

# Leaf creation and atomic lease publication are one catchable-signal-free
# interval under the shared lock. EXIT still removes a partial leaf on error.
trap '' HUP INT TERM
install -d -m 700 "$prepared_leaf" "$prepared_leaf/image"
prepared_leaf_owned=1
validate_bundle_leaf "$prepared_leaf" \
  && [ "$(CDPATH= cd -- "$prepared_leaf" && pwd -P)" = "$prepared_leaf" ] \
  && [ ! -L "$prepared_leaf/image" ] || exit 1
lease_expires=$(( $(date +%s) + 10800 ))
lease_tmp="$prepared_leaf/.lease.v1.tmp"
test ! -e "$lease_tmp" && test ! -L "$lease_tmp" || exit 1
umask 077
printf 'v1 %s %s %s %s %s %s\n' \
  "$revision" "$ci_run_id" "$ci_run_attempt" \
  "$deploy_run_id" "$deploy_run_attempt" "$lease_expires" > "$lease_tmp"
chmod 600 "$lease_tmp"
mv -f "$lease_tmp" "$prepared_leaf/.lease.v1"
prepared_leaf_owned=0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

trap '' HUP INT TERM
rmdir "$operation_lock"
operation_lock_owned=0
trap - EXIT HUP INT TERM
printf '%s\n' "$prepared_leaf"
