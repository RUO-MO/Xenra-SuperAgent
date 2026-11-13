# 006 Deployment

[中文](006-deployment.md) · English

This guide covers operations: what runs on a machine, which accounts it needs, how to install it, how to start and stop it, how to upgrade it, and where to look first when something breaks. For concepts, read [001 Domain model](001-domain.en.md) through [005 Panel](005-panel.en.md); this document only puts them on a machine.

## What runs

Xenra-SuperAgent ships as a DeepSeek Harness bundle. Its `cordis.patch.yml` inserts three plugin rows and two agent-preset rows into a profile's entry list, and otherwise leaves the host alone.

### Plugin rows

| Entry id | Plugin | Loads |
| --- | --- | --- |
| `xenra-superagent` | `xenra-superagent` | The application itself: Store, Engine, Source registry, Executor, management routes and the panel |
| `xenra-superagent-github` | `xenra-superagent/github-watch` | The GitHub Source kind and its polling loop |
| `xenra-superagent-feishu` | `xenra-superagent/feishu-watch` | The Feishu Source kind and its loops, on by default and idle until it has a bot CLI |

The bundle supplies all three rows; a profile's `cordis.patch.yml` only has to give the main row a `stateDir`, as "Machine configuration" describes.

The main plugin injects the host's `agents`, `sessionController`, `sessionPersistence`, `workspaceRegistry`, `permissionPresets`, `tools`, `systemPrompt`, `skills`, `webServer`, `llm` and `subprocess`, and turns off the DeepSeek Harness generated settings page, because the panel brings its own settings interface.

### Agent presets and Sessions

The bundle inserts two `@deepseek-ai/dsh-agent-preset` rows as well, defining the two presets this application uses:

| Preset id | Name | Who runs under it |
| --- | --- | --- |
| `xenra-superagent-worker` | Xenra-SuperAgent 执行器 | Every Ticket's Executor Session, whose id is `worker-<ticket id>` |
| `xenra-superagent-router` | Xenra-SuperAgent 主 Session | The main Session, whose id is stored under `KV.runtime.masterId` and derived from `stateDir` on first start |

Both appear in the DeepSeek Harness preset list, and no setting hides them from the picker, so their names and descriptions say whom they are for. Do not select them for personal Sessions, and do not delete the rows: a Session records the preset id it was created with and looks that id up when it resumes, so a missing preset fails the resume with `agent-preset/not-found`.

The presets differ in two ways. In tools: an Executor Session gets files, search, the shell and its jobs, the web, skills, its todo list and subagents, while the main Session gets only `skill`, `read`, `read_image` and the three job tools, with no shell, writes, search or web. In the role prefix: the worker carries a persona, `You are a coding agent powered by the {{model}} model.`, and the main Session has none, because its prompt is complete on its own (`complete: true`). Both presets move a foreground shell command and a job wait to the background after 5 seconds, so a long command does not hold back the next step. When the Web UI opens a new, empty Session, the host may select the profile's default preset first; before the first turn, `Sessions` selects the role's preset back.

### Permissions and isolation

Sessions created under either preset run as the operator's OS user and are set to `danger-full-access`. Nothing the application writes is a security boundary:

- The shims in `<stateDir>/worker-bin` make `gh` and `lark-cli` act as the agent and make blocked commands fail by name; calling one by absolute path still runs it.
- `<stateDir>/worker-gitconfig` points only the github.com credential helper at the agent's CLI; it constrains where configuration comes from, not the process.
- **It does not change any git configuration your machine already had.** Every write stays inside `<stateDir>`: it does not touch your global `~/.gitconfig`, the system configuration, or any repository's own configuration, and it writes nothing into the host process's environment. Credentials for other hosts — codeup, GitLab, a company mirror — therefore keep working, and so do the other Sessions in DSH and your own terminals.
- The Executor reads its own `worker-gitconfig`, which carries no empty `[credential] helper` line: emptying that list strips the helper of **every** host at once. It redirects github.com alone and leaves every other host to the helpers the machine already has. It also ignores the system git configuration, so a system-wide helper cannot answer for github.com on the agent's behalf and hand over the operator's own token.
- A Ticket's execution directory separates Tickets by directory alone; it isolates no permissions.

An Executor can run any program by path and read the operator's home directory. For real isolation, give the agent a dedicated OS account holding only its own credentials.

