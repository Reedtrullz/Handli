#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$script_dir/deployment-state.sh"

if [ "$#" -ne 7 ]; then
  echo "Usage: $0 <verify|accept|reject|retire|watchdog-reject> <candidate SHA> <candidate image ID> <candidate token> <previous SHA> <previous image ID> <pending deadline>" >&2
  exit 2
fi
action=$1
candidate_revision=$2
candidate_image_id=$3
candidate_token=$4
expected_previous_revision=$5
expected_previous_image_id=$6
expected_pending_deadline=$7
app_root=${HANDLEPLAN_APP_ROOT:-/opt/apps/handleplan}
state_dir="$app_root/state"
shared="$app_root/shared"
env_file="$shared/production.env"
operations_root="$app_root/operations"
operations_current="$operations_root/current"
compose_file="$operations_current/deploy/compose.production.yml"
maximum_reject_attempts=180
minimum_probe_window_seconds=120
maximum_pending_window_seconds=900
watchdog_owns_lease=0

case "$action" in
  verify|accept|reject|retire) ;;
  watchdog-reject) watchdog_owns_lease=1 ;;
  *)
    echo "Pending-deployment resolution action is invalid" >&2
    exit 2
    ;;
esac
valid_deployment_revision "$candidate_revision" \
  && valid_deployment_image_id "$candidate_image_id" \
  && valid_pending_deployment_token "$candidate_token" \
  && valid_deployment_revision "$expected_previous_revision" \
  && valid_deployment_image_id "$expected_previous_image_id" \
  && valid_pending_deployment_deadline "$expected_pending_deadline" \
  && [ "$candidate_revision" != "$expected_previous_revision" ] || {
  echo "Pending-deployment resolver arguments are invalid" >&2
  exit 2
}
test -d "$state_dir" && test ! -L "$state_dir" || {
  echo "Missing regular deployment state directory" >&2
  exit 1
}

pending_matches_expected() {
  load_pending_deployment_state "$state_dir" || return 1
  [ "$pending_deployment_revision" = "$candidate_revision" ] \
    && [ "$pending_deployment_image_id" = "$candidate_image_id" ] \
    && [ "$pending_deployment_token" = "$candidate_token" ] \
    && [ "$pending_previous_revision" = "$expected_previous_revision" ] \
    && [ "$pending_previous_image_id" = "$expected_previous_image_id" ] \
    && [ "$pending_deployment_deadline" = "$expected_pending_deadline" ]
}

accepted_matches_expected() {
  load_accepted_deployment_state "$state_dir" || return 1
  [ "$accepted_deployment_revision" = "$candidate_revision" ] \
    && [ "$accepted_deployment_image_id" = "$candidate_image_id" ] \
    && [ "$accepted_deployment_token" = "$candidate_token" ] \
    && [ "$accepted_previous_revision" = "$expected_previous_revision" ] \
    && [ "$accepted_previous_image_id" = "$expected_previous_image_id" ] \
    && [ "$accepted_deployment_deadline" = "$expected_pending_deadline" ]
}

pending_watchdog_matches_expected() {
  load_pending_watchdog_lease "$state_dir" "$candidate_token" || return 1
  [ "$pending_watchdog_revision" = "$candidate_revision" ] \
    && [ "$pending_watchdog_image_id" = "$candidate_image_id" ] \
    && [ "$pending_watchdog_token" = "$candidate_token" ] \
    && [ "$pending_watchdog_previous_revision" = \
      "$expected_previous_revision" ] \
    && [ "$pending_watchdog_previous_image_id" = \
      "$expected_previous_image_id" ] \
    && [ "$pending_watchdog_deadline" = "$expected_pending_deadline" ]
}

clear_expected_pending_watchdog_lease() {
  clear_pending_watchdog_lease \
    "$state_dir" "$candidate_revision" "$candidate_image_id" \
    "$expected_previous_revision" "$expected_previous_image_id" \
    "$expected_pending_deadline" "$candidate_token"
}

current_matches() {
  expected_current_revision=$1
  expected_current_image_id=$2
  load_deployment_state "$state_dir" || return 1
  [ "$previous_revision" = "$expected_current_revision" ] \
    && [ "$previous_compatibility_mode" = "current" ] \
    && [ "$previous_image_id" = "$expected_current_image_id" ]
}

