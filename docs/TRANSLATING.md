# 文档翻译说明

[English](TRANSLATING.en.md) · 中文

本仓库的文档以中文为主，英文作为对照。这两份都是正式文档，改动其中一份时，另一份要一起改。

## 文件对应关系

| 中文（主） | 英文（对照） |
| --- | --- |
| `README.md` | `README.en.md` |
| `SETUP.md` | `SETUP.en.md` |
| `docs/000-philosophy.md` | `docs/000-philosophy.en.md` |
| 其余 `docs/NNN-name.md` | `docs/NNN-name.en.md` |

每个文档的第一行给出另一份的链接，例如 `[English](000-philosophy.en.md) · 中文`。

## 规则

- **只翻译正文，不动结构。** 标题层级、表格、代码块、mermaid 图、编号小节的顺序与数量，两份文档必须一致。`tests/docs.spec.ts` 会检查编号文档的顺序、链接与架构文档的模块表。
- **中文文档只链接中文文档。** 中文文档里的相对链接指向 `001-domain.md`，英文文档里的指向 `001-domain.en.md`。
- **代码标识符一律不译。** 包名、命令、环境变量、配置键、工具名（`xenra-superagent`、`XENRA_SUPERAGENT_DIR`、`orchestrator_route`、`stateDir`、`accept` 等）保持原样，放在反引号里。
- **产品名与专有名词不译。** Xenra-SuperAgent、DeepSeek Harness、GitHub、Feishu、Lark、Pull Request、Issue、tmux、git 等都保留原文。
- **代码、注释与提示词不译。** `src/`、`tests/`、`prompts/`、`skills/` 与 `lib/` 里的内容继续用英文，本说明只覆盖文档。

## 术语表

领域术语以 [001 领域模型](001-domain.md) 的术语表为准，两份文档使用同一套词，不另造译名。

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

## 语气

中文按技术文档的常态书写：句子短，一段说一件事，少用"我们"，不用营销腔。与英文一致的判断句（例如"它不是生产就绪的软件"）保留原有力度，不要软化。
