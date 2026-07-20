# 原子需求任务索引

## 使用方式

- 每个编号文档只描述一个可实施、可验证的用户结果。
- “建议前置”用于安排实现顺序，不表示两个任务应合并。
- 同一阶段中没有直接依赖的任务可以并行实现。
- 每个任务文档均包含目标、需求、验收标准、不在范围和独立性与原子性检查。
- `00-product-scope.md` 是总体范围，不作为实现任务。
- 编号 46 对应的旧终端分页任务在访谈中被取消并合并到 45；为保持已形成的任务引用稳定，后续编号不回退。

## 阶段 1：游客入口与身份

| 任务 | 建议前置 |
|---|---|
| [07 提供默认游客](./07-provide-default-guest.md) | 无 |
| [08 创建自定义游客](./08-create-custom-guest.md) | 07 |
| [09 选择并记住游客](./09-select-and-remember-guest.md) | 07、08 |
| [10 在项目外切换游客](./10-switch-guest-outside-project.md) | 09 |
| [12 隔离不同标签页的当前游客](./12-isolate-guest-between-tabs.md) | 09、10 |
| [67 展示产品与参与者身份](./67-show-product-identities.md) | 07、08 |

## 阶段 2：首页输入与项目创建

| 任务 | 建议前置 |
|---|---|
| [19 展示首页引导内容](./19-show-home-introduction.md) | 09、67 |
| [02 校验首页首次需求](./02-validate-initial-request.md) | 19 |
| [03 添加图片附件](./03-add-image-attachments.md) | 19 |
| [04 校验图片附件](./04-validate-image-attachments.md) | 03 |
| [05 管理待发送图片](./05-manage-pending-images.md) | 03、04 |
| [06 处理图片发送失败](./06-handle-image-send-failure.md) | 03、04、05 |
| [01 自动生成项目名称](./01-auto-name-project.md) | 02 |
| [20 从首页启动新项目](./20-start-project-from-home.md) | 01–06、09、19 |

## 阶段 3：主导航与项目列表

| 任务 | 建议前置 |
|---|---|
| [21 使用主导航](./21-navigate-primary-pages.md) | 09、10 |
| [22 折叠桌面侧边栏](./22-collapse-desktop-sidebar.md) | 21 |
| [23 使用窄屏导航抽屉](./23-use-mobile-navigation-drawer.md) | 21 |
| [13 展示当前游客的项目列表](./13-list-current-guest-projects.md) | 10、20、21 |
| [14 加载更多项目](./14-load-more-projects.md) | 13 |
| [15 展示项目卡片](./15-display-project-card.md) | 13 |
| [16 展示项目空状态](./16-show-empty-project-state.md) | 13、19 |
| [70 布局项目卡片网格](./70-layout-project-card-grid.md) | 13、15 |
| [17 从项目列表打开项目](./17-open-project-from-list.md) | 13、15 |
| [18 处理不可用项目](./18-handle-unavailable-project.md) | 17 |

## 阶段 4：持续对话与消息队列

| 任务 | 建议前置 |
|---|---|
| [11 在项目页锁定游客](./11-lock-guest-in-project.md) | 17、20 |
| [24 校验项目后续消息](./24-validate-follow-up-message.md) | 03–06、11 |
| [25 排队执行后续消息](./25-queue-follow-up-messages.md) | 20、24 |
| [26 取消排队消息](./26-cancel-queued-message.md) | 25 |
| [27 停止正在执行的消息](./27-stop-running-message.md) | 25 |
| [28 处理消息失败与超时](./28-handle-message-failure-and-timeout.md) | 25 |
| [54 限制项目存储空间（已由 99 取消）](./54-enforce-project-storage-limit.md) | 25、28 |
| [55 完成智能体消息](./55-complete-agent-message.md) | 25 |
| [56 处理存在歧义的需求](./56-handle-ambiguous-request.md) | 25、55 |

