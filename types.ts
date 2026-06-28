export type IdFactory = (prefix: string) => string;
export type Clock = () => string;

export type ArtifactType = "code" | "doc" | "plan" | "analysis" | string;
export type TaskStatus =
  | "todo"
  | "running"
  | "implemented"
  | "tested"
  | "reviewed"
  | "approved"
  | "waiting_approval"
  | "review"
  | "done"
  | "failed"
  | string;

export interface LlmConfig {
  provider?: "mock" | "openai" | "openai-compatible" | string;
  model?: string;
  keyRef?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  temperature?: number | string;
  timeoutMs?: number | string;
  allowMockFallback?: boolean | string;
}

export interface AgentTemplate {
  id: string;
  name: string;
  division?: string;
  summary?: string;
  deliverables?: string[];
  defaultTools?: string[];
  systemPrompt?: string;
  source?: string;
  [key: string]: unknown;
}

export interface Employee {
  id: string;
  templateId?: string;
  displayName: string;
  title: string;
  teamId?: string;
  model?: string;
  llmConfig?: LlmConfig;
  permission?: string;
  status?: string;
  load?: number;
  currentTaskId?: string | null;
  [key: string]: unknown;
}

export interface Project {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface Task {
  id: string;
  title: string;
  projectId?: string;
  ownerUserId?: string;
  status: TaskStatus;
  priority?: string;
  description?: string;
  assignedEmployeeIds: string[];
  dueDate?: string;
  parentTaskId?: string | null;
  signoffs?: TaskSignoff[];
  [key: string]: unknown;
}

export interface Artifact {
  id: string;
  type?: ArtifactType;
  title: string;
  content?: string;
  summary?: string;
  taskId?: string;
  agentId?: string;
  createdBy?: string;
  timestamp?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface ExecutionEventInput {
  type: string;
  taskId?: string | null;
  agentId?: string | null;
  artifactId?: string | null;
  executionTraceId?: string | null;
  orchestrationId?: string | null;
  payload?: Record<string, unknown>;
}

export interface ExecutionEventRecord extends ExecutionEventInput {
  id: string;
  sequence: number;
  engineVersion: string;
  aggregateType: "execution";
  aggregateId: string | null;
  timestamp: string;
}

export interface ExecutionStep {
  name: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: SerializedError | null;
}

export interface ToolInvocation {
  id: string;
  toolName: string;
  status: "waiting_approval" | "running" | "succeeded" | "failed";
  taskId: string;
  agentId: string;
  artifactId: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: SerializedError | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

export interface TaskSignoff {
  id: string;
  taskId: string;
  stage: "qa" | "review" | "product" | "release" | string;
  stageLabel: string;
  employeeId: string;
  status: "passed" | "failed" | string;
  note: string;
  createdAt: string;
  artifactId?: string;
  automatic?: boolean;
  evidence?: Record<string, unknown>;
}

export interface ExecutionRun {
  id: string;
  engineVersion: string;
  taskId: string;
  agentId: string;
  status: "running" | "succeeded" | "failed";
  currentStep: string | null;
  steps: ExecutionStep[];
  artifactIds: string[];
  executionTraceId: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: SerializedError | null;
}

export interface SerializedError {
  message: string;
  name: string;
}

export interface RuntimeError extends Error {
  executionRun?: unknown;
  status?: number;
  provider?: string;
  model?: string;
  keyRef?: string;
  baseUrl?: string;
  prompt?: string;
  llmOutput?: string;
  executionTrace?: unknown;
}

export interface Approval {
  id: string;
  taskId: string;
  requesterEmployeeId?: string | null;
  reviewerUserId?: string | null;
  status: "pending" | "approved" | "rejected" | string;
  risk?: string;
  title?: string;
  action?: string;
  createdAt?: string;
  resolvedAt?: string;
  resolutionNote?: string;
  [key: string]: unknown;
}

export interface ExecutionTrace {
  id: string;
  status: "succeeded" | "failed" | string;
  taskId: string;
  agentId: string;
  artifactId: string | null;
  provider: string;
  requestedProvider: string;
  model: string;
  keyRef: string;
  baseUrl: string;
  fallback: boolean;
  fallbackReason: string;
  responseId: string | null;
  inputTask: Record<string, unknown>;
  agent: Record<string, unknown>;
  prompt: string;
  llmOutput: string;
  parsedOutput: unknown;
  finalArtifact: unknown;
  toolInvocations?: ToolInvocation[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error: SerializedError | null;
}
export interface AppState {
  users: Array<Record<string, unknown>>;
  teams: Array<Record<string, unknown>>;
  projects: Project[];
  tasks: Task[];
  employees: Employee[];
  agentTemplates: AgentTemplate[];
  approvals: Approval[];
  artifacts: Artifact[];
  auditLogs: Array<Record<string, unknown>>;
  events?: ExecutionEventRecord[];
  executionEventCursor?: number;
  executionTraces?: ExecutionTrace[];
  executionRuns?: ExecutionRun[];
  toolInvocations?: ToolInvocation[];
  [key: string]: unknown;
}

export interface LlmResult {
  provider: string;
  requestedProvider?: string;
  model: string;
  keyRef?: string;
  baseUrl?: string;
  output: string;
  fallback?: boolean;
  fallbackReason?: string;
  responseId?: string | null;
}