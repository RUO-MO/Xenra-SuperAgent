# 007 Architecture

[中文](007-architecture.md) · English

This is the implementer's guide. It maps the concepts of [001 Domain model](001-domain.en.md) through [006 Deployment](006-deployment.en.md) onto classes, interfaces and files. Read the layering and the dependency rules first, then use the module and test tables as the index into the code.

## Layering

The code has six layers, and dependencies point one way:

| Layer | Directory | Responsibility | May import |
| --- | --- | --- | --- |
| Core | `src/core/` | Domain types, ports, the Engine and its five parts; knows nothing of Sources, Policy, assessment or execution | Only itself, plus Node's `node:crypto` |
| Policy | `src/policy.ts`, `src/admission.ts`, `src/limits.ts` | Settings schemas, the Policy version, the gate, the admission table | Core, `node:` and `zod` |
| Application | `src/app/` | Composition root, Store, effect queue, Sessions, Executor host, HTTP routes, views, tools | Core, Policy, Executor, Sources, infrastructure |
| Executor | `src/executor/` | One Session and one directory per Ticket; host events; background jobs and subagents | Core, parts of the application, infrastructure |
| Sources | `src/sources/` | One kind per Source: configuration, Policy part, Channel, thread context, polling loops | Core, infrastructure, `src/deployment.ts`; **not** `src/app/` |
| Infrastructure | `src/infra/` | CLI transport, process environment and shims, health board, packaged paths, text metrics | No internal dependency |
| Panel | `src/client/` | The panel that runs in the browser; imports only host-side **types** and a few pure modules | The pure values of `src/core/errors.ts` and `src/core/reasons.ts`, `src/setup.ts`, `src/limits.ts`, `src/admission.ts`, `src/navigation.ts`, `src/sources/host.ts`, and the filter lists and types of `src/app/api.ts` |

### Dependency rules

- **The core does no I/O.** The only Node import under `src/core/` is `createHash` in `src/core/ids.ts`, which derives stable ids from inputs. Storage, subprocesses and the clock arrive through the ports in `src/core/ports.ts`.
- **Sources do not know the application.** `src/sources/` cannot see `src/app/`. It gets its capabilities from `SourceContext` (`src/sources/host.ts`), which `sourceContextOf` in `src/app/source-context.ts` implements on the host side.
- **The panel takes types only.** Every `@deepseek-ai/*` import in `src/client/` is `import type`, and nothing imports `@deepseek-ai/dsh-client-ui-primitives` (the local copy is `src/client/controls.tsx`). `tests/controls.spec.tsx` checks both line by line, and checks that no panel module imports another back.
- **One interface per dependency.** Host dependencies are narrow interfaces: `SessionsHost`, `SettingsHost`, `SetupHost`, `PassesHost`, `OutboxHost`, `ExecutorHost`, `AssessorHost`, `HttpHost`, `MainToolsHost`, `ExecutorToolsHost`, `ResourceHost`, `LinkHost`, `SourceContextDeps`. Most are a `Pick` of another class.
- **One writer per state.** Triggers, Threads, Decisions, Tickets and Assignments belong to the Engine; effect rows to Effects; receipts to the Outbox; a health entry to the part that claimed it; and `kv` to the owner registered in `src/kv.ts`.

## State

One SQLite file, `<stateDir>/orchestrator.sqlite`, opened only by `Store` in `src/app/store.ts`. The Runtime locks the state directory before opening it.

### Tables

| Table | Shape | Writer |
| --- | --- | --- |
| `trigger` | `id`, `value` (JSON), `at` | Engine |
| `disposition` | `id`, `value`: where the Trigger went | Engine |
| `trigger_thread` | `(thread, id, at, human)`, the Thread timeline index | Store, with each Trigger |
| `thread` | `key`, `value` | Engine; Sources write `meta` |
| `ticket` | `id`, `value` | Engine |
| `decision` | `id`, `thread`, `value` | Engine |
| `effect` | `(kind, key)`, `value`, `seq`, `generation`, `attempts`, `error`, `due`, `since` | Effects |
| `outbox` | `id`, `value`: a message with its `status` | Outbox |
| `kv` | `key`, `value`: everything else | The part that registered it |

### Generated columns and working sets

`SETS` adds generated columns and partial indexes to several tables so a pass scans active rows only: `ticket.open`, `ticket.active`, `thread.active`, `thread.subscribed`, `outbox.dropped`, `outbox.pending`. On open, a generated column whose definition changed or that was removed is dropped and rebuilt, and a missing one is added, with SQLite computing its values from the row's JSON. `tests/store.spec.ts` covers both cases.

