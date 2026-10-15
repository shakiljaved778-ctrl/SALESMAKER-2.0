#!/usr/bin/env bash
# ECS deploy steps used by .github/workflows/deploy-staging.yml (docs/runbooks/deploy.md).
# Needs the AWS CLI and jq, with credentials for the target account.
#
#   ecs.sh migrate <cluster> <task-family> <image> <reference-service> <command>
#       Registers the task definition with <image>, runs it once with the network settings of
#       <reference-service> and fails unless the container exits 0.
#   ecs.sh roll <cluster> <service> <image>
#       Registers the service's task definition with <image>, updates the service and waits
#       until it is stable (the circuit breaker rolls back a failed deploy).
set -euo pipefail

# Register a copy of a task definition's latest revision with a new image; prints its ARN.
register_with_image() {
  local family=$1 image=$2
  aws ecs describe-task-definition --task-definition "$family" --query taskDefinition --output json |
    jq --arg image "$image" '.containerDefinitions[0].image = $image
      | {family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions, volumes,
         requiresCompatibilities, cpu, memory, runtimePlatform}
      | with_entries(select(.value != null))' >"${TMPDIR:-/tmp}/taskdef.json"
  aws ecs register-task-definition --cli-input-json "file://${TMPDIR:-/tmp}/taskdef.json" \
    --query taskDefinition.taskDefinitionArn --output text
}

migrate() {
  local cluster=$1 family=$2 image=$3 reference=$4 command=$5
  local taskdef network task code
  taskdef=$(register_with_image "$family" "$image")
  network=$(aws ecs describe-services --cluster "$cluster" --services "$reference" \
    --query 'services[0].networkConfiguration' --output json)
  task=$(aws ecs run-task --cluster "$cluster" --task-definition "$taskdef" --launch-type FARGATE \
    --network-configuration "$network" --started-by "deploy-${GITHUB_SHA:-manual}" \
    --overrides "$(jq -nc --arg c "$command" '{containerOverrides: [{name: "migrate", command: [$c]}]}')" \
    --query 'tasks[0].taskArn' --output text)
  echo "migrate task $task ($command)"
  aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task"
  code=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" \
    --query 'tasks[0].containers[0].exitCode' --output text)
  if [ "$code" != "0" ]; then
    echo "::error::migrate ($command) exited with $code; see the /sm/*/migrate log group" >&2
    exit 1
  fi
}

roll() {
  local cluster=$1 service=$2 image=$3 family taskdef
  family=$(aws ecs describe-services --cluster "$cluster" --services "$service" \
    --query 'services[0].taskDefinition' --output text | sed 's#.*/##; s#:[0-9]*$##')
  taskdef=$(register_with_image "$family" "$image")
  aws ecs update-service --cluster "$cluster" --service "$service" --task-definition "$taskdef" \
    --query 'service.deployments[0].id' --output text
  aws ecs wait services-stable --cluster "$cluster" --services "$service"
  local current
  current=$(aws ecs describe-services --cluster "$cluster" --services "$service" \
    --query 'services[0].taskDefinition' --output text)
  if [ "$current" != "$taskdef" ]; then
    echo "::error::$service rolled back to $current (the new tasks failed their health checks)" >&2
    exit 1
  fi
}

"$@"
