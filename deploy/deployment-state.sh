#!/bin/sh

valid_deployment_revision() (
  candidate_revision=$1
  case "$candidate_revision" in
    ''|*[!0-9a-f]*) return 1 ;;
  esac
  [ "${#candidate_revision}" -eq 40 ]
)

valid_deployment_image_id() (
  candidate_image_id=$1
  case "$candidate_image_id" in
    sha256:*) ;;
    *) return 1 ;;
  esac
  candidate_digest=${candidate_image_id#sha256:}
  case "$candidate_digest" in
    ''|*[!0-9a-f]*) return 1 ;;
  esac
  [ "${#candidate_digest}" -eq 64 ]
)

valid_pending_deployment_token() (
  pending_token_candidate=$1
  case "$pending_token_candidate" in
    ''|*[!0-9a-f]*) return 1 ;;
  esac
  [ "${#pending_token_candidate}" -eq 64 ]
)

valid_pending_deployment_deadline() (
  pending_deadline_candidate=$1
  case "$pending_deadline_candidate" in
    ''|0|0[0-9]*|*[!0-9]*) return 1 ;;
  esac
  [ "${#pending_deadline_candidate}" -le 12 ]
)

# The deployment lock serializes admission, and each detached watchdog retains
# one exact lease until that same watchdog exits. A crashed watchdog leaves its
# lease behind and therefore consumes capacity rather than allowing an
# untracked process population to grow.
maximum_pending_watchdog_leases=4

load_pending_deployment_state() {
  pending_state_dir=$1
  pending_deployment_manifest="$pending_state_dir/pending-deployment"
  [ -f "$pending_deployment_manifest" ] \
    && [ ! -L "$pending_deployment_manifest" ] || return 1

  pending_deployment_version=""
  pending_deployment_revision=""
  pending_deployment_image_id=""
  pending_previous_revision=""
  pending_previous_image_id=""
  pending_deployment_deadline=""
  pending_deployment_token=""
  pending_deployment_extra=""
  IFS=' ' read -r \
    pending_deployment_version \
    pending_deployment_revision \
    pending_deployment_image_id \
    pending_previous_revision \
    pending_previous_image_id \
    pending_deployment_deadline \
    pending_deployment_token \
    pending_deployment_extra < "$pending_deployment_manifest" || return 1
  pending_deployment_contents=$(cat "$pending_deployment_manifest") || return 1
  [ "$pending_deployment_contents" = \
    "$pending_deployment_version $pending_deployment_revision $pending_deployment_image_id $pending_previous_revision $pending_previous_image_id $pending_deployment_deadline $pending_deployment_token" ] \
    && [ "$pending_deployment_version" = "v1" ] \
    && valid_deployment_revision "$pending_deployment_revision" \
    && valid_deployment_image_id "$pending_deployment_image_id" \
    && valid_deployment_revision "$pending_previous_revision" \
    && valid_deployment_image_id "$pending_previous_image_id" \
    && [ "$pending_deployment_revision" != "$pending_previous_revision" ] \
    && valid_pending_deployment_deadline "$pending_deployment_deadline" \
    && valid_pending_deployment_token "$pending_deployment_token" \
    && [ -z "$pending_deployment_extra" ]
}

# The accepted record is the durable decision side of the pending capability.
# It deliberately retains the same exact seven fields as pending-deployment so
# a runner that loses its SSH response after acceptance cannot later interpret
# the now-absent pending file as authority to roll the candidate back.
load_accepted_deployment_state() {
  accepted_state_dir=$1
  accepted_deployment_manifest="$accepted_state_dir/accepted-deployment"
  [ -f "$accepted_deployment_manifest" ] \
    && [ ! -L "$accepted_deployment_manifest" ] || return 1

  accepted_deployment_version=""
  accepted_deployment_revision=""
  accepted_deployment_image_id=""
  accepted_previous_revision=""
  accepted_previous_image_id=""
  accepted_deployment_deadline=""
  accepted_deployment_token=""
  accepted_deployment_extra=""
  IFS=' ' read -r \
    accepted_deployment_version \
    accepted_deployment_revision \
    accepted_deployment_image_id \
    accepted_previous_revision \
    accepted_previous_image_id \
    accepted_deployment_deadline \
    accepted_deployment_token \
    accepted_deployment_extra < "$accepted_deployment_manifest" || return 1
  accepted_deployment_contents=$(cat "$accepted_deployment_manifest") \
    || return 1
  [ "$accepted_deployment_contents" = \
    "$accepted_deployment_version $accepted_deployment_revision $accepted_deployment_image_id $accepted_previous_revision $accepted_previous_image_id $accepted_deployment_deadline $accepted_deployment_token" ] \
    && [ "$accepted_deployment_version" = "v1" ] \
    && valid_deployment_revision "$accepted_deployment_revision" \
    && valid_deployment_image_id "$accepted_deployment_image_id" \
    && valid_deployment_revision "$accepted_previous_revision" \
    && valid_deployment_image_id "$accepted_previous_image_id" \
    && [ "$accepted_deployment_revision" != "$accepted_previous_revision" ] \
    && valid_pending_deployment_deadline "$accepted_deployment_deadline" \
    && valid_pending_deployment_token "$accepted_deployment_token" \
    && [ -z "$accepted_deployment_extra" ]
}

