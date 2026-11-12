# 008 扩展指南

[English](008-cookbook.en.md) · 中文

本指南演示如何扩展 Xenra-SuperAgent。它使用 [001 领域模型](001-domain.md) 与 [002 授权](002-authorization.md) 中的术语，以及 [007 架构](007-architecture.md) 中的组件。

## 新增一个来源

这份配方实现一个名为 `webhook` 的来源种类。它通过一个虚构的 CLI `hookq` 读取一条假想的消息队列，并把消息转换成触发。其他接口都属于 Xenra-SuperAgent。

实现有四项职责：翻译事件、定义接收与授权规则、提供回复与上下文，以及维护轮询循环。下面按顺序把这几个部分搭起来。

示例假定这样的 CLI 约定：

- `hookq pull --after <n> --json` 打印位置 `n` 之后的消息，最早的在前：`{"me": "<智能体在队列上的 id>", "items": […], "next": <位置>}`。一个条目有 `id`、`conversation`、`thread`（开启它所在线程的那条消息的 id，在那条消息上为空）、带 `id` 与 `bot` 的 `sender`、`mentions_me`、`text`、`at` 和 `url`。
- `hookq reply --conversation <id> --to <消息 id> --key <键> --text <文本>` 在某条消息下回复，每个键只回一次。若对话已被删除，它向标准错误输出 `{"error": {"code": 410, "message": "…"}}` 并失败。
- `hookq thread --conversation <id> --root <消息 id> --json`，翻页时加 `--after <游标>`，打印线程的一页，最早的在前：`{"items": […], "next": "<游标>"}`，最后一页没有 `next`。

把种类及其插件条目放进 `src/sources/webhook.ts`，参照 `src/sources/github.ts`。如果来源变大，就像飞书来源那样，把翻译、渠道和轮询代码拆成独立模块。

### 1. 把事件映射到领域

写代码之前先选定稳定的映射。触发 id、线程 id 和渠道地址都会被持久化，之后再改会让已有记录对不上。

| 概念 | 对 webhook 队列而言 |
| --- | --- |
| 触发 | 一条消息 |
| 线程 | 一个对话里的一条消息及其回复：`<conversation>:<第一条消息的 id>` |
| 发起者 | 发送者在队列上的 id，与允许名单中书写的一致 |
| 渠道地址 | 回复所发往的对话与消息 |
| 接收范围 | 一个对话，在准入表中有独立的一行 |

### 2. 配置：schema、字段、事实与健康

本模块导入下面各步要用到的东西：

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
  // find、scope、channel、threadContext、policy 和 environment 在后续步骤中给出。
}
```

- `kind` 是稳定的来源 id。它出现在触发的 `source`、线程键前缀、`source:webhook` 设置块以及来源策略中。
- `schema` 校验已存储的配置并提供默认值。运营者保存实例之前，注册表会按这些默认值创建一个已启用的实例。让默认值什么都收不到；本例默认不接收任何对话。
- `fields` 无需写面板代码就能生成来源设置表单。`rows` 字段编辑以第一列为键的条目；`advanced` 隐藏不常用的设置。如果来源能把 id 解析成显示名，就实现 `refreshLabels`，并把名字保存在 `KV.sources.labels(kind)` 下。带 `choose` 和 `refresh` 的列之后就能提供这些名字。
- 可选的 `facts(deployment)` 显示由配置推导出的值，例如某个 CLI 背后的账号。配置目前只检查 `SETUP_FIELDS` 中列出的 GitHub 与飞书字段，所以本例不提供事实。
- `health` 声明来源的健康项，初始为 `starting`。注册会占用每个名字，并拒绝与 `runtime`、`reply`、`worker` 或各类效果重名。请使用种类名，并把 `sync:<id>` 留给策略同步。出现 `error` 会让状态脚本以 2 退出、每小时检查通知运营者，因此只在可能需要人处理时才报它。

### 3. 把一条消息翻译成触发

转换之前先校验 CLI 的响应：

```ts
/** 一条消息，形式与 `hookq pull` 和 `hookq thread` 打印的一致。 */
const MessageSchema = z.looseObject({
  id: z.string().min(1), conversation: z.string().min(1), thread: z.string().optional(),
  sender: z.looseObject({ id: z.string(), bot: z.boolean().default(false) }), mentions_me: z.boolean().default(false),
  text: z.string(), at: z.string(), url: z.string().optional(),
})
type QueueMessage = z.infer<typeof MessageSchema>
/** `hookq pull` 的答复（逐条读取其中的 items），以及 `hookq thread` 的答复。 */
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