### Transactions

`Store.atomic` implements nestable transactions with savepoints; a failing inner transaction rolls back only its own level. `afterCommit` callbacks run once the outermost transaction commits, and callbacks queued inside a rolled-back level are discarded. A callback that throws is reported and does not affect the committed transaction.

### `kv` and migration

`src/kv.ts` defines every family of `kv` record with its owner, key and value type. `tests/store.spec.ts` requires key literals to appear only in `src/kv.ts` and in migration code. The current schema is 11: `src/app/migration.ts` writes a schema 10 database into the current shape once at startup, and rejects anything older. `SCHEMA_VERSION` only grows, so an older build refuses to open a newer database.

## The effect queue

`Effects` in `src/app/effects.ts` is a durable queue. A command calls `enqueue(kind, key, payload)` inside its own transaction; the row becomes visible when that transaction commits and vanishes when it rolls back.

- **One row per kind/key.** Enqueuing a waiting key again replaces its payload, increments `generation`, resets `attempts` and makes it due at once, keeping its queue position. A running attempt matches its own row by `seq` and `generation`, so a replaced row is neither deleted nor overwritten by it.
- **One handler per kind.** `handle(kind, run, {limit, retry, ordered, quiet})` registers it; `limit()` is evaluated at each dispatch, and 0 holds the kind back (which is what a pause does).
- **Order.** An `ordered` kind reads only its oldest row and stops behind it until that row finishes or falls due; relays and notices keep their order this way.
- **Backoff.** A failure retries from `retry[0]`, doubling each time up to `retry[1]`. Throwing `Later` says the work cannot run now (no free slot, Source off): it is deferred by `retry[0]` without counting as a failure.
- **Health.** Each kind owns a health entry under its own name; `FAILURES_BEFORE_ERROR` (3) consecutive failures report an error, which the next success clears. A `quiet` kind does not report, because its failures already show on the Ticket.

The six kinds and their handlers:

| Kind | Handler | Does |
| --- | --- | --- |
| `assessment` | `MasterAssessor` | Delivers an Eval's candidate card into a main-Session turn, then tells the Engine the candidate arrived, which starts the Eval's deadline |
| `launch` | `DshExecutor` | Launches a pending Assignment: the prepare command, the Executor Session, the Assignment message |
| `delivery` | `DshExecutor` | Hands a Ticket's waiting Inputs to its running Assignment, in order |
| `relay` | `Sessions` | Steers an Executor's report or question, or a person's follow-up, into a main-Session turn |
| `notice` | `Sessions` | Injects a notice into the main Session without waking it |
| `reply` | `Outbox` | Sends one message for a Channel through its Source |

## Passes and scheduling

`Passes` in `src/app/passes.ts` is the clock. It runs every two seconds, and a Source receiving a Trigger, a tool finishing a command, or a settings save also requests a pass.

- **One pass at a time.** A request that arrives while a pass runs records a single follow-up pass instead of a queue.
- **What it runs.** First `effects.kick()` to dispatch due effects, then `engine.evaluateDue()`; neither makes a business decision.
- **Pause and setup.** It returns early before setup finishes or while closing; while paused, `evaluateDue` still records the pause so that Evals in progress do not expire.
- **Health.** A failing pass writes the `runtime` health entry, and the next success clears it.

`Engine.evaluateDue` is the domain's clock: it starts the Evals of Threads whose Triggers wait, requeues the Triggers of overdue Evals, and resumes ended Tickets that a person's message reached while processing was paused. An Eval whose candidate has not reached the main Session does not expire.

## Concurrency and locking

- **The state-directory lock.** The Runtime locks `<stateDir>` with `proper-lockfile` (`stale: 30_000`) and opens the database only after it; when the lock is compromised it sets the `runtime` health entry to an error and aborts the lifetime signal. A second process therefore fails to start rather than migrating the same state alongside the first.
- **The database.** `PRAGMA journal_mode=WAL; synchronous=FULL`, with the file at 0600 and its directory at 0700.
- **The Engine is synchronous.** Each command changes its own aggregate in one transaction; ports queue external work inside that transaction, and adapters run it after the commit. `evaluateDue` uses one transaction per Eval or per Ticket it changes.
- **Executor slots.** `WorkerSlots` reserves capacity before a launch or a wake, a person's message may use one slot beyond the limit, a wake takes precedence over a launch, and nothing starts beyond `maxWorkers`.
- **Panel and API concurrency.** Settings and prompts use revisions for optimistic concurrency: a save carries `revision` or `baseRevision`, and a block changed elsewhere answers 409 instead of being overwritten.
- **Effect concurrency.** See the previous section; the `launch` limit is exactly the number of free slots.