# Callers hold the deployment-operation lock. A valid prior accepted record is
# history and may be atomically replaced by a newer exact decision; a malformed
# or symlink-shaped record is never overwritten because its meaning is
# uncertain and must fail closed.
record_accepted_deployment_state() (
  accepted_state_dir=$1
  accepted_revision=$2
  accepted_image_id=$3
  accepted_prior_revision=$4
  accepted_prior_image_id=$5
  accepted_deadline=$6
  accepted_token=$7
  valid_deployment_revision "$accepted_revision" \
    || deployment_state_error || exit 1
  valid_deployment_image_id "$accepted_image_id" \
    || deployment_state_error || exit 1
  valid_deployment_revision "$accepted_prior_revision" \
    || deployment_state_error || exit 1
  valid_deployment_image_id "$accepted_prior_image_id" \
    || deployment_state_error || exit 1
  [ "$accepted_revision" != "$accepted_prior_revision" ] \
    || deployment_state_error || exit 1
  valid_pending_deployment_deadline "$accepted_deadline" \
    || deployment_state_error || exit 1
  valid_pending_deployment_token "$accepted_token" \
    || deployment_state_error || exit 1

  accepted_manifest="$accepted_state_dir/accepted-deployment"
  if [ -e "$accepted_manifest" ] || [ -L "$accepted_manifest" ]; then
    load_accepted_deployment_state "$accepted_state_dir" \
      || deployment_state_error || exit 1
  fi
  umask 077
  accepted_tmp=$(mktemp "$accepted_state_dir/.accepted-deployment.XXXXXX") \
    || exit 1
  cleanup_accepted_tmp() {
    rm -f "$accepted_tmp"
  }
  trap cleanup_accepted_tmp EXIT HUP INT TERM
  printf 'v1 %s %s %s %s %s %s\n' \
    "$accepted_revision" "$accepted_image_id" \
    "$accepted_prior_revision" "$accepted_prior_image_id" \
    "$accepted_deadline" "$accepted_token" > "$accepted_tmp"
  chmod 600 "$accepted_tmp"
  mv -f "$accepted_tmp" "$accepted_manifest"
  trap - EXIT HUP INT TERM
)

ensure_pending_watchdog_ledger() {
  pending_watchdog_state_dir=$1
  pending_watchdog_ledger="$pending_watchdog_state_dir/pending-watchdogs"
  if [ -e "$pending_watchdog_ledger" ] || [ -L "$pending_watchdog_ledger" ]; then
    [ -d "$pending_watchdog_ledger" ] && [ ! -L "$pending_watchdog_ledger" ] \
      || deployment_state_error || return 1
  else
    mkdir "$pending_watchdog_ledger" || return 1
  fi
  chmod 700 "$pending_watchdog_ledger" || return 1
}

