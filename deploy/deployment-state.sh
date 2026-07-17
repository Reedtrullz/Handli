#!/bin/sh

valid_deployment_revision() {
  candidate_revision=$1
  case "$candidate_revision" in
    ''|*[!0-9a-f]*) return 1 ;;
  esac
  [ "${#candidate_revision}" -eq 40 ]
}

valid_deployment_image_id() {
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
}

deployment_state_error() {
  echo "Invalid deployment state; refusing to select an automatic rollback mode" >&2
  return 1
}

acquire_deployment_operation_lock() {
  operation_state_dir=$1
  deployment_operation_lock="$operation_state_dir/.deployment-operation.lock"
  if ! mkdir "$deployment_operation_lock" 2>/dev/null; then
    echo "Another deploy or rollback operation may be active; refusing concurrent state change" >&2
    return 1
  fi
  chmod 700 "$deployment_operation_lock" || {
    rmdir "$deployment_operation_lock" 2>/dev/null || true
    return 1
  }
}

release_deployment_operation_lock() {
  if [ -n "${deployment_operation_lock:-}" ]; then
    rmdir "$deployment_operation_lock" || {
      echo "Could not release the deployment operation lock" >&2
      return 1
    }
    deployment_operation_lock=""
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
