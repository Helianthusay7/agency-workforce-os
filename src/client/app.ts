const state = {
  data: null,
  selectedProjectId: "all",
  selectedStatus: "all",
  taskSearch: "",
  employeeTemplateSearch: "",
  currentView: "dashboard",
  selectedTaskId: null,
  editingEmployeeId: null,
  notificationTimer: null
};

const $ = (selector) => document.querySelector(selector);
const api = async (url, options = {}) => {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options
  });
  if (!response.ok) throw new Error((await response.json()).error || "Request failed");
  return response.json();
};

const innerHtmlDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");

function sanitizeHtml(markup) {
  const template = document.createElement("template");
  innerHtmlDescriptor.set.call(template, String(markup ?? ""));
  template.content.querySelectorAll("script, iframe, object, embed, link, meta, base").forEach((node) => node.remove());
  template.content.querySelectorAll("*").forEach((node) => {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = String(attribute.value || "").trim().toLowerCase();
      if (name.startsWith("on") || name === "srcdoc") {
        node.removeAttribute(attribute.name);
        continue;
      }
      if (["href", "src", "xlink:href", "formaction"].includes(name) && /^(javascript|data:text\/html):/.test(value)) {
        node.removeAttribute(attribute.name);
        continue;
      }
      if (name === "style" && /(expression|javascript:|url\s*\()/i.test(attribute.value)) {
        node.removeAttribute(attribute.name);
      }
    }
  });
  return innerHtmlDescriptor.get.call(template);
}

function setHtml(element, markup) {
  if (!element) return;
  innerHtmlDescriptor.set.call(element, sanitizeHtml(markup));
}
function notify(message, tone = "info") {
  const toast = $("#app-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.hidden = false;
  window.clearTimeout(state.notificationTimer);
  state.notificationTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 5200);
}

function approvalNotice(result) {
  if (result?.status !== "waiting_approval" || !result.approval) return null;
  return result.reused
    ? `已有待处理审批单：${result.approval.title}`
    : `AI 已自动创建审批单：${result.approval.title}`;
}

function byId(items, id) {
  return items.find((item) => item.id === id);
}

function fmtDate(value) {
  if (!value) return "未设置";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}





function viewConfig(view) {
  const configs = {
    dashboard: {
      title: "总览",
      showMetrics: true,
      panels: ["onboarding-panel", "project-panel", "task-panel"]
    },
    tasks: {
      title: "任务队列",
      showMetrics: false,
      panels: ["task-panel"]
    },
    employees: {
      title: "AI 员工",
      showMetrics: false,
      panels: ["employee-panel", "member-panel", "template-panel"]
    },
    approvals: {
      title: "审批",
      showMetrics: false,
      panels: ["approval-panel", "artifact-panel", "tool-panel", "log-panel"]
    }
  };
  return configs[view] || configs.dashboard;
}