## The HTTP surface

`registerHttp` in `src/app/http.ts` registers the `/orchestrator` prefix on `ctx.webServer`.

- **Loopback only.** A `ctx.webServer.host` other than `127.0.0.1` throws.
- **Same origin.** `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, `x-orchestrator-request` must be `1`, and `Origin` must either be absent or equal `http://<host>`. The port is the listening port, or the one `getOrigin()` names for a listener this process did not bind; with neither, the request is refused. Anything else answers 403.
- **The route table.** `routes(runtime)` maps `'METHOD path'` to a handler, and a path segment starting with `:` is a parameter, URL-decoded, with a malformed escape answering 400. The `Api` type in `src/app/api.ts` is the type-side of the same table and imports types only, which is what lets the panel bundle it. [006 Deployment](006-deployment.en.md) lists the routes.
- **Failure mapping.** One function turns exceptions into statuses: `z.ZodError` → 400 with `issues`, `SetupError` → 400 with `setup`, `RouteError` → 400 or 404, `UserError` → 404 when `missing` and 400 otherwise, with `code` and `values`, `SettingsConflict` and `PromptConflict` → 409, everything else → 500.
- **Request bodies.** The default limit is 128 KiB, with a separate allowance for prompt saves; a body that is not JSON answers 400. Every response is `application/json; charset=utf-8` with `cache-control: no-store` and `x-content-type-options: nosniff`.
- **Startup order.** Routes are registered before setup runs, so setup problems can be fixed in the panel, and every request awaits `runtime.ready` first.

## The client module format

The panel is a separate browser entry, bundled by the second block of `tsdown.config.ts` as CJS and then wrapped into DSH's module loader by a banner and a footer:

```js
window.__ModuleLoader__.load({ id: "xenra-superagent", factory: (require) => { /* ... */ return module.exports; } })
```

The `id` must equal the package name in `package.json`, whose `dsh.client` declares the `web` platform and the host plugins to inject. `lib/client.js` is therefore not an ES module one can import directly; it is a factory in a registry.

`apply` in `src/client/index.tsx` does three things: it registers the bilingual dictionaries under the `xenraSuperagent` namespace, it registers the panel and a sidebar icon in the `main` and `sidebar.panellist` slots, and it registers the config page in `plugins.row.config`. The Deployment page is reused in both places: `DeploymentPage` in `src/client/deployment.tsx` receives `state.setup` from the panel, while `PluginConfig` polls the state itself.

## Test strategy

The 59 specs under `tests/` fall into four groups.

- **Domain and pure functions.** `core-engine.spec.ts` runs every domain rule against `MemoryRepositories`; `stage.spec.ts` checks the stage table of [003 Execution](003-execution.en.md) row by row; `policy.spec.ts` covers the gate, Mandate revalidation and assessment outcomes; `cache.spec.ts`, `timeline.spec.ts`, `markdown.spec.ts`, `marks.spec.ts`, `prompt-config.spec.ts` and `draft.spec.ts` test pure functions.
- **Host and services.** `runtime.spec.ts` and `runtime-concurrency.spec.ts` run the whole application on a simulated DeepSeek Harness host; `sources.spec.ts`, `registry.spec.ts`, `commands.spec.ts`, `deployment.spec.ts`, `environment.spec.ts` and `service-script.spec.ts` cover Sources, the CLIs, setup and the script; `migration.spec.ts` migrates real database files; `store.spec.ts` compares SQLite with the in-memory repositories on order and rollback.
- **Panel.** Each `panel-*.spec.tsx` covers one group of pages against a fake server that implements every route in `src/app/api.ts` (`tests/fixtures/panel-server.ts`); `client.spec.tsx`, `navigation.spec.ts` and `controls.spec.tsx` cover registration, navigation and the local controls.
- **Docs and contracts.** `docs.spec.ts` checks numbering, language pairing, link direction and this document's two tables; `class-docs.spec.ts` requires a JSDoc block before every class; `model-surface.spec.ts` checks everything a model reads (tools, prompts, skills, inputs) against the schemas, the glossary and size budgets; `cards.spec.ts` checks, file by file, the rules the built-in text has to state; `locales.spec.ts` checks that both languages name the same placeholders and that every error code is worded; `styles.spec.ts` checks that the stylesheet uses only classes a component really uses.

