function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function boolOrDefault(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() !== "false";
  return fallback;
}

function resolveAgentLlmConfig(agent) {
  const employeeConfig = agent.llmConfig && typeof agent.llmConfig === "object" ? agent.llmConfig : {};
  const provider = String(employeeConfig.provider || process.env.AGENCY_LLM_PROVIDER || "mock").toLowerCase();
  const keyRef = employeeConfig.keyRef || employeeConfig.apiKeyEnv || (provider === "mock" ? "" : "OPENAI_API_KEY");

  return {
    provider,
    model: employeeConfig.model || process.env.AGENCY_LLM_MODEL || agent.model || "mock-local",
    keyRef,
    baseUrl: employeeConfig.baseUrl || process.env.AGENCY_LLM_BASE_URL || "",
    temperature: numberOrDefault(employeeConfig.temperature ?? process.env.AGENCY_LLM_TEMPERATURE, 0.2),
    timeoutMs: numberOrDefault(employeeConfig.timeoutMs ?? process.env.AGENCY_LLM_TIMEOUT_MS, 6000),
    allowMockFallback: boolOrDefault(employeeConfig.allowMockFallback ?? process.env.AGENCY_LLM_ALLOW_MOCK_FALLBACK, true)
  };
}

function extractOpenAiText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  const chunks = [];
  for (const item of payload?.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

function extractChatText(payload) {
  return String(payload?.choices?.[0]?.message?.content || "").trim();
}

function mockOutput(prompt, task, agent, template, project) {
  const deliverables = template?.deliverables?.length ? template.deliverables.join("、") : "执行结果";
  return JSON.stringify({
    type: "plan",
    meta: {
      agentId: agent.id,
      taskId: task.id
    },
    summary: `${agent.displayName} 已完成“${task.title}”的结构化执行结果。`,
    content: [
      `项目：${project?.name || "未知项目"}`,
      `任务：${task.title}`,
      `角色：${template?.name || agent.title}`,
      `交付方向：${deliverables}`,
      "结果：已分析任务目标、当前系统约束和可交付范围，形成可审阅的执行产物。",
      `Prompt snapshot:\n${prompt}`
    ].join("\n\n"),
    deliverables: template?.deliverables?.length ? template.deliverables : ["结构化执行结果"],
    decisions: ["先产出最小可审阅交付物，再根据结果继续拆分或审批。"],
    risks: ["当前为 mock LLM 输出，真实质量取决于后续配置的模型和角色知识库。"],
    nextActions: ["人工审阅交付物", "必要时拆分后续任务", "需要写操作时进入审批流程"]
  });
}

function runMockAdapter(prompt, task, agent, template, project, config, metadata = {}) {
  return {
    provider: "mock",
    requestedProvider: metadata.requestedProvider || config.provider || "mock",
    model: metadata.model || config.model || agent.model || "mock-local",
    keyRef: metadata.keyRef || config.keyRef || "",
    baseUrl: metadata.baseUrl || config.baseUrl || "",
    output: mockOutput(prompt, task, agent, template, project),
    fallback: Boolean(metadata.fallback),
    fallbackReason: metadata.fallbackReason || "",
    responseId: null
  };
}

async function fetchJsonWithTimeout(url, request, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...request, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`LLM request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function missingKeyError(config) {
  const error = new Error(`${config.keyRef || "API key"} is not configured`);
  error.provider = config.provider;
  error.model = config.model;
  error.keyRef = config.keyRef || "";
  throw error;
}

async function runOpenAiResponsesAdapter(prompt, task, agent, template, project, config) {
  const apiKey = config.keyRef ? process.env[config.keyRef] : "";
  if (!apiKey) missingKeyError(config);

  const baseUrl = config.baseUrl || "https://api.openai.com/v1";
  const { response, payload } = await fetchJsonWithTimeout(`${baseUrl.replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      input: prompt,
      temperature: config.temperature
    })
  }, config.timeoutMs);

  if (!response.ok) {
    const error = new Error(payload?.error?.message || `OpenAI request failed with HTTP ${response.status}`);
    error.provider = config.provider;
    error.model = config.model;
    error.keyRef = config.keyRef;
    throw error;
  }

  const output = extractOpenAiText(payload);
  if (!output) {
    const error = new Error("OpenAI response did not contain text output");
    error.provider = config.provider;
    error.model = config.model;
    error.keyRef = config.keyRef;
    throw error;
  }

  return {
    provider: "openai",
    requestedProvider: config.provider,
    model: config.model,
    keyRef: config.keyRef,
    baseUrl,
    output,
    fallback: false,
    fallbackReason: "",
    responseId: payload.id || null
  };
}

async function runOpenAiCompatibleChatAdapter(prompt, task, agent, template, project, config) {
  const apiKey = config.keyRef ? process.env[config.keyRef] : "";
  if (!apiKey) missingKeyError(config);

  const baseUrl = config.baseUrl || "https://api.openai.com/v1";
  const { response, payload } = await fetchJsonWithTimeout(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      messages: [{ role: "user", content: prompt }]
    })
  }, config.timeoutMs);

  if (!response.ok) {
    const error = new Error(payload?.error?.message || `OpenAI-compatible request failed with HTTP ${response.status}`);
    error.provider = config.provider;
    error.model = config.model;
    error.keyRef = config.keyRef;
    throw error;
  }

  const output = extractChatText(payload);
  if (!output) {
    const error = new Error("OpenAI-compatible response did not contain message content");
    error.provider = config.provider;
    error.model = config.model;
    error.keyRef = config.keyRef;
    throw error;
  }

  return {
    provider: "openai-compatible",
    requestedProvider: config.provider,
    model: config.model,
    keyRef: config.keyRef,
    baseUrl,
    output,
    fallback: false,
    fallbackReason: "",
    responseId: payload.id || null
  };
}

export async function runAgentLlm(prompt, task, agent, template, project) {
  const config = resolveAgentLlmConfig(agent);
  try {
    if (config.provider === "mock") {
      return runMockAdapter(prompt, task, agent, template, project, config);
    }
    if (config.provider === "openai") {
      return await runOpenAiResponsesAdapter(prompt, task, agent, template, project, config);
    }
    if (config.provider === "openai-compatible") {
      return await runOpenAiCompatibleChatAdapter(prompt, task, agent, template, project, config);
    }
    const error = new Error(`Unsupported LLM provider: ${config.provider}`);
    error.provider = config.provider;
    error.model = config.model;
    error.keyRef = config.keyRef;
    throw error;
  } catch (error) {
    if (config.allowMockFallback && config.provider !== "mock") {
      return runMockAdapter(prompt, task, agent, template, project, config, {
        requestedProvider: config.provider,
        model: config.model,
        keyRef: config.keyRef,
        baseUrl: config.baseUrl,
        fallback: true,
        fallbackReason: error.message
      });
    }
    error.provider = error.provider || config.provider;
    error.model = error.model || config.model;
    error.keyRef = error.keyRef || config.keyRef;
    throw error;
  }
}