function renderView() {
  const config = viewConfig(state.currentView);
  const contentGrid = document.querySelector(".content-grid");
  if (contentGrid instanceof HTMLElement) contentGrid.className = `content-grid view-${state.currentView}`;

  const title = document.querySelector(".topbar h1");
  if (title) title.textContent = config.title;

  const metricGrid = document.querySelector(".metric-grid");
  if (metricGrid instanceof HTMLElement) metricGrid.hidden = !config.showMetrics;

  document.querySelectorAll(".content-grid > .panel").forEach((panel) => {
    if (panel instanceof HTMLElement) panel.hidden = !config.panels.some((className) => panel.classList.contains(className));
  });

  document.querySelectorAll(".nav-item").forEach((item) => {
    if (item instanceof HTMLElement) item.classList.toggle("active", item.dataset.view === state.currentView);
  });
}
function taskMatchesSearch(task) {
  const query = state.taskSearch.trim().toLowerCase();
  if (!query) return true;
  const assignedNames = task.assignedEmployeeIds.map(employeeName).join(" ");
  return [task.title, task.description, projectName(task.projectId), assignedNames]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function statusFilterOptions() {
  return [
    ["all", "全部状态"],
    ["todo", "待处理"],
    ["running", "执行中"],
    ["implemented", "已实现"],
    ["tested", "已测试"],
    ["reviewed", "已审核"],
    ["approved", "已批准"],
    ["review", "待审阅"],
    ["waiting_approval", "待审批"],
    ["done", "已完成"]
  ];
}

function projectForTask(task) {
  return byId(state.data.projects, task.projectId);
}

function healthText(health) {
  const labels = {
    "on-track": "健康",
    watch: "关注",
    risk: "有风险"
  };
  return labels[health] || health || "未设置";
}

function projectStatusText(status) {
  const labels = {
    active: "进行中",
    planning: "规划中",
    paused: "已暂停",
    done: "已完成"
  };
  return labels[status] || status || "未设置";
}

function statusText(status) {
  const labels = {
    todo: "待处理",
    running: "执行中",
    implemented: "已实现",
    tested: "已测试",
    reviewed: "已审核",
    review: "待审阅",
    waiting_approval: "待审批",
    done: "已完成",
    failed: "失败",
    approved: "已批准",
    rejected: "已拒绝",
    pending: "待审批"
  };
  return labels[status] || status;
}

function employeeName(id) {
  return byId(state.data.employees, id)?.displayName || "未分配";
}

function userName(id) {
  return byId(state.data.users, id)?.name || "未知成员";
}

function projectName(id) {
  return byId(state.data.projects, id)?.name || "未知项目";
}

function teamName(id) {
  return byId(state.data.teams, id)?.name || "无团队";
}

function templateFor(employee) {
  return byId(state.data.agentTemplates, employee.templateId);
}

function filteredAgentTemplates() {
  const query = state.employeeTemplateSearch.trim().toLowerCase();
  const templates = [...state.data.agentTemplates].sort((a, b) => {
    if (a.source === b.source) return a.name.localeCompare(b.name);
    return a.source === "agency-agents" ? -1 : 1;
  });
  if (!query) return templates;
  return templates.filter((template) => {
    return [template.name, template.division, template.summary, template.source]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
}

function renderEmployeeTemplateOptions() {
  const select = $("#employee-template-select");
  const templates = filteredAgentTemplates();
  setHtml(select, templates
    .map((template) => `<option value="${template.id}">${template.name} · ${template.division}${template.source === "agency-agents" ? " · agency-agents" : ""}</option>`)
    .join("") || `<option value="">没有匹配的岗位模板</option>`);
  renderEmployeeTemplatePreview();
}

function renderEmployeeTemplatePreview() {
  const preview = $("#employee-template-preview");
  const template = byId(state.data.agentTemplates, $("#employee-template-select").value);
  if (!template) {
    preview.textContent = "选择一个岗位模板后，这里会显示专业说明。";
    return;
  }
  setHtml(preview, `
    <strong>${template.name}</strong>
    <span>${template.division || "未分组"} · ${template.source === "agency-agents" ? "来自 agency-agents" : "内置模板"}</span>
    <p>${template.summary || "暂无说明"}</p>
    <small>预期产出：${(template.deliverables || []).slice(0, 5).join(" / ") || "未设置"}</small>
  `);
}

const realTaskLogEvents = new Set([
  "auto_assigned_employees",
  "assigned_employees",
  "requested_approval",
  "resolved_approval",
  "ran_agent_runtime",
  "failed_agent_runtime",
  "created_artifact",
  "signed_task_gate"
]);

function isRealTaskLog(log) {
  return realTaskLogEvents.has(log.event);
}
const taskTemplates = {
  douyin: {
    title: "分析抖音视频数据并给出运营动作",
    description: "请基于抖音创作者中心数据、视频指标、评论内容或增长目标，输出数据解读、趋势判断、回复草案、风险点和需要审批的自动化动作。不要声称已经抓取数据，除非任务提供了数据 artifact 或工具结果。",
    templateId: "tpl_douyin_ops",
    priority: "P1"
  },
  product: {
    title: "分析产品需求并定义 MVP 范围",
    description: "请梳理这个需求的目标用户、核心场景、第一版范围、验收标准、风险点和下一步任务。输出必须能直接进入执行。",
    templateId: "tpl_pm",
    priority: "P1"
  },
  architecture: {
    title: "设计系统架构和执行边界",
    description: "请基于当前需求设计系统模块、数据流、接口边界、执行流程、风险点和最小实现方案。重点保证可落地、可审计、可逐步扩展。",
    templateId: "tpl_architect",
    priority: "P1"
  },
  implementation: {
    title: "制定工程实现计划",
    description: "请把需求拆成可执行的工程步骤，明确需要修改的文件、接口、数据结构、验证方式和交付物。",
    templateId: "tpl_frontend",
    priority: "P2"
  }
};

function employeeForTemplate(templateId) {
  return state.data.employees.find((employee) => employee.templateId === templateId) || state.data.employees[0];
}

function classifyDemand(demand) {
  const text = demand.toLowerCase();
  if (/抖音|douyin|creator\.douyin|视频数据|播放量|完播率|评论回复|自媒体|短视频/.test(text)) {
    return taskTemplates.douyin;
  }
  if (/架构|系统|runtime|接口|数据|后端|执行引擎|worker/.test(text)) {
    return taskTemplates.architecture;
  }
  if (/前端|页面|ui|界面|交互|样式|布局|按钮/.test(text)) {
    return taskTemplates.implementation;
  }
  if (/审查|测试|风险|质量|review|bug|回归/.test(text)) {
    return {
      title: "审查需求风险并给出改进建议",
      description: "请审查这个需求的风险、缺口、测试重点和可执行改进建议。输出必须能直接进入下一步处理。",
      templateId: "tpl_reviewer",
      priority: "P1"
    };
  }
  return taskTemplates.product;
}

function buildDemandTask(demand) {
  const template = classifyDemand(demand);
  const compact = demand.replace(/\s+/g, " ").trim();
  const title = compact.length > 34 ? `${compact.slice(0, 34)}...` : compact;
  return {
    title: title || template.title,
    description: [
      `原始需求：${demand}`,
      "",
      `执行要求：${template.description}`,
      "请生成可以沉淀为交付物的结果，并给出下一步行动。"
    ].join("\n"),
    priority: template.priority,
    employee: employeeForTemplate(template.templateId)
  };
}

async function submitQuickDemand(formElement) {
  const status = $("#quick-demand-status");
  const button = formElement.querySelector("button[type='submit']");
  const form = new FormData(formElement);
  const demand = String(form.get("demand") || "").trim();
  if (!demand) return;

  const taskSpec = buildDemandTask(demand);

  button.disabled = true;

  status.textContent = "正在创建任务...";
  try {
    const task = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: taskSpec.title,
        projectId: state.data.projects[0]?.id,
        priority: taskSpec.priority,
        description: taskSpec.description,
        dueDate: "",
        assignmentMode: "auto",
        autoAssign: true,
        assignedEmployeeIds: []
      })
    });

    status.textContent = "正在让 AI 员工执行...";
    const runResult = await api(`/api/tasks/${task.id}/run`, {
      method: "POST",
      body: JSON.stringify({})
    });

    formElement.reset();
    state.currentView = "tasks";
    await load();
    openDrawer(task.id);
    const notice = approvalNotice(runResult);
    if (notice) {
      status.textContent = "AI 已自动创建审批单，请到审批区处理。";
      notify(notice, "warning");
    } else {
      status.textContent = "已生成交付物，请查看右侧任务详情。";
    }
  } catch (error) {
    status.textContent = error.message || "执行失败，请稍后重试。";
  } finally {
    button.disabled = false;
  }
}

