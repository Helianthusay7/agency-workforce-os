import http from "node:http";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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
const seedStateFile = path.join(dataDir, "state.json");
const stateFile = path.resolve(process.env.AGENCY_STATE_FILE || path.join(dataDir, "state.local.json"));
const port = Number(process.env.PORT || 4173);
const host = process.env.AGENCY_HOST || "127.0.0.1";
const localOnlyHost = host === "127.0.0.1" || host === "localhost" || host === "::1";
const maxJsonBodyBytes = Number(process.env.AGENCY_MAX_BODY_BYTES || 2 * 1024 * 1024);
const apiToken = process.env.AGENCY_API_TOKEN || "";
const localDevAuthSecret = localOnlyHost ? apiToken || "local-development-secret-change-me" : "";
const authSecret = process.env.AGENCY_AUTH_SECRET || localDevAuthSecret;
if (!authSecret) {
    throw new Error("AGENCY_AUTH_SECRET is required when AGENCY_HOST is not local-only");
}
const trustProxy = process.env.AGENCY_TRUST_PROXY === "true";
const forceSecureCookie = process.env.AGENCY_COOKIE_SECURE === "true";
const authRateWindowMs = Number(process.env.AGENCY_AUTH_RATE_WINDOW_MS || 15 * 60 * 1000);
const authRateMaxAttempts = Number(process.env.AGENCY_AUTH_RATE_MAX_ATTEMPTS || 20);
const sessionCookieName = "agency_session";
const sessionMaxAgeSeconds = Number(process.env.AGENCY_SESSION_MAX_AGE_SECONDS || 60 * 60 * 24 * 14);
const encryptionKey = createHash("sha256").update(authSecret).digest();
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
    if (isMutatingApiRequest(req) && !originAllowed(req)) {
        throw apiError("Origin is not allowed", 403);
    }
}