## Prerequisites

- Node.js `^22.19.0` or `>=24`, pnpm, git 2.32 or later, GitHub CLI (`gh`) 2.48 or later.
- DeepSeek Harness within `engines.dsh`, currently `^0.2.2-rc.1`; the build and tests in this repository use `0.2.2-rc.2`.
- A model provider configured for DeepSeek Harness. Both roles use the profile's default model unless the Eval or Execution settings name another.
- Python 3 and tmux: `scripts/xenra-superagent` is a Python script that runs the service in tmux and finds the process with `ps`.
- A repository on github.com. GitHub Enterprise Server is not supported: the git configuration and every API call are hard-wired to github.com and paths on it.
- To give each Ticket a checkout, keep a local clone from which the prepare command can add worktrees; install `git-lfs` if the repository uses Git LFS.

**The plugin itself works on Windows.** Everything platform-specific is answered in one place, `src/infra/platform.ts`:

- **The shims** (`gh`, `lark-cli`, a blocked command) are written as `.cmd` batch files on Windows rather than `#!/bin/sh` scripts, because Windows cannot execute a shell script and finds a command by its PATHEXT extension. Both forms carry the same marker, so a shim left by the other platform is replaced rather than rejected.
- **The prepare command** runs through `cmd /d /s /c`, so it is written in `cmd` syntax rather than `sh` syntax.
- **The setup probes** pass the directory list in the child's environment instead of prefixing the command with an `env` program.
- **Executable lookup** tries `.exe`, `.com`, `.bat`, `.cmd` and `.ps1` on Windows, so `gh` finds `gh.exe` or `gh.cmd`.
- **The worker git configuration** writes the `!` helper's path with forward slashes on Windows, because Git for Windows runs that helper through its own `sh`.

What remains POSIX-only is **`scripts/xenra-superagent`**: it is a Python script that carries the service in tmux, finds it with `ps`, and stops it with SIGINT. On Windows, start `dsh --profile <name>` directly and judge readiness from `GET state` or the panel; run the script inside WSL when you want its start/stop behaviour and exit codes.

`tests/fixtures/platform.ts` records that boundary: cases needing a `#!/bin/sh` wrapper, `tmux`, `ps` or a `chmod` permission bit are skipped on Windows with `it.skipIf`, and the rest — including Windows' own shim and shell forms — run as usual.

## Accounts

### Agent GitHub account

1. Create a GitHub user account for the agent and give it write access to the repository. A GitHub App cannot be the agent: the application reads that account's notifications, and only a user account has that feed.
2. Give it a GitHub CLI that uses only its own credentials:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   Sign in as the agent account; the last command prints its login. The application reads the login the same way and, with it, the account id, using `<id>+<login>@users.noreply.github.com` as the commit email in the execution environment.

   Saving the Source settings calls `repos/<owner>/<name>` and requires `permissions.push` to be true; when it is false the answer is "@… cannot push to …". Write access therefore has to exist before the save.

### Feishu bot (optional)

1. Create a self-built app with the bot capability, grant it permission to receive message events, read and send chat messages, and read chat members, then publish the app version.
2. Give the bot its own `lark-cli` configuration, restricted to the bot identity, and a wrapper:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-xenra-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-xenra-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-xenra-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   The first command reads the app secret from standard input. Use a separate directory: `lark-cli` allows one profile per app id, and your personal configuration may already contain a user login for that app.

   The application accepts the bot identity only. Setup reads `auth status` (`appId` shaped `cli_…`, `brand` `feishu` or `lark`, `identities.bot.status` equal to `ready`), `config strict-mode` (`strict-mode: bot` in its output) and the `open_id` that `/open-apis/bot/v3/info` returns. When any of them fails, the Feishu Source stays on that problem and everything else runs.

   Both configurations share the keychain entry for the app secret. To remove only the bot configuration, delete its directory; do not run `lark-cli config remove`, which would affect the shared secret.

## Install

Run this once, on a machine that has no `xenra` profile yet:

```sh
npm install -g @deepseek-ai/dsh@0.2.2-rc.2
git clone <this repository> xenra-superagent && cd xenra-superagent
pnpm install && pnpm build
dsh xenra --from-default-profile web --dump-config > /dev/null
dsh plugin --profile xenra add "link:$PWD"
```

The first command installs a DeepSeek Harness that satisfies `engines.dsh`; another version works too, as long as it falls within `^0.2.2-rc.1`.