function syncTaskAssignmentMode() {
  const mode = $("#task-assignment-mode")?.value || "auto";
  const employeeSelect = $("#task-employee-select");
  if (employeeSelect) employeeSelect.disabled = mode === "auto";
}
function applyTaskTemplate(templateKey) {
  const template = taskTemplates[templateKey];
  if (!template) return;

  const form = $("#task-form");
  form.elements.title.value = template.title;
  form.elements.description.value = template.description;
  form.elements.priority.value = template.priority;
  form.elements.projectId.value = state.data.projects[0]?.id || "";
  const employee = employeeForTemplate(template.templateId);
  if (employee) form.elements.employeeId.value = employee.id;
  if (form.elements.assignmentMode) form.elements.assignmentMode.value = "manual";
  syncTaskAssignmentMode();
  $("#task-modal").showModal();
}

function closeModal(button) {
  const dialog = button.closest("dialog");
  const form = dialog?.querySelector("form");
  form?.reset();
  dialog?.close();
}

function taskActionButtons(task) {
  if (task.status === "done") {
    return "";
  }

  const actions = [];
  if (task.status === "todo") {
    actions.push(`<button class="secondary-button" data-run-task="${task.id}">开始任务</button>`);
  }
  if (task.status === "implemented") {
    actions.push(`<button class="secondary-button" data-signoff-task="${task.id}" data-signoff-stage="qa">QA 签名</button>`);
  }
  if (task.status === "tested") {
    actions.push(`<button class="secondary-button" data-signoff-task="${task.id}" data-signoff-stage="review">审核签名</button>`);
  }
  if (task.status === "reviewed") {
    actions.push(`<button class="secondary-button" data-signoff-task="${task.id}" data-signoff-stage="product">产品批准</button>`);
  }
  if (task.status === "approved") {
    actions.push(`<button class="secondary-button" data-signoff-task="${task.id}" data-signoff-stage="release">发布完成</button>`);
  }
  return `<div class="task-actions">${actions.join("")}</div>`;
}





function subtasksForTask(taskId) {
  return state.data.tasks.filter((task) => task.parentTaskId === taskId);
}

function parentTaskForTask(task) {
  return task.parentTaskId ? byId(state.data.tasks, task.parentTaskId) : null;
}

function availableTaskEmployees(task) {
  const assigned = new Set(task.assignedEmployeeIds);
  return state.data.employees.filter((employee) => !assigned.has(employee.id));
}

function taskChatRoom(taskId) {
  return state.data.chatRooms?.find((room) => room.taskId === taskId);
}

function taskChatMessages(taskId) {
  const room = taskChatRoom(taskId);
  if (!room) return [];
  return (state.data.chatMessages || []).filter((message) => message.roomId === room.id);
}

function actorName(message) {
  return message.actorType === "agent" ? employeeName(message.actorId) : userName(message.actorId);
}

function taskApprovals(taskId) {
  return state.data.approvals.filter((approval) => approval.taskId === taskId);
}

function taskArtifacts(taskId) {
  return state.data.artifacts.filter((artifact) => artifact.taskId === taskId);
}

function taskToolInvocations(taskId) {
  return (state.data.toolInvocations || []).filter((invocation) => invocation.taskId === taskId);
}

function toolStatusText(status) {
  const labels = {
    running: "\u6267\u884c\u4e2d",
    succeeded: "\u6210\u529f",
    failed: "\u5931\u8d25"
  };
  return labels[status] || status || "\u672a\u77e5";
}

function toolStatusClass(status) {
  if (status === "succeeded") return "approved";
  if (status === "failed") return "rejected";
  return "pending";
}

function toolTargetText(invocation) {
  return invocation?.output?.targetPath || invocation?.input?.targetPath || invocation?.input?.path || "\u672a\u8bb0\u5f55\u76ee\u6807";
}

function toolBytesText(invocation) {
  const value = invocation?.output?.bytesWritten ?? invocation?.output?.contentBytes ?? invocation?.input?.contentBytes;
  return value === undefined || value === null ? "\u672a\u8bb0\u5f55\u5b57\u8282" : String(value) + " \u5b57\u8282";
}

function taskSignoffs(task) {
  return Array.isArray(task?.signoffs) ? task.signoffs : [];
}

function signoffStageText(stage) {
  const labels = {
    qa: "QA 验证",
    review: "独立审核",
    product: "产品验收",
    release: "发布门禁"
  };
  return labels[stage] || stage || "未知阶段";
}

function signoffStatusText(status) {
  const labels = {
    passed: "通过",
    failed: "未通过"
  };
  return labels[status] || status || "未知结果";
}
function taskLogs(taskId) {
  return state.data.auditLogs.filter((log) => {
    const belongsToTask = log.targetId === taskId || taskApprovals(taskId).some((approval) => approval.id === log.targetId);
    return belongsToTask && isRealTaskLog(log);
  });
}

