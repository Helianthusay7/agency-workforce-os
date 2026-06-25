const ARTIFACT_TYPES = new Set(["code", "doc", "plan", "analysis"]);

function artifactTypeFor(template, task) {
  const text = `${template?.name || ""} ${template?.division || ""} ${task.title} ${task.description || ""}`.toLowerCase();
  if (/code|developer|engineer|frontend|backend|implementation|代码|实现/.test(text)) return "code";
  if (/analysis|review|risk|research|分析|审查|风险|调研/.test(text)) return "analysis";
  if (/plan|manager|strategy|roadmap|计划|规划|拆解/.test(text)) return "plan";
  return "doc";
}

function parseJsonOutput(rawOutput) {
  try {
    return JSON.parse(rawOutput);
  } catch (error) {
    const runtimeError = new Error("Agent Runtime expected valid JSON output from LLM");
    runtimeError.name = "StructuredOutputError";
    runtimeError.llmOutput = rawOutput;
    throw runtimeError;
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`Agent Runtime output is missing required string field: ${field}`);
    error.name = "StructuredOutputError";
    throw error;
  }
  return value;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
}

function normalizeStructuredOutput(parsed, task, agent, fallbackType) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const error = new Error("Agent Runtime output must be a JSON object");
    error.name = "StructuredOutputError";
    throw error;
  }

  const meta = parsed.meta && typeof parsed.meta === "object" && !Array.isArray(parsed.meta) ? parsed.meta : {};
  const output = {
    type: ARTIFACT_TYPES.has(parsed.type) ? parsed.type : fallbackType,
    content: requireString(parsed.content, "content"),
    meta: {
      agentId: String(meta.agentId || agent.id),
      taskId: String(meta.taskId || task.id)
    },
    summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : requireString(parsed.content, "content").slice(0, 500),
    deliverables: normalizeStringArray(parsed.deliverables),
    decisions: normalizeStringArray(parsed.decisions),
    risks: normalizeStringArray(parsed.risks),
    nextActions: normalizeStringArray(parsed.nextActions),
    parseStatus: "parsed"
  };

  if (output.meta.taskId !== task.id || output.meta.agentId !== agent.id) {
    const error = new Error("Agent Runtime output meta does not match the executed task and agent");
    error.name = "StructuredOutputError";
    throw error;
  }

  return output;
}

export function buildRuntimePrompt({ task, agent, template, project }) {
  return [
    "You are an AI workforce employee executing a task inside AI Workforce OS.",
    "Return only valid JSON. Do not wrap it in markdown. Do not return plain text.",
    "",
    "Required JSON schema:",
    "{",
    '  "type": "code | doc | plan | analysis",',
    '  "content": "complete deliverable content",',
    '  "meta": {',
    `    "agentId": "${agent.id}",`,
    `    "taskId": "${task.id}"`,
    "  },",
    '  "summary": "short result summary",',
    '  "deliverables": ["concrete outputs produced"],',
    '  "decisions": ["decisions made"],',
    '  "risks": ["risks or blockers"],',
    '  "nextActions": ["recommended next execution steps"]',
    "}",
    "",
    `Task ID: ${task.id}`,
    `Task title: ${task.title}`,
    `Task status: ${task.status}`,
    `Task priority: ${task.priority}`,
    `Task description: ${task.description || "No description"}`,
    `Project: ${project?.name || "Unknown project"}`,
    `Agent ID: ${agent.id}`,
    `Agent: ${agent.displayName} / ${agent.title}`,
    `Agent role: ${template?.name || agent.title}`,
    `Agent division: ${template?.division || "Unknown"}`,
    `Agent summary: ${template?.summary || "No role summary"}`,
    `Agent system prompt: ${template?.systemPrompt || template?.summary || "No system prompt"}`,
    `Expected deliverables: ${(template?.deliverables || []).join(", ") || "general result"}`,
    `Tools: ${(template?.defaultTools || []).join(", ") || "none declared"}`,
    "",
    "Execute the task. Produce a structured artifact that can be stored and reviewed."
  ].join("\n");
}

export async function runAgentRuntime({ task, agent, template, project, callLlm, now }) {
  const startedAt = now();
  const prompt = buildRuntimePrompt({ task, agent, template, project });
  let llmResult;
  try {
    llmResult = await callLlm(prompt, task, agent, template, project);
    const rawOutput = String(llmResult.output || "");
    const fallbackType = artifactTypeFor(template, task);
    const parsedOutput = normalizeStructuredOutput(parseJsonOutput(rawOutput), task, agent, fallbackType);
    const completedAt = now();

    return {
      startedAt,
      completedAt,
      durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      prompt,
      llmResult,
      rawOutput,
      parsedOutput
    };
  } catch (error) {
    error.prompt = prompt;
    error.llmOutput = error.llmOutput || llmResult?.output || "";
    error.provider = error.provider || llmResult?.provider;
    error.model = error.model || llmResult?.model;
    error.keyRef = error.keyRef || llmResult?.keyRef;
    error.baseUrl = error.baseUrl || llmResult?.baseUrl;
    throw error;
  }
}
