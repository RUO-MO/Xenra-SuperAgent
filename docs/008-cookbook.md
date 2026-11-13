# 008 扩展指南

[English](008-cookbook.en.md) · 中文

本篇讲怎么扩展 Xenra-SuperAgent。术语取自 [001 领域模型](001-domain.md) 与 [002 授权](002-authorization.md)，组件取自 [007 架构](007-architecture.md)。每条配方都给出要改的文件、要实现的接口和要补的测试。

扩展点一共有五个，代价从小到大：

| 扩展 | 改哪里 | 要重启吗 | 风险 |
| --- | --- | --- | --- |
| 新的内置提示词分段 | `prompts/`、`src/app/context.ts`、`src/app/prompts.ts`、`src/client/locales.ts` | 是：内置文本在模块载入时读取 | 低 |
| 新的主 Session 或执行器工具 | `src/app/tools/` | 是 | 中：要同时改提示词与 `tests/model-surface.spec.ts` |
| 新的面板页面或视图 | `src/client/` | 客户端插件改动重新构建 `lib/client.js` 后刷新页面 | 中 |
| 新的来源种类 | `src/sources/`、`src/kv.ts`、`tsdown.config.ts`、`package.json`、`cordis.patch.yml` | 是 | 高：会写进持久记录 |
| 新的设置块 | `src/policy.ts`、`src/app/settings.ts`、`src/app/api.ts`、面板 | 是 | 高：涉及修订号与迁移 |

## 新增一个来源

这条配方实现一个名为 `webhook` 的来源种类：通过一个假想的 CLI `hookq` 读一条消息队列，把消息变成触发。其余接口都属于 Xenra-SuperAgent。

先定下 CLI 契约，后面所有代码都按它写：

- `hookq pull --after <n> --json` 打印位置 `n` 之后的消息，最早的在前：`{"me": "<智能体在队列上的 id>", "items": […], "next": <位置>}`。条目含 `id`、`conversation`、`thread`（开启线程的那条消息的 id，本身是首条时为空）、带 `id` 与 `bot` 的 `sender`、`mentions_me`、`text`、`at`、`url`。
- `hookq reply --conversation <id> --to <消息 id> --key <键> --text <文本>` 在某条消息下回复，同一个键只回一次。对话已删除时向标准错误输出 `{"error": {"code": 410, "message": "…"}}` 并失败。
- `hookq thread --conversation <id> --root <消息 id> --json`，翻页加 `--after <游标>`，打印一页线程，最早的在前：`{"items": […], "next": "<游标>"}`，最后一页没有 `next`。

把种类放进 `src/sources/webhook.ts`，参照 `src/sources/github.ts` 的骨架。来源变大之后，像飞书那样把翻译、渠道和循环拆成 `webhook-trigger.ts`、`webhook-channel.ts`、`webhook-read.ts`、`webhook-loops.ts`。

### 1. 先把事件映射到领域

动手写代码之前先把映射定死。触发 id、线程 id 和渠道地址都会被持久化，事后再改会让已有记录对不上。

| 概念 | 对 webhook 队列而言 |
| --- | --- |
| 触发 | 一条消息 |
| 线程 | 一个对话里的一条消息及其回复，id 为 `<conversation>:<首条消息 id>` |
| 发起者 | 发送者在队列上的 id |
| 渠道地址 | 回复发往的对话与消息 |
| 接收范围 | 一个对话；准入表里每个对话一行 |

模块导入这些：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
```

### 2. 配置、字段、事实与健康

```ts
const ConfigSchema = z.object({
  conversations: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    listen: z.enum(['mentions', 'all']),
  }).strict()).default([]),
  pollSeconds: z.number().int().min(10).max(3600).default(30),
}).strict()
export type WebhookConfig = z.infer<typeof ConfigSchema>

