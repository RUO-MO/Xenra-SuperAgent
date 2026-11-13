import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import s from "@deepseek-ai/schemastery";
//#region src/core/model.ts
/** Stable key of a thread across the whole domain. */
const threadKey = (ref) => `${ref.source}:${ref.id}`;
/**
* Normalizes valid timestamps to `Date#toISOString` form so stored timestamps compare lexicographically in memory and SQL;
* values that do not parse as a timestamp are returned unchanged.
*/
function isoTime(value) {
	const time = Date.parse(value);
	return Number.isFinite(time) ? new Date(time).toISOString() : value;
}
/**
* The tickets whose worker decides a person's follow-up: those it reached on their own Threads that can still decide it
* and did not hand it back. A ticket can while it is live, also once a person dropped its Subscription to the Thread, and
* while it is ended, not by a person, with the Trigger waiting to resume it. None once a person sent it to Eval, or while
* an Eval holds it, which an earlier version may have queued. While a ticket owns it, the message goes to no Eval, and the
* main Session may only stop the work on it.
*/
function followupOwners(trigger, records) {
	if (!trigger.human) return [];
	const disposition = records.triggers.disposition(trigger.id);
	if (!disposition || disposition.requeued) return [];
	const returned = new Set(disposition.handbacks?.map((item) => item.ticketId));
	const reached = disposition.fanout.filter((id) => !returned.has(id) && !disposition.context?.includes(id));
	if (!reached.length || records.threads.get(threadKey(trigger.threads[0]))?.evaluating?.triggerIds.includes(trigger.id)) return [];
	return reached.filter((id) => {
		const ticket = records.tickets.get(id);
		return !!ticket && (liveTicket(ticket) || ticket.ended?.by !== "human" && ticket.inputs.some((input) => input.kind === "trigger" && input.triggerId === trigger.id && ticket.undelivered.includes(input.id)));
	});
}
/**
* Whether a Decision settled what a person's message asks for: a stop on it, taken or refused, decides only that ticket's
* work, routing it to a ticket leaves it to that ticket's worker, and an unavailable one decided nothing.
*/
const settled = (decision) => !["stop", "unavailable"].includes(decision.kind) && !decision.reason.some((reason) => [
	"stopNotExplicit",
	"stopUnknown",
	"routed"
].includes(reason.code));
/** Whether a ticket is open: it has not ended. */
const liveTicket = (ticket) => !ticket.ended;
/** How a ticket ended. */
const ticketOutcome = (ticket) => ticket.ended?.outcome;
const runningAssignment = (ticket) => ticket.assignments.find((assignment) => assignment.state === "running");
/**
* Whether a Trigger reached a ticket: it started the ticket, came to it as an Input, or is on a Thread the ticket subscribes
* to; with `context` false, not a Thread the ticket follows only for context, where its worker may read but not write.
*/
function reached(ticket, trigger, thread, context = true) {
	if (ticket.origin.triggerId === trigger.id) return true;
	const input = ticket.inputs.some((item) => item.kind === "trigger" && item.triggerId === trigger.id);
	return trigger.threads.some((ref) => {
		const current = thread(threadKey(ref));
		return current?.subscriptions.includes(ticket.id) === true && (context || !current.context?.includes(ticket.id));
	}) || input && (context || !trigger.threads.every((ref) => thread(threadKey(ref))?.context?.includes(ticket.id)));
}
const latestAssignment = (ticket) => ticket.assignments.at(-1);
/** The latest report any of a ticket's Assignments made, which is what the ticket last said. */
const latestReport = (ticket) => ticket.assignments.findLast((assignment) => assignment.report)?.report;
/**
* Until when a ticket's worker had a turn to read what reached it: its latest report, but a progress report when `progress`
* is false, or the end of its latest turn, whichever is later.
*/
function readUntil(ticket, progress = true) {
	return [(ticket.assignments.findLast((assignment) => assignment.report && (progress || assignment.report.state !== "progress"))?.report)?.at ?? "", ...ticket.assignments.map((assignment) => assignment.idleAt ?? "")].reduce((a, b) => a > b ? a : b);
}
/**
* Whether a ticket waits for a person: its latest Assignment reported blocked or failed, and no person's message reached it
* since. A later report that is neither, a person's message, or a retry, which starts a new Assignment, lifts it.
*/
function waitsForPerson(ticket) {
	const report = latestAssignment(ticket)?.report;
	if (report?.state !== "blocked" && report?.state !== "failed") return false;
	return !ticket.inputs.some((input) => input.kind === "trigger" && input.human && !input.context && input.at > report.at);
}
//#endregion
//#region src/core/ids.ts
/** Stable content-derived identifiers; equal inputs always produce the same id. */
function key(...values) {
	return createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 32);
}
//#endregion
//#region src/limits.ts
/** Validation bounds shared between host schemas and management panel forms. */
const LIMITS = {
	ruleName: 100,
	ruleInstruction: 2e3,
	evalTimeoutSeconds: {
		min: 30,
		max: 600
	},
	maxWorkers: {
		min: 1,
		max: 16
	},
	prepareCommand: 4e3,
	promptMaxChars: {
		min: 1e3,
		max: 1e6
	},
	admissionContextMaxPages: {
		min: 1,
		max: 100
	},
	admissionContextTimeoutMs: {
		min: 1,
		max: 9e4
	}
};
//#endregion
//#region src/infra/text.ts
/** Word counting and string formatting utilities for IM message limits and templates. */
const words = new Intl.Segmenter("zh", { granularity: "word" });
/** Counts word-like segments across Chinese, English, and mixed text, ignoring punctuation. */
function wordCount(text) {
	let count = 0;
	for (const segment of words.segment(text)) if (segment.isWordLike) count++;
	return count;
}
/** Validates that an outgoing IM Markdown message does not exceed `IM_WORDS` (link labels and URLs both count toward the limit). */
function checkedImText(text) {
	const count = wordCount(text);
	if (count > 100) throw new Error(`IM message has ${count} words; maximum is 100. Rewrite as a short high-level update. Do not split it into multiple messages.`);
	return text;
}
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
/** Case-insensitive comparison for GitHub logins and repository names. */
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
//#endregion
//#region src/setup.ts
/** Structured startup and configuration errors with the settings location where the operator can fix them. */
const SETUP_PROBLEMS = {
	foreignFile: ["deployment", "{file} was not written by xenra-superagent; move it, or choose another state directory."],
	gitTooOld: ["deployment", "git does not read the github.com credential configuration xenra-superagent writes; xenra-superagent needs git 2.32 or later. Git {version} was used, and it reported {actual} instead of {expected}."],
	environmentFailed: ["deployment", "Preparing the agent environment failed."],
	repositoryUnset: ["github", "The GitHub Source names no repository."],
	agentCliUnset: ["github", "The agent GitHub CLI is not set."],
	agentCliMissing: ["github", "The agent GitHub CLI was not found."],
	agentCliSignedOut: ["github", "The agent GitHub CLI cannot read its account."],
	agentCliNoAccount: ["github", "The agent GitHub CLI did not report a GitHub account."],
	repositoryUnreadable: ["github", "@{account} cannot read {repository}."],
	repositoryUnreported: ["github", "The agent GitHub CLI did not return {repository}."],
	repositoryReadOnly: ["github", "@{account} cannot push to {repository}."],
	feishuCliFailed: ["feishu", "The bot lark-cli does not work."],
	feishuNoApp: ["feishu", "auth status of the bot lark-cli did not report the app."],
	feishuBotNotReady: ["feishu", "The bot identity of app {app} is {status}; configure the app secret with lark-cli."],
	feishuUserIdentity: ["feishu", "The bot lark-cli allows user identities (strict mode {mode}); give the bot its own lark-cli configuration in strict mode bot, as docs/006-deployment.md describes."],
	feishuNoBot: ["feishu", "The Feishu bot API did not return the bot's open_id."]
};
/**
* Thrown by deployment and account verification checks when a required CLI, account, or repository check fails.
* `Setup` records it for the management overview, and the HTTP layer returns `problem` so the panel can localize it.
*/
var SetupError = class extends Error {
	code;
	values;
	place;
	constructor(code, values = {}) {
		const [place, text] = SETUP_PROBLEMS[code];
		const sentence = fill(text, values);
		super(values.output ? `${sentence}\n${values.output}` : sentence);
		this.code = code;
		this.values = values;
		this.place = place;
	}
	get problem() {
		return {
			place: this.place,
			code: this.code,
			values: this.values,
			detail: this.message
		};
	}
};
//#endregion
//#region src/infra/commands.ts
/** Subprocess wrapper for running gh, lark-cli, and git commands under the deployment's configured accounts. */
const exec$1 = promisify(execFile);
const TIMEOUT_MS = 9e4;
/**
* Error thrown by Commands when a CLI invocation fails, capturing stderr diagnostics, API error codes, and exit status without echoing command arguments.
* Source channels and pollers inspect its code to distinguish deleted conversations from retryable failures.
*/
var CliError = class extends Error {
	code;
	exitCode;
	constructor(message, code, exitCode) {
		super(message);
		this.code = code;
		this.exitCode = exitCode;
	}
};
/** Extracts a sanitized error from a failed subprocess without echoing argv, which may contain message text. */
function commandError(error, program = "command") {
	if (error instanceof Error && error.name === "AbortError") return error;
	const exitCode = error && typeof error === "object" && "code" in error && typeof error.code === "number" ? error.code : void 0;
	if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string") {
		const stderr = error.stderr.trim();
		let parsed;
		try {
			parsed = JSON.parse(stderr.slice(stderr.indexOf("{")));
		} catch {}
		const code = parsed?.error?.code;
		if (parsed?.error?.message) return new CliError(`${parsed.error.message}${code ? ` (${code})` : ""}`, code, exitCode);
		if (stderr) return new CliError(stderr.slice(0, 2e3), Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || void 0, exitCode);
	}
	return new CliError(`${basename(program)} ${ended(error)}`, void 0, exitCode);
}
function ended(error) {
	const { killed, signal, code } = error ?? {};
	if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "printed more output than it may";
	if (killed && signal === "SIGTERM") return `timed out after ${TIMEOUT_MS / 1e3} s`;
	if (signal) return `was stopped by ${signal}`;
	if (typeof code === "number") return `exited with code ${code}`;
	return typeof code === "string" ? `could not run: ${code}` : "failed";
}
/** Parses array elements against a schema, skipping invalid items and incrementing `tally.skipped`. */
function validItems(item, list, tally) {
	const items = list.flatMap((value) => {
		const parsed = item.safeParse(value);
		return parsed.success ? [parsed.data] : [];
	});
	if (tally) tally.skipped += list.length - items.length;
	return items;
}
/** Rewrites Feishu error 232011 (bot not in chat) with remediation instructions. */
function membership(error) {
	if (!(error instanceof CliError) || error.code !== 232011) return error;
	return new CliError("The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.", error.code, error.exitCode);
}
/**
* Executes gh, lark-cli, and git subprocesses with deployment account credentials, timeouts, and abort signals.
* Restricts GitHub API calls to the configured repository and translates CLI failures into CliError instances for Sources, MasterAssessor, Outbox, and Settings.
*/
var Commands = class Commands {
	resolved;
	environment;
	signal;
	/**
	* @param resolved - returns the resolved deployment setup, or throws while setup is still pending.
	* @param environment - variables overriding `process.env` for every command (such as isolated git settings).
	*/
	constructor(resolved, environment, signal) {
		this.resolved = resolved;
		this.environment = environment;
		this.signal = signal;
	}
	get deployment() {
		return this.resolved();
	}
	get repository() {
		return this.deployment.repository;
	}
	withSignal(signal) {
		return signal ? new Commands(this.resolved, this.environment, AbortSignal.any([this.signal, signal])) : this;
	}
	async run(program, args, cwd) {
		try {
			const { stdout } = await exec$1(program, args, {
				cwd,
				signal: this.signal,
				timeout: TIMEOUT_MS,
				maxBuffer: 16777216,
				env: {
					...process.env,
					...this.environment,
					GH_PROMPT_DISABLED: "1",
					LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
					LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
				}
			});
			return stdout;
		} catch (error) {
			throw commandError(error, program);
		}
	}
	/** Runs the agent's GitHub CLI and parses its JSON output; callers should prefer `api`, which is restricted to the configured repository and validates output. */
	async gh(args) {
		return JSON.parse(await this.run(this.deployment.github.cli, args));
	}
	async api(schema, ...rest) {
		if (typeof schema === "string") return this.run(this.deployment.github.cli, [
			"api",
			this.path(schema),
			...rest
		]);
		const [path = "", ...flags] = rest;
		return schema.parse(await this.gh([
			"api",
			this.path(path),
			...flags
		]));
	}
	/** Fetches all pages of a GitHub API list within the configured repository, skipping items that fail schema validation. */
	async pages(item, path, tally) {
		return validItems(item, z.array(z.array(z.unknown())).parse(await this.gh([
			"api",
			this.path(path),
			"--paginate",
			"--slurp"
		])).flat(), tally);
	}
	path(path) {
		if (/^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)) throw new Error("GitHub calls are restricted to the configured repository");
		return path ? `repos/${this.repository}/${path}` : `repos/${this.repository}`;
	}
	/**
	* Runs the Feishu bot's `lark-cli` and returns the JSON `data` payload.
	* @throws CliError with Feishu's error code on failure (rewriting 232011 when the bot is not in the chat).
	*/
	async lark(args, cwd) {
		const bot = this.deployment.feishu;
		if (!bot) throw new Error("The Feishu Source has no working bot CLI");
		const output = await this.run(bot.cli, [
			...args,
			"--as",
			"bot",
			"--format",
			"json"
		], cwd).catch((error) => {
			throw membership(error);
		});
		const result = JSON.parse(output);
		const code = result.error?.code;
		if (!result.ok) throw membership(new CliError(`${result.error?.message ?? "Feishu command failed"}${code ? ` (${code})` : ""}`, code));
		return result.data;
	}
	/** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
	async git(args, cwd) {
		return this.run("git", args, cwd);
	}
};
//#endregion
//#region src/infra/platform.ts
/**
* The platform facts the Host adapts to: which shell runs a configured command, how PATH names an executable, and which
* PATH variable a child reads. The worker shims, the setup probes, the prepare command and the subprocess launcher each
* need one of them, and keeping them here means every caller answers the question the same way.
*/
/** True on Windows, where paths use `\`, the shell is `cmd.exe`, and a program may be named by a PATHEXT extension. */
const WINDOWS = process.platform === "win32";
/** The extensions Windows tries for a bare command name, most preferred first: a native image before a batch wrapper. */
const PATHEXT = [
	".exe",
	".com",
	".bat",
	".cmd",
	".ps1"
];
/** A Windows batch file, which Node cannot start without a shell: `cmd.exe` has to interpret it. */
const BATCH = /\.(?:cmd|bat)$/i;
/**
* Whether two paths name the same directory. A missing path is compared as written, so a directory that does not exist yet
* still compares equal to itself.
*/
function sameDirectory$1(a, b) {
	const real = (path) => {
		try {
			return realpathSync(path);
		} catch {
			return resolve(path);
		}
	};
	return real(a) === real(b);
}
/**
* The environment key that names the directory list. Windows names variables case-insensitively, so a child given `PATH`
* while its parent set `Path` sees one list, but replacing it needs the spelling the parent used.
* @returns `PATH`, or whichever case of it `env` already holds.
*/
function pathKey(env = process.env) {
	return Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
}
/** The directory list the environment holds, read under whichever spelling this platform or parent used. */
const pathValue = (env = process.env) => env[pathKey(env)] ?? "";
/**
* One environment override for the directory list.
* @param value - the list to set.
* @param env - the environment whose spelling of the key is matched.
*/
const pathEnv = (value, env = process.env) => ({ [pathKey(env)]: value });
/**
* The argv that runs one command line through the platform shell: `cmd /d /s /c` on Windows, `sh -c` elsewhere. The
* `prepare` command and the Feishu event consumer both take a command line a person wrote, so they run under this.
* @param command - the command line, written for that platform's shell.
*/
function shellCommand(command) {
	return WINDOWS ? [
		process.env.ComSpec || "cmd.exe",
		"/d",
		"/s",
		"/c",
		command
	] : [
		"sh",
		"-c",
		command
	];
}
/**
* The argv that starts one program. On Windows a batch file is not an image: `cmd.exe` has to interpret it, which is why
* Node refuses one without a shell. Any other program is passed through unchanged.
* @param program - absolute path or command name.
* @param args - the program's arguments.
*/
function spawnArgv(program, args) {
	return WINDOWS && BATCH.test(program) ? [
		process.env.ComSpec || "cmd.exe",
		"/d",
		"/s",
		"/c",
		program,
		...args
	] : [program, ...args];
}
/** Whether `file` is a regular file this process may execute. Windows has no executable bit, so existing is the whole test. */
function executableFile(file) {
	try {
		if (!statSync(file).isFile()) return false;
		if (!WINDOWS) accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
/**
* The file a command name or absolute path resolves to, trying the platform's executable extensions.
*
* A bare name is looked up in each PATH directory but `exclude`, the worker shim directory, so a wrapper script resolving
* `gh` or `lark-cli` by name reaches the real binary instead of the shim again.
* @param name - a command name, or an absolute path.
* @param path - the directory list to search for a name.
* @param exclude - a directory to skip, which the worker shims occupy.
* @returns the path of the executable file.
* @throws when no candidate is an executable file.
*/
function resolveExecutable(name, path, exclude) {
	if ((name.includes("/") || name.includes("\\")) && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`);
	const names = WINDOWS && !extname(name) ? [name, ...PATHEXT.map((extension) => name + extension)] : [name];
	const directories = isAbsolute(name) ? [""] : path.split(delimiter).filter((entry) => isAbsolute(entry) && !(exclude && sameDirectory$1(entry, exclude)));
	const candidates = isAbsolute(name) ? names : directories.flatMap((directory) => names.map((entry) => join(directory, entry)));
	for (const candidate of candidates) if (executableFile(candidate)) return candidate;
	throw new Error(`${name} is not an executable file${isAbsolute(name) ? "" : " on PATH"}`);
}
//#endregion
//#region src/app/git-upgrade.ts
/**
* Reporting on, and upgrading, the git that worker sessions run.
*
* The plugin needs git 2.32 or later because that is the version whose `GIT_CONFIG_GLOBAL` reaches a repository's own
* configuration; older releases ignore the isolated configuration the plugin writes and quietly use the operator's. A
* diagnostic that says only "needs 2.32" leaves an operator to work out what they have and how to change it, so this module
* answers both: the git that actually runs, and the exact command that would upgrade it on this machine.
*
* Nothing here installs anything on its own. `upgrade()` is called only after a person has read the command and what it
* changes, and every plan is a command run as that person, never a package the plugin vendored.
*/
const exec = promisify(execFile);
/** The oldest git whose `GIT_CONFIG_GLOBAL` applies to every repository, which the worker environment depends on. */
const GIT_MINIMUM = "2.32";
/** The git version string a program reported, or undefined when it is not a git version at all. */
function gitVersionOf(text) {
	return /^git version (\S+)/i.exec(text.trim())?.[1];
}
/** Compare two dotted versions by their numeric parts; a Windows-specific suffix such as `.windows.1` is ignored. */
function atLeast(version, minimum) {
	const parts = (value) => value.split(/[.\-+ ]/).flatMap((part) => {
		const number = Number.parseInt(part, 10);
		return Number.isFinite(number) ? [number] : [];
	});
	const [have, need] = [parts(version), parts(minimum)];
	for (let index = 0; index < Math.max(have.length, need.length); index++) {
		const [mine, theirs] = [have[index] ?? 0, need[index] ?? 0];
		if (mine !== theirs) return mine > theirs;
	}
	return true;
}
/**
* The upgrade this machine offers for git, or `undefined` when the plugin knows no way to change it.
* The plan names the package manager it found; finding none is a fact to report, not a failure to hide.
*/
async function planUpgrade() {
	/** A package manager this machine can run: its program, and the arguments that upgrade git through it. */
	const managers = WINDOWS ? [{
		by: "winget",
		argv: [
			"winget",
			"upgrade",
			"--id",
			"Git.Git",
			"--exact",
			"--silent",
			"--accept-package-agreements",
			"--accept-source-agreements"
		],
		command: "winget upgrade --id Git.Git --exact --silent --accept-package-agreements --accept-source-agreements",
		probe: [
			"winget",
			"list",
			"--id",
			"Git.Git",
			"--exact",
			"--accept-source-agreements"
		]
	}] : [
		{
			by: "brew",
			argv: [
				"brew",
				"upgrade",
				"git"
			],
			command: "brew upgrade git",
			probe: [
				"brew",
				"list",
				"--formula",
				"git"
			]
		},
		{
			by: "apt",
			argv: [
				"sudo",
				"apt-get",
				"install",
				"--only-upgrade",
				"-y",
				"git"
			],
			command: "sudo apt-get install --only-upgrade -y git",
			probe: ["apt-get", "--version"]
		},
		{
			by: "dnf",
			argv: [
				"sudo",
				"dnf",
				"upgrade",
				"-y",
				"git"
			],
			command: "sudo dnf upgrade -y git",
			probe: ["dnf", "--version"]
		},
		{
			by: "pacman",
			argv: [
				"sudo",
				"pacman",
				"-Syu",
				"--noconfirm",
				"git"
			],
			command: "sudo pacman -Syu --noconfirm git",
			probe: ["pacman", "--version"]
		},
		{
			by: "zypper",
			argv: [
				"sudo",
				"zypper",
				"update",
				"-y",
				"git"
			],
			command: "sudo zypper update -y git",
			probe: ["zypper", "--version"]
		},
		{
			by: "apk",
			argv: [
				"sudo",
				"apk",
				"upgrade",
				"git"
			],
			command: "sudo apk upgrade git",
			probe: ["apk", "--version"]
		}
	];
	for (const manager of managers) try {
		await exec(manager.probe[0], manager.probe.slice(1), { timeout: 2e4 });
		return {
			by: manager.by,
			argv: manager.argv,
			command: manager.command
		};
	} catch {}
}
/**
* Run one upgrade plan as the operator, without a shell, and report what happened.
*
* This changes software on the machine. It is only ever called from the panel's explicit upgrade action, after the dialog has
* shown `plan.command` and the person has confirmed it; the plugin cannot detect a git that needs upgrading and install one
* on its own.
*/
async function upgrade(plan, signal) {
	try {
		const { stdout, stderr } = await exec(plan.argv[0], plan.argv.slice(1), {
			signal,
			timeout: 9e5,
			maxBuffer: 8388608
		});
		return {
			ok: true,
			output: `${stdout}${stderr}`.trim().slice(-4e3)
		};
	} catch (error) {
		const failure = error;
		return {
			ok: false,
			output: (`${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim() || failure.message || String(error)).slice(-4e3)
		};
	}
}
//#endregion
//#region src/infra/environment.ts
/**
* Process environment and CLI shims that bind git, gh, and lark-cli to the deployment's accounts and block disallowed commands.
* Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
* Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
*/
const MARKER = "# Written by xenra-superagent on every start; edits are lost.";
/** Markers of files written under the project's earlier names (`dsh-superagent`, `dsh-tag`, `dsh-go`, `dsh-freelancer`), which `xenra-superagent` owns and replaces too. */
const LEGACY_MARKERS = [
	"dsh-superagent",
	"dsh-tag",
	"dsh-go",
	"dsh-freelancer"
].map((name) => `# Written by ${name} on every start; edits are lost.`);
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
const WORKER_COMMANDS = [
	"gh",
	"git",
	"lark-cli"
];
const workerBin = (stateDir) => join(stateDir, "worker-bin");
const workerGitConfig = (stateDir) => join(stateDir, "worker-gitconfig");
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
/**
* Quote a path for a git configuration value. Git for Windows runs a `!` helper through its bundled `sh`, where a backslash
* is an escape character, so a Windows path is written with forward slashes; other platforms keep it as is.
*/
/**
* A path as the worker git configuration writes it. Git for Windows runs a `!` helper through its bundled `sh`, where a
* backslash is an escape character, so a Windows path is written with forward slashes; other platforms keep it as is.
* The value written and the value `verifyEnvironment` expects both come from here, so they cannot drift.
*/
const helperPath = (value) => WINDOWS ? value.replaceAll("\\", "/") : value;
const gitQuote = (value) => `"${helperPath(value).replace(/[\\"]/g, (char) => `\\${char}`)}"`;
const credentialHelper = (cli) => `!${shellQuote(helperPath(cli))} auth git-credential`;
/** Quote one argument for a Windows batch file, which `cmd.exe` re-parses: a value with spaces or quotes is wrapped and its quotes doubled. */
const batchQuote = (value) => /[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
function sameDirectory(a, b) {
	const real = (path) => {
		try {
			return realpathSync(path);
		} catch {
			return resolve(path);
		}
	};
	return real(a) === real(b);
}
function withoutDirectory(path, dir) {
	return path.split(delimiter).filter((entry) => !sameDirectory(entry, dir)).join(delimiter);
}
/**
* The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
* `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
* kept: it names no repository, and it stops git's search for one where the operator chose.
*/
const GIT_LOCATION = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_PREFIX",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE"
];
/**
* Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
* environment may name, and operator git identity/config overrides.
*
* These are handed to a child process, never assigned to `process.env`: the plugin shares a process with DSH's other Sessions
* and with the operator's own terminals, and a process-wide `GIT_CONFIG_GLOBAL` would change their git too.
*
* Nothing here writes, replaces or deletes a configuration file the machine already had. The worker reads its own
* `GIT_CONFIG_GLOBAL`, and because that file redirects only github.com, a credential helper for any other host is still found
* through the layers git reads anyway. `GIT_CONFIG_NOSYSTEM` stays: without it, a system-wide helper such as Git Credential
* Manager answers for github.com before the worker's own file does, handing the agent the operator's real token — which is
* exactly the leak this isolation exists to prevent.
*/
function agentVariables(stateDir) {
	return {
		GH_TOKEN: void 0,
		GITHUB_TOKEN: void 0,
		...Object.fromEntries(GIT_LOCATION.map((name) => [name, void 0])),
		GIT_CONFIG_GLOBAL: workerGitConfig(stateDir),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_COUNT: void 0,
		GIT_CONFIG_PARAMETERS: void 0,
		GIT_ASKPASS: "",
		SSH_ASKPASS: void 0,
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: void 0,
		GIT_COMMITTER_NAME: void 0,
		GIT_AUTHOR_EMAIL: void 0,
		GIT_COMMITTER_EMAIL: void 0
	};
}
/**
* True when a regular file starts with the xenra-superagent marker in its first two lines; a symbolic link, directory, or
* other non-regular file never counts as written by xenra-superagent.
*
* A Windows batch shim carries the marker on a `REM` line, since that is the only comment a `.cmd` file has, so the
* marker is read with or without that prefix. Both forms therefore count, and a shim left by the other platform is
* replaced rather than rejected.
*/
async function written(file) {
	if (!(await lstat(file)).isFile()) return false;
	const head = (await readFile(file, "utf8")).split("\n", 2).map((line) => line.trim().replace(/^REM +/i, "").replace(/\r$/, ""));
	return [MARKER, ...LEGACY_MARKERS].some((marker) => head.includes(marker));
}
async function own(file, text, mode = 420) {
	let foreign = false;
	try {
		foreign = !await written(file);
	} catch {}
	if (foreign) throw new SetupError("foreignFile", { file });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, text, { mode });
	await rename(temporary, file);
}
/**
* Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to
* overwrite foreign files.
*
* A shim is a small wrapper that strips the shim directory from the child's directory list before running the real
* program, so a wrapper script that resolves `gh` or `lark-cli` by name reaches the binary instead of the shim again. A
* blocked name is a shim that only prints why it is refused, which is how the configured `blockedCommands` are enforced.
*
* The form follows the platform: a POSIX host gets `#!/bin/sh` scripts, and a Windows host gets `.cmd` batch files, since
* Windows cannot execute a shell script and a program is found through its PATHEXT extension. Both are written with the
* same marker, so `written` recognises either, and a shim written by the other platform is replaced rather than rejected.
*/
async function writeEnvironment(deployment, blockedCommands) {
	const { stateDir, repository, github, feishu } = deployment;
	const dir = workerBin(stateDir);
	await mkdir(dir, { recursive: true });
	const before = await readdir(dir);
	for (const name of before) {
		const file = join(dir, name);
		if (!await written(file)) throw new SetupError("foreignFile", { file });
	}
	const kept = /* @__PURE__ */ new Set();
	const suffix = (name) => WINDOWS && !/\.(?:cmd|bat|exe|com|ps1)$/i.test(name) ? `${name}.cmd` : name;
	const shim = async (name, body) => {
		const file = suffix(name);
		const temporary = join(dir, `.${file}.${process.pid}.tmp`);
		await writeFile(temporary, `${header()}\n${body}\n`, { mode: 493 });
		await rename(temporary, join(dir, file));
		kept.add(file);
	};
	const header = () => WINDOWS ? `@echo off\r\nREM ${MARKER}` : `#!/bin/sh\n${MARKER}`;
	const withoutShims = [
		`self=${shellQuote(dir)}`,
		"rest=",
		"IFS=:",
		"set -f",
		"for entry in $PATH; do [ \"$entry\" = \"$self\" ] || rest=\"${rest:+$rest:}$entry\"; done",
		"set +f",
		"unset IFS",
		"PATH=$rest",
		"export PATH"
	].join("\n");
	const runWindows = (program) => [
		`set "XENRA_SHIM=${dir}"`,
		"set \"PATH=%PATH:%XENRA_SHIM%;=%\"",
		"set \"PATH=%PATH:;%XENRA_SHIM%=%\"",
		`if /I "%PATH%"=="%XENRA_SHIM%" set "PATH="`,
		`call ${batchQuote(program)} %*`,
		"exit /b %ERRORLEVEL%"
	].join("\r\n");
	const run = (program) => WINDOWS ? runWindows(program) : `${withoutShims}\nexec ${shellQuote(program)} "$@"`;
	const fail = (message) => WINDOWS ? [`>&2 echo ${batchQuote(message)}`, "exit /b 1"].join("\r\n") : `echo ${shellQuote(message)} >&2\nexit 1`;
	await shim("gh", run(github.cli));
	await shim("lark-cli", feishu ? run(feishu.cli) : fail("lark-cli is unavailable: this installation has no Feishu bot."));
	for (const name of new Set(blockedCommands.filter((name) => !WORKER_COMMANDS.includes(name)))) await shim(name, fail(`${name} is blocked in this installation; use gh, which acts as ${github.login}.`));
	for (const name of before) if (!kept.has(name)) await unlink(join(dir, name));
	await own(workerGitConfig(stateDir), [
		MARKER,
		"[user]",
		"	useConfigOnly = true",
		"[credential \"https://github.com\"]",
		`\thelper = ${gitQuote(credentialHelper(github.cli))}`,
		"[url \"https://github.com/\"]",
		"	insteadOf = git@github.com:",
		"	insteadOf = ssh://git@github.com/",
		"[filter \"lfs\"]",
		"	clean = git-lfs clean -- %f",
		"	smudge = git-lfs smudge -- %f",
		"	process = git-lfs filter-process",
		"	required = true"
	].join("\n") + "\n");
}
/**
* Removes the files this plugin wrote into `stateDir`, so uninstalling it leaves nothing behind that another tool — or a
* later run of git — could pick up.
*
* Only what xenra-superagent wrote is removed. A file it did not write stays, and the directory stays whenever anything is
* left in it, because a state directory a person chose may also hold their own work: deleting it wholesale would be the same
* mistake as overwriting a foreign `worker-gitconfig`. The database is named explicitly rather than the whole directory being
* removed, so an unknown file is kept and reported instead of silently destroyed.
* @returns the paths that were removed, and those that were kept because xenra-superagent did not write them.
*/
async function removeState(stateDir) {
	const removed = [];
	const kept = [];
	const ours = [
		workerBin(stateDir),
		workerGitConfig(stateDir),
		join(stateDir, "orchestrator.sqlite")
	];
	for (const path of ours) {
		if (!existsSync(path)) continue;
		try {
			await lstat(path);
		} catch {
			continue;
		}
		const dir = (await lstat(path)).isDirectory();
		if (!dir && !await written(path).catch(() => false)) {
			kept.push(path);
			continue;
		}
		await rm(path, {
			recursive: dir,
			force: true
		});
		removed.push(path);
	}
	for (const suffix of ["-shm", "-wal"]) {
		const path = join(stateDir, `orchestrator.sqlite${suffix}`);
		if (!existsSync(path)) continue;
		await rm(path, { force: true });
		removed.push(path);
	}
	if (existsSync(stateDir) && (await readdir(stateDir)).length === 0) await rm(stateDir, {
		recursive: false,
		force: true
	});
	return {
		removed,
		kept
	};
}
/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
async function runAsWorker(subprocess, argv, cwd, signal, env) {
	const handle = subprocess.spawn({
		argv: spawnArgv(argv[0] ?? "", argv.slice(1)),
		cwd,
		graceMs: 2e3,
		signal,
		...env ? { env } : {},
		stdio: {
			stdin: "ignore",
			stdout: { maxBytes: 1 << 20 },
			stderr: { maxBytes: 65536 }
		}
	});
	const { exitCode } = await handle.done;
	const read = (reader) => reader?.readFrom(0).text ?? "";
	if (exitCode === 0) return read(handle.collected.stdout);
	const ended = exitCode === null ? "was stopped before it finished" : `exited with ${exitCode}`;
	throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(" ")} ${ended}`, void 0, exitCode ?? void 0);
}
/**
* Verifies that worker git invocations resolve the deployment's GitHub credential helper.
*
* The diagnostic carries what git actually said and which git ran, because the usual cause is a git too old to read
* `GIT_CONFIG_GLOBAL` — but a different git on `PATH`, or a wrapper that rewrites the value, looks the same from here, and
* "needs git 2.32" without the version is a guess the operator cannot check.
*/
async function verifyEnvironment(deployment, subprocess, signal) {
	const { github, stateDir } = deployment;
	const environment = agentVariables(stateDir);
	const run = (argv) => runAsWorker(subprocess, argv, stateDir, AbortSignal.any([signal, AbortSignal.timeout(6e4)]), environment);
	const expected = [
		`file:${workerGitConfig(stateDir)}`,
		credentialHelper(github.cli),
		""
	].join("\0");
	const [helpers, version] = await Promise.all([run([
		"git",
		"config",
		"-z",
		"--show-origin",
		"--get-all",
		"credential.https://github.com.helper"
	]).catch(() => ""), run(["git", "--version"]).then((text) => gitVersionOf(String(text ?? "")) ?? "unknown").catch(() => "unknown")]);
	if (helpers === expected) return;
	throw new SetupError("gitTooOld", {
		version,
		minimum: GIT_MINIMUM,
		actual: helpers.replaceAll("\0", " | ").trim() || "(nothing)",
		expected: expected.replaceAll("\0", " | ").trim()
	});
}
/**
* Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
* keys, which the agent's git would read from the repository's own config and act on.
*/
async function verifyDirectory(directory, subprocess, signal) {
	const scoped = (await runAsWorker(subprocess, [
		"git",
		"config",
		"-z",
		"--show-scope",
		"--get-regexp",
		"^(credential\\..*|http\\..*extraheader)$"
	], directory, AbortSignal.any([signal, AbortSignal.timeout(6e4)])).catch((error) => {
		if (error instanceof CliError && error.exitCode === 1) return "";
		throw error;
	})).split("\0");
	const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === "local" || scope === "worktree") ? [scoped[index + 1].split("\n")[0]] : []);
	if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(", ")}, which the agent's git would also read; remove them.`);
}
//#endregion
//#region src/kv.ts
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
const record = (key) => key;
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
function family(prefix, format = (...name) => name.join(":")) {
	return Object.assign((...name) => `${prefix}${format(...name)}`, { prefix });
}
const KV = {
	/** Store: current database schema version. */
	store: { schema: record("schema") },
	/** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
	settings: {
		revision: record("settings-revision"),
		block: family("settings-block-revision:"),
		version: family("settings-version:")
	},
	/** Prompts: current revision and saved prompt versions. */
	prompts: {
		revision: record("prompt-revision"),
		version: family("prompt-version:"),
		/** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
		builtIn: family("prompt-built-in:")
	},
	/** Runtime: the main Session's ID. */
	runtime: { masterId: record("master-id") },
	/** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
	sessions: { prompts: family("session-prompts:") },
	/** Schema 11 migration: legacy main-Session queues imported into the effect table. */
	queues: {
		relays: record("relay-queue"),
		unsubscribed: record("subscription-results"),
		prompts: record("prompt-notification"),
		settings: record("settings-notification")
	},
	/** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
	sources: { labels: family("source-labels:") },
	/**
	* GitHub Source: notification cursor and pending retries; per-Issue/PR read cursor shared by notification and polled reads;
	* per-stream cursor, start times by kind, and ETag; default-branch CI state; and per-PR CI fingerprint and revision (`revision`
	* counts reported CI changes so each produces a distinct Trigger ID).
	*/
	github: {
		since: record("github-since"),
		retries: record("github-retry"),
		cursor: family("github-cursor:"),
		stream: family("github-stream:"),
		branchCi: record("github-branch-ci"),
		ci: family("github-ci:")
	},
	/**
	* Feishu Source: known chats (`true` for direct messages); per-chat history cursor and active topics mapped from topic ID
	* to last-seen timestamp; and per-polled-thread seen message IDs and initialization flag.
	*/
	feishu: {
		chats: record("feishu-chats"),
		history: family("feishu-history:"),
		topics: family("feishu-history-threads:"),
		seen: family("thread-seen:"),
		initialized: family("thread-initialized:")
	}
};
//#endregion
//#region src/deployment.ts
/** Plugin configuration and startup verification for repository access and agent CLI identities. */
const reason = (error) => error instanceof Error ? error.message : String(error);
const absolute = (description) => s.string().pattern(/^(?:\/|[A-Za-z]:[\\/])/).description(`${description} Absolute path (POSIX or a Windows drive path).`);
/** Plugin configuration of the xenra-superagent entry. Volatile fields apply without a restart because xenra-superagent reads them on each use; changing `stateDir` remounts the plugin. */
const Config = s.object({
	stateDir: absolute("Directory for the database, locks, worker shims, the agent's git configuration and, by default, the ticket directories.").default(join(homedir(), ".dsh", "state", "xenra-superagent")),
	promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(1e5).description("Largest saved prompt configuration, in characters.").volatile(),
	admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10).description("Pages of thread context one assessment may read.").volatile(),
	admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1).default(15e3).description("Time limit of one context read during an assessment, in milliseconds.").volatile()
});
const MOVED = {
	repository: "on the GitHub Source",
	branchPrefix: "in the prepare command of the Execution settings",
	github: "on the GitHub Source",
	feishu: "on the Feishu Source",
	author: "prompt text",
	repositoryPath: "in the prepare command of the Execution settings",
	worktreeRoot: "the ticket directory of the Execution settings",
	blockedCommands: "in the Execution settings"
};
/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
function machineOf(config) {
	const unknown = Object.keys(config).filter((key) => !(key in (Config.dict ?? {})));
	if (unknown.length) throw new Error(`xenra-superagent configuration has keys it does not use: ${unknown.map((key) => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(", ")}; docs/006-deployment.md lists the keys`);
	const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config;
	return {
		stateDir,
		promptMaxChars,
		admissionContextMaxPages,
		admissionContextTimeoutMs
	};
}
const GithubAccountsSchema = z.object({
	repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, "owner/name").default(""),
	cli: z.string().trim().default("")
});
const FeishuBotSchema = z.object({ cli: z.string().trim().default("") });
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
const SETUP_FIELDS = {
	github: Object.keys(GithubAccountsSchema.shape),
	feishu: Object.keys(FeishuBotSchema.shape)
};
/**
* Resolve a command name or absolute path to an executable file, ignoring the worker shim directory.
* On Windows a bare name also tries the platform's executable extensions, so `gh` finds `gh.exe` or `gh.cmd`.
*/
function executable(name, path, exclude) {
	return resolveExecutable(name, path, exclude);
}
/**
* Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script
* reaches the real binary. The environment is passed to the child rather than set through a helper program, which a Windows
* host has no guaranteed equivalent of: the subprocess service merges these entries onto its scrubbed base.
*/
function workerProbe(subprocess, stateDir, cwd, signal) {
	const path = withoutDirectory(pathValue(), workerBin(stateDir));
	return (argv) => runAsWorker(subprocess, argv, cwd, AbortSignal.any([signal, AbortSignal.timeout(6e4)]), pathEnv(path));
}
const GithubUser = z.object({
	login: z.string().regex(/^[A-Za-z0-9-]+$/),
	id: z.number().int().positive()
});
const RepositoryAccess = z.object({
	name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
	push: z.boolean().nullable()
});
function parsed(schema, text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return;
	}
	const result = schema.safeParse(value);
	return result.success ? result.data : void 0;
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
async function resolveDeployment(machine, github, probe, path = pathValue()) {
	const { stateDir } = machine;
	const accounts = GithubAccountsSchema.parse(github ?? {});
	const remote = accounts.repository;
	if (!remote) throw new SetupError("repositoryUnset");
	if (!accounts.cli) throw new SetupError("agentCliUnset");
	let cli;
	try {
		cli = executable(accounts.cli, path, workerBin(stateDir));
	} catch (error) {
		throw new SetupError("agentCliMissing", { output: reason(error) });
	}
	const text = await probe([
		cli,
		"api",
		"user"
	]).catch((error) => {
		throw new SetupError("agentCliSignedOut", { output: reason(error) });
	});
	const agent = parsed(GithubUser, text);
	if (!agent) throw new SetupError("agentCliNoAccount");
	const access = parsed(RepositoryAccess, await probe([
		cli,
		"api",
		`repos/${remote}`,
		"--jq",
		"{name: .full_name, push: .permissions.push}"
	]).catch((error) => {
		throw new SetupError("repositoryUnreadable", {
			account: agent.login,
			repository: remote,
			output: reason(error)
		});
	}));
	if (!access) throw new SetupError("repositoryUnreported", { repository: remote });
	const repository = access.name;
	if (access.push !== true) throw new SetupError("repositoryReadOnly", {
		account: agent.login,
		repository
	});
	return {
		...machine,
		repository,
		github: {
			cli,
			login: agent.login,
			noreply: `${agent.id}+${agent.login}@users.noreply.github.com`
		}
	};
}
const AuthStatus = z.object({
	appId: z.string().regex(/^cli_[A-Za-z0-9]+$/),
	brand: z.enum(["feishu", "lark"]).default("feishu"),
	identities: z.object({ bot: z.object({ status: z.string() }) })
});
const BotInfo = z.object({ bot: z.object({
	open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/),
	app_name: z.string().default("")
}) });
/**
* Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
* Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
*/
async function resolveFeishuBot(machine, feishu, probe, path = pathValue()) {
	const { cli: name } = FeishuBotSchema.parse(feishu ?? {});
	if (!name) return void 0;
	const fail = (error) => {
		throw error instanceof SetupError ? error : new SetupError("feishuCliFailed", { output: reason(error) });
	};
	let cli = "";
	try {
		cli = executable(name, path, workerBin(machine.stateDir));
	} catch (error) {
		fail(error);
	}
	const run = (...args) => probe([cli, ...args]).catch(fail);
	const text = await run("auth", "status");
	const status = parsed(AuthStatus, text.slice(text.indexOf("{")));
	if (!status) return fail(new SetupError("feishuNoApp"));
	if (status.identities.bot.status !== "ready") fail(new SetupError("feishuBotNotReady", {
		app: status.appId,
		status: status.identities.bot.status
	}));
	const mode = /strict-mode:\s*(\w+)/.exec(await run("config", "strict-mode"))?.[1];
	if (mode !== "bot") fail(new SetupError("feishuUserIdentity", { mode: mode ?? "unknown" }));
	const info = parsed(BotInfo, (await run("api", "GET", "/open-apis/bot/v3/info", "--as", "bot", "--format", "ndjson")).split("\n")[0] ?? "");
	if (!info) return fail(new SetupError("feishuNoBot"));
	return {
		cli,
		appId: status.appId,
		brand: status.brand,
		botId: info.bot.open_id,
		name: info.bot.app_name
	};
}
//#endregion
//#region src/sources/host.ts
/** Fixed English health templates (`{name}` placeholders); the panel localizes each `code` in the interface language. */
const HEALTH_TEXT = {
	setupPending: "Waiting for the deployment check",
	sourceOff: "Off",
	feishuCliUnset: "The Source is on, and its bot lark-cli is not set",
	feishuBotMissing: "Waiting for the Feishu bot",
	pollFailures: "{count} consecutive failed polls; last: {error}"
};
function health(state, code, values = {}) {
	return {
		state,
		detail: fill(HEALTH_TEXT[code], values),
		code,
		...Object.keys(values).length ? { values } : {}
	};
}
const sourceContext = (host, kind) => host.context(kind);
//#endregion
//#region src/sources/poll.ts
/** Shared polling helpers for subscribed threads, overlap-safe cursors, and timer-friendly delays. */
/** How long a subscribed Thread with no live Ticket continues to be polled after its last Trigger or Ticket end. */
const POLL_HORIZON_MS = 12096e5;
/** True when a subscribed thread has a live ticket or recent activity/completion within `POLL_HORIZON_MS`. */
function polled(ctx, thread, now = Date.now()) {
	const tickets = thread.subscriptions.map((id) => ctx.tickets.get(id));
	if (tickets.some((ticket) => !!ticket && liveTicket(ticket))) return true;
	const times = [thread.lastAt ?? thread.createdAt, ...tickets.map((ticket) => ticket?.ended?.at ?? "")].map(Date.parse).filter(Number.isFinite);
	return now - Math.max(...times) < POLL_HORIZON_MS;
}
/** Steps a poll start timestamp back by 5 seconds so late-arriving remote events are not missed; deterministic trigger IDs deduplicate overlaps. */
const cursorAt = (started) => (/* @__PURE__ */ new Date(Date.parse(started) - 5e3)).toISOString();
/** Polls each subscribed Thread of `source` within the horizon independently; records failures on the Thread as `pollError` (unless `stopped()`) and clears `pollError` on success. */
async function pollThreads(ctx, source, stopped, poll, skip = () => false) {
	for (const thread of ctx.threads.subscribed(source)) {
		if (stopped()) return;
		if (skip(thread) || !polled(ctx, thread)) continue;
		try {
			await poll(thread);
			ctx.threads.patch(thread.key, { pollError: void 0 });
		} catch (error) {
			if (stopped()) return;
			ctx.threads.patch(thread.key, { pollError: String(error) });
		}
	}
}
/** Waits `ms` or until `signal` aborts using global `setTimeout` so test fake timers can drive polling loops. */
function pause(ms, signal) {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const stop = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", stop);
			resolve();
		}, ms);
		signal.addEventListener("abort", stop, { once: true });
	});
}
//#endregion
export { threadKey as $, planUpgrade as A, sameName as B, verifyEnvironment as C, GIT_MINIMUM as D, writeEnvironment as E, Commands as F, isoTime as G, LIMITS as H, validItems as I, liveTicket as J, latestAssignment as K, SetupError as L, shellCommand as M, spawnArgv as N, atLeast as O, CliError as P, settled as Q, checkedImText as R, verifyDirectory as S, workerBin as T, key as U, wordCount as V, followupOwners as W, readUntil as X, reached as Y, runningAssignment as Z, record as _, polled as a, removeState as b, Config as c, SETUP_FIELDS as d, ticketOutcome as et, machineOf as f, KV as g, workerProbe as h, pollThreads as i, upgrade as j, gitVersionOf as k, FeishuBotSchema as l, resolveFeishuBot as m, cursorAt as n, health as o, resolveDeployment as p, latestReport as q, pause as r, sourceContext as s, POLL_HORIZON_MS as t, waitsForPerson as tt, GithubAccountsSchema as u, WORKER_COMMANDS as v, withoutDirectory as w, runAsWorker as x, agentVariables as y, escapeRegExp as z };
