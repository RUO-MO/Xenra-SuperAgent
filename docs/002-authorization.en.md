# 002 Authorization

[中文](002-authorization.md) · English

Authorization decides who may start work and what that work may include. This document builds on [001 Domain model](001-domain.en.md) and describes the path that produces a Mandate: gate, assessment, Decision, and the conditions under which a Mandate stops holding.

The gate is enforced by code; prompt text cannot change it. Messages, comments and quoted documents are inputs to a judgement — they can neither raise its strength nor change an allowed list.

## Two paths for a Trigger

### Eval: deciding whether to start work

A Source records whether a message addresses the agent: `mention` when it mentions the bot or the agent account, `direct` for a direct message. A person's message is judged in this order, and the first rule that holds decides where it goes:

1. The sender is on the Source's allowed list and addresses the agent: an explicit request.
2. Its receiving scope's admission cell is set to explicit request: an explicit request, even when the sender is not on the list and even on a Thread that already has Tickets.
3. It arrives on a Thread that already has Tickets (a context-only Subscription does not count), and it is not a direct message from someone off the list: a follow-up, of explicit strength when the sender is on the list and inferred strength when not; in `off` mode only a person on the list takes this path.
4. Its admission cell is set to inferred candidate and the accept mode is not `off`: an inferred candidate.
5. Everything else is not admitted, with the reason code the gate gives: the sender is not on the Source's list (`not_a_member`), the admission table ignores it (`admission_ignored`), or it does not address the agent (`no_mention`).

Bots take a separate path: only a bot on the Source's bot list can make an inferred candidate, and only when it addresses the agent or arrives where the Source receives every message; any other bot's message is not admitted. A system event with no sender, such as a CI result, is checked only against the "not on the list, not addressing the agent" cell of its scope, and only while the accept mode is not `off`. A bot can never make an explicit request, and can never stop a Ticket.

"Receives every message" means the Source observed the message: a Feishu chat set to **All**, or the matching receive-all switch on GitHub. An unaddressed message enters the system only from such a scope, because the Source sends it from nowhere else.

### Subscriptions: continuing existing work

Every later message on a subscribed Thread reaches its subscribed Tickets as an Input, including messages from bots and CI. This path bypasses the gate and grants no new authority; each Ticket remains limited by its Mandate.

A person's message on a Ticket's own Thread belongs to that Ticket's Executor to decide, and takes no Eval. The same applies when the main Session attaches a message to a Ticket. While an Executor owns the message it can obtain no other Decision: accept, attach and requeue are all refused, and only a stop is allowed. The Executor either handles the request within the Ticket's scope or hands it back to be routed elsewhere.

Ownership holds while the Ticket is live, even if a person dropped its Subscription to that Thread. It also covers an ended Ticket that was not stopped by a person and has the waiting message that would resume it.

The main Session receives a follow-up notice listing the message and the Tickets it reached. While an Executor owns the message, the main Session may only stop work on the person's request.

### Handing back and releasing follow-ups

An Executor hands a message back once when it asks for work beyond the Ticket's scope or belongs to another Ticket, with one sentence of reason. The Ticket keeps its Subscription. If an attached Thread turns out to be unrelated, the Executor hands back the messages it holds there and then drops the Subscription; the Thread the Ticket started on, and a Thread a Source made it follow, cannot be dropped.

A message goes to a fresh Eval only once no Ticket still owns it, and its candidate carries the Executors' reasons. The gate judges it as an ordinary message on that Thread, and the main Session can accept it, attach it elsewhere or ignore it. Handing back a message the Ticket never owned — a bot's message, or one a person already sent to Eval — records the hand-back and queues nothing.

When a Ticket ends it releases follow-ups its Executor never read, and the person's messages it read but neither acknowledged, answered nor handed back. Each released message goes to Eval when no other Ticket owns it. A stop ends only the stopped Ticket's work, and the message that stopped it is not sent to Eval again; the main Session may accept the rest of that message as new work.

A person can send an owned follow-up to Eval from the panel. If the main Session then attaches it back to a live Ticket, the Executor receives it again.

### Context-only subscriptions

An Executor can follow a related Thread, such as another Issue or pull request, for context. Its messages reach the Ticket but grant no authority and carry no follow-up strength; a person's message there does not resume an ended Ticket unless the main Session attaches it. A note from the main Session about other work is context only as well.

A person's message that reaches no Ticket — including one on a Thread whose Tickets a person stopped — takes the Eval path. A bot's message takes that path regardless of whether it also reached subscribed Tickets.

## Strength