export const webhookKind: SourceKind<WebhookConfig> = {
  kind: 'webhook',
  title: { zh: 'Webhook 队列', en: 'Webhook queue' },
  description: { zh: '接收 webhook 队列里下列对话的消息。', en: 'Receives the messages of these conversations from the webhook queue.' },
  schema: ConfigSchema,
  fields: [
    { key: 'conversations', type: 'rows', label: { zh: '接收的对话', en: 'Conversations' }, columns: [
      { key: 'id', type: 'text', label: { zh: '对话', en: 'Conversation' }, pattern: '[a-z0-9-]+' },
      { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
        { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
    ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600,
      label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['webhook'],
  // scope、channel、threadContext、policy、environment 见后面各步。
}
```

- `kind` 是稳定的来源 id。它出现在触发的 `source`、线程键前缀、`source:webhook` 设置块和策略的来源部分里。
- `schema` 校验已保存的配置并填默认值。注册表会为每个已注册种类构造一个实例，运营者保存之前就按默认值生效，所以默认值应当什么都收不到：本例默认不接收任何对话。
- `fields` 直接生出来源设置卡片的表单，不用写面板代码。`rows` 编辑以第一列为键的条目，`advanced` 把不常改的字段折进"高级"。种类若能把 id 解析成显示名，就实现 `refreshLabels`，把名字存到 `KV.sources.labels(kind)` 下，列上带 `choose` 与 `refresh` 就能用。
- 可选的 `facts(deployment)` 显示由部署推导出的只读值，例如某个 CLI 背后的账号。配置只会检查 `SETUP_FIELDS` 里列的 GitHub 与飞书字段，所以本例不提供事实。
- `health` 声明本种类独占的健康项，初始为 `starting`。注册会在 `HealthBoard` 上认领这些名字，重名和以 `sync:` 开头的名字会被拒绝。报 `error` 会让 `scripts/xenra-superagent status` 以 2 退出、让每小时检查通知人，所以只在需要人处理时才报。

### 3. 把消息翻译成触发

先校验 CLI 的输出：

```ts
/** 一条消息，形状同 `hookq pull` 与 `hookq thread` 打印的条目。 */
const MessageSchema = z.looseObject({
  id: z.string().min(1), conversation: z.string().min(1), thread: z.string().optional(),
  sender: z.looseObject({ id: z.string(), bot: z.boolean().default(false) }), mentions_me: z.boolean().default(false),
  text: z.string(), at: z.string(), url: z.string().optional(),
})
type QueueMessage = z.infer<typeof MessageSchema>
/** `hookq pull` 的答复（逐条读 `items`），以及 `hookq thread` 的答复。 */
const PageSchema = z.looseObject({ me: z.string(), items: z.array(z.unknown()), next: z.number().int() })
const ThreadPageSchema = z.looseObject({ items: z.array(MessageSchema), next: z.string().optional() })
```

```ts
/** 一条队列消息的触发；智能体自己的消息不产生触发。 */
export function webhookTrigger(message: QueueMessage, me: string): Trigger | undefined {
  if (message.sender.id === me) return undefined
  const thread = `${message.conversation}:${message.thread ?? message.id}`
  return {
    id: key('webhook', message.id),
    source: 'webhook',
    threads: [{ source: 'webhook', id: thread }],
    actor: { source: 'webhook', id: message.sender.id },
    human: !message.sender.bot,
    ...(message.mentions_me ? { addressed: 'mention' as const } : {}),
    at: message.at,
    text: message.text,
    channel: { source: 'webhook', thread: `webhook:${thread}`,
      address: { conversation: message.conversation, message: message.id, ...(message.url ? { url: message.url } : {}) } },
    ...(message.url ? { url: message.url } : {}),
    meta: { conversation: message.conversation, messageId: message.id, root: message.thread ?? message.id },
  }
}
```

- **稳定 id。** 用 `key` 从队列 id 推导触发 id。同一个 id 再进 Engine 一次返回 `duplicate`，重复接单也只产生一张工单，所以重读是安全的。要把编辑当成新事件，就把编辑版本写进 id，GitHub 用评论的 `updated_at` 就是这么做的。
- **线程。** 第一个线程是主线程，评估在它上面进行；额外的线程只补上下文。`threads[0]` 的完整键是 `webhook:<id>`。
- **发送者。** `actor.id` 用来源原生的 id。机器人和 CI 设 `human: false`。名单上的机器人只能成为推断候选。没有发送者的（例如 CI）用"不在名单、未针对智能体"那一格。只有消息确实针对智能体时才设 `addressed`，这会让名单上的人获得明确强度。永远不要为智能体自己的消息产生触发。
- **渠道与元数据。** `channel` 说明回复发去哪里，`channel.thread` 决定同一工单的发送次序：排在同一会话更早一条之后，直到那条连续失败三次。`url` 指向来源消息。来源特有的字段放进 `meta`，核心不解释它。`text` 和 `meta` 都是不可信数据，不是授权。

新的种类可以直接被 `orchestrator_read trigger/<id>` 与 `thread/<key>` 读到，看到消息文本、去向与相邻触发。它不会自动获得内置技能、原始记录资源或 PR 绑定。

全文搜索不用额外代码。要让人们用来源原生的引用（消息 id、URL、`#12`）搜到，实现 `find(query)`：

```ts
  find: query => ({ threads: [], terms: [...new Set(query.match(/\bm[0-9]+\b/g) ?? [])] }),
```

查询里出现队列消息 id（例如 `m42`）时，就用它检索对应的触发。

### 4. 来源接收什么：`scope`

```ts
  scope({ meta }, config) {
    const conversation = config.conversations.find(item => item.id === meta.conversation)
    if (!conversation) return { listened: false, reason: 'conversation_not_listed' }
    return { listened: true, observed: conversation.listen === 'all', row: conversation.id }
  },
```

每个进来的触发都会经 `SourceRegistry.scope` 问一次种类。范围之外的消息以 `filtered` 连同理由记下，不建线程。请把它们交给 `receive`，不要在循环里悄悄丢掉，这样面板才能解释为什么被过滤。

`observed: true` 表示种类在这个范围内收未针对智能体的消息，准入表因此可以按格子判断它们。`row` 指向准入表里那一行，必须与 `policy.rows()` 给出的 id 一致。

授权重新校验时，`scope` 只拿到授权里存的 `meta` 和当前配置，所以它只能依赖这两者。恢复需要 `listened`，不需要 `observed`。没有 `scope` 的种类接收它产生的每个触发，但不观察任何一个。

### 5. 回复：渠道

```ts
  channel: {
    allowed: (address, config) => config.conversations.some(item => item.id === address.conversation),
    send: sendWebhook,
    link: address => ({ url: address.url ?? '',
      label: { zh: `Webhook 对话 ${address.conversation}`, en: `Webhook conversation ${address.conversation}` } }),
  },
```

```ts
export async function sendWebhook(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { conversation, message: to } = message.channel.address
  if (!conversation || !to) throw new Error('Missing webhook reply target')
  try {
    await host.commands.run('hookq', ['reply', '--conversation', conversation, '--to', to, '--key', message.id,
      '--text', message.text])
    return 'sent'
  } catch (error) {
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}
```

- **幂等发送。** Outbox 调 `SourceRegistry.send`，后者调 `channel.send`。种类未安装时消息返回 `waiting` 并等待。远端收到了但应答没回来时仍可能失败，所以重试不能产生重复消息：把 `message.id` 当作幂等键。`hookq` 用 `--key`，GitHub 在评论里放隐藏标记，飞书接受幂等键。
- **永久失败与可重试失败。** 成功返回 `sent`；只有投递永远不可能时（本例的 410）才返回 `gone`，这种消息以 `dropped` 留在回执里，永不再排队，并出现在 `GET sources` 与来源页上。其他失败请抛，让 Outbox 从 5 秒起按指数退避重试到 300 秒。`CliError.code` 是 CLI 输出里报告的编码。
- **允许的目标。** `allowed(address, config)` 只依据保存过的地址与当前配置判断，不再监听的目标会被丢弃，种类停用时消息会一直等待。没有 `allowed` 时，只要种类启用，所有地址都可以回。
- **链接。** `link(address, links)` 返回面板经 `SourceRegistry.link` 显示的 URL 与标签；缺部署信息时返回空 `url`。

### 6. 供研判使用的线程上下文

```ts
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    // 队列线程是平的：根与某条回复所回应的消息都在第一页，和 GitHub 一样。
    read: async (commands, trigger, _part, cursor) => {
      const page = ThreadPageSchema.parse(JSON.parse(await commands.run('hookq', ['thread', '--conversation',
        String(trigger.meta.conversation), '--root', String(trigger.meta.root), '--json', ...(cursor ? ['--after', cursor] : [])])))
      const messages = page.items.map(item => ({ id: item.id, from: item.sender.id, at: item.at, text: item.text,
        ...(item.sender.bot ? { bot: true as const } : {}), ...(item.url ? { url: item.url } : {}) }))
      return { messages, ...(page.next ? { next: page.next } : {}), body: { messages } }
    },
  },
```

主动研判需要触发周围的对话。`orchestrator_eval` 读初始窗口，`orchestrator_eval_read` 展开分页、根消息或父消息。实现可选的 `threadContext`：

- `read(commands, trigger, part, cursor, config)` 返回 `ContextPart`。`messages` 是 `ContextMessage`：`{id, from, at, text}` 加上适用的 `bot`、`deleted`、`reply_to`、`url`、`path`、`line`。最后一页省略 `next`。`body` 是展示给研判的内容。可选的 `status` 描述特殊情况，例如飞书的 `chat_neighbours`。`part` 取 `thread`、`root` 或 `parent`。
- `messageId(trigger)` 给出一条消息在线程消息里的 id，研判靠它定位触发自己那一条。
- `images(text)` 与 `image(…)` 供带图片的种类（如飞书）使用，本例不实现。

`src/sources/admission-context.ts` 的 `admissionContext` 把 `read` 的页数限制在 `admissionContextMaxPages` 内，再交给 `threadWindow` 选出"前五条加触发两侧各五条"的窗口。所以只要 `read` 忠实实现分页，研判的窗口就是有界的。

消息会回复更早的消息时，再加上 `repliesTo(trigger)`，返回被回复那条消息的触发 id，让转达与执行器输入能显示它：

```ts
  repliesTo: trigger => typeof trigger.meta.replyTo === 'string' ? key('webhook', trigger.meta.replyTo) : undefined,
```

### 7. 谁可以发起工作：策略部分

```ts
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
      .default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的人在消息里 @ 智能体。', en: 'Someone on the list mentions the agent in a message.' },
    rows: stored => ConfigSchema.parse(stored).conversations.map(conversation => {
      const all = conversation.listen === 'all'
      return { id: conversation.id, label: conversation.id, note: all ? { zh: '全部消息', en: 'All' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: all, unlistedAddressed: true, unlistedUnaddressed: all } }
    }),
  },
```

- `schema` 校验来源的策略部分，含 `allowed` 发送者。id 比较不区分大小写。准入表由 `src/policy.ts` 单独校验并跨种类共享。这一部分存在 `policy.sources.webhook` 下，并计入策略版本。
- `fields` 在 **评估 → 每个来源** 下生成表单，第一个字段必须是 `allowed`。`explicit` 说明怎样才算针对智能体说话。可选的 `unnamed: { person, bot }` 为飞书 `ou_…` 这类不可读的 id 提供显示标签；本例省略，因为队列 id 本身可读。
- `rows(config)` 列出准入范围和各格是否可用，行 id 必须与 `scope` 返回的 `row` 一致。只有种类观察到未针对智能体的消息时，那些格子才可用。没有 `rows` 的种类使用准入表的默认格子。
- 可选的 `bots` 列出可以成为推断候选的机器人，条目形状与 `allowed` 相同；没有它，任何机器人都不会获准。
- 可选的 `sync: { label, ready(part), run(host, part, signal) }` 在启动和点 **立即同步** 时刷新名单。飞书用的是群成员。失败记在 `sync:<id>` 下，并按分钟到小时退避重试。

`SourcePolicyPart` 的泛型要求类型是 `Record<string, unknown> & { allowed: { id: string; name?: string }[] }`，上面的 schema 推断出 `{ allowed: ... }` 正好满足。

### 8. 给执行器的变量

```ts
  environment: {
    variables: [{ key: 'XENRA_SUPERAGENT_WEBHOOK_CONVERSATION', description: {
      zh: '接下工单的 webhook 对话；工单不是从这个来源来的时为空',
      en: 'The webhook conversation that started the ticket; empty when the ticket did not start on this Source' } }],
    values: ({ trigger }) => ({
      XENRA_SUPERAGENT_WEBHOOK_CONVERSATION: trigger?.source === 'webhook' ? String(trigger.meta.conversation ?? '') : '' }),
  },
```

"执行"设置会在 prepare 命令旁列出声明的 `variables`，即使种类已停用。启用期间，`values` 用部署、配置和起始触发算出每个变量的值。prepare 命令读环境变量，执行器在说明里读到变量与说明。

前缀用 `XENRA_SUPERAGENT_<KIND>_…`，对来自其他来源的工单返回空值，并且绝不放凭据：宿主会去掉名字含 KEY、PASSWORD、SECRET 或 TOKEN 的变量，写了也不会到。

### 9. 插件条目与循环

```ts
export const name = 'xenra-superagent-webhook'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(webhookKind), 'webhook: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, webhookKind)
    const controller = new AbortController()
    // 未处理的拒绝会终止 DSH 进程，所以逃出循环的失败要变成来源的健康状态。
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('webhook', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
```

插件注入 `orchestrator`（`SourceHost`）。第一个 effect 注册种类并返回注销函数，第二个跑循环并返回一个中止循环、等它结束的清理函数；应用停止或重启时，这两个清理都会被调用。

```ts
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // 配置解析完账号后 Xenra-SuperAgent 会重启，在那之前来源什么都不读。
  if (!ctx.configured()) { ctx.report('webhook', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<WebhookConfig>('webhook')
    if (!config) ctx.report('webhook', health('paused', 'sourceOff'))
    else {
      const at = new Date().toISOString()
      try {
        const { read, unreadable } = await pollQueue(ctx, signal)
        failures = 0
        ctx.report('webhook', { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at })
      } catch (error) {
        failures += 1
        // 一次网络失败下一轮重试；连续三次才需要人处理。
        if (!signal.aborted && failures >= 3) {
          ctx.report('webhook', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((config?.pollSeconds ?? 30) * 1000, undefined, { signal }).catch(() => {})
  }
}

/** 读游标之后的队列，接住每条消息，然后把游标推到它们之后。 */
export async function pollQueue(ctx: SourceContext, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const after = ctx.state.get(KV.webhook.cursor) ?? 0
  const output = await ctx.commands.withSignal(signal).run('hookq', ['pull', '--after', String(after), '--json'])
  const page = PageSchema.parse(JSON.parse(output))
  let unreadable = 0
  for (const item of page.items) {
    if (signal.aborted) throw new Error('The webhook Source stopped during the read')
    const message = MessageSchema.safeParse(item)
    if (!message.success) { unreadable++; continue }
    const trigger = webhookTrigger(message.data, page.me)
    if (!trigger) continue
    await ctx.receive(trigger)
    const conversation = { label: { zh: '对话', en: 'Conversation' }, value: message.data.conversation }
    for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { conversation } })
  }
  ctx.state.set(KV.webhook.cursor, page.next)
  return { read: page.items.length, unreadable }
}
```

- **配置与开关。** 先等 `ctx.ready`，`ctx.configured()` 为假时什么都不读。每轮都重新读 `ctx.config(kind)`：种类停用时它返回 `undefined`。
- **游标。** 读取位置存在 `ctx.state` 里，键在 `KV`（`src/kv.ts`）中登记，例如 `webhook: { cursor: record<number>('webhook-cursor') }`。`tests/store.spec.ts` 要求键字面量只出现在那张表里；外部包可以用导出的 `record` 与 `family` 定义自己的键。设为 `undefined` 会删除记录，`ctx.atomic` 把多次写入并进一个事务。

  只有在这一批里每个触发都已存储之后才推进游标。被中断的一轮让游标不动，稳定的 id 让重放安全。时间戳游标用 `src/sources/poll.ts` 的 `cursorAt(started)`，它会往回退五秒，容下远端迟到的写入。
- **线程元数据。** 收到触发之后用 `ctx.threads.describe(key, { label, url, facts })` 填显示信息；`ctx.threads.patch(key, meta)` 设置来源自己的键，值为 `undefined` 时删除。两者都忽略不存在的线程（包括被过滤触发的线程）。
- **逐条错误。** 数出畸形条目并继续，别让整批失败。`src/infra/commands.ts` 的 `validItems(item, list, tally)` 就是这种模式。要独立轮询线程时用 `src/sources/poll.ts` 的 `pollThreads`，它把每次失败记为 `pollError`，并用 `polled` 判断线程是否还在观察窗口内。
- **健康。** 只经 `ctx.report` 写自己声明的条目。`health(state, code, values)` 提供 `setupPending`、`sourceOff`、`pollFailures` 这类固定文案，面板按 `code` 翻译。报 `error` 之前先累计连续失败次数。
- **中止。** 把 `signal` 传给 `ctx.commands.withSignal(signal)` 和 `delay`，并在条目之间检查它，让停止或重启立刻结束循环。

本例不发来源自己的通知。需要时调 `ctx.notify`，Outbox 会像其他回复一样送达它。

本例也不把线程绑到工单。只有当来源的线程生命周期决定工作是否完成（例如 GitHub 的 PR）时，才用 `ctx.tickets.bindThread` 与 `threadClosed`；工单何时结束仍归 Engine。

### 10. 注册插件

先在 `tsdown.config.ts` 的第一段配置里加上这个入口：

```ts
entry: { index: 'src/index.ts', 'github-watch': 'src/sources/github.ts', 'feishu-watch': 'src/sources/feishu.ts',
  'webhook-watch': 'src/sources/webhook.ts' },
```

在 `package.json` 的 `exports` 里加 `"./webhook-watch": "./lib/webhook-watch.js"` 导出构建产物，再把插件以停用状态加进 bundle 的 `cordis.patch.yml` 的 `insert` 列表，和飞书一样：

```yaml
    - id: xenra-superagent-webhook
      name: xenra-superagent/webhook-watch
      disabled: true
```

然后在某个 profile 的 `cordis.patch.yml` 里用 `id: xenra-superagent-webhook` 与 `disabled: false` 启用它。重新构建并重启，新来源就会出现在来源设置和 **评估 → 每个来源** 下。

最后把模块与测试补进 [007 架构](007-architecture.md) 的两张表；`tests/docs.spec.ts` 会检查两张索引是否完整。

### 11. 要补的测试

照 `tests/sources.spec.ts` 的样子建 `tests/webhook.spec.ts`：临时目录里真实的 `Store`、带 `HealthBoard` 的 `SourceRegistry`、用替身端口的 `Engine`，以及 `sourceContextOf` 给出的 `SourceContext`。

用 `vi.spyOn` 伪造 `Commands.run`；也要伪造 `withSignal`，因为它通常返回一个新的 `Commands`。

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Engine, key, type Trigger } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { Commands } from '../src/infra/commands.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Store } from '../src/app/store.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { KV } from '../src/kv.ts'
import { pollQueue, webhookKind, type WebhookConfig } from '../src/sources/webhook.ts'
```

```ts
function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'webhook-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { webhook: { enabled: true, config: { conversations: [{ id: 'ops', listen: 'mentions' }] } } },
    policy: { sources: { webhook: { allowed: [{ id: 'alice' }] } } },
  }))
  // 注册表在 board 上认领该种类的健康项，测试从那里读。
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(webhookKind)
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  // 来源自己的通知进 outbox，这里只记回执，不真的发送。
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { ...deps, store, engine, commands, receive, health: board.all, ctx: sourceContextOf(deps, webhookKind) }
}
/** 一个按 `hookq` 作答的队列。 */
function queue(h: ReturnType<typeof host>, answer: () => unknown) {
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  return vi.spyOn(h.commands, 'run').mockImplementation(async () => JSON.stringify(answer()))
}

