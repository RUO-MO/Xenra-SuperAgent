# 006 部署

[English](006-deployment.en.md) · 中文

本篇讲运维：一台机器上跑着什么、需要哪些账号、怎么安装、怎么启停、怎么升级，以及出问题时先看哪里。概念见 [001 领域模型](001-domain.md) 到 [005 面板](005-panel.md)；本篇只讲把它们放到机器上的事。

## 运行着什么

Xenra-SuperAgent 以 DeepSeek Harness 的 bundle 形式分发。它的 `cordis.patch.yml` 往 profile 的条目表里插入三行插件和两行智能体预置，除此之外不改动宿主。

### 插件行

| 条目 id | 插件 | 载入什么 |
| --- | --- | --- |
| `xenra-superagent` | `xenra-superagent` | 应用本体：Store、Engine、来源注册表、执行器、管理路由和面板 |
| `xenra-superagent-github` | `xenra-superagent/github-watch` | GitHub 来源种类及其轮询循环 |
| `xenra-superagent-feishu` | `xenra-superagent/feishu-watch` | 飞书来源种类及其循环，默认启用；拿到机器人 CLI 之前一直空闲 |

三行都由 bundle 提供，profile 的 `cordis.patch.yml` 只需给本体那一行补上 `stateDir`，见"机器配置"。

本体插件注入宿主的 `agents`、`sessionController`、`sessionPersistence`、`workspaceRegistry`、`permissionPresets`、`tools`、`systemPrompt`、`skills`、`webServer`、`llm` 和 `subprocess`，并关掉 DeepSeek Harness 自动生成的设置页，因为面板自带设置界面。

### 智能体预置与会话

bundle 还插入两行 `@deepseek-ai/dsh-agent-preset`，定义本应用自己用的两个预置：

| 预置 id | 名称 | 谁在用 |
| --- | --- | --- |
| `xenra-superagent-worker` | Xenra-SuperAgent 执行器 | 每个工单的执行器 Session，会话 id 为 `worker-<工单 id>` |
| `xenra-superagent-router` | Xenra-SuperAgent 主 Session | 主 Session，会话 id 记在 `KV.runtime.masterId` 下，首次启动时由 `stateDir` 推导 |

两者都出现在 DeepSeek Harness 的预置列表里，但没有设置能把它们从选择器里藏起来，所以名称和描述写明不供手动选择。不要为个人 Session 选它们，也不要删掉这两行：Session 创建时记下预置 id，恢复时会按 id 找回预置，缺了它，恢复失败并报 `agent-preset/not-found`。

两个预置的差别有两处。工具：执行器拿到文件、搜索、shell 与作业、web、技能、todo 和子智能体；主 Session 只拿到 `skill`、`read`、`read_image` 和三个作业工具，没有 shell、写入、搜索和 web。角色前缀：执行器有一条 `You are a coding agent powered by the {{model}} model.` 的 persona，主 Session 没有，因为它的提示词本身已经完整（`complete: true`）。两个预置的 shell 与作业等待都在 5 秒后转入后台，好让一条长命令不挡住下一步。Web UI 里新开一个空 Session 时，宿主可能先选中 profile 的默认预置；第一轮之前，`Sessions` 会把角色预置选回去。

### 权限与隔离

两个预置创建出来的 Session 都按运营者的操作系统用户运行，并被设成 `danger-full-access`。应用写下的东西都不是安全边界：

- `<stateDir>/worker-bin` 里的包装脚本让 `gh`、`lark-cli` 以智能体的身份行事，并让被禁止的命令按名字失败；按绝对路径调用仍能运行。
- `<stateDir>/worker-gitconfig` 只把 github.com 的凭据助手指向智能体的 CLI；它拦的是配置来源，不是进程。
- **它不会改动你机器上已有的任何 git 配置。** 所有写入都在 `<stateDir>` 里：不改你的全局 `~/.gitconfig`、不改系统级配置、不改任何仓库自己的配置，也不往宿主进程的环境变量里写东西。因此其他主机（例如 codeup、GitLab）的凭据来源照常工作，DSH 里其他会话和你自己的终端也不受影响。
- 执行器读的是自己那份 `worker-gitconfig`，其中没有把 `[credential] helper` 清空的那一行——清空会把**所有**主机的凭据助手一并清掉。它只重定向 github.com，其他主机仍走机器上原有的助手；同时它不读系统级 git 配置，所以系统级的凭据助手不会在 github.com 上替智能体回答、把运营者本人的 token 交出去。
- 每个工单的执行目录只按目录分开工作，不隔离权限。

执行器能按路径执行任意程序，也能读运营者的主目录。要真正隔离，请给智能体一个只含它自己凭据的专用操作系统账号。

## 前置条件

