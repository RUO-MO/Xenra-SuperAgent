# Security policy

[中文](SECURITY.md) · English

## Supported versions

Xenra-SuperAgent follows DeepSeek Harness releases: security fixes land on the latest commit corresponding to the running code, for DSH versions inside the `engines.dsh` range in `package.json`. Upgrade first before reporting against a version outside that range.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting: on this repository's **Security** tab, choose **Report a vulnerability**. Please include:

- the affected version or commit;
- steps to reproduce, or a minimal reproduction;
- the impact: what an attacker can do, and what they need first;
- a suggested fix, if you have one.

We confirm reports as soon as we can, and after a fix ships we will ask whether you want to be credited publicly.

## Known design boundaries

The following are **intended** behavior, not vulnerabilities. They help you judge what is worth reporting:

- **Executors run as the operator's OS user, with `danger-full-access`.** `stateDir`, the wrappers and the ticket directories are defaults, not a security boundary; an Executor can run a program by absolute path and read the operator's home directory. For isolation, use a dedicated OS account, or run the Executor in its own container or virtual machine.
- **Prompt text never changes permissions.** Messages, comments and quoted documents are data; admission, authorization, tool argument checks and account wrappers are enforced by code. See the precedence section of [docs/004-prompts](docs/004-prompts.en.md).
- **The main Session may write policy; an Executor may not.** The main Session holds the tools that change Policy and prompts, because it routes work under a person's Mandate; an Executor gets only the tools its work needs, and loses even those once its Ticket ends. Any channel that can steer the main Session — for example text a permitted GitHub user writes in your repository — is still bounded by the Policy entries, but the **allow list itself** is maintained by a person in Settings.
- **The management API listens on loopback only**, and requires the `x-orchestrator-request` header with a same-origin `Origin`. Exposing it to a network is a misconfiguration, not a supported use.
- **Settings saved through the management API have the panel's permissions**, and can change execution environment and account fields; any process that can reach the loopback port can do the same.

## Please do not put these in an issue

- keys, tokens, app secrets or private keys;
- configuration or logs carrying real credentials;
- public reproduction details for an unfixed vulnerability.

If you already committed a credential by mistake, revoke it first, then contact us through the channel above.
