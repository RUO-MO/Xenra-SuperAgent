import { d as string, l as object, r as array, y as key } from "./schemas-CsYdQGdM.js";
const SOURCE = "workbench";
const WorkbenchConfigSchema = object({ 
/** Who may originate work from the console, in the deployment's own vocabulary. Empty means nobody. */
allowed: array(object({
	id: string().trim().min(1).max(200),
	name: string().trim().max(100).optional()
}).strict()).refine((users) => new Set(users.map((user) => user.id)).size === users.length, "Duplicate user IDs").default([]) }).strict();
/** Builds the Trigger for a console request. The thread is the target (`target`), not the entry channel. */
function workbenchTrigger(request, target) {
	return {
		id: key("workbench-request", request.id),
		source: SOURCE,
		threads: [{
			source: SOURCE,
			id: target
		}],
		actor: {
			source: SOURCE,
			id: request.actor
		},
		human: true,
		addressed: "direct",
		at: request.at,
		text: request.text,
		meta: {
			target,
			...request.scope ? { scope: request.scope } : {}
		}
	};
}
const workbenchKind = {
	kind: SOURCE,
	title: {
		zh: "工作台",
		en: "Workbench"
	},
	description: {
		zh: "在面板里直接写下要求，作用于已配置的项目。",
		en: "Write a request directly in the panel, acting on the configured project."
	},
	schema: WorkbenchConfigSchema,
	fields: [{
		key: "allowed",
		type: "rows",
		label: {
			zh: "可以提要求的人",
			en: "Who may make requests"
		},
		hint: {
			zh: "只有名单上的人从工作台提交的要求才会被接收；其余按评估设置处理。",
			en: "Only requests from people on this list are admitted; the rest follow the evaluation settings."
		},
		columns: [{
			key: "id",
			type: "text",
			label: {
				zh: "账号",
				en: "Account"
			},
			pattern: "[A-Za-z0-9._@-]+",
			placeholder: {
				zh: "例如：alice",
				en: "For example alice"
			}
		}, {
			key: "name",
			type: "text",
			label: {
				zh: "显示名",
				en: "Display name"
			},
			optional: true,
			placeholder: {
				zh: "例如：张三",
				en: "For example Alice"
			}
		}]
	}],
	health: ["workbench"],
	scope({ meta }, config) {
		if (typeof meta.target !== "string" || !meta.target) return {
			listened: false,
			reason: "workbench_no_target"
		};
		return {
			listened: true,
			observed: false,
			row: config.allowed.length ? "listed" : "default"
		};
	},
	channel: {
		send: async (_host, _message) => "sent",
		link: (address) => ({
			url: `#workbench/${address.target ?? ""}`,
			label: {
				zh: "工作台",
				en: "Workbench"
			}
		})
	},
	policy: {
		unnamed: {
			person: {
				zh: "工作台用户",
				en: "Workbench user"
			},
			bot: {
				zh: "工作台机器人",
				en: "Workbench bot"
			}
		},
		schema: object({ allowed: WorkbenchConfigSchema.shape.allowed }).strict(),
		fields: [{
			key: "allowed",
			type: "rows",
			label: {
				zh: "可以提要求的人",
				en: "Who may make requests"
			},
			columns: [{
				key: "id",
				type: "text",
				label: {
					zh: "账号",
					en: "Account"
				},
				pattern: "[A-Za-z0-9._@-]+",
				placeholder: {
					zh: "例如：alice",
					en: "For example alice"
				}
			}, {
				key: "name",
				type: "text",
				label: {
					zh: "显示名",
					en: "Display name"
				},
				optional: true
			}]
		}],
		explicit: {
			zh: "在工作台里直接写下要求。",
			en: "A request written directly in the workbench."
		}
	},
	environment: {
		variables: [{
			key: "XENRA_SUPERAGENT_WORKBENCH_TARGET",
			description: {
				zh: "这次要求作用的目标",
				en: "The target this request acts on"
			}
		}, {
			key: "XENRA_SUPERAGENT_WORKBENCH_SCOPE",
			description: {
				zh: "提出要求的人声明的改动范围",
				en: "The scope the requester declared"
			}
		}],
		values: ({ trigger }) => ({
			XENRA_SUPERAGENT_WORKBENCH_TARGET: trigger?.source === "workbench" ? String(trigger.meta.target ?? "") : "",
			XENRA_SUPERAGENT_WORKBENCH_SCOPE: trigger?.source === "workbench" ? String(trigger.meta.scope ?? "") : ""
		})
	}
};
const name = "xenra-superagent-workbench";
const inject = ["orchestrator"];
function apply(ctx) {
	ctx.effect(() => ctx.orchestrator.sources.register(workbenchKind), "workbench: source kind");
}
export { SOURCE, apply, inject, name, workbenchKind, workbenchTrigger };
