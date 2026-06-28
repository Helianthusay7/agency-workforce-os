import { mkdir, writeFile } from "node:fs/promises";
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
  return path.resolve(value.trim().replace(/[。；;，,\s]+$/g, ""));
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertWritablePath(targetPath: string): void {
  const resolved = normalizeFsPath(targetPath);
  const extension = path.extname(resolved).toLowerCase();
  if (!WRITABLE_EXTENSIONS.has(extension)) {
    const error = new Error(`Tool filesystem.writeArtifact does not allow writing ${extension || "extensionless"} files`) as RuntimeError;
    error.status = 403;
    throw error;
  }

  const allowedRoots = configuredAllowedRoots().map(normalizeFsPath);
  const isAllowed = allowedRoots.some((root) => resolved === root || isWithinRoot(resolved, root));
  if (!isAllowed) {
    const error = new Error(`Tool filesystem.writeArtifact target is outside allowed roots: ${resolved}`) as RuntimeError;
    error.status = 403;
    throw error;
  }
}

function findTargetFilePath(task: Task, artifact: Artifact): string | null {
  const parts = [
    task.description || "",
    task.title || "",
    artifact.summary || "",
    ...(Array.isArray(artifact.deliverables) ? artifact.deliverables : []),
    ...(Array.isArray(artifact.nextActions) ? artifact.nextActions : [])
  ];
  const text = parts.join("\n");
  const windowsPath = text.match(/[A-Za-z]:\\[^\r\n"'<>|?*]+?\.(?:html|htm|js|css|json|md|txt)/i);
  if (windowsPath?.[0]) return normalizeFsPath(windowsPath[0]);
  return null;
}

function buildPendingActions(task: Task, artifact: Artifact): PendingToolAction[] {
  if (artifact.type !== "code") return [];
  const content = String(artifact.content || "");
  if (!content.trim()) return [];
  const targetPath = findTargetFilePath(task, artifact);
  if (!targetPath) return [];
  return [{ toolName: "filesystem.writeArtifact", targetPath, content }];
}

export function ensureToolGatewayState(state: AppState): void {
  if (!Array.isArray(state.toolInvocations)) state.toolInvocations = [];
}

export async function executeArtifactToolActions({ state, task, agent, artifact, createId, now }: ToolGatewayInput): Promise<ToolInvocation[]> {
  ensureToolGatewayState(state);
  const actions = buildPendingActions(task, artifact);
  const invocations: ToolInvocation[] = [];

  for (const action of actions) {
    const startedAt = now();
    const invocation: ToolInvocation = {
      id: createId("tool"),
      toolName: action.toolName,
      status: "running",
      taskId: task.id,
      agentId: agent.id,
      artifactId: artifact.id,
      input: {
        targetPath: action.targetPath,
        contentBytes: Buffer.byteLength(action.content, "utf8")
      },
      output: null,
      error: null,
      startedAt,
      completedAt: null,
      durationMs: null
    };
    state.toolInvocations!.unshift(invocation);

    try {
      assertWritablePath(action.targetPath);
      await mkdir(path.dirname(action.targetPath), { recursive: true });
      await writeFile(action.targetPath, action.content, "utf8");
      const completedAt = now();
      invocation.status = "succeeded";
      invocation.completedAt = completedAt;
      invocation.durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
      invocation.output = {
        targetPath: action.targetPath,
        bytesWritten: Buffer.byteLength(action.content, "utf8")
      };
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

    invocations.push(invocation);
  }

  return invocations;
}
