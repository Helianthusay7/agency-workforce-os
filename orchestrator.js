import { runAgentRuntime } from "./agentRuntime.js";
import {
  completeExecutionRun,
  completeRunStep,
  createExecutionRun,
  ensureExecutionEngineState,
  failExecutionRun,
  failRunStep,
  startRunStep
} from "./executionEngine.js";
import { EXECUTION_EVENT_TYPES, appendEvent } from "./eventStore.js";

function snapshotTask(task) {
  return {
    id: task.id,
    title: task.title,
    projectId: task.projectId,
    ownerUserId: task.ownerUserId,
    status: task.status,
    priority: task.priority,
    description: task.description || "",
    assignedEmployeeIds: [...(task.assignedEmployeeIds || [])],
    dueDate: task.dueDate || "",
    parentTaskId: task.parentTaskId || null
  };
}

function snapshotAgent(agent, template) {
  const llmConfig = agent.llmConfig && typeof agent.llmConfig === "object" ? agent.llmConfig : {};
  return {
    id: agent.id,
    displayName: agent.displayName,
    title: agent.title,
    templateId: agent.templateId,
    role: template?.name || agent.title,
    model: agent.model,
    permission: agent.permission,
    llmConfig: {
      provider: llmConfig.provider || null,
      model: llmConfig.model || agent.model || null,
      keyRef: llmConfig.keyRef || llmConfig.apiKeyEnv || null,
      baseUrl: llmConfig.baseUrl || null
    }
  };
}

export function ensureExecutionState(state) {
  ensureExecutionEngineState(state);
}

function emitEvent(state, createId, now, event) {
  return appendEvent(state, createId, now, event);
}

function selectAgent(state, task, requestedAgentId) {
  if (requestedAgentId) {
    return state.employees.find((agent) => agent.id === requestedAgentId && task.assignedEmployeeIds.includes(agent.id));
  }
  return task.assignedEmployeeIds
    .map((agentId) => state.employees.find((agent) => agent.id === agentId))
    .find(Boolean);
}

function buildArtifact(createId, task, agent, runtimeResult) {
  const artifactId = createId("art");
  return {
    id: artifactId,
    type: runtimeResult.parsedOutput.type,
    title: `Agent execution result: ${task.title}`,
    content: runtimeResult.parsedOutput.content,
    summary: runtimeResult.parsedOutput.summary,
    taskId: task.id,
    agentId: agent.id,
    meta: {
      ...runtimeResult.parsedOutput.meta,
      artifactId,
      runtime: "agent-runtime-v2"
    },
    createdBy: agent.id,
    timestamp: runtimeResult.completedAt,
    updatedAt: runtimeResult.completedAt,
    deliverables: runtimeResult.parsedOutput.deliverables,
    decisions: runtimeResult.parsedOutput.decisions,
    risks: runtimeResult.parsedOutput.risks,
    nextActions: runtimeResult.parsedOutput.nextActions,
    parseStatus: runtimeResult.parsedOutput.parseStatus
  };
}

function buildExecutionTrace(createId, taskSnapshot, agentSnapshot, artifact, runtimeResult) {
  return {
    id: createId("exec"),
    status: "succeeded",
    taskId: taskSnapshot.id,
    agentId: agentSnapshot.id,
    artifactId: artifact.id,
    provider: runtimeResult.llmResult.provider,
    requestedProvider: runtimeResult.llmResult.requestedProvider || runtimeResult.llmResult.provider,
    model: runtimeResult.llmResult.model,
    keyRef: runtimeResult.llmResult.keyRef || "",
    baseUrl: runtimeResult.llmResult.baseUrl || "",
    fallback: Boolean(runtimeResult.llmResult.fallback),
    fallbackReason: runtimeResult.llmResult.fallbackReason || "",
    responseId: runtimeResult.llmResult.responseId || null,
    inputTask: taskSnapshot,
    agent: agentSnapshot,
    prompt: runtimeResult.prompt,
    llmOutput: runtimeResult.rawOutput,
    parsedOutput: runtimeResult.parsedOutput,
    finalArtifact: artifact,
    startedAt: runtimeResult.startedAt,
    completedAt: runtimeResult.completedAt,
    durationMs: runtimeResult.durationMs,
    error: null
  };
}