function taskGuidance(task, artifacts) {
  if (!task.assignedEmployeeIds.length) {
    return "这个任务还没有分配 AI 员工。先添加一个 AI 员工，再运行执行。";
  }
  if (!artifacts.length) {
    return "这个任务还没有交付物。点击“让 AI 员工执行”，系统会调用 Runtime 生成交付物并记录执行过程。";
  }
  if (task.status !== "done") {
    return "这个任务已经有交付物。你可以查看结果、继续拆分任务，或确认后标记完成。";
  }
  return "这个任务已经完成。你可以在交付物和审计日志里查看完整结果。";
}

function openDrawer(taskId) {
  state.selectedTaskId = taskId;
  renderDrawer();
  const drawer = $("#task-drawer");
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
}

function closeDrawer() {
  const drawer = $("#task-drawer");
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
}

function renderDrawer() {
  const task = byId(state.data.tasks, state.selectedTaskId);
  if (!task) return;

  const approvals = taskApprovals(task.id);
  const signoffs = taskSignoffs(task);
  const artifacts = taskArtifacts(task.id);
  const toolInvocations = taskToolInvocations(task.id);
  const logs = taskLogs(task.id);
  const chatMessages = taskChatMessages(task.id);
  const employees = task.assignedEmployeeIds.map((employeeId) => byId(state.data.employees, employeeId)).filter(Boolean);
  const availableEmployees = availableTaskEmployees(task);
  const project = projectForTask(task);
  const subtasks = subtasksForTask(task.id);
  const parentTask = parentTaskForTask(task);

  $("#drawer-title").textContent = task.title;
  setHtml($("#drawer-body"), `
    <section class="detail-section">
      <div class="guide-box">${taskGuidance(task, artifacts)}</div>
      <p>${task.description || "暂无描述"}</p>
      <div class="detail-grid">
        <div class="detail-item"><span>项目</span><strong>${projectName(task.projectId)}</strong></div>
        <div class="detail-item"><span>负责人</span><strong>${userName(task.ownerUserId)}</strong></div>
        <div class="detail-item"><span>状态</span><strong>${statusText(task.status)}</strong></div>
        <div class="detail-item"><span>优先级</span><strong>${task.priority}</strong></div>
        <div class="detail-item"><span>创建时间</span><strong>${fmtDate(task.createdAt)}</strong></div>
        <div class="detail-item"><span>截止日期</span><strong>${task.dueDate || "未设置"}</strong></div>
      </div>
      ${drawerActionButtons(task)}
    </section>
    <section class="detail-section">
      <h3>任务拆分</h3>
      ${parentTask ? `<div class="timeline-row"><strong>父任务</strong><span>${parentTask.title}</span></div>` : ""}
      ${subtasks.map((subtask) => `<div class="timeline-row">
        <strong>${subtask.title}</strong>
        <span>${statusText(subtask.status)} · ${subtask.priority} · ${subtask.dueDate || "无截止日期"}</span>
        <span>${subtask.description || "暂无描述"}</span>
      </div>`).join("") || `<div class="empty">还没有子任务</div>`}
    </section>

    <section class="detail-section">
      <h3>项目上下文</h3>
      <div class="detail-grid">
        <div class="detail-item"><span>项目状态</span><strong>${projectStatusText(project?.status)}</strong></div>
        <div class="detail-item"><span>健康度</span><strong>${healthText(project?.health)}</strong></div>
        <div class="detail-item"><span>代码仓库</span><strong>${project?.repository || "未关联"}</strong></div>
        <div class="detail-item"><span>知识来源</span><strong>${(project?.knowledgeSources || []).join(" / ") || "未设置"}</strong></div>
      </div>
    </section>


    <section class="detail-section">
      <h3>分配的 AI 员工</h3>
      ${employees.map((employee) => {
        const template = templateFor(employee);
        return `<div class="person-row">
          <strong>${employee.displayName} · ${employee.title}</strong>
          <span>${teamName(employee.teamId)} · ${employee.permission} · 负载 ${employee.load}%</span>
          <span>角色模板：${template?.name || "未关联"} · 预期产出：${(template?.deliverables || []).join(", ") || "未设置"}</span>
          <span>${template?.summary || ""}</span>
        </div>`;
      }).join("") || `<div class="empty">还没有分配 AI 员工</div>`}
      <form class="artifact-form" data-assign-form="${task.id}">
        <select name="employeeId" ${availableEmployees.length ? "" : "disabled"}>
          ${availableEmployees.map((employee) => `<option value="${employee.id}">${employee.displayName} · ${employee.title}</option>`).join("") || `<option>没有可用 AI 员工</option>`}
        </select>
        <button class="secondary-button" type="submit" ${availableEmployees.length ? "" : "disabled"}>添加 AI 员工</button>
      </form>
    </section>
    <section class="detail-section">
      <h3>讨论</h3>
      ${chatMessages.map((message) => `<div class="timeline-row">
        <strong>${actorName(message)}</strong>
        <span>${fmtDate(message.createdAt)}</span>
        <span>${message.content}</span>
      </div>`).join("") || `<div class="empty">还没有讨论记录</div>`}
      <button class="primary-button" type="button" data-agent-discuss="${task.id}">让 AI 员工讨论</button>
      <form class="artifact-form" data-chat-form="${task.id}">
        <textarea name="content" required rows="3" maxlength="360" placeholder="补充上下文、决策记录或给 AI 员工的指令。"></textarea>
        <button class="secondary-button" type="submit">发送备注</button>
      </form>
    </section>


    <section class="detail-section">
      <h3>审批记录</h3>
      ${approvals.map((approval) => `<div class="timeline-row">
        <strong>${approval.title}</strong>
        <span>${statusText(approval.status)} · ${approval.risk} · ${fmtDate(approval.createdAt)}</span>
        <span>${approval.action}</span>
      </div>`).join("") || `<div class="empty">还没有审批记录</div>`}
    </section>


    <section class="detail-section">
      <h3>治理签名</h3>
      ${signoffs.map((signoff) => `<div class="timeline-row">
        <strong>${signoffStageText(signoff.stage)} · ${signoffStatusText(signoff.status)}</strong>
        <span>${employeeName(signoff.employeeId)} · ${fmtDate(signoff.createdAt)}</span>
        <span>${signoff.note || "无备注"}</span>
      </div>`).join("") || `<div class="empty">还没有治理签名记录</div>`}
    </section>

    <section class="detail-section">
      <h3>交付物</h3>
      ${artifacts.map((artifact) => `<div class="timeline-row">
        <strong>${artifact.title}</strong>
        <span>${artifact.type} · ${employeeName(artifact.createdBy)} · ${fmtDate(artifact.updatedAt)}</span>
        <span>${artifact.summary}</span>
      </div>`).join("") || `<div class="empty">还没有交付物</div>`}
      <form class="artifact-form" data-artifact-form="${task.id}">
        <input name="title" required maxlength="80" placeholder="交付物标题" />
        <textarea name="summary" required rows="3" maxlength="260" placeholder="交付物摘要"></textarea>
        <button class="primary-button" type="submit">添加交付物</button>
      </form>
    </section>

    <section class="detail-section">
      <h3>\u5de5\u5177\u8c03\u7528</h3>
      ${toolInvocations.map((invocation) => [
        '<div class="timeline-row">',
        '<strong>' + invocation.toolName + ' - ' + toolStatusText(invocation.status) + '</strong>',
        '<span>' + employeeName(invocation.agentId) + ' - ' + fmtDate(invocation.completedAt || invocation.startedAt) + '</span>',
        '<span>' + toolTargetText(invocation) + ' - ' + toolBytesText(invocation) + '</span>',
        invocation.error ? '<span>' + invocation.error.message + '</span>' : '',
        '</div>'
      ].join('')).join('') || '<div class="empty">\u8fd8\u6ca1\u6709\u5de5\u5177\u8c03\u7528</div>'}
    </section>

    <section class="detail-section">
      <h3>相关审计事件</h3>
      ${logs.map((log) => `<div class="timeline-row">
        <strong>${log.detail}</strong>
        <span>${log.actorType === "agent" ? employeeName(log.actorId) : userName(log.actorId)} · ${fmtDate(log.createdAt)}</span>
      </div>`).join("") || `<div class="empty">还没有审计事件</div>`}
    </section>
  `);
}