function base64UrlEncode(value) {
    return Buffer.from(value).toString("base64url");
}
function base64UrlJson(value) {
    return base64UrlEncode(JSON.stringify(value));
}
function hmac(value) {
    return createHmac("sha256", authSecret).update(value).digest("base64url");
}
function parseCookies(req) {
    const result = {};
    const raw = String(req.headers.cookie || "");
    for (const part of raw.split(";")) {
        const index = part.indexOf("=");
        if (index < 0) continue;
        const name = decodeURIComponent(part.slice(0, index).trim());
        result[name] = decodeURIComponent(part.slice(index + 1).trim());
    }
    return result;
}
function signSession(userId) {
    const payload = base64UrlJson({ userId, exp: Date.now() + sessionMaxAgeSeconds * 1000 });
    return payload + "." + hmac(payload);
}
function verifySessionToken(token) {
    const [payload, signature] = String(token || "").split(".");
    if (!payload || !signature || hmac(payload) !== signature) return null;
    try {
        const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (!decoded.userId || Number(decoded.exp || 0) < Date.now()) return null;
        return String(decoded.userId);
    }
    catch {
        return null;
    }
}
function sessionUser(req, state) {
    const token = parseCookies(req)[sessionCookieName];
    const userId = verifySessionToken(token);
    if (!userId || !Array.isArray(state.users)) return null;
    return state.users.find((user) => user.id === userId && user.status !== "disabled") || null;
}
function requestIsSecure(req) {
    return Boolean(req.socket.encrypted)
        || forceSecureCookie
        || (trustProxy && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase() === "https");
}
function sessionCookie(token, req) {
    const secure = requestIsSecure(req) ? "; Secure" : "";
    return sessionCookieName + "=" + encodeURIComponent(token) + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + sessionMaxAgeSeconds + secure;
}
function clearSessionCookie() {
    return sessionCookieName + "=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
}
function sendJsonWithHeaders(res, status, payload, headers = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...headers
    });
    res.end(body);
}
function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
}
const authRateLimits = new Map();
function clientIp(req) {
    if (trustProxy) {
        const forwardedFor = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
        if (forwardedFor) return forwardedFor;
    }
    return req.socket.remoteAddress || "unknown";
}
function assertAuthRateLimit(req, email) {
    const key = clientIp(req) + ":" + normalizeEmail(email);
    const nowMs = Date.now();
    const existing = authRateLimits.get(key);
    if (!existing || existing.resetAt <= nowMs) {
        authRateLimits.set(key, { count: 1, resetAt: nowMs + authRateWindowMs });
        return;
    }
    existing.count += 1;
    if (existing.count > authRateMaxAttempts) {
        const error = new Error("Too many login attempts. Try again later.");
        error.status = 429;
        throw error;
    }
}
function hashPassword(password) {
    const salt = randomBytes(16).toString("base64url");
    const hash = scryptSync(String(password), salt, 64).toString("base64url");
    return "scrypt:" + salt + ":" + hash;
}
function verifyPassword(password, stored) {
    const parts = String(stored || "").split(":");
    if (parts.length !== 3 || parts[0] !== "scrypt") return false;
    const actual = scryptSync(String(password), parts[1], 64);
    const expected = Buffer.from(parts[2], "base64url");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function encryptSecret(value) {
    if (!value) return "";
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}
function decryptSecret(value) {
    if (!value) return "";
    const [ivText, tagText, encryptedText] = String(value).split(".");
    if (!ivText || !tagText || !encryptedText) return "";
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([
        decipher.update(Buffer.from(encryptedText, "base64url")),
        decipher.final()
    ]).toString("utf8");
}
function publicUserLlmConfig(user) {
    const config = user?.llmConfig || {};
    return {
        provider: config.provider || "openai-compatible",
        model: config.model || DEFAULT_LLM_MODEL,
        baseUrl: config.baseUrl || "",
        temperature: config.temperature ?? 0.2,
        timeoutMs: config.timeoutMs || 30000,
        apiKeyConfigured: Boolean(config.apiKeyEncrypted)
    };
}
function publicUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role || "Owner",
        teamId: user.teamId || "",
        status: user.status || "active",
        llmConfig: publicUserLlmConfig(user)
    };
}
function updateUserLlmConfig(user, input) {
    const current = user.llmConfig && typeof user.llmConfig === "object" ? user.llmConfig : {};
    const source = input && typeof input === "object" ? input : {};
    const provider = String(source.provider || current.provider || "openai-compatible").toLowerCase();
    const allowedProviders = new Set(["mock", "openai", "openai-compatible"]);
    const next = {
        provider: allowedProviders.has(provider) ? provider : "openai-compatible",
        model: String(source.model || current.model || DEFAULT_LLM_MODEL),
        baseUrl: String(source.baseUrl || current.baseUrl || ""),
        temperature: Number.isFinite(Number(source.temperature ?? current.temperature)) ? Number(source.temperature ?? current.temperature) : 0.2,
        timeoutMs: Number.isFinite(Number(source.timeoutMs ?? current.timeoutMs)) ? Number(source.timeoutMs ?? current.timeoutMs) : 30000,
        apiKeyEncrypted: current.apiKeyEncrypted || ""
    };
    if (typeof source.apiKey === "string" && source.apiKey.trim()) {
        next.apiKeyEncrypted = encryptSecret(source.apiKey.trim());
    }
    if (source.clearApiKey === true) {
        next.apiKeyEncrypted = "";
    }
    user.llmConfig = next;
    return next;
}
function userLlmConfigForAgent(user, agent) {
    const userConfig = user?.llmConfig || {};
    const agentConfig = agent?.llmConfig && typeof agent.llmConfig === "object" ? agent.llmConfig : {};
    const apiKey = userConfig.apiKeyEncrypted ? decryptSecret(userConfig.apiKeyEncrypted) : "";
    return {
        ...agentConfig,
        provider: userConfig.provider || agentConfig.provider || "openai-compatible",
        model: userConfig.model || agentConfig.model || agent.model || DEFAULT_LLM_MODEL,
        baseUrl: userConfig.baseUrl || agentConfig.baseUrl || "",
        temperature: userConfig.temperature ?? agentConfig.temperature ?? 0.2,
        timeoutMs: userConfig.timeoutMs || agentConfig.timeoutMs || 30000,
        allowMockFallback: false,
        keyRef: apiKey ? "user_api_key" : agentConfig.keyRef || agentConfig.apiKeyEnv || "",
        apiKey
    };
}
function withUserLlmConfig(user, agent) {
    return {
        ...agent,
        llmConfig: userLlmConfigForAgent(user, agent)
    };
}
function llmHealthCheckAgentForUser(user) {
    return withUserLlmConfig(user, {
        id: "llm_health_check",
        templateId: "tpl_pm",
        displayName: "API 健康检查",
        title: "API 健康检查",
        model: user?.llmConfig?.model || DEFAULT_LLM_MODEL,
        permission: "Suggest"
    });
}
async function testUserLlmConfig(user) {
    const agent = llmHealthCheckAgentForUser(user);
    const config = agent.llmConfig || {};
    if (String(config.provider || "").toLowerCase() !== "mock" && !config.apiKey) {
        const error = new Error("My API 未配置 API Key，请先在 My API 保存可用密钥。") as any;
        error.status = 400;
        throw error;
    }
    const task = {
        id: "llm_health_task",
        title: "API 健康检查",
        projectId: "health",
        ownerUserId: user?.id,
        status: "todo",
        priority: "P2",
        description: "请只回复 OK，用于确认模型接口可用。",
        assignedEmployeeIds: [agent.id],
        createdAt: now()
    };
    const startedAt = Date.now();
    const result = await runAgentLlm("请只回复 OK。", task, agent, undefined, { id: "health", name: "API 健康检查" });
    return {
        ok: true,
        provider: result.provider,
        requestedProvider: result.requestedProvider,
        model: result.model,
        baseUrl: result.baseUrl,
        keyRef: result.keyRef,
        latencyMs: Date.now() - startedAt,
        responseId: result.responseId || null,
        sample: String(result.output || "").slice(0, 80)
    };
}
function resourceOwnerId(item, fallbackUserId) {
    return String(item?.ownerUserId || item?.userId || fallbackUserId || "");
}
function belongsToUser(item, userId) {
    return resourceOwnerId(item, userId) === userId;
}
function workspaceOwnerIds(state) {
    const users = Array.isArray(state.users) ? state.users : [];
    return users.map((user) => user.id).filter(Boolean);
}
function ownedTeams(state, userId) {
    return (state.teams || []).filter((item) => belongsToUser(item, userId));
}
function ownedProjects(state, userId) {
    return (state.projects || []).filter((item) => belongsToUser(item, userId));
}
function ownedEmployees(state, userId) {
    return (state.employees || []).filter((item) => belongsToUser(item, userId));
}
function ownedTasks(state, userId) {
    return (state.tasks || []).filter((item) => item.ownerUserId === userId || ownedProjects(state, userId).some((project) => project.id === item.projectId));
}
function taskIdsForUser(state, userId) {
    return new Set(ownedTasks(state, userId).map((task) => task.id));
}
function employeeIdsForUser(state, userId) {
    return new Set(ownedEmployees(state, userId).map((employee) => employee.id));
}
function scopedStateForUser(state, user) {
    const userId = user.id;
    const tasks = ownedTasks(state, userId);
    const taskIds = new Set(tasks.map((task) => task.id));
    const employees = ownedEmployees(state, userId);
    const employeeIds = new Set(employees.map((employee) => employee.id));
    const roomIds = new Set((state.chatRooms || []).filter((room) => taskIds.has(room.taskId)).map((room) => room.id));
    const resourceIds = new Set([
        ...taskIds,
        ...employeeIds,
        ...ownedProjects(state, userId).map((project) => project.id),
        ...(state.approvals || []).filter((approval) => taskIds.has(approval.taskId)).map((approval) => approval.id),
        ...(state.artifacts || []).filter((artifact) => taskIds.has(artifact.taskId)).map((artifact) => artifact.id)
    ]);
    return {
        ...state,
        users: [publicUser(user)],
        currentUser: publicUser(user),
        teams: ownedTeams(state, userId),
        projects: ownedProjects(state, userId),
        employees,
        tasks,
        approvals: (state.approvals || []).filter((approval) => taskIds.has(approval.taskId) || approval.reviewerUserId === userId),
        artifacts: (state.artifacts || []).filter((artifact) => taskIds.has(artifact.taskId)),
        auditLogs: (state.auditLogs || []).filter((log) => log.ownerUserId === userId || log.actorId === userId || employeeIds.has(log.actorId) || resourceIds.has(log.targetId)),
        chatRooms: (state.chatRooms || []).filter((room) => taskIds.has(room.taskId)),
        chatMessages: (state.chatMessages || []).filter((message) => taskIds.has(message.taskId) || roomIds.has(message.roomId)),
        executionTraces: (state.executionTraces || []).filter((trace) => taskIds.has(trace.taskId)),
        executionRuns: (state.executionRuns || []).filter((run) => taskIds.has(run.taskId)),
        toolInvocations: (state.toolInvocations || []).filter((invocation) => taskIds.has(invocation.taskId)),
        events: (state.events || []).filter((event) => !event.taskId || taskIds.has(event.taskId))
    };
}
function findOwnedTask(state, userId, taskId) {
    return ownedTasks(state, userId).find((task) => task.id === taskId);
}
function findOwnedEmployee(state, userId, employeeId) {
    return ownedEmployees(state, userId).find((employee) => employee.id === employeeId);
}
function findOwnedApproval(state, userId, approvalId) {
    const taskIds = taskIdsForUser(state, userId);
    return (state.approvals || []).find((approval) => approval.id === approvalId && (taskIds.has(approval.taskId) || approval.reviewerUserId === userId));
}
function deleteOwnedTaskTree(state, userId, rootTaskId) {
    const owned = new Set(ownedTasks(state, userId).map((task) => task.id));
    if (!owned.has(rootTaskId))
        return null;
    const deleteTaskIds = new Set([rootTaskId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const task of state.tasks || []) {
            if (owned.has(task.id) && task.parentTaskId && deleteTaskIds.has(task.parentTaskId) && !deleteTaskIds.has(task.id)) {
                deleteTaskIds.add(task.id);
                changed = true;
            }
        }
    }
    const artifactIds = new Set((state.artifacts || []).filter((item) => deleteTaskIds.has(item.taskId)).map((item) => item.id));
    const approvalIds = new Set((state.approvals || []).filter((item) => deleteTaskIds.has(item.taskId)).map((item) => item.id));
    const roomIds = new Set((state.chatRooms || []).filter((item) => deleteTaskIds.has(item.taskId)).map((item) => item.id));
    const traceIds = new Set((state.executionTraces || []).filter((item) => deleteTaskIds.has(item.taskId)).map((item) => item.id));
    const runIds = new Set((state.executionRuns || []).filter((item) => deleteTaskIds.has(item.taskId)).map((item) => item.id));

    state.tasks = (state.tasks || []).filter((item) => !deleteTaskIds.has(item.id));
    state.artifacts = (state.artifacts || []).filter((item) => !artifactIds.has(item.id));
    state.approvals = (state.approvals || []).filter((item) => !approvalIds.has(item.id));
    state.chatRooms = (state.chatRooms || []).filter((item) => !roomIds.has(item.id));
    state.chatMessages = (state.chatMessages || []).filter((item) => !deleteTaskIds.has(item.taskId) && !roomIds.has(item.roomId));
    state.executionTraces = (state.executionTraces || []).filter((item) => !traceIds.has(item.id));
    state.executionRuns = (state.executionRuns || []).filter((item) => !runIds.has(item.id));
    state.toolInvocations = (state.toolInvocations || []).filter((item) => !deleteTaskIds.has(item.taskId));
    state.events = (state.events || []).filter((item) => !deleteTaskIds.has(item.taskId) && !artifactIds.has(item.artifactId) && !traceIds.has(item.executionTraceId));
    state.auditLogs = (state.auditLogs || []).filter((item) => {
        return !deleteTaskIds.has(item.targetId) && !artifactIds.has(item.targetId) && !approvalIds.has(item.targetId);
    });
    for (const employee of ownedEmployees(state, userId)) {
        if (employee.currentTaskId && deleteTaskIds.has(employee.currentTaskId)) {
            employee.currentTaskId = null;
            employee.status = "available";
            employee.load = 0;
        }
    }
    return {
        taskIds: [...deleteTaskIds],
        artifactIds: [...artifactIds],
        approvalIds: [...approvalIds],
        traceIds: [...traceIds],
        runIds: [...runIds]
    };
}
function ensureAuthState(state) {
    if (!Array.isArray(state.users)) state.users = [];
    if (!state.users.length) {
        state.users.push({
            id: id("usr"),
            name: "Owner",
            email: "owner@example.local",
            role: "Owner",
            status: "active",
            createdAt: now()
        });
    }
    const defaultOwnerId = state.users[0].id;
    for (const user of state.users) {
        user.email = normalizeEmail(user.email);
        user.role = user.role || "Owner";
        user.status = user.status || "active";
        if (!user.llmConfig) {
            user.llmConfig = {
                provider: "openai-compatible",
                model: DEFAULT_LLM_MODEL,
                baseUrl: "",
                temperature: 0.2,
                timeoutMs: 30000,
                apiKeyEncrypted: ""
            };
        }
    }
    for (const collectionName of ["teams", "projects", "employees"]) {
        if (!Array.isArray(state[collectionName])) state[collectionName] = [];
        for (const item of state[collectionName]) {
            if (!item.ownerUserId) item.ownerUserId = defaultOwnerId;
        }
    }
    if (Array.isArray(state.tasks)) {
        for (const task of state.tasks) {
            if (!task.ownerUserId) task.ownerUserId = defaultOwnerId;
        }
    }
    if (Array.isArray(state.auditLogs)) {
        for (const log of state.auditLogs) {
            if (!log.ownerUserId) log.ownerUserId = log.actorType === "user" && log.actorId ? log.actorId : defaultOwnerId;
        }
    }
}
function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}
function createUserWorkspace(state, user) {
    const suffix = user.id.replace(/^usr_/, "");
    const teamIdMap = new Map();
    const projectIdMap = new Map();
    const employeeIdMap = new Map();
    for (const team of cloneJson(seedState.teams || [])) {
        const oldId = team.id;
        team.id = oldId + "_" + suffix;
        team.ownerUserId = user.id;
        team.leadUserId = user.id;
        teamIdMap.set(oldId, team.id);
        state.teams.push(team);
    }
    for (const project of cloneJson(seedState.projects || [])) {
        const oldId = project.id;
        project.id = oldId + "_" + suffix;
        project.ownerUserId = user.id;
        project.teamId = teamIdMap.get(project.teamId) || project.teamId;
        projectIdMap.set(oldId, project.id);
        state.projects.push(project);
    }
    for (const employee of cloneJson(seedState.employees || [])) {
        const oldId = employee.id;
        employee.id = oldId + "_" + suffix;
        employee.ownerUserId = user.id;
        employee.teamId = teamIdMap.get(employee.teamId) || employee.teamId;
        employee.currentTaskId = null;
        employee.status = "available";
        employee.load = 0;
        employee.llmConfig = normalizeLlmConfig({
            provider: "openai-compatible",
            model: DEFAULT_LLM_MODEL,
            keyRef: "",
            baseUrl: "",
            timeoutMs: 30000,
            allowMockFallback: false
        }, {}, DEFAULT_LLM_MODEL);
        employeeIdMap.set(oldId, employee.id);
        state.employees.push(employee);
    }
    return { teamIdMap, projectIdMap, employeeIdMap };
}
function workspaceSlice(state, userId) {
    return {
        ...state,
        users: (state.users || []).filter((user) => user.id === userId),
        teams: ownedTeams(state, userId),
        projects: ownedProjects(state, userId),
        employees: ownedEmployees(state, userId),
        tasks: ownedTasks(state, userId),
        approvals: (state.approvals || []).filter((approval) => taskIdsForUser(state, userId).has(approval.taskId)),
        artifacts: (state.artifacts || []).filter((artifact) => taskIdsForUser(state, userId).has(artifact.taskId))
    };
}
async function handleAuthApi(req, res, pathname, state) {
    if (req.method === "GET" && pathname === "/api/auth/me") {
        sendJson(res, 200, { user: publicUser(sessionUser(req, state)) });
        return true;
    }
    if (req.method === "POST" && pathname === "/api/auth/logout") {
        sendJsonWithHeaders(res, 200, { ok: true }, { "set-cookie": clearSessionCookie() });
        return true;
    }
    if (req.method === "POST" && (pathname === "/api/auth/login" || pathname === "/api/auth/register")) {
        const body = await readBody(req);
        const email = normalizeEmail(body.email);
        const password = String(body.password || "");
        if (!email || !email.includes("@") || password.length < 8) {
            sendJson(res, 400, { error: "Email and password with at least 8 characters are required" });
            return true;
        }
        try {
            assertAuthRateLimit(req, email);
        }
        catch (error) {
            sendJson(res, error.status || 429, { error: error.message || "Too many login attempts" });
            return true;
        }
        let user = state.users.find((item) => normalizeEmail(item.email) === email);
        if (pathname === "/api/auth/register") {
            if (user) {
                sendJson(res, 409, { error: "This email is already registered" });
                return true;
            }
            if (!user) {
                user = {
                    id: id("usr"),
                    name: String(body.name || email.split("@")[0] || "User"),
                    email,
                    role: "Owner",
                    status: "active",
                    createdAt: now()
                };
                state.users.push(user);
                createUserWorkspace(state, user);
            }
            if (!ownedProjects(state, user.id).length) {
                createUserWorkspace(state, user);
            }
            user.name = String(body.name || user.name || email.split("@")[0]);
            user.email = email;
            user.passwordHash = hashPassword(password);
            updateUserLlmConfig(user, user.llmConfig || {});
            ensureGovernanceState(state);
            await saveState(state);
            sendJsonWithHeaders(res, 201, { user: publicUser(user) }, { "set-cookie": sessionCookie(signSession(user.id), req) });
            return true;
        }
        if (!user?.passwordHash || !verifyPassword(password, user.passwordHash)) {
            sendJson(res, 401, { error: "Invalid email or password" });
            return true;
        }
        sendJsonWithHeaders(res, 200, { user: publicUser(user) }, { "set-cookie": sessionCookie(signSession(user.id), req) });
        return true;
    }
    return false;
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
    for (const ownerUserId of workspaceOwnerIds(state)) {
        for (const employee of governanceEmployees) {
            const existingForOwner = state.employees.find((item) => item.ownerUserId === ownerUserId && item.templateId === employee.templateId);
            if (!existingForOwner) {
                state.employees.push({
                    ...employee,
                    id: id("emp"),
                    ownerUserId,
                    llmConfig: { ...employee.llmConfig },
                    status: "available",
                    load: 0,
                    currentTaskId: null
                });
            }
        }
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

function bestManagerEmployee(state, userId, task) {
    const employees = ownedEmployees(state, userId);
    return employees.find((employee) => task.assignedEmployeeIds.includes(employee.id) && employee.templateId === "tpl_pm")
        || employees.find((employee) => employee.templateId === "tpl_pm")
        || employees.find((employee) => task.assignedEmployeeIds.includes(employee.id))
        || employees[0]
        || null;
}
function preferredAutomationEmployeeIds(state, userId, input) {
    const rawText = String((input?.title || "") + " " + (input?.description || ""));
    const text = rawText.toLowerCase();
    const title = String(input?.title || "");
    const employees = ownedEmployees(state, userId);
    const selected = [];
    const addByTemplates = (...templateIds) => {
        for (const templateId of templateIds) {
            const employee = employees.find((item) => item.templateId === templateId);
            if (employee && !selected.includes(employee.id)) selected.push(employee.id);
        }
    };
    if (/^审查|^检查|^验证|^测试/.test(title)) {
        addByTemplates("tpl_product_reviewer", "tpl_pm", "tpl_reviewer", "tpl_qa");
        return selected;
    }
    if (/^产出|^输出|^撰写|^整理/.test(title)) {
        if (/代码|源码|页面|前端|后端|组件|开发/.test(text)) addByTemplates("tpl_builder", "tpl_frontend", "tpl_architect");
        addByTemplates("tpl_product_reviewer", "tpl_pm");
        return selected;
    }
    if (/^设计|^规划/.test(title)) {
        addByTemplates("tpl_pm", "tpl_architect");
        return selected;
    }
    if (/^明确|^定义|^梳理/.test(title)) {
        addByTemplates("tpl_pm", "tpl_product_reviewer");
        return selected;
    }
    if (/审查|测试|qa|风险|回归|验证/.test(text)) addByTemplates("tpl_product_reviewer", "tpl_pm", "tpl_reviewer", "tpl_qa");
    if (/代码|源码|页面|前端|后端|组件|开发/.test(text)) addByTemplates("tpl_builder", "tpl_frontend", "tpl_architect");
    if (/设计|架构|流程|接口|系统|边界|数据/.test(text)) addByTemplates("tpl_pm", "tpl_architect");
    if (/目标|需求|范围|产品|mvp|验收标准|计划|方案|交付物/.test(text)) addByTemplates("tpl_pm", "tpl_product_reviewer");
    return selected;
}
function assignBestEmployeesForTask(state, userId, task, input, fallbackEmployee) {
    const userEmployeeIds = new Set(ownedEmployees(state, userId).map((employee) => employee.id));
    const preferred = preferredAutomationEmployeeIds(state, userId, input).filter((employeeId) => userEmployeeIds.has(employeeId));
    const selected = (preferred.length ? preferred : autoAssignEmployees(workspaceSlice(state, userId), input).filter((employeeId) => userEmployeeIds.has(employeeId)));
    if (!selected.length && fallbackEmployee?.id) selected.push(fallbackEmployee.id);
    task.assignedEmployeeIds = [...new Set(selected)].slice(0, 3);
    task.assignmentMode = "auto";
    task.assignedBy = "ai_dispatcher";
    assignEmployeesToTask(workspaceSlice(state, userId), task, task.assignedEmployeeIds, 6);
    return task.assignedEmployeeIds;
}
function taskArtifactsForTask(state, taskId) {
    return (state.artifacts || []).filter((artifact) => artifact.taskId === taskId);
}
function automationSummaryForTask(state, taskId) {
    return (state.artifacts || []).find((artifact) => artifact.taskId === taskId && artifact.type === "automation_summary");
}
function sanitizeAutomationPlanningText(value) {
    return String(value || "")
        .replace(/代码/g, "方案")
        .replace(/源码/g, "方案")
        .replace(/实现/g, "落实")
        .replace(/开发/g, "制作")
        .replace(/前端/g, "界面")
        .replace(/后端/g, "服务")
        .replace(/页面/g, "界面")
        .replace(/code|developer|engineer|frontend|backend|implementation|html|javascript|css/gi, "plan");
}
function createOrReuseSubtasksForAutomation(state, userId, parentTask, manager) {
    const existing = ownedTasks(state, userId).filter((task) => task.parentTaskId === parentTask.id);
    if (existing.length) return { subtasks: existing, reused: true };
    const project = ownedProjects(state, userId).find((item) => item.id === parentTask.projectId);
    const specs = buildSubtasks(parentTask, project).slice(0, 4);
    const subtasks = specs.map((spec, index) => {
        const task = {
            id: id("task"),
            parentTaskId: parentTask.id,
            title: sanitizeAutomationPlanningText(spec.title),
            projectId: parentTask.projectId,
            ownerUserId: parentTask.ownerUserId,
            status: "todo",
            priority: index === 0 ? parentTask.priority : "P2",
            description: sanitizeAutomationPlanningText(spec.description) + "\n自动化执行约束：本轮先输出可审阅的文档、计划或分析产物，暂不生成工程文件。",
            assignedEmployeeIds: [],
            assignmentMode: "auto",
            assignedBy: "ai_dispatcher",
            dueDate: parentTask.dueDate || "",
            createdAt: now()
        };
        assignBestEmployeesForTask(state, userId, task, task, manager);
        return task;
    });
    state.tasks.unshift(...subtasks);
    return { subtasks, reused: false };
}
function canRunWithoutApprovalForAutomation(employee) {
    const permission = String(employee?.permission || "").trim().toLowerCase();
    return permission !== "read only" && permission !== "execute with approval";
}
function selectAutomationRunner(state, userId, task, fallbackEmployee) {
    const assigned = task.assignedEmployeeIds
        .map((employeeId) => findOwnedEmployee(state, userId, employeeId))
        .filter(Boolean);
    return assigned.find(canRunWithoutApprovalForAutomation)
        || (fallbackEmployee && canRunWithoutApprovalForAutomation(fallbackEmployee) ? fallbackEmployee : null)
        || assigned[0]
        || fallbackEmployee
        || null;
}
async function runAutomationStep(state, currentUser, currentUserId, task, employeeId) {
    try {
        const result = await orchestrateTask(state, task.id, {
            requestedAgentId: employeeId,
            createId: id,
            now,
            callLlm: (prompt, task, agent, template, project) => runAgentLlm(prompt, task, withUserLlmConfig(currentUser, agent), template, project)
        });
        addLog(state, {
            actorType: "agent",
            actorId: result.agent.id,
            ownerUserId: currentUserId,
            event: "ran_agent_runtime",
            targetId: result.task.id,
            detail: result.agent.displayName + " 自动执行任务并生成交付物：" + result.artifact.title + "，trace=" + result.executionTrace.id
        });
        addLog(state, {
            actorType: "agent",
            actorId: result.agent.id,
            ownerUserId: currentUserId,
            event: "created_artifact",
            targetId: result.artifact.id,
            detail: "创建交付物：" + result.artifact.title
        });
        return { status: "succeeded", task: result.task, agent: result.agent, artifact: result.artifact, executionTrace: result.executionTrace };
    }
    catch (error) {
        if (isApprovalRequiredError(error)) {
            const agent = findTaskAgent(workspaceSlice(state, currentUserId), task, employeeId);
            if (agent) {
                const approvalResult = createExecutionApproval(state, task, agent, error.message);
                return { status: "waiting_approval", task, agent, approval: approvalResult.approval, reused: approvalResult.reused, error: error.message, executionTrace: error.executionTrace };
            }
        }
        task.status = "failed";
        addLog(state, {
            actorType: "agent",
            actorId: error.executionTrace?.agentId || employeeId || null,
            ownerUserId: currentUserId,
            event: "failed_agent_runtime",
            targetId: task.id,
            detail: "自动执行失败：" + (error.message || "Unknown error") + "，trace=" + (error.executionTrace?.id || "none")
        });
        return { status: "failed", task, error: error.message || "Agent Runtime execution failed", executionTrace: error.executionTrace };
    }
}
function upsertAutomationSummaryArtifact(state, currentUserId, parentTask, manager, subtasks, results) {
    const lines = [];
    lines.push("# 自动交付汇总：" + parentTask.title);
    lines.push("");
    lines.push("总管 AI：" + (manager?.displayName || "AI 总管"));
    lines.push("完成子任务：" + results.filter((item) => item.status === "succeeded" || item.status === "reused").length + "/" + subtasks.length);
    lines.push("");
    lines.push("## 子任务分工与产出");
    for (const subtask of subtasks) {
        const assignees = subtask.assignedEmployeeIds.map((employeeId) => ownedEmployees(state, currentUserId).find((employee) => employee.id === employeeId)?.displayName || employeeId).join("、") || "未分配";
        const artifacts = taskArtifactsForTask(state, subtask.id);
        lines.push("- " + subtask.title);
        lines.push("  - 负责员工：" + assignees);
        lines.push("  - 当前状态：" + subtask.status);
        lines.push("  - 交付物：" + (artifacts.map((artifact) => artifact.title).join("、") || "暂无"));
    }
    const statusSet = new Set(results.map((item) => item.status));
    const finalStatus = statusSet.has("failed") ? "partial" : (statusSet.has("waiting_approval") ? "waiting_approval" : "completed");
    lines.push("");
    lines.push(finalStatus === "completed" ? "## 结论\n自动工作流已完成，产物可进入人工验收。" : "## 结论\n自动工作流未完全完成，请处理审批或失败项后继续。");
    const summary = lines.join("\n");
    const existing = automationSummaryForTask(state, parentTask.id);
    if (existing) {
        existing.title = "自动交付汇总：" + parentTask.title;
        existing.summary = summary;
        existing.content = summary;
        existing.updatedAt = now();
        existing.createdBy = manager?.id || parentTask.ownerUserId;
        return existing;
    }
    const artifact = {
        id: id("art"),
        taskId: parentTask.id,
        type: "automation_summary",
        title: "自动交付汇总：" + parentTask.title,
        createdBy: manager?.id || parentTask.ownerUserId,
        updatedAt: now(),
        summary,
        content: summary
    };
    state.artifacts.unshift(artifact);
    return artifact;
}
async function automateOwnedTask(state, currentUser, currentUserId, taskId) {
    ensureRuntimeState(state);
    ensureExecutionState(state);
    const parentTask = findOwnedTask(state, currentUserId, taskId);
    if (!parentTask) return null;
    const manager = bestManagerEmployee(state, currentUserId, parentTask);
    if (!parentTask.assignedEmployeeIds?.length) {
        assignBestEmployeesForTask(state, currentUserId, parentTask, parentTask, manager);
    }
    else if (manager?.id && !parentTask.assignedEmployeeIds.includes(manager.id)) {
        parentTask.assignedEmployeeIds = [manager.id, ...parentTask.assignedEmployeeIds].slice(0, 4);
    }
    addLog(state, {
        actorType: "agent",
        actorId: manager?.id || "ai_dispatcher",
        ownerUserId: currentUserId,
        event: "automation_started",
        targetId: parentTask.id,
        detail: "总管 AI 开始自动处理任务：" + parentTask.title
    });
    let managerRun = null;
    if (manager) {
        const originalTitle = parentTask.title;
        const originalDescription = parentTask.description;
        parentTask.title = "总管规划：" + sanitizeAutomationPlanningText(originalTitle);
        parentTask.description = sanitizeAutomationPlanningText(originalDescription) + "\n请总管 AI 输出任务拆解、岗位分工、验收标准和风险清单。";
        try {
            managerRun = await runAutomationStep(state, currentUser, currentUserId, parentTask, manager.id);
        }
        finally {
            parentTask.title = originalTitle;
            parentTask.description = originalDescription;
        }
    }
    const subtaskResult = createOrReuseSubtasksForAutomation(state, currentUserId, parentTask, manager);
    const subtasks = subtaskResult.subtasks;
    for (const subtask of subtasks) {
        if (!subtask.assignedEmployeeIds?.length) assignBestEmployeesForTask(state, currentUserId, subtask, subtask, manager);
    }
    const results = [];
    for (const subtask of subtasks) {
        const existingArtifacts = taskArtifactsForTask(state, subtask.id);
        if (existingArtifacts.length && ["implemented", "tested", "reviewed", "approved", "done", "review"].includes(String(subtask.status))) {
            results.push({ status: "reused", task: subtask, artifact: existingArtifacts[0] });
            continue;
        }
        const runner = selectAutomationRunner(state, currentUserId, subtask, manager);
        const result = await runAutomationStep(state, currentUser, currentUserId, subtask, runner?.id || "");
        results.push(result);
        if (result.status === "waiting_approval") break;
    }
    const outcomes = [managerRun, ...results].filter(Boolean);
    const hasWaitingApproval = outcomes.some((item) => item.status === "waiting_approval");
    const hasFailed = outcomes.some((item) => item.status === "failed");
    const summaryArtifact = upsertAutomationSummaryArtifact(state, currentUserId, parentTask, manager, subtasks, results);
    if (hasWaitingApproval) {
        parentTask.status = "waiting_approval";
    }
    else if (hasFailed) {
        parentTask.status = "failed";
    }
    else {
        parentTask.status = "review";
    }
    addLog(state, {
        actorType: "agent",
        actorId: manager?.id || "ai_dispatcher",
        ownerUserId: currentUserId,
        event: "automation_completed",
        targetId: parentTask.id,
        detail: "总管 AI 完成自动工作流：" + parentTask.title + "，子任务 " + subtasks.length + " 个，汇总产物 " + summaryArtifact.id
    });
    return {
        status: hasWaitingApproval ? "waiting_approval" : (hasFailed ? "partial" : "completed"),
        parentTask,
        manager,
        managerRun,
        subtasks,
        reusedSubtasks: subtaskResult.reused,
        results,
        summaryArtifact
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
    ensureAuthState(state);
    ensureBusinessSkillState(state);
    ensureGovernanceState(state);
    normalizeLocalizedProfessions(state);
    ensureEmployeeLlmDefaults(state);
    if (await handleAuthApi(req, res, pathname, state)) return;
    const currentUser = sessionUser(req, state);
    if (!currentUser) {
        sendJson(res, 401, { error: "Login required" });
        return;
    }
    const currentUserId = currentUser.id;
    const currentUserState = () => workspaceSlice(state, currentUserId);
    if (req.method === "GET" && pathname === "/api/me/llm-config") {
        sendJson(res, 200, publicUserLlmConfig(currentUser));
        return;
    }
    if (req.method === "PATCH" && pathname === "/api/me/llm-config") {
        const body = await readBody(req);
        updateUserLlmConfig(currentUser, body.llmConfig || body);
        await saveState(state);
        sendJson(res, 200, publicUserLlmConfig(currentUser));
        return;
    }
    if (req.method === "POST" && pathname === "/api/me/llm-config/test") {
        try {
            const result = await testUserLlmConfig(currentUser);
            sendJson(res, 200, result);
        }
        catch (error) {
            sendJson(res, error.status || 502, {
                ok: false,
                error: error.message || "My API 测试失败",
                provider: error.provider || currentUser.llmConfig?.provider || "",
                model: error.model || currentUser.llmConfig?.model || "",
                keyRef: error.keyRef || "user_api_key"
            });
        }
        return;
    }
    if (req.method === "GET" && pathname === "/api/state") {
        ensureChatState(state);
        ensureRuntimeState(state);
        ensureExecutionState(state);
        const scoped = scopedStateForUser(state, currentUser);
        sendJson(res, 200, { ...scoped, dashboard: deriveDashboard(scoped) });
        return;
    }
    if (req.method === "POST" && pathname === "/api/tasks") {
        const body = await readBody(req);
        const assignmentMode = body.autoAssign || body.assignmentMode === "auto" ? "auto" : "manual";
        const userEmployees = ownedEmployees(state, currentUserId);
        const userEmployeeIds = new Set(userEmployees.map((employee) => employee.id));
        const assignedEmployeeIds = assignmentMode === "auto"
            ? autoAssignEmployees(currentUserState(), body)
            : (Array.isArray(body.assignedEmployeeIds) ? body.assignedEmployeeIds.filter((employeeId) => userEmployeeIds.has(employeeId)) : []);
        const task = {
            id: id("task"),
            title: String(body.title || "未命名任务"),
            projectId: ownedProjects(state, currentUserId).some((project) => project.id === body.projectId) ? body.projectId : ownedProjects(state, currentUserId)[0]?.id,
            ownerUserId: currentUserId,
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
        assignEmployeesToTask(currentUserState(), task, task.assignedEmployeeIds);
        addLog(state, {
            actorType: "user",
            actorId: currentUserId,
            ownerUserId: currentUserId,
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
    const taskDeleteMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (req.method === "DELETE" && taskDeleteMatch) {
        const deleted = deleteOwnedTaskTree(state, currentUserId, taskDeleteMatch[1]);
        if (!deleted)
            return notFound(res);
        addLog(state, {
            actorType: "user",
            actorId: currentUserId,
            ownerUserId: currentUserId,
            event: "deleted_task",
            targetId: taskDeleteMatch[1],
            detail: "删除任务：" + deleted.taskIds.join(", ")
        });
        await saveState(state);
        sendJson(res, 200, { deleted });
        return;
    }
    const taskStatusMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/status$/);
    if (req.method === "PATCH" && taskStatusMatch) {
        const body = await readBody(req);
        const task = findOwnedTask(state, currentUserId, taskStatusMatch[1]);
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
            actorId: currentUserId,
            ownerUserId: currentUserId,
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
        const task = findOwnedTask(state, currentUserId, taskSignoffMatch[1]);
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
        const task = findOwnedTask(state, currentUserId, taskAssignMatch[1]);
        if (!task)
            return notFound(res);
        const ownedEmployeeIds = new Set(ownedEmployees(state, currentUserId).map((employee) => employee.id));
        const employeeIds = Array.isArray(body.employeeIds) ? body.employeeIds.filter((employeeId) => ownedEmployeeIds.has(employeeId)) : [];
        const existingEmployeeIds = new Set(task.assignedEmployeeIds);
        const newEmployeeIds = employeeIds.filter((employeeId) => !existingEmployeeIds.has(employeeId));
        task.assignedEmployeeIds = [...new Set([...task.assignedEmployeeIds, ...employeeIds])];
        assignEmployeesToTask(currentUserState(), task, newEmployeeIds, 18);
        addLog(state, {
            actorType: "user",
            actorId: currentUserId,
            ownerUserId: currentUserId,
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
        const ownedTeamIds = new Set(ownedTeams(state, currentUserId).map((team) => team.id));
        const employee = {
            id: id("emp"),
            templateId: template.id,
            displayName: String(body.displayName || template.name.split(" ")[0]),
            title: String(body.title || aiEmployeeTitleForTemplate(String(template.name || ""))),
            teamId: ownedTeamIds.has(body.teamId) ? body.teamId : ownedTeams(state, currentUserId)[0]?.id,
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
            currentTaskId: null,
            ownerUserId: currentUserId
        };
        state.employees.push(employee);
        addLog(state, {
            actorType: "user",
            actorId: currentUserId,
            ownerUserId: currentUserId,
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
        const employee = findOwnedEmployee(state, currentUserId, employeeLlmConfigMatch[1]);
        if (!employee)
            return notFound(res);
        employee.llmConfig = normalizeLlmConfig(body.llmConfig || body, employee.llmConfig, employee.model);
        employee.model = employee.llmConfig.model || employee.model;
        addLog(state, {
            actorType: "user",
            actorId: currentUserId,
            ownerUserId: currentUserId,
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
        const approval = findOwnedApproval(state, currentUserId, approvalMatch[1]);
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
            actorId: currentUserId,
            ownerUserId: currentUserId,
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
        const task = findOwnedTask(state, currentUserId, taskApprovalMatch[1]);
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
            reviewerUserId: currentUserId,
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
        const task = findOwnedTask(state, currentUserId, taskBreakdownMatch[1]);
        if (!task)
            return notFound(res);
        const existingSubtasks = state.tasks.filter((item) => item.parentTaskId === task.id);
        if (existingSubtasks.length) {
            sendJson(res, 200, { parentTask: task, subtasks: existingSubtasks, reused: true });
            return;
        }
        const project = ownedProjects(state, currentUserId).find((item) => item.id === task.projectId);
        const pmEmployee = ownedEmployees(state, currentUserId).find((employee) => task.assignedEmployeeIds.includes(employee.id)) || ownedEmployees(state, currentUserId).find((employee) => employee.templateId === "tpl_pm") || ownedEmployees(state, currentUserId)[0];
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
            assignEmployeesToTask(currentUserState(), subtask, subtask.assignedEmployeeIds, 6);
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
        const task = findOwnedTask(state, currentUserId, taskChatMessageMatch[1]);
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
        const task = findOwnedTask(state, currentUserId, taskChatRoundMatch[1]);
        if (!task)
            return notFound(res);
        const room = ensureTaskChatRoom(state, task);
        const project = ownedProjects(state, currentUserId).find((item) => item.id === task.projectId);
        const employees = task.assignedEmployeeIds.map((employeeId) => findOwnedEmployee(state, currentUserId, employeeId)).filter(Boolean);
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

    const taskAutomateMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/automate$/);
    if (req.method === "POST" && taskAutomateMatch) {
        try {
            await testUserLlmConfig(currentUser);
        }
        catch (error) {
            sendJson(res, error.status || 502, {
                error: "My API 不可用，自动化未启动：" + (error.message || "模型接口测试失败"),
                provider: error.provider || currentUser.llmConfig?.provider || "",
                model: error.model || currentUser.llmConfig?.model || ""
            });
            return;
        }
        const result = await automateOwnedTask(state, currentUser, currentUserId, taskAutomateMatch[1]);
        if (!result) return notFound(res);
        await saveState(state);
        sendJson(res, result.status === "waiting_approval" ? 202 : 201, result);
        return;
    }
    const taskRunMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/run$/);
    if (req.method === "POST" && taskRunMatch) {
        const body = await readBody(req);
        ensureRuntimeState(state);
        ensureExecutionState(state);
        try {
            if (!findOwnedTask(state, currentUserId, taskRunMatch[1])) return notFound(res);
            const result = await orchestrateTask(state, taskRunMatch[1], {
                requestedAgentId: body.employeeId,
                createId: id,
                now,
                callLlm: (prompt, task, agent, template, project) => runAgentLlm(prompt, task, withUserLlmConfig(currentUser, agent), template, project)
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
                const task = findOwnedTask(state, currentUserId, taskRunMatch[1]);
                const agent = findTaskAgent(currentUserState(), task, body.employeeId);
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
        const task = findOwnedTask(state, currentUserId, taskArtifactMatch[1]);
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
server.listen(port, host, () => {
    console.log(`Agency Team Workstation running at http://${host}:${port}`);
    console.log(`Runtime state file: ${stateFile}`);
    if (!process.env.AGENCY_AUTH_SECRET) {
        console.warn("Using local-development auth secret. Set AGENCY_AUTH_SECRET before exposing this service.");
    }
});
