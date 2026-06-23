const state = {
  data: null,
  selectedProjectId: "all",
  selectedStatus: "all",
  taskSearch: "",
  selectedTaskId: null
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

function byId(items, id) {
  return items.find((item) => item.id === id);
}

function fmtDate(value) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
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
    ["all", "All states"],
    ["todo", "Backlog"],
    ["running", "In progress"],
    ["waiting_approval", "In review"],
    ["done", "Done"]
  ];
}

function projectForTask(task) {
  return byId(state.data.projects, task.projectId);
}

function healthText(health) {
  const labels = {
    "on-track": "Healthy",
    watch: "Watch",
    risk: "At risk"
  };
  return labels[health] || health || "Not set";
}

function projectStatusText(status) {
  const labels = {
    active: "Active",
    planning: "Planning",
    paused: "Paused",
    done: "Done"
  };
  return labels[status] || status || "Not set";
}

function statusText(status) {
  const labels = {
    todo: "Backlog",
    running: "In progress",
    waiting_approval: "In review",
    done: "Done",
    failed: "Failed",
    approved: "Approved",
    rejected: "Rejected",
    pending: "In review"
  };
  return labels[status] || status;
}

function employeeName(id) {
  return byId(state.data.employees, id)?.displayName || "Unassigned";
}

function userName(id) {
  return byId(state.data.users, id)?.name || "Unknown member";
}

function projectName(id) {
  return byId(state.data.projects, id)?.name || "Unknown project";
}

function teamName(id) {
  return byId(state.data.teams, id)?.name || "No team";
}

function templateFor(employee) {
  return byId(state.data.agentTemplates, employee.templateId);
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
    actions.push(`<button class="secondary-button" data-run-task="${task.id}">Start</button>`);
  }
  if (task.status !== "waiting_approval") {
    actions.push(`<button class="secondary-button" data-approval-task="${task.id}">Request review</button>`);
  }
  actions.push(`<button class="secondary-button" data-done-task="${task.id}">Done</button>`);
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

