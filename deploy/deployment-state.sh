#!/bin/sh

valid_deployment_revision() {
  candidate_revision=$1
  case "$candidate_revision" in
    ''|*[!0-9a-f]*) return 1 ;;
  esac
  [ "${#candidate_revision}" -eq 40 ]
}

deployment_state_error() {
  echo "Invalid deployment state; refusing to select an automatic rollback mode" >&2
  return 1
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

  if [ -f "$deployment_manifest" ]; then
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
    [ -f "$compatibility_revision_file" ] || deployment_state_error || return 1
    compatibility_revision=$(cat "$compatibility_revision_file") || return 1
    valid_deployment_revision "$compatibility_revision" \
      || deployment_state_error || return 1
    [ "$compatibility_revision" = "$state_revision" ] \
      || deployment_state_error || return 1
    previous_revision=$state_revision
    previous_compatibility_mode=$state_mode
    return 0
  fi

  if [ -e "$deployment_manifest" ]; then
    deployment_state_error
    return 1
  fi
  if [ -f "$compatibility_revision_file" ]; then
    compatibility_revision=$(cat "$compatibility_revision_file") || return 1
    valid_deployment_revision "$compatibility_revision" \
      || deployment_state_error || return 1
    previous_revision=$compatibility_revision
    previous_compatibility_mode="legacy"
  elif [ -e "$compatibility_revision_file" ]; then
    deployment_state_error
    return 1
  fi
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
