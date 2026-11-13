# 008 Cookbook

[中文](008-cookbook.md) · English

This guide shows how to extend Xenra-SuperAgent. It uses the terms of [001 Domain model](001-domain.en.md) and [002 Authorization](002-authorization.en.md) and the components of [007 Architecture](007-architecture.en.md). Each recipe names the files to change, the interface to implement and the test to add.

There are five extension points, from cheapest to most expensive:

| Extension | Changes | Restart? | Risk |
| --- | --- | --- | --- |
| A new built-in prompt part | `prompts/`, `src/app/context.ts`, `src/app/prompts.ts`, `src/client/locales.ts` | Yes: the built-in text is read when the module loads | Low |
| A new main-Session or Executor tool | `src/app/tools/` | Yes | Medium: the prompts and `tests/model-surface.spec.ts` change too |
| A new panel page or view | `src/client/` | Rebuild `lib/client.js` after changing the client plugin, then refresh the page | Medium |
| A new Source kind | `src/sources/`, `src/kv.ts`, `tsdown.config.ts`, `package.json`, `cordis.patch.yml` | Yes | High: it writes persistent records |
| A new settings block | `src/policy.ts`, `src/app/settings.ts`, `src/app/api.ts`, the panel | Yes | High: it touches revisions and migration |

## Adding a Source

This recipe implements a Source kind called `webhook`: it reads a message queue through an imaginary CLI, `hookq`, and turns messages into Triggers. Every other interface belongs to Xenra-SuperAgent.

Fix the CLI contract first; all the code below is written against it:

- `hookq pull --after <n> --json` prints the messages after position `n`, oldest first: `{"me": "<the agent's id on the queue>", "items": […], "next": <position>}`. An item carries `id`, `conversation`, `thread` (the id of the message that opened its Thread, empty on that message), `sender` with `id` and `bot`, `mentions_me`, `text`, `at` and `url`.
- `hookq reply --conversation <id> --to <message id> --key <key> --text <text>` replies under a message, once per key. When the conversation is gone it prints `{"error": {"code": 410, "message": "…"}}` to standard error and fails.
- `hookq thread --conversation <id> --root <message id> --json`, with `--after <cursor>` to page, prints one page of the Thread, oldest first: `{"items": […], "next": "<cursor>"}`, and the last page has no `next`.

Put the kind in `src/sources/webhook.ts`, following the skeleton of `src/sources/github.ts`. Once the Source grows, split translation, Channel and loop into `webhook-trigger.ts`, `webhook-channel.ts`, `webhook-read.ts` and `webhook-loops.ts`, as Feishu does.

### 1. Map the events onto the domain first

Settle the mapping before writing code. Trigger ids, Thread ids and Channel addresses are persisted, and changing them later leaves existing records unmatched.

| Concept | For the webhook queue |
| --- | --- |
| Trigger | One message |
| Thread | One message and its replies in a conversation, with the id `<conversation>:<first message id>` |
| Actor | The sender's id on the queue |
| Channel address | The conversation and message a reply goes to |
| Receiving scope | One conversation, one row in the admission table |

The module imports these:

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

### 2. Configuration, fields, facts and health

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
  // scope, channel, threadContext, policy and environment come in the steps below.
}
```

- `kind` is the stable Source id. It appears in a Trigger's `source`, the Thread key prefix, the `source:webhook` settings block and the Policy's Source part.
- `schema` validates the stored configuration and fills defaults. The registry builds an instance for every installed kind that takes effect before an operator saves anything, so the defaults must receive nothing: this example listens to no conversation by default.
- `fields` generates the Source settings card's form without panel code. `rows` edits entries keyed by their first column, and `advanced` folds a rarely changed field behind "Advanced". A kind that can resolve an id to a display name implements `refreshLabels`, stores the names under `KV.sources.labels(kind)`, and its columns can then offer `choose` and `refresh`.
- The optional `facts(deployment)` shows read-only values derived from the deployment, such as the account behind a CLI. Setup checks only the GitHub and Feishu fields listed in `SETUP_FIELDS`, so this example provides none.
- `health` declares the health entries this kind owns, starting as `starting`. Registration claims those names on the `HealthBoard` and refuses duplicates and any name beginning with `sync:`. Reporting `error` makes `scripts/xenra-superagent status` exit 2 and the hourly check tell a person, so report it only when a person has to act.

### 3. Turn a message into a Trigger

Validate the CLI's output first:

```ts
/** A message, shaped as `hookq pull` and `hookq thread` print their items. */
const MessageSchema = z.looseObject({
  id: z.string().min(1), conversation: z.string().min(1), thread: z.string().optional(),
  sender: z.looseObject({ id: z.string(), bot: z.boolean().default(false) }), mentions_me: z.boolean().default(false),
  text: z.string(), at: z.string(), url: z.string().optional(),
})
type QueueMessage = z.infer<typeof MessageSchema>
/** One `hookq pull` answer (read its `items` one by one), and one `hookq thread` answer. */
const PageSchema = z.looseObject({ me: z.string(), items: z.array(z.unknown()), next: z.number().int() })
const ThreadPageSchema = z.looseObject({ items: z.array(MessageSchema), next: z.string().optional() })
```

```ts
/** One queue message's Trigger; the agent's own messages produce none. */
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

