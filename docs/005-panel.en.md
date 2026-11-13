# 005 Panel

[中文](005-panel.md) · English

Open **Xenra-SuperAgent** in the DeepSeek Harness Web sidebar (the hammer icon, placed near the top of the sidebar panel list) to supervise the agent. The panel has three tabs only — **Home**, **Tickets**, **Settings** — each answering one concrete question, with everything finer folded inside them. This document builds on [000 Philosophy](000-philosophy.en.md) through [004 Prompts](004-prompts.en.md).

The panel touches no state directly: it reads and writes through a management API bound to the loopback address only (`/orchestrator/api/`), and each request carries a same-origin marker, so another program beside the page cannot use it to change configuration or stop a Ticket. The host registers those routes before it runs the deployment check, so the panel opens even while setup is failing.

## The three tabs

| Tab | Question it answers | Shows |
| --- | --- | --- |
| Home | Does anything need me now? | One line of status, system problems, the Tickets waiting on you, and a folded block of Executor counts and links to the two diagnostic views |
| Tickets | How far has one piece of work got? | The Executor's state, the pause control, Tickets filtered by stage, and one Ticket's detail page |
| Settings | What rules does it work by, which account acts, and in which directory? | Sources (status and cards), Eval, Execution and Prompts, plus **Threads and Triggers** and **Assessments** under the **Advanced views** heading |

The header always carries four things: the title, the search box, the glossary (?) button, and **Open main Session**; that button is disabled until the main Session exists. The panel polls every 5 seconds and backs off to six times that interval while the document is hidden; the current route and settings group are kept in session storage, so a reload returns to the same place.

## Home

Home answers "does anything need me" top to bottom, in a fixed order:

1. One line of status.
2. **System problems**, only when there really are some, each with the action that deals with it.
3. **Pending Tickets**, the ones waiting for your answer or your review.
4. **Executor**, folded by default.

The status line has four forms: "Running normally; nothing waits for you." when all is well, "{count} Ticket(s) wait for you." when work waits on you, "Processing is paused, so new requests do not start." while processing is paused, and "Setup still needs to be finished before work can start." while the deployment is unconfigured. A setup problem and a pause each outrank the other two.

### System problems

| Problem | Meaning and action |
| --- | --- |
| Deployment check failed; xenra-superagent takes no work | The startup check failed, with where to fix it and **Check again**; the title opens the settings that fix it (a Source card, or Deployment). A failed Feishu bot check reads "Feishu bot check failed; the Feishu Source is paused" and pauses that Source alone |
| No Source is running; no Triggers arrive | Every Source is off or not installed; **Turn on a Source** opens Settings › Sources |
| No one may originate work: the lists on every Source are empty, so no request can become a Ticket | **Add senders** opens the lists under Settings › Eval |
| Processing paused: no new Evals, Assignments or replies | Carries **Resume processing**, which resumes after confirmation |
| {source} Source failing | One of a Source's health entries reports an error, with its detail and a note; the title opens that Source's card under Settings › Sources |
| {name} failing | A health entry such as `runtime`, `models` or `worker` reports an error, with its raw detail; `evals` is not here, the next row lists it one by one |
| Eval overdue: {thread} | An Eval on a Thread is past its deadline; the title opens that Thread |
| Eval unavailable: {thread} | An unavailable Decision from the last hour with no later judgement on its Thread, with **Evaluate again** and **Dismiss** |
| {source} reply failing (retried {attempts} times) | A message to one Source keeps failing, with its attempt count and error; the title opens the matching Source card |

### Pending Tickets

**Pending Tickets** lists the Tickets in the `person` stage. Each row carries its stage label (Awaiting answer, Awaiting review, Blocked, Failed, Input undelivered), the Threads it follows, the count of undelivered Inputs, and a note or the question verbatim; the title opens the detail page. The actions that apply are **Answer in {source}**, **Retry**, **Open Session** and **Stop**, and each appears only when it does apply. The section heading carries the count; when there are Tickets it also offers **See all Tickets**, which opens the open list on the Tickets tab. With no such Ticket it shows one line: "No pending Tickets.".

### Executor

The **Executor** disclosure holds how this machine runs: **Executing** (Executor Sessions in an active turn over the concurrent-Ticket limit), the **Queued** count and the count of Tickets **Waiting for a Trigger**. The first two link to Open on the Tickets tab, the last one to Waiting for a Trigger. At its foot sit the entries to the two diagnostic views, **Threads and Triggers** and **Assessments**. While the deployment is unconfigured, the three counts give way to one line, "Executor waiting for the deployment check".

## Tickets