| Strength | Cases |
| --- | --- |
| explicit | A person on the list addresses the agent; a person on the list follows up on a Thread that already has a Ticket; an admission cell set to explicit request |
| inferred | A person not on the list follows up on a Thread with a Ticket; an admission cell set to inferred candidate; a message of a bot on the Source's bot list that addresses the agent or arrives where the Source receives every message; a system event with no sender landing on an inferred cell |
| not admitted | Any other bot's message, everything the admission table ignores, and every inferred case while the accept mode is `off` |

An inferred candidate can be accepted only in `auto` mode, and only with matched rules that are all still enabled. Under `observe`, a positive assessment is recorded as an ignore marked "would accept".

## The admission table

Each Source's part of the Policy has an admission table whose rows are receiving scopes:

- **Feishu:** each configured chat, other chats the bot receives mentions from, and direct messages. Other chats have a usable cell only when **Other chats** on the card is set to **@ only**.
- **GitHub:** new Issues, new pull requests, comments, and the default branch's CI.

A row has up to three cells, each deciding whether a message becomes an explicit request, an inferred candidate, or nothing:

| Cell | Choices | Default |
| --- | --- | --- |
| On the list, not addressing the agent | inferred, ignore | inferred |
| Not on the list, addressing the agent | explicit, inferred, ignore | ignore |
| Not on the list, not addressing the agent | inferred, ignore | ignore |

A cell is available only when the Source really receives that kind of message: with a scope set to @ only, its unaddressed cell cannot be chosen, and CI has no sender, so its row offers only the last cell. Bot messages use the bot list instead of these cells.

Setting "not on the list, addressing the agent" to explicit lets anyone in that scope request work by mentioning the agent, and the panel warns on that cell. It suits a dedicated support chat; on repository comments it means anyone who can comment can open a Ticket.

The admission table is part of the Policy version. Weakening a cell does not immediately stop open Tickets accepted under it; their Mandates can be revoked when they are revalidated before resuming.

### Bots and automated reviewers

The host recognizes logins ending in `[bot]`, GitHub Apps and Feishu bots as bots. A Source can list bots such as `dependabot[bot]` whose messages may become inferred candidates; such a bot can never make an explicit request or stop a Ticket.

An automated reviewer using an ordinary account counts as a person to the host: its comments reach subscribed Tickets and generate follow-up notices, so the prompt convention of at most three review rounds per automated reviewer per pull request does not constrain it automatically. Team prompt text must identify such accounts as automated reviewers; both the round count and the reason for declining a suggestion are enforced by prompt text only.

## Routing candidates

The main Session routes explicit candidates with `orchestrator_route`. One call carries at most twenty items, each processed independently: a refused item or a missing field does not stop the others. An item is one of:

| Kind | Needs | Effect |
| --- | --- | --- |
| `accept` | `trigger_id`, `title`, `worktree_name`, `acknowledgement` | Records an accept Decision on the Trigger and creates its Ticket; a Trigger that already started a Ticket returns that Ticket, keeping its title and acknowledgement |
| `attach` | `trigger_id`, `ticket_id` | Attaches the Trigger to the Ticket: the Ticket subscribes to its Thread and receives it as an Input, and the Eval holding it ends, with the rest of its batch going to a fresh Eval |
| `stop` | `trigger_id`, `ticket_id` | Ends the Ticket only when the gate gave explicit strength; otherwise it is recorded as ignore |
| `ignore` | `trigger_id`, `reason` | Records an ignore, which may dismiss a proactive candidate its card alone settles |

`worktree_name` is one to four lowercase English words, at most 32 characters; `acknowledgement` is one sentence of at most one hundred words in the language of the source conversation. Accept and attach may carry a routing note of at most thirty words (Chinese counted by word segmentation).

An inferred candidate normally needs a full assessment: `orchestrator_eval` loads its window, `orchestrator_eval_read` reads further into the Thread, an image or a repository file, and `orchestrator_eval_decide` records the judgement. There is one shortcut: when the card itself shows the candidate touches no enabled rule, `orchestrator_route` may ignore it directly, and the Decision records `ignoredFromCard` to distinguish this from a rule assessment.

Accepting an inferred candidate always requires an assessment. A direct accept of a Trigger the gate did not admit as explicit is refused.

## Accept mode and rules

The accept mode is part of the Policy:

| Mode | Effect |
| --- | --- |
| `off` | Nothing inferred becomes a candidate: no unaddressed message, no bot's message, no follow-up from a person off the list |
| `observe` (default) | Inferred candidates are assessed; a positive assessment is recorded as an ignore marked "would accept", and nothing is accepted |
| `auto` | A positive assessment of an inferred candidate accepts it |

Explicit requests work in every mode. Start in `observe` and switch to `auto` once the recorded Decisions look right.

