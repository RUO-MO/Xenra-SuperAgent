# 003 Execution

[中文](003-execution.md) · English

This document follows an accepted Ticket through launch, delivery and recovery. It builds on [001 Domain model](001-domain.en.md) and [002 Authorization](002-authorization.en.md).

## Ticket stages

Each open Ticket has one stage, determined by what it is waiting for. Read the table from top to bottom; the first matching row wins.

| Stage | Condition | Panel label |
| --- | --- | --- |
| person / delivery | Delivering an Input to the Executor Session failed; it is retried after 2 seconds, then after a delay that doubles up to a minute, and a successful delivery, a new Assignment or the Ticket's end clears it | Input undelivered |
| person / answer | It has an Attention | Awaiting answer |
| person / review | The latest Report is `ready` | Awaiting review |
| person / blocked, failed | The latest Report is `blocked` or `failed`, and no person's message reached the Ticket since | Blocked · Failed |
| working / queued | No Assignment, or a pending one | Queued |
| idle | The latest Report is `waiting`, or the Assignment ended | Waiting for a Trigger |
| working | Everything else | Working |

A `person` stage means the Ticket cannot continue without human input. A new human message releases a `blocked` or `failed` Ticket to its Executor, so it moves to the next matching stage, usually `working`.

An `idle` Ticket has finished its turn without an outstanding question. A Trigger on a subscribed Thread can continue it.

## The Executor

Each Ticket gets an Executor Session named `worker-<ticket id>` and a directory named after the Ticket's short name followed by the first twelve characters of its id. Directories are created under the configured execution root, which defaults to `<stateDir>/work`.

Executor Sessions run as the operator's OS user under `danger-full-access`. They use the `xenra-superagent-worker` preset: DeepSeek Harness's `standard` preset with the tools a Ticket needs, and a shell that moves a foreground command to a background job after five seconds. That lets a worker take a new message at its next step instead of waiting for a long command, and a job's end wakes it in turn.

The main Session uses the `xenra-superagent-router` preset, with no persona: Xenra-SuperAgent composes its whole prompt. Its allow list holds six tools — `skill`, `read`, `read_image`, `job_output`, `job_list`, `job_kill` — and keeps only those the profile actually registers: a machine whose shell is `pwsh` has no `bash`, and a profile without the job service has none of the last three. It has no file write, file edit, shell or web tool. The preset still declares five-second shell and job waits, and a guard refuses `sleep`, a shell timeout above thirty seconds and a job wait above five.

A Session keeps the preset it was created with. If an Executor Session is deleted from outside, the next delivery recreates it under the same id.

An Executor's tools are this allow list, kept only for the names the profile actually registers: `read`, `write`, `edit`, `read_image`, `glob`, `grep`, `bash`, `pwsh`, `job_output`, `job_list`, `job_kill`, `web_search`, `web_fetch`, `skill`, `todo_write`, `subagent`, `list_subagent_models`, `send_message`, `list_agents`, `interrupt_agent`. The shipped preset enables web search but turns web fetch off, so `web_fetch` does not appear on such a profile; no other tool the profile has is kept either — anything that asks or shows a person something, changes configuration, schedules work, or edits documents is excluded. The restriction outlives the Ticket: once it ended, a tool call is refused with the note that new work needs a new Ticket.

A worker's subagents, nested ones included, run under DeepSeek Harness's `standard` preset with the worker's permissions and keep the same work tools; they are listed with `listDescendants` and released with `drainDescendants`, and a subagent's own jobs are killed when it ends. Under `standard`, a shell command moves to the background only after sixty seconds.

### Background work and worker slots

When a turn ends with its Report still `progress` and shell jobs or subagents still running, the Ticket keeps its worker slot and stays working. It is not reported as waiting, and the main Session receives no waiting report. A finished job or subagent wakes the Executor, and that woken turn looks again when it ends.

After each turn, background work has at most thirty minutes to finish. At that limit, shell jobs still running are killed and the Ticket is reported waiting. The report carries the Executor's last words and which jobs were killed, or that subagents are still running. Subagents may continue, and the next turn reads the killed jobs' results.

A handoff to a person frees the slot immediately and leaves the Report in effect: this applies after a `ready` Report or a question, unless an Input arrived since, and after any `blocked` or `failed` Report. At handoff the subagents are released; shell jobs — such as a server started for review — are left to that person and keep running until the Assignment ends. They hold no slot and are exempt from the thirty-minute limit, including after later turns. Their completion does not wake the Executor, which reads the results at its next turn.

