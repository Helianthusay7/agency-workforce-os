import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureExecutionState, orchestrateTask } from "./orchestrator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const stateFile = path.join(dataDir, "state.json");
const port = Number(process.env.PORT || 4173);

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;

const seedState = {
  organization: {
    id: "org_nova",
    name: "NovaWorks",
    plan: "Team",
    timezone: "Asia/Shanghai"
  },
  users: [
    { id: "usr_lin", name: "林启", email: "lin@novaworks.ai", role: "Owner", teamId: "team_product", status: "active" },
    { id: "usr_chen", name: "陈溪", email: "chen@novaworks.ai", role: "Reviewer", teamId: "team_engineering", status: "active" },
    { id: "usr_mia", name: "Mia Zhang", email: "mia@novaworks.ai", role: "Operator", teamId: "team_growth", status: "active" }
  ],
  teams: [
    { id: "team_product", name: "产品", color: "#2f6f73", leadUserId: "usr_lin" },
    { id: "team_engineering", name: "研发", color: "#634f9f", leadUserId: "usr_chen" },
    { id: "team_growth", name: "增长", color: "#a35f2a", leadUserId: "usr_mia" }
  ],
  projects: [
    {
      id: "prj_workstation",
      name: "AI 员工工作站",
      code: "AWS",
      teamId: "team_product",
      status: "active",
      health: "on-track",
      repository: "D:\\ai\\agency",
      knowledgeSources: ["agency-agents 岗位模板", "产品需求池", "团队审批规则"]
    },
    {
      id: "prj_launch",
      name: "内测发布",
      code: "BETA",
      teamId: "team_growth",
      status: "planning",
      health: "watch",
      repository: "",
      knowledgeSources: ["用户访谈", "官网文案", "竞品分析"]
    }
  ],
  agentTemplates: [
    {
      id: "tpl_pm",
      name: "Product Manager",
      division: "Product",
      summary: "把模糊目标拆成范围、验收标准和排期。",
      deliverables: ["PRD", "任务拆解", "验收标准"],
      defaultTools: ["knowledge", "task-board", "artifact-write"]
    },
    {
      id: "tpl_architect",
      name: "Software Architect",
      division: "Engineering",
      summary: "设计系统边界、数据模型、集成路径和技术风险。",
      deliverables: ["架构方案", "接口草案", "风险清单"],
      defaultTools: ["repo-read", "diagram", "artifact-write"]
    },
    {
      id: "tpl_frontend",
      name: "Frontend Engineer",
      division: "Engineering",
      summary: "实现可用界面、状态流和前端交付物。",
      deliverables: ["页面代码", "组件", "交互验证"],
      defaultTools: ["repo-read", "repo-write", "browser-preview"]
    },
    {
      id: "tpl_reviewer",
      name: "Code Reviewer",
      division: "Engineering",
      summary: "审查行为回归、权限边界、测试缺口和可维护性。",
      deliverables: ["审查报告", "阻塞问题", "修复建议"],
      defaultTools: ["repo-read", "diff", "artifact-write"]
    },
    {
      id: "tpl_growth",
      name: "Growth Strategist",
      division: "Growth",
      summary: "规划内测、转化路径、用户分层和发布内容。",
      deliverables: ["发布计划", "邮件草稿", "渠道实验"],
      defaultTools: ["knowledge", "artifact-write"]
    }
  ],
  employees: [
    {
      id: "emp_iris",
      templateId: "tpl_pm",
      displayName: "Iris",
      title: "AI 产品经理",
      teamId: "team_product",
      model: "gpt-5",
      permission: "Suggest",
      status: "available",
      load: 35,
      currentTaskId: "task_scope"
    },
    {
      id: "emp_mason",
      templateId: "tpl_architect",
      displayName: "Mason",
      title: "AI 架构师",
      teamId: "team_engineering",
      model: "gpt-5",
      permission: "Execute With Approval",
      status: "busy",
      load: 68,
      currentTaskId: "task_runtime"
    },
    {
      id: "emp_nova",
      templateId: "tpl_frontend",
      displayName: "Nova",
      title: "AI 前端工程师",
      teamId: "team_engineering",
      model: "gpt-5",
      permission: "Draft",
      status: "available",
      load: 22,
      currentTaskId: null
    },
    {
      id: "emp_rhea",
      templateId: "tpl_reviewer",
      displayName: "Rhea",
      title: "AI 代码审查员",
      teamId: "team_engineering",
      model: "gpt-5",
      permission: "Read Only",
      status: "available",
      load: 18,
      currentTaskId: null
    },
    {
      id: "emp_sol",
      templateId: "tpl_growth",
      displayName: "Sol",
      title: "AI 增长策划",
      teamId: "team_growth",
      model: "gpt-5-mini",
      permission: "Suggest",
      status: "available",
      load: 41,
      currentTaskId: "task_beta"
    }
  ],
  tasks: [
    {
      id: "task_scope",
      title: "定义多人团队 MVP 范围",
      projectId: "prj_workstation",
      ownerUserId: "usr_lin",
      status: "running",
      priority: "P0",
      description: "明确组织、项目、员工池、任务、审批和日志的第一版边界。",
      assignedEmployeeIds: ["emp_iris"],
      dueDate: "2026-06-27",
      createdAt: "2026-06-23T03:20:00.000Z"
    },
    {
      id: "task_runtime",
      title: "设计 Agent Runtime Worker",
      projectId: "prj_workstation",
      ownerUserId: "usr_chen",
      status: "waiting_approval",
      priority: "P1",
      description: "定义 worker 执行隔离、工具网关和审批回调协议。",
      assignedEmployeeIds: ["emp_mason", "emp_rhea"],
      dueDate: "2026-06-30",
      createdAt: "2026-06-23T04:00:00.000Z"
    },
    {
      id: "task_beta",
      title: "准备内测用户招募节奏",
      projectId: "prj_launch",
      ownerUserId: "usr_mia",
      status: "todo",
      priority: "P2",
      description: "规划 30 个种子团队的招募、访谈和反馈收集。",
      assignedEmployeeIds: ["emp_sol"],
      dueDate: "2026-07-05",
      createdAt: "2026-06-23T05:10:00.000Z"
    }
  ],
  approvals: [
    {
      id: "apr_runtime",
      taskId: "task_runtime",
      title: "允许 Mason 创建 worker 协议草案",
      requesterEmployeeId: "emp_mason",
      reviewerUserId: "usr_chen",
      status: "pending",
      risk: "medium",
      action: "生成接口文档和 sandbox 权限表",
      createdAt: "2026-06-23T04:40:00.000Z"
    }
  ],
  artifacts: [
    {
      id: "art_scope",
      taskId: "task_scope",
      type: "plan",
      title: "MVP 范围草案",
      createdBy: "emp_iris",
      updatedAt: "2026-06-23T05:25:00.000Z",
      summary: "第一版聚焦团队对象、AI 员工池、任务流转、审批和交付物归档。"
    },
    {
      id: "art_runtime",
      taskId: "task_runtime",
      type: "architecture",
      title: "Runtime Worker 边界",
      createdBy: "emp_mason",
      updatedAt: "2026-06-23T05:42:00.000Z",
      summary: "Worker 只通过 Tool Gateway 执行动作，所有写操作进入审批队列。"
    }
  ],
  auditLogs: [
    { id: "log_1", actorType: "user", actorId: "usr_lin", event: "created_task", targetId: "task_scope", detail: "创建任务：定义多人团队 MVP 范围", createdAt: "2026-06-23T03:20:00.000Z" },
    { id: "log_2", actorType: "agent", actorId: "emp_iris", event: "created_artifact", targetId: "art_scope", detail: "生成 MVP 范围草案", createdAt: "2026-06-23T05:25:00.000Z" },
    { id: "log_3", actorType: "agent", actorId: "emp_mason", event: "requested_approval", targetId: "apr_runtime", detail: "请求审批 Runtime Worker 协议草案", createdAt: "2026-06-23T04:40:00.000Z" }
  ],
  events: [],
  executionTraces: []
};