Each rule describes one kind of proactive work, with a name and an instruction of at most two thousand characters. An assessment judges every enabled rule exactly once, matched or not; an accept needs at least one matched rule, while an ignore or an unavailable records the judgement of every rule. A Ticket's Mandate records the matched rules, and its Executor receives their names and instructions, whose procedure and communication requirements take precedence over the defaults for that Ticket. Requirements that apply to every Ticket belong in the team prompt sections.

An assessment must also state a direction: whether implementation was requested, whether the target is specified or an existing standard, whether a design decision remains open, and the source text that supports those claims. An unsettled direction, or one that requires a design decision, turns an accept into an ignore.

## Policy version

Rules, accept mode and each Source's part of the Policy together form the Policy version: a content hash over those three, whose inputs carry the revision marker `mandate-v3`. Every Mandate records the version it was accepted under. Models, concurrency, pause state and polling intervals are not part of it: changing them invalidates no existing Decision.

A version change invalidates running Evals — they end `unavailable` and queue their own Triggers again immediately under the new version. It also sends a policy-changed Input to each affected live Ticket, explaining whether:

- a matched rule changed, with its current instruction, or no longer applies;
- the requester may no longer start work; or
- proactive work is no longer accepted, for example because the mode left `auto`.

Unaffected Tickets receive no notice. The change does not revoke a live Ticket's Mandate at once; it bears on later judgements and on resuming.

Source configuration is separate from the Policy. It controls what enters the system: which chats are read, and whether a scope receives every message or only mentions. A Mandate records its Source and receiving scope. Resuming needs the Source still to listen to the Thread, but not to receive every message there.

Replies wait while their Source is off, and are dropped when the Source no longer listens to their destination.

A condition on what the Executor may do with its own result — such as when it may merge — does not decide who may authorize work. It is prompt text, not Policy.

## Resume and stop

An ended Ticket keeps its Mandate. A person's message on one of its own Threads resumes the same work without a new Eval or Decision, whoever sent it. Bots, CI and context-only messages do not wake an ended Ticket. The Executor decides whether the request fits the scope, and hands it back or ends the round if it does not.

Only three operations change a Mandate: an accept creates it, a person's stop withdraws it, and failed revalidation revokes it. A Ticket stopped by a person stays ended and receives nothing; work requested there needs a new accept.

- **A person saying "stop" in a Thread is an ordinary Trigger,** and Eval decides whether to stop; without explicit strength it becomes an ignore. An Executor cannot declare that a person asked it to stop — it can only hand the message back.
- **Stop in the panel is a command.** It acts on the Ticket directly, is recorded as a manual stop, and needs no new Eval.
- **Waiting conditions belong to Sources.** A condition such as "no assignee for N hours" would be a Source that waits and checks again itself; Eval never waits.

### Revalidation before resume

The Source must still listen to the original Thread, or the Mandate no longer holds. The remaining checks depend on the Mandate's basis:

- An explicit follow-up Mandate passes.
- An inferred follow-up Mandate needs `auto` mode and its matched rules still enabled.
- A Mandate admitted through a table cell must still receive at least its original strength under today's table and sender membership. Removing a sender from the list can therefore revoke a Mandate accepted through the listed-sender cell; adding a sender moves the "not on the list, not addressing the agent" cell to "on the list, not addressing the agent" and then continues the checks.
- A bot's Mandate requires the bot to remain on the Source's bot list. Inferred table and bot Mandates also need `auto` mode and matched rules still enabled.
- Other Mandates require the sender to remain on the Source's allowed list.

When revalidation fails, the Ticket stays ended and takes none of its waiting messages. Each message is treated as having reached no Ticket; if no other Ticket owns it, it goes to Eval. The main Session is not told it reached a worker. The same holds after a processing pause. Attaching to that Ticket is refused, and further work needs a new accept.

## When Eval does not finish

The time limit counts from the candidate's delivery to the main Session: one hundred twenty seconds by default, settable from thirty to six hundred. Time spent waiting for delivery does not count, and an undelivered candidate never expires.

An Eval past its deadline queues its Triggers for another attempt; after two such attempts in a row, the third expiry records `unavailable` with the timeout reason. An assessment that reports `unavailable` itself, a judgement made under an outdated Policy, and an Eval invalidated by a Policy change are recorded `unavailable` too; the Policy cases queue the batch again under the current version at once.

The `evals` health entry reports unresolved `unavailable` Decisions from the last hour whose Thread has had no later judgement, and `scripts/xenra-superagent status` includes that error. The overview lists these unfinished Evals individually over a twenty-four-hour window.

The overview asks for human attention only while an unavailable Decision is still the latest Decision on its Thread, has not been dismissed, and its Thread is neither queued nor evaluating. A person can evaluate the Trigger again, or dismiss the problem.
