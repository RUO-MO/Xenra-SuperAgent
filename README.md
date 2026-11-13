# Xenra-SuperAgent

[English](README.en.md) · 中文

Xenra-SuperAgent 是一个面向单个 GitHub 仓库的主动式编码智能体，以 [DeepSeek Harness](https://www.deepseek.com/harness/) 的 bundle 形式分发。它监听 GitHub，也可以监听飞书。当获许的人向它请求工作时，它会开一张工单，在属于自己的 DSH 会话和目录里完成，再回到原对话里答复，例如给出一个 Pull Request。Web 面板只有首页、工单、设置三个标签页：首页先显示需要人处理的事，新安装则由首次配置引导接手。

它同时也是一种与智能体协作的方式：**尽可能少占用人的注意力，尽可能多交付价值。** 一个能为整个团队行动的智能体，也能消耗整个团队的注意力。因此它只在被请求时、或在团队写下的规则允许时行动；只在有人必须行动、或能用上结果时才说话。[docs/000-philosophy.md](docs/000-philosophy.md) 解释了这一原则以及它对运营者的要求。

## 安装

安装步骤较多，所以由一个智能体陪你完成。请对你的编码智能体说：

> 读这个仓库里的 SETUP.md，和我一起配置 Xenra-SuperAgent。

它会一次问一个简短的问题，把完整计划给你看一遍，然后安装并配置好一切。它遵循的是 [SETUP.md](SETUP.md)。

如果你更想自己动手，[docs/006-deployment.md](docs/006-deployment.md) 给出了完整的安装、机器配置、启停与升级步骤。

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

依赖 Node.js 22.19+ 或 24+，以及 pnpm。安装依赖后运行：

```sh
pnpm install
pnpm check
```

`pnpm check` 依次运行类型检查、测试和构建。仓库里同时提交了构建产物 `lib/`，所以以 `link:` 方式安装时无需先构建即可直接使用；改过 `src/` 后请重新 `pnpm build`，让产物与源码一致。

插件本身在 Linux、macOS 与 Windows 上都可用：包装脚本、prepare 命令、路径查找与 git helper 都按平台各自的形式生成。启停脚本 `scripts/xenra-superagent` 需要 tmux 与 `ps`，因此只在 POSIX 主机上运行；在 Windows 上直接用 `dsh --profile <名字>` 启动。测试中少数用例需要 `#!/bin/sh`、`tmux` 或 `ps`，在 Windows 上以 `it.skipIf` 跳过，其余用例照常运行。

## 参与贡献

- 提问与缺陷报告请用 Issue 模板，功能建议请说明它解决的具体问题。
- 提交 Pull Request 前请先运行 `pnpm check`。
- 文档改动请同时改中文版和英文版（`*.md` 与同名 `*.en.md`），规则见 [docs/TRANSLATING.md](docs/TRANSLATING.md)。

## 许可

[MIT](LICENSE)，属主 RUO-MO。

## 致谢

本项目的骨架来自 DeepSeek 团队开源的 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)：它确立了这套主动式智能体的领域模型、授权与执行分离的结构，以及"少打扰人"的设计取向。Xenra-SuperAgent 在此基础上重写为独立的项目与独立的文档，并跟随 DeepSeek Harness 0.2.2 的接口。特别感谢 DeepSeek 团队把这项工作开源出来。