Cases that need POSIX (`#!/bin/sh` shims, `tmux`, `ps`) are skipped with `it.skipIf`, as `tests/fixtures/platform.ts` records.

## Modules

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | The plugin entry: reads the machine settings, constructs the Runtime, hands it the restart callback, and exports `Config` with the core |
| `src/deployment.ts` | The plugin's `Config` and `Machine`; `resolveDeployment` and `resolveFeishuBot` read the repository and accounts from the Source settings, running each CLI the way Executor shells do; `SETUP_FIELDS` lists the Source fields setup reads |
| `src/setup.ts` | Setup problems: `SetupError` and its code table `SETUP_PROBLEMS`, each with the place that fixes it and the English text both languages share |
| `src/policy.ts` | The settings schemas, `policyVersion`, the `Policy` that `settingsPolicy` returns, admission validation, `policyEffects` and `assessmentOutcome` |
| `src/admission.ts` | The admission table's three cells, the values each may take and its defaults, shared with the panel |
| `src/limits.ts` | The bounds of the values a person sets, checked by the settings schemas and offered by the panel's fields |
| `src/kv.ts` | `KV`: every family of `kv` records with its key, value type and owner, plus `Key`, `Family`, `record` and `family` |
| `src/navigation.ts` | `openKnownSession`: opens a Session from the panel once the host catalog lists it |
| `src/core/model.ts` | The domain types and their invariants, among them `threadKey`, `isoTime`, `liveTicket`, `ticketOutcome`, `reached`, `followupOwners`, `settled`, `waitsForPerson`, `runningAssignment`, `latestAssignment` and `latestReport` |
| `src/core/ports.ts` | The ports `Repositories`, `Policy`, `SourceScope`, `Assessor`, `Executor` and `Outbox`, and `DomainEvents` |
| `src/core/engine.ts` | The Engine and the five role interfaces `EngineForSources`, `EngineForMainSession`, `EngineForPeople`, `EngineForSettings` and `EngineForExecutor` |
| `src/core/part.ts` | The `EnginePart` base and `EngineOptions`: the repositories, Policy, clock, events and hand-back logic the parts share |
| `src/core/intake.ts` | `Intake`: receiving Triggers, correlating Threads, fanning out subscriptions, queuing Evals |
| `src/core/evals.ts` | `Evals`: a Thread's Eval, its batch, candidates, replay, hand-back and Decision |
| `src/core/tickets.ts` | `Tickets`: a Ticket's lifecycle from accept to end, the Threads it follows, its Subscriptions and its Inputs |
| `src/core/assignments.ts` | `Assignments`: an Assignment's start, reads and end, and the Executor's reports and the questions in them |
| `src/core/replies.ts` | `Replies`: the Engine's Channel writes through the Outbox, one rule per purpose |
| `src/core/stage.ts` | `ticketStage` and `canRetry`: a Ticket's stage and whether it can be retried |
| `src/core/errors.ts` | `UserError` and `USER_ERRORS`: the fixed refusals with their category and English template |
| `src/core/reasons.ts` | `REASONS`, `Reason`, `said` and `reasonText`: the reason codes for Decisions and for setting a Trigger aside |
| `src/core/ids.ts` | `key`: ids derived from their inputs |
| `src/core/memory.ts` | `MemoryRepositories`: the Store's repositories in memory, with the same order and nested rollback |
| `src/core/index.ts` | The core's export surface |
| `src/app/runtime.ts` | The Runtime: composition root that locks the state directory, constructs the parts, registers the routes and the Source host, and starts and stops |
| `src/app/setup.ts` | `Setup` and `setupChanged`: probes the CLIs, writes and applies the execution environment, records setup problems and restarts when needed |
| `src/app/passes.ts` | `Passes`: the two-second pass, coalescing requests and writing a failure into the `runtime` health entry |
| `src/app/store.ts` | `Store`: the domain repositories over SQLite, `kv`, settings versions, receipts, and `Receipt` with `SettingsVersion` |
| `src/app/store-read.ts` | `storeReads`: the read-only queries for the views, the tools and the Sources' polls |
| `src/app/migration.ts` | The schema 11 migration: writes a schema 10 database into the current shape once, and rejects older ones |
| `src/app/effects.ts` | `Effects`, `Later` and `FAILURES_BEFORE_ERROR`: the durable effect queue |
| `src/app/versions.ts` | `Versions`: numbered snapshots with a current pointer, shared by the settings and the prompts |
| `src/app/cache.ts` | `TextCache`: texts held in memory within a size, the least recently used dropped first |
| `src/app/git-upgrade.ts` | `GIT_MINIMUM`, `atLeast`, `planUpgrade` and `upgrade`: report the Executor's git and offer the upgrade this machine can run, executed only after a person confirms |
| `src/app/settings.ts` | `Settings` and `SettingsConflict`: block validation, revisions, pause, Policy sync and label refresh |
| `src/app/settings-history.ts` | `policyHistory`: each saved settings revision with what it changed from the one before |
| `src/app/prompts.ts` | `Prompts`, `builtInParts`, `promptParts` and `PromptConflict`: versioned prompts, overrides of built-in parts, composition and validation |
| `src/app/context.ts` | The built-in text read from `prompts/` and `skills/`, and `transcriptEntry` |
| `src/app/skill-files.ts` | `promptFile` and `bundledSkills`: joins a one-sentence-per-line file into paragraphs, and reads the packaged skills |
| `src/app/sessions.ts` | `Sessions`, `WORKER_PRESET` and `ROUTER_PRESET`: Session creation, decoration, tool restriction, delivery and model retries |
| `src/app/delivery.ts` | `AgentDelivery` and `messageId`: one delivery per request id, also across a restored Session |
| `src/app/retry-health.ts` | `RetryHealth`: which Sessions wait on a model-budget retry, for the `models` health entry |
| `src/app/role-models.ts` | `resolveRoleModel` and `initializeRoleModel`: resolve a role's model and seed it onto a new Session |
| `src/app/assessment.ts` | `MasterAssessor`, `AssessmentSchema` and `EvalReadSchema`: the candidate card, bounded reads and the outcome conversion |
| `src/app/execution-environment.ts` | The execution environment: `EXECUTOR_VARIABLES`, `executionRoot`, `environmentOf`, `ticketEnvironment`, `environmentLines` |
| `src/app/source-context.ts` | `sourceContextOf` and `SourceContextDeps`: each Source kind's `SourceContext` |
| `src/app/links.ts` | `sourceLink`, `repliedTo` and `candidateCard`: a Source message's link and the candidate card |
| `src/app/cards.ts` | The compact cards models read, `TICKET_STATES`, `textPage` and `relatedTickets` |
| `src/app/resources.ts` | `RESOURCES`, `resourceGrammar` and `readResource`: everything `orchestrator_read` can read |
| `src/app/notices.ts` | `eventNotice`, `reportRelay`, `resultRelay`, `followupRelay` and `receiptNotice`: the main Session's notices and relays |
| `src/app/outbox.ts` | `Outbox`: the `Outbox` port, the receipts and the `reply` effects |
| `src/app/http.ts` | `registerHttp`, `sameOrigin` and `stateView`: the route table, the same-origin check and the failure mapping |
| `src/app/api.ts` | `Api`: every route with its parameters, query, body and response, and the list filters; types only |
| `src/app/tools/tool.ts` | `Tool`, `RegisterTool`, `readTool` and `AcknowledgementSchema` |
| `src/app/tools/main.ts` | `mainTools` and `MainToolsHost`: the main Session's fourteen application tools |
| `src/app/tools/executor.ts` | `executorTools` and `ExecutorToolsHost`: the Executor's six application tools |
| `src/app/views/text.ts` | `preview`, `markdown`, `plain`, `readable` and `attribute`: the two forms of a view's text |
| `src/app/views/records.ts` | The rows the views share, with `snapshot`, `ownersOf`, `channelLink` and `decisionView` |
| `src/app/views/tickets.ts` | `ticketList`, `ticketDetail`, `basisFacts` and `executorLoad` |
| `src/app/views/threads.ts` | `threadList`, `threadDetail`, `search` and `decisionList` |
| `src/app/views/sources.ts` | `sourcesStatus`, `sourceHealth`, `sourceState` and `droppedReplies` |
| `src/app/views/settings.ts` | `settingsView`: each block with its revision, each Source's settings and Policy metadata, and the execution environment |
| `src/app/views/overview.ts` | `overview` and `evalsHealth`: problems, Tickets awaiting a person, load and a day's flow |
| `src/executor/dsh.ts` | `DshExecutor`, `WorkerSlots`, `ticketExecution`, `inputMessage`, `mandateInstructions` and `workerSessionId` |
| `src/executor/background.ts` | An Executor's background work: `runningJobs`, `untilQuiet`, `killJobs`, `collectJobs`, `stopSubagents`, `stopBackground`, `until`, `cancelled` |
| `src/infra/commands.ts` | `Commands`, `CliError`, `commandError` and `validItems`: the CLI transport, repo-limited and never printing arguments |
| `src/infra/environment.ts` | The shims, `worker-gitconfig`, `agentVariables`, `applyEnvironment`, `runAsWorker`, `verifyEnvironment` and `verifyDirectory` |
| `src/infra/health.ts` | `HealthBoard` and `HealthEntry`: one health entry per part, claimed by its single writer |
| `src/infra/paths.ts` | `packageRoot` and `packagePath`: find a packaged file from the source tree or from `lib/` |
| `src/infra/platform.ts` | `WINDOWS`, `pathKey`/`pathValue`/`pathEnv`, `shellCommand`, `spawnArgv`, `resolveExecutable` and `sameDirectory`: the one place a platform difference is answered |
| `src/infra/text.ts` | `IM_WORDS`, `NOTE_WORDS`, `wordCount`, `checkedImText`, `fill`, `sameName` and `escapeRegExp` |
| `src/sources/kind.ts` | The `SourceKind` protocol: configuration schema, form fields, Policy part, Channel, thread context, environment variables |
| `src/sources/registry.ts` | `SourceRegistry`: the installed kinds, the stored instances, the `SourceScope` implementation, and the Channel and context forwarding |
| `src/sources/host.ts` | `SourceHost`, `SourceContext`, `Health`, `health` and `HEALTH_TEXT` |
| `src/sources/poll.ts` | What polling shares: `POLL_HORIZON_MS`, `polled`, `cursorAt`, `pollThreads` and `pause` |
| `src/sources/github.ts` | The GitHub kind and plugin entry, exported as `./github-watch`: notification polling, receive-everything streams, the pull requests of open Tickets with their CI |
| `src/sources/github-trigger.ts` | GitHub Issues, pull requests, comments, reviews and CI changes as Triggers, with addresses and mention detection |
| `src/sources/github-pull.ts` | The pull request rules: `readPull`, `claimPull`, `observePull`, `pullsOf`, `pullOf` and `pullEndNotices` |
| `src/sources/github-channel.ts` | The GitHub Channel: `sendGithub` and `githubLink` |
| `src/sources/github-read.ts` | `readGithub`, `pullChecks`, `readRepositoryPath`, `githubThreadContext` and the CI summaries |
| `src/sources/feishu.ts` | The Feishu kind and plugin entry, exported as `./feishu-watch`: configuration, Policy part with chat sync, and environment variables |
| `src/sources/feishu-trigger.ts` | One rule that turns Feishu events, history pages and topic pages into Triggers |
| `src/sources/feishu-loops.ts` | The Feishu loops: the event consumer, history recovery, chat name refresh, subscribed-thread polling |
| `src/sources/feishu-channel.ts` | The Feishu Channel: `sendFeishu` and `feishuLink` |
| `src/sources/feishu-read.ts` | `feishuRead`, `readFeishu`, `feishuReferences`, `readFeishuLink` and `feishuThreadContext` |
| `src/sources/feishu-image.ts` | `admissionImageKeys` and `readAdmissionImage`: a message's images as attachments an assessment can see |
| `src/sources/admission-context.ts` | `threadWindow` and `admissionContext`: the bounded Thread window an assessment starts from |
| `src/client/index.tsx` | The client plugin entry: dictionaries, the sidebar icon, the main panel and the Plugin Manager config page |
| `src/client/app.tsx` | The panel shell: header, search, glossary, three tabs and the page of the current route; it shows the first-run guide while an installation is unconfigured |
| `src/client/provider.tsx` | `PanelProvider`, `usePanel`, `usePanelData` and `useAction`: panel context, polling and restart detection |
| `src/client/api.ts` | `caller`, `ApiError`, `usePoll` and the type aliases of the views |
| `src/client/route.ts` | `TABS`, `SETTINGS_GROUPS`, `parseRoute`, `initialLocation` and `remember` |
| `src/client/home.tsx` | Home: what waits for you first, then one line of status; the Executor counts fold away |
| `src/client/setup-wizard.tsx` | The first-run guide: repository, account, who may ask and the work directory, each step writing its settings block |
| `src/client/source.tsx` | The Source status and the Source settings cards |
| `src/client/trigger.tsx` | The Trigger status: Threads under a filter |
| `src/client/eval.tsx` | The Eval status (Decision log) and the Eval settings (Policy, admission table, assessment settings) |
| `src/client/git-repair.tsx` | The git repair on the Deployment page: the version running and the one needed, the command and its risk first, then a person confirms or does it themselves |
| `src/client/execution.tsx` | The Execution status, the pause control and the Execution settings |
| `src/client/thread.tsx` | The Thread detail page |
| `src/client/ticket.tsx` | The Ticket detail page |
| `src/client/settings.tsx` | The settings shell: group navigation and the current group |
| `src/client/settings-kit.tsx` | The building blocks of settings blocks: `useBlockDraft`, fields, the Source field renderer, the save history |
| `src/client/prompts.tsx` | The Prompts settings: the editor, the full prompt and the history |
| `src/client/prompt-config.ts` | Pure functions over a prompt configuration: sections, skills, overrides of built-in parts, and the line diff |
| `src/client/deployment.tsx` | The Deployment page, shared by the panel and the Plugin Manager |
| `src/client/draft.tsx` | Settings drafts: `draftReducer`, `merge3`, `saveBarText` and the save bar |
| `src/client/controls.tsx` | Local copies of the DSH controls (buttons, tags, switches, dialogs, tips); they read no context |
| `src/client/widgets.tsx` | The shared small widgets that read the panel context: sections, page heads, load states, times, links, Markdown |
| `src/client/rows.tsx` | The rows pages share (a Ticket, a Thread, a Decision) and the folding of runs of automated messages |
| `src/client/markdown.ts` | The Markdown subset of reports and questions, and linkification of bare addresses |
| `src/client/marks.ts` | The marks of the states the views classify: a Ticket's or a Thread's stage, a Source's state, a Decision's outcome |
| `src/client/text.ts` | Copy by key, and the wording of domain values, reasons, senders and times |
| `src/client/locales.ts` | All copy in both languages, and the glossary |
| `src/client/client.css` | The stylesheet, written against DSH's `--dsw-alias-*` tokens, one rule per line |
| `src/client/css.d.ts` | The type declaration for `?raw` stylesheet imports |

