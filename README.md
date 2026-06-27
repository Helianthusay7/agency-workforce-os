# AI Workforce OS

AI Workforce OS 是一个本地优先的 AI 员工工作站原型。它的目标不是做一个聊天机器人页面，而是把 AI 员工组织成可分配、可执行、可审计的工作流系统。

当前系统支持：用户创建任务，可以手动选择 AI 员工，也可以交给 AI 分配员自动分配；AI 员工通过 Runtime 调用 LLM 或 mock provider 执行任务；执行结果会保存为 artifact，并进入 QA、审核、产品验收、发布门禁等治理流程。

## 核心理念

```text
Task -> Dispatcher -> Orchestrator -> Agent Runtime -> LLM Provider -> Artifact -> Event Store -> Signoff
```

系统里的 AI 员工不是单纯的聊天角色，而是由以下配置组成：

```text
AI 员工 = 角色模板 + 权限 + LLM 配置 + 工具能力 + 当前任务状态
```

## 当前能力

- 任务系统：创建任务、手动分配、AI 自动分配、任务状态流转
- AI 员工：员工模板、权限、模型配置、员工卡片编辑
- Agent Runtime：将任务、员工角色和项目上下文组装为 prompt，调用 LLM，并要求结构化 JSON 输出
- Provider Adapter：支持 `mock`、`openai`、`openai-compatible`
- Artifact：AI 执行结果会保存为结构化交付物
- Execution Trace：记录 prompt、LLM 输出、artifact、执行时间和错误
- Event Store：记录 Runtime 和治理流程事件
- Governance Signoff：`implemented -> tested -> reviewed -> approved -> done`
- 审批流：保留为高风险动作的 Action Gate 原型，后续应改成 AI 自动申请、人类批准
- agency-agents 导入：支持从 markdown agent 模板导入员工岗位
- 抖音运营分析员模板：已作为业务员工案例接入模板层

## 手动分配与自动分配

创建任务时有两种模式：

- AI 分配员自动分配：系统根据任务标题和描述匹配岗位，例如产品、架构、前端、QA、Reviewer、Release、抖音运营等。
- 手动选择 AI 员工：用户明确指定员工，适合已经知道谁最适合处理任务的情况。

当前自动分配员是规则型 dispatcher。后续可以升级为真正的 Dispatcher Agent，让 LLM 根据员工模板、权限、负载和历史表现输出分配方案。

## 审批与签名的区别

系统里有两个容易混淆的概念：

```text
审批 Approval = 批准高风险动作能不能执行
签名 Signoff = 批准任务结果能不能进入下一阶段
```

### Approval

用于危险动作，例如：写文件、改代码、发邮件、发布内容、调用外部平台、自动回复评论、执行抖音脚本。

当前审批仍是 MVP，占位意义更强。合理目标是：AI 员工需要危险动作时自动申请审批，人类只负责批准或拒绝。

### Signoff

用于任务质量治理：

```text
implemented -> QA tested -> Reviewer reviewed -> Product approved -> Release done
```

这样可以避免一个 AI 自己写、自己测、自己批准。

## 运行方式

要求 Node.js 20 或更高版本。

```powershell
cd D:\ai\agency
node server.js
```

打开：

```text
http://127.0.0.1:4173
```

也可以使用 npm script：

```powershell
npm run start
```

## LLM 配置

每个 AI 员工可以单独配置模型：

- provider: `mock` / `openai` / `openai-compatible`
- model: 例如 `gpt-5.4-mini`
- keyRef: 环境变量名，例如 `OPENAI_API_KEY`
- baseUrl: OpenAI-compatible 服务地址
- timeoutMs: 真实 provider 默认建议 `30000`
- temperature: 默认 `0.2`

系统不会保存真实 API Key，只保存环境变量名 `keyRef`。

示例：

```powershell
$env:OPENAI_API_KEY="你的 key"
node server.js
```

如果使用中转站，把员工的 provider 设置为 `openai-compatible`，填写对应 model、baseUrl 和 keyRef。

## 数据存储

当前版本使用单文件 JSON 存储：

```text
data/state.json
```

这适合本地原型和单人开发，但不适合多人并发使用。多请求同时写入时存在覆盖风险。后续应替换为 SQLite 或带事务/锁的存储层。

## 关键文件

```text
server.js              HTTP API、状态读写、任务/员工/审批接口
orchestrator.js        任务编排：选择员工、调用 Runtime、写 artifact/event
agentRuntime.js        构建 prompt、解析 LLM JSON 输出
providerAdapters.js    mock/openai/openai-compatible provider 适配
eventStore.js          Runtime 事件类型和事件写入
executionEngine.js     执行 run/step 状态记录
public/app.js          前端交互逻辑
public/index.html      前端页面结构
public/styles.css      前端样式
data/state.json        本地运行数据
```

## 当前限制

- Tool Runtime 还没有完成，AI 员工目前主要产出结构化 artifact，不会真正安全执行外部工具
- 抖音运营员工目前是岗位和 skill 模板，不等于已经真实调用抖音脚本
- QA AI 和 Reviewer AI 还没有真正自动跑测试、读 diff、点 UI
- 审批还没有完全绑定真实工具动作
- `state.json` 不适合多人并发写入
- 还没有认证、CSRF、防重放、请求大小限制等生产安全能力
- 自动化测试覆盖不足

## 建议下一步

1. Tool Runtime v1：把工具调用变成受控执行单元
2. Action Gate：危险工具动作必须自动申请审批
3. SQLite 存储：替换 `state.json`，解决并发覆盖
4. QA/Reviewer 自动化：让 QA 真跑测试，Reviewer 真审 diff
5. 测试脚本：覆盖权限、状态机、signoff、LLM fallback、HTML sanitization

## GitHub

目标仓库：

```text
https://github.com/Helianthusay7/agency-workforce-os
```