- **Stable ids.** Derive the Trigger id from the queue id with `key`. The same id entering the Engine again answers `duplicate`, and accepting twice produces one Ticket, so rereading is safe. To treat an edit as a new event, put the edit's version in the id, as GitHub does with a comment's `updated_at`.
- **Threads.** The first Thread is the primary one, hosting the Eval; further Threads only add context. The full key of `threads[0]` is `webhook:<id>`.
- **Senders.** `actor.id` uses the Source's own id. Set `human: false` for bots and CI. A listed bot can only become an inferred candidate. A sender-less event (CI, say) takes the "off the list, not addressed to the agent" cell. Set `addressed` only when the message really addresses the agent, which gives a listed person explicit strength. Never produce a Trigger for the agent's own message.
- **Channel and metadata.** `channel` says where a reply goes, and `channel.thread` orders delivery: a message waits behind an earlier one for the same Ticket and conversation until that one has failed three times in a row. `url` points at the Source message. Source-specific fields go into `meta`, which the core never interprets. Both `text` and `meta` are untrusted data, not authority.

`orchestrator_read trigger/<id>` and `thread/<key>` read the new kind directly, showing message text, disposition and neighbouring Triggers. A new kind does not get built-in skills, original-record resources or pull request binding for free.

Full-text search needs no extra code. For people to find messages by a Source-native reference (a message id, a URL, `#12`), implement `find(query)`:

```ts
  find: query => ({ threads: [], terms: [...new Set(query.match(/\bm[0-9]+\b/g) ?? [])] }),
```

A queue message id in the query (such as `m42`) then retrieves its Trigger.

### 4. What the Source receives: `scope`

```ts
  scope({ meta }, config) {
    const conversation = config.conversations.find(item => item.id === meta.conversation)
    if (!conversation) return { listened: false, reason: 'conversation_not_listed' }
    return { listened: true, observed: conversation.listen === 'all', row: conversation.id }
  },
```

The Engine asks the kind about every incoming Trigger through `SourceRegistry.scope`. A message outside the scope is recorded as `filtered` with the kind's reason and creates no Thread. Hand those messages to `receive` rather than dropping them quietly in the loop, so the panel can explain why they were filtered.

`observed: true` means the kind receives unaddressed messages in that scope, so the admission table may judge them per cell. `row` names that table row and must match the id `policy.rows()` returns.

Revalidating a Mandate calls `scope` with only the `meta` stored on the Mandate and the current configuration, so it may depend on nothing else. Resuming needs `listened`, not `observed`. A kind without `scope` receives every Trigger it produces and observes none.

### 5. Replies: the Channel

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

- **Idempotent sending.** The Outbox calls `SourceRegistry.send`, which calls `channel.send`. While the kind is not installed, a message answers `waiting` and waits. A send can still fail after the remote side received it, so a retry must not duplicate the message: use `message.id` as the idempotency key. `hookq` takes `--key`, GitHub keeps a hidden marker in the comment, and Feishu accepts an idempotency key.
- **Permanent and retryable failures.** Answer `sent` on success, and `gone` only when delivery is permanently impossible (410 here); such a message stays as `dropped`, is never queued again, and appears in `GET sources` and on the Source page. Throw on anything else and let the Outbox retry from 5 seconds with exponential backoff up to 300 seconds. `CliError.code` is the code the CLI's output reports.
- **Allowed targets.** `allowed(address, config)` judges from the stored address and the current configuration alone; a target no longer listened to is dropped, and while the kind is off its messages wait. Without `allowed`, every address may receive a reply as long as the kind is enabled.
- **Links.** `link(address, links)` returns the URL and label the panel shows through `SourceRegistry.link`; the `url` is empty when the deployment information is missing.

