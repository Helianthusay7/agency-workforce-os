import { runAgentRuntime } from "./agentRuntime.js";
import type { AgentRuntimeResult, RuntimeParsedOutput } from "./agentRuntime.js";
import {
  completeExecutionRun,
  completeRunStep,
  createExecutionRun,
  ensureExecutionEngineState,
  failExecutionRun,
  failRunStep,
  startRunStep
} from "./executionEngine.js";
import type { ExecutionRun } from "./types.js";
import { EXECUTION_EVENT_TYPES, appendEvent } from "./eventStore.js";
import { ensureToolGatewayState, executeArtifactToolActions } from "./toolGateway.js";
import type {
  AgentTemplate,
  AppState,
  Artifact,
  Clock,
  Employee,
  ExecutionEventInput,
  ExecutionTrace,
  IdFactory,
  LlmResult,
  Project,
  RuntimeError,
  Task,
  TaskSignoff,
  ToolInvocation
} from "./types.js";

interface TaskSnapshot extends Record<string, unknown> {
  id: string;
  title: string;
  projectId?: string;
  ownerUserId?: string;
  status: string;
  priority?: string;
  description: string;
  assignedEmployeeIds: string[];
  dueDate: string;
  parentTaskId: string | null;
}

interface AgentSnapshot extends Record<string, unknown> {
  id: string;
  displayName: string;
  title: string;
  templateId?: string;
  role: string;
  model?: string;
  permission?: string;
  llmConfig: {
    provider: string | null;
    model: string | null;
    keyRef: string | null;
    baseUrl: string | null;
  };
}

interface ExecutionPolicy {
  canRun: boolean;
  requiresApproval: boolean;
  allowedArtifactTypes: string[];
}

interface OrchestrateTaskOptions {
  requestedAgentId?: string;
  createId: IdFactory;
  now: Clock;
  callLlm: (
    prompt: string,
    task: Task,
    agent: Employee,
    template?: AgentTemplate,
    project?: Project
  ) => Promise<LlmResult>;
}

interface OrchestrateTaskResult {
  task: Task;
  employee: Employee;
  agent: Employee;
  artifact: Artifact;
  executionTrace: ExecutionTrace;
  orchestrationId: string;
  executionRun: ExecutionRun;
}

function runtimeError(message: string, status?: number): RuntimeError {
  const error = new Error(message) as RuntimeError;
  if (status) error.status = status;
  return error;
}