A person can also start a turn by writing directly in the Executor Session; that turn's end and background work follow the same rules.

When an Assignment ends, its shell jobs are killed without waking the Session, and its subagents are released with any turns they wake dropped. The replacement Assignment and its waiting Inputs start after that shutdown finishes. Stopping or restarting the plugin takes the same path: shutdown waits up to ten seconds per worker, and Inputs not yet taken into Session history are retained.

### Preparing a Ticket directory

Before the first Assignment, if the Ticket directory does not exist, the prepare command runs once with `sh -c` in its parent directory (the execution root by default), with the Ticket's execution variables. It has ten minutes. A failed command removes an empty directory it left, fails the Ticket and records its output; the failure is not retried automatically, because an existing directory counts as prepared and a retry would take the failed command's leftovers as the workspace. A person's message, a retry or a status request tries preparation again.

Without a prepare command, the worker starts in an empty directory. A typical command creates a checkout with `git worktree`. The directory is then checked: if the repository's local or worktree git configuration defines `credential.*` or `http.*extraheader`, preparation fails, because the agent's git would read them too.

A pull request belongs to a Ticket when it is the pull request the Ticket came from, or when the agent account opened it from a branch whose last path segment is the Ticket's short name. Apart from the first case, one pull request belongs to at most one open Ticket.

### Concurrency

A Ticket holds a worker slot from the start of a launch — preparation included — or from the delivery that wakes its idle Executor, and it holds the slot throughout an active turn.

The configured limit (`maxWorkers`, 3 by default, settable from 1 to 16) applies to those slots, with one extra slot kept for a person's message. When every normal slot is busy, a person's message may use the extra slot and takes the next free slot ahead of new launches, so new work never blocks a person continuing an existing Ticket.

Other Inputs, CI results for instance, wait for a normal slot. A launch waits in `working / queued` until a slot frees. Launches run concurrently, so a slow prepare command delays only its own Ticket.

### Execution variables

The prepare command and the Executor instructions receive the same execution variables. The command reads them from its environment; the Executor reads each value and its description in its prompt. None of them holds a credential.

| Variable | Registered by | Value |
| --- | --- | --- |
| `XENRA_SUPERAGENT_DIR`, `XENRA_SUPERAGENT_NAME`, `XENRA_SUPERAGENT_TICKET` | Executor | The Ticket's directory, short name and id |
| `XENRA_SUPERAGENT_BLOCKED_COMMANDS` | Executor | Programs the execution environment forbids, separated by spaces |
| `XENRA_SUPERAGENT_GITHUB_REPOSITORY` | GitHub | The repository the Source watches, `owner/name` |
| `XENRA_SUPERAGENT_GITHUB_ACCOUNT`, `XENRA_SUPERAGENT_GITHUB_COMMIT_EMAIL` | GitHub | The agent account and its commit email |
| `XENRA_SUPERAGENT_GITHUB_NUMBER`, `XENRA_SUPERAGENT_GITHUB_PR_HEAD` | GitHub | The Issue or pull request that started the Ticket; for a pull request, also its head ref |
| `XENRA_SUPERAGENT_FEISHU_BOT`, `XENRA_SUPERAGENT_FEISHU_CHAT` | Feishu | The bot, and the chat that started the Ticket |

A Ticket's own values come from its directory and the Trigger that started it; the rest come from the current deployment settings. Only the panel may change the execution directory, the prepare command and the blocked commands; a main-Session text change is refused. A Source that is switched off contributes no variables to the execution environment, though the panel's variable table still lists them and marks the Source off.

The Executor reaches GitHub through the agent account's `gh` and Feishu through the bot's `lark-cli`; both names are redirected by wrapper scripts in the state directory to the configured CLIs. A blocked command fails when called by name, and `gh`, `git` and `lark-cli` cannot be blocked. Those wrappers, the isolated git configuration and the directories are defaults and guardrails, not a security boundary: an Executor can still execute a program by absolute path.

## Merging

Auto-merge is governed entirely by the **Delivery requirements** prompt section; the host holds no merge logic.

The default text forbids enabling auto-merge as the agent account, because GitHub records the merge under whichever account enabled it; it requires naming another account's CLI for merging. Without one, a person merges every pull request.

