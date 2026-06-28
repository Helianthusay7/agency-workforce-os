import http from "node:http";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureExecutionState, orchestrateTask } from "./orchestrator.js";
import { EXECUTION_EVENT_TYPES, appendEvent } from "./eventStore.js";
import { runAgentLlm } from "./providerAdapters.js";
import { executeApprovedToolInvocation, rejectToolInvocation } from "./toolGateway.js";
import { aiEmployeeTitleForTemplate, localizeTemplateName } from "./templateLocalization.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = existsSync(path.join(__dirname, "public")) ? __dirname : path.resolve(__dirname, "..");
const publicDir = path.join(appRoot, "public");
const dataDir = path.join(appRoot, "data");
const stateFile = path.join(dataDir, "state.json");
const port = Number(process.env.PORT || 4173);
const maxJsonBodyBytes = Number(process.env.AGENCY_MAX_BODY_BYTES || 2 * 1024 * 1024);
const apiToken = process.env.AGENCY_API_TOKEN || "";
const allowedOrigins = new Set((process.env.AGENCY_ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean));
const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
const DEFAULT_LLM_MODEL = "gpt-5.4-mini";
declare global {
    interface Error {
        status?: number;
        provider?: string;
        model?: string;
    }
}

const douyinOpsTemplate = {
    id: "tpl_douyin_ops",
    source: "TzFilm-Douyin-Tool",
    sourceRepo: "https://github.com/TradingAi666/TzFilm-Douyin-Tool",
    sourcePath: "SKILL.md",
    skill: "douyin-creator-scraping",
    name: localizeTemplateName("Douyin Operations Analyst"),
    sourceName: "Douyin Operations Analyst",
    division: "Growth",
    summary: "Analyze Douyin creator-center exports, track video metrics, forecast performance, draft comment replies, and require approval before automated platform actions.",
    deliverables: ["Douyin performance report", "Video growth trend analysis", "Comment reply draft", "Automation risk note"],
    defaultTools: [
        "douyin_hourly.py",
        "douyin_new_video_tracker.py",
        "prediction_query.py",
        "auto_reply.py",
        "telegram-push",
        "artifact-write"
    ],
    toolPolicies: {
        readOnly: ["douyin_hourly.py", "douyin_new_video_tracker.py", "prediction_query.py"],
        requiresApproval: ["auto_reply.py", "browser-automation", "telegram-push"],
        platformRisk: "Conservative frequency is required. Automated replies and browser automation may trigger Douyin platform risk controls."
    },
    runtimeRequirements: {
        os: "macOS-oriented upstream scripts; Windows requires an adapter or remote runner.",
        browser: "Chrome logged into creator.douyin.com",
        storage: "SQLite database produced by the upstream scraping scripts"
    },
    systemPrompt: [
        "You are a Douyin Operations Analyst inside AI Workforce OS.",
        "Use the TzFilm-Douyin-Tool skill as your operating playbook.",
        "Your job is to analyze Douyin creator-center data, video metric snapshots, trend changes, prediction results, and comments.",
        "You may produce analysis, plans, reply drafts, and risk notes.",
        "Do not claim that data was scraped unless an artifact or tool result is provided.",
        "Do not perform automated replies, browser automation, posting, publishing, or external notifications without explicit approval.",
        "When a task asks for platform action, return an approval-ready plan with risk, target scope, frequency, and rollback instructions.",
        "Always return structured JSON according to the Agent Runtime schema."
    ].join("\n")
};
const douyinOpsEmployee = {
    id: "emp_douyin_ops",
    templateId: "tpl_douyin_ops",
    displayName: "Tao",
    title: aiEmployeeTitleForTemplate(douyinOpsTemplate.name),
    teamId: "team_growth",
    model: "gpt-5.4-mini",
    llmConfig: {
        provider: "mock",
        model: "gpt-5.4-mini",
        keyRef: "",
        baseUrl: "",
        temperature: 0.2,
        timeoutMs: 30000,
        allowMockFallback: true
    },
    permission: "Suggest",
    source: "TzFilm-Douyin-Tool",
    division: "Growth",
    skills: douyinOpsTemplate.deliverables,
    tools: douyinOpsTemplate.defaultTools,
    systemPromptSource: "template.systemPrompt",
    status: "available",
    load: 0,
    currentTaskId: null
};
const governanceTemplates = [
    {
        id: "tpl_builder",
        name: localizeTemplateName("Builder AI"),
        sourceName: "Builder AI",
        division: "Engineering",
        summary: "Implements scoped changes and produces execution artifacts for downstream QA and review.",
        deliverables: ["Implementation artifact", "Change summary", "Verification notes"],
        defaultTools: ["repo-read", "repo-write", "artifact-write"]
    },
    {
        id: "tpl_qa",
        name: localizeTemplateName("QA AI"),
        sourceName: "QA AI",
        division: "Engineering",
        summary: "Validates behavior against the original requirement by running tests, checking API responses, and recording regressions.",
        deliverables: ["Test report", "Regression notes", "Reproduction steps"],
        defaultTools: ["repo-read", "test-runner", "browser-preview", "artifact-write"]
    },
    {
        id: "tpl_product_reviewer",
        name: localizeTemplateName("Product AI"),
        sourceName: "Product AI",
        division: "Product",
        summary: "Checks whether the implementation satisfies the user goal, scope, and acceptance criteria before approval.",
        deliverables: ["Product acceptance report", "Scope gaps", "Decision notes"],
        defaultTools: ["knowledge", "artifact-write"]
    },
    {
        id: "tpl_release",
        name: localizeTemplateName("Release AI"),
        sourceName: "Release AI",
        division: "Operations",
        summary: "Prepares the final release decision, changelog, rollback notes, and completion gate.",
        deliverables: ["Release notes", "Risk summary", "Go-live checklist"],
        defaultTools: ["repo-read", "artifact-write"]
    }
];
const governanceEmployees = [
    {
        id: "emp_builder_ai",
        templateId: "tpl_builder",
        displayName: "Builder",
        title: "AI 开发工程师",
        teamId: "team_engineering",
        model: DEFAULT_LLM_MODEL,
        llmConfig: { provider: "mock", model: DEFAULT_LLM_MODEL, keyRef: "", temperature: 0.2, timeoutMs: 6000, allowMockFallback: true },
        permission: "Execute With Approval",
        status: "available",
        load: 0,
        currentTaskId: null
    },
    {
        id: "emp_qa_ai",
        templateId: "tpl_qa",
        displayName: "QA",
        title: "AI 测试工程师",
        teamId: "team_engineering",
        model: DEFAULT_LLM_MODEL,
        llmConfig: { provider: "mock", model: DEFAULT_LLM_MODEL, keyRef: "", temperature: 0.1, timeoutMs: 6000, allowMockFallback: true },
        permission: "Read Only",
        status: "available",
        load: 0,
        currentTaskId: null
    },
    {
        id: "emp_product_ai",
        templateId: "tpl_product_reviewer",
        displayName: "Product",
        title: "AI 产品验收员",
        teamId: "team_product",
        model: DEFAULT_LLM_MODEL,
        llmConfig: { provider: "mock", model: DEFAULT_LLM_MODEL, keyRef: "", temperature: 0.2, timeoutMs: 6000, allowMockFallback: true },
        permission: "Suggest",
        status: "available",
        load: 0,
        currentTaskId: null
    },
    {
        id: "emp_release_ai",
        templateId: "tpl_release",
        displayName: "Release",
        title: "AI 发布管理员",
        teamId: "team_growth",
        model: DEFAULT_LLM_MODEL,
        llmConfig: { provider: "mock", model: DEFAULT_LLM_MODEL, keyRef: "", temperature: 0.2, timeoutMs: 6000, allowMockFallback: true },
        permission: "Suggest",
        status: "available",
        load: 0,
        currentTaskId: null
    }
];
const governanceStages = {
    qa: {
        label: "\u4eba\u5de5 QA \u9a8c\u8bc1",
        from: "implemented",
        to: "tested",
        templateIds: ["tpl_qa"],
        defaultEmployeeId: "emp_qa_ai"
    },
    review: {
        label: "Independent review",
        from: "tested",
        to: "reviewed",
        templateIds: ["tpl_reviewer"],
        defaultEmployeeId: "emp_rhea"
    },
    product: {
        label: "Product acceptance",
        from: "reviewed",
        to: "approved",
        templateIds: ["tpl_product_reviewer", "tpl_pm"],
        defaultEmployeeId: "emp_product_ai"
    },
    release: {
        label: "Release gate",
        from: "approved",
        to: "done",
        templateIds: ["tpl_release"],
        defaultEmployeeId: "emp_release_ai"
    }
};
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
            repository: "",
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
        },
        douyinOpsTemplate
    ],
    employees: [
        {
            id: "emp_iris",
            templateId: "tpl_pm",
            displayName: "Iris",
            title: "AI 产品经理",
            teamId: "team_product",
            model: DEFAULT_LLM_MODEL,
            llmConfig: {
                provider: "mock",
                model: DEFAULT_LLM_MODEL,
                keyRef: "",
                temperature: 0.2,
                timeoutMs: 6000,
                allowMockFallback: true
            },
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
            model: DEFAULT_LLM_MODEL,
            llmConfig: {
                provider: "mock",
                model: DEFAULT_LLM_MODEL,
                keyRef: "",
                temperature: 0.2,
                timeoutMs: 6000,
                allowMockFallback: true
            },
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
            model: DEFAULT_LLM_MODEL,
            llmConfig: {
                provider: "mock",
                model: DEFAULT_LLM_MODEL,
                keyRef: "",
                temperature: 0.2,
                timeoutMs: 6000,
                allowMockFallback: true
            },
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
            model: DEFAULT_LLM_MODEL,
            llmConfig: {
                provider: "mock",
                model: DEFAULT_LLM_MODEL,
                keyRef: "",
                temperature: 0.1,
                timeoutMs: 6000,
                allowMockFallback: true
            },
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
            model: DEFAULT_LLM_MODEL,
            llmConfig: {
                provider: "mock",
                model: DEFAULT_LLM_MODEL,
                keyRef: "",
                temperature: 0.4,
                timeoutMs: 6000,
                allowMockFallback: true
            },
            permission: "Suggest",
            status: "available",
            load: 41,
            currentTaskId: "task_beta"
        },
        douyinOpsEmployee
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
    executionTraces: [],
    executionRuns: [],
    executionEventCursor: 0
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
let stateWriteSequence = 0;
let stateMutationQueue = Promise.resolve();

async function saveState(state) {
    await mkdir(dataDir, { recursive: true });
    const tempFile = path.join(dataDir, ".state." + process.pid + "." + Date.now() + "." + stateWriteSequence++ + ".tmp");
    await writeFile(tempFile, JSON.stringify(state, null, 2), "utf8");
    await rename(tempFile, stateFile);
}

function enqueueStateMutation(operation) {
    const run = stateMutationQueue.then(operation, operation);
    stateMutationQueue = run.catch(() => undefined);
    return run;
}

function isMutatingApiRequest(req) {
    return req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
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
    const declaredLength = Number(req.headers["content-length"] || 0);
    if (declaredLength > maxJsonBodyBytes) {
        const err = new Error("Request body exceeds " + maxJsonBodyBytes + " bytes");
        err.status = 413;
        throw err;
    }
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > maxJsonBodyBytes) {
            const err = new Error("Request body exceeds " + maxJsonBodyBytes + " bytes");
            err.status = 413;
            throw err;
        }
        chunks.push(buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw)
        return {};
    try {
        return JSON.parse(raw);
    }
    catch {
        const err = new Error("Invalid JSON body");
        err.status = 400;
        throw err;
    }
}
function apiError(message, status) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function bearerToken(req) {
    const header = String(req.headers.authorization || "");
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match?.[1] || String(req.headers["x-agency-token"] || "");
}

