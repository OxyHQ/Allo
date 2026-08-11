#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_directory="$(mktemp -d)"
temporary_root="$(realpath "${TMPDIR:-/tmp}")"
test_directory="$(realpath "$test_directory")"

cleanup_test_directory() {
  if [[ "$test_directory" == "$temporary_root/"* &&
        -d "$test_directory" ]]; then
    rm -rf -- "$test_directory"
  else
    echo "Refusing to remove unexpected test directory: $test_directory" >&2
  fi
}
trap cleanup_test_directory EXIT

export DEPLOY_TEST_LOG=""
export DEPLOY_TEST_EXPECT_METRICS_ARN=false
# The SSM parameter path a case feeds to INTERNAL_METRICS_PARAMETER, and from
# which the mocked register-task-definition derives the ARN it demands. A case
# overrides it to cover a path shape the default does not.
export DEPLOY_TEST_METRICS_PARAMETER=/oxy/sampleapp/INTERNAL_METRICS_TOKEN
export DEPLOY_TEST_TASK_EXIT_CODE=0
export DEPLOY_TEST_EXPECT_TASK_SECRET_ARN=false
export DEPLOY_TEST_SERVICE_DESIRED_COUNT=1
export DEPLOY_TEST_ROLLOUT_SCENARIO=healthy