function taskLogs(taskId) {
  return state.data.auditLogs.filter((log) => log.targetId === taskId || taskApprovals(taskId).some((approval) => approval.id === log.targetId));
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
  const artifacts = taskArtifacts(task.id);
  const logs = taskLogs(task.id);
  const chatMessages = taskChatMessages(task.id);
  const employees = task.assignedEmployeeIds.map((employeeId) => byId(state.data.employees, employeeId)).filter(Boolean);
  const availableEmployees = availableTaskEmployees(task);
  const project = projectForTask(task);
  const subtasks = subtasksForTask(task.id);
  const parentTask = parentTaskForTask(task);

  $("#drawer-title").textContent = task.title;
  $("#drawer-body").innerHTML = `
    <section class="detail-section">
      <p>${task.description || "No description"}</p>
      <div class="detail-grid">
        <div class="detail-item"><span>Project</span><strong>${projectName(task.projectId)}</strong></div>
        <div class="detail-item"><span>Owner</span><strong>${userName(task.ownerUserId)}</strong></div>
        <div class="detail-item"><span>Status</span><strong>${statusText(task.status)}</strong></div>
        <div class="detail-item"><span>Priority</span><strong>${task.priority}</strong></div>
        <div class="detail-item"><span>Created</span><strong>${fmtDate(task.createdAt)}</strong></div>
        <div class="detail-item"><span>Due date</span><strong>${task.dueDate || "Not set"}</strong></div>
      </div>
      ${drawerActionButtons(task)}
    </section>
    <section class="detail-section">
      <h3>Breakdown</h3>
      ${parentTask ? `<div class="timeline-row"><strong>Parent task</strong><span>${parentTask.title}</span></div>` : ""}
      ${subtasks.map((subtask) => `<div class="timeline-row">
        <strong>${subtask.title}</strong>
        <span>${statusText(subtask.status)} · ${subtask.priority} · ${subtask.dueDate || "No due date"}</span>
        <span>${subtask.description || "No description"}</span>
      </div>`).join("") || `<div class="empty">No child tasks</div>`}
    </section>

    <section class="detail-section">
      <h3>Project context</h3>
      <div class="detail-grid">
        <div class="detail-item"><span>Project status</span><strong>${projectStatusText(project?.status)}</strong></div>
        <div class="detail-item"><span>Health</span><strong>${healthText(project?.health)}</strong></div>
        <div class="detail-item"><span>Repository</span><strong>${project?.repository || "Not linked"}</strong></div>
        <div class="detail-item"><span>Knowledge sources</span><strong>${(project?.knowledgeSources || []).join(" / ") || "Not set"}</strong></div>
      </div>
    </section>


    <section class="detail-section">
      <h3>Assigned agents</h3>
      ${employees.map((employee) => {
        const template = templateFor(employee);
        return `<div class="person-row">
          <strong>${employee.displayName} · ${employee.title}</strong>
          <span>${teamName(employee.teamId)} · ${employee.permission} · Load ${employee.load}%</span>
          <span>Role template: ${template?.name || "Not linked"} · Deliverables: ${(template?.deliverables || []).join(", ") || "Not set"}</span>
          <span>${template?.summary || ""}</span>
        </div>`;
      }).join("") || `<div class="empty">No assigned agents</div>`}
      <form class="artifact-form" data-assign-form="${task.id}">
        <select name="employeeId" ${availableEmployees.length ? "" : "disabled"}>
          ${availableEmployees.map((employee) => `<option value="${employee.id}">${employee.displayName} · ${employee.title}</option>`).join("") || `<option>No available agents</option>`}
        </select>
        <button class="secondary-button" type="submit" ${availableEmployees.length ? "" : "disabled"}>Add agent</button>
      </form>
    </section>
    <section class="detail-section">
      <h3>Discussion</h3>
      ${chatMessages.map((message) => `<div class="timeline-row">
        <strong>${actorName(message)}</strong>
        <span>${fmtDate(message.createdAt)}</span>
        <span>${message.content}</span>
      </div>`).join("") || `<div class="empty">No discussion yet</div>`}
      <button class="primary-button" type="button" data-agent-discuss="${task.id}">Run discussion round</button>
      <form class="artifact-form" data-chat-form="${task.id}">
        <textarea name="content" required rows="3" maxlength="360" placeholder="Add context, decision notes, or instructions for agents"></textarea>
        <button class="secondary-button" type="submit">Send note</button>
      </form>
    </section>


    <section class="detail-section">
      <h3>Approval history</h3>
      ${approvals.map((approval) => `<div class="timeline-row">
        <strong>${approval.title}</strong>
        <span>${statusText(approval.status)} · ${approval.risk} · ${fmtDate(approval.createdAt)}</span>
        <span>${approval.action}</span>
      </div>`).join("") || `<div class="empty">No approvals</div>`}
    </section>

    <section class="detail-section">
      <h3>Artifacts</h3>
      ${artifacts.map((artifact) => `<div class="timeline-row">
        <strong>${artifact.title}</strong>
        <span>${artifact.type} · ${employeeName(artifact.createdBy)} · ${fmtDate(artifact.updatedAt)}</span>
        <span>${artifact.summary}</span>
      </div>`).join("") || `<div class="empty">No artifacts</div>`}
      <form class="artifact-form" data-artifact-form="${task.id}">
        <input name="title" required maxlength="80" placeholder="Artifact title" />
        <textarea name="summary" required rows="3" maxlength="260" placeholder="Artifact summary"></textarea>
        <button class="primary-button" type="submit">Add artifact</button>
      </form>
    </section>

    <section class="detail-section">
      <h3>Related audit events</h3>
      ${logs.map((log) => `<div class="timeline-row">
        <strong>${log.detail}</strong>
        <span>${log.actorType === "agent" ? employeeName(log.actorId) : userName(log.actorId)} · ${fmtDate(log.createdAt)}</span>
      </div>`).join("") || `<div class="empty">No audit events</div>`}
    </section>
  `;
}


function drawerActionButtons(task) {
  const actions = [];
  if (task.status !== "done") {
    actions.push(`<button class="primary-button" data-agent-run="${task.id}">Run agent</button>`);
    actions.push(`<button class="secondary-button" data-breakdown-task="${task.id}">Break down</button>`);
  }
  actions.push(taskActionButtons(task).replace('<div class="task-actions">', '').replace('</div>', ''));
  return `<div class="task-actions">${actions.join("")}</div>`;
}