install_lock_cleanup() {
  trap 'release_deployment_operation_lock || true' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

acquire_resolver_lock() {
  # EXIT ownership is installed before mkdir. Signals are ignored only across
  # mkdir plus the ownership publication performed by the lock helper, closing
  # the otherwise orphanable acquisition interval.
  install_lock_cleanup
  trap '' HUP INT TERM
  if ! acquire_deployment_operation_lock "$state_dir"; then
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    return 1
  fi
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

verify_pending_deployment() (
  acquire_resolver_lock || exit 1
  pending_matches_expected || {
    echo "Pending deployment does not match this deploy runner" >&2
    exit 1
  }
  pending_watchdog_matches_expected || {
    echo "Pending deployment does not own an exact watchdog lease" >&2
    exit 1
  }
  now=$(date +%s)
  valid_pending_deployment_deadline "$now" || {
    echo "Could not establish the pending-deployment verification clock" >&2
    exit 1
  }
  earliest_usable_deadline=$((now + minimum_probe_window_seconds))
  latest_valid_deadline=$((now + maximum_pending_window_seconds))
  [ "$pending_deployment_deadline" -ge "$earliest_usable_deadline" ] \
    && [ "$pending_deployment_deadline" -le "$latest_valid_deadline" ] || {
    echo "Pending deployment deadline is outside the bounded promotion window" >&2
    exit 1
  }
  current_matches "$candidate_revision" "$candidate_image_id" || {
    echo "Pending candidate is not the exact committed deployment" >&2
    exit 1
  }
  [ "$deployment_high_water_revision" = "$candidate_revision" ] || {
    echo "Pending candidate does not own the exact deployment high-water mark" >&2
    exit 1
  }
  release_deployment_operation_lock
  trap - EXIT HUP INT TERM
)

accept_pending_deployment() (
  acquire_resolver_lock || exit 1
  accepted_manifest="$state_dir/accepted-deployment"
  if [ -e "$accepted_manifest" ] || [ -L "$accepted_manifest" ]; then
    if accepted_matches_expected; then
      current_matches "$candidate_revision" "$candidate_image_id" \
        && [ "$deployment_high_water_revision" = "$candidate_revision" ] || {
        echo "Accepted deployment no longer matches committed state" >&2
        exit 1
      }
      pending_manifest="$state_dir/pending-deployment"
      if [ -e "$pending_manifest" ] || [ -L "$pending_manifest" ]; then
        pending_matches_expected || {
          echo "Accepted deployment has uncertain pending state" >&2
          exit 1
        }
        clear_pending_deployment_state \
          "$state_dir" "$candidate_revision" "$candidate_image_id" \
          "$expected_previous_revision" "$expected_previous_image_id" \
          "$expected_pending_deadline" "$candidate_token"
      fi
      release_deployment_operation_lock
      trap - EXIT HUP INT TERM
      exit 0
    fi
    load_accepted_deployment_state "$state_dir" || {
      echo "Accepted-deployment decision record is malformed" >&2
      exit 1
    }
  fi
  pending_matches_expected || {
    echo "Pending deployment does not match this deploy runner" >&2
    exit 1
  }
  pending_watchdog_matches_expected || {
    echo "Pending deployment does not own an exact watchdog lease" >&2
    exit 1
  }
  now=$(date +%s)
  valid_pending_deployment_deadline "$now" \
    && [ "$now" -le "$pending_deployment_deadline" ] || {
    echo "Pending deployment deadline elapsed before acceptance" >&2
    exit 1
  }
  current_matches "$candidate_revision" "$candidate_image_id" || {
    echo "Pending candidate is not the exact committed deployment" >&2
    exit 1
  }
  [ "$deployment_high_water_revision" = "$candidate_revision" ] || {
    echo "Pending candidate does not own the exact deployment high-water mark" >&2
    exit 1
  }
  # Publishing the accepted decision before consuming the pending capability
  # makes acceptance idempotent across runner/SSH loss. Rejection checks this
  # exact token-bound record under the same lock before touching runtimes.
  trap '' HUP INT TERM
  record_accepted_deployment_state \
    "$state_dir" "$candidate_revision" "$candidate_image_id" \
    "$expected_previous_revision" "$expected_previous_image_id" \
    "$pending_deployment_deadline" "$candidate_token"
  clear_pending_deployment_state \
    "$state_dir" "$candidate_revision" "$candidate_image_id" \
    "$expected_previous_revision" "$expected_previous_image_id" \
    "$expected_pending_deadline" "$candidate_token"
  release_deployment_operation_lock
  trap - EXIT HUP INT TERM
)

# Watchdogs poll this action while their candidate remains pending. Only the
# exact accepted receipt can retire the exact seven-field lease early. A
# missing, malformed, symlink-shaped, or different capability returns a hard
# failure so the watchdog enters fail-closed rejection instead.
retire_accepted_pending_watchdog() (
  acquire_resolver_lock || exit 75
  pending_watchdog_matches_expected || {
    echo "Pending watchdog lease does not match this resolver" >&2
    exit 1
  }
  accepted_manifest="$state_dir/accepted-deployment"
  if [ -e "$accepted_manifest" ] || [ -L "$accepted_manifest" ]; then
    if accepted_matches_expected; then
      pending_manifest="$state_dir/pending-deployment"
      if [ -e "$pending_manifest" ] || [ -L "$pending_manifest" ]; then
        pending_matches_expected \
          && current_matches "$candidate_revision" "$candidate_image_id" \
          && [ "$deployment_high_water_revision" = "$candidate_revision" ] || {
          echo "Accepted watchdog has uncertain pending state" >&2
          exit 1
        }
        trap '' HUP INT TERM
        clear_pending_deployment_state \
          "$state_dir" "$candidate_revision" "$candidate_image_id" \
          "$expected_previous_revision" "$expected_previous_image_id" \
          "$expected_pending_deadline" "$candidate_token"
      fi
      trap '' HUP INT TERM
      clear_expected_pending_watchdog_lease
      release_deployment_operation_lock
      trap - EXIT HUP INT TERM
      exit 0
    fi
    load_accepted_deployment_state "$state_dir" || {
      echo "Accepted-deployment decision record is malformed" >&2
      exit 1
    }
  fi
  if pending_matches_expected; then
    release_deployment_operation_lock
    trap - EXIT HUP INT TERM
    exit 4
  fi
  echo "Pending watchdog capability changed before acceptance" >&2
  exit 1
)

run_bounded() {
  timeout --foreground --kill-after=5s 60s "$@"
}

compose_for() {
  compose_revision=$1
  compose_image_id=$2
  shift 2
  APP_COMMIT_SHA="$compose_revision" HANDLEPLAN_IMAGE="$compose_image_id" \
    HANDLEPLAN_MIGRATION_IMAGE="$candidate_image_id" \
    run_bounded docker compose --env-file "$env_file" -f "$compose_file" "$@"
}

close_application_runtimes() {
  close_failed=0
  for close_service in review operations worker app; do
    close_containers=$(run_bounded docker ps -aq --no-trunc \
      --filter label=com.docker.compose.project=handleplan \
      --filter label=com.docker.compose.service="$close_service") \
      || close_failed=1
    for close_container in $close_containers; do
      case "$close_container" in
        *[!0-9a-f]*) close_failed=1; continue ;;
      esac
      [ "${#close_container}" -eq 64 ] || {
        close_failed=1
        continue
      }
      close_project=$(run_bounded docker inspect --format \
        '{{index .Config.Labels "com.docker.compose.project"}}' \
        "$close_container") || {
        close_failed=1
        continue
      }
      close_inspected_service=$(run_bounded docker inspect --format \
        '{{index .Config.Labels "com.docker.compose.service"}}' \
        "$close_container") || {
        close_failed=1
        continue
      }
      close_image=$(run_bounded docker inspect --format '{{.Image}}' \
        "$close_container") || {
        close_failed=1
        continue
      }
      close_revision=$(run_bounded docker inspect --format \
        '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
        "$close_container") || {
        close_failed=1
        continue
      }
      if [ "$close_project" != "handleplan" ] \
        || [ "$close_inspected_service" != "$close_service" ]; then
        close_failed=1
        continue
      fi
      if [ "$close_image" = "$candidate_image_id" ] \
        && [ "$close_revision" = "$candidate_revision" ]; then
        :
      elif [ "$close_image" = "$expected_previous_image_id" ] \
        && [ "$close_revision" = "$expected_previous_revision" ]; then
        :
      else
        close_failed=1
        continue
      fi
      run_bounded docker stop "$close_container" >/dev/null || close_failed=1
      run_bounded docker rm -f "$close_container" >/dev/null || close_failed=1
    done
    remaining_containers=$(run_bounded docker ps -aq --no-trunc \
      --filter label=com.docker.compose.project=handleplan \
      --filter label=com.docker.compose.service="$close_service") \
      || close_failed=1
    [ -z "${remaining_containers:-}" ] || close_failed=1
  done
  [ "$close_failed" -eq 0 ] || {
    echo "Pending rejection could not prove all candidate application runtimes absent" >&2
    return 1
  }
}

remove_uncommitted_candidate_runtimes() {
  uncommitted_cleanup_failed=0
  for uncommitted_service in review operations worker app; do
    uncommitted_containers=$(run_bounded docker ps -aq --no-trunc \
      --filter label=com.docker.compose.project=handleplan \
      --filter label=com.docker.compose.service="$uncommitted_service") \
      || uncommitted_cleanup_failed=1
    for uncommitted_container in $uncommitted_containers; do
      case "$uncommitted_container" in
        *[!0-9a-f]*) uncommitted_cleanup_failed=1; continue ;;
      esac
      [ "${#uncommitted_container}" -eq 64 ] || {
        uncommitted_cleanup_failed=1
        continue
      }
      uncommitted_project=$(run_bounded docker inspect --format \
        '{{index .Config.Labels "com.docker.compose.project"}}' \
        "$uncommitted_container") || {
        uncommitted_cleanup_failed=1
        continue
      }
      uncommitted_inspected_service=$(run_bounded docker inspect --format \
        '{{index .Config.Labels "com.docker.compose.service"}}' \
        "$uncommitted_container") || {
        uncommitted_cleanup_failed=1
        continue
      }
      uncommitted_image=$(run_bounded docker inspect --format '{{.Image}}' \
        "$uncommitted_container") || {
        uncommitted_cleanup_failed=1
        continue
      }
      uncommitted_revision=$(run_bounded docker inspect --format \
        '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
        "$uncommitted_container") || {
        uncommitted_cleanup_failed=1
        continue
      }
      if [ "$uncommitted_project" != "handleplan" ] \
        || [ "$uncommitted_inspected_service" != "$uncommitted_service" ]; then
        uncommitted_cleanup_failed=1
        continue
      fi
      if [ "$uncommitted_image" = "$candidate_image_id" ] \
        && [ "$uncommitted_revision" = "$candidate_revision" ]; then
        run_bounded docker stop "$uncommitted_container" >/dev/null \
          || uncommitted_cleanup_failed=1
        run_bounded docker rm -f "$uncommitted_container" >/dev/null \
          || uncommitted_cleanup_failed=1
      elif [ "$uncommitted_image" = "$expected_previous_image_id" ] \
        && [ "$uncommitted_revision" = "$expected_previous_revision" ]; then
        :
      else
        uncommitted_cleanup_failed=1
      fi
    done

    remaining_uncommitted=$(run_bounded docker ps -aq --no-trunc \
      --filter label=com.docker.compose.project=handleplan \
      --filter label=com.docker.compose.service="$uncommitted_service") \
      || uncommitted_cleanup_failed=1
    for remaining_container in $remaining_uncommitted; do
      remaining_image=$(run_bounded docker inspect --format '{{.Image}}' \
        "$remaining_container") || {
        uncommitted_cleanup_failed=1
        continue
      }
      remaining_revision=$(run_bounded docker inspect --format \
        '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
        "$remaining_container") || {
        uncommitted_cleanup_failed=1
        continue
      }
      [ "$remaining_image" = "$expected_previous_image_id" ] \
        && [ "$remaining_revision" = "$expected_previous_revision" ] \
        || uncommitted_cleanup_failed=1
    done
  done
  [ "$uncommitted_cleanup_failed" -eq 0 ] || {
    echo "Could not prove every uncommitted candidate runtime absent" >&2
    return 1
  }
}