The fourth command creates `~/.dsh/profiles/xenra` from the DeepSeek Harness Web template; `DSH_HOME` relocates that default directory. Use it for a new installation only: when the profile already exists it replaces the profile and deletes its `cordis.patch.yml`, machine configuration included. Do not run it for an upgrade.

The fifth installs this repository into that profile as a `link:`, so a rebuild takes effect on the spot. Installing the same package through the DeepSeek Harness plugin manager works as well and has the same effect. The repository commits the built `lib/`, so a `link:` install needs no build; rerun `pnpm build` only after changing `src/`.

Add the machine configuration (next section) before starting.

## Machine configuration

Copy [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) to `~/.dsh/profiles/xenra/cordis.patch.yml` and replace every `<placeholder>` in it. The example sets both the Web server and the state directory:

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3082
- id: xenra-superagent
  config:
    stateDir: /home/me/.dsh/state/xenra-superagent
```

The management API requires the Web server to bind `127.0.0.1`; on any other address the plugin refuses to start. The port is free, and the example uses 3082, which is also the address `scripts/xenra-superagent` checks health at by default. With another port the panel and the new address still agree (the page uses relative paths), but the script needs `--url` or `XENRA_SUPERAGENT_URL` to follow it, or it treats the running service as unreachable and exits 1.

The keys of the `xenra-superagent` row:

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `stateDir` | no | `<home>/.dsh/state/xenra-superagent` | Absolute path: the database, the lock, the command shims in `worker-bin`, the agent's git configuration and, by default, the Ticket directories under `work` |
| `promptMaxChars` | no | `100000` | The largest saved prompt configuration, 1000 to 1000000 |
| `admissionContextMaxPages` | no | `10` | Thread pages one assessment may read, 1 to 100 |
| `admissionContextTimeoutMs` | no | `15000` | Time limit of one context read during an assessment, 1 to 90000 milliseconds |

`stateDir` defaults to `<home>/.dsh/state/xenra-superagent`, so a freshly installed plugin starts and is then configured from its panel — that panel is the surface that would set this key, and a plugin that refused to start without it would leave nowhere to set it. Changing it means a different state, and the plugin remounts. In the panel it sits under **Settings › Deployment**, a group with no entry in the navigation on the left: open it from a **System problem** on Home, from this plugin's page in the DeepSeek Harness plugin manager, or edit the profile's `cordis.patch.yml` directly.

The three limits and `stateDir` are all edited under **Settings › Deployment**, which is the same page the DeepSeek Harness plugin manager opens. The limits are volatile and take effect as soon as they are saved; a new `stateDir` remounts the plugin, the page says so, and it shows the new location a few seconds later.

An unknown configuration key stops startup, and the log names it and says where the old key moved: `repository` and `github` are on the GitHub Source now, `branchPrefix` and `repositoryPath` in the prepare command of the Execution settings, `worktreeRoot` is the directory root there, `blockedCommands` in the Execution settings, and `author` is prompt text. Back up `stateDir` before an upgrade.

The Feishu Source is on by default and needs no configuration file edit: it stays idle until it has a bot CLI. After installing, put that CLI on the Feishu card under **Settings → Sources** and it starts working. Turn it off in the same file only when you do not want it at all:

```yaml
- id: xenra-superagent-feishu
  disabled: true