- Node.js `^22.19.0` 或 `>=24`、pnpm、git 2.32 或更新、GitHub CLI（`gh`）2.48 或更新。
- 处于 `engines.dsh` 范围内的 DeepSeek Harness，当前为 `^0.2.2-rc.1`；仓库构建与测试所用的是 `0.2.2-rc.2`。
- 为 DeepSeek Harness 配好的模型服务。除非"评估"或"执行"设置里另指名，两个角色都用该 profile 的默认模型。
- Python 3 与 tmux：`scripts/xenra-superagent` 是一个 Python 脚本，用 tmux 承载服务进程，用 `ps` 找进程。
- github.com 上的一个仓库。GitHub Enterprise Server 不受支持：git 配置与 API 调用都写死为 github.com 和它上面的路径。
- 要为每个工单生成检出时，保留一个本地克隆，好让 prepare 命令在它上面添加 worktree；仓库用 Git LFS 时还要装 `git-lfs`。

**插件本身在 Windows 上可用。** 与平台有关的部分都收在 `src/infra/platform.ts` 一处回答：

- **包装脚本**（`gh`、`lark-cli`、被阻断的命令）在 Windows 上写成 `.cmd` 批处理文件，而不是 `#!/bin/sh` 脚本，因为 Windows 不能执行 shell 脚本，命令是按 PATHEXT 扩展名找到的。两者带同一个标记，所以另一个平台留下的包装脚本会被替换而不是拒绝。
- **prepare 命令**经 `cmd /d /s /c` 运行，planner 写的是 `cmd` 语法而不是 `sh` 语法。
- **配置探测**把目录列表放在子进程的环境变量里传入，而不是借 `env` 这个前缀程序。
- **可执行文件查找**在 Windows 上会依次尝试 `.exe`、`.com`、`.bat`、`.cmd`、`.ps1`，所以 `gh` 能找到 `gh.exe` 或 `gh.cmd`。
- **worker 的 git 配置**在 Windows 上把 `!` helper 里的路径写成正斜杠，因为 Git for Windows 用它自带的 `sh` 运行该 helper。

仍然只支持 POSIX 的是 **`scripts/xenra-superagent`**：它是 Python 脚本，用 tmux 承载服务进程、用 `ps` 找进程、用 `os.kill` 发送 SIGINT。在 Windows 上可以直接用 `dsh --profile <名字>` 启动，然后用 `GET state` 或面板判断它是否就绪；需要脚本那套启停与退出码时，请在 WSL 里运行它。

`tests/fixtures/platform.ts` 记录了这个边界：需要 `#!/bin/sh` 包装、`tmux`、`ps` 或 `chmod` 权限位的用例在 Windows 上以 `it.skipIf` 跳过，其余用例（含 Windows 自己的包装脚本与 shell 形态）照常运行。

## 账号

### 智能体 GitHub 账号

1. 为智能体建一个 GitHub 用户账号，并给它该仓库的写权限。GitHub App 不能充当智能体：应用要读该账号的通知，这条链路只有用户账号有。
2. 给它一个只用自己凭据的 GitHub CLI：

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

   以智能体账号登录；最后一条命令打印它的登录名。应用用同样的方式读登录名，并顺带读出账号 id，用 `<id>+<login>@users.noreply.github.com` 作为执行环境里的提交邮箱。

   保存来源设置时，应用会调 `repos/<owner>/<name>` 并要求 `permissions.push` 为真；为假时提示"`@… cannot push to …`"。所以写权限必须在保存之前就有。

### 飞书机器人（可选）

1. 建一个带机器人能力的自建应用，授予接收消息事件、读写群消息、读取群成员的权限，然后发布应用版本。
2. 给机器人一份自己的、只允许机器人身份的 `lark-cli` 配置和一个包装脚本：

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

   第一条命令从标准输入读 app secret。请用独立目录：`lark-cli` 每个 app id 只允许一份 profile，而你的个人配置里可能已有该应用的用户登录。

   应用只接受机器人身份。配置检查读 `auth status`（`appId` 形如 `cli_…`、`brand` 为 `feishu` 或 `lark`、`identities.bot.status` 为 `ready`）、`config strict-mode`（输出里 `strict-mode: bot`）和 `/open-apis/bot/v3/info` 返回的 `open_id`。任何一项不满足，飞书来源就停在那条问题上，其余部分照常运行。

   两份配置共用同一个 keychain 里的 app secret。只想删机器人配置时删掉它的目录，不要跑 `lark-cli config remove`，那会动到共用的 secret。

## 安装

在一台还没有 `xenra` profile 的机器上，执行一次：

```sh
npm install -g @deepseek-ai/dsh@0.2.2-rc.2
git clone <this repository> xenra-superagent && cd xenra-superagent
pnpm install && pnpm build
dsh xenra --from-default-profile web --dump-config > /dev/null
dsh plugin --profile xenra add "link:$PWD"
```