function buildFailedExecutionTrace(createId, taskSnapshot, agentSnapshot, runtimeError, startedAt, completedAt) {
  return {
    id: createId("exec"),
    status: "failed",
    taskId: taskSnapshot.id,
    agentId: agentSnapshot.id,
    artifactId: null,
    provider: runtimeError.provider || "unknown",
    requestedProvider: runtimeError.provider || "unknown",
    model: runtimeError.model || agentSnapshot.model || "unknown",
    keyRef: runtimeError.keyRef || agentSnapshot.llmConfig?.keyRef || "",
    baseUrl: runtimeError.baseUrl || agentSnapshot.llmConfig?.baseUrl || "",
    fallback: false,
    fallbackReason: "",
    responseId: null,
    inputTask: taskSnapshot,
    agent: agentSnapshot,
    prompt: runtimeError.prompt || "",
    llmOutput: runtimeError.llmOutput || "",
    parsedOutput: null,
    finalArtifact: null,
    startedAt,
    completedAt,
    durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    error: {
      message: runtimeError.message || "Agent execution failed",
      name: runtimeError.name || "Error"
    }
  };
}

function emitLlmCalled(state, createId, now, { task, agent, orchestrationId, runtimeResult, error }) {
  emitEvent(state, createId, now, {
    type: EXECUTION_EVENT_TYPES.LLM_CALLED,
    orchestrationId,
    taskId: task.id,
    agentId: agent.id,
    payload: {
      status: error ? "failed" : "succeeded",
      provider: runtimeResult?.llmResult?.provider || error?.provider || "unknown",
      requestedProvider: runtimeResult?.llmResult?.requestedProvider || error?.provider || "unknown",
      model: runtimeResult?.llmResult?.model || error?.model || agent.model || "unknown",
      keyRef: runtimeResult?.llmResult?.keyRef || error?.keyRef || agent.llmConfig?.keyRef || "",
      baseUrl: runtimeResult?.llmResult?.baseUrl || error?.baseUrl || agent.llmConfig?.baseUrl || "",
      fallback: Boolean(runtimeResult?.llmResult?.fallback),
      fallbackReason: runtimeResult?.llmResult?.fallbackReason || "",
      prompt: runtimeResult?.prompt || error?.prompt || "",
      output: runtimeResult?.rawOutput || error?.llmOutput || "",
      error: error ? { message: error.message || "LLM execution failed", name: error.name || "Error" } : null
    }
  });
}