- **稳定的 id。** 通过 `key` 从队列 id 推导触发 id。对已存储的 id，`Engine.receive` 返回 `duplicate`，重复接单只产生一个工单，因此重读消息是安全的。若要把编辑当作新事件，就在 id 里带上编辑版本，正如 GitHub 用评论的 `updated_at` 那样。
- **线程。** 第一个线程是主线程，持有评估。额外的线程增加关联上下文。id 由来源决定；它的完整键是 `webhook:<id>`。
- **发送者。** 在 `actor` 中使用来源原生的 id。对机器人和 CI 设置 `human: false`。名单上的机器人只能成为推断候选。发起者 id 为空（例如 CI）时，使用"不在名单、未针对智能体"的准入单元格。只有当消息确实针对智能体时，才把 `addressed` 设为 `mention` 或 `direct`，这会让名单上的人的消息获得明确强度。永远不要为智能体自己的消息生成触发。
- **回复目标与元数据。** `channel` 指明回复发往哪里；`url` 指向来源消息。`channel.thread` 把消息分组以便按序送达：同一工单的后一条消息会排在它的前一条之后，直到前一条连续失败三次；其他工单不等待。来源特有的字段放进 `meta`，例如接收对话与线程根。`meta` 和 `text` 都是不可信数据，不是授权。

智能体可以通过 `orchestrator_read trigger/<id>` 和 `thread/<key>` 读取新的种类。它们会暴露消息文本、去向和相邻触发。新的种类不会自动获得内置技能、原始服务记录的资源或 Pull Request 绑定。

全文搜索无需额外代码即可工作。当人们使用来源特有的引用（例如消息 id、URL 或 `#12`）时，实现 `find(query)`，返回这些引用所确定的线程键与搜索词：

```ts
  find: query => ({ threads: [], terms: [...new Set(query.match(/\bm[0-9]+\b/g) ?? [])] }),
```

这里的查询中出现队列消息 id（例如 `m42`）时，就会用它检索对应的触发。

### 4. 来源接收什么：scope

```ts
  scope({ meta }, config) {
    const conversation = config.conversations.find(item => item.id === meta.conversation)
    if (!conversation) return { listened: false, reason: 'conversation_not_listed' }
    return { listened: true, observed: conversation.listen === 'all', row: conversation.id }
  },
```

对每个进入的触发，引擎通过 `SourceRegistry` 调用 `scope`。范围之外的消息以 filtered 记录并留下原因，不创建线程。请把消息交给 `receive`，不要在轮询循环里静默丢弃它们，这样面板才能解释为什么被过滤。

`observed: true` 表示来源在该范围内接收未针对智能体的消息，因而可以对它们做准入表判断。`row` 标识对应的准入行。

重新校验会用授权中存储的元数据调用 `scope`。让它只依赖 `meta` 和配置。恢复需要 `listened`，不需要 `observed`。没有 `scope` 时，种类接收它产生的每个触发，但不观察任何一个。

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

- **幂等发送。** Outbox 调用 `SourceRegistry.send`，进而调用 `channel.send`。来源插件未加载时，消息会等待。远端服务收到之后发送仍可能失败，所以重试不能造成重复消息。把 `message.id` 用作幂等键：`hookq` 支持 `--key`；GitHub 存放一个隐藏的评论标记；飞书接受幂等键。
- **永久失败与可重试失败。** 成功返回 `sent`，只有投递永久不可能时（例如本例的 410）才返回 `gone`。`gone` 的消息以 dropped 保留，永不再排队；它出现在 `GET sources` 和来源页面上。其他失败请抛出，让 Outbox 在 5 秒后重试、翻倍到 300 秒。`CliError.code` 是 CLI 输出报告的代码。
- **允许的目标。** `allowed(address, config)` 只检查已保存的地址和当前配置。把所需的一切事实放进地址；例如飞书会记录该群是否私信。不再被监听的目标会被丢弃，而来源停用时消息会一直等待。没有 `allowed` 时，只要来源启用，所有地址都被允许。
- **链接。** `link(address, links)` 返回面板通过 `SourceRegistry.link` 显示的 URL 与标签。

