# 首版实现与验收追踪

当前代码已形成已部署、已验收的首版基线。本文只记录实现与验证入口，不改写原始需求。

## 需求到验证入口

| 需求范围 | 主要实现 | 自动化验证 |
|---|---|---|
| 01–12、19–24、67 | 游客、项目创建、文字与图片校验、标签页本地身份与草稿 | `server/domain/*.test.ts`、`server/app.test.ts`、`src/components/Composer.test.tsx`、`src/pages/PageFlows.test.tsx` |
| 13–18、21–23、66、69–70 | 项目列表、分页、导航、空态/错误态、响应式网格、本地时间 | `server/store.test.ts`、`src/pages/PageFlows.test.tsx`、`src/components/Shell.test.tsx`，以及 768/1023/1024/1440 浏览器验收 |
| 25–35、51–52、55–56、58–61、63–64、68、72–74 | 串行队列、取消/停止/恢复、实时消息与事件、思考状态、执行进展播报、历史窗口、通知、用户身份、安全 Markdown | `server/store.test.ts`、`server/agent-runner.test.ts`、`server/app.test.ts`、`src/pages/ProjectPage.test.tsx`、`src/components/Markdown.test.tsx` |
| 31–34、41–45、54、65 | 项目文件隔离、共享语法高亮查看器、文件树、变更标记、终端输出与容量边界 | `server/files.test.ts`、`server/safe-tools.test.ts`、`server/app.test.ts`、`src/syntax.test.ts`、`src/components/FileViewer.test.tsx`、`src/pages/ProjectPage.test.tsx` |
| 36–40、53、62、71 | 查看器协调、隔离预览、导航/刷新/重试、空闲生命周期 | `server/app.test.ts`、`src/pages/ProjectPage.test.tsx`，以及真实生成网页浏览器验收 |
| 47–50、57 | 工作区调整、移动单区切换、离开后继续执行、持久化 | `src/pages/ProjectPage.test.tsx`，以及 768/1024/1440 浏览器验收 |

## 固定验收命令

```bash
npm run test:coverage
npm run typecheck
npm run build
npm audit
```

覆盖率门槛固定在语句/行 55%、分支 65%、函数 45%；领域规则、消息校验与项目命名为
96%，持久化存储为 89%，页面代码为 71%。智能体运行器另以真实 DeepSeek 任务验证，
避免在单元测试中调用付费模型。

## 已完成的真实链路验收

- DeepSeek V4 Pro 经 Pi session 成功创建项目并写入 `index.html`。
- 对话使用 [有序 Item 协议](./conversation-protocol.md)，线上快照已验证
  `commentary → command → commentary → file change → final answer` 按 ordinal 穿插保存。
- 项目外读取被安全工具拒绝；生产 Linux 命令通过 bubblewrap 只挂载当前项目目录，
  沙箱内使用空 `/proc`，不暴露宿主进程信息。
- 生成网页在无 `allow-same-origin` 的 iframe 中运行，主应用状态与存储不可访问。
- 1440px 桌面为约 30/70 双区；1024px 无横向溢出；768px 使用单区切换。
- 站内终态通知、文件“新建/更新”标记、应用预览及移动导航均已在浏览器验证。

## 部署

`scripts/deploy-gce.sh` 会在指定 GCP 项目中创建 GCE、100GB 持久磁盘、防火墙、
Caddy HTTPS 与 systemd 服务，并在发布前强制执行上面的覆盖率、类型和构建检查。
DeepSeek Key 单独上传到 `/etc/atoms-demo/deepseek.key`，不会进入发布归档。

首版已部署到 GCP 项目 `atoms-demo-20260718-gdh`：

- 线上地址：<https://34.81.124.243.sslip.io>
- 区域与实例：`asia-east1-b` / `atoms-demo`
- 静态 IP：`34.81.124.243`
- 线上真实 DeepSeek 基础验收项目：`6f8f302f-972a-41a2-a1c9-82f571f2a1f5`
- 需求文档工作流验收项目：`ab4344ef-aa3d-4dbb-9362-8475202af7ea`
- 验收结果：任务完成、终端沙箱通过、文件写入通过、预览就绪
- 需求工作流：确认需求后生成
  `docs/requirements/R001-deployment-acceptance-marker/README.md`，再自动进入技术方案
- 测试准入：开发后先进入 `testing_admission`；准入报告通过后自动进入 `testing`
  并创建完整测试轮次。线上验收还覆盖了报告字段兼容失败后的修复重试。
- 页面 API：60 个样本，p95 `247.6ms`，低于 `2s` 目标
- 当前发布目录：`/opt/atoms-demo/releases/20260719160848`
- 浏览器：桌面端与 `390×844` 移动端游客选择、首页和移动导航通过
