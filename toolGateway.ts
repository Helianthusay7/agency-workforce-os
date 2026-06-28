import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AppState, Artifact, Clock, Employee, IdFactory, RuntimeError, Task, ToolInvocation } from "./types.js";

interface ToolGatewayInput {
  state: AppState;
  task: Task;
  agent: Employee;
  artifact: Artifact;
  createId: IdFactory;
  now: Clock;
}

interface PendingToolAction {
  toolName: "filesystem.writeArtifact";
  targetPath: string;
  content: string;
}

interface ToolApprovalInput {
  state: AppState;
  approvalId: string;
  createId: IdFactory;
  now: Clock;
}

const DEFAULT_ALLOWED_ROOTS = ["D:\\ai\\aigame"];
const WRITABLE_EXTENSIONS = new Set([".html", ".htm", ".js", ".css", ".json", ".md", ".txt"]);

function configuredAllowedRoots(): string[] {
  const raw = process.env.WORKFORCE_TOOL_FS_ROOTS || "";
  const roots = raw
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  return roots.length ? roots : DEFAULT_ALLOWED_ROOTS;
}

function normalizeFsPath(value: string): string {
  return path.resolve(value.trim().replace(/[??;?,s]+$/g, ""));
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function runtimeError(message: string, status = 400): RuntimeError {
  const error = new Error(message) as RuntimeError;
  error.status = status;
  return error;
}

function assertWritablePath(targetPath: string): string {
  const resolved = normalizeFsPath(targetPath);
  const extension = path.extname(resolved).toLowerCase();
  if (!WRITABLE_EXTENSIONS.has(extension)) {
    throw runtimeError(`Tool filesystem.writeArtifact does not allow writing ${extension || "extensionless"} files`, 403);
  }

  const allowedRoots = configuredAllowedRoots().map(normalizeFsPath);
  const isAllowed = allowedRoots.some((root) => resolved === root || isWithinRoot(resolved, root));
  if (!isAllowed) {
    throw runtimeError(`Tool filesystem.writeArtifact target is outside allowed roots: ${resolved}`, 403);
  }
  return resolved;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function artifactMeta(artifact: Artifact): Record<string, unknown> {
  return objectRecord(artifact.meta);
}

function buildPendingActions(artifact: Artifact): PendingToolAction[] {
  if (artifact.type !== "code") return [];
  const meta = artifactMeta(artifact);
  const rawActions = Array.isArray(meta.toolActions) ? meta.toolActions : [];
  const actions: PendingToolAction[] = [];

  for (const rawAction of rawActions) {
    const action = objectRecord(rawAction);
    if (action.toolName !== "filesystem.writeArtifact") continue;
    if (typeof action.targetPath !== "string" || !action.targetPath.trim()) continue;
    const content = typeof action.content === "string" ? action.content : String(artifact.content || "");
    if (!content.trim()) continue;
    actions.push({
      toolName: "filesystem.writeArtifact",
      targetPath: normalizeFsPath(action.targetPath),
      content
    });
  }

  return actions;
}

function latestArtifactContent(state: AppState, invocation: ToolInvocation): string {
  const artifact = state.artifacts.find((item) => item.id === invocation.artifactId);
  if (!artifact) throw runtimeError("Tool artifact not found", 404);
  return String(artifact.content || "");
}

function approvalTitle(targetPath: string): string {
  return `???????${path.basename(targetPath)}`;
}

function ensureAuditLogs(state: AppState): void {
  if (!Array.isArray(state.auditLogs)) state.auditLogs = [];
}

export function ensureToolGatewayState(state: AppState): void {
  if (!Array.isArray(state.toolInvocations)) state.toolInvocations = [];
  if (!Array.isArray(state.approvals)) state.approvals = [];
  ensureAuditLogs(state);
}

export async function executeArtifactToolActions({ state, task, agent, artifact, createId, now }: ToolGatewayInput): Promise<ToolInvocation[]> {
  ensureToolGatewayState(state);
  const actions = buildPendingActions(artifact);
  const invocations: ToolInvocation[] = [];

  for (const action of actions) {
    const targetPath = assertWritablePath(action.targetPath);
    const startedAt = now();
    const invocation: ToolInvocation = {
      id: createId("tool"),
      toolName: action.toolName,
      status: "waiting_approval",
      taskId: task.id,
      agentId: agent.id,
      artifactId: artifact.id,
      input: {
        targetPath,
        contentBytes: Buffer.byteLength(action.content, "utf8"),
        approvalRequired: true
      },
      output: null,
      error: null,
      startedAt,
      completedAt: null,
      durationMs: null
    };

    const approval = {
      id: createId("apr"),
      taskId: task.id,
      title: approvalTitle(targetPath),
      requesterEmployeeId: agent.id,
      reviewerUserId: task.ownerUserId,
      status: "pending",
      risk: "high",
      action: `??????? filesystem.writeArtifact ???${targetPath}`,
      createdAt: startedAt,
      kind: "tool_action",
      toolInvocationId: invocation.id,
      artifactId: artifact.id,
      targetPath
    };

    invocation.input.approvalId = approval.id;
    state.toolInvocations!.unshift(invocation);
    state.approvals.unshift(approval);
    state.auditLogs.unshift({
      id: createId("log"),
      actorType: "agent",
      actorId: agent.id,
      event: "requested_tool_approval",
      targetId: approval.id,
      detail: approval.title,
      createdAt: now()
    });
    invocations.push(invocation);
  }

  return invocations;
}

export async function executeApprovedToolInvocation({ state, approvalId, createId, now }: ToolApprovalInput): Promise<ToolInvocation | null> {
  ensureToolGatewayState(state);
  const approval = state.approvals.find((item) => item.id === approvalId);
  const invocationId = typeof approval?.toolInvocationId === "string" ? approval.toolInvocationId : "";
  if (!approval || !invocationId) return null;

  const invocation = state.toolInvocations!.find((item) => item.id === invocationId);
  if (!invocation) throw runtimeError("Tool invocation not found", 404);
  if (invocation.status !== "waiting_approval") return invocation;

  const targetPath = assertWritablePath(String(invocation.input.targetPath || ""));
  const artifact = state.artifacts.find((item) => item.id === invocation.artifactId);
  const content = typeof invocation.input.content === "string" ? String(invocation.input.content) : latestArtifactContent(state, invocation);
  if (!content.trim()) throw runtimeError("Tool artifact content is empty", 400);

  invocation.status = "running";
  invocation.input.approvedAt = now();
  invocation.input.approvalId = approval.id;
  const startedAt = now();

  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    const backupPath = existsSync(targetPath) ? `${targetPath}.bak-${Date.now()}` : "";
    if (backupPath) await copyFile(targetPath, backupPath);
    const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, targetPath);

    const completedAt = now();
    invocation.status = "succeeded";
    invocation.completedAt = completedAt;
    invocation.durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    invocation.output = {
      targetPath,
      bytesWritten: Buffer.byteLength(content, "utf8"),
      backupPath: backupPath || null,
      artifactId: artifact?.id || invocation.artifactId
    };
    state.auditLogs.unshift({
      id: createId("log"),
      actorType: "agent",
      actorId: invocation.agentId,
      event: "executed_tool_action",
      targetId: invocation.id,
      detail: `filesystem.writeArtifact ???${targetPath}`,
      createdAt: now()
    });
  } catch (caught) {
    const error = caught as RuntimeError;
    const completedAt = now();
    invocation.status = "failed";
    invocation.completedAt = completedAt;
    invocation.durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    invocation.error = {
      message: error.message || "Tool execution failed",
      name: error.name || "Error"
    };
    throw error;
  }

  return invocation;
}

export function rejectToolInvocation(state: AppState, approvalId: string, now: Clock): ToolInvocation | null {
  ensureToolGatewayState(state);
  const approval = state.approvals.find((item) => item.id === approvalId);
  const invocationId = typeof approval?.toolInvocationId === "string" ? approval.toolInvocationId : "";
  if (!approval || !invocationId) return null;
  const invocation = state.toolInvocations!.find((item) => item.id === invocationId);
  if (!invocation || invocation.status !== "waiting_approval") return invocation || null;
  const completedAt = now();
  invocation.status = "failed";
  invocation.completedAt = completedAt;
  invocation.durationMs = new Date(completedAt).getTime() - new Date(invocation.startedAt).getTime();
  invocation.error = { message: "Tool action was rejected", name: "ToolApprovalRejected" };
  return invocation;
}
