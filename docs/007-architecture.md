# 007 架构

[English](007-architecture.en.md) · 中文

本篇是面向实现者的开发指南。它把 [001 领域模型](001-domain.md) 到 [006 部署](006-deployment.md) 里的概念落到类、接口和文件上。先读分层与依赖规则，再把模块表和测试表当作代码索引。

## 分层

代码分六层，依赖只朝一个方向：

| 层 | 目录 | 职责 | 允许 import |
| --- | --- | --- | --- |
| 核心 | `src/core/` | 领域类型、端口、Engine 及其五个部件，对来源、策略、研判和执行一无所知 | 除 Node 的 `node:crypto` 外只有自己 |
| 策略 | `src/policy.ts`、`src/admission.ts`、`src/limits.ts` | 设置 schema、策略版本、准入门、准入表 | 核心、`node:` 与 `zod` |
| 应用 | `src/app/` | 组合根、Store、副作用队列、Sessions、执行器宿主、HTTP 路由、视图、工具 | 核心、策略、执行器、来源、基础设施 |
| 执行器 | `src/executor/` | 每个工单一个 Session 和一个目录；宿主事件；后台作业与子智能体 | 核心、应用的一部分、基础设施 |
| 来源 | `src/sources/` | 每种来源一个种类：配置、策略部分、渠道、线程上下文、轮询循环 | 核心、基础设施、`src/deployment.ts`；**不** import `src/app/` |
| 基础设施 | `src/infra/` | CLI 传输、进程环境与包装脚本、健康面板、打包路径、文本度量 | 无内部依赖 |
| 面板 | `src/client/` | 在浏览器里运行的面板；只 import 宿主侧的**类型**和几个纯值模块 | `src/core/errors.ts` 与 `src/core/reasons.ts` 的纯值、`src/setup.ts`、`src/limits.ts`、`src/admission.ts`、`src/navigation.ts`、`src/sources/host.ts`、`src/app/api.ts` 的过滤列表与类型 |

### 依赖规则

- **核心不做 I/O。** `src/core/` 里唯一的 Node 导入是 `src/core/ids.ts` 的 `createHash`，用于由输入推导稳定的 id。存储、子进程、时钟都要经 `src/core/ports.ts` 的端口进来。
- **来源不认识应用。** `src/sources/` 看不到 `src/app/`。它通过 `SourceContext`（`src/sources/host.ts`）拿能力，该接口由 `src/app/source-context.ts` 的 `sourceContextOf` 在宿主侧实现。
- **面板只拿类型。** `src/client/` 对 `@deepseek-ai/*` 的 import 全是 `import type`，不 import `@deepseek-ai/dsh-client-ui-primitives`（本地副本在 `src/client/controls.tsx`）。`tests/controls.spec.tsx` 逐行核对这两条，并检查面板模块之间没有环形 import。
- **一个接口一处定义。** 宿主依赖写成窄接口：`SessionsHost`、`SettingsHost`、`SetupHost`、`PassesHost`、`OutboxHost`、`ExecutorHost`、`AssessorHost`、`HttpHost`、`MainToolsHost`、`ExecutorToolsHost`、`ResourceHost`、`LinkHost`、`SourceContextDeps`。多数是其他类的 `Pick`。
- **一个写入者。** 每类状态只有一个写入者：触发、线程、决定、工单、派工归 Engine；副作用行归 Effects；回执归 Outbox；健康项归认领它的部件；`kv` 归 `src/kv.ts` 中登记的条目所有者。

## 状态

一个 SQLite 文件，`<stateDir>/orchestrator.sqlite`，只有 `src/app/store.ts` 的 `Store` 打开它。Runtime 在打开它之前先锁住状态目录。

### 表

| 表 | 形状 | 写入者 |
| --- | --- | --- |
| `trigger` | `id`、`value`（JSON）、`at` | Engine |
| `disposition` | `id`、`value`：它的去向 | Engine |
| `trigger_thread` | `(thread, id, at, human)`，线程时间线的索引 | Store，随每个触发 |
| `thread` | `key`、`value` | Engine；来源写 `meta` |
| `ticket` | `id`、`value` | Engine |
| `decision` | `id`、`thread`、`value` | Engine |
| `effect` | `(kind, key)`、`value`、`seq`、`generation`、`attempts`、`error`、`due`、`since` | Effects |
| `outbox` | `id`、`value`：一条消息及其 `status` | Outbox |
| `kv` | `key`、`value`：其余一切 | 登记它的部件 |

### 生成列与工作集