load_pending_watchdog_lease() {
  pending_watchdog_state_dir=$1
  expected_pending_watchdog_token=$2
  valid_pending_deployment_token "$expected_pending_watchdog_token" \
    || deployment_state_error || return 1
  pending_watchdog_ledger="$pending_watchdog_state_dir/pending-watchdogs"
  [ -d "$pending_watchdog_ledger" ] && [ ! -L "$pending_watchdog_ledger" ] \
    || deployment_state_error || return 1
  pending_watchdog_lease="$pending_watchdog_ledger/$expected_pending_watchdog_token"
  [ -f "$pending_watchdog_lease" ] && [ ! -L "$pending_watchdog_lease" ] \
    || deployment_state_error || return 1

  pending_watchdog_version=""
  pending_watchdog_revision=""
  pending_watchdog_image_id=""
  pending_watchdog_previous_revision=""
  pending_watchdog_previous_image_id=""
  pending_watchdog_deadline=""
  pending_watchdog_token=""
  pending_watchdog_extra=""
  IFS=' ' read -r \
    pending_watchdog_version \
    pending_watchdog_revision \
    pending_watchdog_image_id \
    pending_watchdog_previous_revision \
    pending_watchdog_previous_image_id \
    pending_watchdog_deadline \
    pending_watchdog_token \
    pending_watchdog_extra < "$pending_watchdog_lease" || return 1
  pending_watchdog_contents=$(cat "$pending_watchdog_lease") || return 1
  [ "$pending_watchdog_contents" = \
    "$pending_watchdog_version $pending_watchdog_revision $pending_watchdog_image_id $pending_watchdog_previous_revision $pending_watchdog_previous_image_id $pending_watchdog_deadline $pending_watchdog_token" ] \
    && [ "$pending_watchdog_version" = "v1" ] \
    && valid_deployment_revision "$pending_watchdog_revision" \
    && valid_deployment_image_id "$pending_watchdog_image_id" \
    && valid_deployment_revision "$pending_watchdog_previous_revision" \
    && valid_deployment_image_id "$pending_watchdog_previous_image_id" \
    && [ "$pending_watchdog_revision" != \
      "$pending_watchdog_previous_revision" ] \
    && valid_pending_deployment_deadline "$pending_watchdog_deadline" \
    && valid_pending_deployment_token "$pending_watchdog_token" \
    && [ "$pending_watchdog_token" = "$expected_pending_watchdog_token" ] \
    && [ -z "$pending_watchdog_extra" ]
}

validate_pending_watchdog_ledger() {
  pending_watchdog_state_dir=$1
  pending_watchdog_ledger="$pending_watchdog_state_dir/pending-watchdogs"
  [ -d "$pending_watchdog_ledger" ] && [ ! -L "$pending_watchdog_ledger" ] \
    || deployment_state_error || return 1
  pending_watchdog_lease_count=0
  for pending_watchdog_entry in \
    "$pending_watchdog_ledger"/* \
    "$pending_watchdog_ledger"/.[!.]* \
    "$pending_watchdog_ledger"/..?*
  do
    if [ ! -e "$pending_watchdog_entry" ] \
      && [ ! -L "$pending_watchdog_entry" ]; then
      continue
    fi
    pending_watchdog_entry_name=${pending_watchdog_entry##*/}
    valid_pending_deployment_token "$pending_watchdog_entry_name" \
      && load_pending_watchdog_lease \
        "$pending_watchdog_state_dir" "$pending_watchdog_entry_name" \
      || deployment_state_error || return 1
    pending_watchdog_lease_count=$((pending_watchdog_lease_count + 1))
    [ "$pending_watchdog_lease_count" -le \
      "$maximum_pending_watchdog_leases" ] || {
      echo "Pending-watchdog lease ledger exceeds its hard capacity" >&2
      return 1
    }
  done
}

assert_pending_watchdog_capacity() {
  pending_watchdog_state_dir=$1
  ensure_pending_watchdog_ledger "$pending_watchdog_state_dir" \
    && validate_pending_watchdog_ledger "$pending_watchdog_state_dir" \
    || return 1
  [ "$pending_watchdog_lease_count" -lt \
    "$maximum_pending_watchdog_leases" ] || {
    echo "Pending-watchdog lease capacity is exhausted" >&2
    return 1
  }
}