### 6. Thread context for assessments

```ts
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    // The queue's Threads are flat: the root, and the message a reply answers, are on the first page, as with GitHub.
    read: async (commands, trigger, _part, cursor) => {
      const page = ThreadPageSchema.parse(JSON.parse(await commands.run('hookq', ['thread', '--conversation',
        String(trigger.meta.conversation), '--root', String(trigger.meta.root), '--json', ...(cursor ? ['--after', cursor] : [])])))
      const messages = page.items.map(item => ({ id: item.id, from: item.sender.id, at: item.at, text: item.text,
        ...(item.sender.bot ? { bot: true as const } : {}), ...(item.url ? { url: item.url } : {}) }))
      return { messages, ...(page.next ? { next: page.next } : {}), body: { messages } }
    },
  },
```

A proactive assessment needs the conversation around the Trigger. `orchestrator_eval` reads the initial window, and `orchestrator_eval_read` expands a page, the root or the parent message. Implement the optional `threadContext`:

- `read(commands, trigger, part, cursor, config)` returns a `ContextPart`. Its `messages` are `ContextMessage`s: `{id, from, at, text}` plus whatever of `bot`, `deleted`, `reply_to`, `url`, `path` and `line` applies. The last page omits `next`. `body` is what the assessing Session sees. An optional `status` describes a special outcome, such as Feishu's `chat_neighbours`. `part` is `thread`, `root` or `parent`.
- `messageId(trigger)` gives the id of the Trigger's own message among the Thread's messages, which is how an assessment locates it.
- `images(text)` and `image(…)` serve kinds with images (Feishu, for instance); this example omits them.

`admissionContext` in `src/sources/admission-context.ts` bounds `read` at `admissionContextMaxPages` pages and then hands the result to `threadWindow`, which selects the first five messages plus five on either side of the Trigger. So as long as `read` pages faithfully, the assessment's window is bounded.

When a message answers an earlier one, add `repliesTo(trigger)` returning the answering Trigger's id, so relays and Executor Inputs can show it:

```ts
  repliesTo: trigger => typeof trigger.meta.replyTo === 'string' ? key('webhook', trigger.meta.replyTo) : undefined,
```

### 7. Who may originate work: the Policy part

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

- `schema` validates the Source's part of the Policy, including the `allowed` senders. Ids compare case-insensitively. The admission table is validated separately by `src/policy.ts` and shared across kinds. The part is stored under `policy.sources.webhook` and counts toward the Policy version.
- `fields` generates the form under **Eval → On each Source**, and its first field must be `allowed`. `explicit` says what counts as addressing the agent. The optional `unnamed: { person, bot }` labels unreadable ids such as a Feishu `ou_…`; this example omits it, because a queue id is readable.
- `rows(config)` lists the admission scopes and which of their cells are available, and each row id must match the `row` that `scope` returns. Those cells are available only when the kind observes unaddressed messages. Kinds without `rows` use the admission table's defaults.
- The optional `bots` lists the bots that may become inferred candidates, shaped like `allowed`; without it no bot is admitted.
- The optional `sync: { label, ready(part), run(host, part, signal) }` refreshes the list at startup and on **Sync now**. Feishu uses chat membership. A failure is recorded under `sync:<id>` and retried with a backoff from a minute to an hour.

`SourcePolicyPart`'s generic requires a type that is `Record<string, unknown> & { allowed: { id: string; name?: string }[] }`, which the schema above infers exactly.

### 8. Variables for the Executor

```ts
  environment: {
    variables: [{ key: 'XENRA_SUPERAGENT_WEBHOOK_CONVERSATION', description: {
      zh: '接下工单的 webhook 对话；工单不是从这个来源来的时为空',
      en: 'The webhook conversation that started the ticket; empty when the ticket did not start on this Source' } }],
    values: ({ trigger }) => ({
      XENRA_SUPERAGENT_WEBHOOK_CONVERSATION: trigger?.source === 'webhook' ? String(trigger.meta.conversation ?? '') : '' }),
  },
```

The Execution settings list the declared `variables` beside the prepare command, even while the kind is disabled. While it is enabled, `values` computes each variable from the deployment, the configuration and the originating Trigger. The prepare command reads them as environment variables, and the Executor reads them with their descriptions in its instructions.

