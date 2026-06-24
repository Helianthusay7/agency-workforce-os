function artifactTypeFor(template, task) {
  const text = `${template?.name || ""} ${template?.division || ""} ${task.title} ${task.description || ""}`.toLowerCase();
  if (/code|developer|engineer|frontend|backend|implementation|代码|实现/.test(text)) return "code";
  if (/analysis|review|risk|research|分析|审查|风险|调研/.test(text)) return "analysis";
  if (/plan|manager|strategy|roadmap|计划|规划|拆解/.test(text)) return "plan";
  return "doc";
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeParsedOutput(parsed, rawOutput, fallbackType) {
  if (!parsed || typeof parsed !== "object") {
    return {
      type: fallbackType,
      content: rawOutput,
      summary: rawOutput.slice(0, 500),
      deliverables: [],
      decisions: [],
      risks: [],
      nextActions: [],
      parseStatus: "fallback"
    };
  }

  const content = typeof parsed.content === "string" ? parsed.content : JSON.stringify(parsed.content || parsed.summary || "", null, 2);
  return {
    type: ["code", "doc", "plan", "analysis"].includes(parsed.type) ? parsed.type : fallbackType,
    content,
    summary: String(parsed.summary || content).slice(0, 1200),
    deliverables: Array.isArray(parsed.deliverables) ? parsed.deliverables : [],
    decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
    risks: Array.isArray(parsed.risks) ? parsed.risks : [],
    nextActions: Array.isArray(parsed.nextActions) ? parsed.nextActions : [],
    parseStatus: "parsed"
  };
}

export function buildRuntimePrompt({ task, agent, template, project }) {
  return [
    "You are an AI workforce employee executing a task inside AI Workforce OS.",
    "Return only valid JSON. Do not wrap it in markdown.",
    "",
    "Required JSON schema:",
    "{",
    '  "type": "code | doc | plan | analysis",',
    '  "summary": "short result summary",',
    '  "content": "complete deliverable content",',
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
    `Agent: ${agent.displayName} / ${agent.title}`,
    `Agent role: ${template?.name || agent.title}`,
    `Agent division: ${template?.division || "Unknown"}`,
    `Agent summary: ${template?.summary || "No role summary"}`,
    `Expected deliverables: ${(template?.deliverables || []).join(", ") || "general result"}`,
    `Tools: ${(template?.defaultTools || []).join(", ") || "none declared"}`,
    "",
    "Execute the task. Produce a concrete artifact that can be stored and reviewed."
  ].join("\n");
}

export async function runAgentRuntime({ task, agent, template, project, callLlm, now }) {
  const startedAt = now();
  const prompt = buildRuntimePrompt({ task, agent, template, project });
  const llmResult = await callLlm(prompt, task, agent, template, project);
  const rawOutput = String(llmResult.output || "");
  const fallbackType = artifactTypeFor(template, task);
  const parsedOutput = normalizeParsedOutput(safeJsonParse(rawOutput), rawOutput, fallbackType);
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
}