async function ensureState() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(stateFile)) {
    await saveState(seedState);
  }
}

async function loadState() {
  await ensureState();
  const raw = await readFile(stateFile, "utf8");
  return JSON.parse(raw);
}

async function saveState(state) {
  await writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function notFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("Invalid JSON body");
    err.status = 400;
    throw err;
  }
}

function addLog(state, entry) {
  state.auditLogs.unshift({
    id: id("log"),
    createdAt: now(),
    ...entry
  });
}

function assignEmployeesToTask(state, task, employeeIds, loadDelta = 12) {
  for (const employee of state.employees) {
    if (employeeIds.includes(employee.id)) {
      employee.currentTaskId = task.id;
      employee.status = "busy";
      employee.load = Math.min(95, Number(employee.load || 0) + loadDelta);
    }
  }
}

function releaseEmployeesFromTask(state, task) {
  for (const employee of state.employees) {
    if (!task.assignedEmployeeIds.includes(employee.id)) continue;

    const nextTask = state.tasks.find((item) => {
      return item.id !== task.id && item.status !== "done" && item.assignedEmployeeIds.includes(employee.id);
    });

    employee.currentTaskId = nextTask?.id || null;
    employee.status = nextTask ? "busy" : "available";
    employee.load = Math.max(0, Number(employee.load || 0) - 18);
  }
}