第一条装的是满足 `engines.dsh` 的 DeepSeek Harness；换用别的版本也行，但要落在 `^0.2.2-rc.1` 内。

第四条从 DeepSeek Harness 的 Web 模板创建 `~/.dsh/profiles/xenra`，`DSH_HOME` 可以改变这个默认目录。这一条只用于全新安装：profile 已存在时它会替换该 profile 并删掉它的 `cordis.patch.yml`，连同机器配置。升级时不要运行它。

第五条把本仓库以 `link:` 方式装进那个 profile，这样改动 `src/` 之后重新构建即可生效。也可以走 DeepSeek Harness 的插件管理器装上同一个包，效果一样。仓库里提交了构建产物 `lib/`，所以 `link:` 安装不需要先构建；只有改过 `src/` 之后才要重新运行 `pnpm build`。

装完先补机器配置（下一节），再启动。

## 机器配置

把 [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) 复制为 `~/.dsh/profiles/xenra/cordis.patch.yml`，替换其中每个 `<placeholder>`。该示例同时设置 Web 服务器与状态目录：

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3082
- id: xenra-superagent
  config:
    stateDir: /home/me/.dsh/state/xenra-superagent
```

管理 API 要求 Web 服务器绑在 `127.0.0.1`；换成别的地址，插件拒绝启动。端口任意，示例用 3082——那也是 `scripts/xenra-superagent` 默认查健康状态的地址。换了端口，面板和新地址仍然对得上（页面走相对路径），但脚本要用 `--url` 或 `XENRA_SUPERAGENT_URL` 跟上，否则它会把运行中的服务当成没有应答，以 1 退出。

`xenra-superagent` 行的键：

| 键 | 必需 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `stateDir` | 否 | `<home>/.dsh/state/xenra-superagent` | 绝对路径：数据库、锁、`worker-bin` 里的命令包装脚本、智能体的 git 配置，以及默认情况下的 `work` 下的工单目录 |
| `promptMaxChars` | 否 | `100000` | 已保存提示词配置的最大长度，取值 1000 至 1000000 |
| `admissionContextMaxPages` | 否 | `10` | 一次研判最多读多少页线程，取值 1 至 100 |
| `admissionContextTimeoutMs` | 否 | `15000` | 一次研判读取上下文的时限，取值 1 至 90000 毫秒 |

`stateDir` 默认是 `<home>/.dsh/state/xenra-superagent`，所以刚装上的插件就能启动，并从面板完成配置——要设置它的界面正是插件自己提供的，若它缺了就不启动，就没有地方可设。改动它等于换一份状态：插件会重新挂载，`stateDir` 里的数据库、工单和记录不会带到新目录，所以换目录等于从零开始。面板里它在 **设置 › 部署**，而这个分组没有左侧的导航入口：日常从首页的 **系统问题** 点进来，或在 DeepSeek Harness 的插件管理器里打开本插件，也可以直接改 profile 的 `cordis.patch.yml`。

三个上限与 `stateDir` 都在 **设置 › 部署** 里改，DeepSeek Harness 的插件管理器打开的是同一个页面。三个上限是易变的，保存后立即生效；`stateDir` 改动后插件会重新挂载，页面会提示这一点，几秒后显示新位置。

配置里出现未知键时插件拒绝启动，日志会点名是哪一个键，并说明旧键搬去了哪里：`repository`、`github` 现在在 GitHub 来源上，`branchPrefix`、`repositoryPath` 在"执行"的 prepare 命令里，`worktreeRoot` 是"执行"的目录根，`blockedCommands` 在"执行"设置里，`author` 是提示词文本。升级前请备份 `stateDir`。

飞书来源默认启用，不需要改配置文件：它在拿到机器人 CLI 之前一直空闲。装上后在 **设置 → 来源** 的飞书卡片里填上那个 CLI 就生效。只有想彻底不用它时，才需要在同一个文件里关掉：

```yaml
- id: xenra-superagent-feishu
  disabled: true
