# Documentation languages

[中文](TRANSLATING.md) · English

This repository's documentation is written in Chinese first, with English as the counterpart. Both are real documentation: change one and you change the other. This document is for the contributor editing them; `tests/docs.spec.ts` enforces the rules.

## Which file is which

A pair differs only by the `.en` segment:

| Chinese (primary) | English (counterpart) |
| --- | --- |
| `README.md` | `README.en.md` |
| `SETUP.md` | `SETUP.en.md` |
| `SECURITY.md` | `SECURITY.en.md` |
| `docs/TRANSLATING.md` | `docs/TRANSLATING.en.md` |
| Any other `docs/NNN-name.md` | `docs/NNN-name.en.md` |

The numbered documents under `docs/` run consecutively from `000` with no gaps. A new one takes the next number and adds a line to the document list in `README.md`; do not skip a number, and do not add the Chinese version alone.

## The language switch at the top

Every document names the counterpart within its first four lines. The Chinese version points at the English one with the label `English` and then `· 中文`; the English version points at the Chinese one with the label `中文` and then `· English`. The target is the same document in the other language, relative to the current file — [006 Deployment](006-deployment.en.md) opens with one. This is the one cross-language link a document may have.

## Link rules

- **Link only within one language.** A relative link in a Chinese document points at `001-domain.md`, and in an English document at `001-domain.en.md`. Apart from the switch at the top, any `.md` link that points at the other language is an error.
- **A numbered document links only to lower-numbered numbered documents.** A `.md` link in `docs/00N-*.md` is either its own language counterpart or a `docs/` numbered document with a lower number. So `006` may link `001` through `005`, but not `007`, and not a repository-root document such as `README.md`; name those in prose instead of linking them.
- **Links to files that are not `.md` are not restricted this way.** `../examples/profile.cordis.patch.yml`, as `docs/006-deployment.en.md` writes it, is the case.
- **Every local link must resolve.** A relative path resolves against the current file's directory; do not write absolute paths or point outside the repository. A repository-root file is reached from `docs/` through `../`.
- **Anchors are optional.** A link to a section may carry `#section-title`, but the title must match the target document exactly; renaming a heading means updating every anchor that names it.

## What to translate

- **Prose, headings, table cells, and the words around code blocks.** The English version should read as a document written in English, not as a word-for-word gloss.
- **The shape of a table.** Row count, column count, column order and header meaning must match the Chinese version; a row's content may be rephrased for English word order, but no row may be added or lost.
- **The number and order of code blocks and mermaid diagrams.** Node labels inside a diagram may be translated; node ids, edges and structure stay as they are.

## What not to translate

- **Code and commands.** Everything under `src/`, `tests/`, `prompts/`, `skills/`, `lib/` and `scripts/` stays in English, comments and prompts included. The same goes for code blocks inside `docs/`: commands, environment variables, YAML keys and shell fragments are kept verbatim.
- **Identifiers.** Package names, plugin entry ids, preset ids, configuration keys, tool names, error codes, file names and paths are never translated, and they go in backticks, such as `xenra-superagent`, `stateDir`, `XENRA_SUPERAGENT_DIR`, `orchestrator_route` and `agent-preset/not-found`.
- **Product and proper names.** Xenra-SuperAgent, DeepSeek Harness, GitHub, Feishu, Lark, Pull Request, Issue, tmux, git, pnpm, Node.js and SQLite keep their names in both languages.
- **Copy the host provides.** A DeepSeek Harness menu or button is written as that host currently names it in its own language; do not invent a translation.

## Glossary

The domain glossary in [001 Domain model](001-domain.en.md) is authoritative; both languages use those terms and no others.

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

The panel's copy is maintained separately in `src/client/locales.ts`, and its terms agree with this table. `tests/locales.spec.ts` checks that both languages name the same placeholders and that every error code and reason code is worded; when a document disagrees with it, the panel wins and the document changes.

## Tone

Write Chinese the way technical documentation usually reads: short sentences, one idea per paragraph, sparing use of "we", no marketing language, no emoji. Use full-width punctuation. Keep the English's judgments at the same strength: a sentence saying the software is not production-ready stays just as direct.

Write English in the present tense and the active voice, addressing the operator as "you", in short sentences. Keep the two sides equally certain: where the Chinese says something may happen, the English does not say "will".

## The workflow

1. Change the Chinese version first; it is the primary one.
2. Write the English version with the same structure: the same heading levels, the same table rows and columns, and the same number of code blocks in the same order.
3. For documentation-only changes, run at least `node node_modules/vitest/vitest.mjs run tests/docs.spec.ts tests/locales.spec.ts`; run the full `pnpm check` when code changed too.
4. Put both files in one commit, whose message says what changed in which document.