function drawerActionButtons(task) {
  const actions = [];
  if (task.status !== "done") {
    actions.push(`<button class="primary-button" data-agent-run="${task.id}">让 AI 员工执行</button>`);
    actions.push(`<button class="secondary-button" data-breakdown-task="${task.id}">拆分任务</button>`);
  }
  actions.push(taskActionButtons(task).replace('<div class="task-actions">', '').replace('</div>', ''));
  return `<div class="task-actions">${actions.join("")}</div>`;
}


function renderProjects() {
  const target = $("#project-list");
  if (!target) return;
  setHtml(target, state.data.projects
    .map((project) => {
      const taskCount = state.data.tasks.filter((task) => task.projectId === project.id).length;
      const team = byId(state.data.teams, project.teamId);
      return `
        <article class="project-card">
          <div class="project-top">
            <div>
              <h3>${project.name}</h3>
              <p>${project.code} · ${team?.name || "无团队"}</p>
            </div>
            <span class="pill ${project.health === "on-track" ? "done" : "waiting_approval"}">${healthText(project.health)}</span>
          </div>
          <div class="task-meta">
            <span class="pill">${projectStatusText(project.status)}</span>
            <span class="pill">${taskCount} 个任务</span>
            <span class="pill">${project.repository || "未关联仓库"}</span>
          </div>
          <p>${(project.knowledgeSources || []).join(" / ") || "未设置知识来源"}</p>
        </article>
      `;
    })
    .join(""));
}

function renderMembers() {
  const target = $("#member-list");
  if (!target) return;
  setHtml(target, state.data.users
    .map((user) => `
      <article class="member-card">
        <div>
          <strong>${user.name}</strong>
          <span>${user.email}</span>
        </div>
        <span class="pill">${user.role}</span>
        <small>${teamName(user.teamId)}</small>
      </article>
    `)
    .join(""));
}

function renderTemplates() {
  const target = $("#template-list");
  if (!target) return;
  setHtml(target, state.data.agentTemplates
    .map((template) => `
      <article class="template-card">
        <strong>${template.name}</strong>
        <p>${template.summary}</p>
        <small>${template.division} · ${(template.deliverables || []).join(", ")}</small>
      </article>
    `)
    .join(""));
}

function renderChrome() {
  $("#org-name").textContent = state.data.organization.name;
  $("#org-plan").textContent = state.data.organization.plan;

  $("#metric-active-tasks").textContent = state.data.dashboard.activeTasks;
  $("#metric-approvals").textContent = state.data.dashboard.pendingApprovals;
  $("#metric-employees").textContent = state.data.dashboard.availableEmployees;
  $("#metric-risk").textContent = state.data.dashboard.projectsAtRisk;

  setHtml($("#team-list"), state.data.teams
    .map((team) => {
      const count = state.data.employees.filter((employee) => employee.teamId === team.id).length;
      return `
        <div class="team-row">
          <span class="team-dot" style="background:${team.color}"></span>
          <span>${team.name}</span>
          <small>${count}</small>
        </div>
      `;
    })
    .join(""));
}