# Callers hold the deployment-operation lock. Publication is create-only and
# admission revalidates every existing exact lease before counting it.
record_pending_watchdog_lease() (
  pending_watchdog_state_dir=$1
  pending_watchdog_revision_value=$2
  pending_watchdog_image_id_value=$3
  pending_watchdog_previous_revision_value=$4
  pending_watchdog_previous_image_id_value=$5
  pending_watchdog_deadline_value=$6
  pending_watchdog_token_value=$7
  valid_deployment_revision "$pending_watchdog_revision_value" \
    && valid_deployment_image_id "$pending_watchdog_image_id_value" \
    && valid_deployment_revision "$pending_watchdog_previous_revision_value" \
    && valid_deployment_image_id "$pending_watchdog_previous_image_id_value" \
    && [ "$pending_watchdog_revision_value" != \
      "$pending_watchdog_previous_revision_value" ] \
    && valid_pending_deployment_deadline "$pending_watchdog_deadline_value" \
    && valid_pending_deployment_token "$pending_watchdog_token_value" \
    || deployment_state_error || exit 1
  assert_pending_watchdog_capacity "$pending_watchdog_state_dir" || exit 1
  pending_watchdog_lease="$pending_watchdog_ledger/$pending_watchdog_token_value"
  [ ! -e "$pending_watchdog_lease" ] && [ ! -L "$pending_watchdog_lease" ] \
    || deployment_state_error || exit 1

  umask 077
  pending_watchdog_tmp=$(mktemp \
    "$pending_watchdog_ledger/.pending-watchdog.XXXXXX") || exit 1
  cleanup_pending_watchdog_tmp() {
    rm -f "$pending_watchdog_tmp"
  }
  trap cleanup_pending_watchdog_tmp EXIT HUP INT TERM
  printf 'v1 %s %s %s %s %s %s\n' \
    "$pending_watchdog_revision_value" "$pending_watchdog_image_id_value" \
    "$pending_watchdog_previous_revision_value" \
    "$pending_watchdog_previous_image_id_value" \
    "$pending_watchdog_deadline_value" "$pending_watchdog_token_value" \
    > "$pending_watchdog_tmp"
  chmod 600 "$pending_watchdog_tmp"
  ln "$pending_watchdog_tmp" "$pending_watchdog_lease" || exit 1
  rm -f "$pending_watchdog_tmp"
  trap - EXIT HUP INT TERM
)

# Only an exact tuple can retire its lease. No process identifier grants
# cleanup authority, so PID reuse can never remove another watchdog's record.
clear_pending_watchdog_lease() {
  pending_watchdog_state_dir=$1
  expected_pending_watchdog_revision=$2
  expected_pending_watchdog_image_id=$3
  expected_pending_watchdog_previous_revision=$4
  expected_pending_watchdog_previous_image_id=$5
  expected_pending_watchdog_deadline=$6
  expected_pending_watchdog_token=$7
  load_pending_watchdog_lease \
    "$pending_watchdog_state_dir" "$expected_pending_watchdog_token" \
    || return 1
  [ "$pending_watchdog_revision" = \
      "$expected_pending_watchdog_revision" ] \
    && [ "$pending_watchdog_image_id" = \
      "$expected_pending_watchdog_image_id" ] \
    && [ "$pending_watchdog_previous_revision" = \
      "$expected_pending_watchdog_previous_revision" ] \
    && [ "$pending_watchdog_previous_image_id" = \
      "$expected_pending_watchdog_previous_image_id" ] \
    && [ "$pending_watchdog_deadline" = \
      "$expected_pending_watchdog_deadline" ] \
    && [ "$pending_watchdog_token" = "$expected_pending_watchdog_token" ] \
    || deployment_state_error || return 1
  rm -f -- "$pending_watchdog_lease"
}

# Callers hold the deployment-operation lock. The create-only hard link means a
# second deploy cannot replace an unresolved candidate's watchdog capability.
record_pending_deployment_state() (
  pending_state_dir=$1
  pending_revision=$2
  pending_image_id=$3
  pending_prior_revision=$4
  pending_prior_image_id=$5
  pending_deadline=$6
  pending_token=$7
  valid_deployment_revision "$pending_revision" || deployment_state_error || exit 1
  valid_deployment_image_id "$pending_image_id" || deployment_state_error || exit 1
  valid_deployment_revision "$pending_prior_revision" || deployment_state_error || exit 1
  valid_deployment_image_id "$pending_prior_image_id" || deployment_state_error || exit 1
  [ "$pending_revision" != "$pending_prior_revision" ] \
    || deployment_state_error || exit 1
  valid_pending_deployment_deadline "$pending_deadline" \
    || deployment_state_error || exit 1
  valid_pending_deployment_token "$pending_token" \
    || deployment_state_error || exit 1

  pending_manifest="$pending_state_dir/pending-deployment"
  [ ! -e "$pending_manifest" ] && [ ! -L "$pending_manifest" ] \
    || deployment_state_error || exit 1
  umask 077
  pending_tmp=$(mktemp "$pending_state_dir/.pending-deployment.XXXXXX") || exit 1
  cleanup_pending_tmp() {
    rm -f "$pending_tmp"
  }
  trap cleanup_pending_tmp EXIT HUP INT TERM
  printf 'v1 %s %s %s %s %s %s\n' \
    "$pending_revision" "$pending_image_id" \
    "$pending_prior_revision" "$pending_prior_image_id" \
    "$pending_deadline" "$pending_token" > "$pending_tmp"
  chmod 600 "$pending_tmp"
  ln "$pending_tmp" "$pending_manifest" || exit 1
  rm -f "$pending_tmp"
  trap - EXIT HUP INT TERM
)