`SETS` 给几张表加生成列和部分索引，让一轮巡检只扫活动行：`ticket.open`、`ticket.active`、`thread.active`、`thread.subscribed`、`outbox.dropped`、`outbox.pending`。打开数据库时，定义变过或已删除的生成列会被丢掉并重建，缺失的补上，SQLite 由行内 JSON 算出值。`tests/store.spec.ts` 覆盖这两种情形。

### 事务

`Store.atomic` 用 savepoint 实现可嵌套事务，内层失败只回滚自己那层。`afterCommit` 的回调排到最外层提交之后执行，回滚的那层排的回调直接丢弃；回调自己抛错只报告，不影响已提交的事务。

### `kv` 与迁移

`src/kv.ts` 定义每一族 `kv` 记录的所有者、键和值类型。`tests/store.spec.ts` 要求键字面量只在 `src/kv.ts` 和迁移代码里出现。当前 schema 是 11：`src/app/migration.ts` 在启动时把 schema 10 一次性写成当前形状，更旧的拒绝。`SCHEMA_VERSION` 只增不减，旧版本遇到更高版本会拒绝打开。

## 副作用队列

`src/app/effects.ts` 的 `Effects` 是一张持久队列。命令在自己的事务里调 `enqueue(kind, key, payload)`；行随事务提交而可见，回滚则消失。

- **每个 kind/key 只有一行。** 对同一个等待中的 key 再入队会替换载荷、递增 `generation`、把 `attempts` 清零并让它立即到期，队列位置不变。正在运行的那次尝试按 `seq` 与 `generation` 匹配自己那一行，替换过的行不会被它删掉或改写。
- **按种类各一个处理函数。** `handle(kind, run, {limit, retry, ordered, quiet})` 注册；`limit()` 每次派发时求值，返回 0 就把这类扣住（暂停期间就是如此）。
- **顺序。** `ordered` 的种类只看队首一行，前一行没结束（或没到期）就整类停在那里，转达和通知靠这条保序。
- **退避。** 失败按 `retry[0]` 起、每次翻倍、封顶 `retry[1]` 重试。抛 `Later` 表示现在跑不了（没有空槽、来源停用），照 `retry[0]` 推迟但不计失败。
- **健康。** 每类在自己的名字下有一条健康项；连续失败达到 `FAILURES_BEFORE_ERROR`（3）就报错，下次成功自行清除。`quiet` 的种类不报，因为失败已经显示在工单上。

六类工作与它们的处理函数：

| 种类 | 处理函数 | 做什么 |
| --- | --- | --- |
| `assessment` | `MasterAssessor` | 把评估的候选卡片送入主 Session 的一轮，随后告诉 Engine 候选已送达，评估的截止时间从那时算 |
| `launch` | `DshExecutor` | 启动等待中的派工：prepare 命令、执行器 Session、派工消息 |
| `delivery` | `DshExecutor` | 按顺序把工单等待中的输入交给正在运行的派工 |
| `relay` | `Sessions` | 把执行器的报告或问题、或人的后续，以转向方式送入主 Session 的一轮 |
| `notice` | `Sessions` | 不唤醒主 Session 地注入一条通知 |
| `reply` | `Outbox` | 通过来源为某个渠道发一条消息 |

## 巡检与调度

`src/app/passes.ts` 的 `Passes` 是时钟。它每两秒跑一次，来源收到触发、工具执行完命令、设置保存之后也会请求一次。

- **一次只跑一次。** 正在跑时再来请求，只记下一次“跑完再跑一遍”，不排队列。
- **跑什么。** 先 `effects.kick()` 派发到期副作用，再 `engine.evaluateDue()`；两件事都不做业务判断。
- **暂停与等配置。** 未配置完成或正在关闭时直接返回；暂停时 `evaluateDue` 仍会记录暂停，让进行中的评估不过期。
- **健康。** 巡检失败写进 `runtime` 健康项，下一次成功清掉。

`Engine.evaluateDue` 是领域的时钟：为排队触发仍在等待的线程启动评估（每线程一个）、把超期评估的触发重新排队、恢复暂停期间收到人消息的已结束工单。候选尚未送达主 Session 的评估不过期。

## 并发与锁

- **状态目录锁。** Runtime 用 `proper-lockfile` 锁 `<stateDir>`（`stale: 30_000`），拿到之后才打开数据库；锁失效时把 `runtime` 健康项置为错误并中止生命周期信号。第二个进程因此起不来，而不是争着迁移同一份状态。
- **数据库。** `PRAGMA journal_mode=WAL; synchronous=FULL`，文件权限 0600，目录 0700。
- **Engine 全同步。** 每个命令在一个事务里改自己的聚合，端口在事务内排队外部工作，适配器在提交后执行。`evaluateDue` 为它改动的每个评估或每个工单各用一个事务。
- **执行器槽位。** `WorkerSlots` 在启动或唤醒之前预留容量，人的消息可以多用一格，唤醒优先于启动；`maxWorkers` 之外不再启动。
- **面板与 API 的并发。** 设置与提示词都用修订号做乐观并发：保存带 `revision` / `baseRevision`，被别处改过就返回 409，不覆盖。
- **副作用队列的并发上限。** 见上一节；`launch` 的上限恰好是当前空闲槽位数。