The default text allows auto-merge only on a pull request opened for the Ticket, once it is ready, the required approvals cover the head commit, and it changes fewer than 200 lines, additions plus deletions. The Executor withdraws auto-merge before pushing another revision, and enables it again once those conditions hold for the new head.

A review without a body, an approval for instance, still arrives as a Trigger and can wake an Executor waiting for review. Those instructions bind the agent, not GitHub's merge rules. To require approval, demand it in branch protection and dismiss stale approvals. Omit the merge CLI or delete the auto-merge paragraph to require a manual merge.

## How a Ticket ends

- **Ready with no followed Threads:** a `ready` Report ends the Ticket as completed.
- **Nothing left to do:** when the Executor finds no work for a person — the request does not reproduce, it is not a defect, the decision is already tracked elsewhere — it reports `dropped`. The Ticket ends silently, sending no message unless a matched rule asks for one; a person's later message on its Threads resumes it.
- **Stopped by a person:** Stop in the panel, or an explicit stop Decision, ends it as stopped and withdraws its Mandate.

### Pull requests

After the Executor reports, the Ticket follows the pull request it originally came from. It also follows each pull request the agent account opened from the Ticket's branch, whether the Executor reported it or the GitHub Source found it by polling. A reopened pull request is followed again; dropping the Subscription to a Thread stops following it too.

The Ticket completes once no pull request it opened is still open. If it opened none, every pull request it follows must have closed. It then ends as the last relevant close did, merged or closed, and keeps its Subscriptions so a later human comment resumes it.

A close does not end the Ticket while resumed, retried or resumed work is unfinished: if the Executor took up a follow-up and has not reported anything but progress, nor ended a turn after reading it, the close waits; if the Ticket resumed after the close, this Assignment must report `ready` first. A later `ready` Report then ends the Ticket under the same rules.

Chat channels receive a final notice of the pull request's outcome (GitHub channels do not, since the pull request shows it already). So "awaiting review" usually means a `ready` Report that came with a pull request.

### Follow-ups and context Threads

The Executor judges a person's follow-up that arrives on one of its Ticket's own Threads. It handles a request within scope, and hands back one that asks for more or belongs to another Ticket, answering and acknowledging nothing after the hand-back. Once no Executor owns the message it becomes a candidate for the main Session. Beyond that the main Session may only stop work when a person asks.

An Input counts as read once the Session took it into a step and a Report or the end of a turn followed. When a Ticket ends, unread messages it neither acknowledged, answered nor handed back return to Eval, as [002 Authorization](002-authorization.en.md) describes. A message read and needing no action, thanks for instance, does not.

A Thread followed only for context still delivers messages, but gives the Ticket no ownership of follow-ups and does not resume an ended Ticket. Those messages can be assessed independently.

While any open Ticket subscribes to it, a Source keeps polling a Thread, through two weeks after the later of its last Trigger and the end of its subscribing Tickets. After that, messages arrive only through the ordinary entrance: a GitHub notification or a Feishu live event.

## Failure and recovery

### Executor blocked or failed

When an Executor Session reports `blocked` or `failed`, or a launch fails or errors and is recorded `failed`, the Ticket takes no automatic input: CI and bot messages are recorded on it but neither delivered nor allowed to wake the Session.

A one-off model-service or network failure — an HTTP 408, 429 or 5xx, or a refused, reset or timed-out connection or unresolvable host — is retried at most three times: a failed worker turn is asked to continue after 15, 30 and 60 seconds, and a failed launch is retried through the stored-work queue (from five seconds, doubling up to five minutes) and then marks the Ticket failed. A failed prepare command is not retried.

Its tools stay available, so a person can continue directly in that Session. A failed launch does not retry on its own.

A person's message, a later Report that is neither `blocked` nor `failed`, or a retry lifts the hold. The hold is derived from stored Reports and Inputs, so it survives a restart.

### Retry

Retry is available while an open Ticket is `person / delivery`, `person / blocked` or `person / failed`: a new Assignment ends the current one, starts another in the same Executor Session, directory, branch and pull request, and takes the waiting Inputs — all three are solved by it. The main Session can perform the same operation on an explicit human request.

Once a person's message reached a blocked or failed Ticket, the Executor owns it, so the Ticket shows as working (queued when a failed launch restarts) and offers no retry — unless delivering that message itself failed.