aws() {
  local service_json='{
    "failures": [],
    "services": [{
      "status": "ACTIVE",
      "taskDefinition": "arn:aws:ecs:test:task-definition/deploy-test:1",
      "desiredCount": 1,
      "networkConfiguration": {
        "awsvpcConfiguration": {
          "subnets": ["subnet-test"],
          "securityGroups": ["sg-test"]
        }
      },
      "launchType": "FARGATE",
      "deployments": [
        {
          "taskDefinition": "arn:aws:ecs:test:task-definition/deploy-test:2",
          "status": "PRIMARY",
          "rolloutState": "COMPLETED",
          "runningCount": 1,
          "desiredCount": 1
        },
        {
          "taskDefinition": "arn:aws:ecs:test:task-definition/deploy-test:1",
          "status": "PRIMARY",
          "rolloutState": "COMPLETED",
          "runningCount": 1,
          "desiredCount": 1
        }
      ]
    }]
  }'
  service_json="$(jq \
    --argjson desired "$DEPLOY_TEST_SERVICE_DESIRED_COUNT" \
    '.services[0].desiredCount = $desired' \
    <<<"$service_json")"

  case "$1 $2" in
    "ecs describe-services")
      local describe_count_file="${DEPLOY_TEST_LOG}.describe-count"
      local describe_count=0
      if [[ -f "$describe_count_file" ]]; then
        describe_count="$(<"$describe_count_file")"
      fi
      describe_count=$((describe_count + 1))
      printf '%s\n' "$describe_count" >"$describe_count_file"
      if [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "transient-zero-deployment" &&
            "$describe_count" == "2" ]]; then
        service_json="$(jq '
          .services[0].deployments |= map(
              if .taskDefinition == "arn:aws:ecs:test:task-definition/deploy-test:2"
              then
                .rolloutState = "IN_PROGRESS"
                | .desiredCount = 0
                | .runningCount = 0
              else .
              end
            )
        ' <<<"$service_json")"
      elif [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "zero-service-during-deploy" &&
              "$describe_count" == "2" ]]; then
        service_json="$(jq '
          .services[0].desiredCount = 0
          | .services[0].deployments |= map(
              if .taskDefinition == "arn:aws:ecs:test:task-definition/deploy-test:2"
              then .desiredCount = 0 | .runningCount = 0
              else .
              end
            )
        ' <<<"$service_json")"
      elif [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "completed-zero-deployment" &&
              "$describe_count" == "2" ]]; then
        service_json="$(jq '
          .services[0].deployments |= map(
              if .taskDefinition == "arn:aws:ecs:test:task-definition/deploy-test:2"
              then .desiredCount = 0 | .runningCount = 0
              else .
              end
            )
        ' <<<"$service_json")"
      fi
      printf '%s\n' "$service_json"
      ;;
    "ecs describe-task-definition")
      printf '%s\n' '{
        "family": "deploy-test",
        "networkMode": "awsvpc",
        "requiresCompatibilities": ["FARGATE"],
        "cpu": "256",
        "memory": "512",
        "containerDefinitions": [{
          "name": "deploy-test",
          "image": "example.invalid/deploy-test:old",
          "essential": true,
          "logConfiguration": {
            "logDriver": "awslogs",
            "options": {
              "awslogs-group": "/ecs/deploy-test",
              "awslogs-stream-prefix": "ecs"
            }
          }
        }]
      }'
      ;;
    "ecs register-task-definition")
      if [[ "$DEPLOY_TEST_EXPECT_METRICS_ARN" == "true" ]]; then
        local previous_argument=""
        local input_json=""
        local argument
        for argument in "$@"; do
          if [[ "$previous_argument" == "--cli-input-json" ]]; then
            input_json="${argument#file://}"
            break
          fi
          previous_argument="$argument"
        done
        # The verdict is written to the log rather than left to `set -e`. A
        # command that fails in the MIDDLE of this function does not abort the
        # run -- measured, and it holds whether the function is exported or
        # local -- because the caller consumes it as `v="$(aws ...)"` and only
        # the function's LAST command reaches that assignment's exit status. An
        # assertion whose only effect is its own exit status therefore cannot
        # fail, which is what this one did: pointing it at an ARN no case uses
        # left the suite green. Logging a distinct token instead puts the
        # mismatch in the expected.log diff, where it names itself.
        if jq -e \
          --arg expected \
          "arn:aws:ssm:test:123456789012:parameter${DEPLOY_TEST_METRICS_PARAMETER}" \
          '
          .containerDefinitions[]
          | select(.name == "deploy-test")
          | .secrets[]
          | select(
              .name == "INTERNAL_METRICS_TOKEN" and
              .valueFrom == $expected
            )
        ' "$input_json" >/dev/null; then
          printf 'metrics:arn\n' >>"$DEPLOY_TEST_LOG"
        else
          printf 'metrics:arn:MISMATCH\n' >>"$DEPLOY_TEST_LOG"
        fi
      fi
      if [[ "$DEPLOY_TEST_EXPECT_TASK_SECRET_ARN" == "true" ]]; then
        local previous_argument=""
        local input_json=""
        local argument
        for argument in "$@"; do
          if [[ "$previous_argument" == "--cli-input-json" ]]; then
            input_json="${argument#file://}"
            break
          fi
          previous_argument="$argument"
        done
        # Same reason as the metrics assertion above: log the verdict, do not
        # rely on this function's exit status.
        if jq -e '
          .containerDefinitions[]
          | select(.name == "deploy-test")
          | .secrets[]
          | select(
              .name == "EXTRA_TASK_SECRET" and
              .valueFrom == "arn:aws:ssm:test:123456789012:parameter/oxy/sample-app/EXTRA_TASK_SECRET"
            )
        ' "$input_json" >/dev/null; then
          printf 'task-secret:arn\n' >>"$DEPLOY_TEST_LOG"
        else
          printf 'task-secret:arn:MISMATCH\n' >>"$DEPLOY_TEST_LOG"
        fi
      fi
      printf '%s\n' "arn:aws:ecs:test:task-definition/deploy-test:2"
      ;;
    "ecs update-service")
      local previous_argument=""
      local task_definition=""
      local desired_count=""
      local argument
      for argument in "$@"; do
        if [[ "$previous_argument" == "--task-definition" ]]; then
          task_definition="$argument"
        elif [[ "$previous_argument" == "--desired-count" ]]; then
          desired_count="$argument"
        fi
        previous_argument="$argument"
      done
      if [[ -z "$desired_count" ]]; then
        echo "Mocked update-service requires an explicit --desired-count." >&2
        return 1
      fi
      printf 'service:%s:desired=%s\n' \
        "$task_definition" \
        "$desired_count" \
        >>"$DEPLOY_TEST_LOG"
      printf '{}\n'
      ;;
    "ecs run-task")
      # The ordering log keeps its opaque marker, so every existing expected.log
      # still diffs cleanly — what a one-shot RAN was not observable before, and
      # a test asserting on the command had nothing to read.
      printf 'reconcile\n' >>"$DEPLOY_TEST_LOG"
      # The command itself goes to a sidecar file. Extracted from `--overrides`
      # rather than from an environment variable, so the assertion is about what
      # would reach ECS.
      local overrides_json="" previous_override_argument="" override_argument
      for override_argument in "$@"; do
        if [[ "$previous_override_argument" == "--overrides" ]]; then
          overrides_json="$override_argument"
        fi
        previous_override_argument="$override_argument"
      done
      if [[ -n "$overrides_json" ]]; then
        jq -r '[.containerOverrides[0].command // [] | .[]] | join(" ")' \
          <<<"$overrides_json" >>"${DEPLOY_TEST_LOG}.commands" 2>/dev/null || true
      fi
      printf '%s\n' '{
        "failures": [],
        "tasks": [{"taskArn": "arn:aws:ecs:test:task/deploy-test-reconcile"}]
      }'
      ;;
    "ecs describe-tasks")
      printf '{
        "failures": [],
        "tasks": [{
          "lastStatus": "STOPPED",
          "stoppedReason": "Essential container exited",
          "containers": [{
            "name": "deploy-test",
            "exitCode": %s
          }]
        }]
      }\n' "$DEPLOY_TEST_TASK_EXIT_CODE"
      ;;
    "logs get-log-events")
      printf 'tasklogs\n' >>"$DEPLOY_TEST_LOG"
      printf '%s\n' '{
        "events": [{
          "message": "[migration] fixture failure"
        }]
      }'
      ;;
    *)
      printf 'Unexpected mocked AWS call: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