function renderProjects() {
  const target = $("#project-list");
  if (!target) return;
  target.innerHTML = state.data.projects
    .map((project) => {
      const taskCount = state.data.tasks.filter((task) => task.projectId === project.id).length;
      const team = byId(state.data.teams, project.teamId);
      return `
        <article class="project-card">
          <div class="project-top">
            <div>
              <h3>${project.name}</h3>
              <p>${project.code} · ${team?.name || "No team"}</p>
            </div>
            <span class="pill ${project.health === "on-track" ? "done" : "waiting_approval"}">${healthText(project.health)}</span>
          </div>
          <div class="task-meta">
            <span class="pill">${projectStatusText(project.status)}</span>
            <span class="pill">${taskCount}  tasks</span>
            <span class="pill">${project.repository || "No repository"}</span>
          </div>
          <p>${(project.knowledgeSources || []).join(" / ") || "No knowledge sources"}</p>
        </article>
      `;
    })
    .join("");
}

function renderMembers() {
  const target = $("#member-list");
  if (!target) return;
  target.innerHTML = state.data.users
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
    .join("");
}

function renderTemplates() {
  const target = $("#template-list");
  if (!target) return;
  target.innerHTML = state.data.agentTemplates
    .map((template) => `
      <article class="template-card">
        <strong>${template.name}</strong>
        <p>${template.summary}</p>
        <small>${template.division} · ${(template.deliverables || []).join(", ")}</small>
      </article>
    `)
    .join("");
}

function renderChrome() {
  $("#org-name").textContent = state.data.organization.name;
  $("#org-plan").textContent = state.data.organization.plan;

  $("#metric-active-tasks").textContent = state.data.dashboard.activeTasks;
  $("#metric-approvals").textContent = state.data.dashboard.pendingApprovals;
  $("#metric-employees").textContent = state.data.dashboard.availableEmployees;
  $("#metric-risk").textContent = state.data.dashboard.projectsAtRisk;

  $("#team-list").innerHTML = state.data.teams
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
    .join("");
}

function renderFilters() {
  const options = [
    `<option value="all">All projects</option>`,
    ...state.data.projects.map((project) => `<option value="${project.id}">${project.name}</option>`)
  ].join("");
  $("#project-filter").innerHTML = options;
  $("#project-filter").value = state.selectedProjectId;

  $("#status-filter").innerHTML = statusFilterOptions()
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");
  $("#status-filter").value = state.selectedStatus;

  $("#task-project-select").innerHTML = state.data.projects
    .map((project) => `<option value="${project.id}">${project.name}</option>`)
    .join("");

  $("#task-employee-select").innerHTML = state.data.employees
    .map((employee) => `<option value="${employee.id}">${employee.displayName} · ${employee.title}</option>`)
    .join("");

  $("#employee-template-select").innerHTML = state.data.agentTemplates
    .map((template) => `<option value="${template.id}">${template.name} · ${template.division}</option>`)
    .join("");

  $("#employee-team-select").innerHTML = state.data.teams
    .map((team) => `<option value="${team.id}">${team.name}</option>`)
    .join("");
}

function renderTasks() {
  const tasks = state.data.tasks.filter((task) => {
    const projectMatches = state.selectedProjectId === "all" || task.projectId === state.selectedProjectId;
    const statusMatches = state.selectedStatus === "all" || task.status === state.selectedStatus;
    const searchMatches = taskMatchesSearch(task);
    return projectMatches && statusMatches && searchMatches;
  });

  $("#task-list").innerHTML =
    tasks
      .map((task) => {
        const employees = task.assignedEmployeeIds.map(employeeName).join(", ") || "Unassigned";
        return `
          <article class="task-card" data-open-task="${task.id}">
            <div class="task-top">
              <div>
                <h3>${task.title}</h3>
                <p>${task.description || "No description"}</p>
              </div>
              <span class="pill ${task.status}">${statusText(task.status)}</span>
            </div>
            <div class="task-meta">
              <span class="pill ${task.priority.toLowerCase()}">${task.priority}</span>
              <span class="pill">${projectName(task.projectId)}</span>
              <span class="pill">${employees}</span>
              <span class="pill">${task.dueDate || "No due date"}</span>
            </div>
            ${taskActionButtons(task)}
          </article>
        `;
      })
      .join("") || `<div class="empty">No work items</div>`;
}

