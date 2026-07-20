# 代码版本与需求驱动研发技术方案

- 状态：草稿，待技术方案确认
- 需求范围：76–102
- 基线：当前 React 19 + Fastify 5 + SQLite + Pi coding-agent 实现

## 1. 背景与需求引用

当前系统以项目作为唯一持续对话、session、终端和工作区边界；智能体收到消息后立即在项目目录执行。新需求在保留直接编码体验的同时，引入：

- 项目级平台托管 Git 仓库；
- 独立工作项、对话、session 与终端；
- 可选的结构化需求研发状态机；
- 正式代码版本 `V1/V2…`；
- 版本历史、Diff、历史文件和工作记录；
- 独立附件上传和不限图片张数。

产品行为以 [需求索引](../requirements/README.md) 中 76–102 为准。本方案不引入外部部署、远程 Git、版本恢复、版本删除、任意比较或应用版本界面。

## 2. 现状代码分析与影响范围

### 2.1 当前模型

- `projects` 保存项目与预览状态，没有当前代码版本或活动工作项。
- `conversation_turns` 和 `conversation_items` 直接关联 `project_id`。
- `AgentRunner` 通过 `SessionManager.continueRecent(paths.projectRoot, paths.sessionRoot)` 续接项目最近 session。
- `ensureProjectPaths` 使用 `sessions/{projectId}`，不是工作项级目录。
- 终端查看器汇总项目所有 `command_execution` Item。
- `ProjectPage` 的 `Viewer` 只有 `app | files | terminal`，默认文件模式。
- 文件 API 只读取当前物理工作目录。
- 图片以 Base64 JSON 随消息一次提交，并受 Fastify 55 MB body 限制。
- `safe-tools` 和 `AgentRunner` 都执行每项目 1 GB 目录容量检查。
- 项目目录没有 Git 初始化，`.git` 仅在文件树隐藏名单中。

### 2.2 主要改造模块

| 范围 | 主要文件 |
|---|---|
| 数据库与领域对象 | `server/db.ts`、`server/store.ts`、`server/domain/types.ts` |
| 项目与工作项路径 | `server/paths.ts` |
| Git 仓库与版本读取 | 新增 `server/version-control.ts` |
| 流程状态机与门禁 | 新增 `server/workflow.ts` |
| 智能体 session 与工具权限 | `server/agent-runner.ts`、`server/safe-tools.ts` |
| API 与实时事件 | `server/app.ts`、`server/realtime.ts` |
| 附件上传 | `server/app.ts`、`src/api.ts`、`src/components/Composer.tsx` |
| 项目页与版本查看器 | `src/pages/ProjectPage.tsx`、新增版本域组件 |
| 类型与客户端 API | `src/types.ts`、`src/api.ts` |
| 需求与验收文档 | `docs/requirements/`、`docs/technical/` |

## 3. 总体架构

### 3.1 领域层级

```text
Project
├── managed Git repository
├── current formal code version
├── at most one active WorkItem
├── archived WorkItems
└── CodeVersions

WorkItem
├── type: structured_requirement | direct_coding
├── isolated conversation and terminal items
├── isolated session JSONL directory
├── managed working branch
├── workflow state / execution state
└── zero or one published CodeVersion
```

工作项是所有消息、session、终端事件、分支和版本来源的关联中心。结构化需求和直接编码共享底层工作项与 Git 服务，仅上层状态机和门禁不同。

### 3.2 Git 存储

建议将 Git 元数据与智能体可写工作区分离：

```text
{guestRoot}/
├── projects/{projectId}/                 # 智能体工作区
├── repositories/{projectId}.git/         # 平台托管的外置 Git dir
├── sessions/{projectId}/{workItemId}/    # Pi session JSONL
└── attachments/{projectId}/...
```

该目录使用非 bare 仓库配置，但不在工作区留下 `.git` 指针文件。平台 Git 命令显式使用：

```text
git --git-dir={repositoryRoot} --work-tree={projectRoot} ...
```

工作区内不存在可写 `.git`。智能体 Bash 找不到平台仓库；只读状态和 Diff 通过受控工具或平台生成上下文提供。

### 3.3 分支与引用

- 正式分支：`refs/heads/main`
- 活动工作分支：内部使用稳定工作项 ID，例如 `refs/heads/work/{workItemId}`
- 正式 tag：`refs/tags/code/v{sequence}`
- 已上线工作分支：完成 `--no-ff` 合并后删除引用
- 已放弃结构化需求：保留工作分支和最后放弃快照
- 已放弃直接编码：删除工作分支并将工作区恢复 `main`

用户标题、需求名称和 slug 不承担 Git 身份职责，避免重命名破坏引用。