## HTTP 接口

`src/app/http.ts` 的 `registerHttp` 在 `ctx.webServer` 上注册 `/orchestrator` 前缀。

- **只有回环。** `ctx.webServer.host` 不是 `127.0.0.1` 时直接抛错。
- **同源检查。** `Host` 必须是 `127.0.0.1:<端口>` 或 `localhost:<端口>`；`x-orchestrator-request` 必须是 `1`；`Origin` 要么缺，要么等于 `http://<host>`。端口取监听端口，监听器还没绑定时取 `getOrigin()` 里的端口，两者都没有就拒绝。不满足返回 403。
- **路由表。** `routes(runtime)` 是一张 `'METHOD path'` 到处理函数的表，路径段以 `:` 开头的是参数（URL 解码，解码失败返回 400）。`src/app/api.ts` 的 `Api` 类型是同一张表的类型侧，只 import 类型，面板因此能打包它。路由清单见 [006 部署](006-deployment.md) 的管理 API 一节。
- **失败映射。** 一个函数把异常翻译成状态码：`z.ZodError` → 400 带 `issues`，`SetupError` → 400 带 `setup`，`RouteError` → 400 或 404，`UserError` → `missing` 时 404、否则 400 并带 `code` 与 `values`，`SettingsConflict` / `PromptConflict` → 409，其他 → 500。
- **请求体。** 默认上限 128 KiB，提示词保存另算；不是 JSON 返回 400。所有响应都是 `application/json; charset=utf-8`、`cache-control: no-store`、`x-content-type-options: nosniff`。
- **启动顺序。** 路由在 setup 之前就注册好，这样配置问题能在面板里修；每个请求先 `await runtime.ready`。

## 客户端模块格式

面板是一个单独的浏览器入口，由 `tsdown.config.ts` 的第二段配置打包成 CJS，再由 banner 与 footer 包进 DSH 的模块加载器：

```js
window.__ModuleLoader__.load({ id: "xenra-superagent", factory: (require) => { /* ... */ return module.exports; } })
```

`id` 必须与 `package.json` 的包名一致，`package.json` 的 `dsh.client` 声明平台 `web` 与需要注入的宿主插件。`lib/client.js` 因此不是一个能直接 `import` 的 ES 模块，而是注册表里的一段工厂。

`src/client/index.tsx` 的 `apply` 做三件事：注册双语字典（命名空间 `xenraSuperagent`）、往 `main` 与 `sidebar.panellist` 槽位注册面板与侧栏图标、往 `plugins.row.config` 注册插件管理器里的配置页。部署页在两处复用：`src/client/deployment.tsx` 的 `DeploymentPage` 从面板传 `state.setup`，`PluginConfig` 则自己轮询状态。

## 测试策略

`tests/` 下 59 个 spec，按被测对象分四类。

- **领域与纯函数。** `core-engine.spec.ts` 在 `MemoryRepositories` 上跑全部领域规则；`stage.spec.ts` 逐行核对 [003 执行](003-execution.md) 的阶段表；`policy.spec.ts` 覆盖准入、授权重新校验和研判结果；`cache.spec.ts`、`timeline.spec.ts`、`markdown.spec.ts`、`marks.spec.ts`、`prompt-config.spec.ts`、`draft.spec.ts` 测纯函数。
- **宿主与服务。** `runtime.spec.ts` 与 `runtime-concurrency.spec.ts` 在模拟的 DeepSeek Harness 宿主上跑整个应用；`sources.spec.ts`、`registry.spec.ts`、`commands.spec.ts`、`deployment.spec.ts`、`environment.spec.ts`、`service-script.spec.ts` 测来源、CLI、配置与脚本；`migration.spec.ts` 用真实的旧库文件验迁移；`store.spec.ts` 比对 SQLite 与内存仓库的顺序与回滚。
- **面板。** `panel-*.spec.tsx` 各测一组页面，对着实现了 `src/app/api.ts` 每条路由的假服务器（`tests/fixtures/panel-server.ts`）；`client.spec.tsx`、`navigation.spec.ts`、`controls.spec.tsx` 测注册、导航与本地控件。
- **文档与契约。** `docs.spec.ts` 检查编号、语言对照、链接方向与本文的两张表；`class-docs.spec.ts` 要求每个类前面有 JSDoc；`model-surface.spec.ts` 核对模型读到的一切（工具、提示词、技能、输入）与 schema、术语表和体积上限；`cards.spec.ts` 逐文件核对内置文本必须写明的规则；`locales.spec.ts` 核对两种语言的占位符与每个错误码都有措辞；`styles.spec.ts` 核对样式表只用组件真的用到的类。