function renderEmployees() {
  $("#employee-list").innerHTML =
    state.data.employees
      .map((employee) => {
        const template = templateFor(employee);
        return `
          <article class="employee-card">
            <div class="employee-top">
              <div>
                <h3>${employee.displayName} · ${employee.title}</h3>
                <p>${template?.summary || ""}</p>
              </div>
              <span class="pill">${employee.status === "busy" ? "Busy" : "Available"}</span>
            </div>
            <div class="employee-meta">
              <span class="pill">${teamName(employee.teamId)}</span>
              <span class="pill">${employee.permission}</span>
              <span class="pill">${employee.model}</span>
            </div>
            <div class="load-track" aria-label="Load ${employee.load}%">
              <div class="load-bar" style="width:${employee.load}%"></div>
            </div>
          </article>
        `;
      })
      .join("");
}

function renderApprovals() {
  $("#approval-list").innerHTML =
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
                  <button class="secondary-button" data-reject="${approval.id}">Reject</button>
                  <button class="primary-button" data-approve="${approval.id}">Approve</button>
                </div>`
              : ""
          }
        </article>
      `)
      .join("") || `<div class="empty">No pending approvals</div>`;
}

function renderArtifacts() {
  $("#artifact-list").innerHTML =
    state.data.artifacts
      .map((artifact) => `
        <article class="artifact-card">
          <strong>${artifact.title}</strong>
          <p>${artifact.summary}</p>
          <small>${artifact.type} · ${employeeName(artifact.createdBy)} · ${fmtDate(artifact.updatedAt)}</small>
        </article>
      `)
      .join("") || `<div class="empty">No artifacts</div>`;
}

function renderLogs() {
  $("#log-list").innerHTML =
    state.data.auditLogs
      .slice(0, 8)
      .map((log) => `
        <article class="log-row">
          <p>${log.detail}</p>
          <small>${log.actorType === "agent" ? employeeName(log.actorId) : userName(log.actorId)} · ${fmtDate(log.createdAt)}</small>
        </article>
      `)
      .join("");
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
  renderLogs();
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
  await api(`/api/tasks/${taskId}/run`, {
    method: "POST",
    body: JSON.stringify({})
  });
  await load();
  if (state.selectedTaskId) renderDrawer();
}

async function updateTaskStatus(taskId, status) {
  await api(`/api/tasks/${taskId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });
  await load();
  if (state.selectedTaskId) renderDrawer();
}

async function requestApproval(taskId) {
  const task = byId(state.data.tasks, taskId);
  await api(`/api/tasks/${taskId}/approvals`, {
    method: "POST",
    body: JSON.stringify({
      title: `Review request: ${task.title}`,
      requesterEmployeeId: task.assignedEmployeeIds[0],
      action: "Allow the assigned agent to continue with an auditable write action",
      risk: "medium"
    })
  });
  await load();
  if (state.selectedTaskId) renderDrawer();
}

function bindEvents() {
  $("#refresh-btn").addEventListener("click", load);

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

  $("#open-task-modal").addEventListener("click", () => $("#task-modal").showModal());
  $("#open-employee-modal").addEventListener("click", () => $("#employee-modal").showModal());

  $("#task-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: form.get("title"),
        projectId: form.get("projectId"),
        priority: form.get("priority"),
        description: form.get("description"),
        dueDate: form.get("dueDate"),
        assignedEmployeeIds: [form.get("employeeId")]
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

    const breakdownTaskId = target.dataset.breakdownTask;
    const agentDiscussTask = target.dataset.agentDiscuss;
    const agentRunTask = target.dataset.agentRun;
    const runTask = target.dataset.runTask;
    const doneTask = target.dataset.doneTask;
    const approvalTask = target.dataset.approvalTask;
    const approveId = target.dataset.approve;
    const rejectId = target.dataset.reject;

    if (breakdownTaskId) await breakdownTask(breakdownTaskId);
    if (agentDiscussTask) await runAgentDiscussion(agentDiscussTask);
    if (agentRunTask) await runAgent(agentRunTask);
    if (runTask) await updateTaskStatus(runTask, "running");
    if (doneTask) await updateTaskStatus(doneTask, "done");
    if (approvalTask) await requestApproval(approvalTask);
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
  document.body.innerHTML = `<main class="workspace"><div class="panel"><div class="empty">${error.message}</div></div></main>`;
});