export async function orchestrateTask(state, taskId, options) {
  ensureExecutionState(state);
  const { createId, now, callLlm, requestedAgentId } = options;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    const error = new Error("Task not found");
    error.status = 404;
    throw error;
  }

  const agent = selectAgent(state, task, requestedAgentId);
  if (!agent) {
    const error = new Error("Task has no assigned AI employee");
    error.status = 400;
    throw error;
  }

  const template = state.agentTemplates.find((item) => item.id === agent.templateId);
  const project = state.projects.find((item) => item.id === task.projectId);
  const taskSnapshot = snapshotTask(task);
  const agentSnapshot = snapshotAgent(agent, template);
  const executionRun = createExecutionRun(state, createId, now, { taskSnapshot, agentSnapshot });
  const orchestrationId = executionRun.id;
  const startedAt = executionRun.startedAt;

  emitEvent(state, createId, now, {
    type: EXECUTION_EVENT_TYPES.TASK_STARTED,
    orchestrationId,
    taskId: task.id,
    agentId: agent.id,
    payload: { task: taskSnapshot }
  });

  startRunStep(state, executionRun, createId, now, "select_agent", { requestedAgentId: requestedAgentId || null });
  emitEvent(state, createId, now, {
    type: EXECUTION_EVENT_TYPES.AGENT_ASSIGNED,
    orchestrationId,
    taskId: task.id,
    agentId: agent.id,
    payload: { requestedAgentId: requestedAgentId || null, agent: agentSnapshot }
  });
  completeRunStep(state, executionRun, createId, now, "select_agent", { selectedAgentId: agent.id });

  try {
    startRunStep(state, executionRun, createId, now, "run_agent", { taskId: task.id, agentId: agent.id });
    const runtimeResult = await runAgentRuntime({ task, agent, template, project, callLlm, now });
    emitLlmCalled(state, createId, now, { task, agent, orchestrationId, runtimeResult });
    completeRunStep(state, executionRun, createId, now, "run_agent", {
      provider: runtimeResult.llmResult.provider,
      model: runtimeResult.llmResult.model,
      parseStatus: runtimeResult.parsedOutput.parseStatus
    });

    startRunStep(state, executionRun, createId, now, "create_artifact", { outputType: runtimeResult.parsedOutput.type });
    const artifact = buildArtifact(createId, task, agent, runtimeResult);
    const executionTrace = buildExecutionTrace(createId, taskSnapshot, agentSnapshot, artifact, runtimeResult);
    artifact.executionTraceId = executionTrace.id;
    artifact.orchestrationId = orchestrationId;

    task.status = "review";
    agent.status = "busy";
    agent.currentTaskId = task.id;
    agent.load = Math.min(95, Number(agent.load || 0) + 10);

    state.artifacts.unshift(artifact);
    state.executionTraces.unshift(executionTrace);
    emitEvent(state, createId, now, {
      type: EXECUTION_EVENT_TYPES.ARTIFACT_CREATED,
      orchestrationId,
      taskId: task.id,
      agentId: agent.id,
      artifactId: artifact.id,
      executionTraceId: executionTrace.id,
      payload: { artifact }
    });
    completeRunStep(state, executionRun, createId, now, "create_artifact", {
      artifactId: artifact.id,
      executionTraceId: executionTrace.id
    });

    startRunStep(state, executionRun, createId, now, "persist_events", {
      artifactId: artifact.id,
      executionTraceId: executionTrace.id
    });
    emitEvent(state, createId, now, {
      type: EXECUTION_EVENT_TYPES.TASK_COMPLETED,
      orchestrationId,
      taskId: task.id,
      agentId: agent.id,
      artifactId: artifact.id,
      executionTraceId: executionTrace.id,
      payload: { artifactId: artifact.id, executionTraceId: executionTrace.id }
    });
    completeRunStep(state, executionRun, createId, now, "persist_events", {
      artifactId: artifact.id,
      executionTraceId: executionTrace.id
    });
    completeExecutionRun(state, executionRun, createId, now, {
      artifactId: artifact.id,
      executionTraceId: executionTrace.id
    });

    return { task, employee: agent, agent, artifact, executionTrace, orchestrationId, executionRun };
  } catch (error) {
    const completedAt = now();
    const executionTrace = buildFailedExecutionTrace(createId, taskSnapshot, agentSnapshot, error, startedAt, completedAt);
    state.executionTraces.unshift(executionTrace);
    if (executionRun.currentStep === "run_agent") {
      emitLlmCalled(state, createId, now, { task, agent, orchestrationId, error });
    }
    if (executionRun.currentStep) {
      failRunStep(state, executionRun, createId, now, executionRun.currentStep, error);
    }
    emitEvent(state, createId, now, {
      type: EXECUTION_EVENT_TYPES.TASK_FAILED,
      orchestrationId,
      taskId: task.id,
      agentId: agent.id,
      executionTraceId: executionTrace.id,
      payload: { error: executionTrace.error }
    });
    failExecutionRun(state, executionRun, createId, now, error, executionTrace.id);
    error.executionTrace = executionTrace;
    error.executionRun = executionRun;
    throw error;
  }
}