# Callers hold the deployment-operation lock and supply both sides of the exact
# transition so a stale runner cannot clear a newer pending deployment.
clear_pending_deployment_state() {
  pending_state_dir=$1
  expected_pending_revision=$2
  expected_pending_image_id=$3
  expected_previous_revision=$4
  expected_previous_image_id=$5
  expected_pending_deadline=$6
  expected_pending_token=$7
  load_pending_deployment_state "$pending_state_dir" \
    || deployment_state_error || return 1
  [ "$pending_deployment_revision" = "$expected_pending_revision" ] \
    && [ "$pending_deployment_image_id" = "$expected_pending_image_id" ] \
    && [ "$pending_previous_revision" = "$expected_previous_revision" ] \
    && [ "$pending_previous_image_id" = "$expected_previous_image_id" ] \
    && [ "$pending_deployment_deadline" = "$expected_pending_deadline" ] \
    && [ "$pending_deployment_token" = "$expected_pending_token" ] \
    || deployment_state_error || return 1
  rm -f -- "$pending_deployment_manifest"
}

deployment_state_error() {
  echo "Invalid deployment state; refusing to select an automatic rollback mode" >&2
  return 1
}

acquire_deployment_operation_lock() {
  operation_state_dir=$1
  operation_lock_candidate="$operation_state_dir/.deployment-operation.lock"
  deployment_operation_lock=""
  deployment_operation_lock_owned=0
  if ! mkdir "$operation_lock_candidate" 2>/dev/null; then
    echo "Another deploy or rollback operation may be active; refusing concurrent state change" >&2
    return 1
  fi
  deployment_operation_lock=$operation_lock_candidate
  deployment_operation_lock_owned=1
  chmod 700 "$deployment_operation_lock" || {
    rmdir "$deployment_operation_lock" 2>/dev/null || true
    deployment_operation_lock=""
    deployment_operation_lock_owned=0
    return 1
  }
}

release_deployment_operation_lock() {
  if [ "${deployment_operation_lock_owned:-0}" -eq 1 ] \
    && [ -n "${deployment_operation_lock:-}" ]; then
    rmdir "$deployment_operation_lock" || {
      echo "Could not release the deployment operation lock" >&2
      return 1
    }
    deployment_operation_lock=""
    deployment_operation_lock_owned=0
  fi
}

deployment_compose_mode() {
  case "$1" in
    current|legacy) printf '%s\n' "$1" ;;
    *) deployment_state_error; return 1 ;;
  esac
}