verify_image_binding() {
  binding_revision=$1
  binding_image_id=$2
  inspected_image_id=$(run_bounded docker image inspect --format '{{.Id}}' \
    "$binding_image_id") || return 1
  inspected_revision=$(run_bounded docker image inspect --format \
    '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
    "$binding_image_id") || return 1
  [ "$inspected_image_id" = "$binding_image_id" ] \
    && [ "$inspected_revision" = "$binding_revision" ]
}

verify_runtime_container() {
  verify_service=$1
  container=$(compose_for "$expected_previous_revision" \
    "$expected_previous_image_id" ps -q "$verify_service") || return 1
  [ "${#container}" -eq 64 ] || return 1
  state=$(run_bounded docker inspect --format '{{.State.Status}}' "$container") \
    || return 1
  restarts=$(run_bounded docker inspect --format '{{.RestartCount}}' "$container") \
    || return 1
  health=$(run_bounded docker inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
    "$container") || return 1
  runtime_image=$(run_bounded docker inspect --format '{{.Image}}' "$container") \
    || return 1
  revision_label=$(run_bounded docker inspect \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
    "$container") || return 1
  [ "$state" = "running" ] && [ "$restarts" = "0" ] \
    && [ "$health" = "healthy" ] \
    && [ "$runtime_image" = "$expected_previous_image_id" ] \
    && [ "$revision_label" = "$expected_previous_revision" ]
}