## 4. 数据模型

### 4.1 `projects` 扩展

新增：

- `active_work_item_id TEXT NULL`
- `current_code_version_id TEXT NULL`
- `next_requirement_sequence INTEGER NOT NULL DEFAULT 1`
- `next_code_version_sequence INTEGER NOT NULL DEFAULT 1`
- `workspace_revision INTEGER NOT NULL DEFAULT 0`

序号只在服务端事务内分配。需求号创建即占用；版本号仅在发布事务成功时占用。

### 4.2 `work_items`

建议字段：

- `id`
- `project_id`
- `type`
- `requirement_sequence NULL`
- `title`
- `workflow_state`
- `execution_state`
- `base_commit`
- `branch_ref`
- `revision`
- `error`
- `created_at`
- `updated_at`
- `archived_at`
- `published_version_id NULL`

约束：

- 项目最多一个未归档工作项；
- `structured_requirement` 必须有 requirement sequence；
- `direct_coding` 不分配 requirement sequence；
- 已归档工作项不可重新激活。

### 4.3 对话关联

`conversation_turns` 和 `conversation_items` 增加非空 `work_item_id`，并建立：

- `(work_item_id, sequence)` 唯一；
- `(project_id, work_item_id, status, sequence)` 查询索引；
- 所有实时事件携带 `workItemId`。

功能上线前会清空旧数据，因此不编写旧项目到工作项的内容迁移。数据库仍需通过正常 schema 初始化或空库升级创建新表与列。

### 4.4 `code_versions`

建议字段：

- `id`
- `project_id`
- `sequence`
- `source_type`
- `work_item_id`
- `requirement_sequence NULL`
- `title`
- `summary`
- `commit_sha`
- `tag_ref`
- `base_version_id NULL`
- `confirmed_by_guest_id`
- `published_at`

约束：

- `(project_id, sequence)` 唯一；
- `work_item_id` 唯一，保证一个工作项最多发布一个版本；
- 正式记录创建后不提供更新与删除 API；
- `source_type` 首版只允许 `structured_requirement | direct_coding`，模型预留未来独立应用版本关联，不共用编号序列。

### 4.5 `work_item_events`

追加式审计表：

- `id`
- `project_id`
- `work_item_id`
- `kind`
- `source`
- `from_state`
- `to_state`
- `actor_guest_id`
- `details_json`
- `idempotency_key`
- `created_at`

`idempotency_key` 建唯一索引。完整事件用于恢复与排障，前端只请求用户可见事件类型。

### 4.6 附件

新增 `pending_attachments`：

- `id`
- `guest_id`
- `project_id NULL`
- `work_item_id NULL`
- `upload_token`
- `original_name`
- `mime_type`
- `size`
- `storage_path`
- `created_at`
- `expires_at`
- `claimed_at NULL`

消息提交事务将附件从 pending 标记为 claimed，并写入现有 `item_attachments`。定时任务删除超过 24 小时未 claimed 的文件与记录。

## 5. 工作流状态机

### 5.1 结构化需求

```text
requirements_discussion
  -> requirements_pending_confirmation
  -> technical_design
  -> technical_pending_confirmation
  -> development
  -> testing_admission
  -> testing
  -> pending_release
  -> published

任意非终态 -> abandoned
```

允许退回：

- 技术设计 → 需求讨论
- 开发 → 技术设计或需求讨论
- 测试准入 → 开发
- 测试 → 开发
- 待上线 → 测试、开发或技术设计

执行状态单独保存：

```text
idle | running | stopped | failed
```

异常与服务重启只改变执行状态，不自动推进或创建额外阶段。`continue/retry` 在同一阶段重新启动 AgentRunner。

### 5.2 直接编码

直接编码不使用结构化阶段，只保存：

```text
clean | dirty | validating | validation_failed | publishing | publish_failed
```

工作项创建后从 `main` 建分支。每轮成功变更创建内部检查点；用户确认发布后执行轻量验证和原子发布。放弃时删除工作分支并恢复工作区。

### 5.3 动作协议

按钮与自然语言统一转为服务端 WorkflowAction：

- `confirm_requirements`
- `confirm_technical_and_start`
- `publish`
- `return_to_stage`
- `abandon_work_item`
- `discard_direct_changes`
- `stop`
- `continue`
- `retry`
- `create_structured_work`

需要二次确认的动作先创建短期 pending action，返回动作名称、影响说明和当前状态。用户确认后以同一个 idempotency key 执行。按已确认决策，不实现内容变化自动使确认失效；服务端仍校验动作在当前状态是否合法。

## 6. 提示与工具权限