```

## 启停

```sh
scripts/xenra-superagent start
scripts/xenra-superagent status
scripts/xenra-superagent restart
scripts/xenra-superagent stop
```

`start` 在 tmux 会话 `dsh-<profile>` 中用 `dsh --profile <profile> --no-open` 启动服务，工作目录是检出根目录。它最多等一分钟（`--timeout`）等运行时进入 `ready` 或 `paused`。它拒绝重复实例：同一 profile 有两个服务进程时直接报错，脚本之外启动的实例也算；URL 上已有实例应答时同样拒绝。

`stop` 给服务进程发 `SIGINT`，最多等 300 秒（`--stop-timeout`）让它走完关闭流程，从不强杀，也不碰其他 tmux 会话。`restart` 是同一个停止加一次启动。

`status` 打印一段 JSON：`pids`、`cwd`、`url`、`manually_stopped`、`health`（每项一个状态）、`errors`（状态为 `error` 的部件及其详情）、`setup` 与 `feishu`（缺失的配置）。

换 profile 或端口时用 `--profile` 和 `--url`，或设置 `XENRA_SUPERAGENT_PROFILE` 与 `XENRA_SUPERAGENT_URL`。

`status`、`start` 和 `restart` 的退出码是四种之一：

| 退出码 | 含义 |
| --- | --- |
| 0 | 服务正常运行 |
| 1 | 没有运行、运行了两份、没有应答，或运行时自身报错；重启可能修好 |
| 2 | 在运行，但运行时之外的某个部件报错，例如某个来源或某次允许名单同步（`sync:<来源 id>`）；重启修不好 |
| 3 | 在运行，且在等配置；重启修不好 |

仍在启动的来源算正常运行；配置阶段无法检查的飞书机器人也不算错误。每类效果队列的失败、执行器的事故都算在 2 里。

每次运行都在检出根目录的 `.artifacts/` 下留文件：

- 启动日志 `xenra-superagent-<profile>-<日期>-<时间>-<脚本 pid>.log`，只保留最新 20 份。
- 控制目录 `control/profiles/<profile>/`，含停止标记 `manually-stopped`、`service.pid` 和操作锁 `operation.lock`。

打开日志里打印的 URL，在侧栏选择 **Xenra-SuperAgent**：全新安装会先落在 **首次配置引导** 上，配好之后落在 **首页**。DeepSeek Harness 的插件管理器里也有一行本插件，点开是同一个部署页面。

服务进程被关闭时，正在运行的执行器先走完当前一步；重启过的执行器会在下次启动时按"被中断的派工"处理，见 [003 执行](003-execution.md)。

## 每小时检查

在你自己日常使用的 DeepSeek Harness profile 里安排这个检查，不要建在 `xenra` 里：它必须在智能体服务停掉时仍能运行。请那个 profile 里的智能体按下面的提示词建一个每小时计划，并把检出路径填进去：

```text
Check Xenra-SuperAgent: run `scripts/xenra-superagent --profile xenra status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/xenra-superagent --profile xenra --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/xenra-superagent-xenra-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

这段提示词只做四件事：正常就沉默，部件报错就报给人，等配置就报缺什么，进程不在才重启并回报结果。它不会在有意的停止之后把服务拉起来。

`--respect-stop` 保留有意的停止。只有 `stop` 写停止标记；`start` 清掉它，`restart` 里那一次启动也一样清掉。因此 `stop` 之后的自动检查会一直安静，直到有人显式 `start`；而一次超时的 `restart` 留下的标记会被它自己那次启动清掉，检查可以放心重试。

## 设置

配置成功之前，轮询、研判和派工都不会开始。全新安装打开面板时先看到 **首次配置引导**，而不是空空的首页：四步依次问监听哪个仓库与用哪个账号干活（两项一起保存，来源会立刻核对推送权限）、接不接飞书（可跳过）、谁可以派活、在哪里干活，每一步保存后立即生效，也可以跳过、以后在设置里配，见 [005 面板](005-panel.md)。配置有问题时，首页的 **系统问题** 逐条列出缺什么，并链接到修复它的设置项；部署层面的问题（状态目录、git、执行环境）属于这台机器，不进入引导，只在首页列出。

面板只有三个标签页：**首页**、**工单**、**设置**。设置页有四个日常分组：来源、评估、执行、提示词；部署分组没有导航入口，日常只从首页的系统问题进入，或者在 DeepSeek Harness 的插件管理器里打开本插件。策略不是单独的分组：策略的规则、每个来源的名单与准入表都在 **评估** 下。改动会再次运行配置；如果是应用之外修好的东西（例如给 CLI 登录、升级 git），点 **重新检查** 让配置重跑一次——配置没有可修的问题时，这个操作会被拒绝（`Setup is complete`）。

1. **来源。** 分组顶部先列出每个来源的状态、近 24 小时的到达与被过滤计数、被过滤的触发和被放弃发送的消息，再是配置它的卡片。填 GitHub 仓库（`owner/name`）和智能体 CLI，例如 `/home/me/.local/bin/gh-agent`。请求通常经智能体账号的通知到达：新 Issue、@ 该账号的评论在下一轮轮询时进来；用编辑 Issue 正文的方式加 @ 不会进来，请改为发表新评论。四个全量接收开关默认关闭，打开后连没有 @ 智能体的新 Issue、新 PR、评论和默认分支 CI 也一并接收，再由准入表决定它们能否成为候选。使用飞书时填机器人 CLI、群列表（每群是全量还是仅 @）、其他群和是否接收私信。

   保存仓库或账号字段会先做一次账号检查，然后重启应用；重启期间面板短暂不可用。

2. **评估。** 先是策略，再是评估设置。**策略**：两条示例规则可以改也可以删；在 **在各来源上** 下添加可以发起工作的 GitHub 账号和飞书用户，名单为空时任何请求都成不了工单；准入表按接收范围、发送者是否在名单上、消息是否针对智能体决定强度，见 [002 授权](002-authorization.md)；机器人名单里的机器人只能产生推断候选。使用飞书时，可以从一个群同步名单，在启动时和点 **立即同步** 时执行，同步失败会出现在 `sync:feishu` 下并按分钟到小时退避重试。**评估设置**：接单模式（关闭、仅观察、自动接单）、单次评估时限（30 至 600 秒）和研判模型。

3. **执行。** 目录根、prepare 命令、并发数（1 至 16）和被禁止的命令。要给每个工单一份仓库检出：

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$XENRA_SUPERAGENT_GITHUB_REPOSITORY.git" "${XENRA_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/xenra-superagent/$XENRA_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$XENRA_SUPERAGENT_NAME" "$XENRA_SUPERAGENT_DIR" "refs/xenra-superagent/$XENRA_SUPERAGENT_TICKET"
   ```

   被禁止的命令按名字让执行器里的调用失败，用来挡住你自己账号的 CLI；`gh`、`git`、`lark-cli` 不能禁止。目录根和 prepare 命令只能在面板里改，主 Session 的工具改不动它们。

