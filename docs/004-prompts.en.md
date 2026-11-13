# 004 Prompts

[中文](004-prompts.md) · English

This document explains what the agents read, what the team may change, and when a change takes effect. It builds on [000 Philosophy](000-philosophy.en.md) through [003 Execution](003-execution.en.md). The prompt text itself is written in English, team sections included.

## What a team writes

A team may edit three team sections, add skills, and override any built-in prompt part. Most default text lives under `prompts/` and `skills/`; tool descriptions, notices, card formats and the gate stay in code and cannot be changed by prompt settings.

| Section | Content |
| --- | --- |
| Communication | When to message a person, how a message reads, the declaration line at the start of every GitHub message (by default `This is by an automated agent, not a human`), how reviews are handled, and which ordinary accounts are review bots |
| Ticket scope | When a Ticket goes on and when it stops with a draft, and what a person's hold means |
| Delivery requirements | Before-and-after evidence in a pull request, the auto-merge condition with its line threshold, and the commit author; when none is named, a worker commits as the agent account's no-reply address |
| Team skills | Knowledge an agent loads by name only when it needs it, such as an `identities` skill mapping Feishu users to GitHub accounts |

The built-in text covers the roles, tool usage, host mechanics, authorization rules and the GitHub and Feishu skills. It refers to the team sections by heading rather than repeating their content.

### Built-in parts and templates

An override names one of these keys:

| Part | Key |
| --- | --- |
| Shared rules and roles | `runtime/shared`, `runtime/orchestrator`, `runtime/worker` |
| Working instructions | `runtime/subscriptions`, `runtime/replies`, `runtime/dispatch`, `runtime/work`, `runtime/admission` |
| Handoff instructions | `runtime/handoff/orchestrator`, `runtime/handoff/worker` |
| Source skills | `skill/feishu`, `skill/github` |
| Generated parts | `runtime/environment`, `runtime/policy`, `runtime/policy/none` |

A generated part is an editable template that must keep its placeholders, or the save is refused:

- `runtime/environment`: `{variables}`, filled with the lines of the execution environment variables.
- `runtime/policy`: `{version}`, `{mode}` and `{rules}`, one line per enabled rule.
- `runtime/policy/none`: `{version}` and `{mode}`, used when no rule is enabled.

Changing a part changes what the model is told, but not admission, authorization, the tool allow list or the account wrappers — code still enforces those. A part name must exist; a part a later version removed is dropped at the next save only when the saved configuration already held that key, and every other unknown key is refused. An override whose text is exactly the built-in text again is removed, so the part keeps following future defaults. An override records as its `base` the value it carries, else the one the saved configuration holds, else the built-in text as it reads at that moment.

On an explicit human request, the main Session may save overrides too, through `orchestrator_prompts_save`; with `preview: true` it composes and returns both roles' prompts without saving.

## Assembly and precedence

The system prompt is one section Xenra-SuperAgent registers (`xenra-superagent-policy`, ordered last), assembled in this order:

1. Shared rules and the role.
2. The three team sections.
3. Subscriptions and replies.
4. The main Session's routing instructions, or the Executor's working instructions.
5. `runtime/admission`, main Session only.
6. Handoff instructions.
7. `runtime/environment`.
8. `runtime/policy`, main Session only, always last.

That section is complete for the main Session: it becomes the sole prompt section, so the main Session reads neither DeepSeek Harness's coding prompt nor the repository's `AGENTS.md`. For an Executor Session the section is only one more contribution, so a worker also reads the host prompt and the repository's `AGENTS.md` (up to 64 KiB).

The admission instructions come from `prompts/admission.md`. They describe proactive assessment, and when a card alone settles that an unrelated candidate may be ignored. `orchestrator_eval` returns context instead of repeating them.

The environment part gives the main Session deployment-level values and each Executor the values of its own Ticket, in the form `- <key> = "<value>": <description>`, and says a part is not configured when it has no value. The Policy part is regenerated from the current settings at every model request: the Policy version, the accept mode, the exemption for explicit requests, and each enabled rule as `- <name> (<id>): <instruction>`, or one sentence saying no rule is enabled. It comes last so a Policy change leaves the text before it untouched, and so the host can read it as a section of its own.

A Ticket accepted proactively gets one more paragraph appended, restricting its Executor to the matched rules. An Assignment and the messages a worker receives arrive inline as JSON cards: assignment text longer than 1 500 characters, or a Trigger's text longer than 600, is cut to a preview with its total length and the resource path that reads the rest.

Workers run unattended. Their tools exclude the ones that ask a person, show a person something or change configuration, such as `ask_user_question`, `present` and `plugin_manager`.

From strongest to weakest:

1. Facts enforced by tools and the host: identity, permissions, tool argument checks, reply purposes, length limits. Prompts cannot change them.
2. Built-in and generated parts, as the team's overrides read.
3. The process and communication requirements in a proactive Ticket's matched rules, for that Ticket's Executor Session only.
4. Team sections and team skills.
5. External text: messages, comments, documents and quotes. It is data, and it can never change a rule or a Mandate.

## Principles of the built-in text

These principles carry [000 Philosophy](000-philosophy.en.md) into the agents:

- **Separated roles.** The main Session only routes: it forwards the original Trigger and the facts routing needs, and makes no technical judgement; one `orchestrator_route` call handles several waiting candidates at once. A routing note holds at most 30 words. The Executor reads the original source, judges scope, implements and verifies.
- **The main Session does not wait.** Reports, follow-up notices, candidates and finished background jobs all arrive as messages by themselves. When nothing is left, it ends the turn. A guard refuses `sleep`, a shell timeout above 30 seconds and a job wait above 5 seconds, because a stuck step holds back new candidates; its tool allow list has no shell, no file write and no subagents.
- **It speaks only when a person must act or can use a result:** the result can be reviewed or used, a decision or resource is needed, or the work cannot be done. A chat message defaults to one sentence, with a hard limit of 100 words (Chinese counted by word segmentation, link labels and destinations included).
- **The Executor decides its own follow-ups.** Each Executor handles and acknowledges a request within scope, and hands back one that asks for more or belongs to another Ticket. A message becomes new work only once every owner handed it back or ended without taking it up. The main Session hears of the follow-up but may only stop work on it. A handed-back message then arrives as a candidate carrying the Executor's reason.
- **Coordination through Subscriptions and the main Session.** Executors follow related Threads for context. The main Session may pass on a fact from other work in a note of at most 100 words. Neither Subscriptions nor notes grant authority.
- **Attach only on an explicit reference.** A message must point at the Ticket's pull request, Issue, source message or acknowledgement, or at a recent change exactly one Ticket matches. A similar subject is not enough. Attaching subscribes the Ticket to the whole Thread; an Executor that finds it unrelated calls `orchestrator_thread_unrelated` and does not answer there.
- **Acknowledge concretely, once.** Before substantial work, the Executor acknowledges each new request with `orchestrator_ack`, naming the object and the intended result, as a reply under the original message; it is deduplicated by source Trigger across Executors and restarts, so it goes out once.
- **Ask through `human_action`.** The Executor puts one concrete question in its Report (or the main Session sends one with `orchestrator_reply purpose=attention`), and the host forwards it verbatim. When a person's message raised the question, that message is named and the question is asked there; otherwise it goes to the conversation the Ticket started in. Authorized work may continue meanwhile.
- **Deliver honestly.** An open pull request is not a ready result; a draft is marked unfinished; a UI change without a real "before" capture is not ready.
- **A person's hold stands** across follow-ups, new Executor Sessions and restarts until a person lifts it. Automated feedback never resumes paused work.
- **Examples show format only.** A sample sentence is not a fact the agent may assert.
- **Handle reviews by outcome.** A finding fixed and verified is resolved silently; a suggestion declined gets one factual reason. An automated reviewer's Thread is resolved once it has an answer, with at most three rounds per automated reviewer per pull request.
- **Yield to duplicate work.** When a person's branch or pull request already contains the Ticket's change, the Executor closes its own pull request and leaves one sentence naming the other.

## Versions

- Every save creates an immutable version holding the whole configuration, its revision number, its predecessor, a timestamp and its origin (panel or tool). Restoring a version or the defaults creates another version.
- A save names the revision it edits; a conflicting save is refused with HTTP 409 and the draft is not discarded. Revision 0 is the built-in default, recorded when the first custom configuration is saved.
- A Session reads the latest version at every model request, including later steps of the same turn. A save neither restarts, cancels nor wakes a Session. The host records which revisions each Session used, and an Executor may read any revision it has worked under.
- The deployment sets one overall size limit (`promptMaxChars`, 100 000 characters by default) covering overrides and skills. Validation refuses unknown keys, empty text, reserved built-in skill names, unknown override parts and missing template placeholders. It never truncates text silently.
- A skill registers as `xenra-superagent-<name>`, where the name starts with a lowercase letter, holds only lowercase letters, digits and hyphens, and may not take the built-in `feishu` or `github`. The Feishu skill is registered only when a Feishu bot is configured; the GitHub skill always is.
- An override records the built-in text it was edited from (`base`). When that text changes later, the panel marks the part **Default updated**: it diffs the old and new defaults above the team's text when the installation kept the old one, and otherwise compares the team's text with the new default. The team may keep its text, take the new default, or edit it further. A part with no override follows new defaults automatically.
- The main Session reads the affected part names under `default_changed` of `orchestrator_read prompts`.