`src/sources/github.ts` and `src/sources/feishu.ts` are also the entries of the two Source plugins, built by `tsdown.config.ts` and exported in `package.json` as `./github-watch` and `./feishu-watch`. The bundle's `cordis.patch.yml` inserts the three plugins, with Feishu disabled.

## Tests

| Path | Covers |
| --- | --- |
| `tests/core-engine.spec.ts` | Every domain rule against the in-memory repositories: receive, Eval, fan-out, resume and stop, an interrupted Assignment, pause, Policy change, reports and results, attach, reply, failed delivery |
| `tests/stage.spec.ts` | Ticket stages and retry eligibility, row by row |
| `tests/policy.spec.ts` | The gate, the admission table, Mandate revalidation, the Policy version, settings migration and assessment outcomes |
| `tests/registry.spec.ts` | `SourceRegistry`: instances, validation, Policy parts, Channels, thread context and health claims |
| `tests/sources.spec.ts` | The Feishu and GitHub Sources: translation, polling and read cursors, pull request rules, health, starting and stopping the loops |
| `tests/commands.spec.ts` | `Commands`: accounts, error translation, repository-limited GitHub calls and `lark` for Feishu |
| `tests/feishu-read.spec.ts` | Reading Feishu originals, references and links |
| `tests/github-read.spec.ts` | Reading GitHub originals and CI checks |
| `tests/admission-context.spec.ts` | The Thread window an assessment starts from |
| `tests/feishu-image.spec.ts` | Feishu images read as attachments |
| `tests/assessment.spec.ts` | What `MasterAssessor` keeps for each Eval, and when it lets go |
| `tests/background.spec.ts` | An Executor's background jobs and subagents: waiting, collecting and stopping |
| `tests/bundle-patch.spec.ts` | The bundle patch parsed as DSH parses it, and the two presets it defines |
| `tests/effects.spec.ts` | The effect queue: coalescing, limits, backoff retries, health and shutdown |
| `tests/passes.spec.ts` | Passes: one at a time, coalescing requests, failures in the runtime health |
| `tests/outbox.spec.ts` | The Outbox: messages wait while paused or while a Source is uninstalled, and go out when it registers late |
| `tests/cache.spec.ts` | `TextCache` eviction order |
| `tests/queue.spec.ts` | The Runtime's work through the effect queue, and queues stored by an earlier version being adopted |
| `tests/followups.spec.ts` | A person's follow-up on a Ticket's Thread: the notice to the main Session, the Executor's judgement and hand-back, following for context |
| `tests/health.spec.ts` | One health entry per part, each cleared by its own next success |
| `tests/delivery.spec.ts` | Idempotent delivery in `AgentDelivery` |
| `tests/retry-health.spec.ts` | The projection of model-budget retries |
| `tests/role-models.spec.ts` | Resolving a role's model and seeding it |
| `tests/runtime.spec.ts` | The whole application on a simulated host, through the tools and HTTP |
| `tests/runtime-concurrency.spec.ts` | Overlapping work: Trigger arriving during a turn, Tickets changing during delivery and launch |
| `tests/tools.spec.ts` | The shape of both tool sets, role-scoped resource reads and routing validation |
| `tests/http.spec.ts` | Same-origin and loopback checks, the status of each kind of failure, body limits, path parameters and query |
| `tests/settings.spec.ts` | Saves racing a model or account check, Policy sync, pause and refusals |
| `tests/views.spec.ts` | What the views derive from the Store |
| `tests/timeline.spec.ts` | Thread pagination, neighbouring Triggers and timestamp normalization |
| `tests/migration.spec.ts` | The schema 11 migration: every record in the current shape, older schemas rejected |
| `tests/store.spec.ts` | SQLite and the in-memory repositories agreeing on order and rollback, `kv` keys spelled only in `src/kv.ts`, settings history |
| `tests/prompts.spec.ts` | Prompt validation, composition and versions |
| `tests/cards.spec.ts` | The rules the built-in text must state, file by file |
| `tests/model-surface.spec.ts` | Everything a model reads (tools, prompts, skills, inputs) against the schemas, the glossary and size budgets |
| `tests/deployment.spec.ts` | Plugin configuration, `resolveDeployment`, `resolveFeishuBot` and setup problems |
| `tests/environment.spec.ts` | The shims, `worker-gitconfig`, foreign files and directory checks |
| `tests/index.spec.ts` | The plugin entry: `Config`, `machineOf` and the restart callback |
| `tests/service-script.spec.ts` | `scripts/xenra-superagent` against fake `ps`, `tmux`, `dsh` and a fake health endpoint |
| `tests/client.spec.tsx` | The client plugin's registration, its polling and opening the main Session |
| `tests/navigation.spec.ts` | The three outcomes of `openKnownSession` |
| `tests/controls.spec.tsx` | The local controls' keyboard behaviour, and the panel importing types only with no cycles |
| `tests/panel-overview.spec.tsx` | The overview page |
| `tests/panel-source.spec.tsx` | The Source status and settings |
| `tests/panel-trigger.spec.tsx` | The Trigger status and the Thread page |
| `tests/panel-eval.spec.tsx` | The Eval status and settings |
| `tests/panel-execution.spec.tsx` | The Execution status, the Ticket page and the Execution settings |
| `tests/panel-settings.spec.tsx` | The settings groups, drafts, save bars and history |
| `tests/panel-prompts.spec.tsx` | The Prompts settings: editing, the full prompt, history and changed defaults |
| `tests/panel-deployment.spec.tsx` | The Deployment page and the Plugin Manager page |
| `tests/panel-panel.spec.tsx` | The panel's search, glossary, route memory and its fallback when the host is down |
| `tests/draft.spec.ts` | Draft state, the three-way merge and the save bar's line |
| `tests/prompt-config.spec.ts` | The pure prompt-configuration functions and the line diff |
| `tests/markdown.spec.ts` | The Markdown subset and linkification |
| `tests/marks.spec.ts` | The mark of each state the views classify |
| `tests/locales.spec.ts` | Both languages naming the same placeholders, and every error code and reason code worded |
| `tests/styles.spec.ts` | The stylesheet using only classes a component uses, one rule per line |
| `tests/class-docs.spec.ts` | A JSDoc block before every class in `src` |
| `tests/docs.spec.ts` | Consecutive numbering, language pairing, link direction and resolution, no conflict markers, and this document's two tables being complete |

`tests/fixtures/` holds the shared test rig: `host.ts` (a configured Runtime on a simulated host), `panel-server.ts` with `panel.tsx` (a fake management API answering by route, and panel rendering helpers), `deployment.ts` (a resolved deployment and machine settings), `git.ts`, `async.ts`, and `platform.ts` (the `POSIX` constant).