load_deployment_state() {
  deployment_state_dir=$1
  deployment_manifest="$deployment_state_dir/current-deployment"
  compatibility_revision_file="$deployment_state_dir/current-revision"
  previous_revision=""
  previous_compatibility_mode="legacy"
  previous_image_id=""
  deployment_high_water_revision=""

  if [ -f "$deployment_manifest" ] && [ ! -L "$deployment_manifest" ]; then
    state_version=""
    state_revision=""
    state_mode=""
    state_extra=""
    IFS=' ' read -r state_version state_revision state_mode state_extra \
      < "$deployment_manifest" || deployment_state_error || return 1
    state_contents=$(cat "$deployment_manifest") || return 1
    [ "$state_contents" = "$state_version $state_revision $state_mode" ] \
      || deployment_state_error || return 1
    [ "$state_version" = "v1" ] || deployment_state_error || return 1
    valid_deployment_revision "$state_revision" || deployment_state_error || return 1
    deployment_compose_mode "$state_mode" >/dev/null || return 1
    [ -z "$state_extra" ] || deployment_state_error || return 1
    [ -f "$compatibility_revision_file" ] \
      && [ ! -L "$compatibility_revision_file" ] \
      || deployment_state_error || return 1
    compatibility_revision=$(cat "$compatibility_revision_file") || return 1
    valid_deployment_revision "$compatibility_revision" \
      || deployment_state_error || return 1
    [ "$compatibility_revision" = "$state_revision" ] \
      || deployment_state_error || return 1
    previous_revision=$state_revision
    previous_compatibility_mode=$state_mode
    load_immutable_deployment_state "$deployment_state_dir" || return 1
    return 0
  fi

  if [ -e "$deployment_manifest" ]; then
    deployment_state_error
    return 1
  fi
  if [ -f "$compatibility_revision_file" ] \
    && [ ! -L "$compatibility_revision_file" ]; then
    compatibility_revision=$(cat "$compatibility_revision_file") || return 1
    valid_deployment_revision "$compatibility_revision" \
      || deployment_state_error || return 1
    previous_revision=$compatibility_revision
    previous_compatibility_mode="legacy"
  elif [ -e "$compatibility_revision_file" ]; then
    deployment_state_error
    return 1
  fi
  load_immutable_deployment_state "$deployment_state_dir" || return 1
}

load_verified_deployment_image() {
  verified_state_dir=$1
  verified_revision=$2
  valid_deployment_revision "$verified_revision" || deployment_state_error || return 1
  verified_manifest="$verified_state_dir/verified-images/$verified_revision"
  [ -f "$verified_manifest" ] && [ ! -L "$verified_manifest" ] \
    || deployment_state_error || return 1
  verified_version=""
  verified_record_revision=""
  verified_record_image_id=""
  verified_extra=""
  IFS=' ' read -r verified_version verified_record_revision \
    verified_record_image_id verified_extra < "$verified_manifest" \
    || deployment_state_error || return 1
  verified_contents=$(cat "$verified_manifest") || return 1
  [ "$verified_contents" = \
    "$verified_version $verified_record_revision $verified_record_image_id" ] \
    || deployment_state_error || return 1
  [ "$verified_version" = "v1" ] || deployment_state_error || return 1
  [ "$verified_record_revision" = "$verified_revision" ] \
    || deployment_state_error || return 1
  valid_deployment_image_id "$verified_record_image_id" \
    || deployment_state_error || return 1
  [ -z "$verified_extra" ] || deployment_state_error || return 1
  printf '%s\n' "$verified_record_image_id"
}

load_immutable_deployment_state() {
  immutable_state_dir=$1
  current_image_file="$immutable_state_dir/current-image-id"
  high_water_file="$immutable_state_dir/deployment-high-water"

  if [ -z "$previous_revision" ]; then
    if [ -e "$current_image_file" ] || [ -e "$high_water_file" ]; then
      deployment_state_error
      return 1
    fi
    return 0
  fi

  if [ ! -e "$current_image_file" ] && [ ! -e "$high_water_file" ]; then
    # Compatibility with deployments committed before immutable image records.
    deployment_high_water_revision=$previous_revision
    return 0
  fi
  [ -f "$current_image_file" ] && [ ! -L "$current_image_file" ] \
    && [ -f "$high_water_file" ] && [ ! -L "$high_water_file" ] \
    || deployment_state_error || return 1
  previous_image_id=$(cat "$current_image_file") || return 1
  deployment_high_water_revision=$(cat "$high_water_file") || return 1
  valid_deployment_image_id "$previous_image_id" \
    || deployment_state_error || return 1
  valid_deployment_revision "$deployment_high_water_revision" \
    || deployment_state_error || return 1
  verified_current_image=$(load_verified_deployment_image \
    "$immutable_state_dir" "$previous_revision") || return 1
  [ "$verified_current_image" = "$previous_image_id" ] \
    || deployment_state_error || return 1
}