```

## Start and stop

```sh
scripts/xenra-superagent start
scripts/xenra-superagent status
scripts/xenra-superagent restart
scripts/xenra-superagent stop
```

`start` runs `dsh --profile <profile> --no-open` in tmux session `dsh-<profile>`, with the checkout root as its working directory. It waits up to one minute (`--timeout`) for the runtime to reach `ready` or `paused`. It refuses duplicate instances: two service processes for one profile are an error, including one started outside this script, and so is a URL where an instance already answers.

`stop` sends the service process `SIGINT` and waits up to 300 seconds (`--stop-timeout`) for shutdown to finish. It never force-kills, and it does not touch other tmux sessions. `restart` is that same stop followed by a start.

`status` prints a JSON object: `pids`, `cwd`, `url`, `manually_stopped`, `health` (one state per part), `errors` (the parts in `error` with their details), and `setup` and `feishu` (the configuration still missing).

For a different profile or port, use `--profile` and `--url`, or set `XENRA_SUPERAGENT_PROFILE` and `XENRA_SUPERAGENT_URL`.

`status`, `start` and `restart` exit with one of four codes:

| Code | Meaning |
| --- | --- |
| 0 | The service runs normally |
| 1 | It does not run, runs twice, does not answer, or its runtime reports an error; a restart may fix it |
| 2 | It runs, but a part other than the runtime reports an error, such as a Source or a policy sync (`sync:<source id>`); a restart does not fix it |
| 3 | It runs and waits for setup; a restart does not fix it |

A Source that is still starting counts as normal operation, and so does a Feishu bot that setup could not check. A failure of any effect kind, or an Executor incident, counts as 2.

Every run leaves files under `.artifacts/` in the checkout root:

- Startup logs `xenra-superagent-<profile>-<date>-<time>-<script pid>.log`; only the newest 20 are kept.
- The control directory `control/profiles/<profile>/`, holding the stop marker `manually-stopped`, `service.pid` and the operation lock `operation.lock`.

Open the URL the log prints, then choose **Xenra-SuperAgent** in the sidebar: a fresh installation lands on the **first-run guide** first, and on **Home** once it is configured. The DeepSeek Harness plugin manager also lists this plugin, and opening it shows the same Deployment page.

When the service process is shut down, a running Executor finishes its current step first; the next start treats the interrupted Assignment as one that an interruption cut short, as [003 Execution](003-execution.en.md) describes.

## Hourly check

Schedule this check in the DeepSeek Harness profile you work in, not in `xenra`: it has to keep running while the agent service is down. Ask an agent in that profile to create an hourly schedule with the prompt below, filling in the checkout path:

```text
Check Xenra-SuperAgent: run `scripts/xenra-superagent --profile xenra status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/xenra-superagent --profile xenra --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/xenra-superagent-xenra-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

The prompt does four things only: stay silent when all is well, report a failing part to a person, report what setup still needs, and restart only when the process is gone, then report the outcome. It never brings the service back after an intentional stop.

`--respect-stop` preserves an intentional stop. Only `stop` writes the marker; `start` clears it, and so does the start inside `restart`. An automatic check after a `stop` therefore stays quiet until someone runs `start` explicitly, and a marker left by a `restart` whose shutdown timed out is cleared by that restart's own start, so the check can retry it safely.

## Settings

Until setup succeeds, polling, assessment and dispatch do not start. A fresh installation opens the panel on the **first-run guide** rather than an empty Home: four steps ask which repository to watch and which account acts (saved together, because the Source checks push permission at once), whether to receive Feishu too (skippable), who may ask, and where work happens; each saves at once, and the guide can be skipped for later configuration in Settings, as [005 Panel](005-panel.en.md) describes. When setup has a problem, **System problems** on Home names what is missing, each row linking to the setting that fixes it; a deployment-level problem (the state directory, git, the execution environment) belongs to this machine, does not enter the guide, and shows on Home alone.

The panel has three tabs — **Home**, **Tickets**, **Settings** — and the settings page has four everyday groups: Sources, Eval, Execution and Prompts. The Deployment group has no entry in the navigation; a person reaches it from a system problem on Home, or through DeepSeek Harness's plugin manager. Policy is not a group of its own: its rules, each Source's list and the admission table live under **Eval**. A change runs setup again; when you fixed something outside the application (signing in a CLI, upgrading git), choose **Check again** to rerun setup — and setup refuses that when it has nothing to fix (`Setup is complete`).

1. **Sources.** The group opens with each Source's state, its arrived and filtered counts for the last 24 hours, the Triggers it filtered and the messages it did not send, then the cards that configure it. Set the GitHub repository (`owner/name`) and the agent CLI, for example `/home/me/.local/bin/gh-agent`. Requests normally arrive through the agent account's notifications: new Issues and comments mentioning the account arrive on the next poll, while a mention added by editing an Issue body does not; post a new comment instead. The four receive-everything switches are off by default; with one on, new Issues, new pull requests, comments and default-branch CI that do not mention the agent are received too, and the admission table decides whether they may become candidates. For Feishu, set the bot CLI, the chats (each receive-all or mentions-only), other chats and whether to receive direct messages.

   Saving the repository or an account field runs an account check and then restarts the application; the panel is briefly unavailable during the restart.

2. **Eval.** Policy first, then the Eval settings. **Policy**: the two example rules can be edited or removed; under **On each Source**, add the GitHub accounts and Feishu users who may originate work, and while a list is empty no request can become a Ticket; the admission table decides strength by receiving scope, whether the sender is on the list, and whether the message addresses the agent, as [002 Authorization](002-authorization.en.md) describes; a bot on the bot list can only produce inferred candidates. With Feishu, the list can be synced from a chat, at startup and on **Sync now**, and a failed sync appears under `sync:feishu` and retries with a backoff from a minute to an hour. **Eval settings**: the accept mode (off, observe, auto), the time limit of one Eval (30 to 600 seconds) and the assessor model.

3. **Execution.** The directory root, the prepare command, the concurrency (1 to 16) and the blocked commands. To give each Ticket a checkout of the repository:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$XENRA_SUPERAGENT_GITHUB_REPOSITORY.git" "${XENRA_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/xenra-superagent/$XENRA_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$XENRA_SUPERAGENT_NAME" "$XENRA_SUPERAGENT_DIR" "refs/xenra-superagent/$XENRA_SUPERAGENT_TICKET"
   ```

   A blocked command makes calls to that name fail inside the Executor, which keeps your own account's CLI out of reach; `gh`, `git` and `lark-cli` cannot be blocked. The directory root and the prepare command can only be changed in the panel; the main Session's tools cannot change them.