### 6.1 提示模板

拆分当前 `buildAgentPrompt`：

- `buildRequirementInterviewPrompt`
- `buildTechnicalDesignPrompt`
- `buildDevelopmentPrompt`
- `buildTestingPrompt`
- `buildDirectCodingPrompt`

需求提示逐字包含需求 81 的英文访谈规则。技术提示要求先探索代码，仅询问重大未决项。开发与测试提示将已确认文档路径、工作项 ID、基线 commit 和待办作为显式上下文。

### 6.2 阶段权限

`createSafeToolDefinitions` 接收阶段策略：

- 可写路径规则；
- 只读锁定路径；
- 是否允许 Bash；
- 是否允许依赖安装；
- 是否允许平台只读 Git 状态工具。

Bash 沙箱需要对锁定文档实施真实文件系统保护，不能只在提示中约束。Linux 可将锁定文件以只读 bind 重新覆盖到 `/project`；macOS 测试通过操作层模拟并以 Linux 集成测试验证最终边界。

平台 Git 元数据始终在项目 bind mount 外，不暴露给智能体。

## 7. 文档生成

结构化需求工作分支维护：

```text
docs/
├── requirements/Rxxx-feature/
│   ├── README.md
│   ├── NN-atomic-requirement.md
│   └── assets/
├── technical/Rxxx-feature.md
├── test-reports/Rxxx-feature.md
├── releases/Vn.md
├── implementation-status.md
└── technical-decisions.md
```

需求确认、技术确认、测试准入通过和测试通过分别创建平台检查点。需求讨论从第一轮起直接维护 `docs/requirements/Rxxx-*/` 编号需求包，未单独回答的事项采用智能体推荐方案或合理默认值。用户确认需求后，平台只执行编号、存在性和结构校验并提交需求检查点，随后直接切换到 `technical_design` 并自动启动技术设计轮次，不再启动重复整理需求的 session。若编号需求包尚未完整落盘，则只允许创建一次原地补全轮次；已有目录不得重复生成。升级前遗留在 `requirements_pending_confirmation` 的工作项通过“重新执行”走同一快速定稿路径。

开发完成后 `start_testing` 先切换到 `testing_admission` 并创建准入轮次。智能体检查需求、技术方案、实现、自动化测试和项目可用的类型检查、Lint、构建；发现范围内缺陷时先向用户播报，再自动修复并复检。全部通过后生成 `docs/test-reports/Rxxx-admission.json`。服务端校验必需检查、证据和实际命令退出码，随后提交实现检查点、切换到 `testing` 并自动创建完整测试轮次。若智能体结束后报告校验仍失败，服务端将具体原因作为同一工作项的新轮次自动回传，最多执行两轮修复重试；达到上限、任务超时或用户停止后保持在准入阶段，允许手动重试或退回开发。

发布记录在发布事务预备阶段生成并纳入最终合并提交。直接编码只生成 `releases/Vn.md`，其中包含轻量验证摘要，不伪造结构化文档。

已确认需求与技术文档通过路径锁定保持不可变。退回阶段后平台解除对应锁，并将后续产物标记失效。

## 8. 发布事务

### 8.1 预备

1. 获取项目级发布互斥锁。
2. 校验活动工作项、修订号、队列为空和合法状态。
3. 校验工作区边界、敏感文件、二进制大小和 Git 状态。
4. 执行结构化完整门禁或直接编码轻量门禁。
5. 生成候选发布记录。

### 8.2 提交

1. 创建最终工作分支检查点。
2. 在临时引用上生成 `--no-ff` merge commit。
3. 验证 merge tree、文档和候选预览。
4. 在 SQLite 事务中预留下一版本序号并写版本记录意图。
5. 原子更新 `main` 与 `code/vN` 引用。
6. 完成版本记录、项目当前版本和工作项归档。
7. 切换工作区到新 `main` tree，刷新正式预览。
8. 发布实时事件与通知。

### 8.3 失败恢复

发布记录包含 operation ID 和阶段。启动时 reconciler 检查：

- 数据库有意图但引用未更新：删除意图并保留待上线；
- 引用已更新但数据库未完成：根据 operation ID 完成数据库记录；
- 预览刷新失败：按已确认的全有或全无语义恢复旧 refs 和工作区，需求保持待上线。

用户只看到成功版本或待上线失败，不看到中间版本号。

## 9. API 设计

建议新增：