export -f aws

# Vacuity floor. On success this suite prints ONE line, so a traversal that
# silently stopped after two cases is indistinguishable from a full green run --
# and every guarantee below would read as verified while never having executed.
# A `set -e` abort mid-file exits non-zero, but an early `return` from a helper,
# a case list truncated by a bad merge, or a rewrite that drops cases does not.
#
# Raise this with the case count; lower it ONLY alongside a deletion you can
# name. A floor quietly adjusted to match whatever ran is not a floor.
cases_run=0
MINIMUM_CASES=13

run_release() {
  cases_run=$((cases_run + 1))
  local case_name="$1"
  local expect_success="$2"
  local run_migrations="${3:-false}"
  local inject_internal_metrics="${4:-false}"
  local task_exit_code="${5:-0}"
  local inject_task_secret="${6:-false}"
  local service_desired_count="${7:-1}"
  local rollout_scenario="${8:-healthy}"
  local smoke_exit_code="${9:-0}"
  local case_directory="$test_directory/$case_name"
  local output_file="$case_directory/output.log"
  local smoke_script="$case_directory/smoke.sh"

  mkdir -p "$case_directory"
  DEPLOY_TEST_LOG="$case_directory/aws.log"
  DEPLOY_TEST_EXPECT_METRICS_ARN="$inject_internal_metrics"
  DEPLOY_TEST_TASK_EXIT_CODE="$task_exit_code"
  DEPLOY_TEST_EXPECT_TASK_SECRET_ARN="$inject_task_secret"
  DEPLOY_TEST_SERVICE_DESIRED_COUNT="$service_desired_count"
  DEPLOY_TEST_ROLLOUT_SCENARIO="$rollout_scenario"
  export DEPLOY_TEST_LOG DEPLOY_TEST_EXPECT_METRICS_ARN
  export DEPLOY_TEST_TASK_EXIT_CODE
  export DEPLOY_TEST_EXPECT_TASK_SECRET_ARN
  export DEPLOY_TEST_SERVICE_DESIRED_COUNT
  export DEPLOY_TEST_ROLLOUT_SCENARIO

  # The generated smoke fixture expands DEPLOY_TEST_LOG when it runs; its exit
  # code is the entire interface deploy-ecs-image.sh reads, so each case picks
  # one. 75 is the "failed, but a rollback cannot repair it" code.
  # shellcheck disable=SC2016
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "smoke\n" >>"$DEPLOY_TEST_LOG"' \
    "exit $smoke_exit_code" \
    >"$smoke_script"

  local -a release_environment=(
    AWS_REGION=test
    AWS_ACCOUNT_ID=123456789012
    CLUSTER=deploy-test
    APP=deploy-test
    CONTAINER_NAME=deploy-test
    IMAGE_URI="example.invalid/deploy-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    MAX_WAIT_SECS=5
    POLL_INTERVAL=1
    RUN_MIGRATIONS="$run_migrations"
    MIGRATION_TASK_COMMAND_JSON='["migrate","--phase=pre"]'
    POST_DEPLOY_SMOKE_SCRIPT="$smoke_script"
    POST_DEPLOY_TASK_COMMAND_JSON='["reconcile"]'
  )
  if [[ "$inject_internal_metrics" == "true" ]]; then
    release_environment+=(
      INTERNAL_METRICS_PARAMETER="$DEPLOY_TEST_METRICS_PARAMETER"
    )
  fi
  if [[ "$inject_task_secret" == "true" ]]; then
    release_environment+=(
      TASK_SECRET_OVERRIDES_JSON='{"EXTRA_TASK_SECRET":"arn:aws:ssm:test:123456789012:parameter/oxy/sample-app/EXTRA_TASK_SECRET"}'
    )
  fi

  if env "${release_environment[@]}" \
    bash "$repository_root/.github/scripts/deploy-ecs-image.sh" \
    >"$output_file" 2>&1; then
    if [[ "$expect_success" != "true" ]]; then
      echo "Expected $case_name to fail." >&2
      return 1
    fi
  elif [[ "$expect_success" == "true" ]]; then
    echo "Expected $case_name to succeed." >&2
    sed -n '1,240p' "$output_file" >&2
    return 1
  fi
}