### 6. 供研判使用的线程上下文

```ts
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    // 队列线程是平的：它的根、以及某条回复所回应的消息，都在第一页上，和 GitHub 一样。
    read: async (commands, trigger, _part, cursor) => {
      const page = ThreadPageSchema.parse(JSON.parse(await commands.run('hookq', ['thread', '--conversation',
        String(trigger.meta.conversation), '--root', String(trigger.meta.root), '--json', ...(cursor ? ['--after', cursor] : [])])))
      const messages = page.items.map(item => ({ id: item.id, from: item.sender.id, at: item.at, text: item.text,
        ...(item.sender.bot ? { bot: true as const } : {}), ...(item.url ? { url: item.url } : {}) }))
      return { messages, ...(page.next ? { next: page.next } : {}), body: { messages } }
    },
  },
```

主动研判需要触发周围的对话。`orchestrator_eval` 读取初始窗口；`orchestrator_eval_read` 展开分页、根消息或父消息。实现可选的 `threadContext` 接口来提供这些读取：

- `read(commands, trigger, part, cursor, config)` 返回一个 `ContextPart`。它的 `messages` 使用 `ContextMessage`：`{id, from, at, text}` 以及适用的 `bot`、`deleted`、`reply_to`、`url`、`path` 和 `line` 字段。最后一页省略 `next`。`body` 是展示给研判 Session 的内容，这里是同样的消息。可选的 `status` 可以描述特殊结果，例如飞书的 `chat_neighbours`。`part` 取 `thread`、`root` 或 `parent`。
- `messageId(trigger)` 在其中找到触发自己的那条消息。
- `images(text)` 与 `image(…)` 用于消息带图片的种类（如飞书）；本例未实现。

没有 `threadContext` 的种类不给研判提供线程上下文；触发自身的文本仍然可读。

如果消息会回复更早的消息，就加上 `repliesTo(trigger)`。它返回对应的触发 id，使后续通知和执行器输入在数据存在时能显示被回复的消息。例如，如果 `hookq` 提供 `reply_to`，而翻译把它存为 `meta.replyTo`：

```ts
  repliesTo: trigger => typeof trigger.meta.replyTo === 'string' ? key('webhook', trigger.meta.replyTo) : undefined,
```

### 7. 谁可以请求：来源在策略中的部分

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

- `schema` 校验来源策略，包括 `allowed` 发送者 id。id 比较不区分大小写。准入表单独校验，并跨种类共享。这部分策略保存在 `policy.sources.webhook`，并计入策略版本。
- `fields` 在 **评估 → 每个来源** 下生成表单，以 `allowed` 开头。`explicit` 说明如何针对智能体发言。可选的 `unnamed: {person, bot}` 为飞书 `ou_…` 这类不可读的 id 提供显示标签；本例省略它，因为队列 id 本身就是可读的名字。
- `rows(config)` 列出准入范围及其可用的单元格。每个行 id 必须与 `scope` 返回的 `row` 一致。只有来源观察到未针对智能体的消息时，那些单元格才可用。没有 `rows` 的种类使用默认单元格。
- 可选的 `bots` 列出有资格成为推断候选的机器人，条目形状与 `allowed` 相同。没有它时，任何机器人都不会被准入。
- 可选的 `sync: {label, ready(part), run(host, part, signal)}` 在启动和点 **立即同步** 时刷新成员关系。飞书用的是群成员。失败会出现在 `sync:<id>` 下，并在一分钟后重试，翻倍到一小时，直到成功。

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

执行设置会在 prepare 命令旁显示声明的 `variables`，即使来源已停用。启用期间，`values` 使用部署、配置和发起触发提供工单专属的值。