4. **Prompts.** Edit the team sections (communication, Ticket scope, delivery requirements), the built-in parts and the skills. A built-in part has default text, and an edit records which version it was edited from; when an upgrade changes the default it is marked **Default updated**. What changes here is what the agent is told, not what it may do: tool permissions, admission and the account shims live elsewhere.

5. **Deployment.** No navigational entry: reached from a system problem on Home, or from this plugin's page in the plugin manager. It shows any setup problem with **Check again**, `stateDir` and the three limits. A limit change takes effect at once. The DeepSeek Harness plugin manager opens the same page.

## Management API

The panel talks to an HTTP API on the loopback interface, and agents and the service script can call it too: `scripts/xenra-superagent status` reads `GET state`, and the flow in `SETUP.md` saves settings blocks with `PUT`.

Send requests to `http://127.0.0.1:<port>/orchestrator/api/` with `x-orchestrator-request: 1`. `Host` must be `127.0.0.1:<port>` or `localhost:<port>`; a missing header, or an `Origin` from another site, receives 403 `Same-origin management request required`. When the Web server is not bound to a loopback address, the plugin refuses to start.

A save through the API has the panel's permissions: its origin is `panel`, so it may change the execution environment and the account fields setup reads. A save through the main Session's tools may change neither (`panelOnlyEnvironment`, `panelOnlyAccounts`).

These routes and fields can be relied on; `src/app/api.ts` holds other routes that serve the panel and change with it.

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup`, with `machine` (`stateDir` and the three limits), `problem` and `feishuProblem` (each `null` or a setup problem with `place`, `code`, `values` and `detail`), and `accounts` once it resolved (`repository`, `agent`, `feishu`); `load` (the Executor Sessions `running`, the Tickets `queued`, `maxWorkers`); `masterId`; `paused`; `health` |
| `GET settings` | `policyVersion`; `blocks` (`policy`, `eval`, `executor`, each with `value` and `revision`); `sources` (for each instance `id`, `kind`, `title`, `description`, `installed`, `value` as `{"enabled": …, "config": {…}}`, `revision`, the fields whose save restarts (`restarts`), its kind's `fields` and `facts`, the resolved display names `labels`, its setup `problem` when it has one, and its part of the Policy as `policy`: `fields`, `explicit`, `rows`, `sync`); `environment` (`root` and `variables`) |
| `GET sources` | Each Source's status: `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), the `health` of its parts, its `problem`, the last day's `stats`, the Triggers it `filtered` in that day, and the messages it `dropped` in that day, newest drop first, each with its `channel`, `preview`, its `ticket` when it was for one, its `thread` when the store has it, and `dropped.at` with `dropped.reason`, `channelGone` or `channelIgnored` |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | Saves one block: `saved`, the new `revision`, `policy_changed`, `restarting` and `context_delivery`. `block` is `policy`, `eval`, `executor` or `source:<source id>`; `value` is the whole block as `GET settings` holds it; a missing key takes its default |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `POST setup/check` | Runs setup again by restarting the application: `restarting: true`. Answers 400 when setup has nothing to fix |
| `POST policy-sync/<source id>` | Syncs that Source's allowed list now: `policy`, the Source's part as saved |
| `GET prompts` | `current` (with `revision` and `config`), `defaults`, `sections` (the team sections), `skillName` (the pattern of a team skill's name), `builtin` (the names a team skill cannot take), `skillPrefix` (the prefix a Session loads a skill's name under), `parts` (the built-in parts with their `base`), `defaultChanged`, each Session's prompt revision, and the history |
| `PUT prompts` with `{"config", "baseRevision"}` | Saves the prompt configuration: the new `revision`, `effect: "next-request"` and `context_delivery` |
| `POST prompts/preview` | Composes without saving: both roles' complete prompts and their parts |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retries or stops a Ticket as the panel does, answering `retried` or `stopped` |
| `GET tickets`, `GET tickets/<id>`, `GET threads`, `GET threads/<key>`, `GET decisions`, `GET overview`, `GET search` | The views the panel's pages read; `src/app/api.ts` lists the filters |
| `POST triggers/<id>/requeue`, `POST decisions/<id>/dismiss`, `POST threads/<key>/unsubscribe`, `POST sources/<id>/labels` | The operations the panel's buttons perform |

