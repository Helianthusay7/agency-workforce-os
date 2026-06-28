import type { AppState, Clock, ExecutionEventInput, ExecutionEventRecord, IdFactory } from "./types.js";

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
  EXECUTION_STEP_FAILED: "EXECUTION_STEP_FAILED",
  TOOL_CALLED: "TOOL_CALLED"
});

export type ExecutionEventType = typeof EXECUTION_EVENT_TYPES[keyof typeof EXECUTION_EVENT_TYPES];

export function ensureEventStoreState(state: AppState): void {
  if (!Array.isArray(state.events)) state.events = [];
  if (!Number.isInteger(state.executionEventCursor)) state.executionEventCursor = 0;
}

export function appendEvent(
  state: AppState,
  createId: IdFactory,
  now: Clock,
  event: ExecutionEventInput
): ExecutionEventRecord {
  ensureEventStoreState(state);
  if (!Object.values(EXECUTION_EVENT_TYPES).includes(event.type as ExecutionEventType)) {
    throw new Error(`Unsupported execution event type: ${event.type}`);
  }

  state.executionEventCursor = (state.executionEventCursor || 0) + 1;
  const record: ExecutionEventRecord = {
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
  state.events!.unshift(record);
  return record;
}