Use the `XENRA_SUPERAGENT_<KIND>_…` prefix, return an empty value for a Ticket from another Source, and never put a credential in one: the host strips variables whose names contain KEY, PASSWORD, SECRET or TOKEN, so they would never arrive.

### 9. The plugin entry and its loop

```ts
export const name = 'xenra-superagent-webhook'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(webhookKind), 'webhook: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, webhookKind)
    const controller = new AbortController()
    // DSH ends the process on an unhandled rejection, so a failure escaping the loop becomes Source health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('webhook', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
```

The plugin injects `orchestrator`, the `SourceHost`. The first effect registers the kind and returns its disposer; the second runs the loop and returns the cleanup that aborts it and waits for it to end. Both cleanups run when the application stops or restarts.

```ts
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Xenra-SuperAgent restarts once setup resolves the accounts; before that a Source reads nothing.
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
        // One network failure retries on the next round; three in a row need a person.
        if (!signal.aborted && failures >= 3) {
          ctx.report('webhook', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((config?.pollSeconds ?? 30) * 1000, undefined, { signal }).catch(() => {})
  }
}

/** Read the queue after the cursor, take in every message, then move the cursor past them. */
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

- **Configuration and switches.** Await `ctx.ready`, and read nothing while `ctx.configured()` is false. Read `ctx.config(kind)` on every round: it returns `undefined` while the kind is off.
- **The cursor.** Keep the read position in `ctx.state`, with a key registered in `KV` (`src/kv.ts`), such as `webhook: { cursor: record<number>('webhook-cursor') }`. `tests/store.spec.ts` requires key literals to appear only in that table; an external package can define its own keys with the exported `record` and `family`. Setting a key to `undefined` removes the record, and `ctx.atomic` folds several writes into one transaction.

  Advance the cursor only after every Trigger in the batch is stored. An interrupted round leaves the cursor alone, and stable ids make replay safe. A timestamp cursor uses `cursorAt(started)` from `src/sources/poll.ts`, which steps back five seconds to catch late remote writes.
- **Thread metadata.** After receiving a Trigger, call `ctx.threads.describe(key, { label, url, facts })` to fill in its display information; `ctx.threads.patch(key, meta)` sets the Source's own keys and removes one when its value is `undefined`. Both ignore a Thread that does not exist, including the Thread of a filtered Trigger.
- **Per-item errors.** Count the malformed items and continue rather than failing the batch. `validItems(item, list, tally)` in `src/infra/commands.ts` is that pattern. To poll Threads independently, use `pollThreads` from `src/sources/poll.ts`, which records each failure as `pollError` and uses `polled` to decide whether a Thread is still within the observation window.
- **Health.** Write only your own declared entries, through `ctx.report`. `health(state, code, values)` provides fixed texts such as `setupPending`, `sourceOff` and `pollFailures`, which the panel translates by `code`. Count consecutive failures before reporting `error`.
- **Aborting.** Pass `signal` to `ctx.commands.withSignal(signal)` and to `delay`, and check it between items, so a stop or restart ends the loop at once.

This example sends no notifications of its own. When a Source needs one, call `ctx.notify`; the Outbox delivers it like any other reply.

This example does not bind Threads to Tickets either. Do that with `ctx.tickets.bindThread` and `threadClosed` only when the Source's Thread lifetime decides whether work is done (GitHub's pull requests are the case); when a Ticket ends stays the Engine's decision.

### 10. Register the plugin

First add the entry to the first block of `tsdown.config.ts`:

```ts
entry: { index: 'src/index.ts', 'github-watch': 'src/sources/github.ts', 'feishu-watch': 'src/sources/feishu.ts',
  'webhook-watch': 'src/sources/webhook.ts' },
```

Add `"./webhook-watch": "./lib/webhook-watch.js"` to `package.json`'s `exports` for the built output, then add the plugin to the bundle's `cordis.patch.yml` `insert` list, disabled, as Feishu is:

```yaml
    - id: xenra-superagent-webhook
      name: xenra-superagent/webhook-watch
      disabled: true
