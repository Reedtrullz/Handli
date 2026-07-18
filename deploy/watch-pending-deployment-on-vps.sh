#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$script_dir/deployment-state.sh"

if [ "$#" -ne 6 ]; then
  exit 2
fi
candidate_revision=$1
candidate_image_id=$2
candidate_token=$3
previous_revision=$4
previous_image_id=$5
deadline=$6
resolver="$script_dir/resolve-pending-deployment-on-vps.sh"
acceptance_poll_seconds=2

valid_deployment_revision "$candidate_revision" \
  && valid_deployment_image_id "$candidate_image_id" \
  && valid_pending_deployment_token "$candidate_token" \
  && valid_deployment_revision "$previous_revision" \
  && valid_deployment_image_id "$previous_image_id" \
  && [ "$candidate_revision" != "$previous_revision" ] \
  && valid_pending_deployment_deadline "$deadline" || exit 2
test -x "$resolver" && test ! -L "$resolver" || exit 1
while :; do
  now=$(date +%s)
  valid_pending_deployment_deadline "$now" || exit 1
  [ "$deadline" -gt "$now" ] || break

  set +e
  "$resolver" retire "$candidate_revision" "$candidate_image_id" \
    "$candidate_token" "$previous_revision" "$previous_image_id" \
    "$deadline" 2>/dev/null
  retire_status=$?
  set -e
  case "$retire_status" in
    0) exit 0 ;;
    4|75) ;;
    *) break ;;
  esac

  remaining_seconds=$((deadline - now))
  sleep_seconds=$acceptance_poll_seconds
  if [ "$remaining_seconds" -lt "$sleep_seconds" ]; then
    sleep_seconds=$remaining_seconds
  fi
  sleep "$sleep_seconds"
done

# Only the exact durable accepted receipt retires this watchdog early. Any
# changed capability enters the fail-closed resolver immediately; an ordinary
# unresolved candidate does so at the deadline. The watchdog-specific action
# consumes only this process's exact lease before it exits.
exec "$resolver" watchdog-reject "$candidate_revision" "$candidate_image_id" \
  "$candidate_token" \
  "$previous_revision" "$previous_image_id" "$deadline"