Health entries are grouped by responsibility:

| Entry | Reports |
| --- | --- |
| `runtime` | The application itself; a failed pass shows here |
| `models` | Sessions waiting on a model-budget retry |
| `evals` | Unavailable Evals from the last hour with no later judgement or dismissal |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | The effect queue's six kinds of work, described in [003 Execution](003-execution.en.md); `delivery`'s failures show on the Ticket instead |
| `worker` | Executor Session event handling; it appears after the first failure |
| `github`, `feishu`, `history` | Source polling, event consumption and history recovery |
| `sync:<source id>` | Allowed-list synchronization |

A refusal carries a status and an English `error`:

- 400: an invalid value (with `issues`, each with its `path`), a failed account check (with `setup`), a fixed refusal (with `code` and `values`), or a body that is not JSON or is over the limit.
- 404: something that does not exist.
- 409: a stale revision.
- 500: everything else.

The body limit is 128 KiB, and a prompt save may be `4 × promptMaxChars + 4096` bytes. A save whose revision changed while it ran answers 409 and needs a fresh read.

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

Changing the repository or the CLI runs the matching account check first; a failure answers 400 with the details under `setup`. A successful account change, and any save while setup waits, answer `restarting: true`, and the application restarts.

## Setup checks

Setup runs through DeepSeek Harness's subprocess service, the same way Executor shells do, so the host strips environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN from those subprocesses — which is also why the execution environment holds no credentials.

Setup does three things:

1. It checks the GitHub repository and the agent's push access, and reads the Feishu bot identity; a Feishu failure disables the Feishu Source alone and everything else runs.
2. It writes the execution environment: the shims in `<stateDir>/worker-bin` (`gh` runs the agent's CLI, `lark-cli` runs the bot's CLI or fails, and blocked commands fail) and `<stateDir>/worker-gitconfig`. A shim removes its own directory from `PATH` before handing over, so a wrapper that resolves `gh` by name still reaches the real binary.
3. It applies the process environment: `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM` are set, `GH_TOKEN`, `GITHUB_TOKEN`, the git location variables and the commit identity variables are cleared, and `worker-bin` goes first on `PATH`; then `git config --show-origin` confirms that the github.com credential helper really comes from that file, and setup reports `gitTooOld` when it does not.

Because `worker-bin` is first on `PATH`, the `gh` an Executor calls is the agent's. `worker-gitconfig` replaces the operator's global and system git configuration, so personal settings such as an HTTP proxy do not apply; it rewrites GitHub's SSH addresses to HTTPS and defines the Git LFS filters. No commit identity is set there: the prompts name it, and `user.useConfigOnly` makes git fail rather than guess one.

A file in `worker-bin` or `worker-gitconfig` that this application did not write (its first two lines carry no marker) fails setup, which names the file instead of overwriting it. A Ticket directory inside a repository whose own config sets credentials or `http.*extraheader` fails that Ticket, and the message names the keys to remove.

## Try it