function snapshotTask(task: Task): TaskSnapshot {
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

function snapshotAgent(agent: Employee, template?: AgentTemplate): AgentSnapshot {
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

export function ensureExecutionState(state: AppState): void {
  ensureExecutionEngineState(state);
  ensureToolGatewayState(state);
}

function emitEvent(state: AppState, createId: IdFactory, now: Clock, event: ExecutionEventInput) {
  return appendEvent(state, createId, now, event);
}

function selectAgent(state: AppState, task: Task, requestedAgentId?: string): Employee | undefined {
  if (requestedAgentId) {
    return state.employees.find((agent) => agent.id === requestedAgentId && task.assignedEmployeeIds.includes(agent.id));
  }
  return task.assignedEmployeeIds
    .map((agentId) => state.employees.find((agent) => agent.id === agentId))
    .find(Boolean);
}

function normalizePermission(permission: unknown): string {
  const value = String(permission || "").trim().toLowerCase();
  const aliases: Record<string, string> = {
    "只读": "read only",
    "建议": "suggest",
    "草稿": "draft",
    "审批后执行": "execute with approval",
    "需审批执行": "execute with approval",
    read_only: "read only",
    readonly: "read only",
    draft: "draft",
    suggest: "suggest",
    suggestion: "suggest",
    execute_with_approval: "execute with approval",
    "approval required": "execute with approval",
    execute: "execute"
  };
  return aliases[value] || value;
}

function hasApprovedExecution(state: AppState, task: Task, agent: Employee): boolean {
  return state.approvals.some((approval) => {
    return approval.taskId === task.id
      && approval.status === "approved"
      && (!approval.requesterEmployeeId || approval.requesterEmployeeId === agent.id);
  });
}

function executionPolicy(agent: Employee): ExecutionPolicy {
  const permission = normalizePermission(agent.permission);
  if (permission === "read only") {
    return { canRun: false, requiresApproval: false, allowedArtifactTypes: [] };
  }
  if (permission === "execute with approval") {
    return { canRun: true, requiresApproval: true, allowedArtifactTypes: ["code", "doc", "plan", "analysis"] };
  }
  if (permission === "suggest") {
    return { canRun: true, requiresApproval: false, allowedArtifactTypes: ["doc", "plan", "analysis"] };
  }
  if (permission === "draft") {
    return { canRun: true, requiresApproval: false, allowedArtifactTypes: ["doc", "plan", "analysis"] };
  }
  if (permission === "execute") {
    return { canRun: true, requiresApproval: false, allowedArtifactTypes: ["code", "doc", "plan", "analysis"] };
  }
  return { canRun: true, requiresApproval: false, allowedArtifactTypes: ["doc", "plan", "analysis"] };
}

function assertAgentCanExecute(state: AppState, task: Task, agent: Employee): void {
  const policy = executionPolicy(agent);
  if (!policy.canRun) {
    throw runtimeError(`${agent.displayName} is read-only and cannot execute tasks`, 403);
  }
  if (policy.requiresApproval && !hasApprovedExecution(state, task, agent)) {
    throw runtimeError(`${agent.displayName} requires approved execution before running this task`, 403);
  }
}

function assertArtifactAllowed(agent: Employee, parsedOutput: RuntimeParsedOutput): void {
  const policy = executionPolicy(agent);
  if (!policy.allowedArtifactTypes.includes(parsedOutput.type)) {
    throw runtimeError(`${agent.displayName} is not permitted to create ${parsedOutput.type} artifacts`, 403);
  }
}

function buildArtifact(createId: IdFactory, task: Task, agent: Employee, runtimeResult: AgentRuntimeResult): Artifact {
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

function buildExecutionTrace(
  createId: IdFactory,
  taskSnapshot: TaskSnapshot,
  agentSnapshot: AgentSnapshot,
  artifact: Artifact,
  runtimeResult: AgentRuntimeResult
): ExecutionTrace {
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

function buildFailedExecutionTrace(
  createId: IdFactory,
  taskSnapshot: TaskSnapshot,
  agentSnapshot: AgentSnapshot,
  runtimeError: RuntimeError,
  startedAt: string,
  completedAt: string
): ExecutionTrace {
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

function ensureTaskSignoffs(task: Task): TaskSignoff[] {
  if (!Array.isArray(task.signoffs)) task.signoffs = [];
  return task.signoffs;
}

function selectQaEmployee(state: AppState, builder: Employee): Employee | undefined {
  return state.employees.find((employee) => employee.id === "emp_qa_ai" && employee.id !== builder.id)
    || state.employees.find((employee) => employee.templateId === "tpl_qa" && employee.id !== builder.id)
    || state.employees.find((employee) => /qa|test|\u6d4b\u8bd5/i.test([employee.displayName, employee.title].join(" ")) && employee.id !== builder.id);
}

function buildQaEvidence(artifact: Artifact, toolInvocations: ToolInvocation[]): Record<string, unknown> {
  const content = String(artifact.content || "");
  const failedToolInvocations = toolInvocations.filter((invocation) => invocation.status === "failed");
  const incompleteToolInvocations = toolInvocations.filter((invocation) => invocation.status === "waiting_approval" || invocation.status === "running");
  return {
    artifactId: artifact.id,
    artifactType: artifact.type || "unknown",
    contentBytes: Buffer.byteLength(content, "utf8"),
    hasSummary: Boolean(String(artifact.summary || "").trim()),
    toolInvocationIds: toolInvocations.map((invocation) => invocation.id),
    failedToolInvocationIds: failedToolInvocations.map((invocation) => invocation.id),
    incompleteToolInvocationIds: incompleteToolInvocations.map((invocation) => invocation.id)
  };
}

function createAutomaticQaSignoff({
  state,
  task,
  builder,
  artifact,
  toolInvocations,
  createId,
  now,
  orchestrationId,
  executionTraceId
}: {
  state: AppState;
  task: Task;
  builder: Employee;
  artifact: Artifact;
  toolInvocations: ToolInvocation[];
  createId: IdFactory;
  now: Clock;
  orchestrationId: string;
  executionTraceId: string;
}): TaskSignoff | null {
  const qaEmployee = selectQaEmployee(state, builder);
  if (!qaEmployee) return null;

  const signoffs = ensureTaskSignoffs(task);
  const statusFrom = task.status;
  const evidence = buildQaEvidence(artifact, toolInvocations);
  const contentBytes = Number(evidence.contentBytes || 0);
  const failedToolCount = Array.isArray(evidence.failedToolInvocationIds) ? evidence.failedToolInvocationIds.length : 0;
  const incompleteToolCount = Array.isArray(evidence.incompleteToolInvocationIds) ? evidence.incompleteToolInvocationIds.length : 0;
  const passed = contentBytes > 0 && failedToolCount === 0 && incompleteToolCount === 0;
  const signoff: TaskSignoff = {
    id: createId("sig"),
    taskId: task.id,
    stage: "qa",
    stageLabel: "自动完整性检查",
    employeeId: qaEmployee.id,
    status: passed ? "passed" : "failed",
    note: passed
      ? "自动完整性检查通过：交付物已生成，工具调用均已完成且无失败。"
      : "自动完整性检查未通过：交付物为空，或仍有工具调用待审批/执行中/失败。",
    createdAt: now(),
    artifactId: artifact.id,
    automatic: true,
    evidence
  };

  signoffs.push(signoff);
  task.status = passed ? "tested" : "implemented";
  emitEvent(state, createId, now, {
    type: EXECUTION_EVENT_TYPES.TASK_SIGNED_OFF,
    orchestrationId,
    taskId: task.id,
    agentId: qaEmployee.id,
    artifactId: artifact.id,
    executionTraceId,
    payload: {
      signoff,
      statusFrom,
      statusTo: task.status,
      automatic: true
    }
  });

  state.auditLogs.unshift({
    id: createId("log"),
    actorType: "agent",
    actorId: qaEmployee.id,
    event: "auto_qa_signoff",
    targetId: task.id,
    detail: "Auto QA: " + signoff.status + ", " + statusFrom + " -> " + task.status,
    createdAt: now()
  });
  return signoff;
}

function emitLlmCalled(
  state: AppState,
  createId: IdFactory,
  now: Clock,
  { task, agent, orchestrationId, runtimeResult, error }: {
    task: Task;
    agent: Employee;
    orchestrationId: string;
    runtimeResult?: AgentRuntimeResult;
    error?: RuntimeError;
  }
): void {
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

export async function orchestrateTask(state: AppState, taskId: string, options: OrchestrateTaskOptions): Promise<OrchestrateTaskResult> {
  ensureExecutionState(state);
  const { createId, now, callLlm, requestedAgentId } = options;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    throw runtimeError("Task not found", 404);
  }

  const agent = selectAgent(state, task, requestedAgentId);
  if (!agent) {
    throw runtimeError("Task has no assigned AI employee", 400);
  }
  assertAgentCanExecute(state, task, agent);

  const template = state.agentTemplates.find((item) => item.id === agent.templateId);
  const project = state.projects.find((item) => item.id === task.projectId);
  const taskSnapshot = snapshotTask(task);
  const agentSnapshot = snapshotAgent(agent, template);
  const executionRun = createExecutionRun(state, createId, now, { taskSnapshot, agentSnapshot });
  const orchestrationId = executionRun.id;
  const startedAt = executionRun.startedAt;
  let llmEventEmitted = false;

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
    llmEventEmitted = true;
    assertArtifactAllowed(agent, runtimeResult.parsedOutput);
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

    task.status = "implemented";
    agent.status = "busy";
    agent.currentTaskId = task.id;
    agent.load = Math.min(95, Number(agent.load || 0) + 10);

    state.artifacts.unshift(artifact);
    state.executionTraces!.unshift(executionTrace);
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

    startRunStep(state, executionRun, createId, now, "execute_tools", {
      artifactId: artifact.id,
      artifactType: artifact.type
    });
    const toolInvocations = await executeArtifactToolActions({ state, task, agent, artifact, createId, now });
    artifact.toolInvocations = toolInvocations;
    executionTrace.toolInvocations = toolInvocations;
    for (const invocation of toolInvocations) {
      emitEvent(state, createId, now, {
        type: EXECUTION_EVENT_TYPES.TOOL_CALLED,
        orchestrationId,
        taskId: task.id,
        agentId: agent.id,
        artifactId: artifact.id,
        executionTraceId: executionTrace.id,
        payload: { invocation }
      });
    }
    completeRunStep(state, executionRun, createId, now, "execute_tools", {
      toolInvocationIds: toolInvocations.map((invocation) => invocation.id),
      count: toolInvocations.length
    });

    startRunStep(state, executionRun, createId, now, "qa_signoff", {
      artifactId: artifact.id,
      toolInvocationIds: toolInvocations.map((invocation) => invocation.id)
    });
    const qaSignoff = createAutomaticQaSignoff({
      state,
      task,
      builder: agent,
      artifact,
      toolInvocations,
      createId,
      now,
      orchestrationId,
      executionTraceId: executionTrace.id
    });
    completeRunStep(state, executionRun, createId, now, "qa_signoff", {
      signoffId: qaSignoff?.id || null,
      status: qaSignoff?.status || "skipped"
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
      payload: {
        artifactId: artifact.id,
        executionTraceId: executionTrace.id,
        toolInvocationIds: Array.isArray(artifact.toolInvocations) ? artifact.toolInvocations.map((invocation) => invocation.id) : [],
        qaSignoffId: qaSignoff?.id || null
      }
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
  } catch (caught) {
    const error = caught as RuntimeError;
    const completedAt = now();
    const executionTrace = buildFailedExecutionTrace(createId, taskSnapshot, agentSnapshot, error, startedAt, completedAt);
    state.executionTraces!.unshift(executionTrace);
    if (executionRun.currentStep === "run_agent" && !llmEventEmitted) {
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