```text
POST   /api/guests/:guestId/projects/:projectId/work-items
GET    /api/guests/:guestId/projects/:projectId/work-items
GET    /api/guests/:guestId/projects/:projectId/work-items/:workItemId
POST   /api/.../work-items/:workItemId/turns
POST   /api/.../work-items/:workItemId/actions
POST   /api/.../work-items/:workItemId/actions/:actionId/confirm

GET    /api/.../versions
GET    /api/.../versions/:versionId
GET    /api/.../versions/:versionId/files
GET    /api/.../versions/:versionId/file
GET    /api/.../versions/:versionId/diff
GET    /api/.../versions/:versionId/diff/:path

POST   /api/.../attachments
DELETE /api/.../attachments/:attachmentId
```

版本与工作记录使用游标或 offset 分页，每页 20 条。历史 Git revision 只能通过数据库 version/work item ID 间接选择，客户端不得提交任意 ref。

项目详情响应增加：

- `activeWorkItem`
- `currentCodeVersion`
- `hasUnpublishedChanges`
- `viewerDefault`

## 10. 实时事件

新增事件：

- `work_item_created`
- `work_item_updated`
- `workflow_action_pending`
- `workflow_transition`
- `document_updated`
- `checkpoint_created`
- `validation_updated`
- `version_publish_progress`
- `version_published`
- `work_item_archived`
- `attachment_updated`

现有 turn、item、file、terminal、thinking 和 todo 事件全部增加 `workItemId`，客户端只合并当前或明确选择的工作项事件。

## 11. 前端交互

### 11.1 状态拆分

`ProjectPage` 当前已较大，版本功能不继续堆入单文件。建议新增：

- `VersionViewer`
- `CurrentWorkPanel`
- `VersionHistory`
- `VersionDetail`
- `WorkHistory`
- `WorkflowBar`
- `WorkflowConfirmDialog`
- `DiffViewer`
- `HistoricalFileViewer`
- `AttachmentUploader`

顶层 Viewer 扩展为 `app | files | terminal | versions`。URL 查询参数保存 section、version ID、work item ID 和历史文件 path。

### 11.2 流程栏

流程栏紧邻 Composer 上方：

- 左侧：工作项标题、`Rxxx`、阶段和执行状态；
- 右侧：一个当前主要动作；
- 更多菜单：退回、停止、放弃；
- 移动端允许两行；
- 危险动作使用统一确认 Dialog。

### 11.3 版本与记录

- 当前工作：概览、需求、技术方案、变更、测试、发布；
- 版本历史：倒序 20 条分页；
- 工作记录：两种工作项与归档内容；
- 历史对话与终端在左侧切换为只读；
- 历史文件使用 Git tree/blob API，不改变当前 viewer 数据源。

### 11.4 预览

预览来源由活动工作项与阶段决定：

- 讨论/设计：正式 `main`
- 开发/测试：活动工作分支工作区
- 待上线：冻结候选工作区
- 发布后：新 `main`
- 放弃后：旧 `main`

现有 iframe 隔离、导航和空闲生命周期继续复用。

## 12. 附件上传

前端不再调用 `encodeImages` 把全部文件放入消息 JSON。改为：

1. 选择任意张 PNG/JPEG；
2. 以有限并发逐个 `POST attachments`；
3. 每个请求只含一张不超过 10 MB 的文件；
4. Composer 保存返回的 attachment ID；
5. 发送消息时提交 ID 列表；
6. 服务端事务认领附件。

上传协议可使用 `multipart/form-data`。Fastify 注册 multipart 流式处理，写入临时路径后校验实际字节数与 MIME。应用层不设置张数和消息总量限制；仍受单文件 10 MB 约束。24 小时清理任务使用有界批次删除过期 pending 文件。

按已确认决策，移除项目 1 GB 配额和实例磁盘低水位保护。该选择会增加公网演示实例资源耗尽风险，技术实现不擅自增加替代配额。

## 13. 安全与隔离

- Git 管理目录位于 AgentRunner bind mount 外。
- 平台 Git 调用使用参数数组，不拼接用户标题或路径到 shell。
- 路径继续经过 canonical root 校验。
- Git tree/blob API只接受服务端解析出的 commit SHA 和规范化相对路径。
- 平台强制排除集合独立于项目 `.gitignore`。
- 发布拒绝秘密文件、嵌套仓库、submodule、越界 symlink、特殊文件和超过 10 MB 的二进制 blob。
- 历史 Markdown、Diff 和终端继续使用安全渲染，不执行版本内容。
- 所有工作项 API重复校验 guest 与 project 归属。

## 14. 兼容性与数据处理

本功能发布前清空历史项目、对话、session、附件和工作区数据。实现无需：

- 合成迁移 `V1`；
- 把旧项目会话映射为工作项；
- 把项目级 session 拆分；
- 为旧附件创建 pending 记录。