function ensureChatState(state) {
  if (!Array.isArray(state.chatRooms)) state.chatRooms = [];
  if (!Array.isArray(state.chatMessages)) state.chatMessages = [];
}

function ensureRuntimeState(state) {
  if (!Array.isArray(state.executionTraces)) state.executionTraces = [];
  if (!Array.isArray(state.events)) state.events = [];
}

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

function snapshotAgent(employee, template) {
  return {
    id: employee.id,
    displayName: employee.displayName,
    title: employee.title,
    templateId: employee.templateId,
    role: template?.name || employee.title,
    model: employee.model,
    permission: employee.permission
  };
}

function ensureTaskChatRoom(state, task) {
  ensureChatState(state);
  let room = state.chatRooms.find((item) => item.taskId === task.id);
  if (!room) {
    room = {
      id: `room_${task.id}`,
      type: "task",
      taskId: task.id,
      title: task.title,
      participantIds: [...new Set([task.ownerUserId, ...task.assignedEmployeeIds].filter(Boolean))],
      createdAt: now()
    };
    state.chatRooms.unshift(room);
  } else {
    room.title = task.title;
    room.participantIds = [...new Set([...room.participantIds, task.ownerUserId, ...task.assignedEmployeeIds].filter(Boolean))];
  }
  return room;
}


function buildSubtasks(task, project) {
  const base = task.title.replace(/^定义|设计|准备|实现/, "").trim() || task.title;
  return [
    {
      title: `明确 ${base} 的目标和验收标准`,
      description: `基于父任务“${task.title}”梳理目标、边界、输入输出和验收标准。`
    },
    {
      title: `设计 ${base} 的执行流程`,
      description: `说明 ${project?.name || "当前项目"} 中该任务的执行步骤、依赖对象和风险点。`
    },
    {
      title: `产出 ${base} 的最小交付物`,
      description: `在不重构系统的前提下，产出可审阅的文档、代码或结果草案。`
    },
    {
      title: `审查 ${base} 的结果并沉淀改进项`,
      description: `检查交付物质量、遗漏风险和下一步优化建议。`
    }
  ];
}

function buildDiscussionMessage(task, employee, template, project, index) {
  const role = template?.name || employee.title;
  const focus = template?.deliverables?.[index % Math.max(template.deliverables.length, 1)] || "下一步交付";
  return `${employee.displayName}（${role}）：我建议围绕“${task.title}”先推进 ${focus}。当前项目是 ${project?.name || "未知项目"}，需要保持最小改动、明确交付物，并把需要人工确认的动作进入审批。`;
}