4. **提示词。** 编辑团队小节（沟通方式、工单范围、交付要求）、内置分段和技能。内置分段有默认文本，改过之后会记录它是从哪个版本改的；升级让默认值变了会标为 **默认已更新**。这里改的是智能体被告知什么，不是它被允许做什么：工具权限、准入和账号包装脚本都在别处。

5. **部署。** 没有导航入口，从首页的系统问题（或在插件管理器里打开本插件）进入；显示启动问题与 **重新检查**、`stateDir` 和三个上限。上限改动立即生效。DeepSeek Harness 的插件管理器打开的是同一个页面。

## 管理 API

面板走一个只在本机回环上的 HTTP API，智能体和服务脚本也可以调它：`scripts/xenra-superagent status` 读 `GET state`，`SETUP.md` 里的流程用 `PUT` 保存设置块。

请求发到 `http://127.0.0.1:<端口>/orchestrator/api/`，并带上 `x-orchestrator-request: 1`。`Host` 必须是 `127.0.0.1:<端口>` 或 `localhost:<端口>`；缺头部，或 `Origin` 来自别的站点，都收到 403 `Same-origin management request required`。Web 服务器不绑在回环地址上时，插件直接拒绝启动。

用 API 保存拥有和面板一样的权限：`origin` 是 `panel`，因此能改执行环境与配置用的账号字段。主 Session 的工具保存改不了这两类（`panelOnlyEnvironment`、`panelOnlyAccounts`）。

下面这些路由与字段可以依赖；`src/app/api.ts` 里还有服务面板的路由，它们随面板变化。