With a GitHub account on the allowed list, open an Issue, or post a comment containing `@<agent login> <request>`. Within one polling interval (60 seconds by default) a Ticket should appear among the **Pending Tickets** on **Home** or in the **Open** list on **Tickets**. The agent acknowledges in the original conversation, works in its own Session and its own directory, and delivers the result where the request came from, usually as a pull request.

With Feishu, mention the bot in a configured chat, or post in an allowed chat when it receives everything; direct messages work the same way.

## Uninstall

Choosing **Uninstall** in the Plugin Manager removes what this plugin wrote into `<stateDir>` as it stops: the shims in `worker-bin`, `worker-gitconfig`, and the database with its `-shm`/`-wal` companions. There is nothing to do in the panel first — after the uninstall the panel is gone.

It deletes only files it wrote: anything in `<stateDir>` without this application's marker in its first two lines is kept, and the directory itself is kept when a person's own files remain. The decision comes from the plugin-management events DSH already emits — **DSH itself is not modified**: cleanup happens only when an explicit uninstall of this plugin is seen, no update is in progress, and the profile manifest really has stopped selecting it. Disabling, updating and restarting never trigger it; an unreadable manifest means no deletion, rather than a guess that could destroy a working installation.

A restart or an upgrade does not clean up: the plugin is still selected in the profile then, so the database and its tickets stay.

## Upgrade

1. Wait until no Executor is in the middle of a turn.
2. Back up `<stateDir>/orchestrator.sqlite`.
3. Run `git pull && pnpm install && pnpm build`.
4. Run `scripts/xenra-superagent restart`, then `status` and confirm it exits 0.

A restart ends running Assignments and starts replacements with a recovery note. Team text and overridden prompt parts survive, and parts without an override follow the new defaults; after an upgrade, check the parts marked **Default updated**.

A database a newer version migrated cannot be opened by an older one: the schema version only grows, and an older build reports `Unsupported orchestrator database version`. Rolling back therefore means rolling back to the backup taken before the upgrade. The current schema is 11; startup migrates a schema 10 database once, and rejects anything older with a message to use a new state directory.

After upgrading DeepSeek Harness itself, restart the running instance so the panel loads artifacts that match the host; otherwise the plugin page fails to load.

### Upgrading from dsh-superagent

This project was once called `dsh-superagent`. The package, the plugin entries, the presets, the skills, the script and the environment variables are now `xenra-superagent` and `XENRA_SUPERAGENT_*`. An installation made under the old name still works, because what is read back is interpreted under the new name:

- Files in `worker-bin` and `worker-gitconfig` written under the old name still count as this application's and are replaced.
- Saved prompt text and the `DSH_SUPERAGENT_*` in a prepare command are rewritten to `XENRA_SUPERAGENT_*` during migration, and so are the `dsh-superagent-*` skill and variable prefixes.
- Messages delivered under the old source are still deduplicated by their original id, so none is sent twice.
- The hidden marker on GitHub comments is recognised under either name.

Only the profile configuration does not migrate; edit it once by hand:

1. In `<profile>/cordis.patch.yml`, rename the entry `dsh-superagent` to `xenra-superagent`, and `dsh-superagent-feishu` and `dsh-superagent-github` to `xenra-superagent-feishu` and `xenra-superagent-github`. Keep each `stateDir`, so the existing database and Tickets are reused.
2. Where `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL` were set, set `XENRA_SUPERAGENT_PROFILE` and `XENRA_SUPERAGENT_URL`, and point the hourly check at `scripts/xenra-superagent`.
3. Choose **Xenra-SuperAgent** in the sidebar; the DeepSeek Harness plugin manager lists this plugin under its new entry.
4. Start once after the upgrade, open **Home** to confirm the Tickets are still there, glance at the Decision record and Threads under **Settings › Advanced views**, then delete the old entry rows.

Sessions restored before the rename keep the preset ids they were created with, and those ids no longer exist, so restoring them fails. Once the Executors and main Session from before the upgrade are no longer needed, delete the Sessions they live in; the Sessions themselves can be removed from DeepSeek Harness.

## Agent presets

The two preset rows do one thing: let a Session find the preset it needs when it is created and when it resumes.

- **Do not delete them.** While any Session still uses one, deleting it makes that resume fail with `agent-preset/not-found`. To delete them, first confirm the Sessions that used them have ended and been removed.
- **Do not select them for personal Sessions.** The worker preset has no tools for asking a person, presenting or plan mode; the router preset only reads and has no shell.
- **A wrong selection is corrected.** When the Web UI selects another preset before a Session's first turn, `Sessions` selects the role's preset back; after the first turn the host no longer allows a change.
- A preset row has no setting that hides it from the list, so its name and description state its purpose directly.