function buildAgentPrompt(state, task, employee, template, project) {
  return [
    `Task: ${task.title}`,
    `Status: ${task.status}`,
    `Project: ${project?.name || "Unknown project"}`,
    `Agent: ${employee.displayName} / ${employee.title}`,
    `Role: ${template?.name || employee.title}`,
    `Role summary: ${template?.summary || "No role summary"}`,
    `Task description: ${task.description || "No description"}`,
    `Expected deliverables: ${(template?.deliverables || []).join(", ") || "general result"}`
  ].join("\n");
}

function runMockLlm(prompt, task, employee, template, project) {
  const deliverables = template?.deliverables?.length ? template.deliverables.join("、") : "执行结果";
  return JSON.stringify({
    type: "plan",
    summary: `${employee.displayName} 已完成“${task.title}”的结构化执行结果。`,
    content: [
      `项目：${project?.name || "未知项目"}`,
      `任务：${task.title}`,
      `角色：${template?.name || employee.title}`,
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

function getLlmConfig(employee) {
  const requestedProvider = (process.env.AGENCY_LLM_PROVIDER || "mock").toLowerCase();
  return {
    requestedProvider,
    model: process.env.AGENCY_LLM_MODEL || employee.model || "mock-local",
    allowMockFallback: process.env.AGENCY_LLM_ALLOW_MOCK_FALLBACK !== "false",
    timeoutMs: Number(process.env.AGENCY_LLM_TIMEOUT_MS || 6000)
  };
}

function runMockAdapter(prompt, task, employee, template, project, metadata = {}) {
  return {
    provider: "mock",
    requestedProvider: metadata.requestedProvider || "mock",
    model: metadata.model || employee.model || "mock-local",
    output: runMockLlm(prompt, task, employee, template, project),
    fallback: Boolean(metadata.fallback),
    fallbackReason: metadata.fallbackReason || "",
    responseId: null
  };
}

async function runOpenAiAdapter(prompt, task, employee, template, project, config) {
  if (!process.env.OPENAI_API_KEY) {
    if (config.allowMockFallback) {
      return runMockAdapter(prompt, task, employee, template, project, {
        requestedProvider: "openai",
        model: config.model,
        fallback: true,
        fallbackReason: "OPENAI_API_KEY is not configured"
      });
    }
    const error = new Error("OPENAI_API_KEY is not configured");
    error.provider = "openai";
    error.model = config.model;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: config.model,
        input: prompt
      })
    });
  } catch (error) {
    const message = error.name === "AbortError" ? `OpenAI request timed out after ${config.timeoutMs}ms` : error.message;
    if (config.allowMockFallback) {
      return runMockAdapter(prompt, task, employee, template, project, {
        requestedProvider: "openai",
        model: config.model,
        fallback: true,
        fallbackReason: message
      });
    }
    error.provider = "openai";
    error.model = config.model;
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `OpenAI request failed with HTTP ${response.status}`;
    if (config.allowMockFallback) {
      return runMockAdapter(prompt, task, employee, template, project, {
        requestedProvider: "openai",
        model: config.model,
        fallback: true,
        fallbackReason: message
      });
    }
    const error = new Error(message);
    error.provider = "openai";
    error.model = config.model;
    throw error;
  }

  const output = extractOpenAiText(payload);
  if (!output) {
    const error = new Error("OpenAI response did not contain text output");
    error.provider = "openai";
    error.model = config.model;
    throw error;
  }

  return {
    provider: "openai",
    requestedProvider: "openai",
    model: config.model,
    output,
    fallback: false,
    fallbackReason: "",
    responseId: payload.id || null
  };
}

async function runLlm(prompt, task, employee, template, project) {
  const config = getLlmConfig(employee);
  if (config.requestedProvider === "openai") {
    return runOpenAiAdapter(prompt, task, employee, template, project, config);
  }
  return runMockAdapter(prompt, task, employee, template, project, {
    requestedProvider: config.requestedProvider,
    model: config.model
  });
}