record_deployment_state() (
  deployment_state_dir=$1
  state_revision=$2
  state_mode=$3
  valid_deployment_revision "$state_revision" || deployment_state_error || exit 1
  deployment_compose_mode "$state_mode" >/dev/null || exit 1

  umask 077
  manifest_tmp=$(mktemp "$deployment_state_dir/.current-deployment.XXXXXX") || exit 1
  revision_tmp=$(mktemp "$deployment_state_dir/.current-revision.XXXXXX") || {
    rm -f "$manifest_tmp"
    exit 1
  }
  cleanup_deployment_state_tmp() {
    rm -f "$manifest_tmp" "$revision_tmp"
  }
  trap cleanup_deployment_state_tmp EXIT HUP INT TERM
  printf 'v1 %s %s\n' "$state_revision" "$state_mode" > "$manifest_tmp"
  printf '%s\n' "$state_revision" > "$revision_tmp"
  chmod 600 "$manifest_tmp" "$revision_tmp"

  # The combined manifest is the authoritative atomic revision/mode commit.
  # The revision-only marker remains for older operational tooling.
  mv -f "$manifest_tmp" "$deployment_state_dir/current-deployment"
  mv -f "$revision_tmp" "$deployment_state_dir/current-revision"
  trap - EXIT HUP INT TERM
)

record_verified_deployment_image() (
  verified_state_dir=$1
  verified_revision=$2
  verified_image_id=$3
  valid_deployment_revision "$verified_revision" || deployment_state_error || exit 1
  valid_deployment_image_id "$verified_image_id" || deployment_state_error || exit 1

  umask 077
  verified_directory="$verified_state_dir/verified-images"
  if [ -e "$verified_directory" ]; then
    [ -d "$verified_directory" ] && [ ! -L "$verified_directory" ] \
      || deployment_state_error || exit 1
  else
    mkdir "$verified_directory" || exit 1
  fi
  chmod 700 "$verified_directory" || exit 1
  verified_manifest="$verified_directory/$verified_revision"
  if [ -e "$verified_manifest" ]; then
    existing_image=$(load_verified_deployment_image \
      "$verified_state_dir" "$verified_revision") || exit 1
    [ "$existing_image" = "$verified_image_id" ] \
      || deployment_state_error || exit 1
    exit 0
  fi
  verified_tmp=$(mktemp "$verified_directory/.verified-image.XXXXXX") || exit 1
  cleanup_verified_tmp() {
    rm -f "$verified_tmp"
  }
  trap cleanup_verified_tmp EXIT HUP INT TERM
  printf 'v1 %s %s\n' "$verified_revision" "$verified_image_id" > "$verified_tmp"
  chmod 600 "$verified_tmp"
  # A hard-link publication is create-only. Concurrent or conflicting writers
  # cannot replace an existing immutable revision-to-image binding.
  ln "$verified_tmp" "$verified_manifest" || exit 1
  rm -f "$verified_tmp"
  trap - EXIT HUP INT TERM
)

record_immutable_deployment_state() (
  immutable_state_dir=$1
  state_revision=$2
  state_mode=$3
  state_image_id=$4
  high_water_revision=$5
  valid_deployment_revision "$state_revision" || deployment_state_error || exit 1
  deployment_compose_mode "$state_mode" >/dev/null || exit 1
  valid_deployment_image_id "$state_image_id" || deployment_state_error || exit 1
  valid_deployment_revision "$high_water_revision" || deployment_state_error || exit 1

  record_verified_deployment_image \
    "$immutable_state_dir" "$state_revision" "$state_image_id" || exit 1

  umask 077
  image_tmp=$(mktemp "$immutable_state_dir/.current-image-id.XXXXXX") || exit 1
  high_water_tmp=$(mktemp "$immutable_state_dir/.deployment-high-water.XXXXXX") || {
    rm -f "$image_tmp"
    exit 1
  }
  cleanup_immutable_state_tmp() {
    rm -f "$image_tmp" "$high_water_tmp"
  }
  trap cleanup_immutable_state_tmp EXIT HUP INT TERM
  printf '%s\n' "$state_image_id" > "$image_tmp"
  printf '%s\n' "$high_water_revision" > "$high_water_tmp"
  chmod 600 "$image_tmp" "$high_water_tmp"
  mv -f "$image_tmp" "$immutable_state_dir/current-image-id"
  mv -f "$high_water_tmp" "$immutable_state_dir/deployment-high-water"
  record_deployment_state "$immutable_state_dir" "$state_revision" "$state_mode" || exit 1
  trap - EXIT HUP INT TERM
)