run_release success true false true
printf '%s\n' \
  metrics:arn \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/success/expected.log"
diff -u \
  "$test_directory/success/expected.log" \
  "$test_directory/success/aws.log"

# A hyphen in the parameter path is its own case because it is its own bug: the
# bracket expression validating this name once matched every character EXCEPT a
# hyphen, so an app whose path had none deployed and an app whose path had one
# did not -- and the only repo with a smoke fixture at the time was one of the
# former, which is why nothing here caught it.
#
# KEEP BOTH, and keep the plain one's app segment hyphen-FREE. That asymmetry is
# the entire test: rename them to two spellings that both contain a hyphen and
# this pair silently stops discriminating, while the suite still passes and still
# goes red under a mutation -- just for the wrong case.
DEPLOY_TEST_METRICS_PARAMETER=/oxy/sample-app/INTERNAL_METRICS_TOKEN
run_release hyphenated-metrics-parameter true false true
DEPLOY_TEST_METRICS_PARAMETER=/oxy/sampleapp/INTERNAL_METRICS_TOKEN
printf '%s\n' \
  metrics:arn \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/hyphenated-metrics-parameter/expected.log"
diff -u \
  "$test_directory/hyphenated-metrics-parameter/expected.log" \
  "$test_directory/hyphenated-metrics-parameter/aws.log"

run_release explicit-task-secret true false false 0 true
printf '%s\n' \
  task-secret:arn \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/explicit-task-secret/expected.log"
diff -u \
  "$test_directory/explicit-task-secret/expected.log" \
  "$test_directory/explicit-task-secret/aws.log"

run_release reconciliation-failure false false false 1
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  reconcile \
  tasklogs \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1' \
  >"$test_directory/reconciliation-failure/expected.log"
diff -u \
  "$test_directory/reconciliation-failure/expected.log" \
  "$test_directory/reconciliation-failure/aws.log"

run_release migration-failure false true false 1
printf '%s\n' \
  reconcile \
  tasklogs \
  >"$test_directory/migration-failure/expected.log"
diff -u \
  "$test_directory/migration-failure/expected.log" \
  "$test_directory/migration-failure/aws.log"
grep -F \
  "[migration] fixture failure" \
  "$test_directory/migration-failure/output.log" \
  >/dev/null
if grep -q '^service:' "$test_directory/migration-failure/aws.log"; then
  echo "Failed migration reached update-service." >&2
  exit 1
fi

