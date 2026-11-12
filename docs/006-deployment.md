# 006 部署

[English](006-deployment.en.md) · 中文

本指南用于安装、配置和运维 Xenra-SuperAgent。它覆盖账号、启动检查、升级与故障排查，建立在 [001 领域模型](001-domain.md) 到 [005 面板](005-panel.md) 之上。

## 运行着什么

- **一个专用的 DeepSeek Harness profile**，本指南中称为 `xenra`。用 Web profile 模板创建它。它加载本 bundle，并在 `127.0.0.1` 上提供面板。请把它和你日常工作的 profile 分开：该插件会修改进程范围的 `PATH` 和 git 设置，它的进程也需要独立地重启和升级。
- **一个智能体 GitHub 账号。** 智能体以该账号评论、推送分支、开启 Pull Request，并通过只以该账号登录的 GitHub CLI 操作。
- **可选：** 用于聊天请求的飞书机器人。

插件配置保存状态目录和机器上限。其余一切都在面板里做：仓库与账号在"来源"，允许名单在"策略"，执行器目录与命令在"执行"。

### 权限与隔离

本 bundle 为执行器定义 `xenra-superagent-worker`、为主 Session 定义 `xenra-superagent-router`。它们会出现在 DeepSeek Harness 的预置列表里，但只供 Xenra-SuperAgent 使用。不要为个人 Session 选择它们，也不要禁用它们的配置行。应用需要它们来创建和恢复自己的 Session。

在 Web UI 里新开一个空的管理 Session 可能会选中该 profile 的默认预置。Xenra-SuperAgent 会在第一轮之前恢复它自己的角色预置。

两个预置都以运营者的操作系统用户身份、在 `danger-full-access` 下运行，并读取已订阅线程的消息。账号包装脚本默认选择智能体的凭据，但不隔离进程。执行器可以按路径执行程序，也能读取运营者的主目录。要隔离，请使用只包含智能体凭据的专用操作系统账号。

## 前置条件

- Node.js 22.19+ 或 24+、pnpm、git 2.32+、Python 3.8+ 和 tmux
- GitHub CLI（`gh`）2.48 或更新。来源的 CLI 字段必须指向 `gh` 或 `lark-cli` 的包装脚本；宿主依赖它们的子命令和输出格式。
- github.com 上的一个仓库；不支持 GitHub Enterprise Server。要为每个工单创建检出，请保留一个本地克隆，让 prepare 命令能在它上面添加 worktree。仓库使用 Git LFS 时请安装 `git-lfs`。
- 为 DeepSeek Harness 配置好的模型服务。除非评估或执行设置里另指定，Xenra-SuperAgent 使用该 profile 的默认模型。
- 使用飞书时：`lark-cli`（已在 1.0.90 上测试）以及一个带机器人能力的飞书或 Lark 应用

## 账号

### 智能体 GitHub 账号

1. 为智能体创建一个 GitHub 用户账号，并给它该仓库的写权限。GitHub App 不能充当智能体，因为 Xenra-SuperAgent 要读该账号的通知。
2. 给它一个只使用自身凭据的 GitHub CLI：

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

   以智能体账号登录；最后一条命令会打印它的登录名。Xenra-SuperAgent 以同样的方式读取该登录名。

### 飞书机器人（可选）

1. 创建一个具备机器人能力的自建应用。授予它接收消息事件、读写群消息、读取群成员的权限，然后发布应用版本。
2. 给该机器人一份自己的、限制为机器人身份的 `lark-cli` 配置，以及一个包装脚本：

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

   第一条命令从标准输入读取 app secret。请使用独立的配置目录：`lark-cli` 每个 app id 只允许一份 profile，而你的个人配置里可能已经含有该应用的用户登录。

   宿主会拒绝能以用户身份行动的 CLI。它从机器人配置中读取 app id、飞书/Lark 品牌和机器人的 `open_id`。

   两份配置共用同一个 keychain 中的 app secret。若只想删除机器人配置，请删掉它的目录；不要运行 `lark-cli config remove`，那会影响共用的 secret。