it('takes in what the queue holds after the cursor, once, and moves the cursor after it', async () => {
  const h = host()
  queue(h, () => ({ me: 'agent', items: [message('m1'), { id: 'broken' }, message('m2', { conversation: 'elsewhere' })], next: 3 }))
  expect(await pollQueue(h.ctx, new AbortController().signal)).toEqual({ read: 3, unreadable: 1 })
  expect(await h.receive.mock.results[0]!.value).toBe('stored')
  expect(await h.receive.mock.results[1]!.value).toBe('filtered')
  expect(h.store.get(KV.webhook.cursor)).toBe(3)
  // 名单上的发送者 @ 了智能体，这是明确请求。
  expect(h.engine.candidate(key('webhook', 'm1'))?.strength).toBe('explicit')
  await pollQueue(h.ctx, new AbortController().signal)
  expect(await h.receive.mock.results[2]!.value).toBe('duplicate')
  h.store.close()
})
```

`message(id, fields)` 构造一条队列条目。至少要覆盖：

- 翻译：稳定 id、线程、发起者、`human` 与 `addressed`，以及智能体自己的消息不产生触发；
- 一轮读取：每个触发只存一次、范围外的一条是 `filtered`、游标推到它们之后、名单上发送者的 @ 研判为 `explicit`；
- 被提前中断的一轮不动游标；
- `send`：成功为 `sent`，只有 410 是 `gone`，其他失败抛出，CLI 错误经 `CliError` 传出来；
- 线程上下文：一页的消息与下一页的游标，对照 `tests/registry.spec.ts` 经 `SourceRegistry.threadContext` 读取某种类线程的写法；
- 插件：`apply` 注册种类，配置等待期间报 `setupPending`，清理函数注销种类，逃出循环的失败变成来源健康而不是未处理的拒绝；
- 策略部分与准入行，对照 `tests/registry.spec.ts`、`tests/policy.spec.ts` 检查飞书的方式。

### 检查清单

1. 先定映射：触发、线程、发起者、渠道地址、接收范围。
2. 写种类：`schema`、`fields`、`health`，以及配置能推导出事实时的 `facts`。
3. 用稳定 id 把事件翻译成触发，丢掉智能体自己的消息。
4. 在 `scope` 里只凭 `meta` 与配置决定接收什么。
5. 给它一个渠道，`send` 每条消息只发一次，只在目标永远收不到时才回 `gone`。
6. 能读线程就提供 `threadContext`。
7. 给出策略部分，含 `allowed` 与准入行。
8. 登记执行环境变量。
9. 写插件条目与循环：等配置、跟开关、`receive` 之后推进游标、按条目留住错误、上报健康、被中止时停下；游标键写进 `KV`。
10. 加构建入口、`exports` 与 `cordis.patch.yml` 的插入项，并在 007 的两张表里列出模块与测试。
11. 照 `tests/sources.spec.ts` 的样子测试它。

## 新增一个提示词分段

提示词组装在 `src/app/prompts.ts`。一个分段有四件事：键、默认文本、读它的角色，以及模板占位符（如果有）。

1. **默认文本。** 固定的内置文本放在 `prompts/`，一句一行，由 `src/app/context.ts` 的 `promptFile` 读入并连成段落。例如新增 `prompts/verification.md`，在 `context.ts` 里 `export const verificationPrompt = promptFile('verification')`。
2. **登记分段。** 在 `PART_KEYS` 里加键（例如 `'runtime/verification'`），在 `builtInParts()` 里加一项 `{ roles: BOTH, text: verificationPrompt }`。`roles` 决定哪个角色的提示词读到它。占位符（例如 `{variables}`）要写进 `placeholders`，否则覆盖它的团队文本不会校验出缺失的占位符。
3. **插进顺序。** `promptParts(config, role, environment, policy)` 决定分段顺序：先是 `runtime/shared` 与角色段，然后是三个团队小节，再是订阅、回复、路由或执行，随后是接单约束、交回、执行环境和策略。新产品段要在这里出现，否则不会进入任何提示词。
4. **面板文案。** 在 `src/client/locales.ts` 里给两种语言各加一条 `promptPart.<key>`，`tests/panel-prompts.spec.tsx` 会逐键核对 `builtInParts()` 与文案表是否一一对应。
5. **契约测试。** `tests/cards.spec.ts` 逐文件列出内置文本必须写明的规则。新分段若含不可让步的规则，就在那里加一行；`tests/model-surface.spec.ts` 的 `BUDGET` 也会因为文本变长而逼近上限，需要时再调。

团队小节（`communication`、`scope`、`delivery`）走的是另一条路：它们由 `TEAM_SECTIONS` 与 `TEAM_HEADINGS` 定义，标题就是 `prompts/team/*.md` 之外的面板小节标题，改动要同时照顾 `tests/prompts.spec.ts`。

## 新增一个工具

工具在 `src/app/tools/`。先决定它属于哪个角色：主 Session 的工具在 `main.ts`，执行器的在 `executor.ts`，两者都用 `tool.ts` 的 `Tool`。

下面这个例子给执行器加一个只读工具，把某份派工的完整报告读出来：工单卡片上的 `preview` 只是最新一份报告的摘要，被 `preview()` 截到 160 个字符。

```ts
tool({
  name: 'orchestrator_assignment_report',
  description: 'Read the full report of one of this ticket\'s assignments; its card shows only a 160-character preview of the latest.',
  schema: z.object({ assignment_id: z.string().min(1) }).strict(),
  execute: async (args, signal) => readResource(host.resources, `ticket/${ticketId}/report/${args.assignment_id}`, 0, undefined, ticketId, signal),
})
```

`ticketId` 就是 `executorTools(host, ticket)` 收到的那张工单的 id；`executorTools` 的其余工具都按这个形状闭包在工单上。放进 `executorTools` 返回的数组即可，`Sessions` 会在修饰执行器 Session 时逐个登记。

规则：

- **描述是给模型的唯一说明。** 写清谁在什么时候调用它、它会改变什么。`tests/model-surface.spec.ts` 会核对描述里点到的工具名都已注册、枚举取值合法、没有旧术语，并把整段算进体积预算。
- **schema 用 `.strict()`。** 多余的字段在模型那一侧直接报错，错误的参数不会到执行体。
- **先有权限判断，再写工具。** 工具自己不做授权；它调 Engine 的角色接口（`EngineForMainSession`、`EngineForExecutor` 等），拒绝用 `UserError`，面板按 `code` 翻译。需要新的领域动作时，先加 Engine 命令和对应的角色接口，再写工具，别在工具里改仓库。
- **只面板该做的事不要做成工具。** 执行环境、账号字段、关闭未完成的决定、重跑 setup、刷新显示名都没有工具；`orchestrator_trigger_requeue` 也故意拒绝执行器仍拥有人工后续的触发。
- **依赖从 host 来。** 需要新能力就扩 `MainToolsHost` / `ExecutorToolsHost`，由 `src/app/runtime.ts` 的 `toolHost` 提供，别让工具直接抓 `Runtime`。只读工单的工具还要照顾执行器一侧：`readResource` 按调用者过滤 id，执行器看不到其他工单和决定。
- **测试。** `tests/tools.spec.ts` 检查工具登记、角色限定的资源读取与每种拒绝；`tests/model-surface.spec.ts` 会把新工具算进预算，并核对提示词没有引用不存在的工具。

## 新增一个面板视图

面板在 `src/client/`，模块之间不许有环形 import（`tests/controls.spec.tsx` 会走一遍图）。

- **只加一个页面。** 若是新标签页，改 `src/client/route.ts` 的 `TABS` 与 `Route` 联合类型、`parseRoute` 的分支，再在 `src/client/app.tsx` 的 `Pages` 里加一个 `case`。设置类页面加进 `SETTINGS_GROUPS` 即可。
- **数据从服务端来。** 页面用 `src/client/api.ts` 的 `usePoll` 与 `call` 读 `src/app/api.ts` 声明的路由；要新数据就在那里加路由与响应类型，并在 `src/app/http.ts` 的 `routes` 表里实现，最后在 `src/app/views/` 里写视图函数。`tests/fixtures/panel-server.ts` 实现了每条路由，新路由会要求它跟着改。
- **文案。** 所有文案走 `src/client/locales.ts` 的键，两种语言各一条，占位符必须一致（`tests/locales.spec.ts` 核对）。
- **样式。** 用 `client.css` 里的类与 `--dsw-alias-*` 令牌，每行一条规则；`tests/styles.spec.ts` 会拒绝没有任何组件使用的类。
- **控件。** 用 `src/client/controls.tsx` 的本地副本或 `widgets.tsx` 的共用组件，不要 import `@deepseek-ai/dsh-client-ui-primitives`。
- **测试。** 照 `tests/panel-*.spec.tsx` 建一个新的：`tests/fixtures/panel.tsx` 提供 `mount`、`click`、`type`、`field`、`tab` 等助手，假服务器按路由作答并记录任何未声明的查询参数。