## Troubleshooting

The panel shows setup problems in the interface language and links each to where it is fixed; logs and the API carry the English text below.

| Symptom | Cause and fix |
| --- | --- |
| The plugin refuses to start, and the log says the configuration has keys it does not use | Delete the named keys as the message says, and move each to where it now lives (see "Machine configuration") |
| The plugin refuses to start, and the log asks for a loopback Web server | Set the profile's `webserver.host` back to `127.0.0.1` |
| `Orchestrator database schema N predates schema 10` | This channel's database comes from an older prototype and cannot be migrated; use a new `stateDir` |
| `Unsupported orchestrator database version N` | A newer version migrated the database; rolling back needs the backup taken before the upgrade |
| `The agent GitHub CLI is not set.` | Set the agent's CLI on the GitHub card |
| `The agent GitHub CLI was not found.` | Give the wrapper's absolute path, or a command name on `PATH` |
| `The agent GitHub CLI cannot read its account.` | Run `auth login` for that wrapper |
| `The agent GitHub CLI did not report a GitHub account.` | Same: after signing in, `api user` must print a login |
| `@… cannot read …` / `@… cannot push to …` | Give the agent account write access to the repository, or check the repository name |
| `The GitHub Source names no repository.` | Set the repository as `owner/name` on the GitHub card |
| `The bot lark-cli does not work.` | Check the bot configuration directory and the wrapper's path, and that `lark-cli auth status` runs |
| `The bot identity of app … is …` | Run `config init` again with the app secret so the bot identity becomes `ready` |
| `The bot lark-cli allows user identities (strict mode …)` | Give the bot its own `strict-mode bot` configuration, as "Feishu bot" describes |
| `The Feishu bot is not a member of the chat.` | Add the bot in the chat's settings; the next attempt succeeds |
| `… was not written by xenra-superagent` | Move the named file out of `worker-bin` or `worker-gitconfig`, or use another `stateDir` |
| `git does not read the github.com credential configuration xenra-superagent writes` | The message carries the git version that actually ran and the value it reported. On Settings → Deployment, under **This machine**, look for **Upgrade git…**: it first shows the command it would run (`winget`, `brew`, `apt` and so on, whichever package manager this machine has) and what that changes, and runs it only once you confirm; close the dialog to upgrade in your own terminal instead and then choose **Check again**. When no package manager is available it says so and names the version to reach |
| `Preparing the agent environment failed.` with a permission error in the detail | Make `stateDir` writable by the OS user that runs DSH, or use a directory that user owns |
| A Ticket fails with `The prepare command failed: …` | The output says why, such as a wrong clone path or a missing credential; fix the command and retry the Ticket. This failure is never retried automatically |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named `credential.*` or `http.*extraheader` from the clone's `.git/config` |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …`, `… could not run: …` | A CLI failed without printing why; run the named program by hand as the operator and read its own message |
| `status` exits 2 | A part keeps reporting an error, which a restart does not fix; `errors` names each part with its detail, and the entry clears itself once the part recovers |
| `status` exits 3 | Setup is waiting: `setup` says what is missing, and the system problems on Home link to the setting that fixes it |
| `status` exits 1 | The service is not running, runs twice, does not answer, or its runtime reports an error; the output and the newest log say which |
| The panel says it cannot reach the service | The application is restarting, or did not start because of a setup problem; read the newest log under `.artifacts/` |
| The panel shows "Failed to load plugins" | DeepSeek Harness was upgraded; restart the running instance |
| A save answers `Setup is complete` | Setup is healthy and **Check again** has nothing to do; change the setting itself |
| A save answers `Settings changed. Reload before saving.` | The revision is stale; reload and edit again |
| A save answers `The execution environment … can only be changed in the management panel` | That field changes only from the panel or the management API; the main Session's tools cannot change it |
| A save answers `The {block} model is not available: …` | The model provider is not configured, or that provider/model is unavailable |
| Nothing happens after an `@` | Check that the author is on that Source's allowed list, the Source is enabled, and processing is not paused; on GitHub a mention added by editing a body is not received, so mention the agent in a comment |