```

Then enable it in a profile's `cordis.patch.yml` with `id: xenra-superagent-webhook` and `disabled: false`. Rebuild and restart, and the new Source appears in the Source settings and under **Eval → On each Source**.

Finally add the module and its test to both tables of [007 Architecture](007-architecture.en.md); `tests/docs.spec.ts` checks that the two indexes are complete.

### 11. The test to add

Create `tests/webhook.spec.ts` following `tests/sources.spec.ts`: a real `Store` in a temporary directory, a `SourceRegistry` with its `HealthBoard`, an `Engine` with stand-in ports, and the `SourceContext` that `sourceContextOf` builds.

Fake the CLI calls with `vi.spyOn` on `Commands.run`. Fake `withSignal` as well, since it usually returns a new `Commands`.

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
  // The registry claims the kind's health entry on the board, and the test reads it from there.
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(webhookKind)
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  // The Source's own notifications enter the outbox; here they only record a receipt and send nothing.
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { ...deps, store, engine, commands, receive, health: board.all, ctx: sourceContextOf(deps, webhookKind) }
}
/** A queue that answers the way `hookq` does. */
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
  // A sender on the list mentioned the agent, which makes an explicit request.
  expect(h.engine.candidate(key('webhook', 'm1'))?.strength).toBe('explicit')
  await pollQueue(h.ctx, new AbortController().signal)
  expect(await h.receive.mock.results[2]!.value).toBe('duplicate')
  h.store.close()
})
```

`message(id, fields)` builds a queue item. Cover at least:

- translation: stable ids, the Thread, the actor, `human` and `addressed`, and the agent's own messages producing no Trigger;
- one round: each Trigger stored once, one outside the scope `filtered`, the cursor moved past them, and a listed sender's mention assessed as `explicit`;
- an interrupted round leaving the cursor alone;
- `send`: `sent` on success, `gone` only for 410, and anything else thrown, with the CLI's error carried out as `CliError`;
- thread context: a page's messages and the next page's cursor, matching how `tests/registry.spec.ts` reads a kind's Thread through `SourceRegistry.threadContext`;
- the plugin: `apply` registering the kind, reporting `setupPending` while setup waits, its cleanup unregistering the kind, and a failure escaping the loop becoming Source health rather than an unhandled rejection;
- the Policy part and its admission rows, as `tests/registry.spec.ts` and `tests/policy.spec.ts` check Feishu's.

### Checklist

1. Settle the mapping: Trigger, Thread, actor, Channel address and receiving scope.
2. Write the kind: `schema`, `fields`, `health`, and `facts` when the configuration implies them.
3. Translate events into Triggers with stable ids, and discard the agent's own messages.
4. Decide in `scope`, from `meta` and the configuration alone, what the Source receives.
5. Give it a Channel whose `send` sends each message once and answers `gone` only when the target can never receive it.
6. Provide `threadContext` if it can read Threads.
7. Give it a Policy part with `allowed` and its admission rows.
8. Register its execution environment variables.
9. Write the plugin entry and its loop: await setup, follow the switch, move the cursor after `receive`, keep errors per item, report health, and stop when aborted; name its cursor key in `KV`.
10. Add the build entry, the `exports` and the `cordis.patch.yml` insert, and list the module and its test in both tables of 007.
11. Test it the way `tests/sources.spec.ts` tests the other Sources.

## Adding a prompt part

Prompt composition lives in `src/app/prompts.ts`. A part has four things: a key, its default text, the roles that read it, and its template placeholders, if any.

1. **The default text.** Fixed built-in text lives in `prompts/`, one sentence per line, read and joined into paragraphs by `promptFile` in `src/app/context.ts`. To add one, create `prompts/verification.md` and export `verificationPrompt = promptFile('verification')` from `context.ts`.
2. **Register the part.** Add the key to `PART_KEYS` (for example `'runtime/verification'`) and an entry to `builtInParts()`, such as `{ roles: BOTH, text: verificationPrompt }`. `roles` decides which role's prompt reads it. List any placeholder (such as `{variables}`) in `placeholders`, or an override will not be checked for losing it.
3. **Place it in the order.** `promptParts(config, role, environment, policy)` decides the order: `runtime/shared` and the role's part first, then the three team sections, then subscriptions, replies and routing or work, then the accept constraints, the hand-off, the execution environment and the Policy. A new part must appear there, or it reaches no prompt.
4. **Panel copy.** Add a `promptPart.<key>` entry in both languages to `src/client/locales.ts`; `tests/panel-prompts.spec.tsx` checks that `builtInParts()` and the copy table list the same keys.
5. **Contract tests.** `tests/cards.spec.ts` lists, file by file, the rules the built-in text must state. Add a row there when the new part states a rule that cannot be dropped; the `BUDGET` in `tests/model-surface.spec.ts` also moves closer as the text grows, so raise it deliberately when needed.