需要 POSIX 的用例（`#!/bin/sh` 包装脚本、`tmux`、`ps`）以 `it.skipIf` 跳过，见 `tests/fixtures/platform.ts`。

## 模块

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | 插件主入口：读机器设置、构造 Runtime、把重启回调交给它，并把 `Config` 与核心一起导出 |
| `src/deployment.ts` | 插件的 `Config` 与 `Machine`；`resolveDeployment` 与 `resolveFeishuBot` 从来源设置读出仓库与账号，每次 CLI 调用都按执行器 shell 的方式运行；`SETUP_FIELDS` 列出 setup 读取的来源字段 |
| `src/setup.ts` | setup 问题：`SetupError` 及其编码表 `SETUP_PROBLEMS`，每条带修复位置与中英共用的英文原文 |
| `src/policy.ts` | 设置 schema、`policyVersion`、`settingsPolicy` 给出的 `Policy`、准入表校验、`policyEffects` 与 `assessmentOutcome` |
| `src/admission.ts` | 准入表的三个格子、各格可用取值与默认值，与面板共用 |
| `src/limits.ts` | 人可以设置的值的上限，由设置 schema 校验，也由面板字段给出 |
| `src/kv.ts` | `KV`：每一族 `kv` 记录及其键、值类型与所有者，以及 `Key`、`Family`、`record`、`family` |
| `src/navigation.ts` | `openKnownSession`：宿主目录列出某个 Session 之后从面板打开它 |
| `src/core/model.ts` | 领域类型与不改写的不变量，含 `threadKey`、`isoTime`、`liveTicket`、`ticketOutcome`、`reached`、`followupOwners`、`settled`、`waitsForPerson`、`runningAssignment`、`latestAssignment`、`latestReport` |
| `src/core/ports.ts` | 端口：`Repositories`、`Policy`、`SourceScope`、`Assessor`、`Executor`、`Outbox`，以及 `DomainEvents` |
| `src/core/engine.ts` | Engine 与五个角色接口 `EngineForSources`、`EngineForMainSession`、`EngineForPeople`、`EngineForSettings`、`EngineForExecutor` |
| `src/core/part.ts` | `EnginePart` 基类与 `EngineOptions`：各部件共享的仓库、策略、时钟、事件与交回逻辑 |
| `src/core/intake.ts` | `Intake`：接收触发、关联线程、扇出订阅、排队评估 |
| `src/core/evals.ts` | `Evals`：线程的评估、批量、候选、重放、交回与决定 |
| `src/core/tickets.ts` | `Tickets`：工单从接单到结束的生命周期、它跟随的线程、订阅与输入 |
| `src/core/assignments.ts` | `Assignments`：派工的开始、读写、结束，以及执行器报告与其中的问题 |
| `src/core/replies.ts` | `Replies`：Engine 经 Outbox 的渠道写入，每种用途一条规则 |
| `src/core/stage.ts` | `ticketStage` 与 `canRetry`：工单阶段与可重试性 |
| `src/core/errors.ts` | `UserError` 与 `USER_ERRORS`：固定拒绝的编码、类别与英文模板 |
| `src/core/reasons.ts` | `REASONS`、`Reason`、`said`、`reasonText`：决定与搁置的理由编码 |
| `src/core/ids.ts` | `key`：由输入推导的稳定 id |
| `src/core/memory.ts` | `MemoryRepositories`：Store 仓库的内存版，顺序与嵌套回滚都与 Store 一致 |
| `src/core/index.ts` | 核心的导出面 |
| `src/app/runtime.ts` | Runtime：组合根，锁状态目录、构造各部件、注册路由与来源宿主、启动与关闭 |
| `src/app/setup.ts` | `Setup` 与 `setupChanged`：探测 CLI、写并应用执行环境、记录 setup 问题、必要时重启 |
| `src/app/passes.ts` | `Passes`：两秒一次的巡检，合并请求，把失败写进 `runtime` 健康项 |
| `src/app/store.ts` | `Store`：SQLite 上的领域仓库、`kv`、设置版本、回执，以及 `Receipt`、`SettingsVersion` |
| `src/app/store-read.ts` | `storeReads`：视图、工具与来源轮询用的只读查询 |
| `src/app/migration.ts` | schema 11 迁移：一次把 schema 10 写成当前形状，并拒绝更旧的 |
| `src/app/effects.ts` | `Effects`、`Later`、`FAILURES_BEFORE_ERROR`：持久副作用队列 |
| `src/app/versions.ts` | `Versions`：带编号快照加当前指针的版本化存储，设置与提示词共用 |
| `src/app/cache.ts` | `TextCache`：按大小上限在内存里保存文本，最久未用的先丢 |
| `src/app/git-upgrade.ts` | `GIT_MINIMUM`、`atLeast`、`planUpgrade`、`upgrade`：说明执行器用的 git 版本，并给出这台机器可运行的升级命令；只在人确认后执行 |
| `src/app/settings.ts` | `Settings` 与 `SettingsConflict`：分块校验、修订号、暂停、策略同步与显示名刷新 |
| `src/app/settings-history.ts` | `policyHistory`：每个保存过的设置修订号，连同它相对上一版改了什么 |
| `src/app/prompts.ts` | `Prompts`、`builtInParts`、`promptParts`、`PromptConflict`：版本化提示词、内置分段覆盖、组装与校验 |
| `src/app/context.ts` | 从 `prompts/` 与 `skills/` 读入的内置文本，以及 `transcriptEntry` |
| `src/app/skill-files.ts` | `promptFile` 与 `bundledSkills`：把一句一行的文件连成段落，并读取随包发布的技能 |
| `src/app/sessions.ts` | `Sessions`、`WORKER_PRESET`、`ROUTER_PRESET`：Session 的创建、修饰、工具限制、送达与模型重试 |
| `src/app/delivery.ts` | `AgentDelivery` 与 `messageId`：一个请求 id 只送达一次，跨恢复的 Session 也如此 |
| `src/app/retry-health.ts` | `RetryHealth`：哪些 Session 在等模型预算重试，供 `models` 健康项使用 |
| `src/app/role-models.ts` | `resolveRoleModel` 与 `initializeRoleModel`：解析角色模型，并把它种到新 Session 上 |
| `src/app/assessment.ts` | `MasterAssessor`、`AssessmentSchema`、`EvalReadSchema`：研判的候选卡片、有界读取与结果转换 |
| `src/app/execution-environment.ts` | 执行环境：`EXECUTOR_VARIABLES`、`executionRoot`、`environmentOf`、`ticketEnvironment`、`environmentLines` |
| `src/app/source-context.ts` | `sourceContextOf` 与 `SourceContextDeps`：每个来源种类的 `SourceContext` |
| `src/app/links.ts` | `sourceLink`、`repliedTo`、`candidateCard`：来源消息的链接与候选卡片 |
| `src/app/cards.ts` | 给模型的紧凑卡片、`TICKET_STATES`、`textPage`、`relatedTickets` |
| `src/app/resources.ts` | `RESOURCES`、`resourceGrammar`、`readResource`：`orchestrator_read` 能读的一切 |
| `src/app/notices.ts` | `eventNotice`、`reportRelay`、`resultRelay`、`followupRelay`、`receiptNotice`：主 Session 的通知与转达 |
| `src/app/outbox.ts` | `Outbox`：`Outbox` 端口，回执与 `reply` 副作用 |
| `src/app/http.ts` | `registerHttp`、`sameOrigin`、`stateView`：路由表、同源检查与失败映射 |
| `src/app/api.ts` | `Api`：每条路由的参数、查询、请求体与响应，以及列表过滤条件；只 import 类型 |
| `src/app/tools/tool.ts` | `Tool`、`RegisterTool`、`readTool`、`AcknowledgementSchema` |
| `src/app/tools/main.ts` | `mainTools` 与 `MainToolsHost`：主 Session 的十四个应用工具 |
| `src/app/tools/executor.ts` | `executorTools` 与 `ExecutorToolsHost`：执行器的六个应用工具 |
| `src/app/views/text.ts` | `preview`、`markdown`、`plain`、`readable`、`attribute`：视图文本的两种形式 |
| `src/app/views/records.ts` | 视图共用的行与 `snapshot`、`ownersOf`、`channelLink`、`decisionView` |
| `src/app/views/tickets.ts` | `ticketList`、`ticketDetail`、`basisFacts`、`executorLoad` |
| `src/app/views/threads.ts` | `threadList`、`threadDetail`、`search`、`decisionList` |
| `src/app/views/sources.ts` | `sourcesStatus`、`sourceHealth`、`sourceState`、`droppedReplies` |
| `src/app/views/settings.ts` | `settingsView`：各块及其修订号、每个来源的配置与策略元数据、执行环境 |
| `src/app/views/overview.ts` | `overview` 与 `evalsHealth`：问题、待人工决定的工单、负载与一天的流量 |
| `src/executor/dsh.ts` | `DshExecutor`、`WorkerSlots`、`ticketExecution`、`inputMessage`、`mandateInstructions`、`workerSessionId` |
| `src/executor/background.ts` | 执行器的后台工作：`runningJobs`、`untilQuiet`、`killJobs`、`collectJobs`、`stopSubagents`、`stopBackground`、`until`、`cancelled` |
| `src/infra/commands.ts` | `Commands`、`CliError`、`commandError`、`validItems`：CLI 传输，限定仓库，不打印参数 |
| `src/infra/environment.ts` | 包装脚本、`worker-gitconfig`、`agentVariables`、`applyEnvironment`、`runAsWorker`、`verifyEnvironment`、`verifyDirectory` |
| `src/infra/health.ts` | `HealthBoard` 与 `HealthEntry`：每个部件一条健康项，单写入者认领 |
| `src/infra/paths.ts` | `packageRoot` 与 `packagePath`：从源码树或 `lib/` 找到包内文件 |
| `src/infra/platform.ts` | `WINDOWS`、`pathKey`/`pathValue`/`pathEnv`、`shellCommand`、`spawnArgv`、`resolveExecutable`、`sameDirectory`：平台差异只在这一处回答 |
| `src/infra/text.ts` | `IM_WORDS`、`NOTE_WORDS`、`wordCount`、`checkedImText`、`fill`、`sameName`、`escapeRegExp` |
| `src/sources/kind.ts` | `SourceKind` 协议：配置 schema、表单字段、策略部分、渠道、线程上下文、环境变量 |
| `src/sources/registry.ts` | `SourceRegistry`：已注册种类、已保存实例、`SourceScope` 实现、渠道与上下文的转发 |
| `src/sources/host.ts` | `SourceHost`、`SourceContext`、`Health`、`health`、`HEALTH_TEXT` |
| `src/sources/poll.ts` | 轮询共用部分：`POLL_HORIZON_MS`、`polled`、`cursorAt`、`pollThreads`、`pause` |
| `src/sources/github.ts` | GitHub 种类与插件入口，导出为 `./github-watch`：通知轮询、全量接收、开放工单的 PR 及其 CI |
| `src/sources/github-trigger.ts` | GitHub 的 Issue、PR、评论、review 与 CI 变化作为触发，以及地址与提及判定 |
| `src/sources/github-pull.ts` | PR 规则：`readPull`、`claimPull`、`observePull`、`pullsOf`、`pullOf`、`pullEndNotices` |
| `src/sources/github-channel.ts` | GitHub 渠道：`sendGithub` 与 `githubLink` |
| `src/sources/github-read.ts` | `readGithub`、`pullChecks`、`readRepositoryPath`、`githubThreadContext` 与 CI 摘要 |
| `src/sources/feishu.ts` | 飞书种类与插件入口，导出为 `./feishu-watch`：配置、策略部分（含群同步）与环境变量 |
| `src/sources/feishu-trigger.ts` | 飞书事件、历史页与话题页统一翻译成触发 |
| `src/sources/feishu-loops.ts` | 飞书的循环：事件消费者、历史补收、群名刷新、订阅线程轮询 |
| `src/sources/feishu-channel.ts` | 飞书渠道：`sendFeishu` 与 `feishuLink` |
| `src/sources/feishu-read.ts` | `feishuRead`、`readFeishu`、`feishuReferences`、`readFeishuLink`、`feishuThreadContext` |
| `src/sources/feishu-image.ts` | `admissionImageKeys` 与 `readAdmissionImage`：把消息里的图片读成研判可用的附件 |
| `src/sources/admission-context.ts` | `threadWindow` 与 `admissionContext`：一次研判起始的有界线程窗口 |
| `src/client/index.tsx` | 客户端插件入口：字典、侧栏图标、主面板与插件管理器配置页的注册 |
| `src/client/app.tsx` | 面板外壳：页头、搜索、术语表、三个标签页与当前路由的页面；未配置时装上首次配置引导 |
| `src/client/provider.tsx` | `PanelProvider`、`usePanel`、`usePanelData`、`useAction`：面板上下文、轮询与重启检测 |
| `src/client/api.ts` | `caller`、`ApiError`、`usePoll` 与各视图的类型别名 |
| `src/client/route.ts` | `TABS`、`SETTINGS_GROUPS`、`parseRoute`、`initialLocation`、`remember` |
| `src/client/home.tsx` | 首页：先是等你处理的事，其次是一句话的运行状态；执行器计数收在折叠区 |
| `src/client/setup-wizard.tsx` | 首次配置引导：仓库、账号、可以派活的人、工作目录四步，每步直接写对应的设置块 |
| `src/client/source.tsx` | 来源状态与来源设置卡片 |
| `src/client/trigger.tsx` | 触发状态：按过滤条件列出的线程 |
| `src/client/eval.tsx` | 评估状态（决定日志）与评估设置（策略、准入表、研判设置） |
| `src/client/git-repair.tsx` | 部署页里的 git 修复：说明当前版本与所需版本，先把要运行的命令与风险摆出来，再由人确认或自行处理 |
| `src/client/execution.tsx` | 执行状态、暂停控制与执行设置 |
| `src/client/thread.tsx` | 线程详情页 |
| `src/client/ticket.tsx` | 工单详情页 |
| `src/client/settings.tsx` | 设置页外壳：分组导航与当前分组 |
| `src/client/settings-kit.tsx` | 设置块的构件：`useBlockDraft`、字段、来源字段渲染、保存历史 |
| `src/client/prompts.tsx` | 提示词设置：编辑、完整提示词与历史 |
| `src/client/prompt-config.ts` | 提示词配置的纯函数：分段、技能、内置部件覆盖与行级差异 |
| `src/client/deployment.tsx` | 部署设置页，面板与插件管理器共用 |
| `src/client/draft.tsx` | 设置草稿：`draftReducer`、`merge3`、`saveBarText`、保存栏 |
| `src/client/controls.tsx` | DSH 控件的本地副本：按钮、标签、开关、弹窗、提示等，不读上下文 |
| `src/client/widgets.tsx` | 读面板上下文的共用小组件：小节、页头、加载态、时间、链接、Markdown |
| `src/client/rows.tsx` | 页面共用的行：工单、线程、决定，以及连续自动消息的折叠 |
| `src/client/markdown.ts` | 报告与问题所用的 Markdown 子集，以及裸地址的链接化 |
| `src/client/marks.ts` | 状态标记：工单与线程的阶段、来源状态、决定结果，各为一个圆点、图标、色调与标签 |
| `src/client/text.ts` | 按键取文案，以及领域取值、理由、发送者与时间的措辞 |
| `src/client/locales.ts` | 两种语言的全部文案与术语表 |
| `src/client/client.css` | 面板样式表，按 DSH 的 `--dsw-alias-*` 设计令牌书写，每行一条规则 |
| `src/client/css.d.ts` | `?raw` 样式表导入的类型声明 |

