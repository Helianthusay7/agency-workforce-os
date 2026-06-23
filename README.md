# Agency Team Workstation

多人团队 AI 员工工作站 MVP。

## 运行

```powershell
cd D:\ai\agency
node server.js
```

打开：

```text
http://127.0.0.1:4173
```

## 当前能力

- 组织、团队、项目总览
- AI 员工池，按部门和权限管理
- 任务创建、指派、状态流转
- 审批请求和审批记录
- 交付物、活动日志、运行轨迹
- JSON 文件持久化，无需安装依赖

## 后续接入 agency-agents

当前版本内置了一组与 `agency-agents` 思路一致的岗位模板。后续可以添加同步任务，从：

```text
https://github.com/msitarzewski/agency-agents
```

拉取 agent markdown、`divisions.json` 和 `tools.json`，写入 `agentTemplates` 与工具权限表。