An Executor model applies only when its Session is created; an existing Session keeps the model it had.

### Restart

A running Assignment ends as `hostRestarted`, and a new Assignment starts with a recovery note requiring the Executor to inspect its directory, git history and GitHub state before repeating any external operation, oldest Ticket first.

An Assignment that is waiting, ready, blocked or failed keeps its state, unless an Input arrived after that Report; then it starts again as well.

Sessions, directories, Subscriptions, queued messages and the stored work below all survive a restart, as does the record of which Inputs each Executor Session took into its history. A step records that once, after claiming a message and before calling the model: messages a restart cut off after taking them into a turn count as read once a Report or a turn end follows, while messages claimed but cancelled or cut off before entering history count as unread.

Retry or restart hands the new Assignment the Inputs the replaced one received that its Session never took in; a copy still waiting in the Session, kept by a restart or persisted across a crash, is removed ahead of the new Assignment's first message, so the new delivery is the only copy.

### Stored work

What Xenra-SuperAgent must do after deciding — relaying a candidate, a follow-up or a Report to the main Session, launching an Assignment, delivering an Input, sending a message — is written to a queue in the state directory before it runs. That write happens inside the core command's transaction, so a crash never leaves it half done.

A failed relay, notice, assessment delivery or Input delivery — one to an unreachable Session, for instance — is retried after two seconds, then after a delay that doubles up to a minute; a failed launch and a failed message start at five seconds and double up to five minutes. A launch that hits a one-off failure retries three times inside its own handling and then marks the Ticket failed; a paused write or a momentarily full set of slots is not a failure, and simply queues the launch again under its own backoff.

A kind of work reports an error in the overview's system problems only after three consecutive failures; a failed Input delivery shows on its own Ticket instead and takes no system space.

Relays to the main Session and notices to it keep their order, and a failed row holds back later ones of its kind; replies go out one at a time, in queue order. When the same queued message is requested again with new content it keeps its position in the queue.

### Source failure

The GitHub Source reads each Issue, pull request and Thread independently: a failed read leaves the error on that Thread, retries at the next poll, and counts toward the Source's errors — reported after three consecutive failed polls by default, with any successful poll resetting the count.

GitHub also answers 404 when the agent loses access to a private repository, so a 404 is retried.

A notified Issue or pull request whose reads keep failing is dropped a day after the first failed read, or at once when GitHub answers 410. It no longer makes polling fail, its Thread keeps the error, and the Source's status names it.

Its read position stays put, so a later notification or a poll of its Thread reads what the failed read missed.

The Feishu event consumer reports every failure; polling of subscribed topics leaves each failure on its Thread. A malformed entry in a GitHub listing or a Feishu page is skipped and counted in the Source's status.

### Channel failure

An outgoing message is queued as stored work and retried with a backoff from five seconds, doubling up to 300 seconds.

A Ticket's messages to one conversation go out in queue order, so its acknowledgement precedes a later answer or result: while an earlier message of the same Ticket to the same conversation has not gone out, later ones wait, until that one fails three times in a row and shows as a problem.

Messages of other Tickets, and messages of no Ticket, do not wait for it.

A message with a failed attempt counts as a system problem until it is sent or withdrawn.

A message is dropped only when its Source no longer listens to that conversation, or the Source answers that the conversation can never receive it. While a Source is off, the message waits. GitHub answers that way for a deleted Issue or a locked conversation, and Feishu for a recalled message or one it can no longer find. A reply to a review comment that no longer exists goes to the pull request's conversation instead.

A dropped message keeps a record of when and why it was dropped and which Ticket it belonged to, so it is never queued again; a dropped acknowledgement shows as dropped, not sent.

### Pause processing

Pause stops launches, new Evals, Eval timeouts, Input deliveries and replies; a launch already under way waits for processing to resume.

Sources keep recording Triggers, and a running Executor turn is not interrupted.

A person's message to an ended Ticket waits: the first pass after the pause resumes the Ticket, provided its Mandate still holds under the Policy at that time.

An Eval in progress does not expire during a pause; its deadline moves forward by the pause's length.

### Invalid configuration

Stored Source configuration its kind rejects disables that Source instance until the panel saves a usable configuration. The Threads, Tickets and read position it already produced are kept.