`src/sources/github.ts` 与 `src/sources/feishu.ts` 同时是两个来源插件的入口，由 `tsdown.config.ts` 构建，并在 `package.json` 里导出为 `./github-watch` 与 `./feishu-watch`。bundle 的 `cordis.patch.yml` 插入三个插件，飞书处于停用状态。

## 测试

| 路径 | 覆盖 |
| --- | --- |
| `tests/core-engine.spec.ts` | 内存仓库上的全部领域规则：接收、评估、扇出、恢复与停止、被中断的派工、暂停、策略变更、报告与结果、挂上、回复、失败的送达 |
| `tests/stage.spec.ts` | 工单阶段与可重试性，逐行 |
| `tests/policy.spec.ts` | 准入、准入表、授权重新校验、策略版本、设置迁移与研判结果 |
| `tests/registry.spec.ts` | `SourceRegistry`：实例、校验、策略部分、渠道、线程上下文与健康项认领 |
| `tests/sources.spec.ts` | 飞书与 GitHub 来源：翻译、轮询与读取位置、PR 规则、健康、循环的启停 |
| `tests/commands.spec.ts` | `Commands`：账号、错误翻译、限定在仓库上的 GitHub 调用、飞书的 `lark` |
| `tests/feishu-read.spec.ts` | 飞书原始记录的读取、引用与链接 |
| `tests/github-read.spec.ts` | GitHub 原始记录与 CI 检查的读取 |
| `tests/admission-context.spec.ts` | 研判起始的线程窗口 |
| `tests/feishu-image.spec.ts` | 飞书图片读成附件 |
| `tests/assessment.spec.ts` | `MasterAssessor` 为每个评估保存什么，以及何时放手 |
| `tests/background.spec.ts` | 执行器的后台作业与子智能体：等待、收集与停止 |
| `tests/bundle-patch.spec.ts` | bundle 补丁按 DSH 的方式解析，以及它定义的两个预置 |
| `tests/effects.spec.ts` | 副作用队列：合并、上限、带退避的重试、健康与关闭 |
| `tests/passes.spec.ts` | 巡检：一次只跑一次、请求合并、失败写进运行时健康 |
| `tests/outbox.spec.ts` | Outbox：暂停或来源未安装时消息等待，来源迟到注册后发出 |
| `tests/cache.spec.ts` | `TextCache` 的淘汰次序 |
| `tests/queue.spec.ts` | Runtime 经副作用队列的工作，以及更早版本存下的队列被接管 |
| `tests/followups.spec.ts` | 工单线程上人的后续：主 Session 的通知、执行器判断与交回、上下文跟随 |
| `tests/health.spec.ts` | 每个部件一条健康项，各由自己的下一次成功清除 |
| `tests/delivery.spec.ts` | `AgentDelivery` 的幂等送达 |
| `tests/retry-health.spec.ts` | 模型预算重试的投影 |
| `tests/role-models.spec.ts` | 角色模型的解析与种入 |
| `tests/runtime.spec.ts` | 在模拟宿主上的整个应用，经工具与 HTTP |
| `tests/runtime-concurrency.spec.ts` | 重叠的工作：一轮中到达的触发、送达与启动期间变化的工单 |
| `tests/tools.spec.ts` | 两套工具的形状、角色限定的资源读取与路由校验 |
| `tests/http.spec.ts` | 同源与回环检查、每类失败的状态码、请求体上限、路径参数与查询 |
| `tests/settings.spec.ts` | 与模型或账号检查竞争的保存、策略同步、暂停与拒绝 |
| `tests/views.spec.ts` | 视图从 Store 推导出的内容 |
| `tests/timeline.spec.ts` | 线程分页、相邻触发与时间戳规范化 |
| `tests/migration.spec.ts` | schema 11 迁移：每条记录处于当前形状，更旧的被拒绝 |
| `tests/store.spec.ts` | SQLite 与内存仓库的顺序和回滚一致、`kv` 键只在 `src/kv.ts` 拼写、设置历史 |
| `tests/prompts.spec.ts` | 提示词校验、组装与版本 |
| `tests/cards.spec.ts` | 内置文本必须写明的规则，逐文件 |
| `tests/model-surface.spec.ts` | 模型读到的一切：工具、提示词、技能与输入，按 schema、术语表与体积上限核对 |
| `tests/deployment.spec.ts` | 插件配置、`resolveDeployment`、`resolveFeishuBot` 与 setup 问题 |
| `tests/environment.spec.ts` | 包装脚本、`worker-gitconfig`、外来文件与目录检查 |
| `tests/index.spec.ts` | 插件入口：`Config`、`machineOf` 与重启回调 |
| `tests/service-script.spec.ts` | `scripts/xenra-superagent` 对着假的 `ps`、`tmux`、`dsh` 与假的健康端点 |
| `tests/client.spec.tsx` | 客户端插件的注册、轮询与打开主 Session |
| `tests/navigation.spec.ts` | `openKnownSession` 的三种结果 |
| `tests/controls.spec.tsx` | 本地控件的键盘行为，以及面板只 import 类型、无环形依赖 |
| `tests/panel-overview.spec.tsx` | 总览页 |
| `tests/panel-source.spec.tsx` | 来源状态与设置 |
| `tests/panel-trigger.spec.tsx` | 触发状态与线程页 |
| `tests/panel-eval.spec.tsx` | 评估状态与设置 |
| `tests/panel-execution.spec.tsx` | 执行状态、工单页与执行设置 |
| `tests/panel-settings.spec.tsx` | 设置分组、草稿、保存栏与历史 |
| `tests/panel-prompts.spec.tsx` | 提示词设置：编辑、完整提示词、历史与默认值变更 |
| `tests/panel-deployment.spec.tsx` | 部署页与插件管理器页 |
| `tests/panel-panel.spec.tsx` | 面板的搜索、术语表、路由记忆与宿主不可用时的回退 |
| `tests/draft.spec.ts` | 草稿状态、三方合并与保存栏文案 |
| `tests/prompt-config.spec.ts` | 提示词配置的纯函数与行级差异 |
| `tests/markdown.spec.ts` | Markdown 子集与链接化 |
| `tests/marks.spec.ts` | 视图归类的每个状态的标记 |
| `tests/locales.spec.ts` | 两种语言的占位符一致，且每个错误码与理由码都有措辞 |
| `tests/styles.spec.ts` | 样式表只用组件真的用到的类，且每行一条规则 |
| `tests/class-docs.spec.ts` | `src` 中每个类前面有 JSDoc 块 |
| `tests/docs.spec.ts` | 编号连续、语言对照、链接方向与可解析、无冲突标记，以及本文两张表完整 |

`tests/fixtures/` 存放共用的测试装置：`host.ts`（在模拟宿主上跑起一个配置好的 Runtime）、`panel-server.ts` 与 `panel.tsx`（按路由作答的假管理 API 与面板渲染助手）、`deployment.ts`（一份解析好的部署与机器设置）、`git.ts`、`async.ts`，以及 `platform.ts`（`POSIX` 常量）。