## 阶段 5：对话与执行事件

| 任务 | 建议前置 |
|---|---|
| [29 展示项目对话内容](./29-show-conversation-content.md) | 20、25 |
| [72 标识自己的对话消息](./72-identify-own-messages.md) | 29、67 |
| [63 流式展示智能体回复](./63-stream-agent-reply.md) | 29 |
| [73 展示智能体思考状态](./73-show-agent-thinking-state.md) | 29、63 |
| [74 播报智能体执行进展](./74-narrate-agent-progress.md) | 30、63、73 |
| [75 规划并展示多步骤任务](./75-plan-multi-step-tasks.md) | 25、29、63 |
| [64 渲染对话文本](./64-render-conversation-text.md) | 29、63 |
| [30 展示执行事件卡片](./30-show-action-event-cards.md) | 29 |
| [31 实时展示文件写入](./31-stream-file-write-event.md) | 30 |
| [32 实时展示终端命令](./32-stream-terminal-event.md) | 30 |
| [33 跟随对话最新活动](./33-follow-live-conversation.md) | 29–32、63 |
| [35 分批加载对话历史](./35-load-conversation-history.md) | 29、30 |
| [60 预览已发送图片](./60-preview-sent-image.md) | 29 |
| [68 满足实时事件延迟目标](./68-meet-realtime-latency.md) | 31、32、63 |

## 阶段 6：文件与终端工作区

| 任务 | 建议前置 |
|---|---|
| [41 浏览项目文件树](./41-browse-project-files.md) | 20 |
| [42 查看项目文件](./42-view-project-file.md) | 41 |
| [43 标记本轮变化文件](./43-mark-changed-files.md) | 31、41 |
| [65 实时更新文件树](./65-update-file-tree-live.md) | 31、41 |
| [44 处理文件删除](./44-handle-deleted-file.md) | 30、41、42 |
| [45 查看终端会话](./45-view-terminal-session.md) | 32 |
| [34 跟随查看器最新输出](./34-follow-live-viewer-output.md) | 31、32、42、45 |

## 阶段 7：应用预览与查看器协调

| 任务 | 建议前置 |
|---|---|
| [36 切换右侧查看器](./36-switch-workbench-viewers.md) | 30、41、45 |
| [53 适配项目预览能力](./53-adapt-preview-capability.md) | 36 |
| [37 选择项目默认查看器](./37-choose-default-project-viewer.md) | 36、53 |
| [38 刷新应用预览](./38-refresh-app-preview.md) | 53、55 |
| [39 处理应用预览失败](./39-handle-app-preview-failure.md) | 38 |
| [40 导航应用预览](./40-navigate-app-preview.md) | 38 |
| [62 管理网页预览生命周期](./62-manage-preview-lifecycle.md) | 38、39 |
| [71 隔离生成应用预览](./71-isolate-app-preview.md) | 38、40 |

## 阶段 8：项目工作区布局

| 任务 | 建议前置 |
|---|---|
| [47 调整项目双区宽度](./47-resize-project-workspace.md) | 29、36 |
| [48 切换窄屏项目区域](./48-switch-mobile-project-surface.md) | 29、36 |
| [49 收起桌面项目对话区](./49-collapse-project-conversation.md) | 29、36、47 |
| [50 离开正在运行的项目](./50-leave-running-project.md) | 17、25 |

## 阶段 9：持久化、多标签与恢复

| 任务 | 建议前置 |
|---|---|
| [58 同步同一项目的多个标签页](./58-sync-project-tabs.md) | 25、29–32 |
| [59 管理标签页本地草稿](./59-manage-tab-drafts.md) | 03–06、24 |
| [51 恢复项目实时连接](./51-reconnect-project-updates.md) | 25、29–32、63 |
| [52 处理服务重启中断](./52-recover-after-service-restart.md) | 25、28 |
| [57 保留演示数据](./57-retain-demo-data.md) | 07–10、20、35、41 |
| [61 通知后台任务结果](./61-notify-background-result.md) | 25、50、55、58 |