function isLocalRequest(req) {
    const remote = req.socket.remoteAddress || "";
    return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function originAllowed(req) {
    const origin = String(req.headers.origin || "");
    if (!origin) return true;
    if (allowedOrigins.has(origin)) return true;
    const host = String(req.headers.host || "");
    return Boolean(host) && (origin === "http://" + host || origin === "https://" + host);
}

function assertApiAccess(req) {
    if (apiToken) {
        if (bearerToken(req) !== apiToken) throw apiError("Unauthorized", 401);
    } else if (!isLocalRequest(req)) {
        throw apiError("AGENCY_API_TOKEN is required for non-local API access", 401);
    }
    if (isMutatingApiRequest(req) && !originAllowed(req)) {
        throw apiError("Origin is not allowed", 403);
    }
}

function sendNoContent(res, req) {
    const origin = String(req.headers.origin || "");
    const headers = {
        "cache-control": "no-store"
    };
    if (origin && originAllowed(req)) {
        headers["access-control-allow-origin"] = origin;
        headers["access-control-allow-headers"] = "content-type, authorization, x-agency-token";
        headers["access-control-allow-methods"] = "GET, POST, PATCH, OPTIONS";
    }
    res.writeHead(204, headers);
    res.end();
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
        if (!task.assignedEmployeeIds.includes(employee.id))
            continue;
        const nextTask = state.tasks.find((item) => {
            return item.id !== task.id && item.status !== "done" && item.assignedEmployeeIds.includes(employee.id);
        });
        employee.currentTaskId = nextTask?.id || null;
        employee.status = nextTask ? "busy" : "available";
        employee.load = Math.max(0, Number(employee.load || 0) - 18);
    }
}
function employeeForTemplates(state, templateIds) {
    return state.employees.find((employee) => templateIds.includes(employee.templateId));
}
function autoAssignEmployees(state, input) {
    const text = `${input.title || ""} ${input.description || ""}`.toLowerCase();
    const selected = [];
    const addByTemplates = (...templateIds) => {
        const employee = employeeForTemplates(state, templateIds);
        if (employee && !selected.includes(employee.id))
            selected.push(employee.id);
    };
    if (/douyin|抖音|creator\.douyin|视频|评论|播放|完播|自媒体|短视频/.test(text))
        addByTemplates("tpl_douyin_ops");
    if (/prd|产品|需求|范围|验收|用户|mvp|规划|目标/.test(text))
        addByTemplates("tpl_pm", "tpl_product_reviewer");
    if (/架构|后端|runtime|worker|接口|数据库|状态|权限|安全|存储|并发|api/.test(text))
        addByTemplates("tpl_architect");
    if (/前端|页面|ui|界面|交互|布局|按钮|dashboard|样式|组件/.test(text))
        addByTemplates("tpl_frontend");
    if (/测试|qa|回归|验证|用例|冒烟|接口返回|playwright/.test(text))
        addByTemplates("tpl_qa");
    if (/审核|review|审查|风险|漏洞|绕过|安全|架构债|code review/.test(text))
        addByTemplates("tpl_reviewer");
    if (/发布|release|上线|变更说明|回滚|版本/.test(text))
        addByTemplates("tpl_release");
    if (!selected.length)
        addByTemplates("tpl_pm", "tpl_architect");
    if (!selected.length && state.employees[0])
        selected.push(state.employees[0].id);
    return selected.slice(0, 4);
}
function employeeNames(state, employeeIds) {
    return employeeIds
        .map((employeeId) => state.employees.find((employee) => employee.id === employeeId)?.displayName || employeeId)
        .join(", ");
}
function findTaskAgent(state, task, requestedAgentId) {
    if (!task)
        return null;
    if (requestedAgentId) {
        return state.employees.find((employee) => employee.id === requestedAgentId && task.assignedEmployeeIds.includes(employee.id)) || null;
    }
    return task.assignedEmployeeIds
        .map((employeeId) => state.employees.find((employee) => employee.id === employeeId))
        .find(Boolean) || null;
}
function createExecutionApproval(state, task, agent, reason) {
    const existingApproval = state.approvals.find((approval) => {
        return approval.taskId === task.id
            && approval.status === "pending"
            && (!approval.requesterEmployeeId || approval.requesterEmployeeId === agent.id);
    });
    if (existingApproval) {
        task.status = "waiting_approval";
        return { approval: existingApproval, reused: true };
    }
    const approval = {
        id: id("apr"),
        taskId: task.id,
        title: `执行审批：${agent.displayName} / ${task.title}`,
        requesterEmployeeId: agent.id,
        reviewerUserId: task.ownerUserId || state.users[0]?.id,
        status: "pending",
        risk: "medium",
        action: `AI 员工 ${agent.displayName} 需要审批后执行。原因：${reason || "权限要求 Execute With Approval"}`,
        createdAt: now(),
        source: "agent_runtime"
    };
    task.status = "waiting_approval";
    state.approvals.unshift(approval);
    addLog(state, {
        actorType: "agent",
        actorId: agent.id,
        event: "requested_approval",
        targetId: approval.id,
        detail: approval.title
    });
    return { approval, reused: false };
}
function isApprovalRequiredError(error) {
    return error?.status === 403 && /requires approved execution/i.test(String(error.message || ""));
}
function ensureGovernanceState(state) {
    if (!Array.isArray(state.agentTemplates))
        state.agentTemplates = [];
    if (!Array.isArray(state.employees))
        state.employees = [];
    if (!Array.isArray(state.tasks))
        state.tasks = [];
    for (const template of governanceTemplates) {
        const existingTemplate = state.agentTemplates.find((item) => item.id === template.id);
        if (existingTemplate) {
            Object.assign(existingTemplate, template);
        }
        else {
            state.agentTemplates.push({ ...template });
        }
    }
    for (const employee of governanceEmployees) {
        const existingEmployee = state.employees.find((item) => item.id === employee.id);
        if (!existingEmployee) {
            state.employees.push({
                ...employee,
                llmConfig: { ...employee.llmConfig }
            });
            continue;
        }
        existingEmployee.templateId = employee.templateId;
        existingEmployee.title = existingEmployee.title || employee.title;
        existingEmployee.teamId = existingEmployee.teamId || employee.teamId;
        existingEmployee.model = ["gpt-5", "gpt-5-mini", "mock-local", ""].includes(String(existingEmployee.model || "")) ? employee.model : existingEmployee.model;
        existingEmployee.llmConfig = existingEmployee.llmConfig || { ...employee.llmConfig };
        if (["gpt-5", "gpt-5-mini", "mock-local", ""].includes(String(existingEmployee.llmConfig.model || ""))) {
            existingEmployee.llmConfig.model = employee.llmConfig.model;
        }
        existingEmployee.permission = normalizePermissionValue(existingEmployee.permission || employee.permission);
        existingEmployee.status = existingEmployee.status || "available";
        existingEmployee.load = Number.isFinite(Number(existingEmployee.load)) ? Number(existingEmployee.load) : 0;
        existingEmployee.currentTaskId = existingEmployee.currentTaskId || null;
    }
    for (const task of state.tasks) {
        if (!Array.isArray(task.signoffs))
            task.signoffs = [];
    }
}
function normalizeGovernanceStage(stage) {
    const value = String(stage || "").trim().toLowerCase();
    const aliases = {
        test: "qa",
        tested: "qa",
        qa: "qa",
        reviewer: "review",
        review: "review",
        reviewed: "review",
        product: "product",
        approval: "product",
        approved: "product",
        release: "release",
        done: "release"
    };
    return aliases[value] || "";
}
function taskLatestBuilderId(state, task) {
    const artifact = state.artifacts
        .filter((item) => item.taskId === task.id)
        .sort((a, b) => String(b.updatedAt || b.timestamp || "").localeCompare(String(a.updatedAt || a.timestamp || "")))[0];
    return artifact?.createdBy || task.assignedEmployeeIds?.[0] || null;
}
function findGovernanceEmployee(state, stageConfig, requestedEmployeeId) {
    if (requestedEmployeeId)
        return state.employees.find((employee) => employee.id === requestedEmployeeId);
    if (!stageConfig?.templateIds)
        return null;
    return state.employees.find((employee) => employee.id === stageConfig.defaultEmployeeId)
        || state.employees.find((employee) => stageConfig.templateIds.includes(employee.templateId));
}
function assertGovernanceSignoffAllowed(state, task, stageKey, employee) {
    const stageConfig = governanceStages[stageKey];
    if (!stageConfig) {
        const error = new Error("Unsupported governance stage");
        error.status = 400;
        throw error;
    }
    if (task.status !== stageConfig.from) {
        const error = new Error(`${stageConfig.label} requires task status ${stageConfig.from}; current status is ${task.status}`);
        error.status = 400;
        throw error;
    }
    if (!employee) {
        const error = new Error(`No AI employee available for ${stageConfig.label}`);
        error.status = 400;
        throw error;
    }
    if (!stageConfig.templateIds.includes(employee.templateId)) {
        const error = new Error(`${employee.displayName} cannot sign ${stageConfig.label}`);
        error.status = 403;
        throw error;
    }
    if (task.signoffs.some((signoff) => signoff.stage === stageKey && signoff.status === "passed")) {
        const error = new Error(`${stageConfig.label} has already been signed`);
        error.status = 400;
        throw error;
    }
    const builderId = taskLatestBuilderId(state, task);
    if (builderId && employee.id === builderId) {
        const error = new Error("The builder cannot sign their own downstream governance gate");
        error.status = 403;
        throw error;
    }
}
function createTaskSignoff(state, task, stageKey, employee, body) {
    const stageConfig = governanceStages[stageKey];
    const statusFrom = task.status;
    const signoff = {
        id: id("sig"),
        taskId: task.id,
        stage: stageKey,
        stageLabel: stageConfig.label,
        employeeId: employee.id,
        status: body.status === "failed" ? "failed" : "passed",
        note: String(body.note || ""),
        createdAt: now()
    };
    task.signoffs.push(signoff);
    if (signoff.status === "passed") {
        task.status = stageConfig.to;
        if (task.status === "done")
            releaseEmployeesFromTask(state, task);
    }
    appendEvent(state, id, now, {
        type: EXECUTION_EVENT_TYPES.TASK_SIGNED_OFF,
        taskId: task.id,
        agentId: employee.id,
        payload: {
            signoff,
            statusFrom,
            statusTo: task.status
        }
    });
    addLog(state, {
        actorType: "agent",
        actorId: employee.id,
        event: "signed_task_gate",
        targetId: task.id,
        detail: `${stageConfig.label}: ${signoff.status}, ${statusFrom} -> ${task.status}`
    });
    return signoff;
}
function ensureChatState(state) {
    if (!Array.isArray(state.chatRooms))
        state.chatRooms = [];
    if (!Array.isArray(state.chatMessages))
        state.chatMessages = [];
}
function ensureRuntimeState(state) {
    if (!Array.isArray(state.executionTraces))
        state.executionTraces = [];
    if (!Array.isArray(state.events))
        state.events = [];
    if (!Array.isArray(state.executionRuns))
        state.executionRuns = [];
    if (!Array.isArray(state.toolInvocations))
        state.toolInvocations = [];
    if (!Number.isInteger(state.executionEventCursor))
        state.executionEventCursor = 0;
}
function ensureBusinessSkillState(state) {
    if (!Array.isArray(state.agentTemplates))
        state.agentTemplates = [];
    if (!Array.isArray(state.employees))
        state.employees = [];
    const existingTemplate = state.agentTemplates.find((template) => template.id === douyinOpsTemplate.id);
    if (existingTemplate) {
        Object.assign(existingTemplate, douyinOpsTemplate);
    }
    else {
        state.agentTemplates.push({ ...douyinOpsTemplate });
    }
    const existingEmployee = state.employees.find((employee) => employee.id === douyinOpsEmployee.id);
    if (!existingEmployee) {
        state.employees.push({
            ...douyinOpsEmployee,
            llmConfig: { ...douyinOpsEmployee.llmConfig },
            skills: [...douyinOpsEmployee.skills],
            tools: [...douyinOpsEmployee.tools]
        });
    }
    else {
        existingEmployee.templateId = douyinOpsTemplate.id;
        existingEmployee.source = "TzFilm-Douyin-Tool";
        existingEmployee.division = "Growth";
        existingEmployee.skills = [...douyinOpsEmployee.skills];
        existingEmployee.tools = [...douyinOpsEmployee.tools];
        existingEmployee.systemPromptSource = "template.systemPrompt";
        if (!existingEmployee.permission || existingEmployee.permission === "Execute With Approval") {
            existingEmployee.permission = douyinOpsEmployee.permission;
        }
        existingEmployee.llmConfig = existingEmployee.llmConfig || { ...douyinOpsEmployee.llmConfig };
    }
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
    }
    else {
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
function defaultLlmTimeoutMs(provider) {
    return provider === "mock" ? 6000 : 30000;
}
function normalizeLlmConfig(input: any = {}, current: any = {}, modelFallback = DEFAULT_LLM_MODEL) {
    const source: any = input && typeof input === "object" ? input : {};
    const existing: any = current && typeof current === "object" ? current : {};
    const requestedProvider = String(source.provider || existing.provider || "mock").toLowerCase();
    const allowedProviders = new Set(["mock", "openai", "openai-compatible"]);
    const provider = allowedProviders.has(requestedProvider) ? requestedProvider : "mock";
    const previousProvider = String(existing.provider || "mock").toLowerCase();
    const providerChanged = Boolean(source.provider) && provider !== previousProvider;
    const hasSourceTimeout = source.timeoutMs !== undefined && source.timeoutMs !== "";
    const timeoutCandidate = hasSourceTimeout ? source.timeoutMs : (providerChanged ? undefined : existing.timeoutMs);
    return {
        provider,
        model: String(source.model || existing.model || modelFallback || DEFAULT_LLM_MODEL),
        keyRef: String(source.keyRef || source.apiKeyEnv || existing.keyRef || existing.apiKeyEnv || ""),
        baseUrl: String(source.baseUrl || existing.baseUrl || ""),
        temperature: Number.isFinite(Number(source.temperature ?? existing.temperature)) ? Number(source.temperature ?? existing.temperature) : 0.2,
        timeoutMs: Number.isFinite(Number(timeoutCandidate)) ? Number(timeoutCandidate) : defaultLlmTimeoutMs(provider),
        allowMockFallback: typeof source.allowMockFallback === "boolean" ? source.allowMockFallback : existing.allowMockFallback !== false
    };
}
function ensureEmployeeLlmDefaults(state) {
    if (!Array.isArray(state.employees))
        return;
    const legacyDefaultModels = new Set(["gpt-5", "gpt-5-mini", "mock-local", ""]);
    for (const employee of state.employees) {
        employee.llmConfig = normalizeLlmConfig(employee.llmConfig || {}, {}, employee.model || DEFAULT_LLM_MODEL);
        const provider = String(employee.llmConfig.provider || "mock");
        const model = String(employee.llmConfig.model || employee.model || "");
        const hasExternalKey = Boolean(employee.llmConfig.keyRef || employee.llmConfig.apiKeyEnv);
        if (provider === "mock" && legacyDefaultModels.has(model) && !hasExternalKey) {
            employee.model = DEFAULT_LLM_MODEL;
            employee.llmConfig.model = DEFAULT_LLM_MODEL;
        }
    }
}
function normalizeLocalizedProfessions(state) {
    if (!Array.isArray(state.agentTemplates))
        state.agentTemplates = [];
    const templateNames = new Map();
    for (const template of state.agentTemplates) {
        const currentName = String(template.name || "").trim();
        const sourceName = String(template.sourceName || currentName).trim();
        const localizedName = localizeTemplateName(sourceName || currentName);
        if (localizedName && localizedName !== currentName) {
            if (!template.sourceName && currentName)
                template.sourceName = currentName;
            template.name = localizedName;
        }
        if (template.id)
            templateNames.set(template.id, String(template.name || localizedName || currentName));
    }
    if (!Array.isArray(state.employees))
        return;
    for (const employee of state.employees) {
        const templateName = templateNames.get(employee.templateId);
        if (!templateName)
            continue;
        const title = String(employee.title || "").trim();
        const hasChineseTitle = /[\u4e00-\u9fff]/.test(title);
        if (!title || (!hasChineseTitle && /^AI\s+/i.test(title)))
            employee.title = aiEmployeeTitleForTemplate(templateName);
    }
}
function normalizePermissionValue(permission) {
    const value = String(permission || "Suggest").trim().toLowerCase();
    const aliases = {
        "只读": "Read Only",
        "建议": "Suggest",
        "草稿": "Draft",
        "审批后执行": "Execute With Approval",
        "需审批执行": "Execute With Approval",
        "read only": "Read Only",
        read_only: "Read Only",
        readonly: "Read Only",
        suggest: "Suggest",
        suggestion: "Suggest",
        draft: "Draft",
        "execute with approval": "Execute With Approval",
        execute_with_approval: "Execute With Approval",
        "approval required": "Execute With Approval",
        execute: "Execute"
    };
    return aliases[value] || "Suggest";
}
async function handleApi(req, res, url) {
    if (req.method === "OPTIONS") {
        if (!originAllowed(req)) throw apiError("Origin is not allowed", 403);
        sendNoContent(res, req);
        return;
    }
    assertApiAccess(req);
    if (isMutatingApiRequest(req)) {
        return enqueueStateMutation(() => handleApiUnlocked(req, res, url));
    }
    return handleApiUnlocked(req, res, url);
}

async function handleApiUnlocked(req, res, url) {
    const state = await loadState();
    const pathname = url.pathname;
    ensureBusinessSkillState(state);
    ensureGovernanceState(state);
    normalizeLocalizedProfessions(state);
    ensureEmployeeLlmDefaults(state);
    if (req.method === "GET" && pathname === "/api/state") {
        ensureChatState(state);
        ensureRuntimeState(state);
        ensureExecutionState(state);
        sendJson(res, 200, { ...state, dashboard: deriveDashboard(state) });
        return;
    }
    if (req.method === "POST" && pathname === "/api/tasks") {
        const body = await readBody(req);
        const assignmentMode = body.autoAssign || body.assignmentMode === "auto" ? "auto" : "manual";
        const assignedEmployeeIds = assignmentMode === "auto"
            ? autoAssignEmployees(state, body)
            : (Array.isArray(body.assignedEmployeeIds) ? body.assignedEmployeeIds.filter(Boolean) : []);
        const task = {
            id: id("task"),
            title: String(body.title || "未命名任务"),
            projectId: body.projectId || state.projects[0]?.id,
            ownerUserId: body.ownerUserId || state.users[0]?.id,
            status: "todo",
            priority: body.priority || "P2",
            description: String(body.description || ""),
            assignedEmployeeIds,
            assignmentMode,
            assignedBy: assignmentMode === "auto" ? "ai_dispatcher" : "user",
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
        if (assignmentMode === "auto") {
            addLog(state, {
                actorType: "agent",
                actorId: "ai_dispatcher",
                event: "auto_assigned_employees",
                targetId: task.id,
                detail: `AI 分配员自动分配：${employeeNames(state, assignedEmployeeIds)}`
            });
        }
        await saveState(state);
        sendJson(res, 201, task);
        return;
    }
    const taskStatusMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/status$/);
    if (req.method === "PATCH" && taskStatusMatch) {
        const body = await readBody(req);
        const task = state.tasks.find((item) => item.id === taskStatusMatch[1]);
        if (!task)
            return notFound(res);
        const nextStatus = String(body.status || task.status);
        const allowedStatuses = new Set(["todo", "running", "implemented", "tested", "reviewed", "approved", "waiting_approval", "review", "done"]);
        if (!allowedStatuses.has(nextStatus)) {
            sendJson(res, 400, { error: `Unsupported task status: ${nextStatus}` });
            return;
        }
        if (nextStatus === "done" && task.status !== "done") {
            sendJson(res, 400, { error: "Task must pass the release signoff before done" });
            return;
        }
        task.status = nextStatus;
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
    const taskSignoffMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/signoffs$/);
    if (req.method === "POST" && taskSignoffMatch) {
        const body = await readBody(req);
        ensureRuntimeState(state);
        const task = state.tasks.find((item) => item.id === taskSignoffMatch[1]);
        if (!task)
            return notFound(res);
        if (!Array.isArray(task.signoffs))
            task.signoffs = [];
        const stageKey = normalizeGovernanceStage(body.stage);
        const stageConfig = governanceStages[stageKey];
        const employee = findGovernanceEmployee(state, stageConfig || {}, body.employeeId);
        try {
            assertGovernanceSignoffAllowed(state, task, stageKey, employee);
            const signoff = createTaskSignoff(state, task, stageKey, employee, body);
            await saveState(state);
            sendJson(res, 201, { task, signoff });
        }
        catch (error) {
            sendJson(res, error.status || 500, { error: error.message || "Task signoff failed" });
        }
        return;
    }
    const taskAssignMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/assign$/);
    if (req.method === "POST" && taskAssignMatch) {
        const body = await readBody(req);
        const task = state.tasks.find((item) => item.id === taskAssignMatch[1]);
        if (!task)
            return notFound(res);
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
            title: String(body.title || aiEmployeeTitleForTemplate(String(template.name || ""))),
            teamId: body.teamId || state.teams[0]?.id,
            model: body.model || DEFAULT_LLM_MODEL,
            llmConfig: normalizeLlmConfig(body.llmConfig, {}, body.model || DEFAULT_LLM_MODEL),
            permission: normalizePermissionValue(body.permission),
            source: template.source || "local",
            division: template.division || "",
            skills: Array.isArray(template.deliverables) ? template.deliverables : [],
            tools: Array.isArray(template.defaultTools) ? template.defaultTools : [],
            systemPromptSource: template.systemPrompt ? "template.systemPrompt" : "template.summary",
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
    const employeeLlmConfigMatch = pathname.match(/^\/api\/employees\/([^/]+)\/llm-config$/);
    if (req.method === "PATCH" && employeeLlmConfigMatch) {
        const body = await readBody(req);
        const employee = state.employees.find((item) => item.id === employeeLlmConfigMatch[1]);
        if (!employee)
            return notFound(res);
        employee.llmConfig = normalizeLlmConfig(body.llmConfig || body, employee.llmConfig, employee.model);
        employee.model = employee.llmConfig.model || employee.model;
        addLog(state, {
            actorType: "user",
            actorId: body.actorId || state.users[0]?.id,
            event: "updated_employee_llm_config",
            targetId: employee.id,
            detail: `Updated LLM config for ${employee.displayName}: provider=${employee.llmConfig.provider}, model=${employee.llmConfig.model}, keyRef=${employee.llmConfig.keyRef || "none"}`
        });
        await saveState(state);
        sendJson(res, 200, employee);
        return;
    }
    const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/resolve$/);
    if (req.method === "POST" && approvalMatch) {
        const body = await readBody(req);
        const approval = state.approvals.find((item) => item.id === approvalMatch[1]);
        if (!approval)
            return notFound(res);
        approval.status = body.status === "approved" ? "approved" : "rejected";
        approval.resolvedAt = now();
        approval.resolutionNote = String(body.note || "");
        const approvalTask = state.tasks.find((task) => task.id === approval.taskId);
        if (!approval.toolInvocationId && approvalTask && approvalTask.status === "waiting_approval" && approval.status === "approved") {
            approvalTask.status = "todo";
        }
        let toolInvocation = null;
        if (approval.toolInvocationId) {
            toolInvocation = approval.status === "approved"
                ? await executeApprovedToolInvocation({ state, approvalId: approval.id, createId: id, now })
                : rejectToolInvocation(state, approval.id, now);
        }
        addLog(state, {
            actorType: "user",
            actorId: approval.reviewerUserId,
            event: "resolved_approval",
            targetId: approval.id,
            detail: `${approval.title}：${approval.status}`
        });
        await saveState(state);
        sendJson(res, 200, toolInvocation ? { approval, toolInvocation } : approval);
        return;
    }
    const taskApprovalMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/approvals$/);
    if (req.method === "POST" && taskApprovalMatch) {
        const body = await readBody(req);
        const task = state.tasks.find((item) => item.id === taskApprovalMatch[1]);
        if (!task)
            return notFound(res);
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
        if (!task)
            return notFound(res);
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
        if (!task)
            return notFound(res);
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
        if (!task)
            return notFound(res);
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
                callLlm: runAgentLlm
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
        }
        catch (error) {
            if (error.status === 404)
                return notFound(res);
            if (isApprovalRequiredError(error)) {
                const task = state.tasks.find((item) => item.id === taskRunMatch[1]);
                const agent = findTaskAgent(state, task, body.employeeId);
                if (task && agent) {
                    const { approval, reused } = createExecutionApproval(state, task, agent, error.message);
                    await saveState(state);
                    sendJson(res, 202, {
                        status: "waiting_approval",
                        error: error.message,
                        approval,
                        reused,
                        task,
                        executionTrace: error.executionTrace
                    });
                    return;
                }
            }
            if (error.status === 400 || error.status === 403) {
                sendJson(res, error.status, { error: error.message, executionTrace: error.executionTrace });
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
        if (!task)
            return notFound(res);
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
    if (!filePath.startsWith(publicDir))
        return notFound(res);
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
    }
    catch {
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
    }
    catch (error) {
        sendJson(res, error.status || 500, { error: error.message || "Server error" });
    }
});
server.listen(port, "127.0.0.1", () => {
    console.log(`Agency Team Workstation running at http://127.0.0.1:${port}`);
});