verify_predecessor_runtimes() {
  rollback_health=$(curl --fail --silent --show-error --max-time 15 \
    http://127.0.0.1:3004/api/health) || return 1
  printf '%s' "$rollback_health" \
    | grep -F "\"commit\":\"$expected_previous_revision\"" >/dev/null \
    || return 1
  for verify_service in app review operations worker; do
    verify_runtime_container "$verify_service" || return 1
  done
  rollback_worker_health=$(compose_for "$expected_previous_revision" \
    "$expected_previous_image_id" exec -T worker \
    wget -qO- http://127.0.0.1:3005/health) || return 1
  printf '%s' "$rollback_worker_health" \
    | grep -F "\"revision\":\"$expected_previous_revision\"" >/dev/null \
    && printf '%s' "$rollback_worker_health" \
      | grep -F '"ready":true' >/dev/null
}

reject_pending_deployment() (
  set -e
  rejection_cleanup_armed=0
  uncommitted_cleanup_armed=0
  rejection_committed=0
  cleanup_rejection() {
    rejection_status=$?
    trap - EXIT
    trap '' HUP INT TERM
    if [ "$uncommitted_cleanup_armed" -eq 1 ]; then
      remove_uncommitted_candidate_runtimes || rejection_status=1
    elif [ "$rejection_cleanup_armed" -eq 1 ] \
      && [ "$rejection_committed" -ne 1 ]; then
      close_application_runtimes || rejection_status=1
    fi
    if [ "$watchdog_owns_lease" -eq 1 ] \
      && [ "${deployment_operation_lock_owned:-0}" -eq 1 ]; then
      clear_expected_pending_watchdog_lease || rejection_status=1
    fi
    release_deployment_operation_lock || rejection_status=1
    exit "$rejection_status"
  }
  trap cleanup_rejection EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap '' HUP INT TERM
  if ! acquire_deployment_operation_lock "$state_dir" 2>/dev/null; then
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    exit 75
  fi
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  close_after_capability_loss() {
    capability_loss_message=$1
    # Publish cleanup ownership without a catchable interruption gap. Missing
    # or malformed capability state never authorizes predecessor rollback; it
    # only authorizes closing the exact expected candidate, or removing an
    # uncommitted candidate while preserving an exact predecessor runtime.
    trap '' HUP INT TERM
    if current_matches "$expected_previous_revision" "$expected_previous_image_id"; then
      uncommitted_cleanup_armed=1
    elif current_matches "$candidate_revision" "$candidate_image_id"; then
      # A newer accepted deployment may have replaced this candidate's single
      # accepted receipt before an operator explicitly rolls back to it. The
      # old detached watchdog must not mistake that authorized rollback target
      # for its once-pending candidate. Only the candidate's own high-water
      # mark proves that capability-loss cleanup still belongs to this tuple.
      if [ "$deployment_high_water_revision" != "$candidate_revision" ]; then
        trap 'exit 129' HUP
        trap 'exit 130' INT
        trap 'exit 143' TERM
        echo "Pending capability was lost after candidate ceased owning the deployment high-water mark" >&2
        exit 1
      fi
      rejection_cleanup_armed=1
    else
      trap 'exit 129' HUP
      trap 'exit 130' INT
      trap 'exit 143' TERM
      echo "Pending capability was lost after committed state changed" >&2
      exit 1
    fi
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    command -v timeout >/dev/null 2>&1 || {
      echo "Pending capability-loss cleanup requires the bounded timeout control" >&2
      exit 1
    }
    if [ "$uncommitted_cleanup_armed" -eq 1 ]; then
      remove_uncommitted_candidate_runtimes
      uncommitted_cleanup_armed=0
    else
      close_application_runtimes
      rejection_cleanup_armed=0
    fi
    if [ "$watchdog_owns_lease" -eq 1 ]; then
      clear_expected_pending_watchdog_lease
    fi
    release_deployment_operation_lock
    trap - EXIT HUP INT TERM
    echo "$capability_loss_message" >&2
    exit 1
  }

  accepted_manifest="$state_dir/accepted-deployment"
  if [ -e "$accepted_manifest" ] || [ -L "$accepted_manifest" ]; then
    if accepted_matches_expected; then
      current_matches "$candidate_revision" "$candidate_image_id" \
        && [ "$deployment_high_water_revision" = "$candidate_revision" ] || {
        echo "Accepted deployment no longer matches committed state" >&2
        exit 1
      }
      pending_manifest="$state_dir/pending-deployment"
      if [ -e "$pending_manifest" ] || [ -L "$pending_manifest" ]; then
        pending_matches_expected || {
          echo "Accepted deployment has uncertain pending state" >&2
          exit 1
        }
        trap '' HUP INT TERM
        clear_pending_deployment_state \
          "$state_dir" "$candidate_revision" "$candidate_image_id" \
          "$expected_previous_revision" "$expected_previous_image_id" \
          "$expected_pending_deadline" "$candidate_token"
      fi
      if [ "$watchdog_owns_lease" -eq 1 ]; then
        clear_expected_pending_watchdog_lease
      fi
      release_deployment_operation_lock
      trap - EXIT HUP INT TERM
      exit 3
    fi
    load_accepted_deployment_state "$state_dir" \
      || close_after_capability_loss \
        "Accepted-deployment decision record is malformed; application runtimes were closed"
  fi

  pending_manifest="$state_dir/pending-deployment"
  if [ ! -e "$pending_manifest" ] && [ ! -L "$pending_manifest" ]; then
    close_after_capability_loss \
      "No pending deployment capability existed; application runtimes were closed without rollback"
  fi
  # The current-state CAS result and closed-cleanup ownership are published as
  # one catchable-signal-free transition. Otherwise TERM in between could leave
  # an exact rejected candidate online with cleanup still disarmed.
  trap '' HUP INT TERM
  if ! pending_matches_expected; then
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    if load_pending_deployment_state "$state_dir"; then
      echo "Refusing to reject a different pending deployment" >&2
      exit 1
    fi
    close_after_capability_loss \
      "Pending deployment capability is malformed; application runtimes were closed without rollback"
  fi
  if current_matches "$expected_previous_revision" "$expected_previous_image_id"; then
    rejection_high_water_revision=$deployment_high_water_revision
    rejection_cleanup_armed=1
    case "$rejection_high_water_revision" in
      "$expected_previous_revision"|"$candidate_revision") ;;
      *)
        echo "Pending predecessor state has an unrelated deployment high-water mark" >&2
        exit 1
        ;;
    esac
  elif current_matches "$candidate_revision" "$candidate_image_id"; then
    rejection_high_water_revision=$deployment_high_water_revision
    rejection_cleanup_armed=1
    [ "$rejection_high_water_revision" = "$candidate_revision" ] || {
      echo "Pending candidate does not own the exact deployment high-water mark" >&2
      exit 1
    }
  else
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    echo "Refusing to reject pending deployment after committed state changed" >&2
    exit 1
  fi
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  # From this point every failure is fail-closed. The pending record, current
  # state, and token were all revalidated while holding the same lock used for
  # acceptance, so an accept/reject race cannot roll back an accepted image.
  command -v timeout >/dev/null 2>&1 || {
    echo "Pending rejection requires the bounded timeout control" >&2
    exit 1
  }

  test -f "$env_file" && test ! -L "$env_file" || {
    echo "Missing regular protected production environment" >&2
    exit 1
  }
  test -L "$operations_current" \
    && [ "$(readlink "$operations_current")" = "releases/$candidate_revision" ] \
    && test -f "$compose_file" && test ! -L "$compose_file" || {
    echo "Pending candidate operations release is not exact" >&2
    exit 1
  }
  operations_current_physical=$(CDPATH= cd -- "$operations_current" && pwd -P) \
    || exit 1
  [ "$operations_current_physical" = \
    "$operations_root/releases/$candidate_revision" ] || {
    echo "Pending candidate operations release path is not canonical" >&2
    exit 1
  }
  target_image_id=$(load_verified_deployment_image \
    "$state_dir" "$expected_previous_revision")
  [ "$target_image_id" = "$expected_previous_image_id" ] || {
    echo "Pending predecessor immutable image binding changed" >&2
    exit 1
  }
  verify_image_binding "$candidate_revision" "$candidate_image_id" \
    && verify_image_binding "$expected_previous_revision" \
      "$expected_previous_image_id" || {
    echo "Pending rollback image binding is no longer exact" >&2
    exit 1
  }
  compose_for "$expected_previous_revision" "$expected_previous_image_id" \
    config >/dev/null

  close_application_runtimes
  compose_for "$expected_previous_revision" "$expected_previous_image_id" \
    up -d --wait --remove-orphans --no-deps app review operations worker
  verify_predecessor_runtimes || {
    echo "Pending predecessor failed exact runtime readback" >&2
    exit 1
  }

  # Commit predecessor state and consume the exact pending capability as one
  # signal-free critical section. A hard kill between the two leaves a pending
  # predecessor which the next reject safely clears without touching runtimes.
  trap '' HUP INT TERM
  record_immutable_deployment_state "$state_dir" \
    "$expected_previous_revision" current "$expected_previous_image_id" \
    "$rejection_high_water_revision"
  clear_pending_deployment_state \
    "$state_dir" "$candidate_revision" "$candidate_image_id" \
    "$expected_previous_revision" "$expected_previous_image_id" \
    "$expected_pending_deadline" "$candidate_token"
  if [ "$watchdog_owns_lease" -eq 1 ]; then
    clear_expected_pending_watchdog_lease
  fi
  rejection_committed=1
  release_deployment_operation_lock
  trap - EXIT HUP INT TERM
)