The first line of the Tickets tab is the Executor's state: **Executor running**, **Processing paused** or **Executor waiting for the deployment check**; once the deployment check passes it also gives **Executing** (running / limit) and **Queued**, with **Pause processing** or **Resume processing** on the right, each behind a confirmation. The (?) beside the "Status" title explains what the page is for, and **Settings** on the right opens Settings › Execution.

Below it the filters run by stage: **Open** (the default, every Ticket that has not ended), **Pending**, **Working**, **Waiting for a Trigger**, **Ended**. Each row is one Ticket: its stage label (Awaiting answer, Working, Waiting for a Trigger, or an ended Ticket's outcome such as Completed, Pull request merged, Stopped by a person), the Threads it follows, the undelivered count, a time or the question verbatim, and the applicable **Answer in {source}**, **Retry**, **Open Session** and **Stop**. **Waiting for a Trigger** explains at the top that the Executor ended its turn without asking anything, and that a new Trigger wakes these Tickets. A page longer than the limit offers **Load more**.

### One Ticket

Opening a Ticket goes to its detail page. The page header holds the title, a back button to the previous step, and the applicable **Open on {source}**, **Retry** and **Open Session**.

The status line gives the stage, the **Mandate** strength, **From** (Source and sender) and **Updated**; an ended Ticket adds a line with its outcome, such as "Pull request merged", "Nothing to do" or "Stopped by a person". An **Attention** question appears verbatim in a banner at the top, with **Answer in {source}**; a report that failed or blocked shows its summary in a banner, and a failed delivery of an Input gets a banner of its own.

The **Mandate details** section gives the Decision, its reason, the rules that matched and those that did not, the assessment direction with its evidence, then the scope, the facts it rests on (sender, how it was admitted, receiving-scope cell, accept mode, matched rules) and the Policy version; the Policy version opens the history under Settings › Eval. Undelivered Inputs get a section of their own, explaining whether they wait for delivery, wait behind a pause, or failed and need a retry. A subscribed-Threads section lists the Threads this Ticket follows.

Everything else folds below the immediate actions: the Assignment list with each Report and its span, which appears only once a Ticket has more than one (after a resume or a handoff), the execution environment variables, the Channel links, the delivered Inputs, and identifiers such as the Ticket id and directory. The bottom holds the destructive **Stop** zone.

## Settings

The settings page carries navigation on the left and a form on the right. The navigation lists four everyday groups first — **Sources**, **Eval**, **Execution**, **Prompts** — then an **Advanced views** heading holding **Threads and Triggers** and **Assessments**. Each settings block has one save bar, visible only while a change exists, a save runs or a save fails; a draft survives a reload and is merged three ways against someone else's save.

- **Sources:** the group opens with each Source's status, then the cards that configure it — "why did nothing happen" and "which repository is it watching" are two questions about one Source, so one page answers both. The status section's "Status" title carries a (?) explanation, and each row gives its state (Running, Starting, Pending, Failing, Off, Plugin not installed, Waiting for the deployment check), its **Arrived in 24 h** and filtered counts and its **Latest** time; a configuration problem says what is missing and offers **Open settings**, which jumps to that card. Two disclosures appear only when their count is non-zero: **Latest Triggers filtered in the last 24 hours** (sender, content, reason, time) and **Not sent in the last 24 hours** (the conversation can no longer receive them, or the Source no longer listens to it). A deployment-level problem shows at the top of this section, with **Fix it**.
  Each card has its switch, fields, verified account facts, folded **Advanced** fields and the note that saving restarts the plugin; when a changed field affects the deployment check while Assignments run, the save bar warns that this interrupts them. GitHub offers the **Repository**, the **Agent GitHub CLI**, the four receive switches for new Issues, new pull requests, comments and default-branch CI, with the **Polling interval / seconds** and **Failed polls before reporting an error** under Advanced; Feishu offers the **Bot lark-cli**, the **Chats** (each @ only or All, with **Refresh chats**), **Other chats**, **Direct messages**, and **Messages per page** with the original message's link time limit under Advanced.
- **Eval:** the Policy version (first 8 characters) and the accept-rule list, where rules can be added, duplicated, enabled, disabled, removed and reworded; then a tab per Source under **On each Source**, with the accounts that may originate work, Feishu's **Sync chat** and **Sync now**, the bot list and the admission table; then the Eval settings: the accept mode, the time limit of one Eval and the assessor model. **Sync now** is available only while nothing is unsaved and a sync chat is named.
- **Execution:** the Executor model, **Concurrent Tickets**, the **Ticket directory root** (empty means `<stateDir>/work`, and the field names the path actually in use), the **Prepare command**, a folded **Available variables** table (choosing a key inserts `"$key"` into the prepare command at the caret) and the **Blocked commands**.
- **Prompts:** **Edit** changes the three team sections, the built-in parts and the skills; a built-in part can be reset, a template lists the placeholders it must keep, and an edited part is marked changed. **Full prompt** shows the assembled text per role and skill, compares it with the saved text or the defaults, and can copy all of it. **History** lists the versions, the parts each changed, restoring a version or the defaults, and the revision each Session is using.
- **Deployment:** this group has no entry in the navigation on the left — a person needs it only when the deployment check fails, and a system problem on Home points straight at it; DeepSeek Harness's plugin manager also opens this plugin on the same form. The page starts with any startup problem and **Check again**, then a **This machine** section (**State directory**) and a **Limits** section: the **Largest prompt configuration / characters**, the **Thread pages one Assessment may read** and the **Time limit of one context read / ms**. A saved limit applies at once, without a restart; the state directory must be an absolute path, and changing it remounts the plugin on the new directory, which the page says. The Plugin Manager copy also lists the repository, agent account and Feishu bot derived from the Source settings; where DSH serves no writable form, or the browser is not on this machine, those fields show read-only.

### Advanced views

**Threads and Triggers** and **Assessments** used to be two top-level tabs; they now live inside Settings, because they answer "why" and are needed only while investigating. Opening one leaves none of the everyday groups highlighted while the top navigation stays on **Settings**; choosing an everyday group leaves them.

- **Threads and Triggers** opens with the "Status" title and a sentence, then filters Threads by **Subscribed** (the default), **Evaluating**, **New Triggers in 24 h** or **All Threads**. Each row gives its stage (Subscribed, Eval running, N queued, Tickets ended, Not subscribed, Polling failed), the latest Trigger, which Ticket it fans out to and a time; the title opens the Thread page, and hovering the title shows a polling error.
- **Assessments** filters Decisions by **Accept and reopen** (the default), **Stopped**, **Ignored**, **Unavailable** or **All**, and can restrict them to "Triggers from the last 24 hours only". Each row shows the outcome, the reason, the matched rules and the time; opening it goes to its Ticket, or to that Trigger inside its Thread. An ignore that observe mode would have accepted carries its own label. While processing is paused, the top says that new Triggers are recorded but not evaluated.

### One Thread

A Thread page shows its Source, latest and creation times, a link to the original, the Eval in progress (Trigger count, strength, deadline), any polling error, its subscribed Tickets, a folded list of Decisions, its correlated Threads, and the Trigger timeline newest first.

Each Trigger carries disposition tags: queued for Eval, Eval running, filtered with its reason, a Decision unless it was an ignore, delivered to a Ticket, or fanned out to N Tickets; a handed-back message names the Ticket and why. A person's Trigger offers **Evaluate again** when no effective judgement covers it: the Source filtered it, its Eval was unavailable, an Executor still owns it, or it reached a Ticket and nothing decided it. Automated messages from one sender in a row fold into a single row showing only the newest.

While Tickets subscribe to it, the bottom of the page offers **Unsubscribe**: after confirmation it discards every Ticket's Subscription to the Thread, so new Triggers stop fanning out until the next accept or attach. This page carries only two writes: sending one Trigger to Eval, and unsubscribing.

## The first-run guide

While an installation is unconfigured, the panel body is replaced by the first-run guide and the three tabs are hidden; the header's search, glossary and **Open main Session** stay. It appears when the GitHub Source names no repository, its agent CLI is empty, or that Source's Policy list is empty. Deployment-level and Feishu bot problems — git too old, the environment failing, a bot identity not configured — are not among these three steps, so they neither trigger nor block the guide and still show as system problems on Home.

The four steps build on each other, the current one open and the others showing only their number and title:

1. **Repository and account.** The repository is written `owner/name`, for example `octocat/Hello-World`; the agent CLI's command name or path comes next, for example `gh-agent`, and the agent acts as the account it is signed in to, with its commits and comments appearing under that name. **Both are saved together**, because the GitHub Source validates the repository and the account as one unit (`SETUP_FIELDS.github`): it immediately uses that CLI to confirm the account can push to that repository, so a save carrying only one of them fails. **Next** is therefore enabled once both are filled.
2. **Feishu, if the team asks there.** When the team raises requests in Feishu chats, this step fills the bot's `lark-cli` into the Feishu Source's card. With GitHub alone, **Not now** skips it without writing anything: the Feishu Source is on by default and stays idle without a CLI, so GitHub work is unaffected. When this profile leaves the Feishu row off, the step says a CLI here would not work and offers only to skip.
3. **Who may ask.** The repository saved in the first step is shown first, then one GitHub account is added to this Source's list; yourself is enough to start.
4. **Where work happens.** One directory per Ticket; leave it empty for the default location, or name the parent of an existing clone to work there.

The first step writes the GitHub Source, the second writes the Feishu Source (or nothing, when skipped), the third writes the Policy, and the fourth writes the Executor. **Next** or **Finish** saves at once, so closing the page halfway loses nothing; when a save restarts the plugin the panel says it is restarting and reconnects by itself. **Back** returns to the previous step. A refusal is shown below the step that caused it and stays on screen, rather than appearing as a toast that vanishes. At the foot are two links, **Skip and configure later in Settings** and **Open Settings instead**, which dismiss the whole guide; the second step's **Not now** only skips that step.

## Routes and older links

The panel remembers where you are in session storage, so a reload returns to the same place. A name an older version stored still opens the view it meant: Overview opens Home, Execution opens Tickets, Source opens Settings › Sources, and Trigger and Eval open the same Thread list and Decision record as **Advanced views**, with the top navigation left on Home because those views no longer have a tab of their own. A filter the page no longer has is dropped, leaving the default view.

## Search

The header search finds Triggers by text, id, Feishu message id or a stored link such as a GitHub comment URL, up to 20 of them; a Feishu link missing from the original message becomes searchable only after the host has read it during the current process lifetime. The same search finds Threads by references such as `#12` or a GitHub URL, and Tickets by title or by a matching Thread (up to 10).

Results group Tickets, Threads and Triggers in that order and report how many of each were found; when Triggers hit the cap of 20, the line asks you to narrow the search instead. A filtered Trigger has no Thread, so it shows its filter reason instead of a link.

## Glossary

The (?) in the header opens the glossary: a two-language table grouped by roles, Source settings, Threads and Triggers, Assessments and Tickets, plus a legend of status colors (done, running, waiting, failing, ended) and a two-column list of each state's values. It follows the glossary of [001 Domain model](001-domain.en.md) and is what the panel and the documents agree on.

## Localization

The panel uses DeepSeek Harness design tokens and controls, and follows the host language, Chinese or English. The interface shows one language at a time; documents, code and tool names use the English terms, and the glossary sets both side by side.

## Destructive actions

An action that needs confirmation first explains its consequence in a dialog, then **Confirm** runs it and **Cancel** closes the dialog.

| Action | Where it appears | What the confirmation says |
| --- | --- | --- |
| Stop | Home, the Ticket list, the foot of a Ticket page | The current Assignment ends and its Session and directory stay; stopping withdraws the Mandate, so later messages on its Threads do not resume it |
| Retry | Home, the Ticket list, the page header of a Ticket | Ends the current Assignment and starts a new one; Mandate and Subscriptions stay |
| Unsubscribe | The foot of a Thread page | New Triggers stop fanning out to Tickets until the next accept or attach |
| Pause processing / Resume processing | The Tickets tab, a system problem on Home | While paused, Sources keep recording Triggers but no Evals or Assignments start and no replies are sent; resuming continues |
| Check again | A system problem on Home, the Deployment page | Asks first only when Assignments run: it restarts the plugin and interrupts them |

Other changes take no confirmation but do state their consequence: a Source field that affects the deployment check restarts the plugin, and a new state directory remounts it. **Dismiss** only puts one unavailable Eval away and is not destructive.

## Principles

1. **Focus on what matters.** Every element answers the question of one of the three tabs, or it is removed. A number appears only when it changes what the supervisor does.
2. **Precise definitions.** Categories have checkable definitions, are mutually exclusive and cover every case, as the Ticket stages do. A label says whom a row waits for and what it needs, not an internal status code.
3. **One place per concept.** Tickets belong to Tickets; Sources, rules, the execution environment and prompts belong to Settings; Threads and Triggers and Assessments belong to Settings › Advanced views. Home summarizes these and links to them instead of becoming another detailed view.
4. **Domain structure.** The panel uses the domain terms. Internal identifiers appear only in folded details, and names replace identifiers where they can be resolved.
5. **Honest state.** A count equals the length of the list it links to: the number on the system problems heading is the number of rows it lists, and so is the count on Pending Tickets. No state contradicts another fact.
6. **Quiet by default.** Healthy states take no extra space, and the Executor counts fold into **Executor**. Problems must be actionable; a one-off network error is not enough. Rows needing a person offer their action directly. Keep page explanations to one sentence and put further detail in the (?) tooltip.
7. **Consistent controls.** Use DeepSeek Harness design tokens and control behavior. The same information should look the same throughout the panel. Each settings block has one save bar, and every destructive action asks for confirmation.