| 请求 | 答复 |
| --- | --- |
| `GET state` | 每个页面读的内容：`setup`，含 `machine`（`stateDir` 与三个上限）、`problem` 与 `feishuProblem`（各自为 `null` 或带 `place`、`code`、`values`、`detail` 的配置问题），以及解析成功后的 `accounts`（`repository`、`agent`、`feishu`）；`load`（`running` 的执行器、`queued` 的工单、`maxWorkers`）；`masterId`；`paused`；`health` |
| `GET settings` | `policyVersion`；`blocks`（`policy`、`eval`、`executor`，各含 `value` 与 `revision`）；`sources`（每个实例的 `id`、`kind`、`title`、`description`、`installed`、`value` 即 `{"enabled": …, "config": {…}}`、`revision`、保存后会重启的字段 `restarts`、它种类的 `fields` 与 `facts`、显示名 `labels`、有问题时的 `problem`，以及它在策略中的部分 `policy`：`fields`、`explicit`、`rows`、`sync`）；`environment`（`root` 与 `variables`） |
| `GET sources` | 每个来源的状态：`state`（`missing`、`off`、`error`、`setup`、`starting`、`paused` 或 `ready`）、各部分 `health`、`problem`、最近一天的 `stats`、该日被它 `filtered` 的触发，以及该日被它 `dropped` 的消息（最新在前，每条含 `channel`、`preview`、属于某个工单时的 `ticket`、存储中存在时的 `thread`，以及 `dropped.at` 与 `dropped.reason`：`channelGone` 或 `channelIgnored`） |
| `PUT settings/<block>`，`{"value": …, "revision": n}` | 保存一个块：`saved`、新 `revision`、`policy_changed`、`restarting`、`context_delivery`。`block` 取 `policy`、`eval`、`executor` 或 `source:<来源 id>`；`value` 是整个块，形式同 `GET settings`；缺失的键取默认值 |
| `POST executor/pause`，`{"paused": true}` 或 `false` | 暂停或恢复处理：`paused` |
| `POST setup/check` | 通过重启应用再跑一次配置：`restarting: true`。配置没有可修的问题时返回 400 |
| `POST policy-sync/<来源 id>` | 立刻同步该来源的允许名单：`policy`，即保存后的来源部分 |
| `GET prompts` | `current`（含 `revision` 与 `config`）、`defaults`、`sections`（团队小节）、`skillName`（团队技能名的模式）、`builtin`（团队技能不能使用的名字）、`skillPrefix`（Session 加载技能名时使用的前缀）、`parts`（内置分段及其 `base`）、`defaultChanged`、各 Session 的提示词版本与历史 |
| `PUT prompts`，`{"config", "baseRevision"}` | 保存提示词配置：新 `revision`、`effect: "next-request"` 与 `context_delivery` |
| `POST prompts/preview` | 只组装不保存：两个角色的完整提示词与各分段 |
| `POST tickets/<id>/retry`、`POST tickets/<id>/stop` | 与面板一样重试或停止工单，答复 `retried` 或 `stopped` |
| `GET tickets`、`GET tickets/<id>`、`GET threads`、`GET threads/<key>`、`GET decisions`、`GET overview`、`GET search` | 面板各页读的视图，过滤条件见 `src/app/api.ts` |
| `POST triggers/<id>/requeue`、`POST decisions/<id>/dismiss`、`POST threads/<key>/unsubscribe`、`POST sources/<id>/labels` | 与面板按钮等价的操作 |

健康项按职责分组：

| 键 | 报告内容 |
| --- | --- |
| `runtime` | 应用本身；巡检失败时在这里 |
| `models` | 正在等模型预算重试的 Session |
| `evals` | 最近一小时未完成、且此后没有新判断也未被忽略的评估 |
| `assessment`、`launch`、`delivery`、`relay`、`notice`、`reply` | 副作用队列的六类工作，见 [003 执行](003-execution.md)；`delivery` 的失败显示在工单上而不是这里 |
| `worker` | 执行器 Session 的事件处理；第一次失败之后才出现 |
| `github`、`feishu`、`history` | 来源轮询、事件消费与历史补收 |
| `sync:<来源 id>` | 允许名单同步 |

拒绝会带状态码和英文原文 `error`：

- 400：无效的值（附 `issues`，各含 `path`）、账号检查失败（附 `setup`）、固定拒绝（附 `code` 与 `values`），或请求体不是 JSON、超过上限。
- 404：不存在的东西。
- 409：过期的修订号。
- 500：其他一切。

请求体上限是 128 KiB，提示词保存是 `4 × promptMaxChars + 4096` 字节。保存过程中修订号变了的，返回 409，需要重新读取后再存。

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

改仓库或 CLI 会先跑对应的账号检查；失败返回 400，详情在 `setup` 里。账号改动成功，或配置待完成期间的任何保存，都返回 `restarting: true`，应用随后重启。

## 配置检查

配置走 DeepSeek Harness 的子进程服务，和执行器 shell 一样，因此子进程里名字含 KEY、PASSWORD、SECRET 或 TOKEN 的环境变量会被宿主去掉——执行环境里不放凭据也是这个原因。

配置做三件事：

1. 校验 GitHub 仓库与智能体的推送权限，读飞书机器人身份；飞书失败只停用飞书来源，其余照常。
2. 写执行环境：`<stateDir>/worker-bin` 里的包装脚本（`gh` 运行智能体的 CLI，`lark-cli` 运行机器人的 CLI 或直接失败，被禁止的命令失败），以及 `<stateDir>/worker-gitconfig`。包装脚本在转交目标之前把自己的目录从 `PATH` 里去掉，所以包装脚本里按名字找 `gh` 也能到真正的二进制。
3. 应用进程环境：设置 `GIT_CONFIG_GLOBAL`、`GIT_CONFIG_NOSYSTEM`，清掉 `GH_TOKEN`、`GITHUB_TOKEN`、git 位置变量与提交身份变量，并把 `worker-bin` 排在 `PATH` 最前；随后用 `git config --show-origin` 复核 github.com 的凭据助手确实来自那份配置，不是就报 `gitTooOld`。