prepare 命令读取环境变量；执行器在说明中读取它们的值。请使用 `XENRA_SUPERAGENT_<KIND>_…` 前缀，对来自其他来源的工单返回空值，并且绝不包含凭据。

### 9. 插件条目及其循环

```ts
export const name = 'xenra-superagent-webhook'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(webhookKind), 'webhook: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, webhookKind)
    const controller = new AbortController()
    // 出现未处理的拒绝时 DSH 会结束进程，所以逃出循环的失败要变成来源的健康状态。
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('webhook', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
```

插件注入 `orchestrator`。第一个效果注册种类，并在销毁时注销。第二个用 `SourceContext` 运行轮询循环。销毁会中止循环并等待它结束，应用停止或重启期间也一样。

```ts
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // 配置解析完账号后 Xenra-SuperAgent 会重启；在那之前来源什么都不读。
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
        // 一次网络失败在下一轮重试；连续三次就需要人处理。
        if (!signal.aborted && failures >= 3) {
          ctx.report('webhook', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((config?.pollSeconds ?? 30) * 1000, undefined, { signal }).catch(() => {})
  }
}

/** 读取游标之后的队列，接住每条消息，然后把游标推到它们之后。 */
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

- **配置与开关。** 等待 `ctx.ready`，并在 `ctx.configured()` 为假时什么都不读。每轮都读 `ctx.config(kind)`：来源停用时它是 undefined。
- **游标。** 把读取位置存在 `ctx.state` 中，使用 `KV`（`src/kv.ts`）里带类型的条目，例如 `webhook: {cursor: record<number>('webhook-cursor')}`。`tests/store.spec.ts` 要求键字面量只出现在该注册表里。外部包可以用导出的 `record` 和 `family` 定义键。设为 `undefined` 会删除记录；`ctx.atomic` 把多次写入归入一个事务。

  只有在覆盖到的每个触发都已存储之后，才推进游标。被中断的一轮让游标保持不变；稳定的 id 让重放安全。对于时间戳游标，`src/sources/poll.ts` 的 `cursorAt(started)` 会减去五秒，以容纳远端迟到的写入。
- **线程元数据。** 收到触发之后，调用 `ctx.threads.describe(key, {label, url, facts})` 填充它的显示信息。`ctx.threads.patch(key, meta)` 委托给 `threads.patchMeta`，设置来源拥有的键，或在值为 `undefined` 时移除它们。两者都会忽略不存在的线程，包括被过滤触发的线程。
- **逐条错误。** 统计畸形条目并继续，而不是让整批失败。`src/infra/commands.ts` 的 `validItems(item, list, tally)` 支持这种模式。对独立轮询的线程，使用 `src/sources/poll.ts` 的 `pollThreads`；它把每次失败记为 `pollError`。它的 `polled` 判断保留活动订阅，以及最后一个触发与工单结束之中较晚者之后两周的窗口。
- **健康。** 只通过 `ctx.report` 写已声明的条目。`health(state, code, values)` 提供 `setupPending`、`sourceOff` 和 `pollFailures` 这类固定消息。报 `error` 之前先累计连续失败次数。
- **中止。** 把信号传给 `ctx.commands.withSignal(signal)` 和 `delay`，并在条目之间检查它，这样停止或重启能立刻结束循环。

本例不发送来源自己的通知。需要通知的来源调用 `ctx.notify`；Outbox 会像其他回复一样送达它们。

本例也不把线程绑定到工单完成。只有当来源的线程生命周期决定工作是否完成时（正如 GitHub 的 Pull Request 那样），才使用 `ctx.tickets.bindThread` 和 `threadClosed`。工单何时结束仍由引擎决定。

### 10. 注册插件

在 `tsdown.config.ts` 中把该模块构建为自己的入口：

```ts
entry: { index: 'src/index.ts', 'github-watch': 'src/sources/github.ts', 'feishu-watch': 'src/sources/feishu.ts',
  'webhook-watch': 'src/sources/webhook.ts' },