function buildExecutionTrace({ taskSnapshot, agentSnapshot, prompt, llmResult, artifact, startedAt, completedAt }) {
  return {
    id: id("exec"),
    status: "succeeded",
    taskId: taskSnapshot.id,
    agentId: agentSnapshot.id,
    artifactId: artifact.id,
    provider: llmResult.provider,
    requestedProvider: llmResult.requestedProvider || llmResult.provider,
    model: llmResult.model,
    fallback: Boolean(llmResult.fallback),
    fallbackReason: llmResult.fallbackReason || "",
    responseId: llmResult.responseId || null,
    inputTask: taskSnapshot,
    agent: agentSnapshot,
    prompt,
    llmOutput: llmResult.output,
    finalArtifact: {
      id: artifact.id,
      taskId: artifact.taskId,
      type: artifact.type,
      title: artifact.title,
      createdBy: artifact.createdBy,
      summary: artifact.summary,
      updatedAt: artifact.updatedAt
    },
    startedAt,
    completedAt,
    durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    error: null
  };
}

function buildFailedExecutionTrace({ taskSnapshot, agentSnapshot, prompt, llmResult, error, startedAt, completedAt }) {
  return {
    id: id("exec"),
    status: "failed",
    taskId: taskSnapshot.id,
    agentId: agentSnapshot.id,
    artifactId: null,
    provider: llmResult?.provider || error.provider || "unknown",
    requestedProvider: llmResult?.requestedProvider || error.provider || "unknown",
    model: llmResult?.model || error.model || agentSnapshot.model || "unknown",
    fallback: Boolean(llmResult?.fallback),
    fallbackReason: llmResult?.fallbackReason || "",
    responseId: llmResult?.responseId || null,
    inputTask: taskSnapshot,
    agent: agentSnapshot,
    prompt,
    llmOutput: llmResult?.output || "",
    finalArtifact: null,
    startedAt,
    completedAt,
    durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    error: {
      message: error.message || "Agent Runtime execution failed",
      name: error.name || "Error"
    }
  };
}

function deriveDashboard(state) {
  const activeTasks = state.tasks.filter((task) => task.status !== "done").length;
  const pendingApprovals = state.approvals.filter((approval) => approval.status === "pending").length;
  const availableEmployees = state.employees.filter((employee) => employee.status === "available").length;
  const projectsAtRisk = state.projects.filter((project) => project.health !== "on-track").length;
  return {
    activeTasks,
    pendingApprovals,
    availableEmployees,
    projectsAtRisk
  };
}