仍应保留数据库 schema 初始化的幂等性，保证空持久化磁盘、服务重启和重复部署正常启动。

## 15. 测试计划与验收映射

### 15.1 单元测试

- 状态机合法/非法转移与确认矩阵；
- 序号分配、不复用和发布失败不占号；
- Git 排除、二进制大小、symlink 和 ref 校验；
- 工作项 session 路径隔离；
- pending 附件认领与过期；
- Diff 截断和二进制元数据。

### 15.2 Store 与 API 集成测试

- 项目创建同时初始化仓库；
- 一个项目只能有一个活动工作项；
- 两类工作项完整生命周期；
- 多标签幂等确认；
- 发布各阶段故障注入与 reconciler；
- 历史版本文件不 checkout 工作区；
- 任意 ref/path 攻击被拒绝；
- 超过 5 张图片逐文件上传并成功发送。

### 15.3 AgentRunner 测试

- 不同工作项创建不同 session JSONL；
- 同一工作项继续最近 session；
- 阶段提示和工具策略正确；
- 锁定文档无法通过 write/edit/bash 修改；
- 停止、失败、重启后不自动恢复；
- 重试保留现场。

### 15.4 前端测试

- 两种模式启动与空白新工作；
- 流程栏按钮、自然语言 pending action 和确认 Dialog；
- 版本/工作记录分页与深链接；
- 历史对话、终端和文件只读；
- 自动查看器切换与手动锁定；
- 多图片上传进度、重试、移除；
- 加载、空、失败、禁用和冲突状态。

### 15.5 浏览器验收

- 390、768、1024、1440 宽度；
- 完整结构化需求到 `V1`；
- 多轮直接编码到 `V2`；
- 放弃结构化需求和直接编码；
- 候选预览、正式预览和历史文件互不影响；
- 版本首屏 p95 < 2 秒、文件 Diff p95 < 3 秒。

固定质量命令继续使用：

```bash
npm run test:coverage
npm run typecheck
npm run build
npm audit
```

## 16. 上线、监控与回滚

### 16.1 上线顺序

1. 停止服务并按已确认方案删除历史数据。
2. 部署新 schema、Git 服务和工作项 API。
3. 验证新项目初始化与直接编码路径。
4. 验证结构化需求全流程。
5. 开放版本入口。

### 16.2 运行日志

保留普通服务日志，重点包含：

- repository/work item/operation ID；
- Git 操作阶段与耗时；
- 状态转移拒绝原因；
- 发布恢复结果；
- pending 附件清理结果。

不记录图片内容、对话正文、秘密或完整文件内容。

### 16.3 回滚

由于发布前会删除旧数据，应用代码回滚不能恢复被删除的历史数据。部署前需明确这是一次破坏性切换。应用回滚时，新数据 schema 与旧服务不保证兼容；应优先修复前向问题，而不是依赖旧版本读取新数据。

## 17. 实施步骤与依赖顺序

1. 新领域类型、schema、Store 与状态机。
2. 平台托管 Git 服务、项目初始化和安全边界。
3. 工作项路径、session 隔离、消息与终端关联。
4. 阶段提示、工具权限和文档锁。
5. 结构化需求生命周期与文档检查点。
6. 直接编码工作项与轻量发布。
7. 原子发布、版本详情、Diff 和历史文件 API。
8. 当前工作、版本历史、工作记录和流程栏前端。
9. 预览协调、实时同步、通知与深链接。
10. 独立附件上传与 Composer 改造。
11. 移动端、可访问性、性能与故障注入验收。
12. 清空历史数据并部署。

## 18. 风险与取舍

- 平台无项目配额、无实例磁盘保护且图片总量不限，公网实例存在显著存储耗尽风险；这是已确认取舍。
- 外置 Git dir 提升历史安全性，但平台 Git 操作必须自行处理工作区索引、锁和崩溃恢复。
- 单活动工作项降低并发能力，但避免首版引入 worktree、分支冲突和多预览。
- 发布的全有或全无包含预览恢复，故障注入和 reconciler 是上线前必测项。
- 同一结构化 session 跨阶段保留上下文，阶段提示和工具权限必须由服务端强制，不能依赖模型自律。

## 19. 非目标

- 多活动需求、需求队列和 Git worktree。
- 版本恢复、删除、重命名、下载和任意比较。
- 远程 Git 与 Pull Request。
- 外部生产部署。
- 应用版本界面和应用版本编号。
- 文档直接编辑与文档修订浏览器。
- 附件或项目总容量配额。

## 20. 待确认项

无。产品访谈中的所有设计分支均已形成需求 76–102；本技术方案等待整体确认后再进入业务代码实现。