包装脚本排在 `PATH` 最前，因此执行器里的 `gh` 就是智能体的 `gh`。`worker-gitconfig` 取代运营者的全局与系统 git 配置，HTTP 代理之类的个人设置不会生效；它把 GitHub 的 SSH 地址改写成 HTTPS，并定义 Git LFS 过滤器；提交身份不在这里设，由提示词指定，`user.useConfigOnly` 让没有身份时报错而不是猜一个。

`worker-bin` 或 `worker-gitconfig` 里出现不是本应用写入的文件（首两行没有写入标记），配置失败并点名该文件，不覆盖它。工单目录如果处在一个自身配置写了凭据或 `http.*extraheader` 的仓库里，该工单失败并说明要删掉的键。

## 试一试

用一个在允许名单上的 GitHub 账号，开一个 Issue，或发表一条包含 `@<智能体登录名> <请求>` 的评论。在一个轮询周期内（默认 60 秒），**首页** 的 **待处理工单** 或 **工单** 页的 **进行中** 列表里应出现一张工单。智能体会在原对话里确认，在自己的 Session 和自己的目录里做完，然后把结果发回原处，通常是一个 Pull Request。

用飞书时，在已配置的群里 @ 机器人，或在允许的群里直接发消息（全量接收时），私信同样可用。

## 升级

1. 等到没有执行器正处于一轮的中间。
2. 备份 `<stateDir>/orchestrator.sqlite`。
3. 运行 `git pull && pnpm install && pnpm build`。
4. 运行 `scripts/xenra-superagent restart`，再 `status` 确认退出码为 0。

重启会结束正在运行的派工，并以恢复说明启动替代者。团队文本和覆盖过的提示词分段保留，没有覆盖的分段跟随新默认值；升级后请检查标为 **默认已更新** 的分段。

被新版本迁移过的数据库无法被旧版本打开：schema 版本只增不减，旧版本遇到更高版本会报 `Unsupported orchestrator database version`。回滚要连同升级前的备份一起回滚。当前 schema 是 11，启动时会把 schema 10 的数据库一次性迁移；更旧的直接拒绝，并提示用新的状态目录。

升级 DeepSeek Harness 本身之后，请重启正在运行的实例，让面板加载与宿主匹配的产物；否则插件页会加载失败。

### 从 dsh-superagent 升级

本项目曾以 `dsh-superagent` 为名。包名、插件条目、预置、技能、脚本和环境变量现在分别是 `xenra-superagent` 与 `XENRA_SUPERAGENT_*`。以旧名完成的安装仍然能用，因为读回时会按新名解释：

- `worker-bin` 与 `worker-gitconfig` 里以旧名写入的文件仍被认作本应用写的，会被替换。
- 保存的提示词文本和 prepare 命令里的 `DSH_SUPERAGENT_*` 在迁移时改写成 `XENRA_SUPERAGENT_*`，`dsh-superagent-*` 的技能与变量前缀同样改写。
- 以旧来源送达的消息仍按原来的 id 去重，不会重复发送。
- GitHub 评论上的隐藏标记两种名字都认。

只有 profile 配置不会自动迁移，请手动改一次：

1. 在 `<profile>/cordis.patch.yml` 里把条目 `dsh-superagent` 改名为 `xenra-superagent`，把 `dsh-superagent-feishu`、`dsh-superagent-github` 改为 `xenra-superagent-feishu`、`xenra-superagent-github`。保留各自的 `stateDir`，这样会复用已有的数据库和工单。
2. 在原来设置 `DSH_SUPERAGENT_PROFILE` 与 `DSH_SUPERAGENT_URL` 的地方改设 `XENRA_SUPERAGENT_PROFILE` 与 `XENRA_SUPERAGENT_URL`，并把每小时检查指向 `scripts/xenra-superagent`。
3. 在侧栏选择 **Xenra-SuperAgent**；DeepSeek Harness 插件管理器里本插件的条目是新的那个。
4. 升级后启动一次，打开 **首页** 确认工单还在，再从 **设置 › 高级视图** 看一眼判断记录与线程，最后删掉旧的条目行。

改名之前恢复出来的 Session 会保留它们创建时用的预置 id，而那些 id 已经不存在，恢复会失败。等升级前的执行器和主 Session 都不再需要之后，删掉它们所在的旧会话即可；这些 Session 本身可以从 DeepSeek Harness 里删掉。

## 智能体预置

两个预置行的作用只有一个：让 Session 在创建和恢复时找得到自己要用的预置。

- **不要删。** 只要有 Session 还在用它们，删掉后恢复就报 `agent-preset/not-found`。要删，先确认对应的 Session 都已结束并删除。
- **不要为个人 Session 选它们。** 执行器预置没有向人提问、展示、计划模式这些工具；主 Session 预置只读不写，也没有 shell。
- **预置的选择会被纠正。** Web UI 在第一轮之前给 Session 选了别的预置时，`Sessions` 会把角色预置选回去；第一轮之后宿主不再允许改选择。
- 预置行没有"在列表里隐藏"的设置，所以名称和描述直接写明用途。