## 阶段 10：跨页面一致性与验收

| 任务 | 建议前置 |
|---|---|
| [66 显示本地时间](./66-display-local-times.md) | 13、15、29、30 |
| [69 满足普通页面首屏目标](./69-meet-page-load-target.md) | 09、13、19 |

## 阶段 11：工作项与需求驱动研发

| 任务 | 建议前置 |
|---|---|
| [76 初始化项目代码仓库](./76-initialize-project-code-repository.md) | 20、57 |
| [77 创建项目工作项](./77-create-project-work-item.md) | 20、76 |
| [78 选择模式开始新工作](./78-start-work-in-selected-mode.md) | 19、20、77 |
| [79 隔离工作项对话与执行会话](./79-isolate-work-item-conversation-and-session.md) | 25、45、77 |
| [80 限制单个活动工作项](./80-limit-one-active-work-item.md) | 77、79 |
| [81 逐题访谈结构化需求](./81-interview-structured-requirement.md) | 77、80 |
| [82 维护需求文档](./82-maintain-requirement-documents.md) | 41、81 |
| [83 控制工作流阶段流转](./83-control-workflow-transitions.md) | 25、77、80 |
| [84 生成并确认技术方案](./84-generate-technical-design.md) | 82、83 |
| [85 限制各阶段写入权限](./85-enforce-phase-write-permissions.md) | 76、83、84 |

## 阶段 12：实现、测试与正式版本

| 任务 | 建议前置 |
|---|---|
| [86 实现结构化需求](./86-implement-structured-requirement.md) | 76、84、85 |
| [102 执行测试阶段准入检查](./102-gate-entry-to-testing.md) | 84、86 |
| [87 测试结构化需求](./87-test-structured-requirement.md) | 102 |
| [88 发布结构化需求代码版本](./88-publish-structured-code-version.md) | 76、83、87 |
| [89 执行直接编码工作项](./89-run-direct-coding-work-item.md) | 76、78–80、85 |
| [90 发布直接编码代码版本](./90-publish-direct-code-version.md) | 76、89 |
| [91 放弃活动工作](./91-abandon-active-work.md) | 76、77、83、89 |
| [100 保护版本内容边界](./100-protect-version-content-boundaries.md) | 76、85 |

## 阶段 13：版本与工作记录

| 任务 | 建议前置 |
|---|---|
| [92 展示代码版本历史](./92-list-code-versions.md) | 88、90 |
| [93 查看代码版本详情](./93-inspect-code-version.md) | 92、100 |
| [94 浏览版本代码快照](./94-browse-version-code-snapshot.md) | 41、42、76、93 |
| [95 浏览工作记录](./95-browse-work-records.md) | 79、88、90、91 |
| [96 协调版本查看器与应用预览](./96-coordinate-version-viewer-and-preview.md) | 36–40、62、77、92 |
| [97 同步与恢复版本工作流](./97-sync-and-recover-version-workflow.md) | 51、52、58、79、83 |
| [98 审计并通知版本事件](./98-audit-and-notify-version-events.md) | 61、83、88、90、97 |
| [101 适配版本工作流布局与性能](./101-support-version-workflow-layout.md) | 47–49、69、92–96 |

## 阶段 14：附件协议调整

| 任务 | 建议前置 |
|---|---|
| [99 上传不限张数的消息图片](./99-upload-unbounded-image-count.md) | 03–06、24、82、87 |

## 原子性结论

- 共 100 个原子任务。
- 每个任务均只有一个主要用户结果。
- 每个任务均有可单独执行的验收场景。
- 涉及多步状态变化但无法安全拆开的行为，会在任务中说明不可继续拆分的原因，例如“从首页启动新项目”的完整事务。
- 技术选型、目录与部署约束不混入任务需求，统一记录在 `../technical-decisions.md`。