async function handleApi(req, res, url) {
  const state = await loadState();
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/state") {
    ensureChatState(state);
    ensureRuntimeState(state);
    ensureExecutionState(state);
    sendJson(res, 200, { ...state, dashboard: deriveDashboard(state) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/tasks") {
    const body = await readBody(req);
    const task = {
      id: id("task"),
      title: String(body.title || "未命名任务"),
      projectId: body.projectId || state.projects[0]?.id,
      ownerUserId: body.ownerUserId || state.users[0]?.id,
      status: "todo",
      priority: body.priority || "P2",
      description: String(body.description || ""),
      assignedEmployeeIds: Array.isArray(body.assignedEmployeeIds) ? body.assignedEmployeeIds : [],
      dueDate: body.dueDate || "",
      createdAt: now()
    };
    state.tasks.unshift(task);
    assignEmployeesToTask(state, task, task.assignedEmployeeIds);
    addLog(state, {
      actorType: "user",
      actorId: task.ownerUserId,
      event: "created_task",
      targetId: task.id,
      detail: `创建任务：${task.title}`
    });
    await saveState(state);
    sendJson(res, 201, task);
    return;
  }

  const taskStatusMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/status$/);
  if (req.method === "PATCH" && taskStatusMatch) {
    const body = await readBody(req);
    const task = state.tasks.find((item) => item.id === taskStatusMatch[1]);
    if (!task) return notFound(res);
    task.status = body.status || task.status;
    if (task.status === "running") {
      assignEmployeesToTask(state, task, task.assignedEmployeeIds, 8);
    }
    if (task.status === "done") {
      releaseEmployeesFromTask(state, task);
    }
    addLog(state, {
      actorType: "user",
      actorId: body.actorId || state.users[0]?.id,
      event: "updated_task_status",
      targetId: task.id,
      detail: `任务状态更新为 ${task.status}`
    });
    await saveState(state);
    sendJson(res, 200, task);
    return;
  }

  const taskAssignMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/assign$/);
  if (req.method === "POST" && taskAssignMatch) {
    const body = await readBody(req);
    const task = state.tasks.find((item) => item.id === taskAssignMatch[1]);
    if (!task) return notFound(res);
    const employeeIds = Array.isArray(body.employeeIds) ? body.employeeIds : [];
    const existingEmployeeIds = new Set(task.assignedEmployeeIds);
    const newEmployeeIds = employeeIds.filter((employeeId) => !existingEmployeeIds.has(employeeId));
    task.assignedEmployeeIds = [...new Set([...task.assignedEmployeeIds, ...employeeIds])];
    assignEmployeesToTask(state, task, newEmployeeIds, 18);
    addLog(state, {
      actorType: "user",
      actorId: body.actorId || state.users[0]?.id,
      event: "assigned_employees",
      targetId: task.id,
      detail: `指派 AI 员工：${employeeIds.join(", ")}`
    });
    await saveState(state);
    sendJson(res, 200, task);
    return;
  }

  if (req.method === "POST" && pathname === "/api/employees") {
    const body = await readBody(req);
    const template = state.agentTemplates.find((item) => item.id === body.templateId) || state.agentTemplates[0];
    const employee = {
      id: id("emp"),
      templateId: template.id,
      displayName: String(body.displayName || template.name.split(" ")[0]),
      title: String(body.title || `AI ${template.name}`),
      teamId: body.teamId || state.teams[0]?.id,
      model: body.model || "gpt-5",
      permission: body.permission || "Suggest",
      status: "available",
      load: 0,
      currentTaskId: null
    };
    state.employees.push(employee);
    addLog(state, {
      actorType: "user",
      actorId: body.actorId || state.users[0]?.id,
      event: "created_employee",
      targetId: employee.id,
      detail: `创建 AI 员工：${employee.displayName}`
    });
    await saveState(state);
    sendJson(res, 201, employee);
    return;
  }

  const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/resolve$/);
  if (req.method === "POST" && approvalMatch) {
    const body = await readBody(req);
    const approval = state.approvals.find((item) => item.id === approvalMatch[1]);
    if (!approval) return notFound(res);
    approval.status = body.status === "approved" ? "approved" : "rejected";
    approval.resolvedAt = now();
    approval.resolutionNote = String(body.note || "");
    addLog(state, {
      actorType: "user",
      actorId: approval.reviewerUserId,
      event: "resolved_approval",
      targetId: approval.id,
      detail: `${approval.title}：${approval.status}`
    });
    await saveState(state);
    sendJson(res, 200, approval);
    return;
  }

  const taskApprovalMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/approvals$/);
  if (req.method === "POST" && taskApprovalMatch) {
    const body = await readBody(req);
    const task = state.tasks.find((item) => item.id === taskApprovalMatch[1]);
    if (!task) return notFound(res);
    const existingApproval = state.approvals.find((item) => item.taskId === task.id && item.status === "pending");
    if (existingApproval) {
      task.status = "waiting_approval";
      await saveState(state);
      sendJson(res, 200, existingApproval);
      return;
    }
    const approval = {
      id: id("apr"),
      taskId: task.id,
      title: String(body.title || `审批：${task.title}`),
      requesterEmployeeId: body.requesterEmployeeId || task.assignedEmployeeIds[0] || null,
      reviewerUserId: body.reviewerUserId || task.ownerUserId,
      status: "pending",
      risk: body.risk || "medium",
      action: String(body.action || ""),
      createdAt: now()
    };
    task.status = "waiting_approval";
    state.approvals.unshift(approval);
    addLog(state, {
      actorType: "agent",
      actorId: approval.requesterEmployeeId,
      event: "requested_approval",
      targetId: approval.id,
      detail: approval.title
    });
    await saveState(state);
    sendJson(res, 201, approval);
    return;
  }
  const taskBreakdownMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/breakdown$/);
  if (req.method === "POST" && taskBreakdownMatch) {
    const task = state.tasks.find((item) => item.id === taskBreakdownMatch[1]);
    if (!task) return notFound(res);

    const existingSubtasks = state.tasks.filter((item) => item.parentTaskId === task.id);
    if (existingSubtasks.length) {
      sendJson(res, 200, { parentTask: task, subtasks: existingSubtasks, reused: true });
      return;
    }

    const project = state.projects.find((item) => item.id === task.projectId);
    const pmEmployee = state.employees.find((employee) => task.assignedEmployeeIds.includes(employee.id)) || state.employees.find((employee) => employee.templateId === "tpl_pm") || state.employees[0];
    const specs = buildSubtasks(task, project);
    const subtasks = specs.map((spec, index) => ({
      id: id("task"),
      parentTaskId: task.id,
      title: spec.title,
      projectId: task.projectId,
      ownerUserId: task.ownerUserId,
      status: "todo",
      priority: index === 0 ? task.priority : "P2",
      description: spec.description,
      assignedEmployeeIds: pmEmployee ? [pmEmployee.id] : [],
      dueDate: task.dueDate || "",
      createdAt: now()
    }));

    state.tasks.unshift(...subtasks);
    for (const subtask of subtasks) {
      assignEmployeesToTask(state, subtask, subtask.assignedEmployeeIds, 6);
    }

    const artifact = {
      id: id("art"),
      taskId: task.id,
      type: "plan",
      title: `任务拆解计划：${task.title}`,
      createdBy: pmEmployee?.id || task.ownerUserId,
      updatedAt: now(),
      summary: subtasks.map((subtask, index) => `${index + 1}. ${subtask.title}`).join("\n")
    };
    state.artifacts.unshift(artifact);
    addLog(state, {
      actorType: pmEmployee ? "agent" : "user",
      actorId: pmEmployee?.id || task.ownerUserId,
      event: "broke_down_task",
      targetId: task.id,
      detail: `拆解任务：${task.title}`
    });
    addLog(state, {
      actorType: pmEmployee ? "agent" : "user",
      actorId: pmEmployee?.id || task.ownerUserId,
      event: "created_artifact",
      targetId: artifact.id,
      detail: `创建交付物：${artifact.title}`
    });
    await saveState(state);
    sendJson(res, 201, { parentTask: task, subtasks, artifact });
    return;
  }

  const taskChatMessageMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/chat\/messages$/);
  if (req.method === "POST" && taskChatMessageMatch) {
    const body = await readBody(req);
    const task = state.tasks.find((item) => item.id === taskChatMessageMatch[1]);
    if (!task) return notFound(res);
    const room = ensureTaskChatRoom(state, task);
    const actorId = body.actorId || task.ownerUserId || state.users[0]?.id;
    const message = {
      id: id("msg"),
      roomId: room.id,
      taskId: task.id,
      actorType: state.employees.some((employee) => employee.id === actorId) ? "agent" : "user",
      actorId,
      content: String(body.content || ""),
      createdAt: now()
    };
    state.chatMessages.push(message);
    addLog(state, {
      actorType: message.actorType,
      actorId: message.actorId,
      event: "created_chat_message",
      targetId: task.id,
      detail: `新增任务讨论消息：${task.title}`
    });
    await saveState(state);
    sendJson(res, 201, { room, message });
    return;
  }

  const taskChatRoundMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/chat\/agent-round$/);
  if (req.method === "POST" && taskChatRoundMatch) {
    const task = state.tasks.find((item) => item.id === taskChatRoundMatch[1]);
    if (!task) return notFound(res);
    const room = ensureTaskChatRoom(state, task);
    const project = state.projects.find((item) => item.id === task.projectId);
    const employees = task.assignedEmployeeIds.map((employeeId) => state.employees.find((employee) => employee.id === employeeId)).filter(Boolean);
    if (!employees.length) {
      sendJson(res, 400, { error: "Task has no assigned AI employee" });
      return;
    }

    const messages = employees.map((employee, index) => {
      const template = state.agentTemplates.find((item) => item.id === employee.templateId);
      return {
        id: id("msg"),
        roomId: room.id,
        taskId: task.id,
        actorType: "agent",
        actorId: employee.id,
        content: buildDiscussionMessage(task, employee, template, project, index),
        createdAt: now()
      };
    });

    const summary = [
      `AI 讨论纪要：${task.title}`,
      `参与员工：${employees.map((employee) => employee.displayName).join("、")}`,
      "结论：先围绕任务目标形成最小可交付结果，再将高风险动作进入审批，交付内容沉淀为 artifact。",
      "下一步：由负责人审阅讨论结论，确认是否继续执行 Agent Runtime 或拆分子任务。"
    ].join("\n");

    const artifact = {
      id: id("art"),
      taskId: task.id,
      type: "discussion",
      title: `AI 讨论纪要：${task.title}`,
      createdBy: employees[0].id,
      updatedAt: now(),
      summary
    };

    state.chatMessages.push(...messages);
    state.artifacts.unshift(artifact);
    addLog(state, {
      actorType: "agent",
      actorId: employees[0].id,
      event: "ran_agent_discussion",
      targetId: task.id,
      detail: `AI 员工完成一轮任务讨论：${task.title}`
    });
    addLog(state, {
      actorType: "agent",
      actorId: employees[0].id,
      event: "created_artifact",
      targetId: artifact.id,
      detail: `创建交付物：${artifact.title}`
    });
    await saveState(state);
    sendJson(res, 201, { room, messages, artifact });
    return;
  }

  const taskRunMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/run$/);
  if (req.method === "POST" && taskRunMatch) {
    const body = await readBody(req);
    ensureRuntimeState(state);
    ensureExecutionState(state);
    try {
      const result = await orchestrateTask(state, taskRunMatch[1], {
        requestedAgentId: body.employeeId,
        createId: id,
        now,
        callLlm: runLlm
      });
      addLog(state, {
        actorType: "agent",
        actorId: result.agent.id,
        event: "ran_agent_runtime",
        targetId: result.task.id,
        detail: `${result.agent.displayName} 执行任务并生成交付物：${result.artifact.title}；trace=${result.executionTrace.id}`
      });
      addLog(state, {
        actorType: "agent",
        actorId: result.agent.id,
        event: "created_artifact",
        targetId: result.artifact.id,
        detail: `创建交付物：${result.artifact.title}`
      });
      await saveState(state);
      sendJson(res, 201, result);
    } catch (error) {
      if (error.status === 404) return notFound(res);
      if (error.status === 400) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      addLog(state, {
        actorType: "agent",
        actorId: error.executionTrace?.agentId || body.employeeId || null,
        event: "failed_agent_runtime",
        targetId: taskRunMatch[1],
        detail: `Agent Runtime 执行失败：${error.message || "Unknown error"}；trace=${error.executionTrace?.id || "none"}`
      });
      await saveState(state);
      sendJson(res, 500, { error: error.message || "Agent Runtime execution failed", executionTrace: error.executionTrace });
    }
    return;
  }

  const taskArtifactMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/artifacts$/);
  if (req.method === "POST" && taskArtifactMatch) {
    const body = await readBody(req);
    const task = state.tasks.find((item) => item.id === taskArtifactMatch[1]);
    if (!task) return notFound(res);
    const artifact = {
      id: id("art"),
      taskId: task.id,
      type: body.type || "note",
      title: String(body.title || "未命名交付物"),
      createdBy: body.createdBy || task.assignedEmployeeIds[0] || state.users[0]?.id,
      updatedAt: now(),
      summary: String(body.summary || "")
    };
    state.artifacts.unshift(artifact);
    addLog(state, {
      actorType: state.employees.some((employee) => employee.id === artifact.createdBy) ? "agent" : "user",
      actorId: artifact.createdBy,
      event: "created_artifact",
      targetId: artifact.id,
      detail: `创建交付物：${artifact.title}`
    });
    await saveState(state);
    sendJson(res, 201, artifact);
    return;
  }

  notFound(res);
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) return notFound(res);

  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml"
    };
    res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    notFound(res);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "Server error" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Agency Team Workstation running at http://127.0.0.1:${port}`);
});

