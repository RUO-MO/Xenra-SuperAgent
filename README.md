# Xenra-SuperAgent

[English](README.en.md) · 中文

> **仅供研究参考的原型，不是 DeepSeek 的官方产品。** 这份代码源自我们团队的日常开发工作，其中大部分工程由编码智能体完成。请把它当作研究代码，而不是可用于生产的软件：它可能仍有缺陷，编码风格与工程实践也可能不一致。在你自己的环境里使用之前，请先评审并改造它。
>
> 我们为公开发布做过调整，因此它与我们的内部版本、也不与 *Exploring Super-agent Design: Towards a More Autonomous Agent System* 一文描述的实现在细节上完全相同。文中讨论的部分设计属于未来方向，本原型并未实现。
>
> Xenra-SuperAgent 派生自 DeepSeek Harness 的 `dsh-superagent` 研究原型，并由此改名而来。包名、bundle 条目、预置、技能、`scripts/xenra-superagent` 脚本和 `XENRA_SUPERAGENT_*` 环境变量都使用新名；以旧名完成的安装请见 [从 dsh-superagent 升级](docs/006-deployment.md#从-dsh-superagent-升级)。

Xenra-SuperAgent 是一个面向单个 GitHub 仓库的主动式编码智能体，以 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 的 bundle 形式分发。它监听 GitHub，也可以监听飞书。当获许的人向智能体请求工作时，它会开一张工作项，在属于自己的智能体会话和目录里完成任务，并回到原对话里答复，例如给出一个 Pull Request。Web 面板会显示需要人处理的事。

它同时也是一种与智能体协作的方式：**尽可能少占用人的注意力，尽可能多交付价值。** 一个能为整个团队行动的智能体，也能消耗整个团队的注意力。因此它只在被请求时、或在团队写下的规则允许时行动；只在有人必须行动、或能用上结果时才说话。[docs/000-philosophy.md](docs/000-philosophy.md) 解释了这一原则以及它对运营者的要求。

## 安装

安装步骤较多，所以由一个智能体陪你完成。请对你的编码智能体说：

> 读这个仓库里的 SETUP.md，和我一起配置 Xenra-SuperAgent。

它会一次问一个简短的问题，把完整计划给你看一遍，然后安装并配置好一切。它遵循的是 [SETUP.md](SETUP.md)。

## 文档

按顺序阅读下面这些编号文档，每篇只依赖它前面的内容。每篇都有中文版（主）与英文版（对照）。

- [000 理念](docs/000-philosophy.md)
- [001 领域模型](docs/001-domain.md)
- [002 授权](docs/002-authorization.md)
- [003 执行](docs/003-execution.md)
- [004 提示词](docs/004-prompts.md)
- [005 面板](docs/005-panel.md)
- [006 部署](docs/006-deployment.md)：手动安装、配置、升级与故障排查
- [007 架构](docs/007-architecture.md)
- [008 扩展指南](docs/008-cookbook.md)：新增一个来源

## 开发

`pnpm check` 会依次运行类型检查、测试和构建。持续集成会在每次推送到 `main` 以及每个 Pull Request 上运行同样的检查。

仓库里同时提交了构建产物 `lib/`，所以以 `link:` 方式安装时无需先构建即可直接使用。

## 参与贡献

- 提问与缺陷报告请用 Issue 模板，功能建议请说明它解决的具体问题。
- 提交 Pull Request 前请先运行 `pnpm check`。
- 文档改动请同时改中文版和英文版（`*.md` 与同名 `*.en.md`），规则见 [docs/TRANSLATING.md](docs/TRANSLATING.md)。

## 许可

[MIT](LICENSE)
