import { runAgentRuntime } from "./agentRuntime.js";

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
  return {
    id: agent.id,
    displayName: agent.displayName,
    title: agent.title,
    templateId: agent.templateId,
    role: template?.name || agent.title,
    model: agent.model,
    permission: agent.permission
  };
}

export function ensureExecutionState(state) {
  if (!Array.isArray(state.artifacts)) state.artifacts = [];
  if (!Array.isArray(state.events)) state.events = [];
  if (!Array.isArray(state.executionTraces)) state.executionTraces = [];
}

function emitEvent(state, createId, now, event) {
  const record = {
    id: createId("evt"),
    timestamp: now(),
    ...event
  };
  state.events.unshift(record);
  return record;
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
  return {
    id: createId("art"),
    type: runtimeResult.parsedOutput.type,
    title: `Agent 执行结果：${task.title}`,
    content: runtimeResult.parsedOutput.content,
    summary: runtimeResult.parsedOutput.summary,
    taskId: task.id,
    agentId: agent.id,
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
  const orchestrationId = createId("run");
  const startedAt = now();

  emitEvent(state, createId, now, {
    type: "execution_started",
    orchestrationId,
    taskId: task.id,
    agentId: agent.id,
    input: { task: taskSnapshot, agent: agentSnapshot }
  });
  emitEvent(state, createId, now, {
    type: "agent_selected",
    orchestrationId,
    taskId: task.id,
    agentId: agent.id,
    input: { requestedAgentId: requestedAgentId || null }
  });

  try {
    const runtimeResult = await runAgentRuntime({ task, agent, template, project, callLlm, now });
    const artifact = buildArtifact(createId, task, agent, runtimeResult);
    const executionTrace = buildExecutionTrace(createId, taskSnapshot, agentSnapshot, artifact, runtimeResult);
    artifact.executionTraceId = executionTrace.id;
    artifact.orchestrationId = orchestrationId;

    task.status = "running";
    agent.status = "busy";
    agent.currentTaskId = task.id;
    agent.load = Math.min(95, Number(agent.load || 0) + 10);

    state.artifacts.unshift(artifact);
    state.executionTraces.unshift(executionTrace);
    emitEvent(state, createId, now, {
      type: "prompt_built",
      orchestrationId,
      taskId: task.id,
      agentId: agent.id,
      prompt: runtimeResult.prompt
    });
    emitEvent(state, createId, now, {
      type: "llm_completed",
      orchestrationId,
      taskId: task.id,
      agentId: agent.id,
      output: runtimeResult.rawOutput,
      provider: runtimeResult.llmResult.provider,
      model: runtimeResult.llmResult.model
    });
    emitEvent(state, createId, now, {
      type: "artifact_created",
      orchestrationId,
      taskId: task.id,
      agentId: agent.id,
      artifact
    });
    emitEvent(state, createId, now, {
      type: "execution_completed",
      orchestrationId,
      taskId: task.id,
      agentId: agent.id,
      artifactId: artifact.id,
      executionTraceId: executionTrace.id
    });

    return { task, employee: agent, agent, artifact, executionTrace, orchestrationId };
  } catch (error) {
    const completedAt = now();
    const executionTrace = buildFailedExecutionTrace(createId, taskSnapshot, agentSnapshot, error, startedAt, completedAt);
    state.executionTraces.unshift(executionTrace);
    emitEvent(state, createId, now, {
      type: "execution_failed",
      orchestrationId,
      taskId: task.id,
      agentId: agent.id,
      executionTraceId: executionTrace.id,
      error: executionTrace.error
    });
    error.executionTrace = executionTrace;
    throw error;
  }
}