```

然后在 `package.json` 的 `exports` 中加入 `"./webhook-watch": "./lib/webhook-watch.js"` 以导出构建产物，并把该插件以禁用状态加进 bundle 的 `cordis.patch.yml` 的 `insert` 列表，与飞书一样：

```yaml
    - id: xenra-superagent-webhook
      name: xenra-superagent/webhook-watch
      disabled: true
```

在某个 profile 的 `cordis.patch.yml` 里用 `id: xenra-superagent-webhook` 和 `disabled: false` 启用该插件。构建并重启。新的来源会出现在来源设置和 **评估 → 每个来源** 下。

把它的模块与测试加到 [007 架构](007-architecture.md) 的模块表和测试表中。`tests/docs.spec.ts` 会检查两份索引是否完整。

### 11. 测试

按 `tests/sources.spec.ts` 的模式创建 `tests/webhook.spec.ts`：临时目录中真实的 Store、带 `HealthBoard` 的 `SourceRegistry`、使用替身端口的 Engine，以及由 `sourceContextOf` 得到的 `SourceContext`。

通过监视 `Commands.run` 来伪造 CLI 调用。也要监视 `withSignal`，因为它通常会返回一个新的 `Commands` 实例。

```ts
function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'webhook-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { webhook: { enabled: true, config: { conversations: [{ id: 'ops', listen: 'mentions' }] } } },
    policy: { sources: { webhook: { allowed: [{ id: 'alice' }] } } },
  }))
  // 注册表在 board 上占用该种类的健康项，测试从那里读取。
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(webhookKind)
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  // 来源自己的通知进入 outbox，它保留回执，在这里不发送任何东西。
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { ...deps, store, engine, commands, receive, health: board.all, ctx: sourceContextOf(deps, webhookKind) }
}
/** 与 `hookq` 作答一致的队列。 */
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
  // 名单上的发送者 @ 了智能体，构成明确请求。
  expect(h.engine.candidate(key('webhook', 'm1'))?.strength).toBe('explicit')
  await pollQueue(h.ctx, new AbortController().signal)
  expect(await h.receive.mock.results[2]!.value).toBe('duplicate')
  h.store.close()
})
```

`message(id, fields)` 构造一条队列条目。至少要覆盖：

- 翻译：稳定的 id、线程、发起者、`human` 与 `addressed`，以及智能体自己的消息不产生触发；
- 一轮读取：触发只存储一次、范围之外的一条为 `filtered`、游标推到它们之后、名单上发送者的 @ 被研判为 `explicit`；
- 被提前中断的一轮保持它的游标；
- `send`：成功为 `sent`，只有 410 才是 `gone`，其他失败抛出，CLI 的错误由 `commandError` 构造；
- 线程上下文：一页的消息和下一页的游标，对应 `tests/registry.spec.ts` 通过 `SourceRegistry.threadContext` 读取某种类的线程；
- 插件：`apply` 注册种类，并在配置等待期间报 `setupPending`；它的销毁函数注销种类；逃出循环的失败变成来源的健康状态，而不是未处理的拒绝；
- 来源在策略中的部分及其准入行，对应 `tests/registry.spec.ts` 和 `tests/policy.spec.ts` 检查飞书来源的方式。

### 检查清单

1. 映射触发、线程、发起者、渠道地址和接收范围。
2. 写种类：`schema`、`fields`、`health`，以及配置能推导出事实时的 `facts`。
3. 用稳定的 id 把事件翻译成触发，并丢弃智能体自己的消息。
4. 在 `scope` 中仅凭 `meta` 决定来源接收什么。
5. 给它一个渠道，其 `send` 每条消息只发一次，并且只在对话永远无法收到时才回答 `gone`。
6. 如果它能读取线程，就为研判提供线程上下文。
7. 给出它在策略中的部分，包含 `allowed` 与准入行。
8. 注册它的执行环境变量。
9. 写插件条目和一个循环：等待配置、跟随开关、在 `receive` 之后推进游标、按条目保留错误、上报健康、被中止时停止；并在 `KV` 中命名游标。
10. 加上构建入口、导出和 `cordis.patch.yml` 的插入项，并在 007 的两张表中列出该模块及其测试。
11. 像 `tests/sources.spec.ts` 测试其他来源那样测试它。
