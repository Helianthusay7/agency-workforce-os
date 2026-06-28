import { EXECUTION_EVENT_TYPES, appendEvent, ensureEventStoreState } from "./eventStore.js";
import type {
  AppState,
  Clock,
  ExecutionEventInput,
  ExecutionEventRecord,
  ExecutionRun,
  ExecutionStep,
  IdFactory,
  RuntimeError
} from "./types.js";

export const EXECUTION_ENGINE_VERSION = "v2";

interface ExecutionSnapshot {
  id: string;
  [key: string]: unknown;
}

export function ensureExecutionEngineState(state: AppState): void {
  if (!Array.isArray(state.artifacts)) state.artifacts = [];
  ensureEventStoreState(state);
  if (!Array.isArray(state.executionTraces)) state.executionTraces = [];
  if (!Array.isArray(state.executionRuns)) state.executionRuns = [];
}

export function appendExecutionEvent(
  state: AppState,
  createId: IdFactory,
  now: Clock,
  event: ExecutionEventInput
): ExecutionEventRecord {
  return appendEvent(state, createId, now, event);
}

export function createExecutionRun(
  state: AppState,
  createId: IdFactory,
  now: Clock,
  { taskSnapshot, agentSnapshot }: { taskSnapshot: ExecutionSnapshot; agentSnapshot: ExecutionSnapshot }
): ExecutionRun {
  ensureExecutionEngineState(state);
  const run: ExecutionRun = {
    id: createId("run"),
    engineVersion: EXECUTION_ENGINE_VERSION,
    taskId: taskSnapshot.id,
    agentId: agentSnapshot.id,
    status: "running",
    currentStep: null,
    steps: [],
    artifactIds: [],
    executionTraceId: null,
    startedAt: now(),
    completedAt: null,
    durationMs: null,
    error: null
  };
  state.executionRuns!.unshift(run);
  appendExecutionEvent(state, createId, now, {
    type: EXECUTION_EVENT_TYPES.EXECUTION_RUN_STARTED,
    orchestrationId: run.id,
    taskId: run.taskId,
    agentId: run.agentId,
    payload: { task: taskSnapshot, agent: agentSnapshot }
  });
  return run;
}

export function startRunStep(
  state: AppState,
  run: ExecutionRun,
  createId: IdFactory,
  now: Clock,
  name: string,
  input: Record<string, unknown> = {}
): ExecutionStep {
  const step: ExecutionStep = {
    name,
    status: "running",
    startedAt: now(),
    completedAt: null,
    durationMs: null,
    input,
    output: null,
    error: null
  };
  run.currentStep = name;
  run.steps.push(step);
  appendExecutionEvent(state, createId, now, {
    type: EXECUTION_EVENT_TYPES.EXECUTION_STEP_STARTED,
    orchestrationId: run.id,
    taskId: run.taskId,
    agentId: run.agentId,
    payload: { step: name, input }
  });
  return step;
}

export function completeRunStep(
  state: AppState,
  run: ExecutionRun,
  createId: IdFactory,
  now: Clock,
  name: string,
  output: Record<string, unknown> = {}
): ExecutionStep | null {
  const step = [...run.steps].reverse().find((item) => item.name === name && item.status === "running");
  if (!step) return null;
  step.status = "succeeded";
  step.completedAt = now();
  step.durationMs = new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime();
  step.output = output;
  run.currentStep = null;
  appendExecutionEvent(state, createId, now, {
    type: EXECUTION_EVENT_TYPES.EXECUTION_STEP_COMPLETED,
    orchestrationId: run.id,
    taskId: run.taskId,
    agentId: run.agentId,
    payload: { step: name, output }
  });
  return step;
}

export function failRunStep(
  state: AppState,
  run: ExecutionRun,
  createId: IdFactory,
  now: Clock,
  name: string,
  error: RuntimeError
): ExecutionStep | null {
  const step = [...run.steps].reverse().find((item) => item.name === name && item.status === "running");
  if (!step) return null;
  step.status = "failed";
  step.completedAt = now();
  step.durationMs = new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime();
  step.error = {
    message: error.message || "Execution step failed",
    name: error.name || "Error"
  };
  run.currentStep = name;
  appendExecutionEvent(state, createId, now, {
    type: EXECUTION_EVENT_TYPES.EXECUTION_STEP_FAILED,
    orchestrationId: run.id,
    taskId: run.taskId,
    agentId: run.agentId,
    payload: { step: name, error: step.error }
  });
  return step;
}

export function completeExecutionRun(
  state: AppState,
  run: ExecutionRun,
  createId: IdFactory,
  now: Clock,
  { artifactId, executionTraceId }: { artifactId?: string | null; executionTraceId?: string | null }
): ExecutionRun {
  run.status = "succeeded";
  run.completedAt = now();
  run.durationMs = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
  run.currentStep = null;
  run.artifactIds = artifactId ? [...new Set([...run.artifactIds, artifactId])] : run.artifactIds;
  run.executionTraceId = executionTraceId || null;
  appendExecutionEvent(state, createId, now, {
    type: EXECUTION_EVENT_TYPES.EXECUTION_RUN_COMPLETED,
    orchestrationId: run.id,
    taskId: run.taskId,
    agentId: run.agentId,
    artifactId,
    executionTraceId,
    payload: { artifactId, executionTraceId }
  });
  return run;
}

export function failExecutionRun(
  state: AppState,
  run: ExecutionRun,
  createId: IdFactory,
  now: Clock,
  error: RuntimeError,
  executionTraceId: string | null = null
): ExecutionRun {
  run.status = "failed";
  run.completedAt = now();
  run.durationMs = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
  run.executionTraceId = executionTraceId;
  run.error = {
    message: error.message || "Execution run failed",
    name: error.name || "Error"
  };
  appendExecutionEvent(state, createId, now, {
    type: EXECUTION_EVENT_TYPES.EXECUTION_RUN_FAILED,
    orchestrationId: run.id,
    taskId: run.taskId,
    agentId: run.agentId,
    executionTraceId,
    payload: { error: run.error }
  });
  return run;
}