function renderFilters() {
  const options = [
    `<option value="all">全部项目</option>`,
    ...state.data.projects.map((project) => `<option value="${project.id}">${project.name}</option>`)
  ].join("");
  setHtml($("#project-filter"), options);
  $("#project-filter").value = state.selectedProjectId;

  setHtml($("#status-filter"), statusFilterOptions()
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join(""));
  $("#status-filter").value = state.selectedStatus;

  setHtml($("#task-project-select"), state.data.projects
    .map((project) => `<option value="${project.id}">${project.name}</option>`)
    .join(""));

  setHtml($("#task-employee-select"), state.data.employees
    .map((employee) => `<option value="${employee.id}">${employee.displayName} · ${employee.title}</option>`)
    .join(""));

  renderEmployeeTemplateOptions();

  setHtml($("#employee-team-select"), state.data.teams
    .map((team) => `<option value="${team.id}">${team.name}</option>`)
    .join(""));
}

function renderTasks() {
  const tasks = state.data.tasks.filter((task) => {
    const projectMatches = state.selectedProjectId === "all" || task.projectId === state.selectedProjectId;
    const statusMatches = state.selectedStatus === "all" || task.status === state.selectedStatus;
    const searchMatches = taskMatchesSearch(task);
    return projectMatches && statusMatches && searchMatches;
  });

  setHtml($("#task-list"),
    tasks
      .map((task) => {
        const employees = task.assignedEmployeeIds.map(employeeName).join(", ") || "未分配";
        return `
          <article class="task-card" data-open-task="${task.id}">
            <div class="task-top">
              <div>
                <h3>${task.title}</h3>
                <p>${task.description || "暂无描述"}</p>
              </div>
              <span class="pill ${task.status}">${statusText(task.status)}</span>
            </div>
            <div class="task-meta">
              <span class="pill ${task.priority.toLowerCase()}">${task.priority}</span>
              <span class="pill">${projectName(task.projectId)}</span>
              <span class="pill">${employees}</span>
              <span class="pill">${task.dueDate || "无截止日期"}</span>
            </div>
            ${taskActionButtons(task)}
          </article>
        `;
      })
      .join("") || `<div class="empty">没有符合条件的任务</div>`);
}

function renderEmployees() {
  setHtml($("#employee-list"),
    state.data.employees
      .map((employee) => {
        const template = templateFor(employee);
        return `
          <article class="employee-card compact-employee-card">
            <div class="employee-top">
              <div>
                <h3>${employee.displayName}</h3>
                <p>${employee.title}</p>
              </div>
              <button class="secondary-button compact-edit-button" type="button" data-edit-employee="${employee.id}">${state.editingEmployeeId === employee.id ? "收起" : "编辑"}</button>
            </div>
            <div class="employee-meta compact-employee-meta">
              <span class="pill">${employee.status === "busy" ? "忙碌" : "可用"}</span>
              <span class="pill">${teamName(employee.teamId)}</span>
              <span class="pill">${employee.permission}</span>
              <span class="pill">${employee.llmConfig?.provider || "mock"}</span>
              <span class="pill">${employee.llmConfig?.model || employee.model}</span>
            </div>
            ${state.editingEmployeeId === employee.id ? `<form class="artifact-form employee-config-form" data-llm-form="${employee.id}">
              <select name="provider">
                ${["mock", "openai-compatible", "openai"].map((provider) => `<option value="${provider}" ${(employee.llmConfig?.provider || "mock") === provider ? "selected" : ""}>${provider}</option>`).join("")}
              </select>
              <input name="model" list="model-presets" value="${employee.llmConfig?.model || employee.model || "gpt-5.4-mini"}" placeholder="model" />
              <input name="keyRef" value="${employee.llmConfig?.keyRef || ""}" placeholder="KEY_REF" />
              <input name="baseUrl" value="${employee.llmConfig?.baseUrl || ""}" placeholder="base_url" />
              <input name="timeoutMs" type="number" min="1000" step="1000" value="${employee.llmConfig?.timeoutMs || ((employee.llmConfig?.provider || "mock") === "mock" ? 6000 : 30000)}" placeholder="timeout ms" />
              <input name="temperature" type="number" min="0" max="2" step="0.1" value="${employee.llmConfig?.temperature ?? 0.2}" placeholder="temperature" />
              <button class="secondary-button" type="submit">保存模型</button>
            </form>` : ""}
          </article>
        `;
      })
      .join("") || `<div class="empty">还没有 AI 员工</div>`);
}

function renderApprovals() {
  setHtml($("#approval-list"),
    state.data.approvals
      .map((approval) => `
        <article class="approval-card">
          <div class="approval-top">
            <div>
              <h3>${approval.title}</h3>
              <p>${approval.action}</p>
            </div>
            <span class="pill ${approval.status}">${statusText(approval.status)}</span>
          </div>
          <div class="approval-meta">
            <span class="pill">${projectName(byId(state.data.tasks, approval.taskId)?.projectId)}</span>
            <span class="pill">${employeeName(approval.requesterEmployeeId)}</span>
            <span class="pill">${userName(approval.reviewerUserId)}</span>
            <span class="pill">${approval.risk}</span>
          </div>
          ${
            approval.status === "pending"
              ? `<div class="approval-actions">
                  <button class="secondary-button" data-reject="${approval.id}">拒绝</button>
                  <button class="primary-button" data-approve="${approval.id}">批准</button>
                </div>`
              : ""
          }
        </article>
      `)
      .join("") || `<div class="empty">没有待处理审批</div>`);
}

