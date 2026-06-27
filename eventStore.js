export const EXECUTION_EVENT_TYPES = Object.freeze({
  TASK_STARTED: "TASK_STARTED",
  AGENT_ASSIGNED: "AGENT_ASSIGNED",
  LLM_CALLED: "LLM_CALLED",
  ARTIFACT_CREATED: "ARTIFACT_CREATED",
  TASK_COMPLETED: "TASK_COMPLETED",
  TASK_FAILED: "TASK_FAILED",
  TASK_SIGNED_OFF: "TASK_SIGNED_OFF",
  EXECUTION_RUN_STARTED: "EXECUTION_RUN_STARTED",
  EXECUTION_RUN_COMPLETED: "EXECUTION_RUN_COMPLETED",
  EXECUTION_RUN_FAILED: "EXECUTION_RUN_FAILED",
  EXECUTION_STEP_STARTED: "EXECUTION_STEP_STARTED",
  EXECUTION_STEP_COMPLETED: "EXECUTION_STEP_COMPLETED",
  EXECUTION_STEP_FAILED: "EXECUTION_STEP_FAILED"
});

export function ensureEventStoreState(state) {
  if (!Array.isArray(state.events)) state.events = [];
  if (!Number.isInteger(state.executionEventCursor)) state.executionEventCursor = 0;
}

export function appendEvent(state, createId, now, event) {
  ensureEventStoreState(state);
  if (!Object.values(EXECUTION_EVENT_TYPES).includes(event.type)) {
    throw new Error(`Unsupported execution event type: ${event.type}`);
  }

  state.executionEventCursor += 1;
  const record = {
    id: createId("evt"),
    sequence: state.executionEventCursor,
    engineVersion: "v2",
    aggregateType: "execution",
    aggregateId: event.orchestrationId || event.taskId || null,
    timestamp: now(),
    type: event.type,
    taskId: event.taskId || null,
    agentId: event.agentId || null,
    artifactId: event.artifactId || null,
    executionTraceId: event.executionTraceId || null,
    orchestrationId: event.orchestrationId || null,
    payload: event.payload || {}
  };
  state.events.unshift(record);
  return record;
}
