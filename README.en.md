# Xenra-SuperAgent

[中文](README.md) · English

Xenra-SuperAgent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own DSH Session and directory, and answers in the original conversation, for example with a pull request. The web panel has three tabs — Home, Tickets and Settings: Home leads with what needs a person, and a fresh installation opens the first-run guide instead.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.en.md](docs/000-philosophy.en.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up Xenra-SuperAgent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.en.md](SETUP.en.md) is what it follows.

If you would rather do it yourself, [docs/006-deployment.en.md](docs/006-deployment.en.md) gives the complete install, machine configuration, start/stop and upgrade steps.

## Documentation

Read the numbered documents in order; each builds only on the ones before it. Every document has a Chinese primary text and an English counterpart.

- [000 Philosophy](docs/000-philosophy.en.md)
- [001 Domain model](docs/001-domain.en.md)
- [002 Authorization](docs/002-authorization.en.md)
- [003 Execution](docs/003-execution.en.md)
- [004 Prompts](docs/004-prompts.en.md)
- [005 Panel](docs/005-panel.en.md)
- [006 Deployment](docs/006-deployment.en.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.en.md)
- [008 Cookbook](docs/008-cookbook.en.md): adding a Source

## Development

Requires Node.js 22.19+ or 24+, and pnpm. Install the dependencies, then run:

```sh
pnpm install
pnpm check
```

`pnpm check` runs the typecheck, the tests and the build in that order. The build output in `lib/` is committed, so the repository installs as-is through a `link:` install without a build step first; after changing `src/`, run `pnpm build` again so the output matches the sources.

The plugin itself runs on Linux, macOS and Windows: the shims, the prepare command, executable lookup and the git helper each take the form their platform expects. The start/stop script `scripts/xenra-superagent` needs tmux and `ps`, so it runs on POSIX hosts only; on Windows, start `dsh --profile <name>` directly. A few test cases need `#!/bin/sh`, `tmux` or `ps`, and are skipped on Windows with `it.skipIf`; the rest run as usual.

## Contributing

- Open an issue from a template for a question or a defect; for a feature, describe the concrete problem it solves.
- Run `pnpm check` before opening a pull request.
- Change a document in both languages (`*.md` and its `*.en.md` counterpart); see [docs/TRANSLATING.en.md](docs/TRANSLATING.en.md).

## License

[MIT](LICENSE), held by RUO-MO.

## Acknowledgements

The skeleton of this project comes from the DeepSeek team's open-source [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype): it established this proactive agent's domain model, the separation of authorization from execution, and the design intent of consuming as little of a person's attention as possible. Xenra-SuperAgent rewrites that foundation as its own project with its own documentation, and follows the DeepSeek Harness 0.2.2 interfaces. Special thanks to the DeepSeek team for open-sourcing that work.