function renderArtifacts() {
  setHtml($("#artifact-list"),
    state.data.artifacts
      .map((artifact) => `
        <article class="artifact-card">
          <strong>${artifact.title}</strong>
          <p>${artifact.summary}</p>
          <small>${artifact.type} · ${employeeName(artifact.createdBy)} · ${fmtDate(artifact.updatedAt)}</small>
        </article>
      `)
      .join("") || `<div class="empty">还没有交付物</div>`);
}

function renderToolInvocations() {
  const invocations = [...(state.data.toolInvocations || [])].reverse().slice(0, 10);
  setHtml($("#tool-list"),
    invocations
      .map((invocation) => [
        '<article class="tool-card">',
        '<div class="tool-card-top">',
        '<strong>' + invocation.toolName + '</strong>',
        '<span class="pill ' + toolStatusClass(invocation.status) + '">' + toolStatusText(invocation.status) + '</span>',
        '</div>',
        '<p>' + toolTargetText(invocation) + '</p>',
        '<small>' + employeeName(invocation.agentId) + ' - ' + (byId(state.data.tasks, invocation.taskId)?.title || '\u672a\u77e5\u4efb\u52a1') + ' - ' + toolBytesText(invocation) + ' - ' + fmtDate(invocation.completedAt || invocation.startedAt) + '</small>',
        invocation.error ? '<p>' + invocation.error.message + '</p>' : '',
        '</article>'
      ].join(''))
      .join('') || '<div class="empty">\u8fd8\u6ca1\u6709\u5de5\u5177\u8c03\u7528</div>');
}

function renderLogs() {
  setHtml($("#log-list"),
    state.data.auditLogs
      .filter(isRealTaskLog)
      .slice(0, 8)
      .map((log) => `
        <article class="log-row">
          <p>${log.detail}</p>
          <small>${log.actorType === "agent" ? employeeName(log.actorId) : userName(log.actorId)} · ${fmtDate(log.createdAt)}</small>
        </article>
      `)
      .join("") || `<div class="empty">还没有真实任务日志</div>`);
}

function render() {
  renderChrome();
  renderFilters();
  renderProjects();
  renderMembers();
  renderTemplates();
  renderTasks();
  renderEmployees();
  renderApprovals();
  renderArtifacts();
  renderToolInvocations();
  renderLogs();
  renderView();
}

async function load() {
  state.data = await api("/api/state");
  render();
}






async function breakdownTask(taskId) {
  await api(`/api/tasks/${taskId}/breakdown`, {
    method: "POST",
    body: JSON.stringify({})
  });
  await load();
  if (state.selectedTaskId) renderDrawer();
}

async function sendChatMessage(taskId, content) {
  await api(`/api/tasks/${taskId}/chat/messages`, {
    method: "POST",
    body: JSON.stringify({ content })
  });
  await load();
  if (state.selectedTaskId) renderDrawer();
}

async function assignEmployee(taskId, employeeId) {
  await api(`/api/tasks/${taskId}/assign`, {
    method: "POST",
    body: JSON.stringify({ employeeIds: [employeeId] })
  });
  await load();
  if (state.selectedTaskId) renderDrawer();
}

async function runAgentDiscussion(taskId) {
  await api(`/api/tasks/${taskId}/chat/agent-round`, {
    method: "POST",
    body: JSON.stringify({})
  });
  await load();
  if (state.selectedTaskId) renderDrawer();
}

async function runAgent(taskId) {
  const result = await api(`/api/tasks/${taskId}/run`, {
    method: "POST",
    body: JSON.stringify({})
  });
  await load();
  if (state.selectedTaskId) renderDrawer();
  const notice = approvalNotice(result);
  notify(notice || "AI 员工已完成执行并生成交付物。", notice ? "warning" : "success");
}