The team sections (`communication`, `scope`, `delivery`) take another route: `TEAM_SECTIONS` and `TEAM_HEADINGS` define them, their headings are the panel's section titles, and changing them touches `tests/prompts.spec.ts`.

## Adding a tool

Tools live in `src/app/tools/`. Decide first which role owns the new one: the main Session's tools are in `main.ts`, the Executor's in `executor.ts`, and both use the `Tool` type from `tool.ts`.

This example adds a read-only tool to the Executor that reads one Assignment's full report: a Ticket card's `preview` is only the latest report's summary, cut by `preview()` at 160 characters.

```ts
tool({
  name: 'orchestrator_assignment_report',
  description: 'Read the full report of one of this ticket\'s assignments; its card shows only a 160-character preview of the latest.',
  schema: z.object({ assignment_id: z.string().min(1) }).strict(),
  execute: async (args, signal) => readResource(host.resources, `ticket/${ticketId}/report/${args.assignment_id}`, 0, undefined, ticketId, signal),
})
```

`ticketId` is the id of the ticket `executorTools(host, ticket)` received; the other tools of `executorTools` close over that ticket the same way. Add it to the array `executorTools` returns, and `Sessions` registers it when it decorates the Executor Session.

The rules:

- **The description is all a model reads.** Say who calls it and when, and what it changes. `tests/model-surface.spec.ts` checks that every tool name it mentions is registered, that enum options are valid, that no legacy term appears, and that the whole surface stays within its size budget.
- **Use `.strict()` schemas.** Extra fields are refused on the model's side, so a wrong call never reaches the body.
- **Authority first, then the tool.** A tool makes no authorization decision of its own; it calls an Engine role interface (`EngineForMainSession`, `EngineForExecutor`, and so on), and a refusal is a `UserError` the panel words by `code`. When the domain needs a new action, add the Engine command and its role interface first, and never change the repositories from a tool.
- **Keep panel-only actions out.** There is no tool for the execution environment, account fields, closing an unfinished Decision, rerunning setup or refreshing display names; `orchestrator_trigger_requeue` deliberately refuses a Trigger whose follow-up an Executor still owns.
- **Take dependencies from the host.** When a tool needs a new capability, extend `MainToolsHost` or `ExecutorToolsHost` and provide it from `toolHost` in `src/app/runtime.ts`; do not reach for the `Runtime`. A ticket-reading tool also has to serve the Executor side: `readResource` filters ids by caller, so an Executor Session sees neither other Tickets nor Decisions.
- **Tests.** `tests/tools.spec.ts` covers tool registration, role-scoped resource reads and each refusal; `tests/model-surface.spec.ts` counts the new tool against the budget and checks that no prompt names a tool that does not exist.

## Adding a panel view

The panel lives in `src/client/`, and its modules may not import each other in a cycle (`tests/controls.spec.tsx` walks the graph).

- **A single page.** For a new tab, change `TABS` and the `Route` union in `src/client/route.ts`, its branch in `parseRoute`, and add a `case` in the `Pages` component of `src/client/app.tsx`. A settings page only needs an entry in `SETTINGS_GROUPS`.
- **Data comes from the host.** Use `usePoll` and `call` from `src/client/api.ts` to read the routes declared in `src/app/api.ts`. New data means a new route and response type there, an implementation in the `routes` table of `src/app/http.ts`, and a view function under `src/app/views/`. `tests/fixtures/panel-server.ts` implements every route, so a new one has to be added there too.
- **Copy.** All copy goes through keys in `src/client/locales.ts`, one entry per language, with identical placeholders (`tests/locales.spec.ts` checks them).
- **Styles.** Use the classes in `client.css` and the `--dsw-alias-*` tokens, one rule per line; `tests/styles.spec.ts` rejects a class no component uses.
- **Controls.** Use the local copies in `src/client/controls.tsx` or the shared widgets in `widgets.tsx`; do not import `@deepseek-ai/dsh-client-ui-primitives`.
- **Tests.** Create a new `tests/panel-*.spec.tsx` following the others: `tests/fixtures/panel.tsx` provides `mount`, `click`, `type`, `field`, `tab` and friends, and the fake server answers by route and records any undeclared query parameter.