# A service parked at desiredCount 0 -- the state a store cutover leaves it in --
# must still land its image, because the release that would make the service
# bootable again is the one a refusal blocks.
#
# The exact log is the whole assertion, and what it does NOT contain matters more
# than what it does. The first `reconcile` is the migration one-shot; compare
# `reconciliation-failure` above, the same release at desired=1, where `service:`
# is followed by `smoke` and a SECOND `reconcile` for the post-deploy task. Here
# `smoke` must be ABSENT and the second `reconcile` PRESENT.
#
# THE ASYMMETRY, because an earlier version of this case got it wrong: it
# asserted the log STOPS at `service:`, excluding the post one-shot ALONG WITH
# the smoke check, on the reasoning that "neither is real when nothing is
# running". That is true of the smoke check and false of the one-shot.
#
#   - A smoke script asserts HTTP against the service's own origin. Zero tasks,
#     so it can only fail on an empty target group or "pass" against something
#     that is not this image. Not real. Skipped.
#   - `run_one_shot_command` calls `ecs run-task`: its own task, on the new
#     revision, independent of the service. The pre-phase line directly above in
#     this same expected log is the positive control -- it launches and succeeds
#     at desired=0 by exactly that mechanism. Real. Run.
#
# Excluding the one-shot DEADLOCKS a parked service: it is the `post` migration
# phase, @oxyhq/db's ledger is a high-water mark, and the next release's `pre`
# run is refused behind an unapplied `post` one -- so the deploy that was
# supposed to "catch up later" fails at its migration step instead. Measured in
# alia: four consecutive merges deployed red behind an unapplied 0016.
run_release zero-desired-count true true false 0 false 0
printf '%s\n' \
  reconcile \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=0' \
  reconcile \
  >"$test_directory/zero-desired-count/expected.log"
diff -u \
  "$test_directory/zero-desired-count/expected.log" \
  "$test_directory/zero-desired-count/aws.log"
# `service:...deploy-test:2:...` is the REPOINT, and it is the half that is easy
# to drop: registering a revision does not point the service at it, so without
# this line a later scale-up would launch the OLD image and every subsequent
# deploy would render from the stale revision.
grep -F \
  "service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=0" \
  "$test_directory/zero-desired-count/aws.log" \
  >/dev/null
grep -F \
  "NO ROLLOUT PERFORMED: ECS service deploy-test is at desiredCount=0" \
  "$test_directory/zero-desired-count/output.log" \
  >/dev/null
grep -F \
  "NO ROLLOUT PERFORMED: the task definition WAS registered and the service now points at it: arn:aws:ecs:test:task-definition/deploy-test:2" \
  "$test_directory/zero-desired-count/output.log" \
  >/dev/null
# The smoke script is skipped, and SAID to be skipped. An omitted line and a
# deliberate skip look identical in a log, which is how the post phase went
# missing in the first place.
if grep -qF 'smoke' "$test_directory/zero-desired-count/aws.log"; then
  echo "A zero-capacity release ran smoke checks against a service with no tasks." >&2
  exit 1
fi
grep -F \
  "post-deploy smoke checks were SKIPPED" \
  "$test_directory/zero-desired-count/output.log" \
  >/dev/null
grep -F \
  "MIGRATIONS DID RUN — the pre-rollout migration ran before the repoint and the post-deploy one-shot after it" \
  "$test_directory/zero-desired-count/output.log" \
  >/dev/null
# The success line of an ordinary release. If it ever appears here, a reader of
# the workflow log six weeks from now cannot tell this run apart from one that
# actually shipped, which is the failure this whole case exists to prevent.
if grep -qF \
  "ECS rollout reached a healthy steady state" \
  "$test_directory/zero-desired-count/output.log"; then
  echo "A zero-capacity release claimed a healthy rollout it never performed." >&2
  exit 1
fi

# The negative control for the case above: desiredCount ABSENT is ECS declining
# to answer, which is not the same fact as a zero it reports confidently, and
# must still refuse. Without this, deleting the numeric check outright would
# leave the suite green.
run_release missing-desired-count false false false 0 false null
grep -F \
  "reported a non-numeric desiredCount" \
  "$test_directory/missing-desired-count/output.log" \
  >/dev/null
if [[ -s "$test_directory/missing-desired-count/aws.log" ]]; then
  echo "A service with an unreadable desiredCount reached a mutating AWS call." >&2
  exit 1
fi

run_release transient-zero-deployment true false false 0 false 1 transient-zero-deployment
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/transient-zero-deployment/expected.log"
diff -u \
  "$test_directory/transient-zero-deployment/expected.log" \
  "$test_directory/transient-zero-deployment/aws.log"
grep -F \
  "has not assigned desired tasks" \
  "$test_directory/transient-zero-deployment/output.log" \
  >/dev/null

run_release zero-service-during-deploy false false false 0 false 1 zero-service-during-deploy
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1' \
  >"$test_directory/zero-service-during-deploy/expected.log"
diff -u \
  "$test_directory/zero-service-during-deploy/expected.log" \
  "$test_directory/zero-service-during-deploy/aws.log"
