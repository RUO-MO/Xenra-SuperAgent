# Security policy

[中文](SECURITY.md) · English

## Supported versions

This project is a research prototype (see the README), and offers no formal security support window. We still take security reports seriously and fix them on the latest commit when we can.

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

- **Executors run as the operator's OS user, with `danger-full-access`.** Wrappers and directories are defaults, not a security boundary; an Executor can run a program by absolute path and read the operator's home directory. For isolation, use a dedicated OS account. See "Permissions and isolation" in [docs/006-deployment](docs/006-deployment.en.md).
- **Prompt text never changes permissions.** Messages, comments and quoted documents are data; the gate, Mandates, tool argument checks and account wrappers are enforced by code. See the precedence section of [docs/004-prompts](docs/004-prompts.en.md).
- **The management API listens on loopback only**, and requires the `x-orchestrator-request` header with a same-origin `Origin`. Exposing it to a network is a misconfiguration, not a supported use.
- **Settings saved through the management API have the panel's permissions**, and can change execution environment and account fields.

## Please do not put these in an issue

- keys, tokens, app secrets or private keys;
- configuration or logs carrying real credentials;
- public reproduction details for an unfixed vulnerability.

If you already committed a credential by mistake, revoke it first, then contact us through the channel above.