## 安装

在还没有 `xenra` profile 的机器上，执行一次这个代码块：

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> xenra-superagent && cd xenra-superagent
pnpm install && pnpm build
dsh xenra --from-default-profile web --dump-config > /dev/null
dsh plugin --profile xenra add "link:$PWD"
```

上面固定的版本是公开版本；其他版本必须满足 `package.json` 里的 `engines.dsh`。

第四条命令从 DeepSeek Harness 的 Web 模板创建 `~/.dsh/profiles/xenra`。第五条安装本 bundle。设置 `DSH_HOME` 可以改变默认的 `~/.dsh` 目录。

只有全新安装时才运行创建 profile 的命令。profile 已存在时，那条命令会替换它并删除它的 `cordis.patch.yml`，包括机器配置。升级时不要使用它。

## 机器配置

把 [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) 复制为 `~/.dsh/profiles/xenra/cordis.patch.yml`，替换掉该文件，并替换其中每个 `<placeholder>`。使用飞书时，同时在那里启用 `xenra-superagent-feishu` 条目。`webserver` 条目设置面板端口。

| 键 | 必需 | 含义 |
| --- | --- | --- |
| `stateDir` | 是 | 绝对路径：数据库、锁、`worker-bin` 中的命令包装脚本、智能体的 git 配置，以及默认情况下的 `work` 中的工单目录。升级前请备份 |
| `promptMaxChars`、`admissionContextMaxPages`、`admissionContextTimeoutMs` | 否 | 已保存提示词配置的最大长度，以及一次研判在多少时间内读取多少页线程 |

首次启动之后，可以在 **设置 → 部署** 或 DeepSeek Harness 的插件管理器里修改机器上限。改动无需重启即可生效。`stateDir` 不能在那里修改。无效的值或未知的配置键会阻止启动；日志会指明是哪个键。

## 启停

```sh
scripts/xenra-superagent start
scripts/xenra-superagent status
```

`start` 在 tmux 会话 `dsh-xenra` 中运行 `dsh --profile xenra`，其他 profile 则是 `dsh-<profile>`。它最多等一分钟，等运行时就绪或报告需要配置。首次运行时它会打印缺失的配置信息。它会拒绝重复实例，包括在脚本之外启动的实例。

`stop` 和 `restart` 请求优雅关闭，并为执行器最多等五分钟。它们从不强制终止进程，也不碰其他 tmux 会话。

`status` 打印进程 id、健康和配置问题。换 profile 或端口时，用 `--profile` 和 `--url`，或设置 `XENRA_SUPERAGENT_PROFILE` 与 `XENRA_SUPERAGENT_URL`。

`status`、`start` 和 `restart` 的退出码是四种之一：

| 退出码 | 含义 |
| --- | --- |
| 0 | 服务正常运行 |
| 1 | 没有运行、运行了两份、没有响应，或它的运行时报告错误；重启可能修好 |
| 2 | 在运行，但运行时之外的某个部分（例如某个来源，或策略同步 `sync:<来源 id>`）报告错误；重启修不好 |
| 3 | 在运行，且正在等待配置；重启修不好 |

仍在启动的来源算正常运行，配置时无法检查的飞书机器人也算。

`status` 在 `errors` 下返回失败的部分及其详情，在 `setup` 下返回配置需求。`start` 和 `restart` 会把这些作为逐行打印；服务始终起不来时它们以 1 退出。只有有意的 `stop` 会暂停自动恢复。

每个 profile 的日志和控制文件都放在 `.artifacts/` 下：

- 启动日志：`xenra-superagent-<profile>-<日期>-<时间>-<pid>.log`，其中 pid 属于脚本。只保留最新 20 份。
- 控制文件：`control/profiles/<profile>/`，含停止标记、锁和进程 id。

打开日志里打印的 URL，然后在侧栏选择 **Xenra-SuperAgent**。

### 每小时检查

在你日常使用的 DeepSeek Harness profile 里创建这个每小时检查，不要建在 `xenra` 里。它必须在智能体服务停掉时仍能运行。请那个 profile 里的智能体按下面的提示词创建每小时计划，并填好检出路径：

```text
Check Xenra-SuperAgent: run `scripts/xenra-superagent --profile xenra status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/xenra-superagent --profile xenra --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/xenra-superagent-xenra-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` 会保留有意的停止。只有 `stop` 会写入该标记，`start` 会清除它。`restart` 不写标记，所以该检查可以恢复一次关闭超时的重启。