async function updateTaskStatus(taskId, status) {
  await api(`/api/tasks/${taskId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });
  await load();
  if (state.selectedTaskId) renderDrawer();
}

async function signoffTask(taskId, stage) {
  await api(`/api/tasks/${taskId}/signoffs`, {
    method: "POST",
    body: JSON.stringify({ stage })
  });
  await load();
  if (state.selectedTaskId) renderDrawer();
}
function bindEvents() {
  $("#refresh-btn").addEventListener("click", load);

  document.querySelectorAll(".nav-item").forEach((item) => {
    if (!(item instanceof HTMLElement)) return;
    item.addEventListener("click", () => {
      state.currentView = item.dataset.view || "dashboard";
      renderView();
    });
  });

  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("close", () => dialog.querySelector("form")?.reset());
  });
  $("#task-search").addEventListener("input", (event) => {
    state.taskSearch = event.target.value;
    renderTasks();
  });


  $("#project-filter").addEventListener("change", (event) => {
    state.selectedProjectId = event.target.value;
    renderTasks();
  });

  $("#status-filter").addEventListener("change", (event) => {
    state.selectedStatus = event.target.value;
    renderTasks();
  });

  $("#employee-template-search").addEventListener("input", (event) => {
    state.employeeTemplateSearch = event.target.value;
    renderEmployeeTemplateOptions();
  });

  $("#employee-template-select").addEventListener("change", renderEmployeeTemplatePreview);

  $("#task-assignment-mode")?.addEventListener("change", syncTaskAssignmentMode);
  syncTaskAssignmentMode();

  $("#open-task-modal").addEventListener("click", () => $("#task-modal").showModal());
  $("#open-employee-modal").addEventListener("click", () => $("#employee-modal").showModal());

  $("#quick-demand-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitQuickDemand(event.currentTarget);
  });

  $("#task-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const assignmentMode = form.get("assignmentMode") || "auto";
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: form.get("title"),
        projectId: form.get("projectId"),
        priority: form.get("priority"),
        description: form.get("description"),
        dueDate: form.get("dueDate"),
        assignmentMode,
        autoAssign: assignmentMode === "auto",
        assignedEmployeeIds: assignmentMode === "manual" ? [form.get("employeeId")].filter(Boolean) : []
      })
    });
    event.currentTarget.reset();
    $("#task-modal").close();
    await load();
  });

  $("#employee-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        displayName: form.get("displayName"),
        templateId: form.get("templateId"),
        teamId: form.get("teamId"),
        model: form.get("model"),
        llmConfig: {
          provider: form.get("provider"),
          model: form.get("model"),
          keyRef: form.get("keyRef"),
          baseUrl: form.get("baseUrl"),
          timeoutMs: Number(form.get("timeoutMs") || 0) || undefined,
          temperature: form.get("temperature") === "" ? undefined : Number(form.get("temperature")),
          allowMockFallback: form.get("provider") === "mock"
        },
        permission: form.get("permission")
      })
    });
    event.currentTarget.reset();
    $("#employee-modal").close();
    await load();
  });


  document.body.addEventListener("submit", async (event) => {
    const formElement = event.target;
    if (!(formElement instanceof HTMLFormElement)) return;
    
    
    const llmEmployeeId = formElement.dataset.llmForm;
    if (llmEmployeeId) {
      event.preventDefault();
      const form = new FormData(formElement);
      await api(`/api/employees/${llmEmployeeId}/llm-config`, {
        method: "PATCH",
        body: JSON.stringify({
          provider: form.get("provider"),
          model: form.get("model"),
          keyRef: form.get("keyRef"),
          baseUrl: form.get("baseUrl"),
          timeoutMs: Number(form.get("timeoutMs") || 0) || undefined,
          temperature: form.get("temperature") === "" ? undefined : Number(form.get("temperature")),
          allowMockFallback: form.get("provider") === "mock"
        })
      });
      await load();
      return;
    }
    const chatTaskId = formElement.dataset.chatForm;
    if (chatTaskId) {
      event.preventDefault();
      const form = new FormData(formElement);
      await sendChatMessage(chatTaskId, form.get("content"));
      formElement.reset();
      return;
    }
    const assignTaskId = formElement.dataset.assignForm;
    if (assignTaskId) {
      event.preventDefault();
      const form = new FormData(formElement);
      await assignEmployee(assignTaskId, form.get("employeeId"));
      formElement.reset();
      return;
    }
    const taskId = formElement.dataset.artifactForm;
    if (!taskId) return;
    event.preventDefault();
    const form = new FormData(formElement);
    await api(`/api/tasks/${taskId}/artifacts`, {
      method: "POST",
      body: JSON.stringify({
        title: form.get("title"),
        summary: form.get("summary"),
        createdBy: byId(state.data.tasks, taskId)?.assignedEmployeeIds[0]
      })
    });
    formElement.reset();
    await load();
    renderDrawer();
  });
  document.body.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const drawerCloseButton = target.closest("[data-close-drawer]");
    if (drawerCloseButton instanceof HTMLElement) {
      closeDrawer();
      return;
    }

    const taskOpenButton = target.closest("[data-open-task]");
    if (taskOpenButton instanceof HTMLElement && !target.closest("button")) {
      openDrawer(taskOpenButton.dataset.openTask);
      return;
    }

    const closeButton = target.closest("[data-close-modal]");
    if (closeButton instanceof HTMLElement) {
      closeModal(closeButton);
      return;
    }

    const taskTemplateButton = target.closest("[data-task-template]");
    if (taskTemplateButton instanceof HTMLElement) {
      applyTaskTemplate(taskTemplateButton.dataset.taskTemplate);
      return;
    }

    const breakdownTaskId = target.dataset.breakdownTask;
    const agentDiscussTask = target.dataset.agentDiscuss;
    const agentRunTask = target.dataset.agentRun;
    const runTask = target.dataset.runTask;
    const doneTask = target.dataset.doneTask;
    const signoffTaskId = target.dataset.signoffTask;
    const signoffStage = target.dataset.signoffStage;
    const editEmployeeId = target.dataset.editEmployee;
    const approveId = target.dataset.approve;
    const rejectId = target.dataset.reject;

    if (breakdownTaskId) await breakdownTask(breakdownTaskId);
    if (agentDiscussTask) await runAgentDiscussion(agentDiscussTask);
    if (agentRunTask) await runAgent(agentRunTask);
    if (runTask) await updateTaskStatus(runTask, "running");
    if (doneTask) await updateTaskStatus(doneTask, "done");
    if (signoffTaskId) await signoffTask(signoffTaskId, signoffStage);
    if (editEmployeeId) {
      state.editingEmployeeId = state.editingEmployeeId === editEmployeeId ? null : editEmployeeId;
      renderEmployees();
    }
    if (approveId) {
      await api(`/api/approvals/${approveId}/resolve`, {
        method: "POST",
        body: JSON.stringify({ status: "approved" })
      });
      await load();
      if (state.selectedTaskId) renderDrawer();
    }
    if (rejectId) {
      await api(`/api/approvals/${rejectId}/resolve`, {
        method: "POST",
        body: JSON.stringify({ status: "rejected" })
      });
      await load();
      if (state.selectedTaskId) renderDrawer();
    }
  });
}

bindEvents();
load().catch((error) => {
  setHtml(document.body, `<main class="workspace"><div class="panel"><div class="empty">${error.message}</div></div></main>`);
});