grep -F \
  "service deploy-test reached desiredCount=0 during the deployment rollout" \
  "$test_directory/zero-service-during-deploy/output.log" \
  >/dev/null

run_release completed-zero-deployment false false false 0 false 1 completed-zero-deployment
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1' \
  >"$test_directory/completed-zero-deployment/expected.log"
diff -u \
  "$test_directory/completed-zero-deployment/expected.log" \
  "$test_directory/completed-zero-deployment/aws.log"
grep -F \
  "completed at desiredCount=0; refusing to accept a zero-task steady state" \
  "$test_directory/completed-zero-deployment/output.log" \
  >/dev/null

# A smoke failure the smoke script attributes to the new image rolls the service
# back, and stops the release before the reconciliation task runs.
run_release smoke-hermetic-failure false false false 0 false 1 healthy 1
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1' \
  >"$test_directory/smoke-hermetic-failure/expected.log"
diff -u \
  "$test_directory/smoke-hermetic-failure/expected.log" \
  "$test_directory/smoke-hermetic-failure/aws.log"
grep -F \
  "Post-deploy smoke checks failed." \
  "$test_directory/smoke-hermetic-failure/output.log" \
  >/dev/null

# A smoke failure the smoke script attributes to something outside the new image
# (exit 75) must NOT roll back: the service stays on the new task definition, the
# release finishes its reconciliation task, and the job still fails so the
# failure is paged rather than swallowed.
run_release smoke-no-rollback-failure false false false 0 false 1 healthy 75
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/smoke-no-rollback-failure/expected.log"
diff -u \
  "$test_directory/smoke-no-rollback-failure/expected.log" \
  "$test_directory/smoke-no-rollback-failure/aws.log"
if grep -qF \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:' \
  "$test_directory/smoke-no-rollback-failure/aws.log"; then
  echo "A smoke failure that cannot be repaired by a rollback rolled back anyway." >&2
  exit 1
fi
grep -F \
  "stays on arn:aws:ecs:test:task-definition/deploy-test:2" \
  "$test_directory/smoke-no-rollback-failure/output.log" \
  >/dev/null
grep -F \
  "Nothing was rolled back; this release needs a human." \
  "$test_directory/smoke-no-rollback-failure/output.log" \
  >/dev/null

# The migration command is CONFIGURABLE, and the deploy runs what it was given.
#
# It used to be hardcoded to a compiled `dist/` path. A service whose image runs
# TypeScript directly — or whose migrator needs arguments — cannot use that, and
# setting `RUN_MIGRATIONS=true` without a matching command fails every deploy.
# The fake `aws` records each one-shot's `--overrides`, so this asserts on what
# would actually be sent to ECS rather than on the variable being set.
run_release configurable-migration-command true true false 0 false 1 healthy 0
if ! grep -qF 'migrate --phase=pre' \
  "$test_directory/configurable-migration-command/aws.log.commands"; then
  echo "The migration one-shot did not run the command it was configured with." >&2
  cat "$test_directory/configurable-migration-command/aws.log.commands" >&2
  exit 1
fi
# Anti-vacuity: the OLD hardcoded command must be gone, or the assertion above
# could pass on a run that also still issues the default.
if grep -qF 'dist/scripts/migrate.js' \
  "$test_directory/configurable-migration-command/aws.log.commands"; then
  echo "The hardcoded migration command is still being issued." >&2
  exit 1
fi

# A malformed command is refused BEFORE anything is registered or updated.
if env \
  AWS_REGION=test AWS_ACCOUNT_ID=123456789012 CLUSTER=deploy-test APP=deploy-test \
  CONTAINER_NAME=deploy-test \
  IMAGE_URI="example.invalid/deploy-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  RUN_MIGRATIONS=true MIGRATION_TASK_COMMAND_JSON='not json' \
  bash "$repository_root/.github/scripts/deploy-ecs-image.sh" >/dev/null 2>&1; then
  echo "A malformed MIGRATION_TASK_COMMAND_JSON was accepted." >&2
  exit 1
fi

if (( cases_run < MINIMUM_CASES )); then
  echo "ASSERTION FAILED: only $cases_run release cases ran, expected at least $MINIMUM_CASES." >&2
  echo "The suite exited green without executing everything it claims to check." >&2
  exit 1
fi

echo "Deployment script transaction tests passed ($cases_run release cases)."