## 设置

配置成功之前，轮询或工作都不会开始。总览会列出缺失的要求，并链接到对应设置。设置改动会再次运行配置。若你在应用之外修好了某些东西（例如 CLI 登录），请点 **重新检查**。

1. **来源。** 设置 GitHub 仓库（`owner/name`）和智能体 CLI，例如 `/home/me/.local/bin/gh-agent`。请求通常通过智能体账号的通知到达。新的 Issue 或 @ 该账号的评论会在下次轮询时到达；通过编辑已有 Issue 正文来添加 @ 则不会。请改为发表新评论。使用飞书时，设置机器人 CLI、群、每个群是全量接收还是仅 @，以及是否接收私信。
2. **策略。** 两条示例规则可以编辑或删除。在 **每个来源** 下，添加可以请求工作的 GitHub 账号和飞书用户；在名单里有人之前，任何请求都成不了工单。使用飞书时，可以选择从一个群同步名单，在启动时和点 **立即同步** 时执行。
3. **执行。** 目录根和一条 prepare 命令。要让每个工单都有一份仓库检出：

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$XENRA_SUPERAGENT_GITHUB_REPOSITORY.git" "${XENRA_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/xenra-superagent/$XENRA_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$XENRA_SUPERAGENT_NAME" "$XENRA_SUPERAGENT_DIR" "refs/xenra-superagent/$XENRA_SUPERAGENT_TICKET"
   ```

   把你个人的 CLI（例如以你自己的账号登录的那个）列为被禁止的命令。
4. **提示词。** 设置团队小节：GitHub 的声明行、评审机器人、提交作者和自动合并条件。

### 管理 API

面板使用一个本地 HTTP API，智能体也可以调用它。`SETUP.md` 用它保存设置，服务脚本读取 `GET state`。

把请求发到 `http://127.0.0.1:<端口>/orchestrator/api/`，并带上 `x-orchestrator-request: 1`。主机必须是 `127.0.0.1:<端口>` 或 `localhost:<端口>`。缺少该头部，或 `Origin` 来自其他站点，会收到 403。

通过 API 保存拥有与面板相同的权限。与通过主 Session 工具所做的保存不同，它们可以修改执行环境和配置用的账号字段。

智能体可以依赖这些路由与字段。`src/app/api.ts` 中的其他路由只服务面板，并随面板变化。

| 请求 | 答复 |
| --- | --- |
| `GET state` | 每个页面读取的内容：`setup`（含 `problem` 与 `feishuProblem`，各自为 `null` 或一个带 `place`、`code`、`values`、`detail` 的配置问题；配置解析后还有 `accounts`）；`health`（每个部分一条，见下，含 `state`（`starting`、`ready`、`paused` 或 `error`）、`detail`、`at`）；`load`（`running` 的执行器 Session、`queued` 的工单与 `maxWorkers`）；`paused`；以及 `masterId` |
| `GET settings` | `blocks`：`policy`、`eval`、`executor`，各含 `value` 和 `revision`；`sources`：来源实例，各含 `id`、`kind`、`installed`、其块的 `value`（`{"enabled": …, "config": {…}}`）与 `revision`、其种类的表单，以及有问题时的配置 `problem`；`policyVersion`；以及 `environment`（执行环境的 `root` 和 `variables`） |
| `GET sources` | 每个来源的状态：`state`（`missing`、`off`、`error`、`setup`、`starting`、`paused` 或 `ready`）、其各部分 `health`、配置 `problem`、最近一天的 `stats`、该日被它 `filtered` 的触发，以及该日被它 `dropped` 的消息（最新的在前，每条含 `channel`、`preview`、属于某个工单时的 `ticket`（`id` 与 `title`）、存储中存在时的 `thread`，以及 `dropped.at` 与 `dropped.reason`（`channelGone` 或 `channelIgnored`）） |
| `PUT settings/<block>` 带 `{"value": …, "revision": n}` | 保存一个块：`saved`、该块的新 `revision`、`policy_changed` 和 `restarting`。`value` 是整个块，形式同 `GET settings`；缺失的键取其默认值 |
| `POST executor/pause` 带 `{"paused": true}` 或 `false` | 暂停或恢复处理：`paused` |
| `POST setup/check` | 通过重启 Xenra-SuperAgent 再次运行配置：`restarting: true`。配置没有可修的问题时被拒绝 |
| `POST policy-sync/<来源 id>` | 立刻同步该来源的允许名单：`policy`，即保存后的来源部分 |
| `GET prompts`、`PUT prompts` 带 `{"config", "baseRevision"}` | 读取提示词配置：`current`（含 `revision` 与 `config`）、`defaults`、`sections`（团队小节，按 Session 读取的顺序）、`skillName`（团队技能名的模式）、`builtin`（团队技能不能使用的名字）、`skillPrefix`（Session 加载技能名时使用的前缀）。或保存它：新的 `revision` |
| `POST tickets/<id>/retry`、`POST tickets/<id>/stop` | 与面板一样重试或停止一个工单 |

健康项按职责分组：

| 键 | 报告内容 |
| --- | --- |
| `runtime` | 应用本身 |
| `models` | 正在等待模型预算重试的 Session |
| `evals` | 最近一小时未完成、且此后没有新判断也未被忽略的评估 |
| `assessment`、`launch`、`delivery`、`relay`、`notice`、`reply` | [003 执行](003-execution.md) 中描述的存储工作；`delivery` 统计等待中的工作，`reply` 覆盖渠道消息 |
| `worker` | 执行器 Session 的事件处理；首次失败后才出现 |
| `github`、`feishu`、`history` | 来源轮询、事件与历史补收 |
| `sync:<来源 id>` | 允许名单同步 |

拒绝会带状态码和 `error`（英文原文）：

- 400：无效的值（`issues`，各含 `path`）、账号检查失败（`setup`）、固定拒绝（`code` 与 `values`），或请求体不是 JSON / 过大。
- 404：不存在的东西。
- 409：过期的修订号。
- 500：其他一切。

各块：

- `source:github`、`source:feishu`：`{"enabled": true, "config": {…}}`。GitHub 的 config 有 `repository` 和 `cli`，以及默认关闭的开关 `observeIssues`、`observePulls`、`observeComments`、`observeCi`——它们接收仓库里每个新 Issue、新 Pull Request 和评论，以及默认分支的 CI；飞书的 config 有 `cli`、`chats`（形如 `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]`，或 `"all"`）、`directMessages`，以及取 `"none"` 或 `"mentions"` 的 `otherChats`。
- `policy`：`{"rules": […], "sources": {"github": {"allowed": [{"id": "<登录名>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`。`bots` 列出其消息可以成为推断候选的机器人。`admission` 的行以群 id 为键；飞书还用 `other` 和 `direct`，GitHub 用 `issues`、`pulls`、`comments` 和 `ci`；未设置的单元格取默认值（见 [002 授权](002-authorization.md)）。
- `eval`：`mode`、`timeoutSeconds` 和 `model`。
- `executor`：`model`、`maxWorkers`、`directory`、`prepare` 和 `blockedCommands`。处理暂停是独立设置 `paused`，由 `POST executor/pause` 设置。

修改仓库或 CLI 会先运行对应的配置检查。检查失败返回 400，详情在 `setup` 中。账号改动成功，或在配置待完成期间的任何保存，都会返回 `restarting: true`。应用重启期间 API 暂不可用。

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## 配置检查

配置使用 DeepSeek Harness 的子进程服务，和执行器 shell 一样。它会移除名字中含 KEY、PASSWORD、SECRET 或 TOKEN 的环境变量。

配置会校验 GitHub 仓库与智能体的推送权限、写入执行器环境，并检查 git 只对 github.com 使用智能体凭据。飞书配置失败只会禁用飞书来源。

配置写入的进程环境：

- **命令包装脚本**位于 `<stateDir>/worker-bin`，排在 `PATH` 最前：`gh` 运行智能体的 CLI；`lark-cli` 运行机器人的 CLI；被禁止的命令失败。包装脚本在运行目标之前会把自己的目录从 `PATH` 中移除。
- **git 配置**位于 `<stateDir>/worker-gitconfig`：取代运营者的全局与系统 git 配置。它把智能体 CLI 设为 github.com 的凭据助手，把 GitHub 的 SSH 地址改写为 HTTPS，并定义 Git LFS 过滤器。HTTP 代理之类的个人 git 设置不会生效。这里不设置提交身份，git 也从不提示输入凭据，`GH_TOKEN` 和 `GITHUB_TOKEN` 会被移除。

`worker-bin` 或 `worker-gitconfig` 中不是 Xenra-SuperAgent 写入的文件会中断配置。位于一个自身配置添加了凭据的 git 仓库内的工单目录，会使该工单失败。

## 试一试

用一个在允许名单上的 GitHub 账号，开一个 Issue，或发表一条包含 `@<智能体登录名> <请求>` 的评论。在一个轮询周期内（默认一分钟），总览应显示一个工单。智能体会确认该请求，在自己的 Session 和目录里工作，并在原对话里交付。使用飞书时，在已配置的群里 @ 机器人。

## 升级

1. 等到没有执行器正处于一轮的中间。
2. 备份 `<stateDir>/orchestrator.sqlite`。
3. 运行 `git pull && pnpm install && pnpm build`。
4. 运行 `scripts/xenra-superagent restart` 并检查它的状态。

重启会结束正在运行的派工，并以恢复说明启动替代者。团队的文本和被覆盖的提示词分段会保留；没有覆盖的分段跟随新的默认值。升级后请检查标为 **默认已更新** 的分段。

被更新版本迁移过的数据库无法被旧版本打开，所以回滚需要升级前的备份。升级 DeepSeek Harness 本身之后，请重启正在运行的实例，让面板加载匹配的产物。

### 从 dsh-superagent 升级

本项目曾叫 `dsh-superagent`；包名、DSH 条目、预置、技能、脚本和环境变量现在分别是 `xenra-superagent` 和 `XENRA_SUPERAGENT_*`。以旧名做的安装仍然可用，因为存储的数据会按新名读回：以旧名写入的执行器包装脚本和智能体 git 配置仍会被识别并替换，提示词文本和 `prepare` 命令会从 `dsh-superagent-*` 和 `DSH_SUPERAGENT_*` 改写，以旧来源送达的消息也仍然保持去重。只有机器配置不会自动迁移，请手动改一次：

1. 在 `<profile>/cordis.patch.yml` 中，把条目 `dsh-superagent` 改名为 `xenra-superagent`，把 `dsh-superagent-feishu` 和 `dsh-superagent-github` 改为 `xenra-superagent-feishu` 和 `xenra-superagent-github`。保留各自的 `stateDir`，这样会复用已有的数据库和工单。
2. 在原来设置 `DSH_SUPERAGENT_PROFILE` 和 `DSH_SUPERAGENT_URL` 的地方设置 `XENRA_SUPERAGENT_PROFILE` 和 `XENRA_SUPERAGENT_URL`，并把每小时检查指向 `scripts/xenra-superagent`。
3. 在侧栏选择 **Xenra-SuperAgent**；它在 DeepSeek Harness 插件管理器里的条目是新的那个。

改名之前恢复的 Session 会保留它们创建时使用的预置 id。等升级前的执行器和主 Session 都不再使用之后，删掉旧的预置行。

### 智能体预置

执行器与主 Session 预置会在 5 秒后把 shell 命令转入后台。Session 没有预置就无法加载。只要它们的 Session 还在使用，就请在 `cordis.patch.yml` 中保留 `xenra-superagent-worker` 和 `xenra-superagent-router` 这两行；否则恢复会因 `agent-preset/not-found` 失败。

## 故障排查

配置问题会以面板的语言显示在总览上，并链接到修复位置；日志和 API 显示下面这些英文原文。

| 现象 | 原因与修复 |
| --- | --- |
| `The agent GitHub CLI is not set.` | 在 GitHub 卡片上设置智能体的 CLI |
| `The agent GitHub CLI was not found.` | 设置包装脚本的绝对路径，或 `PATH` 上的命令名 |
| `The agent GitHub CLI cannot read its account` | 用 `auth login` 登录该包装脚本 |
| `@… cannot read …` 或 `@… cannot push to …` | 给智能体账号该仓库的写权限 |
| `The GitHub Source names no repository.` | 在 GitHub 卡片上设置仓库，`owner/name` |
| 工单以 `The prepare command failed: …` 失败 | 输出指明了原因，例如克隆路径错误；修好命令后重试该工单 |
| `git does not read the github.com credential configuration xenra-superagent writes` | 安装 git 2.32 或更新版本 |
| 工单以 `The git configuration of the repository in … sets …` 失败 | 从克隆的 `.git/config` 中删掉被点名的凭据设置或 `http.*.extraheader` 设置 |
| `… was not written by xenra-superagent` | 把被点名的文件移出 `<stateDir>/worker-bin` 或 `<stateDir>/worker-gitconfig`，或换一个 `stateDir` |
| `The bot lark-cli allows user identities` | 把飞书来源指向只允许机器人身份的配置，如上面的飞书机器人一节 |
| `The bot lark-cli does not work.` 或 `The bot identity of app … is …` | 检查该配置的 app id 与 secret |
| `The Feishu bot is not a member of the chat.` | 在群的设置里把机器人加进去；下次尝试就会成功 |
| `status` 退出码为 2 | 某个部分报告错误，重启修不好：`errors` 会点名每个部分（见管理 API 一节）及其详情；各部分恢复正常后会自己清除该条目 |
| `status` 退出码为 3 | 配置在等待：`setup` 说明缺什么，总览会链接到修复它的设置 |
| `status` 退出码为 1 | 服务没有运行、运行了两份、没有响应，或运行时报告错误；输出和最新的日志会说明是哪一种 |
| `… timed out after 90 s`、`… was stopped by …`、`… exited with code …` 或 `… could not run: …` | 某个 CLI 失败但没有打印原因；以运营者用户手动运行被点名的程序，看它自己的消息 |
| 面板说 Xenra-SuperAgent 没有响应 | 它正在重启，或因配置有误而没启动；DeepSeek Harness 的日志会说明原因 |
| `xenra-superagent configuration has keys it does not use`（日志） | 删掉被点名的键；消息会说明每个值现在放在哪里 |
| 日志说该插件与正在运行的 dsh 不兼容 | 安装 `engines.dsh` 范围内的 DeepSeek Harness 版本 |
| 升级 DeepSeek Harness 后面板显示 "Failed to load plugins" | 重启正在运行的实例 |
| @ 之后什么都没发生 | 检查作者是否在来源的允许名单上、来源是否开启、处理是否被暂停。在 GitHub 上，通过编辑 Issue 正文添加的 @ 不会被接收；请在评论里 @ 智能体 |