## 故障排查

配置问题在面板上按界面语言显示，并链接到修复它的位置；日志和 API 里是下面这些英文原文。

| 现象 | 原因与修复 |
| --- | --- |
| 插件拒绝启动，日志说配置里有不用的键 | 按提示删掉被点名的键，并把它搬到提示的新位置（见"机器配置"） |
| 插件拒绝启动，日志说需要回环 Web 服务器 | 把 profile 的 `webserver.host` 改回 `127.0.0.1` |
| `Orchestrator database schema N predates schema 10` | 这个渠道的数据库来自更早的原型，无法迁移；换一个新的 `stateDir` |
| `Unsupported orchestrator database version N` | 数据库被更新的版本迁移过；回滚需要升级前的备份 |
| `The agent GitHub CLI is not set.` | 在 GitHub 卡片上填智能体的 CLI |
| `The agent GitHub CLI was not found.` | 填包装脚本的绝对路径，或 `PATH` 上的命令名 |
| `The agent GitHub CLI cannot read its account.` | 对那个包装脚本跑 `auth login` |
| `The agent GitHub CLI did not report a GitHub account.` | 同上：登录后 `api user` 要能打印登录名 |
| `@… cannot read …` / `@… cannot push to …` | 给智能体账号该仓库的写权限，或确认仓库名写对 |
| `The GitHub Source names no repository.` | 在 GitHub 卡片上填 `owner/name` |
| `The bot lark-cli does not work.` | 检查机器人配置文件与包装脚本的路径，确认 `lark-cli auth status` 能跑通 |
| `The bot identity of app … is …` | 用 app secret 重新 `config init`，让机器人身份变成 `ready` |
| `The bot lark-cli allows user identities (strict mode …)` | 给机器人一份独立的、`strict-mode bot` 的配置，见"飞书机器人" |
| `The Feishu bot is not a member of the chat.` | 在群设置里把机器人加进去；下次尝试就会成功 |
| `… was not written by xenra-superagent` | 把被点名的文件移出 `worker-bin` 或 `worker-gitconfig`，或换一个 `stateDir` |
| `git does not read the github.com credential configuration xenra-superagent writes` | 消息里带着实际运行的 git 版本与它返回的值。到"设置 → 部署"的 **本机设置** 一栏看 **升级 git…**：它会先显示要运行的命令（`winget`、`brew`、`apt` 等，按机器上找到的包管理器）以及这一步会改动什么，你确认后才执行；不想用它可以关掉对话框、自己在终端升级，再点 **重新检查**。没有可用包管理器时它会说明，并给出手动升级的目标版本 |
| `Preparing the agent environment failed.` 且详情是权限错误 | 让 `stateDir` 对运行 DSH 的操作系统用户可写；若它属于别的用户，换一个目录 |
| 工单以 `The prepare command failed: …` 失败 | 输出说明了原因，例如克隆路径错、凭据缺失；修好命令后重试该工单。这种失败不会被自动重试 |
| 工单以 `The git configuration of the repository in … sets …` 失败 | 从克隆的 `.git/config` 里删掉被点名的 `credential.*` 或 `http.*extraheader` |
| `… timed out after 90 s`、`… was stopped by …`、`… exited with code …`、`… could not run: …` | 某个 CLI 失败但没打印原因；以运营者用户手动跑一次被点名的程序，看它自己的消息 |
| `status` 退出码 2 | 某个部件持续报错，重启修不好；`errors` 点名每个部件及其详情，恢复后条目自己消失 |
| `status` 退出码 3 | 配置在等：`setup` 说明缺什么，首页的系统问题会链接到修复它的设置 |
| `status` 退出码 1 | 服务没运行、运行了两份、没应答，或运行时自身报错；输出和最新日志说明是哪一种 |
| 面板说连不上服务 | 应用正在重启，或因配置有误没起来；看最新的 `.artifacts/` 日志 |
| 面板显示 "Failed to load plugins" | 升级过 DeepSeek Harness；重启正在运行的实例 |
| 保存返回 `Setup is complete` | 配置已经健康，**重新检查** 无事可做；改设置本身即可 |
| 保存返回 `Settings changed. Reload before saving.` | 修订号过期；刷新后重新编辑 |
| 保存返回 `The execution environment … can only be changed in the management panel` | 该字段只能从面板或管理 API 改，主 Session 的工具改不了 |
| 保存返回 `The {block} model is not available: …` | 模型服务没配好，或该 provider/model 不可用 |
| `@` 之后什么都没发生 | 确认作者在该来源的允许名单上、来源已启用、处理未暂停；GitHub 上通过编辑正文加的 @ 不会被接收，请在评论里 @ |