if [ "$action" = "verify" ]; then
  verify_pending_deployment
  printf 'pending-deployment=%s verified\n' "$candidate_revision"
  exit 0
fi

if [ "$action" = "accept" ]; then
  accept_pending_deployment
  printf 'pending-deployment=%s accepted\n' "$candidate_revision"
  exit 0
fi

if [ "$action" = "retire" ]; then
  set +e
  retire_accepted_pending_watchdog
  retire_status=$?
  set -e
  if [ "$retire_status" -eq 0 ]; then
    printf 'pending-watchdog=%s retired\n' "$candidate_revision"
    exit 0
  fi
  exit "$retire_status"
fi

attempt=0
while [ "$attempt" -lt "$maximum_reject_attempts" ]; do
  set +e
  # Runtime tooling may write ordinary progress to stdout. Keep the resolver's
  # stdout as one machine-readable outcome line for the workflow CAS branch.
  reject_pending_deployment >&2
  reject_status=$?
  set -e
  if [ "$reject_status" -eq 0 ]; then
    printf 'pending-deployment=%s rejected\n' "$candidate_revision"
    exit 0
  fi
  if [ "$reject_status" -eq 3 ]; then
    printf 'pending-deployment=%s already-accepted\n' "$candidate_revision"
    exit 0
  fi
  if [ "$reject_status" -ne 75 ]; then
    exit "$reject_status"
  fi
  attempt=$((attempt + 1))
  sleep 2
done

echo "Timed out while rejecting the exact pending deployment" >&2
exit 1
