# 文档翻译说明

[English](TRANSLATING.en.md) · 中文

本仓库的文档以中文为主，英文作为对照。两份都是正式文档，改动一份就要同时改另一份。本篇写给要改文档的贡献者，规则由 `tests/docs.spec.ts` 检查。

## 文件对应关系

成对的文件名只差 `.en` 这一段：

| 中文（主） | 英文（对照） |
| --- | --- |
| `README.md` | `README.en.md` |
| `SETUP.md` | `SETUP.en.md` |
| `SECURITY.md` | `SECURITY.en.md` |
| `docs/TRANSLATING.md` | `docs/TRANSLATING.en.md` |
| 其余 `docs/NNN-name.md` | `docs/NNN-name.en.md` |

`docs/` 下的编号文档从 `000` 开始连续编号，一篇不缺。新增一篇就占用下一个号，并同时在 `README.md` 的文档列表里加一行；不要跳号，也不要只加中文版。

## 开头的语言切换

每份文档的第四行之前必须出现指向另一份的链接。中文版指向英文版，标签写 `English`，后面跟 `· 中文`；英文版指向中文版，标签写 `中文`，后面跟 `· English`。链接目标就是同一篇的另一个语言版本，路径相对于当前文件，例如 [006 部署](006-deployment.md) 开头那一行。这是全文唯一允许的跨语言链接。

## 链接规则

- **只链接同一种语言。** 中文文档里的相对链接指向 `001-domain.md`，英文文档里的指向 `001-domain.en.md`。除了开头的语言切换，任何一条指向另一种语言的 `.md` 链接都算错。
- **编号文档只链编号更小的编号文档。** `docs/00N-*.md` 的 `.md` 链接只能是自己的语言版本，或 `docs/` 下一个编号更小的编号文档。所以 `006` 可以链 `001` 到 `005`，不能链 `007`，也不能链 `README.md` 这类仓库根目录的文档；要提到它们就写文件名，不写成链接。
- **指向非 `.md` 文件的链接不受此限。** 例如 `docs/006-deployment.md` 里的 `../examples/profile.cordis.patch.yml`。
- **每条本地链接都要能解析。** 相对路径按当前文件所在目录解析；不要写绝对路径，不要指向仓库外的文件。仓库根目录的文件从 `docs/` 里用 `../` 引。
- **锚点可选。** 指向小节时可以在路径后加 `#小节标题`，但标题必须与目标文档里的标题一致；改标题要顺手改所有指向它的锚点。

## 翻译什么

- **正文、标题、表格单元格、代码块外的说明文字。** 英文版要读起来像独立写成的一篇英文文档，而不是逐字对照的译文。
- **表格的结构。** 行数、列数、列的顺序和表头含义必须与中文版一致；一行的内容可以按英文语序重写，但不能多一行或少一行。
- **代码块与 mermaid 图的数量与顺序。** 图里的节点文字可以译，节点 id、边和结构不动。

## 不翻译什么

- **代码与命令。** `src/`、`tests/`、`prompts/`、`skills/`、`lib/`、`scripts/` 里的内容继续用英文，包括注释与提示词。`docs/` 里的代码块也一样：命令、环境变量、YAML 键、shell 片段原样保留。
- **标识符。** 包名、插件条目 id、预置 id、配置键、工具名、错误码、文件名与路径都不译，并放在反引号里，例如 `xenra-superagent`、`stateDir`、`XENRA_SUPERAGENT_DIR`、`orchestrator_route`、`agent-preset/not-found`。
- **产品名与专有名词。** Xenra-SuperAgent、DeepSeek Harness、GitHub、Feishu、Lark、Pull Request、Issue、tmux、git、pnpm、Node.js、SQLite 保持原文。
- **宿主提供的界面文案。** DeepSeek Harness 自己的菜单与按钮名按它当前语言写，不要另造译名。

## 术语表

领域术语以 [001 领域模型](001-domain.md) 的术语表为准，两种语言使用同一套词，不另造译名。

| English | 中文 |
| --- | --- |
| Agent | 智能体 |
| Main Session | 主 Session |
| Executor Session | 执行器 Session |
| Source | 来源 |
| Trigger | 触发 |
| Thread | 线程 |
| Correlation | 关联 |
| Channel | 渠道 |
| Policy | 策略 |
| Policy version | 策略版本 |
| Eval | 评估 |
| Gate | 准入 |
| Assessment | 研判 |
| Decision | 决定 |
| Mandate | 授权 |
| Ticket | 工单 |
| Assignment | 派工 |
| Subscription | 订阅 |
| Fan-out | 扇出 |
| Executor | 执行器 |
| Execution environment | 执行环境 |
| Report | 报告 |
| Attention | 待人工决定 |
| Disposition | 去向 |
| Input | 输入 |
| Scope | 范围 |
| Strength | 强度 |

状态与取值：

| English | 中文 |
| --- | --- |
| accept / stop / ignore / unavailable | 接单 / 停止 / 忽略 / 未完成 |
| explicit / inferred | 明确 / 推断 |
| pending / running / ended | 待启动 / 执行中 / 已结束 |
| progress / waiting / ready / blocked / failed / dropped | 进展 / 等待 / 就绪 / 受阻 / 失败 / 无需处理 |

面板的文案另外由 `src/client/locales.ts` 维护，它的术语与本表一致。`tests/locales.spec.ts` 检查两种语言的占位符完全相同，并检查每个错误码与理由码都有措辞；文档里的术语与它冲突时，以它为准并改文档。

## 语气

中文按技术文档的常态书写：句子短，一段说一件事，少用"我们"，不用营销腔，不加表情符号。标点用全角，引号用 `"…"`。与英文一致的判断句保留原有力度，例如"它不是生产就绪的软件"不要软化。

英文用现在时、主动语态，第二人称指运营者，句子短。两边的确定性要一致：中文说"可能"的地方，英文不能写成 "will"。

## 改动流程

1. 先改中文版，它是主版本。
2. 按同样的结构写英文版：标题层级、表格行列、代码块数量与顺序都要对齐。
3. 只改文档时至少跑 `node node_modules/vitest/vitest.mjs run tests/docs.spec.ts tests/locales.spec.ts`；改动涉及代码时跑完整的 `pnpm check`。
4. 两篇文件放在同一个提交里，提交信息说明改了哪一篇的什么。
