# Documentation languages

[中文](TRANSLATING.md) · English

This repository's documentation is written in Chinese first, with English as the counterpart. Both are real documentation: change one, change the other.

## Which file is which

| Chinese (primary) | English (counterpart) |
| --- | --- |
| `README.md` | `README.en.md` |
| `SETUP.md` | `SETUP.en.md` |
| `docs/000-philosophy.md` | `docs/000-philosophy.en.md` |
| Any other `docs/NNN-name.md` | `docs/NNN-name.en.md` |

Each document names the other language on its first line, for example `[English](000-philosophy.en.md) · 中文`.

## Rules

- **Translate the prose; leave the structure alone.** Headings, tables, code blocks, mermaid diagrams and the order and number of numbered sections must match between the two files. `tests/docs.spec.ts` checks numbered order, links and the module and test tables in 007 Architecture.
- **A Chinese document links only to Chinese documents.** A relative link in `006-deployment.md` points at `001-domain.md`; in `006-deployment.en.md` it points at `001-domain.en.md`. The only cross-language link is the switch at the top.
- **Code identifiers are never translated.** Package names, commands, environment variables, configuration keys and tool names (`xenra-superagent`, `XENRA_SUPERAGENT_DIR`, `orchestrator_route`, `stateDir`, `accept`) stay as they are, in backticks.
- **Product and proper names are never translated.** Xenra-SuperAgent, DeepSeek Harness, GitHub, Feishu, Lark, Pull Request, Issue, tmux and git keep their names in both languages.
- **Code, comments and prompts are not translated.** Everything in `src/`, `tests/`, `prompts/`, `skills/` and `lib/` stays in English. This policy covers documentation only.

## Glossary

The domain glossary in [001 Domain model](001-domain.en.md) is authoritative; both languages use the same terms and no others.

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

States and values:

| English | 中文 |
| --- | --- |
| accept / stop / ignore / unavailable | 接单 / 停止 / 忽略 / 未完成 |
| explicit / inferred | 明确 / 推断 |
| pending / running / ended | 待启动 / 执行中 / 已结束 |
| progress / waiting / ready / blocked / failed / dropped | 进展 / 等待 / 就绪 / 受阻 / 失败 / 无需处理 |

## Tone

Write Chinese the way technical documentation usually reads: short sentences, one idea per paragraph, sparing use of "we", no marketing language. Keep the English's judgments at the same strength — a sentence saying the software is not production-ready stays just as direct.
