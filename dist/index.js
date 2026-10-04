import { createRequire } from "node:module";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { gzipSync, zstdDecompressSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import * as qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
//#region src/common/config.ts
const DEFAULT_CONFIG = {
	credentialRef: "LARK_LINK_APP",
	groupPolicy: "open",
	groupKeywords: ["lark", "小斯"],
	alsoOnReply: true,
	streaming: {
		enabled: false,
		printFrequencyMs: 120,
		printStep: 3
	},
	reactions: {
		enabled: true,
		pool: [
			"THUMBSUP",
			"OK",
			"HEART",
			"LAUGH",
			"SMILE",
			"WOW",
			"CLAP",
			"Fire"
		],
		done: "DONE"
	},
	attachments: {
		dir: "",
		retentionHours: 168
	},
	outbox: {
		maxAttempts: 50,
		backoffMaxMs: 6e4,
		retainDays: 7,
		pendingCap: 1e4,
		blobThreshold: 24e3
	},
	supervisor: {
		probeIntervalMs: 3e4,
		probeTimeoutMs: 8e3,
		probeFailThreshold: 3,
		maxReconnectAttempts: 8,
		idleKeepaliveMs: 12e5
	},
	quota: {
		windowMinutes: 60,
		limit: 12
	},
	denyList: [],
	sessionIdleTtlMs: 18e5,
	maxSessions: 32,
	allowlist: [],
	workspaceRoot: "",
	agentPreset: "ptc",
	permissionMode: "danger-full-access"
};
/**
* Map a configured agent-preset id onto one DSH's agent-presets service
* accepts. DSH ships `standard | ptc | minimal | cordis` — there is no
* `code`. Older bridge configs/UI used `code` for what DSH calls `ptc`
* (GH #11); keep accepting the alias so stored overrides still work.
*/
function normalizeAgentPreset(id) {
	return id === "code" ? "ptc" : id;
}
/** Keys that may be hot-reloaded via /lark-config (whitelist, never credentials). */
const HOT_RELOADABLE = [
	"groupPolicy",
	"groupKeywords",
	"alsoOnReply",
	"workspaceRoot",
	"agentPreset",
	"permissionMode",
	"streaming",
	"reactions",
	"denyList",
	"allowlist",
	"attachments"
];
/**
* Parse a /lark-config key path into a hot-reload patch.
*
* Accepts BOTH top-level keys ("denyList") and dotted paths under
* object-valued whitelist keys ("streaming.enabled", "streaming.printStep") —
* the dotted form is what users naturally type for the streaming knobs and
* used to be rejected with 不可热改 because only the exact top-level names
* were matched. Unknown top-level segments and unknown/over-deep nested keys
* throw so typos never silently no-op.
*/
function buildHotReloadPatch(key, value) {
	const segments = key.split(".").filter((s) => s !== "");
	if (segments.length === 0) throw new Error(`config key "${key}" is not hot-reloadable`);
	const head = segments[0];
	const rest = segments.slice(1);
	if (!HOT_RELOADABLE.includes(head)) throw new Error(`config key "${head}" is not hot-reloadable`);
	if (rest.length === 0) return { [head]: value };
	if (rest.length > 1) throw new Error(`config key "${key}" is unknown (FeishuConfig nests one level deep)`);
	const nested = DEFAULT_CONFIG[head];
	const nestedKey = rest[0];
	if (typeof nested !== "object" || nested === null || Array.isArray(nested) || !(nestedKey in nested)) throw new Error(`config key "${key}" is unknown (not a configurable nested key)`);
	return { [head]: { [nestedKey]: value } };
}
function deepMerge(base, over) {
	const out = { ...base };
	for (const [k, v] of Object.entries(over ?? {})) {
		if (v === void 0) continue;
		const existing = out[k];
		if (existing !== null && v !== null && typeof existing === "object" && typeof v === "object" && !Array.isArray(existing) && !Array.isArray(v)) out[k] = deepMerge(existing, v);
		else out[k] = v;
	}
	return out;
}
function createConfigStore(stateDir, initialOverrides) {
	const overridesPath = join(stateDir, "runtime-overrides.json");
	mkdirSync(dirname(overridesPath), { recursive: true });
	let overrides = { ...initialOverrides ?? {} };
	try {
		const raw = readFileSync(overridesPath, "utf8");
		const parsed = JSON.parse(raw);
		overrides = deepMerge(overrides, parsed);
	} catch {}
	const get = () => deepMerge(DEFAULT_CONFIG, overrides);
	const persist = (file, data) => {
		try {
			writeFileSync(file, JSON.stringify(data, null, 2), { mode: 384 });
		} catch {}
	};
	return {
		get,
		update(partial) {
			for (const key of Object.keys(partial)) if (!HOT_RELOADABLE.includes(key)) throw new Error(`config key "${key}" is not hot-reloadable`);
			overrides = deepMerge(overrides, partial);
			return get();
		},
		save() {
			persist(join(stateDir, "config.json"), get());
		},
		saveOverrides() {
			persist(overridesPath, overrides);
		},
		path: () => overridesPath
	};
}
//#endregion
//#region src/sessions/dsh-adapter.ts
/** Resolve the DSH agent-preset id for a conversation, normalizing aliases. */
function resolveAgentPreset(key, deps, presetOverrides) {
	return normalizeAgentPreset(presetOverrides.get(key) ?? deps.preset?.(key) ?? "ptc");
}
/** Pending per-session projection checkpoints (one timer each, replaced). */
const projectionCheckpoints = /* @__PURE__ */ new Map();
/**
* Durably checkpoint one session's projection (title, list metadata, …) shortly
* after its turn ends.
*
* WHY: DSH's session list reads COLD sessions' titles from the projection cache
* only. Bridge-owned sessions were never opened in the Web UI, so without this
* write the GUI showed them as "未命名" after every restart, while opening one
* (making it live) revealed the real title. The delay lets the async title
* generation land first; failures are swallowed — a missing cache row must
* never affect the conversation.
*/
function scheduleProjectionCheckpoint(ctx, session) {
	const id = session?.id;
	if (typeof id !== "string" || id === "") return;
	const cache = ctx?.get?.("sessionProjectionCache");
	if (typeof cache?.write !== "function") return;
	const previous = projectionCheckpoints.get(id);
	if (previous !== void 0) clearTimeout(previous);
	projectionCheckpoints.set(id, setTimeout(() => {
		projectionCheckpoints.delete(id);
		try {
			Promise.resolve(cache.write?.(session)).catch(() => void 0);
		} catch {}
	}, 2500));
}
function textOf(blocks) {
	return (blocks ?? []).filter((b) => b.type === "text" && b.text !== void 0).map((b) => b.text).join("");
}
function toSessionEventOut(ev) {
	const raw = ev;
	switch (raw.type) {
		case "turn/start": return { type: "turn/start" };
		case "assistant/chunk": {
			const c = raw.data?.chunk;
			if (c?.type === "text-delta") return {
				type: "assistant/chunk",
				text: c.text
			};
			return;
		}
		case "assistant/message": return {
			type: "assistant/message",
			text: textOf(raw.data?.message?.content)
		};
		case "turn/end": return {
			type: "turn/end",
			reason: raw.data?.reason?.kind ?? "done"
		};
		case "tool/call": return {
			type: "tool/call",
			name: raw.data?.name
		};
		case "tool/result": return {
			type: "tool/result",
			name: raw.data?.message?.content?.[0]?.type ?? "?",
			error: raw.data?.error
		};
		case "todo/write": {
			const d = raw.data;
			if (Array.isArray(d?.todos)) return {
				type: "todo/write",
				todos: d.todos
			};
			if (Array.isArray(raw.data)) return {
				type: "todo/write",
				todos: raw.data
			};
			return;
		}
		case "goal/change": {
			const d = raw.data;
			const target = d?.goal ?? d;
			if (target && typeof target.id === "string" && typeof target.objective === "string") return {
				type: "goal/change",
				goal: {
					id: target.id,
					revision: typeof target.revision === "number" ? target.revision : 1,
					objective: target.objective,
					phase: target.phase || "active",
					roundsStarted: typeof d.roundsStarted === "number" ? d.roundsStarted : typeof target.roundsStarted === "number" ? target.roundsStarted : 0,
					maxGoalRounds: typeof target.maxGoalRounds === "number" ? target.maxGoalRounds : 256,
					blockedReason: target.blockedReason,
					createdAt: typeof d.createdAt === "number" ? d.createdAt : typeof target.createdAt === "number" ? target.createdAt : Date.now(),
					updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : typeof target.updatedAt === "number" ? target.updatedAt : Date.now()
				}
			};
			if (d?.operation === "clear" && d.cleared) return {
				type: "goal/change",
				goal: {
					id: d.cleared.id,
					revision: d.cleared.revision,
					objective: "(目标已清除)",
					phase: "complete",
					roundsStarted: 0,
					maxGoalRounds: 0,
					createdAt: Date.now(),
					updatedAt: Date.now()
				}
			};
			return;
		}
		default: return;
	}
}
function isImageUnsupportedError(errText, errCode) {
	if (errCode === "UNSUPPORTED_CONTENT" && /image|vision|multimodal|content/i.test(errText)) return true;
	return /does not support image/i.test(errText) || /does not support .*image/i.test(errText) || /adapter does not support image/i.test(errText) || /model .* does not support image/i.test(errText) || /model does not support/i.test(errText) && /image|vision/i.test(errText) || /image (?:input|content) is not supported/i.test(errText) || /not support (?:image|images|vision|multimodal)/i.test(errText) || /unsupported (?:image|content|content_type)/i.test(errText) || /cannot represent .*image/i.test(errText) || /image.*requires the durable attachment service/i.test(errText) || /UNSUPPORTED_CONTENT/i.test(errText);
}
function createDshAdapter(deps) {
	const c = deps.ctx;
	const selFor = (key) => {
		const ms = deps.modelSelection;
		if (!ms) return void 0;
		if ("currentFor" in ms) return ms.currentFor(key);
		return ms.current;
	};
	const tracked = /* @__PURE__ */ new Map();
	const keyBySession = /* @__PURE__ */ new Map();
	const listeners = /* @__PURE__ */ new Map();
	const disposers = /* @__PURE__ */ new Map();
	const lastAssistantText = /* @__PURE__ */ new Map();
	const ensureInFlight = /* @__PURE__ */ new Map();
	let runNonce = deps.runNonce ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	const generations = /* @__PURE__ */ new Map();
	const bridgeKey = (key) => `${deps.sessionPrefix}-${key.replace(/[^A-Za-z0-9_-]+/g, "-")}-${runNonce}-${generations.get(key) ?? 0}`;
	const pendingResume = /* @__PURE__ */ new Map();
	const presetOverrides = /* @__PURE__ */ new Map();
	const imageUnsupportedKeys = /* @__PURE__ */ new Set();
	const imageUnsupportedModels = /* @__PURE__ */ new Set();
	const imageRetryGrace = /* @__PURE__ */ new Set();
	const pendingImageRetry = /* @__PURE__ */ new Map();
	/**
	* Thoroughly retire/evict any live agent or session matching targetSessionId from memory.
	* DSH session persistence requires targetSessionId to be completely absent from ctx.sessions
	* before agents.resume / sessionPersistence.prepare can execute.
	*/
	const releaseLiveSession = async (targetSessionId) => {
		for (const [k, t] of Array.from(tracked.entries())) if (t.handle.sessionId === targetSessionId) {
			disposers.get(k)?.();
			disposers.delete(k);
			listeners.delete(k);
			tracked.delete(k);
			keyBySession.delete(targetSessionId);
			try {
				await t.handle.dispose();
			} catch (err) {
				deps.logger?.warn?.(`releaseLiveSession: error disposing tracked handle for ${targetSessionId}: ${String(err)}`);
			}
		}
		const ownerKey = keyBySession.get(targetSessionId);
		if (ownerKey) {
			keyBySession.delete(targetSessionId);
			const t = tracked.get(ownerKey);
			if (t) {
				disposers.get(ownerKey)?.();
				disposers.delete(ownerKey);
				listeners.delete(ownerKey);
				tracked.delete(ownerKey);
				try {
					await t.handle.dispose();
				} catch {}
			}
		}
		try {
			const agentsRegistry = c.agents;
			if (agentsRegistry) {
				const liveAgent = agentsRegistry.get?.(targetSessionId);
				if (liveAgent?.ctx) try {
					await (liveAgent.ctx.scope?.dispose?.() ?? liveAgent.ctx.dispose?.());
				} catch {}
				const list = agentsRegistry.list?.() ?? [];
				for (const a of list) if (a.id === targetSessionId || a.session?.id === targetSessionId) try {
					await (a.ctx?.scope?.dispose?.() ?? a.ctx?.dispose?.());
				} catch {}
				const agentStore = agentsRegistry.store;
				if (agentStore && agentStore.has(targetSessionId)) {
					const entry = agentStore.get(targetSessionId);
					try {
						await (entry?.agent?.ctx?.scope?.dispose?.() ?? entry?.agent?.ctx?.dispose?.());
					} catch {}
					try {
						entry?.detach?.();
					} catch {}
					agentStore.delete(targetSessionId);
				}
				if (agentsRegistry.agents && agentsRegistry.agents.has(targetSessionId)) agentsRegistry.agents.delete(targetSessionId);
				if (typeof agentsRegistry.delete === "function") try {
					agentsRegistry.delete(targetSessionId);
				} catch {}
			}
		} catch {}
		try {
			const sessionsRegistry = c.sessions;
			if (sessionsRegistry?.store && sessionsRegistry.store.has(targetSessionId)) {
				const entry = sessionsRegistry.store.get(targetSessionId);
				try {
					entry?.detach?.();
				} catch {}
				sessionsRegistry.store.delete(targetSessionId);
			}
		} catch {}
		try {
			const persistence = c.get?.("sessionPersistence") ?? c.sessionPersistence;
			if (typeof persistence?.waitForRetirement === "function") await persistence.waitForRetirement(targetSessionId);
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 0));
	};
	const rotateKey = (key) => {
		pendingImageRetry.delete(key);
		lastAssistantText.delete(key);
		runNonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		generations.delete(key);
		presetOverrides.delete(key);
		deps.setActiveSessionId?.(key, void 0);
		const t = tracked.get(key);
		if (t) {
			disposers.get(key)?.();
			disposers.delete(key);
			listeners.delete(key);
			tracked.delete(key);
			const oldId = t.handle.sessionId;
			if (oldId) keyBySession.delete(oldId);
			try {
				t.handle.dispose();
			} catch {}
		}
	};
	async function ensureAgent(key) {
		const existing = tracked.get(key);
		if (existing) {
			existing.lastUsedAt = Date.now();
			return existing.handle;
		}
		const inFlight = ensureInFlight.get(key);
		if (inFlight) return inFlight.then((h) => {
			const t = tracked.get(key);
			if (t) t.lastUsedAt = Date.now();
			return h;
		});
		const p = (async () => {
			const pending = pendingResume.get(key);
			let sessionId = pending?.sessionId ?? bridgeKey(key);
			let owned;
			const sel = selFor(key);
			const defaultModel = sel?.provider && sel.model ? sel : void 0;
			const agentOptions = defaultModel ? {
				provider: defaultModel.provider,
				model: defaultModel.model
			} : void 0;
			if (!defaultModel) deps.logger?.warn(`no model selection — bridge agent for ${key} has no provider/model; turns will fail unless one is supplied`);
			const setup = async (agentCtx) => {
				const sel = selFor(key);
				if (sel?.provider && sel.model) installModelSelection(agentCtx, {
					current: sel,
					assembled: void 0
				});
				const presets = c.get?.("agentPresets");
				const resolvedPreset = resolveAgentPreset(key, deps, presetOverrides);
				if (presets?.mount) {
					if (presets.list) try {
						const rows = await presets.list();
						if (rows.length > 0 && !rows.some((r) => r.id === resolvedPreset)) deps.logger?.warn(`agent preset "${resolvedPreset}" is not in the DSH roster (available: ${rows.map((r) => r.id).join(", ")}) — create/mount may fail`);
					} catch {}
					await presets.mount(agentCtx, resolvedPreset);
				}
				if (deps.askUserQuestion) {
					const askTool = defineTool({
						name: "ask_user_question",
						description: "Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. Send one or more questions, each with a stable id that will be echoed in the answer.",
						parameters: { questions: {
							type: "array",
							required: true,
							description: "Questions to ask the user before continuing.",
							items: {
								type: "object",
								additionalProperties: true,
								properties: {
									id: {
										type: "string",
										required: true,
										description: "Stable id for this question; echoed in the answer."
									},
									question: {
										type: "string",
										required: true,
										description: "The specific question to ask the user."
									},
									header: {
										type: "string",
										description: "Optional short heading for the question."
									},
									options: {
										type: "array",
										description: "Optional choices to show the user.",
										items: {
											type: "object",
											additionalProperties: true,
											properties: {
												label: {
													type: "string",
													required: true,
													description: "Short user-facing option label."
												},
												description: {
													type: "string",
													description: "One sentence explaining the tradeoff or impact."
												}
											}
										}
									},
									multi_select: {
										type: "boolean",
										description: "Whether the user may select more than one option. Defaults to false."
									}
								}
							}
						} },
						output: {
							schema: {
								type: "object",
								additionalProperties: false,
								properties: { answers: {
									type: "array",
									required: true,
									items: {
										type: "object",
										additionalProperties: false,
										properties: {
											id: {
												type: "string",
												required: true
											},
											selected: {
												type: "array",
												required: true,
												items: { type: "string" }
											},
											custom: { type: "string" }
										}
									}
								} }
							},
							render: (_args, value) => [{
								type: "text",
								text: JSON.stringify(value)
							}]
						},
						async execute(args, exec) {
							if (!deps.askUserQuestion) return { answers: [] };
							const questions = (args.questions ?? []).map((q) => ({
								id: q.id,
								question: q.question,
								...q.header !== void 0 ? { header: q.header } : {},
								...q.options !== void 0 ? { options: q.options } : {},
								...q.multi_select !== void 0 ? { multiSelect: q.multi_select } : {}
							}));
							const agentId = exec.agent?.id ?? "";
							return deps.askUserQuestion(questions, agentId);
						}
					});
					agentCtx.tools?.register?.(askTool);
				}
			};
			if (pending) {
				await releaseLiveSession(pending.sessionId);
				try {
					owned = await c.agents.resume({
						resumeSessionId: pending.sessionId,
						...agentOptions ? { agentOptions } : {},
						setup
					});
					sessionId = pending.sessionId;
					deps.setActiveSessionId?.(key, sessionId);
				} catch (err) {
					throw new Error(`failed to resume session "${pending.sessionId}" for ${key}: ${err instanceof Error ? err.message : String(err)}`);
				}
			} else {
				const activeId = deps.activeSessionId?.(key);
				let resumedOwned;
				if (activeId) try {
					await releaseLiveSession(activeId);
					resumedOwned = await c.agents.resume({
						resumeSessionId: activeId,
						...agentOptions ? { agentOptions } : {},
						setup
					});
					sessionId = activeId;
				} catch (err) {
					deps.logger?.warn(`failed to resume active session "${activeId}" for ${key}: ${err instanceof Error ? err.message : String(err)} — falling back to create fresh session`);
					try {
						deps.onResumeFallback?.(key, activeId, err);
					} catch {}
				}
				if (resumedOwned) owned = resumedOwned;
				else {
					sessionId = bridgeKey(key);
					try {
						owned = await c.agents.create({
							sessionId,
							meta: {
								cwd: deps.cwd?.(key) ?? process.cwd(),
								agentPreset: resolveAgentPreset(key, deps, presetOverrides)
							},
							...agentOptions ? { agentOptions } : {},
							setup
						});
						deps.setActiveSessionId?.(key, sessionId);
					} catch (err) {
						if (err instanceof Error && /already exists|already has a persisted log/i.test(err.message)) try {
							await releaseLiveSession(sessionId);
							owned = await c.agents.resume({
								resumeSessionId: sessionId,
								...agentOptions ? { agentOptions } : {},
								setup
							});
							deps.setActiveSessionId?.(key, sessionId);
						} catch (resumeErr) {
							deps.logger?.warn(`session id collision for ${key} and resume failed — minting fresh session: ${String(resumeErr)}`);
							runNonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
							const freshId = bridgeKey(key);
							try {
								owned = await c.agents.create({
									sessionId: freshId,
									meta: {
										cwd: deps.cwd?.(key) ?? process.cwd(),
										agentPreset: resolveAgentPreset(key, deps, presetOverrides)
									},
									...agentOptions ? { agentOptions } : {},
									setup
								});
								sessionId = freshId;
								deps.setActiveSessionId?.(key, sessionId);
							} catch (err2) {
								throw new Error(`failed to mint fresh session for ${key} (was "${sessionId}"): ${err2 instanceof Error ? err2.message : String(err2)}`);
							}
						}
						else throw new Error(`failed to create DSH agent for ${key}: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
			}
			if (!owned?.agent) throw new Error(`DSH agents.create returned no agent for ${key}`);
			const wsCwd = deps.cwd?.(key) ?? process.cwd();
			try {
				const workspaces = c.get?.("workspaceRegistry");
				if (workspaces?.create) {
					const entity = await workspaces.create(wsCwd, basename(wsCwd));
					deps.logger?.info(`workspace create: ${wsCwd} (${entity ? "entity" : "none"})`);
					if (entity?.attachSession) {
						await entity.attachSession(sessionId);
						deps.logger?.info(`workspace attach: ${sessionId} -> ${wsCwd}`);
					} else deps.logger?.warn(`workspace attach skipped: entity has no attachSession (${wsCwd})`);
				} else deps.logger?.warn(`workspaceRegistry unavailable — session ${sessionId} will show under 未分组`);
			} catch (err) {
				deps.logger?.warn(`workspace create/attach failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
			}
			const agent = owned.agent;
			try {
				const services = c;
				const permission = services.get?.("permissionPresets");
				const approval = services.get?.("approval");
				const mode = deps.permissionMode?.();
				if (permission?.apply && agent.session && mode) {
					permission.apply(agent.session, mode, (policy) => {
						approval?.setPolicy?.(agent, policy);
					});
					deps.logger?.info(`permission for ${key} set to ${mode} (session-scoped)`);
				}
			} catch (err) {
				deps.logger?.warn(`permission apply failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
			}
			const handle = {
				agentId: agent.id,
				sessionId,
				async followup(text, attachments) {
					const parts = [text];
					const content = [{
						type: "text",
						text
					}];
					const currentModel = selFor(key);
					const modelTag = currentModel?.provider && currentModel?.model ? `${currentModel.provider}/${currentModel.model}` : void 0;
					const isUnsupported = imageUnsupportedKeys.has(key) || (modelTag ? imageUnsupportedModels.has(modelTag) : false);
					for (const a of attachments ?? []) if (a.kind === "image") {
						if (a.imageRef && !isUnsupported) content.push({
							type: "image",
							attachment: a.imageRef
						});
						if (a.path && !a.path.startsWith("feishu://")) parts.push(`\n\n[用户发送了图片，已保存到本地: ${a.path}（需要查看时用 read_image 工具读取该路径）]`);
						else if (!a.imageRef) parts.push("\n\n[用户发送了图片，但未能保存（无附件服务）]");
					} else if (a.kind === "file" && a.textPreview) parts.push(`\n\n[附件 ${a.name ?? "文件"} 内容]\n${a.textPreview}`);
					else if (a.kind === "file") parts.push(`\n\n[附件 ${a.name ?? "文件"}（未能提取文本）]`);
					content[0] = {
						type: "text",
						text: parts.join("")
					};
					const message = createUserMessage({
						content,
						source: { kind: "user" }
					});
					if (content.length > 1) pendingImageRetry.set(key, createUserMessage({
						content: [content[0]],
						source: { kind: "user" }
					}));
					else pendingImageRetry.delete(key);
					agent.followup(message);
				},
				rawAgent: agent,
				async cancel() {
					agent.cancel({ kind: "user" });
				},
				onEvent(fn) {
					const set = listeners.get(key) ?? /* @__PURE__ */ new Set();
					set.add(fn);
					listeners.set(key, set);
					return () => {
						set.delete(fn);
					};
				},
				isIdle: () => agent.status === "idle",
				async dispose() {
					disposers.get(key)?.();
					disposers.delete(key);
					await owned.dispose();
					tracked.delete(key);
					keyBySession.delete(sessionId);
					listeners.delete(key);
					pendingImageRetry.delete(key);
					lastAssistantText.delete(key);
				}
			};
			tracked.set(key, {
				handle,
				lastUsedAt: Date.now()
			});
			keyBySession.set(sessionId, key);
			const disp = (c.on ?? agent.ctx.on?.bind(agent.ctx))?.("session/event", (sess, ev) => {
				if (sess !== void 0 && sess !== agent.session && sess?.id !== sessionId) return;
				const out = toSessionEventOut(ev);
				if (!out) return;
				if (out.type === "turn/start") lastAssistantText.delete(key);
				if (out.type === "assistant/message" && out.text.trim() !== "") lastAssistantText.set(key, out.text);
				if (out.type === "turn/end" && out.finalText === void 0) {
					const final = lastAssistantText.get(key);
					if (final !== void 0) out.finalText = final;
					lastAssistantText.delete(key);
				}
				if (out.type === "turn/end") scheduleProjectionCheckpoint(c, agent.session);
				const set = listeners.get(key);
				if (set) for (const fn of set) fn(out);
			}) ?? (() => {});
			disposers.set(key, disp);
			const errDisp = agent.ctx.on("agent/error", (payload) => {
				const errText = payload.error instanceof Error ? payload.error.message : String(payload.error);
				const errObj = payload.error;
				const errCode = errObj?.code ?? (errObj?.failure)?.code;
				deps.logger?.warn(`agent error for ${key}: ${errText}`);
				if (isImageUnsupportedError(errText, errCode)) {
					imageUnsupportedKeys.add(key);
					const currentModel = selFor(key);
					if (currentModel?.provider && currentModel?.model) imageUnsupportedModels.add(`${currentModel.provider}/${currentModel.model}`);
					const retry = pendingImageRetry.get(key);
					if (retry) {
						pendingImageRetry.delete(key);
						imageRetryGrace.add(key);
						(async () => {
							try {
								if (typeof agent.whenIdle === "function") await agent.whenIdle();
								agent.followup(retry);
								deps.logger?.info(`model rejects image input for ${key}; retried text-only (image stays on disk, read_image available)`);
							} catch (err) {
								deps.logger?.warn(`text-only retry failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
							}
						})();
					}
				}
			});
			disposers.set(key, errDisp);
			return handle;
		})();
		ensureInFlight.set(key, p);
		try {
			return await p;
		} finally {
			ensureInFlight.delete(key);
		}
	}
	return {
		consumeImageRetryGrace(key) {
			if (imageRetryGrace.has(key)) {
				imageRetryGrace.delete(key);
				return true;
			}
			return false;
		},
		clearImageUnsupported(key) {
			if (key) imageUnsupportedKeys.delete(key);
			else {
				imageUnsupportedKeys.clear();
				imageUnsupportedModels.clear();
			}
		},
		async ensureAgent(key) {
			return ensureAgent(key);
		},
		async resumeAgent(key, sessionId, opts) {
			const existingCurrent = tracked.get(key);
			if (existingCurrent && existingCurrent.handle.sessionId === sessionId && (!opts?.preset || opts.preset === deps.preset?.(key))) return existingCurrent.handle;
			await releaseLiveSession(sessionId);
			rotateKey(key);
			if (opts?.preset) presetOverrides.set(key, normalizeAgentPreset(opts.preset));
			pendingResume.set(key, { sessionId });
			try {
				return await ensureAgent(key);
			} finally {
				pendingResume.delete(key);
			}
		},
		get: (key) => tracked.get(key)?.handle,
		keyForSessionId: (sessionId) => keyBySession.get(sessionId),
		async listPresets() {
			const presets = c.get?.("agentPresets");
			if (!presets?.list) return [];
			try {
				return (await presets.list()).map((row) => ({
					id: row.id,
					label: row.name ?? row.id,
					...row.trust === void 0 ? {} : { trust: row.trust },
					...row.description === void 0 ? {} : { desc: row.description },
					...row.broken === void 0 ? {} : { broken: row.broken }
				}));
			} catch (err) {
				deps.logger?.warn(`agentPresets.list() failed — /mode falls back to shipped presets: ${String(err)}`);
				return [];
			}
		},
		disposeIdle(idleTtlMs) {
			const toDispose = [];
			for (const [key, t] of tracked) if (t.handle.isIdle() && Date.now() - t.lastUsedAt >= idleTtlMs) toDispose.push({
				key,
				handle: t.handle
			});
			for (const { key, handle } of toDispose) {
				tracked.delete(key);
				keyBySession.delete(handle.sessionId);
				generations.set(key, (generations.get(key) ?? 0) + 1);
				handle.dispose();
			}
			return toDispose.length;
		},
		size: () => tracked.size,
		rotate(key) {
			rotateKey(key);
		},
		async dispose(key) {
			const t = tracked.get(key);
			if (!t) return;
			await t.handle.dispose();
			tracked.delete(key);
		},
		async disposeAll() {
			for (const t of tracked.values()) await t.handle.dispose();
			tracked.clear();
			keyBySession.clear();
		}
	};
}
//#endregion
//#region src/sessions/dsh-session-backend.ts
/** The shipped preset roster, mirrored here so the memory backend (used when
* DSH services are absent) still answers a /mode picker with the four
* official modes. Kept in sync with `AGENT_PRESETS` in presentation/cards. */
const SHIPPED_PRESETS = [
	{
		id: "standard",
		label: "标准模式",
		desc: "全能：文件/Shell/检索/Skills/目标/子代理/工作流",
		trust: "system"
	},
	{
		id: "ptc",
		label: "PTC 模式",
		desc: "标准能力 + Code Mode（多步操作一次执行，更快）",
		trust: "system"
	},
	{
		id: "minimal",
		label: "极简模式",
		desc: "仅 bash + 文件编辑，轻量省 token",
		trust: "system"
	},
	{
		id: "cordis",
		label: "创造模式",
		desc: "标准能力 + preset 创作工具（面向开发者）",
		trust: "system"
	}
];
function createMemoryDshBackend(opts = {}) {
	const agents = /* @__PURE__ */ new Map();
	const keyBySession = /* @__PURE__ */ new Map();
	let counter = 0;
	const makeAgent = (key, sessionId) => {
		const sid = sessionId ?? `session-${++counter}`;
		const agentId = sessionId ?? `agent-${counter}`;
		const listeners = /* @__PURE__ */ new Set();
		let busy = false;
		let disposed = false;
		const emit = (e) => {
			for (const fn of listeners) fn(e);
		};
		return {
			agentId,
			sessionId: sid,
			async followup(text, attachments) {
				if (disposed) throw new Error("agent disposed");
				busy = true;
				const reply = opts.autoReply?.(key, text);
				const stream = async () => {
					const content = reply ?? `echo: ${text}`;
					const mid = Math.floor(content.length / 2);
					emit({
						type: "assistant/chunk",
						text: content.slice(0, mid)
					});
					if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
					emit({
						type: "assistant/chunk",
						text: content.slice(mid)
					});
					emit({
						type: "assistant/message",
						text: content
					});
					emit({
						type: "turn/end",
						reason: "complete",
						finalText: content
					});
					busy = false;
				};
				stream();
			},
			async cancel() {
				busy = false;
			},
			onEvent(fn) {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
			isIdle: () => !busy,
			async dispose() {
				disposed = true;
				listeners.clear();
				agents.delete(key);
				keyBySession.delete(sid);
			}
		};
	};
	return {
		agents,
		async ensureAgent(key) {
			let a = agents.get(key);
			if (!a) {
				a = makeAgent(key);
				agents.set(key, a);
				keyBySession.set(a.sessionId, key);
			}
			return a;
		},
		get: (key) => agents.get(key),
		async resumeAgent(key, sessionId) {
			const prev = agents.get(key);
			if (prev) {
				agents.delete(key);
				keyBySession.delete(prev.sessionId);
			}
			const a = makeAgent(key, sessionId);
			agents.set(key, a);
			keyBySession.set(a.sessionId, key);
			return a;
		},
		keyForSessionId: (sessionId) => keyBySession.get(sessionId),
		listPresets: async () => [...SHIPPED_PRESETS],
		disposeIdle(ttlMs) {
			let n = 0;
			for (const [key, a] of agents) if (a.isIdle()) {
				a.dispose();
				agents.delete(key);
				keyBySession.delete(a.sessionId);
				n++;
			}
			return n;
		},
		size: () => agents.size,
		rotate() {},
		clearImageUnsupported() {},
		async dispose(key) {
			const a = agents.get(key);
			if (a) await a.dispose();
			agents.delete(key);
		},
		async disposeAll() {
			for (const a of agents.values()) await a.dispose();
			agents.clear();
			keyBySession.clear();
		}
	};
}
//#endregion
//#region src/application/command-router.ts
const BRIDGE_COMMANDS = /* @__PURE__ */ new Set([
	"status",
	"workspace",
	"stop",
	"support",
	"doctor",
	"sessions",
	"lark-config",
	"help",
	"feishu-config",
	"model",
	"mode",
	"permission",
	"new",
	"resume",
	"goal",
	"menu"
]);
function stripLeadingMentions(text) {
	let cur = text.trim();
	while (true) {
		const next = cur.replace(/^(?:<at[^>]*>.*?<\/at>|@\S+)\s*/i, "").trim();
		if (next === cur) break;
		cur = next;
	}
	return cur;
}
function createCommandRouter(deps) {
	return {
		isCommand(text) {
			const cleaned = stripLeadingMentions(text);
			return /^\//.test(cleaned);
		},
		async route(msg) {
			const rawText = (msg.text ?? msg.content ?? "").trim();
			if (rawText === "") return "skipped";
			const text = stripLeadingMentions(rawText);
			if (text === "") return "skipped";
			if (!this.isCommand(rawText)) return "agent";
			const tokens = text.split(/\s+/);
			const cmdName = (tokens[0] ?? "").replace(/^\/+/, "").toLowerCase();
			const rawInput = tokens.slice(1).join(" ");
			if (BRIDGE_COMMANDS.has(cmdName) || cmdName === "lark") {
				const handled = await deps.bridgeHandler(cmdName, rawInput, msg);
				if (handled) {
					const cfg = deps.ctx.cfg();
					if (cfg.reactions.enabled) deps.ctx.sender?.addReaction(msg.messageId, cfg.reactions.done || "DONE").catch(() => void 0);
				}
				return handled ? "bridge" : "agent";
			}
			const key2 = deps.ctx.conversationKeyFor(msg);
			let agent = deps.ctx.backend?.get(key2);
			if (!agent) try {
				agent = await deps.ctx.backend?.ensureAgent?.(key2);
			} catch {}
			const agentId = agent?.agentId ?? "";
			if (agentId && deps.commands.has(cmdName, agentId)) try {
				const result = await deps.commands.run(cmdName, rawInput, agentId);
				const key = deps.ctx.conversationKeyFor(msg);
				if (result.kind === "success" && result.text) await deps.ctx.outbox?.enqueue({
					dedupeKey: `${key}:cmd:${cmdName}:${msg.messageId}`,
					laneKey: key,
					route: {
						sessionKey: key,
						chatId: msg.chatId,
						chatType: msg.chatType
					},
					kind: "command-reply",
					payload: {
						kind: "text",
						text: result.text
					}
				});
				else if (result.kind === "error" && result.text) await deps.ctx.outbox?.enqueue({
					dedupeKey: `${key}:cmd:${cmdName}:${msg.messageId}`,
					laneKey: key,
					route: {
						sessionKey: key,
						chatId: msg.chatId,
						chatType: msg.chatType
					},
					kind: "command-reply",
					payload: {
						kind: "text",
						text: `⚠️ ${result.text}`
					}
				});
				return "dsh";
			} catch {
				return "agent";
			}
			return "agent";
		}
	};
}
//#endregion
//#region src/sessions/conversation-manager.ts
function createConversationManager(deps) {
	const queues = /* @__PURE__ */ new Map();
	const hooks = /* @__PURE__ */ new Map();
	const hooksAgent = /* @__PURE__ */ new Map();
	const keyFor = (msg) => msg.chatType === "p2p" ? `dm:${msg.chatId}` : `group:${msg.chatId}`;
	const enqueueSerial = (key, task) => {
		const next = (queues.get(key) ?? Promise.resolve()).then(task, task);
		queues.set(key, next.catch(() => void 0));
		return next;
	};
	const ensureUnderCap = async () => {
		if (deps.backend.size() < deps.maxSessions) return;
		deps.backend.disposeIdle(0);
		if (deps.backend.size() >= deps.maxSessions) {
			await new Promise((r) => setTimeout(r, 250));
			deps.backend.disposeIdle(0);
		}
	};
	return {
		keyFor,
		async handleMessage(msg, attachments) {
			const key = keyFor(msg);
			await ensureUnderCap();
			const agent = await deps.backend.ensureAgent(key);
			const prevAgentId = hooksAgent.get(key);
			if (!hooks.has(key) || prevAgentId !== agent.agentId) {
				hooks.get(key)?.();
				const detach = agent.onEvent((e) => deps.onEvent?.(key, e));
				hooks.set(key, detach);
				hooksAgent.set(key, agent.agentId);
			}
			const rawText = msg.text ?? msg.content ?? "";
			const text = stripLeadingMentions(rawText) || rawText;
			await enqueueSerial(key, async () => {
				try {
					await agent.followup(text, attachments);
				} catch (err) {
					deps.logger?.warn(`followup failed for ${key}: ${String(err)}`);
				}
			});
		},
		async stop(key) {
			const agent = deps.backend.get(key);
			if (agent) await agent.cancel();
		},
		async dispose(key) {
			hooks.get(key)?.();
			hooks.delete(key);
			hooksAgent.delete(key);
			queues.delete(key);
			await deps.backend.dispose(key);
		},
		async rotate(key) {
			hooks.get(key)?.();
			hooks.delete(key);
			hooksAgent.delete(key);
			queues.delete(key);
			deps.backend.rotate(key);
		},
		sweep() {
			return deps.backend.disposeIdle(deps.idleTtlMs);
		},
		size: () => deps.backend.size(),
		keys: () => [...queues.keys()],
		async disposeAll() {
			for (const detach of hooks.values()) detach();
			hooks.clear();
			hooksAgent.clear();
			await deps.backend.disposeAll();
			queues.clear();
		}
	};
}
//#endregion
//#region src/sessions/conversation-config.ts
function createConversationConfigStore(file) {
	let data = {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (parsed && typeof parsed === "object") data = parsed;
	} catch {}
	const persist = () => {
		try {
			writeFileSync(file, JSON.stringify(data, null, 2), { mode: 384 });
		} catch {}
	};
	const clean = (o) => {
		const out = {};
		if (o.workspaceRoot) out.workspaceRoot = o.workspaceRoot;
		if (o.provider) out.provider = o.provider;
		if (o.model) out.model = o.model;
		if (o.preset) out.preset = o.preset;
		if (o.activeSessionId) out.activeSessionId = o.activeSessionId;
		return out;
	};
	return {
		get(key) {
			return data[key] ? { ...data[key] } : {};
		},
		set(key, partial) {
			const merged = clean({
				...data[key] ?? {},
				...partial
			});
			if (Object.keys(merged).length === 0) delete data[key];
			else data[key] = merged;
			persist();
		},
		clear(key) {
			delete data[key];
			persist();
		},
		keys() {
			return Object.keys(data);
		}
	};
}
//#endregion
//#region src/sessions/workspace-sessions.ts
/** Newest session-log file in one session directory, or undefined.
*
* DSH renamed the log to session.v4.jsonl.zstd; matching only the old
* "session.jsonl.zstd" name made every scan-sourced listing empty (the GUI
* showed sessions but /resume answered "该工作区暂无历史会话日志"). */
function sessionLogPath(sessionDir) {
	let names;
	try {
		names = readdirSync(sessionDir);
	} catch {
		return;
	}
	let best;
	let bestMtime = -1;
	for (const entry of names) {
		if (!/^session(\.[A-Za-z0-9]+)?\.jsonl(\.zstd)?$/.test(entry)) continue;
		let mtime;
		try {
			mtime = statSync(join(sessionDir, entry)).mtimeMs;
		} catch {
			continue;
		}
		if (mtime > bestMtime) {
			bestMtime = mtime;
			best = join(sessionDir, entry);
		}
	}
	return best;
}
/** Read the session's own title straight out of its (zstd-framed) log, so a
*  filesystem-scan listing can show real titles instead of "会话". */
function titleFromSessionLog(logPath) {
	try {
		const raw = readFileSync(logPath);
		const magic = Buffer.from([
			40,
			181,
			47,
			253
		]);
		const offsets = [];
		let at = raw.indexOf(magic);
		if (at < 0) return void 0;
		while (at >= 0) {
			offsets.push(at);
			at = raw.indexOf(magic, at + 4);
		}
		let text = "";
		for (let i = 0; i < offsets.length; i += 1) {
			const start = offsets[i] ?? 0;
			const end = i + 1 < offsets.length ? offsets[i + 1] ?? raw.length : raw.length;
			try {
				text += zstdDecompressSync(raw.subarray(start, end)).toString("utf8");
			} catch {}
		}
		let title;
		for (const line of text.split("\n")) {
			if (!line.includes("session/title")) continue;
			try {
				const record = JSON.parse(line);
				if (record.type !== "session/title") continue;
				const value = record.data?.title?.trim();
				if (value) title = value.slice(0, 36);
			} catch {}
		}
		return title;
	} catch {
		return;
	}
}
/**
* Extract a human-readable title from a session's events:
* 1. session/title event (highest precedence)
* 2. first user message text (deterministic fallback)
*/
function extractTitleFromEvents(events) {
	if (!Array.isArray(events) || events.length === 0) return void 0;
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (ev?.type === "session/title" && ev.data?.title) {
			const t = ev.data.title.trim();
			if (t) return t.slice(0, 36);
		}
	}
	for (let i = 0; i < events.length; i++) {
		const ev = events[i];
		if (ev?.type === "user/message") {
			const text = (ev.data?.content ?? []).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text?.trim()).filter(Boolean).join(" ");
			if (text) {
				const oneLine = (text.replace(/^\/[a-zA-Z0-9_-]+\s*/, "").trim() || text).replace(/[\r\n\t]+/g, " ").trim();
				if (oneLine) return oneLine.slice(0, 36);
			}
		}
	}
}
/**
* Port of dsh-session-persistence-jsonl's projectKey: `/`, `\` and `:` become
* `-` (consecutive runs collapse), safe `[A-Za-z0-9._-]` passes, everything
* else escapes as `~XXXX` (uppercase hex code unit); wrapped `--…--` with the
* readable part bounded to 251 chars and `root` when empty.
*/
function projectKeyOf(cwd) {
	if (cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const ch = cwd[i];
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")}`;
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}
/** Decode an encoded session dir name (`~003A` → `:` etc.). */
function decodeSessionDirName(name) {
	return name.replace(/~([0-9A-Fa-f]{4})/g, (_m, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}
/** List historical sessions of one workspace, newest first, capped. */
async function listWorkspaceSessions(deps) {
	const limit = deps.limit ?? 10;
	const exclude = new Set(deps.exclude ?? []);
	let rows = [];
	if (deps.persistence?.list) try {
		rows = (await deps.persistence.list()).filter((h) => h.cwd === deps.cwd && h.origin !== "subagent" && !exclude.has(h.id)).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map((h) => {
			const title = deps.titleFor?.(h.id) ?? h.title;
			return {
				id: h.id,
				createdAt: h.createdAt,
				...h.agentPreset ? { preset: h.agentPreset } : {},
				...title ? { title } : {},
				source: "service"
			};
		});
	} catch {}
	if (rows.length === 0) {
		const dir = join(deps.sessionsRoot, projectKeyOf(deps.cwd));
		if (existsSync(dir)) {
			for (const name of readdirSync(dir)) {
				const log = sessionLogPath(join(dir, name));
				if (log === void 0) continue;
				let mtime;
				try {
					mtime = statSync(log).mtimeMs;
				} catch {
					continue;
				}
				const id = decodeSessionDirName(name);
				if (exclude.has(id)) continue;
				const title = deps.titleFor?.(id) ?? titleFromSessionLog(log);
				rows.push({
					id,
					createdAt: mtime,
					...title ? { title } : {},
					source: "scan"
				});
			}
			rows.sort((a, b) => b.createdAt - a.createdAt);
			rows = rows.slice(0, limit);
		}
	}
	if (deps.persistence && rows.length > 0) await Promise.allSettled(rows.map(async (row) => {
		if (row.title) return;
		if (deps.titleFor) {
			const t = deps.titleFor(row.id);
			if (t) {
				row.title = t;
				return;
			}
		}
		try {
			let events;
			if (deps.persistence?.inspect) events = (await deps.persistence.inspect(row.id))?.events;
			else if (deps.persistence?.load) events = (await deps.persistence.load(row.id))?.events;
			else if (deps.persistence?.readFrom) events = (await deps.persistence.readFrom(row.id, 0))?.events;
			if (events) {
				const extracted = extractTitleFromEvents(events);
				if (extracted) row.title = extracted;
			}
		} catch {}
	}));
	return rows;
}
//#endregion
//#region src/sessions/turn-supervisor.ts
function createTurnSupervisor(deps) {
	const now = deps.now ?? Date.now;
	const armed = /* @__PURE__ */ new Map();
	let timer;
	return {
		arm(key) {
			armed.set(key, now());
		},
		disarm(key) {
			armed.delete(key);
		},
		start() {
			if (timer) return;
			timer = setInterval(() => {
				const cutoff = now() - deps.timeoutMs;
				for (const [key, armedAt] of armed) if (armedAt < cutoff) {
					armed.delete(key);
					deps.logger?.warn(`turn timeout for ${key}; disposing agent to unlock`);
					const agent = deps.backend.get(key);
					if (agent) agent.dispose().then(() => {
						deps.logger?.info(`disposed agent for ${key} after turn timeout`);
					});
				}
			}, 1e3);
			timer.unref?.();
		},
		stop() {
			if (timer) clearInterval(timer);
			timer = void 0;
			armed.clear();
		}
	};
}
//#endregion
//#region src/outbound/outbox.ts
/** Unref'd sleep so an idle pump never keeps the process alive. */
function sleep$2(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms).unref?.();
	});
}
function createOutbox(deps) {
	const now = deps.now ?? Date.now;
	const dir = deps.dir;
	mkdirSync(join(dir, "blobs"), { recursive: true });
	/** id -> envelope (all statuses, bounded by prune). */
	const envelopes = /* @__PURE__ */ new Map();
	/** laneKey -> array of envelope ids in FIFO order (pending+failed+sending). */
	const lanes = /* @__PURE__ */ new Map();
	/** dedupeKey -> done/fatal envelope id (idempotency, 30d). */
	const sentKeys = /* @__PURE__ */ new Map();
	const isFatal = deps.isFatalError ?? ((e) => /400|403|invalid|not found/i.test(e));
	let draining = false;
	let stopped = false;
	let pruneTimer;
	const activeDeliveries = /* @__PURE__ */ new Set();
	const laneQueues = /* @__PURE__ */ new Map();
	/** Wake signal for the idle pump (set while it waits). */
	let idleWake;
	const emitStats = () => {
		try {
			let pending = 0;
			let failed = 0;
			for (const env of envelopes.values()) {
				if (env.status === "pending" || env.status === "failed") pending++;
				if (env.status === "failed") failed++;
			}
			deps.onStatsChange?.({
				pending,
				failed
			});
		} catch {}
	};
	const segmentPath = (n) => join(dir, `seg-${n}.jsonl`);
	function loadSegment(file) {
		try {
			const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
			for (const line of lines) try {
				const env = JSON.parse(line);
				envelopes.set(env.id, env);
				if (env.dedupeKey) sentKeys.set(env.dedupeKey, env.id);
				if (env.status === "pending" || env.status === "failed" || env.status === "sending") {
					const lane = lanes.get(env.laneKey) ?? [];
					lane.push(env.id);
					lanes.set(env.laneKey, lane);
				}
			} catch {}
		} catch {}
	}
	function rebuildFromDisk() {
		envelopes.clear();
		lanes.clear();
		sentKeys.clear();
		let segs = [];
		try {
			segs = readdirSync(dir).filter((f) => /^seg-\d+\.jsonl$/.test(f)).sort((a, b) => {
				return Number(basename(a).match(/\d+/)?.[0] ?? 0) - Number(basename(b).match(/\d+/)?.[0] ?? 0);
			});
		} catch {
			segs = [];
		}
		for (const seg of segs) loadSegment(join(dir, seg));
		let changed = false;
		for (const env of envelopes.values()) if (env.status === "sending") {
			env.status = "pending";
			env.updatedAt = now();
			changed = true;
		}
		if (changed) persistAll();
	}
	function persistAll() {
		try {
			const segFile = segmentPath(Math.floor(now() / 1e3));
			const lines = [...envelopes.values()].map((e) => JSON.stringify(e));
			const tmp = `${segFile}.tmp`;
			writeFileSync(tmp, lines.join("\n") + "\n", { mode: 384 });
			renameSync(tmp, segFile);
			const cutoff = now() - deps.cfg.retainDays * 864e5;
			for (const f of readdirSync(dir).filter((x) => /^seg-\d+\.jsonl$/.test(x))) if (Number(basename(f).match(/\d+/)?.[0] ?? 0) * 1e3 < cutoff) try {
				rmSync(join(dir, f));
			} catch {}
		} catch {}
	}
	function spill(payload) {
		if (JSON.stringify(payload).length <= deps.cfg.blobThreshold) return { payload };
		const ref = `${randomUUID()}.json`;
		try {
			writeFileSync(join(dir, "blobs", ref), JSON.stringify(payload), { mode: 384 });
			return { blobRef: ref };
		} catch {
			return { payload };
		}
	}
	function resolvePayload(env) {
		if (env.payload) return env.payload;
		if (env.blobRef) try {
			return JSON.parse(readFileSync(join(dir, "blobs", env.blobRef), "utf8"));
		} catch {
			return;
		}
	}
	function enqueue(input) {
		if (stopped) return void 0;
		if (!input.skipDedupe && sentKeys.has(input.dedupeKey)) return void 0;
		if (envelopes.size >= deps.cfg.pendingCap) return;
		const id = randomUUID();
		const spilled = spill(input.payload);
		const env = {
			id,
			dedupeKey: input.dedupeKey,
			laneKey: input.laneKey,
			route: input.route,
			kind: input.kind,
			status: "pending",
			attempts: 0,
			nextRetryAt: now(),
			createdAt: now(),
			updatedAt: now(),
			...spilled
		};
		envelopes.set(id, env);
		sentKeys.set(input.dedupeKey, id);
		const lane = lanes.get(input.laneKey) ?? [];
		lane.push(id);
		lanes.set(input.laneKey, lane);
		persistAll();
		idleWake?.();
		emitStats();
		return id;
	}
	async function deliverOne(id) {
		const env = envelopes.get(id);
		if (!env || env.status === "done" || env.status === "fatal") return;
		const payload = resolvePayload(env);
		if (!payload) {
			env.status = "fatal";
			env.error = "payload unresolved (blob missing)";
			env.updatedAt = now();
			return;
		}
		env.status = "sending";
		env.updatedAt = now();
		const resolved = {
			...env,
			payload
		};
		const result = await deps.sender.deliver(resolved, payload);
		if (result.ok) {
			env.status = "done";
			env.updatedAt = now();
			if (env.dedupeKey) sentKeys.set(env.dedupeKey, env.id);
		} else {
			env.attempts += 1;
			env.error = result.error;
			env.updatedAt = now();
			if (!result.retryable || isFatal(result.error)) env.status = "fatal";
			else if (env.attempts >= deps.cfg.maxAttempts) env.status = "fatal";
			else {
				env.status = "failed";
				const backoff = Math.min(deps.cfg.backoffMaxMs, 1e3 * 2 ** Math.min(env.attempts - 1, 10));
				env.nextRetryAt = now() + backoff;
			}
		}
		persistAll();
		emitStats();
	}
	/** Drain one lane FIFO. Failed messages fall out; retry sweep picks them up. */
	async function drainLane(laneKey) {
		const ids = lanes.get(laneKey);
		if (!ids || ids.length === 0) return;
		const head = ids.shift();
		lanes.set(laneKey, ids);
		if (head !== void 0) await deliverOne(head);
	}
	/** Retry sweep: re-drain 'failed' envelopes whose nextRetryAt has passed. */
	function retrySweep() {
		let woke = false;
		const due = [];
		for (const env of envelopes.values()) if (env.status === "failed" && env.nextRetryAt <= now()) due.push(env.id);
		for (const id of due) {
			const env = envelopes.get(id);
			if (env) {
				const lane = lanes.get(env.laneKey) ?? [];
				if (!lane.includes(id)) {
					lane.push(id);
					lanes.set(env.laneKey, lane);
					woke = true;
				}
			}
		}
		if (woke) idleWake?.();
	}
	async function pump() {
		if (draining) return;
		draining = true;
		try {
			while (!stopped) {
				retrySweep();
				let worked = false;
				for (const laneKey of lanes.keys()) {
					const ids = lanes.get(laneKey);
					if (ids && ids.length > 0) {
						worked = true;
						const next = (laneQueues.get(laneKey) ?? Promise.resolve()).then(() => drainLane(laneKey));
						laneQueues.set(laneKey, next.catch(() => void 0));
						activeDeliveries.add(next);
						next.finally(() => activeDeliveries.delete(next));
					}
				}
				if (!worked) {
					await new Promise((resolve) => {
						idleWake = resolve;
						setTimeout(() => {
							idleWake = void 0;
							resolve();
						}, 200).unref?.();
					});
					idleWake = void 0;
				} else await sleep$2(25);
			}
		} finally {
			draining = false;
		}
	}
	function doPrune() {
		const cutoff = now() - deps.cfg.retainDays * 864e5;
		let changed = false;
		for (const [id, env] of envelopes) if ((env.status === "done" || env.status === "fatal") && env.updatedAt < cutoff) {
			envelopes.delete(id);
			if (env.blobRef) try {
				rmSync(join(dir, "blobs", env.blobRef));
			} catch {}
			changed = true;
		}
		if (changed) persistAll();
		emitStats();
	}
	return {
		enqueue,
		start() {
			stopped = false;
			const cadence = deps.pruneIntervalMs ?? Math.max(36e5, Math.min(864e5, deps.cfg.retainDays * 36e5));
			doPrune();
			pruneTimer = setInterval(() => doPrune(), cadence);
			if (pruneTimer.unref) pruneTimer.unref();
			pump();
		},
		async stop() {
			stopped = true;
			if (pruneTimer) clearInterval(pruneTimer);
			pruneTimer = void 0;
			await Promise.allSettled([...activeDeliveries]);
		},
		pendingCount() {
			let n = 0;
			for (const env of envelopes.values()) if (env.status === "pending" || env.status === "failed") n++;
			return n;
		},
		failedCount() {
			let n = 0;
			for (const env of envelopes.values()) if (env.status === "failed") n++;
			return n;
		},
		prune: doPrune,
		rebuildFromDisk,
		lanes: () => [...lanes.keys()]
	};
}
//#endregion
//#region src/outbound/event-forwarder.ts
function createEventForwarder(deps) {
	const state = /* @__PURE__ */ new Map();
	const emptyState = () => ({
		acc: "",
		lastFlushAt: Date.now(),
		hasOutput: false,
		doneIssued: false
	});
	const routeRefFor = (route) => ({
		sessionKey: route.sessionKey,
		chatId: route.chatId,
		chatType: route.chatType,
		threadMessageId: route.threadMessageId
	});
	async function onSessionEvent(sessionKey, event) {
		const route = deps.routeFor(sessionKey);
		if (!route) return;
		const st = state.get(sessionKey) ?? emptyState();
		state.set(sessionKey, st);
		switch (event.type) {
			case "turn/start":
				st.hasOutput = false;
				st.doneIssued = false;
				st.acc = "";
				st.stream = void 0;
				break;
			case "assistant/chunk": {
				const { streamingEnabled } = deps.cfg();
				if (!streamingEnabled) return;
				st.acc += event.text;
				if (!st.stream || st.stream.disposed) {
					const stream = deps.streamFor(sessionKey)?.ensureStream();
					if (stream && !stream.disposed) st.stream = stream;
				}
				if (st.stream && !st.stream.disposed) await st.stream.patch(event.text);
				break;
			}
			case "assistant/message": {
				const text = st.acc.length > event.text.length ? st.acc : event.text;
				st.acc = "";
				if (!text || text.trim() === "" || text === "No response.") return;
				st.hasOutput = true;
				if (st.stream && !st.stream.disposed) try {
					if (!await st.stream.finalize(text)) throw new Error("CardKit finalize returned empty cardId");
					st.stream = void 0;
					deps.onDelivered?.(sessionKey);
					return;
				} catch {
					st.stream = void 0;
				}
				await deps.outbox.enqueue({
					dedupeKey: `${sessionKey}:assistant:${text.length}:${Date.now()}`,
					laneKey: sessionKey,
					route: routeRefFor(route),
					kind: "assistant-output",
					payload: {
						kind: "text",
						text
					}
				});
				deps.onDelivered?.(sessionKey);
				break;
			}
			case "turn/end": {
				st.acc = "";
				if (st.stream) {
					try {
						await st.stream.finalize("");
					} catch {}
					st.stream = void 0;
				}
				const rescue = (event.finalText ?? "").trim() !== "" ? event.finalText : "";
				if (!st.hasOutput && rescue && rescue !== "No response.") try {
					await deps.outbox.enqueue({
						dedupeKey: `${sessionKey}:rescue:${rescue.length}:${Date.now()}`,
						laneKey: sessionKey,
						route: routeRefFor(route),
						kind: "assistant-output",
						payload: {
							kind: "text",
							text: rescue
						}
					});
					st.hasOutput = true;
					deps.onDelivered?.(sessionKey);
				} catch {}
				const target = deps.streamFor(sessionKey);
				if (target && st.hasOutput && !st.doneIssued) {
					st.doneIssued = true;
					await target.markDone();
				}
				break;
			}
		}
	}
	async function finalizeSession(sessionKey) {
		const st = state.get(sessionKey);
		if (!st) return;
		if (st.acc.length > 0 && st.hasOutput === false) {
			const route = deps.routeFor(sessionKey);
			if (route) await deps.outbox.enqueue({
				dedupeKey: `${sessionKey}:finalize:${Date.now()}`,
				laneKey: sessionKey,
				route: routeRefFor(route),
				kind: "assistant-output",
				payload: {
					kind: "text",
					text: st.acc
				}
			});
		}
		if (st.stream) {
			try {
				await st.stream.finalize("");
			} catch {}
			st.stream = void 0;
		}
		state.delete(sessionKey);
	}
	return {
		onSessionEvent,
		finalizeSession
	};
}
/** element_id of the single markdown element (1–20 chars per API rules). */
const STREAM_ELEMENT_ID = "stream_md";
/** Safety valve: stop patching beyond this many API calls; finalize covers it. */
const MAX_STREAM_PATCHES = 400;
function createCardKitStream(opts) {
	let cardId;
	let seq = 0;
	let lastPatchAt = 0;
	let patchCount = 0;
	let disposed = false;
	let inFlight = false;
	let backoffUntil = 0;
	let acc = "";
	const now = opts.now ?? Date.now;
	const minInterval = opts.minPushIntervalMs ?? opts.printFrequencyMs ?? 800;
	const nextSeq = () => {
		seq += 1;
		return seq;
	};
	const cardJson = (text, streaming) => JSON.stringify({
		schema: "2.0",
		config: {
			update_multi: true,
			...streaming ? {
				streaming_mode: true,
				streaming_config: {
					print_frequency_ms: { default: opts.printFrequencyMs ?? 120 },
					print_step: { default: opts.printStep ?? 3 },
					print_strategy: "fast"
				}
			} : { streaming_mode: false }
		},
		body: { elements: [{
			tag: "markdown",
			content: text || " ",
			element_id: STREAM_ELEMENT_ID
		}] }
	});
	const createPayload = (text, streaming) => ({
		type: "card_json",
		data: cardJson(text, streaming)
	});
	const extractCardId = (res) => res?.card_id ?? res?.data?.card_id;
	return {
		get cardId() {
			return cardId ?? "";
		},
		get disposed() {
			return disposed;
		},
		async patch(text) {
			if (disposed) return;
			acc += text;
			if (cardId === void 0) {
				if (inFlight) return;
				inFlight = true;
				try {
					const created = await opts.api.createCard(createPayload(acc || " ", true));
					cardId = extractCardId(created);
					if (!cardId) throw new Error("CardKit create returned no card_id");
					await opts.api.deliverCard(cardId);
					patchCount++;
					lastPatchAt = now();
				} catch (err) {
					opts.onError?.(err);
					disposed = true;
					return;
				} finally {
					inFlight = false;
				}
				return;
			}
			if (inFlight) return;
			if (patchCount >= MAX_STREAM_PATCHES) return;
			const currentTime = now();
			if (currentTime < backoffUntil) return;
			if (currentTime - lastPatchAt < minInterval) return;
			inFlight = true;
			lastPatchAt = currentTime;
			try {
				await opts.api.streamText(cardId, STREAM_ELEMENT_ID, {
					content: acc,
					sequence: nextSeq(),
					uuid: randomUUID()
				});
				patchCount++;
			} catch (err) {
				const errStr = String(err);
				if (errStr.includes("230020") || errStr.includes("rate limit") || errStr.includes("429")) backoffUntil = now() + 1500;
				opts.onError?.(err);
			} finally {
				inFlight = false;
			}
		},
		async finalize(fullText) {
			if (disposed) {
				if (!cardId) throw new Error("CardKit stream handle was disposed (creation failed)");
				return cardId;
			}
			let waitCount = 0;
			while (inFlight && waitCount < 20) {
				await new Promise((r) => setTimeout(r, 50));
				waitCount++;
			}
			const text = fullText || acc;
			if (!cardId) try {
				const created = await opts.api.createCard(createPayload(text || " ", false));
				cardId = extractCardId(created);
				if (!cardId) throw new Error("CardKit create returned no card_id");
				await opts.api.deliverCard(cardId);
				disposed = true;
				return cardId;
			} catch (err) {
				opts.onError?.(err);
				disposed = true;
				throw err;
			}
			const id = cardId;
			try {
				await opts.api.patchSettings(id, {
					settings: JSON.stringify({ config: { streaming_mode: false } }),
					sequence: nextSeq(),
					uuid: randomUUID()
				});
			} catch (err) {
				opts.onError?.(err);
			}
			try {
				await opts.api.updateCard(id, {
					card: {
						type: "card_json",
						data: cardJson(text || " ", false)
					},
					sequence: nextSeq(),
					uuid: randomUUID()
				});
			} catch (err) {
				const errStr = String(err);
				if (errStr.includes("230020") || errStr.includes("rate limit") || errStr.includes("429")) {
					await new Promise((r) => setTimeout(r, 600));
					try {
						await opts.api.updateCard(id, {
							card: {
								type: "card_json",
								data: cardJson(text || " ", false)
							},
							sequence: nextSeq(),
							uuid: randomUUID()
						});
						disposed = true;
						return id;
					} catch (retryErr) {
						opts.onError?.(retryErr);
						disposed = true;
						throw retryErr;
					}
				}
				opts.onError?.(err);
				disposed = true;
				throw err;
			}
			disposed = true;
			return id;
		}
	};
}
//#endregion
//#region src/outbound/outbound-router.ts
function createRouteStore(file, now = Date.now) {
	let routes = /* @__PURE__ */ new Map();
	try {
		const raw = readFileSync(file, "utf8");
		const parsed = JSON.parse(raw);
		routes = new Map(parsed.map((r) => [r.sessionKey, r]));
	} catch {
		routes = /* @__PURE__ */ new Map();
	}
	const persist = () => {
		try {
			writeFileSync(file, JSON.stringify([...routes.values()], null, 2), { mode: 384 });
		} catch {}
	};
	return {
		get(key) {
			return routes.get(key);
		},
		all() {
			return [...routes.values()];
		},
		upsert(route) {
			routes.set(route.sessionKey, route);
			persist();
		},
		touch(key, lastMessageId) {
			const r = routes.get(key);
			if (!r) return;
			r.updatedAt = now();
			if (lastMessageId !== void 0) r.lastMessageId = lastMessageId;
			persist();
		},
		remove(key) {
			routes.delete(key);
			persist();
		},
		prune(maxAgeMs) {
			const cutoff = now() - maxAgeMs;
			let changed = false;
			for (const [k, r] of routes) if (r.updatedAt < cutoff) {
				routes.delete(k);
				changed = true;
			}
			if (changed) persist();
		},
		persist
	};
}
//#endregion
//#region src/inbound/transport.ts
function msgTypeOf(type) {
	switch (type) {
		case "text": return "text";
		case "post": return "post";
		case "image": return "image";
		case "file": return "file";
		case "audio": return "audio";
		case "interactive": return "interactive";
		default: return "unknown";
	}
}
function pickText(contentRaw, msgType) {
	if (!contentRaw) return void 0;
	try {
		const parsed = JSON.parse(contentRaw);
		if (typeof parsed.text === "string") return parsed.text;
		if (msgType === "post") {
			const content = parsed.content;
			if (content?.paragraphs) return content.paragraphs.map((p) => (p.elements ?? []).map((e) => e.text_run?.content ?? "").join("")).join("\n");
			if (Array.isArray(parsed.content)) {
				const text = parsed.content.map((line) => (Array.isArray(line) ? line : [line]).map((e) => {
					const el = e;
					return el?.tag === "text" && typeof el.text === "string" ? el.text : "";
				}).join("")).filter((l) => l.trim().length > 0).join("\n");
				if (text.trim()) return text;
			}
		}
		if (typeof parsed.content === "string") return parsed.content;
	} catch {
		return contentRaw;
	}
}
function chatModeFor(opts) {
	if (opts.chatType === "p2p") return "p2p";
	if (opts.groupPolicy === "open") return "group_at";
	if (opts.groupPolicy === "mention") return opts.mentionedBot ? "group_at" : "group_all";
	return "group_at";
}
/**
* Normalize a raw Feishu event (any shape) into a FeishuInboundMessage.
* Returns undefined when the event is not a message we should process
* (e.g. non-message events, missing ids).
*/
function normalizeInbound(raw, opts = {}) {
	const msg = raw.message ?? raw;
	const messageId = msg.message_id ?? raw.message_id;
	const chatId = msg.chat_id ?? raw.chat_id;
	if (!messageId || !chatId) return void 0;
	const chatType = (msg.chat_type ?? raw.chat_type ?? "p2p") === "group" ? "group" : "p2p";
	const msgType = msgTypeOf(msg.message_type ?? raw.message_type);
	const senderOpenId = raw.sender?.sender_id?.open_id ?? raw.operator?.operator_id?.open_id ?? "unknown";
	const mentions = (msg.mentions ?? []).map((m) => m.id?.open_id ?? m.id?.user_id ?? m.name ?? "").filter(Boolean);
	return {
		messageId,
		chatId,
		chatType,
		chatMode: chatModeFor({
			chatType,
			mentionedBot: opts.mentionedBot ?? (opts.botOpenId !== void 0 ? mentions.includes(opts.botOpenId) : mentions.length > 0),
			groupPolicy: opts.groupPolicy ?? (chatType === "group" ? "mention" : "open")
		}),
		senderOpenId,
		msgType,
		content: msg.content ?? raw.content ?? "",
		text: msgType === "image" ? "[图片]" : msgType === "file" ? "[文件]" : msgType === "audio" ? "[语音]" : pickText(msg.content ?? raw.content, msgType),
		rootId: msg.root_id ?? raw.root_id,
		parentId: msg.parent_id ?? raw.parent_id,
		threadId: msg.thread_id ?? raw.thread_id,
		mentions,
		timestamp: Number(msg.create_time ?? raw.create_time ?? Date.now())
	};
}
/** Event name constants. */
const EVENT_MESSAGE = "im.message.receive_v1";
const EVENT_CARD_ACTION = "card.action.trigger";
function createTransport(deps) {
	let started = false;
	let wsReadyFlag = false;
	let botOpenId;
	const normalize = deps.normalize ?? normalizeInbound;
	const client = () => deps.getClient();
	async function handleEvent(event, data) {
		deps.onEvent?.(event, data);
		if (event !== "im.message.receive_v1") return;
		const msg = normalize(data, { botOpenId });
		if (!msg) return;
		try {
			await deps.onMessage(msg);
		} catch (err) {
			deps.logger?.error(`onMessage failed: ${String(err)}`);
		}
	}
	return {
		async start() {
			if (started) return;
			started = true;
			const c = client();
			if (c.on) {
				c.on(EVENT_MESSAGE, (data) => void handleEvent(EVENT_MESSAGE, data));
				c.on(EVENT_CARD_ACTION, (data) => void handleEvent(EVENT_CARD_ACTION, data));
			}
			try {
				botOpenId = (await c.getBotInfo?.())?.open_id;
			} catch {}
			try {
				await c.ws?.start?.();
				wsReadyFlag = true;
			} catch (err) {
				deps.logger?.error(`ws start failed: ${String(err)}`);
				wsReadyFlag = false;
			}
		},
		async stop() {
			started = false;
			wsReadyFlag = false;
			try {
				await client().ws?.stop?.();
			} catch {}
		},
		isConnected: () => started && wsReadyFlag,
		wsReady: () => wsReadyFlag,
		async probe() {
			try {
				const bot = await client().getBotInfo?.();
				if (bot?.open_id) botOpenId = bot.open_id;
				return true;
			} catch {
				return false;
			}
		},
		botOpenId: () => botOpenId,
		async downloadResource(params) {
			const c = client();
			if (!c.downloadResource) throw new Error("lark client does not support downloadResource");
			return c.downloadResource(params);
		}
	};
}
/**
* Extract an upload key from a Feishu SDK upload response, tolerating BOTH
* the real top-level shape ({file_key}) and the legacy nested shape
* ({data:{file_key}}) — pi-feishu-link 2026-08-14 real-SDK fix.
*/
function extractUploadKey(res, key) {
	if (!res || typeof res !== "object") return void 0;
	const r = res;
	const direct = r[key];
	if (typeof direct === "string" && direct.length > 0) return direct;
	const nested = r.data?.[key];
	return typeof nested === "string" && nested.length > 0 ? nested : void 0;
}
//#endregion
//#region src/inbound/connection-supervisor.ts
const sleep$1 = (ms) => new Promise((r) => {
	setTimeout(r, ms).unref?.();
});
function createConnectionSupervisor(deps) {
	const now = deps.now ?? Date.now;
	let state = "idle";
	let timer;
	let stopped = false;
	let probeFailStreak = 0;
	let reconnectAttempts = 0;
	const setState = (s, detail) => {
		state = s;
		deps.status.setConn(s, detail ? { lastError: detail } : {});
		deps.onStateChange?.(s, detail);
		if (detail) deps.logger?.warn(`conn -> ${s}: ${detail}`);
		else deps.logger?.info(`conn -> ${s}`);
	};
	async function ensureConnected() {
		if (stopped) return;
		if (deps.transport.isConnected()) {
			if (state !== "connected") setState("connected");
			return;
		}
		if (state === "quarantined") return;
		if (deps.quota.tripped()) {
			setState("quarantined", `quota breaker tripped (${deps.cfg.quotaLimit}/${deps.cfg.quotaWindowMinutes}min); retry after reset`);
			return;
		}
		if (reconnectAttempts >= deps.cfg.maxReconnectAttempts) {
			deps.quota.recordFailure();
			setState("quarantined", `reconnect attempts exhausted (${reconnectAttempts}); circuit breaker armed`);
			return;
		}
		setState("connecting");
		deps.quota.recordConnect();
		try {
			await deps.transport.start();
		} catch (err) {
			deps.logger?.error(`transport.start threw: ${String(err)}`);
		}
		if (deps.transport.isConnected()) {
			reconnectAttempts = 0;
			probeFailStreak = 0;
			setState("connected");
		} else {
			reconnectAttempts++;
			deps.quota.recordFailure();
			if (deps.quota.tripped()) {
				setState("quarantined", `quota breaker tripped after ${reconnectAttempts} failed connects`);
				return;
			}
			setState("reconnecting", `connect failed (attempt ${reconnectAttempts}/${deps.cfg.maxReconnectAttempts})`);
		}
	}
	async function tick() {
		if (stopped) return;
		if (state === "quarantined") {
			const liftAt = deps.quota.resetAt();
			if (liftAt === void 0 || now() >= liftAt) {
				deps.logger?.info("quota window reset — auto-recovering from quarantine");
				deps.quota.reset();
				reconnectAttempts = 0;
				if (state === "quarantined") state = "reconnecting";
				await ensureConnected();
			}
			return;
		}
		let ok = false;
		try {
			ok = await Promise.race([deps.transport.probe(), sleep$1(deps.cfg.probeTimeoutMs).then(() => false)]);
		} catch {
			ok = false;
		}
		deps.status.update({
			lastProbeAt: now(),
			lastProbeOk: ok,
			wsReady: deps.transport.wsReady()
		});
		if (ok) {
			probeFailStreak = 0;
			if (!deps.transport.isConnected()) {
				reconnectAttempts = 0;
				await ensureConnected();
			} else if (state !== "connected") setState("connected");
			return;
		}
		probeFailStreak++;
		if (probeFailStreak >= deps.cfg.probeFailThreshold) {
			if (deps.transport.isConnected()) setState("degraded", `probe failed ${probeFailStreak}x`);
			await ensureConnected();
		}
	}
	return {
		async start() {
			stopped = false;
			setState("connecting");
			await ensureConnected();
			timer = setInterval(() => void tick(), deps.cfg.probeIntervalMs);
			timer.unref?.();
		},
		async stop() {
			stopped = true;
			if (timer) clearInterval(timer);
			await deps.transport.stop();
			setState("stopped");
		},
		async tick() {
			await tick();
		},
		state: () => state,
		async reconnect() {
			reconnectAttempts = 0;
			deps.quota.reset();
			await deps.transport.stop();
			await ensureConnected();
		}
	};
}
//#endregion
//#region src/inbound/missed-compensation.ts
/** Replay window: pull messages from the last N minutes of disconnection. */
const REPLAY_WINDOW_MS = 6e5;
function createMissedCompensation(deps) {
	const now = deps.now ?? Date.now;
	const delivered = /* @__PURE__ */ new Set();
	const maxTracked = 5e3;
	return {
		noteDelivered(messageId) {
			delivered.add(messageId);
			if (delivered.size > maxTracked) {
				const arr = [...delivered];
				delivered.clear();
				for (const id of arr.slice(-2500)) delivered.add(id);
			}
		},
		async onRecovered() {
			const until = now();
			const since = until - REPLAY_WINDOW_MS;
			let pulled = 0;
			for (const route of deps.routes.all()) try {
				const items = await deps.listMessages({
					chatId: route.chatId,
					startTimeMs: since,
					endTimeMs: until
				});
				for (const item of items) {
					if (delivered.has(item.messageId)) continue;
					deps.reinject({
						messageId: item.messageId,
						chatId: route.chatId,
						chatType: route.chatType,
						chatMode: route.chatType === "p2p" ? "p2p" : "group_at",
						senderOpenId: "unknown",
						msgType: "text",
						content: "",
						text: "",
						mentions: [],
						timestamp: item.timestampMs
					});
					delivered.add(item.messageId);
					pulled++;
				}
			} catch (err) {
				deps.logger?.warn(`compensation listMessages failed for ${route.chatId}: ${String(err)}`);
			}
			if (pulled > 0) deps.logger?.info(`compensation re-injected ${pulled} missed messages`);
		}
	};
}
//#endregion
//#region src/inbound/group-trigger.ts
function createGroupTrigger(deps) {
	return { shouldTrigger(msg) {
		if (msg.chatType !== "group") return true;
		const { policy, keywords, alsoOnReply } = deps.cfg();
		const botOpenId = deps.botOpenId?.();
		const isReplyToBot = msg.parentId !== void 0 || msg.rootId !== void 0;
		switch (policy) {
			case "open": return true;
			case "mention":
				if (botOpenId !== void 0 && msg.mentions.includes(botOpenId)) return true;
				if (msg.mentions.length > 0 || msg.chatMode === "group_at") return true;
				return alsoOnReply && isReplyToBot;
			case "keywords":
				if (keywords.some((k) => (msg.text ?? "").includes(k))) return true;
				return alsoOnReply && isReplyToBot;
			case "reply": return isReplyToBot;
			default: return false;
		}
	} };
}
//#endregion
//#region src/application/bridge-context.ts
function createBridgeContext(deps) {
	let _conversations;
	let _transport;
	let _outbox;
	let _forwarder;
	let _compensation;
	let _botOpenId;
	let _started = false;
	let _voice = deps.voice;
	return {
		get conversations() {
			return _conversations;
		},
		setConversations(v) {
			_conversations = v;
		},
		get backend() {
			return deps.backend;
		},
		get transport() {
			return _transport;
		},
		setTransport(v) {
			_transport = v;
		},
		get outbox() {
			return _outbox;
		},
		setOutbox(v) {
			_outbox = v;
		},
		get router() {
			return deps.router;
		},
		get forwarder() {
			return _forwarder;
		},
		setForwarder(v) {
			_forwarder = v;
		},
		get compensation() {
			return _compensation;
		},
		setCompensation(v) {
			_compensation = v;
		},
		get sender() {
			return deps.sender;
		},
		get attachments() {
			return deps.attachmentsRef?.();
		},
		get voice() {
			return _voice;
		},
		setVoice(v) {
			_voice = v;
		},
		get logger() {
			return deps.logger;
		},
		get cfg() {
			return deps.cfg;
		},
		get configStore() {
			return deps.configStore;
		},
		get status() {
			return deps.status;
		},
		botOpenId: () => _botOpenId,
		setBotOpenId(v) {
			_botOpenId = v;
		},
		started: () => _started,
		setStarted(v) {
			_started = v;
		},
		conversationKeyFor: (msg) => msg.chatType === "p2p" ? `dm:${msg.chatId}` : `group:${msg.chatId}`,
		routeFor(key) {
			return deps.router?.get(key);
		},
		async markDone(key, triggerMessageId) {
			if (!triggerMessageId || !deps.sender) return;
			const doneEmoji = deps.cfg().reactions.done || "DONE";
			deps.logger.info(`markDone: ${key} -> ${triggerMessageId} (${doneEmoji})`);
			try {
				await deps.sender.addReaction(triggerMessageId, doneEmoji);
			} catch (err) {
				deps.logger.warn(`markDone reaction failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	};
}
//#endregion
//#region src/common/reactions.ts
/** All Feishu-valid emoji_type values (open.feishu.cn …/emojis-introduce). */
const VALID_EMOJI_TYPES = /* @__PURE__ */ new Set([
	"OK",
	"THUMBSUP",
	"THANKS",
	"MUSCLE",
	"FINGERHEART",
	"APPLAUSE",
	"FISTBUMP",
	"JIAYI",
	"DONE",
	"SMILE",
	"BLUSH",
	"LAUGH",
	"SMIRK",
	"LOL",
	"FACEPALM",
	"LOVE",
	"WINK",
	"PROUD",
	"WITTY",
	"SMART",
	"SCOWL",
	"THINKING",
	"SOB",
	"CRY",
	"ERROR",
	"NOSEPICK",
	"HAUGHTY",
	"SLAP",
	"SPITBLOOD",
	"TOASTED",
	"GLANCE",
	"DULL",
	"INNOCENTSMILE",
	"JOYFUL",
	"WOW",
	"TRICK",
	"YEAH",
	"ENOUGH",
	"TEARS",
	"EMBARRASSED",
	"KISS",
	"SMOOCH",
	"DROOL",
	"OBSESSED",
	"MONEY",
	"TEASE",
	"SHOWOFF",
	"COMFORT",
	"CLAP",
	"PRAISE",
	"STRIVE",
	"XBLUSH",
	"SILENT",
	"WAVE",
	"WHAT",
	"FROWN",
	"SHY",
	"DIZZY",
	"LOOKDOWN",
	"CHUCKLE",
	"WAIL",
	"CRAZY",
	"WHIMPER",
	"HUG",
	"BLUBBER",
	"WRONGED",
	"HUSKY",
	"SHHH",
	"SMUG",
	"ANGRY",
	"HAMMER",
	"SHOCKED",
	"TERROR",
	"PETRIFIED",
	"SKULL",
	"SWEAT",
	"SPEECHLESS",
	"SLEEP",
	"DROWSY",
	"YAWN",
	"SICK",
	"PUKE",
	"BETRAYED",
	"HEADSET",
	"EatingFood",
	"MeMeMe",
	"Sigh",
	"Typing",
	"Lemon",
	"Get",
	"LGTM",
	"OnIt",
	"OneSecond",
	"VRHeadset",
	"YouAreTheBest",
	"SALUTE",
	"SHAKE",
	"HIGHFIVE",
	"UPPERLEFT",
	"ThumbsDown",
	"SLIGHT",
	"TONGUE",
	"EYESCLOSED",
	"RoarForYou",
	"CALF",
	"BEAR",
	"BULL",
	"RAINBOWPUKE",
	"ROSE",
	"HEART",
	"PARTY",
	"LIPS",
	"BEER",
	"CAKE",
	"GIFT",
	"CUCUMBER",
	"Drumstick",
	"Pepper",
	"CANDIEDHAWS",
	"BubbleTea",
	"Coffee",
	"Yes",
	"No",
	"OKR",
	"CheckMark",
	"CrossMark",
	"MinusOne",
	"Hundred",
	"AWESOMEN",
	"Pin",
	"Alarm",
	"Loudspeaker",
	"Trophy",
	"Fire",
	"BOMB",
	"Music",
	"XmasTree",
	"Snowman",
	"XmasHat",
	"FIREWORKS",
	"REDPACKET",
	"FORTUNE",
	"LUCK",
	"FIRECRACKER",
	"StickyRiceBalls",
	"HEARTBROKEN",
	"POOP",
	"StatusFlashOfInspiration",
	"CLEAVER",
	"Soccer",
	"Basketball",
	"GeneralDoNotDisturb",
	"Status_PrivateMessage",
	"GeneralInMeetingBusy",
	"StatusReading",
	"StatusInFlight",
	"GeneralBusinessTrip",
	"GeneralWorkFromHome",
	"StatusEnjoyLife",
	"GeneralTravellingCar",
	"StatusBus",
	"GeneralSun",
	"GeneralMoonRest",
	"MoonRabbit",
	"Mooncake",
	"JubilantRabbit",
	"TV",
	"Movie",
	"Pumpkin",
	"BeamingFace",
	"Delighted",
	"ColdSweat",
	"FullMoonFace",
	"Partying",
	"GoGoGo",
	"ThanksFace",
	"SaluteFace",
	"Shrug",
	"ClownFace",
	"HappyDragon"
]);
/** Completion marker — never part of the random pool. */
const DONE_EMOJI = "DONE";
/**
* Default random receipt pool (all Feishu-valid). 2026-08-08 pi fix:
* FIRE → Fire (case-sensitive); ROCKET/SUN/WHITE_CHECK_MARK are NOT valid
* Feishu emoji_type values and cause addReaction 231001.
*/
const DEFAULT_RANDOM_POOL = [
	"THUMBSUP",
	"OK",
	"HEART",
	"LAUGH",
	"SMILE",
	"WOW",
	"CLAP",
	"Fire"
];
/**
* Build a reaction picker from a configured pool. Filters out any type not in
* VALID_EMOJI_TYPES (fail-safe: a stale config cannot 400 the bridge) AND the
* DONE marker (completion marker never participates in the random pool);
* falls back to the default pool when nothing valid remains.
*/
function createReactionPicker(pool, done) {
	const validPool = pool.filter((t) => VALID_EMOJI_TYPES.has(t) && t !== done);
	const effectivePool = validPool.length > 0 ? validPool : DEFAULT_RANDOM_POOL.filter((t) => t !== done);
	const effectiveDone = VALID_EMOJI_TYPES.has(done) ? done : DONE_EMOJI;
	return {
		pickRandom() {
			if (effectivePool.length === 0) return void 0;
			return effectivePool[Math.floor(Math.random() * effectivePool.length)];
		},
		done: () => effectiveDone
	};
}
//#endregion
//#region src/application/message-handler.ts
/**
* Make a user-provided filename safe on EVERY platform we may run on
* (Linux/macOS/Windows — the bridge is cross-platform by design):
* - Windows forbids <>:"/\\|?* and trailing dots/spaces;
* - control characters confuse shells and terminals everywhere;
* - macOS screenshot names contain ":" (invalid on Windows) — a file written
*   with such a name on one OS becomes unreadable/unmovable when the state
*   dir lives on a share synced to another.
* CJK/unicode content itself is kept; only separators/reserved chars go.
*/
function sanitizeAttachmentName(name) {
	const trimmed = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]$/, "_").slice(0, 200);
	return trimmed.length > 0 ? trimmed : "feishu-attachment";
}
/** Sniff image media type from magic bytes (feishu im resources are raw). */
function sniffImageType(buf) {
	if (buf.length >= 8 && buf[0] === 137 && buf[1] === 80) return "image/png";
	if (buf.length >= 3 && buf[0] === 255 && buf[1] === 216) return "image/jpeg";
	if (buf.length >= 12 && buf.slice(0, 4).every((b, i) => b === [
		82,
		73,
		70,
		70
	][i]) && buf.slice(8, 12).every((b, i) => b === [
		87,
		69,
		66,
		80
	][i])) return "image/webp";
	if (buf.length >= 6 && buf[0] === 71 && buf[1] === 73) return "image/gif";
	return "image/png";
}
/** File extension (including dot) for an image media type. */
function imgExt(m) {
	switch (m) {
		case "image/png": return ".png";
		case "image/webp": return ".webp";
		case "image/gif": return ".gif";
		default: return ".jpg";
	}
}
/**
* Resolve inbound Feishu attachments (M6): image → download → attachment
* store (ImageBlock for the visual model); file → download → bounded text
* extraction. Post (rich text) messages carry images INLINE as
* `{tag:"img", image_key}` elements — every one is extracted and resolved.
* Failures degrade to text-only (never drop the message).
*/
/** Persist fallback used when no voice service is wired at all. */
function persistAudioFallback(buffer, baseName, inboundDir) {
	if (!inboundDir) return { errors: ["未配置 inboundDir，音频无法落盘"] };
	try {
		mkdirSync(join(inboundDir, "media"), { recursive: true });
		const localPath = join(inboundDir, "media", `${baseName}.bin`);
		writeFileSync(localPath, buffer);
		return {
			localPath,
			errors: []
		};
	} catch (err) {
		return { errors: ["落盘失败: " + (err instanceof Error ? err.message : String(err))] };
	}
}
async function resolveInboundAttachments(msg, ctx, inboundDir, voice, transcribe = true) {
	const out = [];
	if (!msg.messageId) return out;
	try {
		if (msg.msgType === "post") {
			const parsed = JSON.parse(msg.content ?? "{}");
			const keys = [];
			const pushImgKeys = (elements) => {
				if (!Array.isArray(elements)) return;
				for (const e of elements) {
					const el = e;
					if (el?.tag === "img" && typeof el.image_key === "string") keys.push(el.image_key);
				}
			};
			const content = parsed.content;
			const paragraphs = content?.paragraphs;
			if (Array.isArray(paragraphs)) for (const p of paragraphs) pushImgKeys(p?.elements);
			else if (Array.isArray(content)) for (const line of content) if (Array.isArray(line)) pushImgKeys(line);
			else pushImgKeys([line]);
			const unique = [...new Set(keys)];
			for (const key of unique) {
				const one = await resolveOneImage(msg, ctx, inboundDir, key);
				if (one) out.push(one);
			}
			return out;
		}
		if (msg.msgType === "image") {
			const parsed = JSON.parse(msg.content ?? "{}");
			if (parsed.image_key) {
				const one = await resolveOneImage(msg, ctx, inboundDir, parsed.image_key);
				if (one) out.push(one);
			}
		} else if (msg.msgType === "audio") {
			const parsed = JSON.parse(msg.content ?? "{}");
			const key = parsed.file_key;
			const durationMs = Number(parsed.duration ?? 0);
			if (key && ctx.transport) {
				const buf = await ctx.transport.downloadResource({
					messageId: msg.messageId,
					fileKey: key,
					type: "file"
				});
				if (buf && buf.length > 0) {
					const seconds = durationMs > 0 ? (durationMs / 1e3).toFixed(1) : "?";
					const stem = `feishu-${sanitizeAttachmentName(msg.messageId)}-${msg.timestamp}-${sanitizeAttachmentName(key.slice(-6))}`;
					let localPath;
					const persisted = voice ? voice.persistRawAudio(buf, stem, inboundDir) : persistAudioFallback(buf, stem, inboundDir);
					localPath = persisted.localPath;
					for (const e of persisted.errors) ctx.logger.warn(`voice: ${e}`);
					if (voice && transcribe && localPath) {
						const outcome = await voice.transcribeRaw(localPath, durationMs);
						for (const e of outcome.errors) ctx.logger.warn(`voice: ${e}`);
						if (outcome.text) msg.text = outcome.text;
					}
					out.push({
						path: localPath ?? "feishu://audio",
						kind: "file",
						name: `[语音 ${seconds}s] ${localPath ?? "feishu://audio"}`
					});
				}
			}
		} else if (msg.msgType === "file") {
			const parsed = JSON.parse(msg.content ?? "{}");
			const key = parsed.file_key;
			const name = parsed.file_name ?? "附件";
			if (key && ctx.transport) {
				const buf = await ctx.transport.downloadResource({
					messageId: msg.messageId,
					fileKey: key,
					type: "file"
				});
				if (buf && buf.length > 0) {
					let localPath;
					if (inboundDir) try {
						mkdirSync(join(inboundDir, "media"), { recursive: true });
						const path = join(inboundDir, "media", `feishu-${sanitizeAttachmentName(msg.messageId)}-${Date.now()}-${sanitizeAttachmentName(name)}`);
						writeFileSync(path, buf);
						localPath = path;
					} catch (err) {
						ctx.logger.warn(`inbound file persist failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					out.push({
						path: localPath ?? "feishu://file",
						kind: "file",
						name
					});
					if (buf.length <= 15e4) {
						const text = buf.toString("utf8");
						if (text && !text.includes("�")) out.push({
							path: "feishu://file-text",
							kind: "file",
							name: `${name} 内容提取`,
							textPreview: text
						});
					}
				}
			}
		}
	} catch (err) {
		ctx.logger.warn(`inbound attachment resolve failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	return out;
}
/**
* Shared per-image resolution (image message + post-embedded img elements):
* download → persist a real local file → save into the DSH attachment store
* (ImageBlock ref). Returns undefined on any failure (degrade, never drop).
*/
async function resolveOneImage(msg, ctx, inboundDir, imageKey) {
	if (!ctx.transport) return void 0;
	const buf = await ctx.transport.downloadResource({
		messageId: msg.messageId,
		fileKey: imageKey,
		type: "image"
	});
	if (!buf || buf.length === 0) return void 0;
	let localPath;
	if (inboundDir) try {
		const ext = imgExt(sniffImageType(buf));
		const name = `feishu-${sanitizeAttachmentName(msg.messageId)}-${sanitizeAttachmentName(imageKey.slice(-8))}${ext}`;
		mkdirSync(join(inboundDir, "media"), { recursive: true });
		const path = join(inboundDir, "media", name);
		writeFileSync(path, buf);
		localPath = path;
	} catch (err) {
		ctx.logger.warn(`inbound image persist failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	const attach = {
		path: localPath ?? "feishu://image",
		kind: "image",
		name: localPath ?? "feishu-image"
	};
	const store = ctx.attachments;
	if (store?.saveImage) try {
		attach.imageRef = await store.saveImage({
			data: buf,
			mediaType: sniffImageType(buf),
			name: attach.name
		});
	} catch (err) {
		ctx.logger.warn(`inbound image saveImage failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	return attach;
}
function createMessageHandler(deps) {
	const logger = deps.ctx.logger;
	async function handle(msg, compensated) {
		if (!compensated && !deps.dedupe.add(msg.messageId)) {
			logger.info(`drop: duplicate ${msg.messageId}`);
			return "dropped";
		}
		const allowlist = deps.allowlist();
		if (allowlist.length > 0 && !allowlist.includes(msg.senderOpenId)) {
			logger.info(`drop: sender ${msg.senderOpenId} not in allowlist`);
			return "dropped";
		}
		if (!deps.groupTrigger.shouldTrigger(msg)) {
			logger.info(`drop: group policy for ${msg.chatId}`);
			return "dropped";
		}
		const reactions = deps.ctx.cfg().reactions;
		if (reactions.enabled) {
			const pick = createReactionPicker(reactions.pool, reactions.done).pickRandom();
			if (pick) try {
				await deps.ctx.sender?.addReaction(msg.messageId, pick);
			} catch {
				logger.warn(`receipt reaction failed for ${msg.messageId}`);
			}
		}
		if (await deps.commands.route(msg) === "agent") {
			const cm = deps.ctx.conversations;
			if (!cm) {
				logger.error("message dropped: conversations not assembled (late wiring?)");
				return "dropped";
			}
			const sessionKey = cm.keyFor(msg);
			deps.ctx.router?.upsert({
				sessionKey,
				chatId: msg.chatId,
				chatType: msg.chatType,
				lastMessageId: msg.messageId,
				updatedAt: Date.now()
			});
			const attachments = await resolveInboundAttachments(msg, deps.ctx, deps.inboundDir, deps.voice, deps.transcribeAudio !== false);
			if ((msg.msgType === "text" || (msg.text ?? "").trim() !== "") && !compensated && deps.wal) try {
				deps.wal.accept({
					messageId: msg.messageId,
					sessionKey,
					chatId: msg.chatId,
					chatType: msg.chatType,
					senderOpenId: msg.senderOpenId,
					text: (msg.text ?? msg.content ?? "").slice(0, 8e3)
				});
			} catch (err) {
				logger.warn(`inbound-wal accept failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			try {
				await cm.handleMessage(msg, attachments);
			} catch (err) {
				logger.error(`conversation handling failed: ${String(err)}`);
				return "dropped";
			}
		}
		if (compensated) deps.onReinjected?.(msg);
		return "processed";
	}
	return {
		async handleInbound(msg) {
			return handle(msg, false);
		},
		async handleCompensated(msg) {
			await handle(msg, true);
		}
	};
}
//#endregion
//#region src/application/media-retention.ts
/**
* Delete files under `mediaDir` whose mtime is older than
* `retentionHours`. Missing directory / unreadable entries are no-ops so
* the sweeper can never take the bridge down.
*/
function sweepMediaDir(mediaDir, retentionHours, now = Date.now()) {
	if (!(retentionHours > 0)) return {
		deleted: 0,
		errors: 0
	};
	let entries;
	try {
		entries = readdirSync(mediaDir);
	} catch {
		return {
			deleted: 0,
			errors: 0
		};
	}
	const cutoff = now - retentionHours * 36e5;
	let deleted = 0;
	let errors = 0;
	for (const name of entries) {
		const p = join(mediaDir, name);
		try {
			const st = statSync(p);
			if (st.isFile() && st.mtimeMs < cutoff) {
				rmSync(p, {
					force: true,
					maxRetries: 3,
					retryDelay: 100
				});
				deleted++;
			}
		} catch {
			errors++;
		}
	}
	return {
		deleted,
		errors
	};
}
/**
* Start the media retention sweeper: one sweep IMMEDIATELY (clears stale
* files from previous runs — the temp dir survives restarts) and then every
* `intervalMs` (default: hourly). `retentionHours` is a live getter so
* `/lark-config attachments.retentionHours=<n>` applies without a reload.
* Returns a stop function (wired into the Cordis ctx.effect disposer).
*/
function startMediaSweeper(opts) {
	const run = () => {
		try {
			const r = sweepMediaDir(opts.mediaDir, opts.retentionHours());
			if (r.deleted > 0) opts.logger?.info?.(`media sweep: removed ${r.deleted} expired file(s) under ${opts.mediaDir}`);
			if (r.errors > 0) opts.logger?.warn?.(`media sweep: ${r.errors} entr(y/ies) failed under ${opts.mediaDir}`);
		} catch (err) {
			opts.logger?.warn?.(`media sweep failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	run();
	const timer = setInterval(run, opts.intervalMs ?? 36e5);
	timer.unref?.();
	return () => clearInterval(timer);
}
//#endregion
//#region src/application/status-formatter.ts
function formatStatusLine(s) {
	const parts = [
		`连接: ${s.connState.toUpperCase()}${s.wsReady ? " (WS)" : ""}`,
		`outbox: ${s.outboxPending} 待发 / ${s.outboxFailed} 失败`,
		`会话: ${s.sessions}`
	];
	if (s.inboundPending > 0) parts.push(`补发: ${s.inboundPending} 条未完成`);
	if (s.inboundFailed > 0) parts.push(`补发失败: ${s.inboundFailed} 条`);
	if (s.quarantinedUntil) {
		const mins = Math.ceil((s.quarantinedUntil - Date.now()) / 6e4);
		parts.push(`熔断: ${Math.max(0, mins)}min 后重试`);
	}
	if (s.lastError) parts.push(`最近错误: ${s.lastError}`);
	return parts.join(" · ");
}
function statusDetailLines(s) {
	const lines = [
		`状态: ${s.connState}`,
		`WS 就绪: ${s.wsReady}`,
		`上次探活: ${s.lastProbeAt ? new Date(s.lastProbeAt).toISOString() : "—"} (${s.lastProbeOk === void 0 ? "?" : s.lastProbeOk ? "正常" : "失败"})`,
		`outbox 待发: ${s.outboxPending}`,
		`outbox 失败: ${s.outboxFailed}`,
		`入站补发待处理: ${s.inboundPending}`,
		`入站补发失败: ${s.inboundFailed}`,
		`活跃会话: ${s.sessions}`
	];
	if (s.connectedAt) lines.push(`连接时间: ${new Date(s.connectedAt).toISOString()}`);
	if (s.quarantinedUntil) lines.push(`熔断至: ${new Date(s.quarantinedUntil).toISOString()} (${s.quarantinedReason ?? ""})`);
	if (s.owner) lines.push(`持有者: pid ${s.owner.pid} @ ${s.owner.host} (${new Date(s.owner.startedAt).toISOString()})`);
	return lines;
}
/** Mask secrets in a diagnostics dump (config/credentials redaction). */
function redactSecrets(input, secrets) {
	let out = input;
	for (const secret of secrets) {
		if (!secret) continue;
		out = out.split(secret).join("***");
	}
	out = out.replace(/\b[0-9A-Za-z_\-]{32,}\b/g, "***");
	return out;
}
//#endregion
//#region src/application/diagnostics-service.ts
function createDiagnosticsService(deps) {
	return { async build() {
		const s = deps.ctx.status.get();
		const cfg = deps.ctx.cfg();
		const lines = [
			"# dsh-lark-plus 诊断包",
			"",
			`生成时间: ${(/* @__PURE__ */ new Date()).toISOString()}`,
			`桥状态: ${deps.ctx.started() ? "运行中" : "未启动"}`,
			...statusDetailLines(s),
			"",
			"## 配置（脱敏）",
			"```json",
			redactSecrets(JSON.stringify(cfg, null, 2), deps.secrets),
			"```"
		];
		if (deps.extra) lines.push("", "## 附加信息", "```json", JSON.stringify(deps.extra, null, 2), "```");
		const issueMd = [
			"## 问题描述",
			"",
			"（请填写：现象 / 复现步骤 / 期望结果）",
			"",
			"## 诊断信息",
			"```",
			...lines,
			"```",
			"",
			"## 环境",
			"- dsh-lark-plus: 0.1.0",
			"- Node: " + process.version
		].join("\n");
		return {
			text: lines.join("\n"),
			issueMd
		};
	} };
}
//#endregion
//#region src/common/connection-status.ts
function createStatusStore(file, now = Date.now) {
	let status = {
		connState: "idle",
		outboxPending: 0,
		outboxFailed: 0,
		inboundPending: 0,
		inboundFailed: 0,
		sessions: 0,
		wsReady: false
	};
	if (file) try {
		const raw = readFileSync(file, "utf8");
		status = {
			...status,
			...JSON.parse(raw)
		};
	} catch {}
	const persist = () => {
		if (!file) return;
		try {
			writeFileSync(file, JSON.stringify(status, null, 2), { mode: 384 });
		} catch {}
	};
	return {
		get: () => ({ ...status }),
		update(patch) {
			status = {
				...status,
				...patch
			};
			persist();
			return this.get();
		},
		setConn(state, extra) {
			const patch = {
				connState: state,
				...extra
			};
			if (state === "connected") patch.connectedAt = now();
			status = {
				...status,
				...patch
			};
			persist();
			return this.get();
		},
		refreshCounters(counters) {
			status = {
				...status,
				...counters
			};
			persist();
		}
	};
}
//#endregion
//#region src/common/logger.ts
function createLogger(scope, minLevel = "info") {
	const levelRank = {
		debug: 0,
		info: 1,
		warn: 2,
		error: 3
	};
	const emit = (level, msg, meta) => {
		if (levelRank[level] < levelRank[minLevel]) return;
		const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] [${level.toUpperCase()}] [${scope}] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}`;
		if (level === "error") process.stderr.write(line + "\n");
		else process.stdout.write(line + "\n");
	};
	return {
		debug: (m, meta) => emit("debug", m, meta),
		info: (m, meta) => emit("info", m, meta),
		warn: (m, meta) => emit("warn", m, meta),
		error: (m, meta) => emit("error", m, meta)
	};
}
//#endregion
//#region src/common/dedupe-store.ts
const MAX_RECORDS = 1e4;
function createDedupeStore(file, now = Date.now) {
	let records = [];
	try {
		const raw = readFileSync(file, "utf8");
		records = JSON.parse(raw).slice(-1e4);
	} catch {
		records = [];
	}
	const persist = () => {
		try {
			writeFileSync(file, JSON.stringify(records.slice(-1e4), null, 2), { mode: 384 });
		} catch {}
	};
	return {
		seen(messageId) {
			return records.some((r) => r.messageId === messageId);
		},
		add(messageId) {
			if (records.some((r) => r.messageId === messageId)) return false;
			records.push({
				messageId,
				at: now()
			});
			if (records.length > MAX_RECORDS) records = records.slice(-1e4);
			persist();
			return true;
		},
		prune(ttlMs) {
			const cutoff = now() - ttlMs;
			const before = records.length;
			records = records.filter((r) => r.at >= cutoff);
			if (records.length !== before) persist();
		}
	};
}
//#endregion
//#region src/inbound/inbound-wal.ts
function createInboundWal(deps) {
	const dir = deps.dir;
	const replayRetentionMs = deps.replayRetentionMs ?? 18e5;
	const maxReplayAttempts = deps.maxReplayAttempts ?? 2;
	const now = deps.now ?? Date.now;
	mkdirSync(dir, { recursive: true });
	/** messageId -> record (bounded set; pruned over time). */
	const records = /* @__PURE__ */ new Map();
	function load() {
		let segs = [];
		try {
			segs = readdirSync(dir).filter((f) => /^seg-.*\.jsonl$/.test(f)).sort();
		} catch {
			segs = [];
		}
		for (const seg of segs) try {
			const lines = readFileSync(join(dir, seg), "utf8").split("\n").filter(Boolean);
			for (const line of lines) try {
				const rec = JSON.parse(line);
				if (rec?.messageId) records.set(rec.messageId, rec);
			} catch {}
		} catch {}
	}
	function persistAll() {
		try {
			const segFile = join(dir, `seg-${Date.now()}.jsonl`);
			const tmp = `${segFile}.tmp`;
			const lines = [...records.values()].map((r) => JSON.stringify(r));
			writeFileSync(tmp, lines.join("\n") + "\n", { mode: 384 });
			renameSync(tmp, segFile);
		} catch {}
	}
	load();
	return {
		accept(rec) {
			const full = {
				...rec,
				acceptedAt: now(),
				attempts: 0,
				state: "accepted"
			};
			records.set(rec.messageId, full);
			persistAll();
			return full;
		},
		delivered(messageId) {
			const rec = records.get(messageId);
			if (!rec || rec.state === "delivered") return;
			rec.state = "delivered";
			persistAll();
		},
		fail(messageId) {
			const rec = records.get(messageId);
			if (!rec || rec.state === "delivered" || rec.state === "failed") return;
			rec.state = "failed";
			persistAll();
		},
		markReplay(messageId) {
			const rec = records.get(messageId);
			if (!rec) return false;
			if (rec.state === "delivered") return false;
			if (rec.attempts >= maxReplayAttempts) {
				if (rec.state !== "failed") {
					rec.state = "failed";
					persistAll();
				}
				return false;
			}
			if (now() - rec.acceptedAt > replayRetentionMs) return false;
			rec.attempts += 1;
			rec.state = "replayed";
			persistAll();
			return true;
		},
		pendingReplays() {
			const cutoff = now() - replayRetentionMs;
			return [...records.values()].filter((r) => r.state !== "delivered" && r.state !== "failed" && r.attempts < maxReplayAttempts && r.acceptedAt >= cutoff).sort((a, b) => a.acceptedAt - b.acceptedAt);
		},
		prune() {
			const deliveredCutoff = now() - replayRetentionMs;
			let changed = false;
			for (const [id, r] of records) if (r.state === "delivered" || r.state === "failed" ? r.acceptedAt < deliveredCutoff : r.acceptedAt < deliveredCutoff && r.attempts >= maxReplayAttempts) {
				records.delete(id);
				changed = true;
			}
			if (changed) persistAll();
		},
		remove(messageId) {
			if (records.delete(messageId)) persistAll();
		},
		failedCount: () => [...records.values()].filter((r) => r.state === "failed").length,
		pendingCount: () => records.size
	};
}
//#endregion
//#region src/inbound/replay-salvage.ts
/** Extract assistant text from a DSH session event's content blocks. */
function assistantTextOf(ev) {
	const e = ev;
	if (e?.type !== "assistant/message") return void 0;
	const blocks = e.data?.message?.content;
	if (!Array.isArray(blocks)) return void 0;
	return blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}
function createReplaySalvage(deps) {
	const salvaged = /* @__PURE__ */ new Set();
	return { async salvage(rec, sessionId) {
		if (!sessionId || salvaged.has(rec.messageId)) return false;
		let events;
		try {
			events = (await deps.loadSession(sessionId))?.events;
		} catch (err) {
			deps.logger?.warn(`replay-salvage: loadSession(${sessionId}) failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
		if (!events || events.length === 0) return false;
		for (let i = events.length - 1; i >= 0; i--) {
			const text = assistantTextOf(events[i]);
			if (text === void 0) continue;
			const time = events[i].time;
			if (typeof time !== "number" || time < rec.acceptedAt) return false;
			if (!text || text.trim() === "" || text === "No response.") return false;
			try {
				await deps.enqueue({
					dedupeKey: `wal-salvage:${rec.messageId}`,
					laneKey: rec.sessionKey,
					route: {
						sessionKey: rec.sessionKey,
						chatId: rec.chatId,
						chatType: rec.chatType
					},
					kind: "assistant-output",
					payload: {
						kind: "text",
						text
					}
				});
			} catch (err) {
				deps.logger?.warn(`replay-salvage: enqueue failed for ${rec.messageId}: ${err instanceof Error ? err.message : String(err)}`);
				return false;
			}
			salvaged.add(rec.messageId);
			deps.wal.delivered(rec.messageId);
			deps.logger?.info(`replay-salvage: answered ${rec.messageId} from session ${sessionId} (no agent re-run)`);
			return true;
		}
		return false;
	} };
}
//#endregion
//#region src/common/quota-governor.ts
function createQuotaGovernor(historyFile, opts = {
	windowMinutes: 60,
	limit: 12
}) {
	const now = opts.now ?? Date.now;
	const windowMs = opts.windowMinutes * 6e4;
	let history = [];
	try {
		history = readFileSync(historyFile, "utf8").split("\n").filter(Boolean).map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return;
			}
		}).filter((r) => r !== void 0);
	} catch {
		history = [];
	}
	const persist = () => {
		try {
			mkdirSync(join(historyFile, ".."), { recursive: true });
			writeFileSync(historyFile, history.slice(-500).map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 384 });
		} catch {}
	};
	const prune = () => {
		const cutoff = now() - windowMs;
		history = history.filter((r) => r.at >= cutoff);
	};
	return {
		recordConnect() {
			prune();
			history.push({
				at: now(),
				ok: true
			});
			persist();
			return history.length;
		},
		recordFailure() {
			prune();
			history.push({
				at: now(),
				ok: false
			});
			persist();
		},
		tripped() {
			prune();
			return history.filter((r) => !r.ok).length >= opts.limit;
		},
		remaining() {
			prune();
			return Math.max(0, opts.limit - history.filter((r) => !r.ok).length);
		},
		resetAt() {
			prune();
			const oldest = history.filter((r) => !r.ok)[0];
			return oldest ? oldest.at + windowMs : void 0;
		},
		reset() {
			history = [];
			persist();
		}
	};
}
//#endregion
//#region src/presentation/task-cards.ts
/**
* Generate a text-based progress bar, e.g. `[████░░░░░░░░░░░░] 25.0%`.
*/
function renderProgressBar(completed, total, width = 14) {
	if (total <= 0) return "[░░░░░░░░░░░░░░] 0.0%";
	const ratio = Math.min(1, Math.max(0, completed / total));
	const filled = Math.round(ratio * width);
	const empty = width - filled;
	return `\`[${"█".repeat(filled) + "░".repeat(empty)}]\` **${(ratio * 100).toFixed(1)}%** (${completed}/${total})`;
}
/**
* Format todo item lines with appropriate visual badges.
*/
function formatTodoList(todos, isFolded = true, maxFoldItems = 6) {
	if (todos.length === 0) return "*(暂无任务清单)*";
	const formatItem = (t, i) => {
		switch (t.status) {
			case "in_progress": return `🔵 **#${i + 1} ${t.content}** *(进行中)*`;
			case "completed": return `🟢 ~#${i + 1} ${t.content}~`;
			default: return `◌ #${i + 1} ${t.content}`;
		}
	};
	if (!isFolded || todos.length <= maxFoldItems) return todos.map((t, i) => formatItem(t, i)).join("\n");
	const inProgIdx = todos.findIndex((t) => t.status === "in_progress");
	const displayItems = [];
	todos.forEach((t, i) => {
		if (i < 3 || inProgIdx !== -1 && Math.abs(i - inProgIdx) <= 1 || i === todos.length - 1) {
			if (!displayItems.some((d) => d.index === i)) displayItems.push({
				item: t,
				index: i
			});
		}
	});
	displayItems.sort((a, b) => a.index - b.index);
	const lines = [];
	let lastIdx = -1;
	for (const { item, index } of displayItems) {
		if (lastIdx !== -1 && index > lastIdx + 1) {
			const hiddenCount = index - lastIdx - 1;
			lines.push(`*... (已折叠 ${hiddenCount} 项待处理任务) ...*`);
		}
		lines.push(formatItem(item, index));
		lastIdx = index;
	}
	if (lastIdx < todos.length - 1) {
		const hiddenCount = todos.length - 1 - lastIdx;
		lines.push(`*... (还有 ${hiddenCount} 项待处理任务已折叠) ...*`);
	}
	return lines.join("\n");
}
/**
* Main Task & Goal Board Card (Schema 2.0).
* Matches the DSH native task monitor UI shown in user screenshots.
*/
function buildTaskBoardCard(state, opts = {}) {
	const isFolded = opts.isFolded ?? state.isFolded ?? true;
	const todos = state.todos ?? [];
	const inProgressCount = todos.filter((t) => t.status === "in_progress").length;
	const completedCount = todos.filter((t) => t.status === "completed").length;
	const pendingCount = todos.filter((t) => t.status === "pending").length;
	const totalCount = todos.length;
	let template = "blue";
	let statusLabel = "执行中";
	if (state.goal) switch (state.goal.phase) {
		case "complete":
			template = "green";
			statusLabel = "已完成";
			break;
		case "paused":
			template = "yellow";
			statusLabel = "已暂停";
			break;
		case "blocked":
			template = "orange";
			statusLabel = "已阻塞";
			break;
		default:
			template = "blue";
			statusLabel = "执行中";
	}
	else if (totalCount > 0 && completedCount === totalCount) {
		template = "green";
		statusLabel = "已完成";
	}
	const elements = [];
	if (state.goal) {
		elements.push({
			tag: "markdown",
			content: `**🎯 进行中的目标**\n${state.goal.objective}`
		});
		if (state.goal.phase === "blocked" && state.goal.blockedReason) elements.push({
			tag: "markdown",
			content: `> ⚠️ **阻塞原因**: \`${state.goal.blockedReason.code}\` - ${state.goal.blockedReason.message}`
		});
		const wsDisplay = state.workspacePath ? state.workspacePath.split("/").filter(Boolean).pop() ?? state.workspacePath : "默认工作区";
		elements.push({
			tag: "column_set",
			flex_mode: "flow",
			background_style: "grey",
			columns: [
				{
					tag: "column",
					width: "weighted",
					weight: 1,
					elements: [{
						tag: "markdown",
						content: `📁 **工作区**\n\`${wsDisplay}\``
					}]
				},
				{
					tag: "column",
					width: "weighted",
					weight: 1,
					elements: [{
						tag: "markdown",
						content: `🔄 **执行轮次**\n\`${state.goal.roundsStarted}\` / ${state.goal.maxGoalRounds}`
					}]
				},
				{
					tag: "column",
					width: "weighted",
					weight: 1,
					elements: [{
						tag: "markdown",
						content: `📊 **总进度**\n${totalCount > 0 ? `${Math.round(completedCount / totalCount * 100)}%` : "0%"}`
					}]
				}
			]
		});
		elements.push({ tag: "hr" });
	}
	elements.push({
		tag: "markdown",
		content: [`**📊 任务总览** ⚡ ${inProgressCount} 进行中 · ⏳ ${pendingCount} 待处理 · ✅ ${completedCount} 已完成`, renderProgressBar(completedCount, totalCount)].join("\n")
	});
	elements.push({
		tag: "markdown",
		content: `**📋 任务执行清单**:\n\n${formatTodoList(todos, isFolded)}`
	});
	elements.push({ tag: "hr" });
	const actionCols = [];
	if (state.goal?.phase === "paused") actionCols.push({
		tag: "column",
		width: "weighted",
		weight: 1,
		elements: [button("▶️ 恢复执行", {
			op: "goal:resume",
			goalId: state.goal.id,
			revision: state.goal.revision
		}, "primary")]
	});
	else if (state.goal?.phase === "active" || !state.goal && inProgressCount > 0) actionCols.push({
		tag: "column",
		width: "weighted",
		weight: 1,
		elements: [button("⏸ 暂停目标", {
			op: "goal:pause",
			goalId: state.goal?.id,
			revision: state.goal?.revision
		})]
	});
	actionCols.push({
		tag: "column",
		width: "weighted",
		weight: 1,
		elements: [button("🛑 终止任务", {
			op: "goal:clear",
			goalId: state.goal?.id,
			revision: state.goal?.revision
		}, "danger")]
	});
	if (totalCount > 6) actionCols.push({
		tag: "column",
		width: "weighted",
		weight: 1,
		elements: [button(isFolded ? "📋 展开详情" : "🔼 收起列表", {
			op: "task:toggle_fold",
			folded: !isFolded
		})]
	});
	elements.push({
		tag: "column_set",
		flex_mode: "flow",
		columns: actionCols
	});
	return {
		schema: "2.0",
		config: {
			update_multi: true,
			streaming_mode: false
		},
		header: {
			title: {
				tag: "plain_text",
				content: `🎯 DSH 任务看板 · ${statusLabel} (${completedCount}/${totalCount})`
			},
			subtitle: {
				tag: "plain_text",
				content: `${inProgressCount} 进行中 · ${pendingCount} 待处理 · ${completedCount} 已完成`
			},
			template
		},
		body: { elements }
	};
}
/**
* Briefing card sent when an agent session is restored via `/resume`.
*/
function buildSessionResumedCard(briefing) {
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "🔄 已恢复历史会话"
			},
			template: "blue"
		},
		body: { elements: [{
			tag: "markdown",
			content: `**工作区**: \`${briefing.workspacePath ?? "默认"}\`${briefing.preset ? ` · **模式**: \`${briefing.preset}\`` : ""}`
		}, {
			tag: "markdown",
			content: "💡 **会话已恢复**，直接发送消息即可继续对话。"
		}] }
	};
}
//#endregion
//#region src/presentation/cards.ts
/**
* schema 2.0 按钮：直接作为组件放 elements（平铺、宽度完整不缩略）；
* 交互回传用 behaviors:[{type:"callback",value}]（card.action.trigger 回调返回 value）。
*/
function button(text, value, style) {
	const b = {
		tag: "button",
		width: "fill",
		text: {
			tag: "plain_text",
			content: text
		},
		behaviors: [{
			type: "callback",
			value
		}]
	};
	if (style === "primary") b.type = "primary";
	if (style === "danger") b.type = "danger";
	return b;
}
/**
* Heuristic: does this reply carry markdown worth rendering as a card?
* Matches headings, lists, fenced code, blockquotes, bold, tables and
* paragraph breaks (pi-feishu-link rich-text mode selection).
*/
function looksLikeMarkdown(text) {
	const t = text.trim();
	if (!t) return false;
	if (/(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s|\*\*|\|.*\|)/.test(t) || t.includes("\n\n")) return true;
	return false;
}
function markdownCard(markdown, opts = {}) {
	return {
		schema: "2.0",
		...opts.header ? { header: {
			title: {
				tag: "plain_text",
				content: opts.header
			},
			template: opts.accent ? "blue" : "grey"
		} } : {},
		body: { elements: [{
			tag: "markdown",
			content: markdown
		}] }
	};
}
/**
* Agent preset options (DSH agent-presets).
*
* `AGENT_PRESETS` is the FALLBACK roster — the four shipped presets — used
* when the live DSH agentPresets service is unreachable. When the service is
* up, the bridge renders the dynamic roster (shipped + user-authored) instead;
* see the DshSessionBackend.listPresets surface.
*/
const AGENT_PRESETS = [
	{
		id: "standard",
		label: "标准模式",
		desc: "全能：文件/Shell/检索/Skills/目标/子代理/工作流",
		trust: "system"
	},
	{
		id: "ptc",
		label: "PTC 模式",
		desc: "标准能力 + Code Mode（多步操作一次执行，更快）",
		trust: "system"
	},
	{
		id: "minimal",
		label: "极简模式",
		desc: "仅 bash + 文件编辑，轻量省 token",
		trust: "system"
	},
	{
		id: "cordis",
		label: "创造模式",
		desc: "标准能力 + preset 创作工具（面向开发者）",
		trust: "system"
	}
];
/** Permission preset options (dsh-permission-presets). */
const PERMISSION_PRESETS = [
	{
		id: "read-only",
		label: "只读",
		desc: "沙箱只读，危险操作需审批"
	},
	{
		id: "workspace-write",
		label: "工作区写",
		desc: "仅工作区可写，危险操作需审批"
	},
	{
		id: "danger-full-access",
		label: "Full access",
		desc: "全访问 + 审批 never（默认）"
	}
];
/** Append action buttons to a markdown card's body. */
function withButtons(card, buttons) {
	const c = card;
	return {
		...c,
		body: {
			...c.body ?? {},
			elements: [...c.body?.elements ?? [], ...buttons]
		}
	};
}
/**
* Intent-confirmation card (DSH ask_user_question → Feishu).
*
* Single-select (default): one button per option, answered immediately via op
* "uqa:<questionId>:<optionIndex>".
*
* Multi-select (multiSelect === true): a form_container with a
* multi_select_static dropdown; the user taps 提交 and the onSubmit callback
* returns action.formValue.answer (string[] of option indexes) via op
* "uqam:<questionId>".
*
* The footer always invites a plain-text reply as a custom answer.
*/
function questionCard(q) {
	const header = q.header ? { header: {
		title: {
			tag: "plain_text",
			content: q.header
		},
		template: "blue"
	} } : {};
	if (q.multiSelect) {
		const options = (q.options ?? []).map((o, i) => ({
			text: {
				tag: "plain_text",
				content: o.label
			},
			value: String(i)
		}));
		return {
			schema: "2.0",
			...header,
			body: { elements: [
				{
					tag: "markdown",
					content: q.question
				},
				...q.detail ? [{
					tag: "markdown",
					content: q.detail
				}] : [],
				{
					tag: "form_container",
					children: [{
						tag: "multi_select_static",
						name: "answer",
						placeholder: {
							tag: "plain_text",
							content: "请选择（可多选）…"
						},
						options
					}],
					onSubmit: [{
						type: "callback",
						value: { op: `uqam:${q.id}` }
					}]
				},
				{
					tag: "markdown",
					content: "或直接发消息输入自定义答案"
				}
			] }
		};
	}
	const elements = [{
		tag: "markdown",
		content: q.question
	}, ...q.detail ? [{
		tag: "markdown",
		content: q.detail
	}] : []];
	(q.options ?? []).forEach((o, i) => {
		elements.push(button(o.label, { op: `uqa:${q.id}:${i}` }));
	});
	elements.push({
		tag: "markdown",
		content: "或直接发消息输入自定义答案"
	});
	return {
		schema: "2.0",
		...header,
		body: { elements }
	};
}
/** Single-select mode picker card — tap a button to switch (no typing). */
function modeCard(current, presets) {
	return markdownCard([
		"**Agent 模式**（单选，点按钮即切换，下条消息生效）",
		"",
		...(presets && presets.length > 0 ? presets : AGENT_PRESETS).map((p) => `- ${p.label}${p.trust === "user" ? "（自定义）" : ""}${current === p.id ? " ← 当前" : ""}：${p.desc ?? p.id}${p.broken ? `（不可用：${p.broken}）` : ""}`)
	].join("\n"), {
		header: "切换模式",
		accent: true
	});
}
/** Model picker card grouped by provider: provider header + one button per model. */
function modelCard(current, groups) {
	const elements = [{
		tag: "markdown",
		content: `**当前模型**: ${current?.provider ?? "?"}/${current?.model ?? "未设置"}`
	}, {
		tag: "markdown",
		content: "**按供应商选择模型**（点按钮即切换，下条消息生效）"
	}];
	let first = true;
	for (const g of groups) {
		if (g.models.length === 0) continue;
		if (!first) elements.push({ tag: "hr" });
		first = false;
		elements.push({
			tag: "markdown",
			content: `**${g.label ?? g.provider}**`
		});
		for (const m of g.models) elements.push({
			tag: "button",
			width: "fill",
			text: {
				tag: "plain_text",
				content: m.name ?? m.id
			},
			behaviors: [{
				type: "callback",
				value: { op: `model:${g.provider}/${m.id}` }
			}]
		});
	}
	if (first) elements.push({
		tag: "markdown",
		content: "（无可用模型列表）"
	});
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "切换模型"
			},
			template: "blue"
		},
		body: { elements }
	};
}
/** Single-select permission picker card. */
function permissionCard(current) {
	return markdownCard([
		"**权限模式**（单选，点按钮即切换）",
		"",
		...PERMISSION_PRESETS.map((p) => `- ${p.label}${current === p.id ? " ← 当前" : ""}：${p.desc}`)
	].join("\n"), {
		header: "切换权限",
		accent: true
	});
}
/**
* Workspace history picker card (/resume): one button per historical session
* of the CURRENT workspace (newest first).
*
* User-friendliness decisions:
* - Relative times (5 分钟前 / 3 天前) instead of raw timestamps.
* - Stored preset badge per row; the CURRENT session is listed too but its
*   button is disabled (users see where they are).
* - Button op carries the session id URI-ENCODED — the card-action dispatcher
*   splits op at the FIRST ":" and lark-plus session ids are full of colons
*   (`lark-plus:dm:oc_x:nonce:0`); an unencoded id would lose its prefix and
*   the click would resolve to 未找到会话.
*/
function resumeCard(sessions, currentSessionId, opts = {}) {
	const now = opts.now ?? Date.now;
	const rel = (ts) => {
		const d = Math.max(0, now() - ts);
		const m = Math.floor(d / 6e4);
		if (m < 1) return "刚刚";
		if (m < 60) return `${m} 分钟前`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h} 小时前`;
		const day = Math.floor(h / 24);
		if (day < 30) return `${day} 天前`;
		return new Date(ts).toLocaleDateString("zh-CN");
	};
	const elements = [{
		tag: "markdown",
		content: "**恢复历史会话**（点按钮即恢复；或直接回复 `/resume <序号>`）"
	}];
	let n = 0;
	sessions.forEach((s) => {
		const isCurrent = s.id === currentSessionId;
		const titlePart = s.title ? s.title.slice(0, 32) : "会话";
		const btn = button(isCurrent ? `当前会话: ${titlePart}（${rel(s.createdAt)}）` : `#${++n} ${titlePart}（${rel(s.createdAt)}）`, { op: `resume:${encodeURIComponent(s.id)}` });
		if (isCurrent) btn.disabled = true;
		elements.push(btn);
	});
	if (currentSessionId && !sessions.some((s) => s.id === currentSessionId)) elements.push({
		tag: "markdown",
		content: `- 当前会话：刚刚开始（发消息即在此会话继续）`
	});
	if (sessions.length === 0) elements.push({
		tag: "markdown",
		content: "（该工作区暂无历史会话日志）"
	});
	elements.push({
		tag: "markdown",
		content: [
			"———",
			"💡 恢复后**下一条消息接续历史上下文**；此前的会话仍然保留，随时可再 `/resume` 切回。",
			"新起会话用 `/new`；换工作区用 `/workspace <路径>`。"
		].join("\n")
	});
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "恢复历史会话"
			},
			template: "blue"
		},
		body: { elements }
	};
}
function helpCard() {
	return markdownCard([
		"**可用命令**（点按钮或直接输入）",
		"",
		"- `/status` 桥接状态",
		"- `/mode` 切换 Agent 模式（标准/PTC/极简/创造）",
		"- `/permission` 切换权限（只读/工作区写/Full access）",
		"- `/new` 当前工作区新起会话",
		"- `/resume` 恢复当前工作区的历史会话",
		"- `/workspace <路径>` 切换工作区（`~` 可用）",
		"- `/stop` 停止当前会话任务",
		"- `/doctor` 生成诊断包（含 session log）",
		"- `/model` 查看/切换模型",
		"- `/lark-config k=v` 热改配置（嵌套键如 `streaming.enabled=true`）",
		"- `/lark setup|start|stop|status` 桥接管理",
		"- `/goal` 等 DSH 命令原样执行",
		"- skill 无需前缀：直接说任务（如「用 X skill 做 Y」）"
	].join("\n"), {
		header: "Lark Link 帮助",
		accent: true
	});
}
/** Command panel card with one-click buttons. */
function commandPanelCard() {
	return {
		schema: "2.0",
		body: {
			header: {
				title: {
					tag: "plain_text",
					content: "命令面板"
				},
				template: "blue"
			},
			elements: [
				{
					tag: "markdown",
					content: "**命令面板**\n点击按钮一键执行，或直接输入文字聊天："
				},
				...commandPanelButtons(),
				{
					tag: "markdown",
					content: "文本命令：`/status` `/new` `/sessions` `/resume` `/mode` `/permission` `/workspace` `/stop` `/doctor` `/help`\n\n`/goal` 等 DSH 命令原样执行；skill 无需前缀，直接描述任务即可。"
				}
			]
		}
	};
}
/**
* Buttons of the command panel: BARE command names as ops — the card-action
* dispatcher forwards unhandled ops to the bridge handler, so a tap is
* identical to typing the command. This is what makes the commands
* discoverable without configuring Feishu's own per-application "/" menu.
*/
function commandPanelButtons() {
	return [
		button("桥接状态", { op: "status" }),
		button("新会话", { op: "new" }),
		button("历史会话", { op: "sessions" }),
		button("停止任务", { op: "stop" }),
		button("模式", { op: "mode" }),
		button("权限", { op: "permission" }),
		button("模型", { op: "model" }),
		button("诊断包", { op: "doctor" }),
		button("配置", { op: "lark-config" }),
		button("帮助", { op: "help" })
	];
}
/**
* The "where am I" block /status appends: the CURRENT session of this chat,
* its workspace/mode/model, and how to move to another one. Until now only
* the Web UI could answer that question.
*/
function sessionStatusBlock(info) {
	const out = ["**当前会话**"];
	out.push("- 会话 ID：`" + (info.sessionId ?? "（尚未建立，下一条消息创建）") + "`");
	if (info.title) out.push("- 标题：" + info.title.slice(0, 48));
	if (info.workspace) out.push("- 工作区：" + info.workspace);
	if (info.preset) out.push("- 模式：" + info.preset);
	if (info.model) out.push("- 模型：" + info.model);
	out.push("- 切换会话：`/sessions` 看历史（点按钮或 `/resume <序号>`）；新起一条：`/new`。");
	return out.join("\n");
}
//#endregion
//#region src/outbound/task-card-syncer.ts
function createTaskCardSyncer(opts) {
	const states = /* @__PURE__ */ new Map();
	const timers = /* @__PURE__ */ new Map();
	const inFlight = /* @__PURE__ */ new Set();
	const debounceMs = opts.debounceMs ?? 1500;
	const now = opts.now ?? Date.now;
	const ensureState = (sessionKey, workspacePath) => {
		let st = states.get(sessionKey);
		if (!st) {
			st = {
				sessionKey,
				sequence: 0,
				todos: [],
				workspacePath,
				isFolded: true,
				lastUpdatedAt: now()
			};
			states.set(sessionKey, st);
		}
		if (workspacePath) st.workspacePath = workspacePath;
		return st;
	};
	const extractCardId = (res) => res?.card_id ?? res?.data?.card_id;
	async function pushCard(sessionKey) {
		const st = states.get(sessionKey);
		if (!st) return;
		const timer = timers.get(sessionKey);
		if (timer) {
			clearTimeout(timer);
			timers.delete(sessionKey);
		}
		if (inFlight.has(sessionKey)) {
			scheduleDebounce(sessionKey);
			return;
		}
		inFlight.add(sessionKey);
		st.lastUpdatedAt = now();
		try {
			const cardPayload = buildTaskBoardCard(st);
			const cardJsonStr = JSON.stringify(cardPayload);
			if (!st.cardEntityId) {
				const createRes = await opts.api.createCard({
					type: "card_json",
					data: cardJsonStr
				});
				const cardId = extractCardId(createRes);
				if (!cardId) throw new Error("TaskCard create returned no card_id");
				st.cardEntityId = cardId;
				st.sequence = 1;
				if (opts.deliverCard && opts.routeFor) {
					const route = opts.routeFor(sessionKey);
					if (route?.chatId) await opts.deliverCard({
						chatId: route.chatId,
						cardId
					});
				} else await opts.api.deliverCard(cardId);
			} else {
				st.sequence += 1;
				await opts.api.updateCard(st.cardEntityId, {
					card: {
						type: "card_json",
						data: cardJsonStr
					},
					sequence: st.sequence,
					uuid: randomUUID()
				});
			}
		} catch (err) {
			opts.onError?.(err);
		} finally {
			inFlight.delete(sessionKey);
		}
	}
	function scheduleDebounce(sessionKey) {
		if (timers.has(sessionKey)) return;
		const timer = setTimeout(() => {
			timers.delete(sessionKey);
			pushCard(sessionKey);
		}, debounceMs);
		timers.set(sessionKey, timer);
	}
	async function updateGoal(sessionKey, goal, workspacePath) {
		const st = ensureState(sessionKey, workspacePath);
		st.goal = goal;
		if (goal.phase === "complete" || !st.cardEntityId) await pushCard(sessionKey);
		else scheduleDebounce(sessionKey);
	}
	async function updateTodos(sessionKey, todos, workspacePath) {
		const st = ensureState(sessionKey, workspacePath);
		st.todos = todos;
		const allCompleted = todos.length > 0 && todos.every((t) => t.status === "completed");
		if (!st.cardEntityId || allCompleted) await pushCard(sessionKey);
		else scheduleDebounce(sessionKey);
	}
	async function toggleFold(sessionKey, isFolded) {
		const st = states.get(sessionKey);
		if (!st) return;
		st.isFolded = isFolded ?? !st.isFolded;
		await pushCard(sessionKey);
	}
	function getState(sessionKey) {
		return states.get(sessionKey);
	}
	async function flush(sessionKey) {
		const timer = timers.get(sessionKey);
		if (timer) {
			clearTimeout(timer);
			timers.delete(sessionKey);
		}
		await pushCard(sessionKey);
	}
	function disposeSession(sessionKey) {
		const timer = timers.get(sessionKey);
		if (timer) {
			clearTimeout(timer);
			timers.delete(sessionKey);
		}
		states.delete(sessionKey);
		inFlight.delete(sessionKey);
	}
	return {
		updateGoal,
		updateTodos,
		toggleFold,
		getState,
		flush,
		disposeSession
	};
}
//#endregion
//#region src/host/lark-client.ts
/**
* Keep only the fields worth persisting. The registration service omits
* fields it has no value for, and `user_info` itself is optional, so an
* all-empty payload normalizes to undefined instead of an empty object.
*/
function normalizeUserInfo(raw) {
	if (!raw) return void 0;
	const out = {};
	if (typeof raw.open_id === "string" && raw.open_id !== "") out.open_id = raw.open_id;
	if (raw.tenant_brand === "feishu" || raw.tenant_brand === "lark") out.tenant_brand = raw.tenant_brand;
	return out.open_id !== void 0 || out.tenant_brand !== void 0 ? out : void 0;
}
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
function isValidRef(ref) {
	return REF_PATTERN.test(ref);
}
/** Parse the stored JSON blob into credentials; undefined if absent/malformed. */
function parseCredentials(raw) {
	if (!raw) return void 0;
	try {
		const parsed = JSON.parse(raw);
		if (parsed.appId && parsed.appSecret) {
			const out = {
				appId: parsed.appId,
				appSecret: parsed.appSecret,
				domain: parsed.domain === "lark" ? "lark" : "feishu"
			};
			const userInfo = normalizeUserInfo(parsed.userInfo);
			if (userInfo) out.userInfo = userInfo;
			return out;
		}
	} catch {}
}
async function resolveCredentials(store, ref) {
	return parseCredentials((await store.resolve(ref))?.value);
}
async function persistCredentials(store, ref, creds) {
	if (!isValidRef(ref)) throw new TypeError(`credential ref "${ref}" must match ${String(REF_PATTERN)}`);
	await store.set(ref, JSON.stringify(creds));
}
async function clearCredentials(store, ref) {
	await store.unset(ref);
}
/** Default loader: dynamic import of the real SDK (kept out of test paths). */
const defaultSdkLoader = async () => await import("@larksuiteoapi/node-sdk");
/**
* Build a FeishuClientLike backed by the real SDK. Event handlers attach via
* `.on()` (forwarded to the EventDispatcher); `ws.start()` boots the WSClient
* with that dispatcher; send/probe/upload calls translate to SDK shapes.
*/
async function buildLarkClient(opts) {
	const sdk = await (opts.sdkLoader ?? defaultSdkLoader)();
	const domain = opts.domain === "lark" ? sdk.Domain.Lark : sdk.Domain.Feishu;
	const dh = sdk.defaultHttpInstance;
	if (dh?.defaults) dh.defaults.proxy = false;
	const clientOpts = {
		appId: opts.appId,
		appSecret: opts.appSecret,
		appType: sdk.AppType.SelfBuild,
		domain,
		loggerLevel: sdk.LoggerLevel.error
	};
	const sdkClient = new sdk.Client(clientOpts);
	const dispatcher = new sdk.EventDispatcher({ loggerLevel: sdk.LoggerLevel.error });
	const wsClient = new sdk.WSClient(clientOpts);
	return {
		on(event, handler) {
			dispatcher.register({ [event]: handler });
		},
		ws: {
			start() {
				try {
					wsClient.start({ eventDispatcher: dispatcher });
				} catch (err) {
					opts.logger?.error(`wsClient.start failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			},
			stop() {
				Promise.resolve(wsClient.stop?.()).catch(() => void 0);
			}
		},
		async getBotInfo() {
			const res = await sdkClient.request({
				url: "/open-apis/bot/v3/info",
				method: "GET"
			});
			const bot = res?.bot ?? (res?.data)?.bot;
			return {
				open_id: bot?.open_id ?? (res?.data)?.open_id,
				name: bot?.app_name
			};
		},
		async sendMessage(params) {
			const p = params;
			return sdkClient.im.message.create({
				params: { receive_id_type: p.receive_id_type },
				data: p.params
			});
		},
		async addReaction(params) {
			const p = params;
			return sdkClient.im.messageReaction.create({
				path: { message_id: p.message_id },
				data: { reaction_type: { emoji_type: p.emoji_type } }
			});
		},
		async listMessages(params) {
			const p = params;
			const res = await sdkClient.im.message.list({ params: {
				...p,
				page_size: 50
			} });
			return { items: (res?.items ?? (res?.data)?.items ?? []).map((i) => ({
				message_id: i.message_id,
				create_time: i.create_time
			})) };
		},
		async uploadFile(params) {
			const p = params;
			const fileType = {
				pdf: "pdf",
				doc: "doc",
				docx: "doc",
				xls: "xls",
				xlsx: "xls",
				ppt: "ppt",
				pptx: "ppt",
				mp4: "mp4",
				opus: "opus"
			}[(p.file_name ?? "").split(".").pop()?.toLowerCase() ?? ""] ?? "stream";
			return sdkClient.im.file.create({ data: {
				file_type: fileType,
				file_name: p.file_name ?? "file",
				file: p.file
			} });
		},
		async uploadImage(params) {
			const p = params;
			return sdkClient.im.image.create({ data: {
				image_type: "message",
				image: p.image
			} });
		},
		async downloadResource(params) {
			const p = params;
			const mr = sdkClient.im?.messageResource;
			let stream;
			if (mr?.get) stream = (await mr.get({
				path: {
					message_id: p.messageId,
					file_key: p.fileKey
				},
				params: { type: p.type }
			}))?.getReadableStream?.();
			else {
				const res = await sdkClient.request({
					url: `/open-apis/im/v1/messages/${p.messageId}/resources/${p.fileKey}`,
					method: "GET",
					params: { type: p.type },
					responseType: "stream"
				});
				stream = res?.getReadableStream?.() ?? res?.data;
			}
			if (!stream) throw new Error(`downloadResource: no stream for ${p.fileKey}`);
			const chunks = [];
			for await (const chunk of stream) chunks.push(Buffer.from(chunk));
			return Buffer.concat(chunks);
		},
		async cardkitCreateCard(payload) {
			return await sdkClient.request({
				url: "/open-apis/cardkit/v1/cards",
				method: "POST",
				data: payload
			});
		},
		async cardkitDeliverCard(params) {
			const p = params;
			return sdkClient.im.message.create({
				params: { receive_id_type: p.chatId.startsWith("oc_") ? "chat_id" : "open_id" },
				data: {
					receive_id: p.chatId,
					msg_type: "interactive",
					content: JSON.stringify({
						type: "card",
						data: { card_id: p.cardId }
					})
				}
			});
		},
		async cardkitStreamText(cardId, elementId, body) {
			return sdkClient.request({
				url: `/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`,
				method: "PUT",
				data: body
			});
		},
		async cardkitPatchSettings(cardId, body) {
			return sdkClient.request({
				url: `/open-apis/cardkit/v1/cards/${cardId}/settings`,
				method: "PATCH",
				data: body
			});
		},
		async cardkitUpdateCard(cardId, body) {
			return sdkClient.request({
				url: `/open-apis/cardkit/v1/cards/${cardId}`,
				method: "PUT",
				data: body
			});
		}
	};
}
//#endregion
//#region src/host/auth-setup.ts
/** Bridge-required event subscription: message arrival. */
const REQUIRED_EVENT = "im.message.receive_v1";
/** Bridge-dependent permission scopes (message + group-all + reactions). */
const SETUP_SCOPES = [
	"im:message",
	"im:message.send_as_bot",
	"im:chat",
	"im:resource",
	"im:message.group_msg",
	"im:message.reactions:write_only",
	"contact:user.base:readonly"
];
/** Pure function — unit-testable addon builder. */
function buildSetupAddons() {
	return {
		scopes: { tenant: [...SETUP_SCOPES] },
		events: { items: { tenant: [REQUIRED_EVENT] } },
		callbacks: { items: ["card.action.trigger"] }
	};
}
/** Detect Lark (international) vs Feishu (China) from the registerApp result. */
function detectDomain(userInfo) {
	return userInfo?.tenant_brand === "lark" ? "lark" : "feishu";
}
function createAuthSetup(deps) {
	return { async run(opts) {
		opts.onStatusChange?.("创建应用中…");
		const created = await deps.registerApp({
			source: "dsh-lark-plus",
			addons: buildSetupAddons(),
			onQRCodeReady: (info) => opts.onQRCodeReady(info),
			onStatusChange: (info) => opts.onStatusChange?.(info.status ?? "…")
		});
		const appId = created.client_id ?? "";
		const appSecret = created.client_secret ?? "";
		if (!appId || !appSecret) throw new Error("registerApp 未返回 client_id/client_secret");
		const domain = detectDomain(created.user_info);
		const userInfo = normalizeUserInfo(created.user_info);
		opts.onStatusChange?.("校验事件订阅…");
		const result = userInfo ? {
			appId,
			appSecret,
			domain,
			userInfo
		} : {
			appId,
			appSecret,
			domain
		};
		await deps.persist(result);
		opts.onStatusChange?.("完成 ✅");
		return result;
	} };
}
/** base64url(gzip(addons)) — matches the SDK's encodeAddons encoding. */
function encodeAddons(addons) {
	const json = JSON.stringify(addons);
	return gzipSync(Buffer.from(json, "utf8")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function postForm(url, params, signal) {
	let res;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
				"User-Agent": "dsh-lark-plus (device-code client)"
			},
			body: new URLSearchParams(params).toString(),
			signal
		});
	} catch (err) {
		throw new Error(`registration request failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	let data;
	try {
		data = await res.json();
	} catch {
		data = {};
	}
	if (!res.ok && !data.error) throw new Error(`registration request failed: HTTP ${res.status}`);
	return data;
}
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(/* @__PURE__ */ new Error("Registration was aborted"));
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			cleanup();
			reject(/* @__PURE__ */ new Error("Registration was aborted"));
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
/**
* registerApp implementation over global fetch. Wire protocol mirrors
* @larksuiteoapi/node-sdk's registerApp (device-code flow against
* accounts.feishu.cn / accounts.larksuite.com), so the QR and created-app
* payload are byte-compatible with the SDK path.
*/
function registerAppWithFetch() {
	return async (options) => {
		const { source, signal, onQRCodeReady, onStatusChange, addons } = options;
		const baseUrl = "https://accounts.feishu.cn";
		const larkBaseUrl = "https://accounts.larksuite.com";
		const endpoint = "/oauth/v1/app/registration";
		const beginRes = await postForm(baseUrl + endpoint, {
			action: "begin",
			archetype: "PersonalAgent",
			auth_method: "client_secret",
			request_user_info: "open_id"
		}, signal);
		const verificationUri = beginRes.verification_uri_complete;
		if (typeof verificationUri !== "string" || verificationUri === "") throw new Error(beginRes.error_description ?? "registerApp begin 未返回 verification_uri_complete");
		let qrUrl;
		try {
			qrUrl = new URL(verificationUri);
		} catch {
			throw new Error(`registerApp begin 返回了无效的 verification_uri_complete: ${verificationUri.slice(0, 80)}`);
		}
		qrUrl.searchParams.set("from", "sdk");
		qrUrl.searchParams.set("source", `node-sdk/${source}`);
		qrUrl.searchParams.set("tp", "sdk");
		if (addons) qrUrl.searchParams.set("addons", encodeAddons(addons));
		onQRCodeReady({
			url: qrUrl.toString(),
			expireIn: beginRes.expires_in ?? 600
		});
		const deviceCode = beginRes.device_code;
		if (!deviceCode) throw new Error("registerApp begin 未返回 device_code");
		let currentBase = baseUrl;
		let interval = (beginRes.interval ?? 5) * 1e3;
		const deadline = Date.now() + (beginRes.expires_in ?? 600) * 1e3;
		let domainSwitched = false;
		while (Date.now() < deadline) {
			if (signal?.aborted) throw new Error("Registration was aborted");
			const pollRes = await postForm(currentBase + endpoint, {
				action: "poll",
				device_code: deviceCode
			}, signal);
			const userInfo = pollRes.user_info;
			if (userInfo?.tenant_brand === "lark" && !domainSwitched) {
				currentBase = larkBaseUrl;
				domainSwitched = true;
				onStatusChange?.({ status: "domain_switched" });
				continue;
			}
			const clientId = pollRes.client_id;
			const clientSecret = pollRes.client_secret;
			if (clientId && clientSecret) return {
				client_id: clientId,
				client_secret: clientSecret,
				user_info: userInfo
			};
			switch (pollRes.error) {
				case "authorization_pending":
					onStatusChange?.({ status: "polling" });
					break;
				case "slow_down":
					interval += 5e3;
					onStatusChange?.({
						status: "slow_down",
						interval: interval / 1e3
					});
					break;
				case "access_denied":
				case "expired_token": throw new Error(pollRes.error_description ?? `注册失败：${String(pollRes.error)}`);
				default: if (pollRes.error) throw new Error(pollRes.error_description ?? `注册失败：${String(pollRes.error)}`);
			}
			await sleep(interval, signal);
		}
		throw new Error("注册轮询超时（二维码已过期），请重新运行 /lark setup");
	};
}
//#endregion
//#region src/host/voice-audio-route.ts
/** Extension → Content-Type. Persisted Feishu clips are .ogg (or .bin). */
const VOICE_AUDIO_TYPES = {
	".ogg": "audio/ogg",
	".oga": "audio/ogg",
	".opus": "audio/ogg",
	".bin": "audio/ogg",
	".wav": "audio/wav",
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".flac": "audio/flac"
};
/**
* Resolve one requested clip inside mediaDir, or undefined when the name is not
* a bare, whitelisted audio file name that exists there.
*/
function voiceAudioFile(name, mediaDir) {
	if (name === "" || name === "." || name === "..") return void 0;
	if (name.includes("/") || name.includes("\\") || name.includes("\0")) return void 0;
	if (basename(name) !== name) return void 0;
	const dot = name.lastIndexOf(".");
	if (dot < 0) return void 0;
	if (VOICE_AUDIO_TYPES[name.slice(dot).toLowerCase()] === void 0) return void 0;
	const file = join(mediaDir, name);
	try {
		return existsSync(file) && statSync(file).isFile() ? file : void 0;
	} catch {
		return;
	}
}
/** GET/HEAD one clip, with Range support so the player can seek. */
function voiceAudioRoute(req, res, mediaDir) {
	const deny = (code, message) => {
		try {
			res.writeHead(code, {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "no-store"
			});
			res.end(message);
		} catch {}
	};
	const method = req.method ?? "GET";
	if (method !== "GET" && method !== "HEAD") return deny(405, "GET only");
	let name = "";
	try {
		name = new URL(req.url ?? "/", "http://dsh.internal").searchParams.get("name") ?? "";
	} catch {
		return deny(400, "bad url");
	}
	const file = voiceAudioFile(name, mediaDir);
	if (file === void 0) return deny(404, "voice audio not found");
	let size = 0;
	try {
		size = statSync(file).size;
	} catch {
		return deny(404, "voice audio unreadable");
	}
	const type = VOICE_AUDIO_TYPES[file.slice(file.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";
	let start = 0;
	let end = size - 1;
	let code = 200;
	const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers?.range ?? "").trim());
	if (range !== null) {
		const rawStart = range[1] ?? "";
		const rawEnd = range[2] ?? "";
		if (rawStart === "" && rawEnd === "") return deny(416, "bad range");
		if (rawStart === "") {
			const tail = Number(rawEnd);
			if (!Number.isFinite(tail) || tail <= 0) return deny(416, "bad range");
			start = Math.max(0, size - tail);
		} else {
			start = Number(rawStart);
			if (rawEnd !== "") end = Math.min(size - 1, Number(rawEnd));
		}
		if (!Number.isFinite(start) || start < 0 || start >= size || end < start) return deny(416, "bad range");
		code = 206;
	}
	let body;
	try {
		body = readFileSync(file).subarray(start, end + 1);
	} catch {
		return deny(404, "voice audio unreadable");
	}
	const headers = {
		"Content-Type": type,
		"Content-Length": String(body.byteLength),
		"Accept-Ranges": "bytes",
		"Cache-Control": "no-store"
	};
	if (code === 206) headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
	try {
		res.writeHead(code, headers);
		res.end(method === "HEAD" ? void 0 : body);
	} catch {}
}
//#endregion
//#region src/common/paths.ts
/** True for a path that is absolute on the CURRENT platform OR Windows-shaped
* (drive letter / UNC) — a superset check so drive paths never get joined
* under a Unix cwd (GH #7). */
function isAbsoluteAny(p) {
	return isAbsolute(p) || win32.isAbsolute(p);
}
/**
* Resolve a /workspace argument against the current workspace (GH #7).
* - `~` / `~/…` expands to the user's home directory
* - absolute (posix OR windows drive/UNC) stays verbatim (normalized)
* - anything else joins onto curWs
*/
function resolveWorkspaceTarget(arg, curWs) {
	const expanded = arg === "~" || arg.startsWith("~/") ? join(homedir(), arg.slice(arg.startsWith("~/") ? 2 : 1)) : arg;
	if (!isAbsoluteAny(expanded)) return resolve(join(curWs, expanded));
	if (win32.isAbsolute(expanded) && !isAbsolute(expanded)) return win32.normalize(expanded);
	return resolve(expanded);
}
/**
* Resolve a file path for the lark_send_local_file tool and check that it
* stays inside the workspace root (GH #7).
* Returns { abs, ok } — ok=false means the path escapes the workspace and
* must be rejected (拒绝: 路径不在工作区内).
*/
function resolveInWorkspacePath(p, root) {
	const abs = isAbsoluteAny(p) ? resolveWorkspaceTarget(p, root) : resolve(join(root, p));
	const rel = win32.isAbsolute(root) || win32.isAbsolute(abs) ? win32.relative(root, abs) : relative(root, abs);
	return {
		abs,
		ok: rel === "" || !rel.startsWith("..") && !isAbsolute(rel) && !win32.isAbsolute(rel)
	};
}
//#endregion
//#region src/voice/wav.ts
/** SenseVoice wants 16 kHz. */
const DEFAULT_TARGET_SAMPLE_RATE = 16e3;
/** Read one byte, 0 when past the end (keeps the parser total without casts). */
function byteAt(bytes, offset) {
	return bytes[offset] ?? 0;
}
/**
* Decode a WAV buffer into mono float samples at \`targetSampleRate\`.
* @param input - WAV bytes (Buffer, Uint8Array or any typed-array view).
* @param targetSampleRate - rate to resample to when the file disagrees.
* @returns mono samples and the sample rate they are at.
* @throws Error when the container or the PCM format is unsupported.
*/
function readWavSamples(input, targetSampleRate = DEFAULT_TARGET_SAMPLE_RATE) {
	const bytes = input;
	if (bytes.byteLength === 0) return {
		samples: /* @__PURE__ */ new Float32Array(0),
		sampleRate: targetSampleRate
	};
	if (bytes.byteLength < 12) throw new Error("WAV 数据过短，无法解析");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const tag = (offset) => String.fromCharCode(byteAt(bytes, offset), byteAt(bytes, offset + 1), byteAt(bytes, offset + 2), byteAt(bytes, offset + 3));
	if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("不是合法的 RIFF/WAVE 音频");
	let offset = 12;
	let fmt;
	let data;
	while (offset + 8 <= bytes.byteLength) {
		const id = tag(offset);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (id === "fmt " && body + 16 <= bytes.byteLength) fmt = {
			code: view.getUint16(body, true),
			channels: view.getUint16(body + 2, true),
			sampleRate: view.getUint32(body + 4, true),
			bits: view.getUint16(body + 14, true)
		};
		else if (id === "data") data = {
			start: body,
			size: Math.min(size, Math.max(0, bytes.byteLength - body))
		};
		offset = body + size + size % 2;
		if (fmt !== void 0 && data !== void 0) break;
	}
	if (fmt === void 0 || data === void 0) throw new Error("WAV 缺少 fmt/data 数据块");
	const { code, channels, bits, sampleRate } = fmt;
	if (!(channels >= 1)) throw new Error("WAV 声道数非法：" + String(channels));
	if (!(sampleRate > 0)) throw new Error("WAV 采样率非法：" + String(sampleRate));
	const bytesPerSample = bits / 8;
	if (!(bytesPerSample >= 1)) throw new Error("WAV 位深非法：" + String(bits));
	if (code !== 1 && code !== 3) throw new Error("暂不支持的 WAV 编码格式：" + String(code));
	const frames = Math.floor(data.size / (bytesPerSample * channels));
	if (frames <= 0) return {
		samples: /* @__PURE__ */ new Float32Array(0),
		sampleRate: targetSampleRate
	};
	const pcm = new Float32Array(frames);
	for (let i = 0; i < frames; i += 1) {
		let sum = 0;
		for (let c = 0; c < channels; c += 1) {
			const p = data.start + (i * channels + c) * bytesPerSample;
			let value;
			if (code === 3) value = view.getFloat32(p, true);
			else if (bits === 8) value = (view.getUint8(p) - 128) / 128;
			else if (bits === 16) value = view.getInt16(p, true) / 32768;
			else if (bits === 24) {
				const lo = view.getUint8(p);
				const mid = view.getUint8(p + 1);
				value = (view.getInt8(p + 2) << 16 | mid << 8 | lo) / 8388608;
			} else if (bits === 32) value = view.getInt32(p, true) / 2147483648;
			else throw new Error("暂不支持的 WAV 位深：" + String(bits));
			sum += value;
		}
		pcm[i] = sum / channels;
	}
	if (sampleRate === targetSampleRate) return {
		samples: pcm,
		sampleRate: targetSampleRate
	};
	const target = Math.max(1, Math.round(pcm.length * targetSampleRate / sampleRate));
	const out = new Float32Array(target);
	const ratio = target > 1 ? (pcm.length - 1) / (target - 1) : 0;
	for (let i = 0; i < target; i += 1) {
		const x = i * ratio;
		const i0 = Math.floor(x);
		const i1 = Math.min(pcm.length - 1, i0 + 1);
		const f = x - i0;
		out[i] = (pcm[i0] ?? 0) * (1 - f) + (pcm[i1] ?? 0) * f;
	}
	return {
		samples: out,
		sampleRate: targetSampleRate
	};
}
//#endregion
//#region src/voice/transcribe.ts
/** 16 kHz mono is what SenseVoice expects. */
const TARGET_SAMPLE_RATE = 16e3;
/** Mirrors tried in order when the primary URL fails (mainland networks). */
const DEFAULT_MIRRORS = [
	"https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx",
	"https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
	"https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2"
];
const MIRROR_TOKENS_URL = "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt";
const require_ = createRequire(import.meta.url);
/** Resolve the model directory using the same convention as dsh-voice-local,
*  so an already-downloaded model is shared instead of fetched twice. */
function resolveModelDir(override) {
	const env = process.env.DSH_VOICE_MODEL_DIR;
	if (typeof override === "string" && override.trim() !== "") return override.trim();
	if (typeof env === "string" && env.trim() !== "") return env.trim();
	const home = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
	return join(home, "voice", "sensevoice");
}
function modelFiles(dir) {
	return {
		model: join(dir, "model.int8.onnx"),
		tokens: join(dir, "tokens.txt")
	};
}
function modelReady(dir) {
	const { model, tokens } = modelFiles(dir);
	try {
		return statSync(model).size > 0 && statSync(tokens).size > 0;
	} catch {
		return false;
	}
}
/**
* Locate ffmpeg. Order: explicit config > DSH_VOICE_FFMPEG > PATH > common
* install locations. Returns undefined when nothing is found (the caller
* then reports a readable error instead of silently skipping).
*/
function resolveFfmpeg(explicit) {
	if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim();
	const env = process.env.DSH_VOICE_FFMPEG;
	if (typeof env === "string" && env.trim() !== "") return env.trim();
	const which = spawnSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], { encoding: "utf8" });
	const found = which.status === 0 ? (which.stdout ?? "").split(/\r?\n/)[0]?.trim() : "";
	if (found && existsSync(found)) return found;
	for (const candidate of [
		"D:/ffmpeg/bin/ffmpeg.exe",
		"C:/ffmpeg/bin/ffmpeg.exe",
		"/opt/homebrew/bin/ffmpeg",
		"/usr/local/bin/ffmpeg",
		"/usr/bin/ffmpeg"
	]) if (existsSync(candidate)) return candidate;
}
/** Decode any audio file ffmpeg understands into 16 kHz mono PCM16 WAV. */
function transcodeToWav(input, output, ffmpeg, timeoutMs = 6e4) {
	if (!ffmpeg) return {
		ok: false,
		error: "未找到 ffmpeg（配置 voice.ffmpegPath 或设置 DSH_VOICE_FFMPEG）"
	};
	if (!existsSync(input)) return {
		ok: false,
		error: "输入音频不存在: " + input
	};
	try {
		const conv = spawnSync(ffmpeg, [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			input,
			"-ar",
			String(TARGET_SAMPLE_RATE),
			"-ac",
			"1",
			"-c:a",
			"pcm_s16le",
			output
		], {
			encoding: "utf8",
			timeout: timeoutMs
		});
		if (conv.status !== 0 || !existsSync(output)) return {
			ok: false,
			error: "ffmpeg 转换失败: " + (conv.stderr || conv.error?.message || "退出码 " + String(conv.status)).trim().slice(0, 400)
		};
		return {
			ok: true,
			wavPath: output
		};
	} catch (err) {
		return {
			ok: false,
			error: "ffmpeg 转换异常: " + (err instanceof Error ? err.message : String(err))
		};
	}
}
let recognizer;
let recognizerDir;
let loading;
function loadSherpa() {
	return require_("sherpa-onnx-node/non-streaming-asr.js");
}
function buildRecognizerConfig(dir) {
	const { model, tokens } = modelFiles(dir);
	return {
		featConfig: {
			sampleRate: TARGET_SAMPLE_RATE,
			featureDim: 80
		},
		modelConfig: {
			senseVoice: {
				model,
				language: "auto",
				useInverseTextNormalization: 1
			},
			tokens,
			numThreads: 4,
			provider: "cpu",
			debug: 0
		}
	};
}
/** Load (once) the SenseVoice recognizer for dir. Throws a readable error
*  when the native addon or the model is unusable. */
async function ensureRecognizer(dir) {
	if (recognizer && recognizerDir === dir) return recognizer;
	if (loading) return loading;
	loading = (async () => {
		if (!modelReady(dir)) throw new Error("语音模型未就绪（缺少 " + modelFiles(dir).model + " 或 tokens.txt）");
		const { OfflineRecognizer } = loadSherpa();
		const created = new OfflineRecognizer(buildRecognizerConfig(dir));
		recognizer = created;
		recognizerDir = dir;
		return created;
	})();
	try {
		return await loading;
	} finally {
		loading = void 0;
	}
}
function disposeRecognizer() {
	recognizer = void 0;
	recognizerDir = void 0;
}
/** Drop the cached recognizer when the configured model directory changed. */
function releaseRecognizerIfStale(dir) {
	if (recognizer && recognizerDir !== dir) disposeRecognizer();
}
/**
* Transcribe a 16 kHz mono PCM16 WAV buffer. Returns ok:false instead of
* throwing, so one bad voice message can never break the pipeline.
*/
async function transcribeWavBuffer(wav, opts = {}) {
	const dir = resolveModelDir(opts.modelDir);
	if (!modelReady(dir)) return {
		ok: false,
		error: "语音模型未就绪",
		modelMissing: true
	};
	try {
		releaseRecognizerIfStale(dir);
		const rec = await ensureRecognizer(dir);
		const wave = readWavSamples(wav, TARGET_SAMPLE_RATE);
		let samples = wave.samples;
		if (wave.sampleRate !== 16e3) {
			const ratio = TARGET_SAMPLE_RATE / wave.sampleRate;
			const out = new Float32Array(Math.max(1, Math.round(samples.length * ratio)));
			for (let i = 0; i < out.length; i++) {
				const pos = i / ratio;
				const i0 = Math.floor(pos);
				const i1 = Math.min(samples.length - 1, i0 + 1);
				const frac = pos - i0;
				const a = samples[i0];
				const b = samples[i1];
				if (a === void 0 || b === void 0) continue;
				out[i] = a * (1 - frac) + b * frac;
			}
			samples = out;
		}
		const stream = rec.createStream();
		stream.acceptWaveform({
			samples,
			sampleRate: TARGET_SAMPLE_RATE
		});
		rec.decode(stream);
		const result = rec.getResult(stream);
		return {
			ok: true,
			text: String(result?.text ?? "").trim()
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
let downloadState = {
	running: false,
	phase: "idle",
	receivedBytes: 0,
	totalBytes: null
};
function getDownloadState() {
	return { ...downloadState };
}
async function fetchToFile(url, dest, onBytes) {
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok || !res.body) throw new Error("HTTP " + res.status + " " + url);
	downloadState.totalBytes = Number(res.headers.get("content-length") ?? 0) || null;
	const chunks = [];
	let received = 0;
	for await (const chunk of res.body) {
		chunks.push(chunk);
		received += chunk.length;
		onBytes(received);
	}
	writeFileSync(dest, Buffer.concat(chunks));
	return received;
}
/**
* Download + install the SenseVoice model into dir. Idempotent (a ready
* directory short-circuits) and multi-mirror. Extraction uses the system
* tar; the hf-mirror direct-file route avoids tar entirely and is listed
* first in DEFAULT_MIRRORS for that reason.
*/
async function downloadModel(dir, opts = {}) {
	if (modelReady(dir)) {
		downloadState = {
			running: false,
			phase: "done",
			receivedBytes: 0,
			totalBytes: null
		};
		return getDownloadState();
	}
	if (downloadState.running) return getDownloadState();
	downloadState = {
		running: true,
		phase: "download",
		receivedBytes: 0,
		totalBytes: null,
		startedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, ".download");
	rmSync(tmp, {
		recursive: true,
		force: true
	});
	mkdirSync(tmp, { recursive: true });
	try {
		const mirrors = (opts.mirrors ?? "").split(",").map((s) => s.trim()).filter(Boolean);
		const urls = [
			opts.modelUrl?.trim(),
			...mirrors,
			...DEFAULT_MIRRORS
		].filter((u) => typeof u === "string" && u !== "");
		let installed = false;
		let lastError = "";
		for (const url of urls) try {
			if (/\.onnx(\?|$)/i.test(url)) {
				const modelOut = join(tmp, "model.int8.onnx");
				await fetchToFile(url, modelOut, (n) => {
					downloadState.receivedBytes = n;
				});
				const tokensOut = join(tmp, "tokens.txt");
				await fetchToFile(MIRROR_TOKENS_URL, tokensOut, () => {});
				renameSync(modelOut, modelFiles(dir).model);
				renameSync(tokensOut, modelFiles(dir).tokens);
				installed = true;
			} else {
				const archive = join(tmp, basename(new URL(url).pathname) || "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2");
				await fetchToFile(url, archive, (n) => {
					downloadState.receivedBytes = n;
				});
				downloadState.phase = "extract";
				const extractDir = join(tmp, "extract");
				mkdirSync(extractDir, { recursive: true });
				const untar = spawnSync("tar", [
					"-xjf",
					archive,
					"--strip-components=1",
					"-C",
					extractDir
				], { encoding: "utf8" });
				if (untar.status !== 0) throw new Error("tar 解压失败: " + (untar.stderr || "").slice(0, 200));
				if (!existsSync(join(extractDir, "model.int8.onnx"))) throw new Error("归档内未找到 model.int8.onnx");
				renameSync(join(extractDir, "model.int8.onnx"), modelFiles(dir).model);
				renameSync(join(extractDir, "tokens.txt"), modelFiles(dir).tokens);
				installed = true;
			}
			if (installed) break;
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
		if (!installed) throw new Error(lastError || "所有下载源均失败");
		downloadState = {
			running: false,
			phase: "done",
			receivedBytes: downloadState.receivedBytes,
			totalBytes: downloadState.totalBytes
		};
		return getDownloadState();
	} catch (err) {
		downloadState = {
			running: false,
			phase: "error",
			receivedBytes: downloadState.receivedBytes,
			totalBytes: downloadState.totalBytes,
			error: err instanceof Error ? err.message : String(err)
		};
		return getDownloadState();
	} finally {
		rmSync(tmp, {
			recursive: true,
			force: true
		});
	}
}
/** Fire-and-forget download used on first contact (never blocks a turn). */
function startModelDownload(dir, opts = {}) {
	downloadModel(dir, opts);
}
/**
* Persist a downloaded audio buffer under inboundDir/media. Never throws:
* returns the local path, or an error string when it could not be written.
* Kept separate from transcription because the raw clip is retained even when
* transcription is disabled — replaying a message must not depend on STT.
*/
function persistAudio(buffer, inboundDir, baseName) {
	if (!inboundDir) return { errors: ["未配置 inboundDir，音频无法落盘"] };
	try {
		mkdirSync(join(inboundDir, "media"), { recursive: true });
		const ext = detectContainer(buffer) === "ogg" ? "ogg" : "bin";
		const localPath = join(inboundDir, "media", baseName + "." + ext);
		writeFileSync(localPath, buffer);
		return {
			localPath,
			errors: []
		};
	} catch (err) {
		return { errors: ["落盘失败: " + (err instanceof Error ? err.message : String(err))] };
	}
}
/** Transcode a persisted audio file to 16 kHz mono WAV for the recognizer. */
function transcodeAudio(localPath, opts = {}) {
	const conv = transcodeToWav(localPath, localPath + ".16000.wav", resolveFfmpeg(opts.ffmpegPath), opts.ffmpegTimeoutMs);
	if (conv.ok && conv.wavPath) return {
		wavPath: conv.wavPath,
		errors: []
	};
	return { errors: [conv.error ?? "转码失败"] };
}
/** Persist a downloaded audio buffer and transcode it; never throws. */
function prepareAudio(buffer, inboundDir, baseName, durationMs, opts = {}) {
	const persisted = persistAudio(buffer, inboundDir, baseName);
	const localPath = persisted.localPath;
	const errors = [...persisted.errors];
	let wavPath;
	if (localPath) {
		const transcoded = transcodeAudio(localPath, opts);
		wavPath = transcoded.wavPath;
		errors.push(...transcoded.errors);
	}
	return {
		localPath,
		wavPath,
		durationMs,
		errors
	};
}
/** Sniff the container from magic bytes (Feishu voice is OGG/Opus). */
function detectContainer(buf) {
	const head = Buffer.from(buf.subarray(0, 4)).toString("ascii");
	if (head.startsWith("OggS")) return "ogg";
	if (head.startsWith("RIFF")) return "wav";
	if (buf[0] === 26 && buf[1] === 69 && buf[2] === 223 && buf[3] === 163) return "webm";
	return "unknown";
}
function readWavFile(path) {
	return new Uint8Array(readFileSync(path));
}
//#endregion
//#region src/voice/service.ts
function createVoiceService(logger, opts = {}) {
	let current = { ...opts };
	const modelDir = () => resolveModelDir(current.modelDir);
	const diag = () => {
		const missing = !modelReady(modelDir());
		const ff = resolveFfmpeg(current.ffmpegPath);
		return [
			"engine=SenseVoice(sherpa-onnx, cpu)",
			"modelDir=" + modelDir(),
			"model=" + (missing ? "missing" : "ready"),
			"ffmpeg=" + (ff ?? "missing")
		].join(" ");
	};
	return {
		modelDir,
		ready: () => modelReady(modelDir()),
		ffmpeg: () => resolveFfmpeg(current.ffmpegPath),
		statusLine: diag,
		download: () => getDownloadState(),
		configure(next) {
			current = {
				...current,
				...next
			};
		},
		startDownload() {
			if (modelReady(modelDir())) return;
			logger.info("[voice] model missing — starting background download");
			startModelDownload(modelDir(), current);
		},
		async downloadNow() {
			return downloadModel(modelDir(), current);
		},
		async transcribe(buffer, baseName, durationMs, inboundDir, uniqueSuffix) {
			const errors = [];
			const prepared = prepareAudio(buffer, inboundDir, uniqueSuffix === void 0 ? baseName : baseName + "-" + uniqueSuffix, durationMs, current);
			errors.push(...prepared.errors);
			if (!prepared.wavPath) return {
				localPath: prepared.localPath,
				errors
			};
			const result = await transcribeWavBuffer(readWavFile(prepared.wavPath), current);
			if (result.ok) return {
				text: result.text,
				localPath: prepared.localPath,
				errors
			};
			if (result.modelMissing) {
				this.startDownload();
				return {
					localPath: prepared.localPath,
					errors: [...errors, "语音模型尚在下载，请稍后重发这条语音"],
					downloadStarted: true
				};
			}
			return {
				localPath: prepared.localPath,
				errors: [...errors, result.error ?? "转写失败"]
			};
		},
		persistRawAudio(buffer, baseName, inboundDir) {
			return persistAudio(buffer, inboundDir, baseName);
		},
		async transcribeRaw(localPath, _durationMs) {
			const errors = [];
			const transcoded = transcodeAudio(localPath, current);
			errors.push(...transcoded.errors);
			if (!transcoded.wavPath) return {
				localPath,
				errors
			};
			const result = await transcribeWavBuffer(readWavFile(transcoded.wavPath), current);
			if (result.ok) return {
				text: result.text,
				localPath,
				errors
			};
			if (result.modelMissing) {
				this.startDownload();
				return {
					localPath,
					errors: [...errors, "语音模型尚在下载，请稍后重发这条语音"],
					downloadStarted: true
				};
			}
			return {
				localPath,
				errors: [...errors, result.error ?? "转写失败"]
			};
		}
	};
}
//#endregion
//#region src/index.ts
const name = "dsh-lark-plus";
const inject = [
	"tools",
	"commands",
	"agents",
	"systemPrompt",
	"credentials",
	"webServer"
];
/** Build VoiceOptions from plugin config + environment + defaults. */
function voiceOptionsFrom(cfg) {
	const v = cfg?.voice;
	const pick = (a, b) => {
		if (typeof a === "string" && a.trim() !== "") return a.trim();
		if (typeof b === "string" && b.trim() !== "") return b.trim();
	};
	return {
		modelDir: pick(v?.modelDir, process.env.DSH_VOICE_MODEL_DIR),
		ffmpegPath: pick(v?.ffmpegPath, process.env.DSH_VOICE_FFMPEG),
		modelUrl: pick(v?.modelUrl, process.env.DSH_VOICE_MODEL_URL),
		mirrors: v?.mirrors,
		ffmpegTimeoutMs: v?.ffmpegTimeoutMs
	};
}
/** Bridge state directory (<DSH_HOME>/lark, overridable). */
function stateDir() {
	return process.env.DSH_LARK_PLUS_HOME ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "lark-plus");
}
function apply(ctx, rawConfig) {
	const cfg = rawConfig;
	if (cfg?.enabled === false) return;
	const dir = stateDir();
	mkdirSync(dir, { recursive: true });
	const logger = createLogger("lark-plus");
	const configStore = createConfigStore(dir, {
		groupPolicy: cfg?.groupPolicy,
		denyList: cfg?.denyList
	});
	const status = createStatusStore(join(dir, "status.json"));
	const routeStore = createRouteStore(join(dir, "routes.json"));
	const dedupe = createDedupeStore(join(dir, "dedupe.jsonl"));
	const inboundWal = createInboundWal({ dir: join(dir, "inbound-wal") });
	const getCfg = () => configStore.get();
	const convCfg = createConversationConfigStore(join(dir, "conversation-overrides.json"));
	const liveModelSelection = {
		provider: "",
		model: ""
	};
	const admService = ctx.get?.("agentDefaultModel");
	{
		const cur = admService?.currentSelection?.();
		if (cur?.provider && cur.model) {
			liveModelSelection.provider = cur.provider;
			liveModelSelection.model = cur.model;
		}
	}
	const liveModels = /* @__PURE__ */ new Map();
	const liveModelFor = (key) => {
		let m = liveModels.get(key);
		if (!m) {
			const o = convCfg.get(key);
			m = {
				provider: o.provider ?? liveModelSelection.provider,
				model: o.model ?? liveModelSelection.model,
				override: Boolean(o.provider && o.model)
			};
			liveModels.set(key, m);
		}
		return m;
	};
	const runNonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	let backend;
	try {
		backend = createDshAdapter({
			ctx,
			sessionPrefix: "lark-plus",
			runNonce,
			logger,
			cwd: (key) => convCfg.get(key).workspaceRoot ?? (getCfg().workspaceRoot || process.cwd()),
			preset: (key) => {
				return normalizeAgentPreset(convCfg.get(key).preset ?? (getCfg().agentPreset || "ptc"));
			},
			modelSelection: { currentFor: (key) => {
				const m = liveModelFor(key);
				return m.provider && m.model ? m : void 0;
			} },
			activeSessionId: (key) => convCfg.get(key).activeSessionId,
			setActiveSessionId: (key, sessionId) => {
				convCfg.set(key, { activeSessionId: sessionId });
			},
			askUserQuestion,
			permissionMode: () => getCfg().permissionMode,
			onResumeFallback: (key, lostSessionId, cause) => {
				try {
					const reason = cause instanceof Error ? cause.message : String(cause);
					logger.warn("session resume fell back for " + key + ": " + reason);
					const route = routeStore.get(key);
					if (route === void 0 || !route.chatId) return;
					const queued = outbox.enqueue({
						dedupeKey: "bridge:session-fallback:" + Date.now().toString(36),
						laneKey: key,
						route: {
							sessionKey: key,
							chatId: route.chatId,
							chatType: route.chatType
						},
						kind: "command-reply",
						payload: {
							kind: "text",
							text: [
								"⚠️ **没能接续上次的会话**，已新开一个空会话。",
								"- 原会话：`" + lostSessionId + "`",
								"- 原因：" + reason.slice(0, 300),
								"- 想回去：发 `/sessions` 点一下原会话，或 `/resume <序号>`；历史内容都还在。"
							].join("\n")
						}
					});
					if (queued instanceof Promise) queued.catch(() => void 0);
				} catch (err) {
					logger.warn("resume fallback notice failed: " + String(err));
				}
			}
		});
	} catch (err) {
		logger.warn(`DSH adapter unavailable — using in-memory backend: ${String(err)}`);
		backend = createMemoryDshBackend();
	}
	let larkClient;
	const getLarkClient = () => larkClient;
	const credStore = {
		resolve: (ref) => ctx.credentials?.resolve(ref) ?? Promise.resolve(void 0),
		set: (ref, value) => ctx.credentials?.set(ref, value) ?? Promise.resolve(),
		unset: (ref) => ctx.credentials?.unset(ref) ?? Promise.resolve()
	};
	let startBlocker;
	const maskId = (id) => id.length <= 8 ? "****" : `${id.slice(0, 6)}…${id.slice(-4)}`;
	let activeQr;
	const webServer = ctx.webServer;
	if (webServer) {
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: "/plugins/lark-plus/qr",
			handler: (_req, res) => {
				const r = res;
				if (activeQr && Date.now() < activeQr.expireAt) {
					r.writeHead(200, {
						"Content-Type": "image/png",
						"Cache-Control": "no-store"
					});
					r.end(activeQr.png);
				} else {
					r.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
					r.end("no active lark-plus setup qr (run /lark setup)");
				}
			}
		}), "lark-plus: webui qr route");
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: "/plugins/lark-plus/status",
			handler: async (_req, res) => {
				const r = res;
				const configured = Boolean(await resolveCredentials(credStore, getCfg().credentialRef));
				r.writeHead(200, {
					"Content-Type": "application/json; charset=utf-8",
					"Cache-Control": "no-store"
				});
				r.end(JSON.stringify({
					...status.get(),
					configured
				}));
			}
		}), "lark-plus: webui status route");
		ctx.effect(() => webServer.register({
			kind: "prefix",
			path: "/plugins/lark-plus/audio",
			handler: (req, res) => voiceAudioRoute(req, res, join(getCfg().attachments.dir.trim() || join(tmpdir(), "dsh-lark-plus", "inbound"), "media"))
		}), "lark-plus: voice playback route");
		ctx.effect(() => webServer.register({
			kind: "prefix",
			path: "/dsh-voice-local/v1",
			handler: async (req, res) => {
				const r = res;
				const method = req.method ?? "GET";
				const url = req.url ?? "";
				const json = (code, value) => {
					r.writeHead(code, {
						"Content-Type": "application/json; charset=utf-8",
						"Cache-Control": "no-store"
					});
					r.end(JSON.stringify(value));
				};
				const path = url.split("?")[0] ?? "";
				if (method === "GET" && path.endsWith("/health")) {
					json(200, {
						ok: true,
						engine: "sensevoice",
						modelDir: voice.modelDir(),
						modelReady: voice.ready(),
						ffmpeg: voice.ffmpeg() ?? null,
						download: voice.download()
					});
					return;
				}
				if (method === "GET" && path.endsWith("/model/status")) {
					json(200, {
						ok: true,
						modelDir: voice.modelDir(),
						ready: voice.ready(),
						download: voice.download()
					});
					return;
				}
				if (method === "POST" && path.endsWith("/model/download")) {
					voice.startDownload();
					json(200, {
						ok: true,
						started: true,
						download: voice.download()
					});
					return;
				}
				if (method === "POST" && path.endsWith("/transcribe")) {
					if (!voice.ready()) {
						json(503, {
							ok: false,
							error: {
								code: "model-not-ready",
								message: "SenseVoice 模型未就绪"
							}
						});
						return;
					}
					const chunks = [];
					let size = 0;
					for await (const chunk of req) {
						size += chunk.length;
						if (size > 25165824) {
							json(413, {
								ok: false,
								error: {
									code: "too-large",
									message: "音频超过 24 MiB"
								}
							});
							return;
						}
						chunks.push(chunk);
					}
					const result = await transcribeWavBuffer(Buffer.concat(chunks), voiceOptions);
					if (result.modelMissing) {
						voice.startDownload();
						json(503, {
							ok: false,
							error: {
								code: "model-not-ready",
								message: "模型下载中，请稍后重试"
							}
						});
						return;
					}
					json(result.ok ? 200 : 400, result.ok ? {
						ok: true,
						text: result.text
					} : {
						ok: false,
						error: {
							code: "transcribe-failed",
							message: result.error
						}
					});
					return;
				}
				json(404, {
					ok: false,
					error: {
						code: "not-found",
						message: "未知端点"
					}
				});
			}
		}), "lark-plus: local transcribe route");
	}
	const sender = {
		async replyTo(msg, textOrCard) {
			const text = typeof textOrCard === "string" ? textOrCard : JSON.stringify(textOrCard);
			if (typeof textOrCard === "string") await sender.sendText(msg.chatId, text);
			else await sender.sendCard(msg.chatId, textOrCard);
		},
		async sendText(chatId, text) {
			const client = getLarkClient();
			if (!client?.sendMessage) throw new Error("lark client not ready");
			if (looksLikeMarkdown(text) && text.length <= 28e3) {
				await client.sendMessage({
					receive_id_type: chatId.startsWith("oc_") ? "chat_id" : "open_id",
					params: {
						receive_id: chatId,
						msg_type: "interactive",
						content: JSON.stringify(markdownCard(text))
					}
				});
				return;
			}
			await client.sendMessage({
				receive_id_type: chatId.startsWith("oc_") ? "chat_id" : "open_id",
				params: {
					receive_id: chatId,
					msg_type: "text",
					content: JSON.stringify({ text })
				}
			});
		},
		async sendCard(chatId, card) {
			const client = getLarkClient();
			if (!client?.sendMessage) throw new Error("lark client not ready");
			await client.sendMessage({
				receive_id_type: chatId.startsWith("oc_") ? "chat_id" : "open_id",
				params: {
					receive_id: chatId,
					msg_type: "interactive",
					content: JSON.stringify(card)
				}
			});
		},
		async addReaction(messageId, emojiType) {
			const client = getLarkClient();
			if (!client?.addReaction) throw new Error("lark client not ready");
			await client.addReaction({
				message_id: messageId,
				emoji_type: emojiType
			});
		},
		async sendFile(chatId, fileKey, type) {
			const client = getLarkClient();
			if (!client?.sendMessage) throw new Error("lark client not ready");
			await client.sendMessage({
				receive_id_type: chatId.startsWith("oc_") ? "chat_id" : "open_id",
				params: {
					receive_id: chatId,
					msg_type: type,
					content: JSON.stringify(type === "image" ? { image_key: fileKey } : { file_key: fileKey })
				}
			});
		},
		async listMessages({ chatId, startTimeMs, endTimeMs }) {
			const client = getLarkClient();
			if (!client?.listMessages) return [];
			return ((await client.listMessages({
				container_id_type: "chat",
				container_id: chatId,
				start_time: String(startTimeMs),
				end_time: String(endTimeMs)
			})).items ?? []).map((i) => ({
				messageId: i.message_id ?? "",
				timestampMs: Number(i.create_time ?? 0)
			}));
		}
	};
	const voiceOptions = voiceOptionsFrom(cfg);
	const voiceEnabled = cfg?.voice?.enabled !== false;
	const voice = createVoiceService({
		warn: (m) => logger.warn(m),
		info: (m) => logger.info(m)
	}, voiceOptions);
	if (voiceEnabled && !voice.ready()) voice.startDownload();
	const bridge = createBridgeContext({
		logger,
		cfg: getCfg,
		configStore,
		status,
		backend,
		router: routeStore,
		sender,
		attachmentsRef: () => ctx.get?.("attachments")
	});
	const outbox = createOutbox({
		dir: join(dir, "outbox"),
		sender: { async deliver(env, payload) {
			const chatId = env.route.chatId;
			try {
				if (payload.kind === "text") {
					if (payload.card !== void 0) await sender.sendCard(chatId, payload.card);
					else await sender.sendText(chatId, payload.text);
				} else if (payload.kind === "card") await sender.sendCard(chatId, payload.card);
				else if (payload.kind === "media") await sender.sendFile(chatId, payload.fileKey, payload.type);
				else if (payload.kind === "reaction") await sender.addReaction(payload.messageId, payload.emojiType);
				return { ok: true };
			} catch (err) {
				return {
					ok: false,
					retryable: true,
					error: err instanceof Error ? err.message : String(err)
				};
			}
		} },
		cfg: getCfg().outbox,
		onStatsChange: (stats) => {
			try {
				status.refreshCounters({
					outboxPending: stats.pending,
					outboxFailed: stats.failed
				});
			} catch {}
		}
	});
	const streamHandles = /* @__PURE__ */ new Map();
	const cardkitNotified = /* @__PURE__ */ new Set();
	const resolveRawAgent = (handle) => {
		if (!handle) return void 0;
		const h = handle;
		if (h.rawAgent) return h.rawAgent;
		if (h.agentId) {
			const found = (ctx.get?.("agents"))?.get?.(h.agentId);
			if (found) return found;
		}
		return handle;
	};
	const notifyCardkitFailure = (sessionKey, err) => {
		if (cardkitNotified.has(sessionKey)) return;
		cardkitNotified.add(sessionKey);
		const chatId = routeStore.get(sessionKey)?.chatId;
		if (!chatId) return;
		const msg = err instanceof Error ? err.message : String(err);
		sender.sendText(chatId, `⚠️ 流式卡片创建失败，本轮已回退普通消息（原因: ${msg.slice(0, 200)}）。常见排查：应用未开通 CardKit 卡片权限（cardkit:card）、飞书客户端版本过旧、或 stream 文本超限。错误只提示一次。`).catch(() => void 0);
	};
	const taskCardSyncer = createTaskCardSyncer({
		api: {
			createCard: async (payload) => {
				const client = getLarkClient();
				if (!client?.cardkitCreateCard) return void 0;
				return await client.cardkitCreateCard(payload);
			},
			deliverCard: async (cardId) => {},
			streamText: async (cardId, elementId, body) => {
				const client = getLarkClient();
				return client?.cardkitStreamText ? await client.cardkitStreamText(cardId, elementId, body) : {};
			},
			patchSettings: async (cardId, body) => {
				const client = getLarkClient();
				return client?.cardkitPatchSettings ? await client.cardkitPatchSettings(cardId, body) : {};
			},
			updateCard: async (cardId, body) => {
				const client = getLarkClient();
				return client?.cardkitUpdateCard ? await client.cardkitUpdateCard(cardId, body) : {};
			}
		},
		routeFor: (key) => routeStore.get(key),
		deliverCard: async ({ chatId, cardId }) => {
			const client = getLarkClient();
			return client?.cardkitDeliverCard ? await client.cardkitDeliverCard({
				chatId,
				cardId
			}) : {};
		},
		debounceMs: 1500,
		onError: (err) => logger.warn(`task card syncer error: ${err instanceof Error ? err.message : String(err)}`)
	});
	const forwarder = createEventForwarder({
		outbox,
		taskCardSyncer,
		routeFor: (key) => routeStore.get(key),
		streamFor: (sessionKey) => {
			const route = routeStore.get(sessionKey);
			if (!route) return void 0;
			return {
				route: {
					sessionKey: route.sessionKey,
					chatId: route.chatId,
					chatType: route.chatType,
					threadMessageId: route.threadMessageId
				},
				ensureStream: () => {
					const client = getLarkClient();
					if (!client?.cardkitCreateCard || !client.cardkitDeliverCard) return void 0;
					const existing = streamHandles.get(sessionKey);
					if (existing && !existing.disposed) return existing;
					streamHandles.delete(sessionKey);
					const cfgStream = getCfg().streaming;
					const handle = createCardKitStream({
						api: {
							createCard: async (payload) => {
								try {
									return await client.cardkitCreateCard(payload);
								} catch (err) {
									notifyCardkitFailure(sessionKey, err);
									throw err;
								}
							},
							deliverCard: (cardId) => client.cardkitDeliverCard({
								chatId: route.chatId,
								cardId
							}),
							streamText: (cardId, elementId, body) => client.cardkitStreamText(cardId, elementId, body),
							patchSettings: (cardId, body) => client.cardkitPatchSettings(cardId, body),
							updateCard: (cardId, body) => client.cardkitUpdateCard(cardId, body)
						},
						printFrequencyMs: cfgStream.printFrequencyMs,
						printStep: cfgStream.printStep,
						minPushIntervalMs: 800,
						onError: (err) => {
							const errStr = String(err);
							if (!errStr.includes("230020") && !errStr.includes("rate limit")) logger.warn(`cardkit stream error for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
						}
					});
					streamHandles.set(sessionKey, handle);
					return handle;
				},
				fallbackText: async (text) => {
					await outbox.enqueue({
						dedupeKey: `${sessionKey}:fallback:${Date.now()}`,
						laneKey: sessionKey,
						route: {
							sessionKey: route.sessionKey,
							chatId: route.chatId,
							chatType: route.chatType
						},
						kind: "assistant-output",
						payload: {
							kind: "text",
							text
						}
					});
				},
				markDone: () => bridge.markDone(sessionKey, route.lastMessageId)
			};
		},
		cfg: () => ({ streamingEnabled: getCfg().streaming.enabled }),
		onDelivered: (sessionKey) => {
			try {
				const route = routeStore.get(sessionKey);
				if (route?.lastMessageId) inboundWal.delivered(route.lastMessageId);
			} catch {}
		}
	});
	const groupTrigger = createGroupTrigger({
		cfg: () => ({
			policy: getCfg().groupPolicy,
			keywords: getCfg().groupKeywords,
			alsoOnReply: getCfg().alsoOnReply
		}),
		botOpenId: () => bridge.botOpenId()
	});
	const diagnostics = createDiagnosticsService({
		ctx: bridge,
		secrets: []
	});
	const pendingQuestions = /* @__PURE__ */ new Map();
	async function askUserQuestion(questions, agentId) {
		const answers = [];
		const key = backend?.keyForSessionId?.(agentId);
		const chatId = (key ? routeStore.get(key) : void 0)?.chatId;
		if (!chatId) {
			logger.warn(`ask_user_question: no Feishu route for ${agentId}`);
			return { answers: questions.map((q) => ({
				id: q.id,
				selected: ["(无会话，未回答)"]
			})) };
		}
		for (const q of questions) {
			const answer = await new Promise((resolve) => {
				const timer = setTimeout(() => {
					pendingQuestions.delete(q.id);
					resolve({
						id: q.id,
						selected: ["(超时未回答)"]
					});
				}, 6e5);
				timer.unref?.();
				pendingQuestions.set(q.id, {
					resolve,
					chatId,
					questionId: q.id,
					timer,
					options: q.options ?? []
				});
				sender.sendCard(chatId, questionCard(q)).catch((err) => {
					clearTimeout(timer);
					pendingQuestions.delete(q.id);
					resolve({
						id: q.id,
						selected: [`(卡片发送失败: ${err instanceof Error ? err.message : String(err)})`]
					});
				});
			});
			answers.push(answer);
		}
		return { answers };
	}
	const dshCommands = {
		has: (name, agentId) => {
			try {
				const services = ctx;
				const agent = agentId ? services.agents?.get?.(agentId) : void 0;
				if (!agent) return false;
				return Boolean(services.commands?.find?.(agent, name));
			} catch {
				return false;
			}
		},
		async run(name, rawInput, agentId) {
			try {
				const services = ctx;
				const commands = services.commands;
				const agent = services.agents?.get?.(agentId);
				if (!commands?.execute || !agent) return {
					kind: "error",
					text: "commands service unavailable"
				};
				const line = rawInput.trim() ? `/${name} ${rawInput.trim()}` : `/${name}`;
				const out = await commands.execute(agent, line, new AbortController().signal);
				if (!out?.result) return {
					kind: "error",
					text: `未知命令 /${name}`
				};
				return {
					kind: out.result.kind,
					text: out.result.text
				};
			} catch (err) {
				return {
					kind: "error",
					text: err instanceof Error ? err.message : String(err)
				};
			}
		}
	};
	const durableReply = async (cmdName, msg, textOrCard) => {
		const key = bridge.conversationKeyFor(msg);
		await outbox.enqueue({
			dedupeKey: `bridge:${cmdName}:${msg.messageId}`,
			laneKey: key,
			route: {
				sessionKey: key,
				chatId: msg.chatId,
				chatType: msg.chatType
			},
			kind: "command-reply",
			payload: typeof textOrCard === "string" ? {
				kind: "text",
				text: textOrCard
			} : {
				kind: "card",
				card: textOrCard
			}
		});
	};
	const bridgeHandler = async (name, _rawInput, msg) => {
		switch (name) {
			case "status": {
				const statusKey = bridge.conversationKeyFor(msg);
				const statusSessionId = bridge.backend?.get(statusKey)?.sessionId ?? convCfg.get(statusKey).activeSessionId;
				let statusTitle;
				try {
					const statusSessions = ctx.get?.("sessions");
					const statusTitles = ctx.get?.("sessionTitle");
					const statusLive = statusSessionId === void 0 ? void 0 : statusSessions?.get?.(statusSessionId);
					if (statusLive && statusTitles?.get) statusTitle = statusTitles.get(statusLive)?.title;
				} catch {}
				const statusModel = liveModelFor(statusKey);
				await durableReply(name, msg, formatStatusLine(status.get()) + "\n\n" + statusDetailLines(status.get()).join("\n") + "\n\n" + sessionStatusBlock({
					sessionId: statusSessionId,
					title: statusTitle,
					workspace: convCfg.get(statusKey).workspaceRoot ?? (getCfg().workspaceRoot || process.cwd()),
					preset: normalizeAgentPreset(convCfg.get(statusKey).preset ?? (getCfg().agentPreset || "ptc")),
					model: statusModel.provider && statusModel.model ? statusModel.provider + "/" + statusModel.model : void 0
				}));
				return true;
			}
			case "feishu-config":
			case "lark-config": {
				const arg = _rawInput.trim();
				if (!arg) {
					await durableReply(name, msg, formatStatusLine(status.get()) + "\n\n" + statusDetailLines(status.get()).join("\n"));
					return true;
				}
				const eq = arg.indexOf("=");
				if (eq === -1) {
					await durableReply(name, msg, "用法：/lark-config key=value（可热改: " + HOT_RELOADABLE.join(", ") + "；嵌套键用点路径，如 streaming.enabled=true）");
					return true;
				}
				const key = arg.slice(0, eq).trim();
				const rawVal = arg.slice(eq + 1).trim();
				let val = rawVal;
				if (rawVal === "true" || rawVal === "false") val = rawVal === "true";
				else if (rawVal !== "" && !Number.isNaN(Number(rawVal))) val = Number(rawVal);
				let presetAliasNote = "";
				if (key === "agentPreset" && typeof val === "string") {
					const normalized = normalizeAgentPreset(val);
					if (normalized !== val) presetAliasNote = `（已映射 ${val} → ${normalized}：DSH 无 code preset）`;
					val = normalized;
				}
				try {
					configStore.update(buildHotReloadPatch(key, val));
					configStore.saveOverrides();
				} catch (err) {
					await durableReply(name, msg, err instanceof Error && /not hot-reloadable/.test(err.message) ? `"${key}" 不可热改（可改: ${HOT_RELOADABLE.join(", ")}）` : `更新失败: ${err instanceof Error ? err.message : String(err)}`);
					return true;
				}
				await durableReply(name, msg, `已更新 ${key}=${JSON.stringify(val)}${presetAliasNote}`);
				return true;
			}
			case "support":
			case "doctor": {
				const diag = await diagnostics.build();
				const client = getLarkClient();
				if (client?.uploadFile) try {
					const key = bridge.conversationKeyFor(msg);
					const sessionId = bridge.backend?.get(key)?.sessionId ?? findLatestLarkSessionId();
					const zipBuf = sessionId ? await buildSessionExportZip(sessionId, diag.text, diag.issueMd) : void 0;
					if (zipBuf) {
						const fileName = `lark-plus-doctor-${Date.now()}.zip`;
						const uploadKey = extractUploadKey(await client.uploadFile({
							file_type: "file",
							file_name: fileName,
							file: zipBuf
						}), "file_key");
						if (uploadKey) {
							await sender.sendFile(msg.chatId, uploadKey, "file");
							return true;
						}
					}
					const fileName = `lark-plus-doctor-${Date.now()}.md`;
					const buf = Buffer.from(`# dsh-lark-plus 诊断包\n\n${diag.text}\n\n${diag.issueMd}\n`, "utf8");
					const uploadKey = extractUploadKey(await client.uploadFile({
						file_type: "file",
						file_name: fileName,
						file: buf
					}), "file_key");
					if (uploadKey) {
						await sender.sendFile(msg.chatId, uploadKey, "file");
						return true;
					}
				} catch (err) {
					logger.warn(`doctor file send failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				await durableReply(name, msg, diag.text);
				return true;
			}
			case "sessions": return bridgeHandler("resume", "", msg);
			case "help":
				await durableReply(name, msg, withButtons(helpCard(), commandPanelButtons()));
				return true;
			case "menu":
				await durableReply(name, msg, commandPanelCard());
				return true;
			case "workspace": {
				const arg = _rawInput.trim();
				const wsKey = bridge.conversationKeyFor(msg);
				const curWs = convCfg.get(wsKey).workspaceRoot ?? (getCfg().workspaceRoot || process.cwd());
				if (!arg) {
					await durableReply(name, msg, `工作区: ${curWs}`);
					return true;
				}
				const target = resolveWorkspaceTarget(arg, curWs);
				if (!isAbsoluteAny(target)) {
					await durableReply(name, msg, `无效路径: ${arg}`);
					return true;
				}
				try {
					if (!statSync(target).isDirectory()) {
						await durableReply(name, msg, `不是有效目录: ${target}`);
						return true;
					}
				} catch {
					await durableReply(name, msg, `目录不存在: ${target}`);
					return true;
				}
				convCfg.set(wsKey, {
					workspaceRoot: target,
					activeSessionId: void 0
				});
				await conversations?.rotate(bridge.conversationKeyFor(msg));
				await durableReply(name, msg, `工作区已切换: ${target}\n当前会话已重置，下一条消息在新工作区生效（其他会话不受影响）。`);
				return true;
			}
			case "resume": {
				const key = bridge.conversationKeyFor(msg);
				const wsRoot = convCfg.get(key).workspaceRoot ?? (getCfg().workspaceRoot || process.cwd());
				const currentSessionId = bridge.backend?.get(key)?.sessionId ?? convCfg.get(key).activeSessionId;
				const persistence = ctx.get?.("sessionPersistence");
				let sessions = [];
				const titleService = ctx.get?.("sessionTitle");
				const liveSessions = ctx.get?.("sessions");
				const titleFor = (sid) => {
					try {
						const sess = liveSessions?.get?.(sid);
						if (sess) {
							if (titleService?.get) {
								const res = titleService.get(sess);
								if (res?.title) return res.title;
							}
							if (sess.events) {
								const extracted = extractTitleFromEvents(sess.events);
								if (extracted) return extracted;
							}
						}
					} catch {}
				};
				try {
					sessions = await listWorkspaceSessions({
						sessionsRoot: join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "sessions"),
						cwd: wsRoot,
						persistence: persistence?.list ? {
							list: async () => await persistence.list(),
							inspect: persistence.inspect ? async (id) => await persistence.inspect(id) : void 0,
							load: persistence.load ? async (id) => await persistence.load(id) : void 0,
							readFrom: persistence.readFrom ? async (id, fromSeq) => await persistence.readFrom(id, fromSeq) : void 0
						} : void 0,
						titleFor
					});
				} catch (err) {
					logger.warn(`resume: listing workspace sessions failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				const arg = _rawInput.trim();
				if (!arg) {
					await sender.sendCard(msg.chatId, resumeCard(sessions, currentSessionId));
					return true;
				}
				let sel = arg;
				try {
					if (arg.includes("%")) sel = decodeURIComponent(arg);
				} catch {}
				const resumable = sessions.filter((s) => s.id !== currentSessionId);
				const pick = /^\d+$/.test(sel) ? resumable[Number(sel) - 1] : resumable.find((s) => s.id === sel || s.id.startsWith(sel) || s.id.endsWith(`:${sel}`));
				if (!pick) {
					await durableReply(name, msg, `未找到会话 «${arg}»（发送 /resume 查看当前工作区的历史会话）`);
					return true;
				}
				try {
					await bridge.backend?.resumeAgent(key, pick.id, pick.preset ? { preset: pick.preset } : void 0);
					const resumedHandle = bridge.backend?.get(key);
					resolveRawAgent(resumedHandle);
					await sender.sendCard(msg.chatId, buildSessionResumedCard({
						sessionId: pick.id,
						workspacePath: wsRoot,
						preset: pick.preset
					}));
				} catch (err) {
					await durableReply(name, msg, `恢复失败: ${err instanceof Error ? err.message : String(err)}`);
				}
				return true;
			}
			case "goal": {
				const key = bridge.conversationKeyFor(msg);
				const arg = _rawInput.trim();
				let agentHandle = bridge.backend?.get(key);
				if (!agentHandle) try {
					agentHandle = await bridge.backend?.ensureAgent?.(key);
				} catch {}
				const rawAgent = resolveRawAgent(agentHandle);
				const goalsService = ctx.get?.("goals");
				let currentGoal;
				try {
					currentGoal = rawAgent && goalsService?.get ? goalsService.get(rawAgent) : void 0;
				} catch {
					currentGoal = void 0;
				}
				if (!arg) {
					if (currentGoal) {
						let phaseLabel = "已暂停";
						if (currentGoal.phase === "active") phaseLabel = "执行中";
						else if (currentGoal.phase === "complete") phaseLabel = "已完成";
						await durableReply(name, msg, `🎯 当前目标 (${phaseLabel})：${currentGoal.objective}\n🔄 轮次：${currentGoal.roundsStarted}/${currentGoal.maxGoalRounds}\n💡 可发送 /goal pause 暂停、/goal resume 恢复、/goal clear 清除。`);
					} else await durableReply(name, msg, "🎯 **目标模式 (/goal)**：发送 `/goal <任务目标>` 即可启动目标长任务。\n\n常用命令：\n- `/goal <目标描述>`：设定新目标并开始自主执行\n- `/goal pause`：暂停当前目标\n- `/goal resume`：恢复执行目标\n- `/goal clear`：清除当前目标");
					return true;
				}
				if (arg === "pause") {
					if (!currentGoal) {
						await durableReply(name, msg, "当前没有正在运行的目标。");
						return true;
					}
					try {
						goalsService?.pause?.(rawAgent, {
							id: currentGoal.id,
							revision: currentGoal.revision
						});
						await durableReply(name, msg, "⏸ 目标已暂停。发送 /goal resume 可恢复执行。");
					} catch (err) {
						await durableReply(name, msg, `暂停失败: ${err instanceof Error ? err.message : String(err)}`);
					}
					return true;
				}
				if (arg === "resume") {
					if (!currentGoal) {
						await durableReply(name, msg, "当前没有可恢复的目标。");
						return true;
					}
					try {
						goalsService?.resume?.(rawAgent, {
							id: currentGoal.id,
							revision: currentGoal.revision
						});
						await durableReply(name, msg, "▶️ 目标已恢复执行。");
					} catch (err) {
						await durableReply(name, msg, `恢复失败: ${err instanceof Error ? err.message : String(err)}`);
					}
					return true;
				}
				if (arg === "clear") {
					if (!currentGoal) {
						await durableReply(name, msg, "当前没有活跃的目标。");
						return true;
					}
					try {
						goalsService?.clear?.(rawAgent, {
							id: currentGoal.id,
							revision: currentGoal.revision
						});
						await bridge.conversations?.stop(key);
						await durableReply(name, msg, "🛑 目标已清除并停止当前任务轮次。");
					} catch (err) {
						await durableReply(name, msg, `清除失败: ${err instanceof Error ? err.message : String(err)}`);
					}
					return true;
				}
				try {
					goalsService?.create?.(rawAgent, { objective: arg });
					await durableReply(name, msg, `🎯 已启动目标：${arg}\nAgent 将围绕该目标自主执行。`);
				} catch (err) {
					await durableReply(name, msg, `目标启动失败: ${err instanceof Error ? err.message : String(err)}`);
				}
				return true;
			}
			case "stop": {
				const key = bridge.conversationKeyFor(msg);
				await bridge.conversations?.stop(key);
				await durableReply(name, msg, "已停止当前会话任务");
				return true;
			}
			case "new": {
				const key = bridge.conversationKeyFor(msg);
				convCfg.set(key, { activeSessionId: void 0 });
				await conversations?.rotate(key);
				const newWs = convCfg.get(key).workspaceRoot ?? (getCfg().workspaceRoot || process.cwd());
				await durableReply(name, msg, `已开启新会话（工作区: ${newWs}）。下一条消息开始全新上下文。`);
				return true;
			}
			case "model": {
				const arg = _rawInput.trim();
				const modelKey = bridge.conversationKeyFor(msg);
				const mine = liveModelFor(modelKey);
				const llm = ctx.get?.("llm");
				const current = mine.provider && mine.model ? {
					provider: mine.provider,
					model: mine.model
				} : admService?.currentSelection?.();
				if (!arg) {
					const groups = [];
					const providers = llm?.listProviders?.() ?? [];
					for (const p of providers) {
						let models = [];
						try {
							models = await llm?.listModels?.(p.id ?? "") ?? [];
						} catch {}
						if (models.length > 0) groups.push({
							provider: p.id ?? "",
							label: p.name ?? p.id,
							models
						});
					}
					await sender.sendCard(msg.chatId, modelCard(current, groups));
					return true;
				}
				let provider = current?.provider ?? "";
				let model = arg;
				if (arg.includes("/")) {
					const [p, m] = arg.split("/");
					if (p) provider = p.trim();
					model = (m ?? "").trim();
				}
				if (!provider || !model) {
					await durableReply(name, msg, "用法：/model <provider>/<model> 或 /model <model>");
					return true;
				}
				convCfg.set(modelKey, {
					provider,
					model
				});
				const entry = liveModelFor(modelKey);
				entry.provider = provider;
				entry.model = model;
				entry.override = true;
				backend?.clearImageUnsupported?.(modelKey);
				await durableReply(name, msg, `模型已切换: ${provider}/${model}\n本会话下次回复生效（会话不中断，其他会话不受影响）。`);
				return true;
			}
			case "mode": {
				const live = backend ? await backend.listPresets() : [];
				const roster = live.length > 0 ? live : [...AGENT_PRESETS];
				const arg = _rawInput.trim().toLowerCase();
				const requested = arg ? normalizeAgentPreset(arg) : "";
				if (!arg) {
					const current = normalizeAgentPreset(getCfg().agentPreset);
					const unknownCurrent = live.length > 0 && !live.some((p) => p.id === current);
					await sender.sendCard(msg.chatId, withButtons(modeCard(current, roster), roster.filter((p) => !p.broken).map((p) => button(p.label, { op: `mode:${p.id}` }))));
					if (unknownCurrent) await durableReply(name, msg, `⚠️ 当前配置 agentPreset=${current} 不在 DSH roster（可用: ${live.map((p) => p.id).join(", ")}）——新建 agent 会失败。请点选模式切换，或 \`/lark-config agentPreset=<id>\`。`);
					return true;
				}
				if (!roster.some((p) => p.id === requested)) {
					await durableReply(name, msg, `未知模式 ${arg}（可用: ${roster.map((p) => p.id).join(", ")}）`);
					return true;
				}
				convCfg.set(bridge.conversationKeyFor(msg), {
					preset: requested,
					activeSessionId: void 0
				});
				await conversations?.rotate(bridge.conversationKeyFor(msg));
				const picked = roster.find((p) => p.id === requested);
				await durableReply(name, msg, `模式已切换为 ${picked?.label ?? requested}${picked?.trust === "user" ? "（自定义）" : ""}（当前会话已重置，下条消息生效；其他会话不受影响）`);
				return true;
			}
			case "permission": {
				const arg = _rawInput.trim().toLowerCase();
				if (!arg) {
					await sender.sendCard(msg.chatId, withButtons(permissionCard(getCfg().permissionMode), PERMISSION_PRESETS.map((p) => button(p.label, { op: `permission:${p.id}` }))));
					return true;
				}
				if (!PERMISSION_PRESETS.some((p) => p.id === arg)) {
					await durableReply(name, msg, `未知权限 ${arg}（可用: ${PERMISSION_PRESETS.map((p) => p.id).join(", ")}）`);
					return true;
				}
				try {
					const services = ctx;
					const sessionId = bridge.backend?.get(bridge.conversationKeyFor(msg))?.sessionId;
					const agent = sessionId ? (services.get?.("agents"))?.get?.(sessionId) : void 0;
					const permission = services.get?.("permissionPresets");
					if (agent?.session && permission?.apply) permission.apply(agent.session, arg, (policy) => {
						(services.get?.("approval"))?.setPolicy?.(agent, policy);
					});
				} catch (err) {
					logger.warn(`permission switch failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				configStore.update({ permissionMode: arg });
				configStore.saveOverrides();
				await durableReply(name, msg, `权限已切换为 ${arg}（仅桥接会话生效）`);
				return true;
			}
			case "lark": {
				const sub = _rawInput.trim().split(/\s+/)[0] ?? "";
				await durableReply(name, msg, await runLarkSubcommand(sub.toLowerCase()));
				return true;
			}
			default: return false;
		}
	};
	const commandRouter = createCommandRouter({
		ctx: bridge,
		commands: dshCommands,
		bridgeHandler
	});
	const handleCardAction = async (data) => {
		try {
			const raw = data;
			const value = raw.action?.value ?? {};
			const op = typeof value.op === "string" ? value.op : "";
			logger.info(`card action data: ${JSON.stringify(raw).slice(0, 600)}`);
			const chatId = raw.context?.open_chat_id ?? raw.operator?.operator_id?.open_id ?? raw.open_id ?? "";
			const messageId = raw.message?.message_id ?? "";
			if (!op) return;
			if (op.startsWith("uqam:")) {
				const questionId = op.slice(5);
				const pending = pendingQuestions.get(questionId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingQuestions.delete(questionId);
					const answer = (raw.action?.formValue)?.answer;
					const selected = (Array.isArray(answer) ? answer.map((v) => String(v)) : typeof answer === "string" && answer ? [answer] : []).map((v) => {
						const i = Number(v);
						return Number.isInteger(i) && pending.options[i] ? pending.options[i].label : v;
					});
					sender.sendText(pending.chatId, `已收到你的选择 ✅（${selected.join("、")}）`).catch(() => void 0);
					pending.resolve({
						id: questionId,
						selected
					});
				}
				return;
			}
			if (op.startsWith("uqa:")) {
				const parts = op.split(":");
				const questionId = parts[1] ?? "";
				const optionIndex = Number(parts[2] ?? NaN);
				const pending = pendingQuestions.get(questionId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingQuestions.delete(questionId);
					const label = pending.options[optionIndex]?.label ?? String(optionIndex);
					sender.sendText(pending.chatId, `已收到你的选择 ✅（${label}）`).catch(() => void 0);
					pending.resolve({
						id: questionId,
						selected: [label]
					});
				}
				return;
			}
			if (op === "task:toggle_fold") {
				const sessionKey = routeStore.all().find((r) => r.chatId === chatId)?.sessionKey ?? (chatId ? `dm:${chatId}` : "");
				if (sessionKey) {
					const isFolded = typeof value.folded === "boolean" ? value.folded : void 0;
					await taskCardSyncer.toggleFold(sessionKey, isFolded);
				}
				return;
			}
			if (op === "task:focus_board") {
				const sessionKey = routeStore.all().find((r) => r.chatId === chatId)?.sessionKey ?? (chatId ? `dm:${chatId}` : "");
				if (sessionKey) {
					const st = taskCardSyncer.getState(sessionKey);
					if (st) await sender.sendCard(chatId, buildTaskBoardCard(st));
					else await sender.sendText(chatId, "当前会话暂无活跃任务看板。");
				}
				return;
			}
			if (op.startsWith("plan:approve_goal:")) {
				const questionId = op.slice(18);
				const pending = pendingQuestions.get(questionId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingQuestions.delete(questionId);
					sender.sendText(pending.chatId, "已批准方案，正在启动目标执行 🚀").catch(() => void 0);
					pending.resolve({
						id: questionId,
						selected: ["Approve"]
					});
					const sessionKey = routeStore.all().find((r) => r.chatId === chatId)?.sessionKey ?? (chatId ? `dm:${chatId}` : "");
					const agentHandle = sessionKey ? bridge.backend?.get(sessionKey) : void 0;
					const rawAgent = resolveRawAgent(agentHandle);
					const goalsService = ctx.get?.("goals");
					if (rawAgent && goalsService?.create) try {
						const opt = pending.options[0];
						const firstLine = (opt?.description ?? opt?.label ?? "").split("\n")[0] || "执行已批准的规划方案";
						goalsService.create(rawAgent, { objective: firstLine });
					} catch {}
				}
				return;
			}
			if (op.startsWith("plan:approve_plain:")) {
				const questionId = op.slice(19);
				const pending = pendingQuestions.get(questionId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingQuestions.delete(questionId);
					sender.sendText(pending.chatId, "已批准方案 ✅，退出 Plan 模式继续执行。").catch(() => void 0);
					pending.resolve({
						id: questionId,
						selected: ["Approve"]
					});
				}
				return;
			}
			if (op.startsWith("plan:feedback:")) {
				const questionId = op.slice(14);
				const pending = pendingQuestions.get(questionId);
				if (pending) sender.sendText(pending.chatId, "请在聊天框直接回复你的修改建议 💬，Agent 将在 Plan 模式下调整方案。").catch(() => void 0);
				return;
			}
			if (op.startsWith("plan:cancel:")) {
				const questionId = op.slice(12);
				const pending = pendingQuestions.get(questionId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingQuestions.delete(questionId);
					sender.sendText(pending.chatId, "已放弃当前方案 🛑，退出 Plan 模式。").catch(() => void 0);
					const planModeService = ctx.get?.("planMode");
					const sessionKey = routeStore.all().find((r) => r.chatId === chatId)?.sessionKey ?? (chatId ? `dm:${chatId}` : "");
					const agentHandle = sessionKey ? bridge.backend?.get(sessionKey) : void 0;
					const rawAgent = resolveRawAgent(agentHandle);
					if (rawAgent && planModeService?.set) try {
						planModeService.set(rawAgent, false);
					} catch {}
					pending.resolve({
						id: questionId,
						selected: ["Keep planning"]
					});
				}
				return;
			}
			if (op.startsWith("goal:tpl:")) {
				const tpl = op.slice(9);
				const sessionKey = routeStore.all().find((r) => r.chatId === chatId)?.sessionKey ?? (chatId ? `dm:${chatId}` : "");
				convCfg.get(sessionKey).workspaceRoot ?? (getCfg().workspaceRoot || process.cwd());
				let obj = "构建工程并运行全量测试验证";
				if (tpl === "fix") obj = "诊断并修复当前工程中的已知问题与测试失败";
				else if (tpl === "refactor") obj = "重构核心模块并补齐单元测试与文档";
				let agentHandle = sessionKey ? bridge.backend?.get(sessionKey) : void 0;
				if (!agentHandle && sessionKey) try {
					agentHandle = await bridge.backend?.ensureAgent?.(sessionKey);
				} catch {}
				const rawAgent = resolveRawAgent(agentHandle);
				const goalsService = ctx.get?.("goals");
				try {
					if (rawAgent && goalsService?.create) goalsService.create(rawAgent, { objective: obj });
					await sender.sendText(chatId, `🎯 已设定目标：${obj}\nAgent 将围绕该目标自主执行。`);
				} catch (err) {
					await sender.sendText(chatId, `设定目标失败: ${err instanceof Error ? err.message : String(err)}`);
				}
				return;
			}
			const sep = op.indexOf(":");
			const cmd = sep === -1 ? op : op.slice(0, sep);
			const arg = sep === -1 ? "" : op.slice(sep + 1);
			const knownRoute = routeStore.all().find((r) => r.chatId === chatId);
			const pseudo = {
				messageId: messageId ? `${messageId}#${op}` : `card#${Date.now()}#${op}`,
				chatId,
				chatType: knownRoute?.chatType === "group" ? "group" : "p2p",
				chatMode: knownRoute?.chatType === "group" ? "group_all" : "p2p",
				senderOpenId: chatId,
				msgType: "interactive",
				content: "",
				text: "",
				mentions: [],
				timestamp: Date.now()
			};
			await bridgeHandler(cmd, arg, pseudo);
		} catch (err) {
			logger.error(`card action failed: ${String(err)}`);
		}
	};
	const sessionPersistenceService = ctx.get?.("sessionPersistence");
	const replaySalvage = createReplaySalvage({
		loadSession: async (id) => sessionPersistenceService?.load?.(id),
		enqueue: (input) => outbox.enqueue(input),
		wal: inboundWal,
		logger
	});
	const messageHandler = createMessageHandler({
		ctx: bridge,
		commands: commandRouter,
		groupTrigger,
		dedupe,
		allowlist: () => getCfg().allowlist,
		wal: inboundWal,
		inboundDir: getCfg().attachments.dir.trim() || join(tmpdir(), "dsh-lark-plus", "inbound"),
		voice,
		transcribeAudio: voiceEnabled
	});
	const turnDelivered = /* @__PURE__ */ new Set();
	const conversations = createConversationManager({
		backend,
		maxSessions: getCfg().maxSessions,
		idleTtlMs: getCfg().sessionIdleTtlMs,
		logger,
		onEvent: (key, event) => {
			forwarder.onSessionEvent(key, event).catch((e) => logger.warn(`forwarder: ${String(e)}`));
			if (event.type === "turn/start") {
				turnDelivered.delete(key);
				streamHandles.delete(key);
				turnSupervisor.arm(key);
			}
			if (event.type === "assistant/chunk") {
				if ((event.text ?? "").trim() !== "") turnSupervisor.arm(key);
			}
			if (event.type === "tool/call" || event.type === "tool/result") turnSupervisor.arm(key);
			if (event.type === "assistant/message") {
				if ((event.text ?? "").trim() !== "") {
					turnSupervisor.disarm(key);
					turnDelivered.add(key);
				} else turnSupervisor.arm(key);
			}
			if (event.type === "turn/end") {
				turnSupervisor.disarm(key);
				streamHandles.delete(key);
				const reason = event.reason;
				const silent = !turnDelivered.has(key) && (reason === "rejected" || reason === "failed" || reason === "error");
				turnDelivered.delete(key);
				if (silent && backend.consumeImageRetryGrace?.(key)) logger.warn(`turn ended '${reason}' for ${key} but an image-degrade retry is in flight; skipping error notice`);
				else if (silent) {
					logger.warn(`turn ended '${reason}' with no output for ${key}`);
					const chatId = routeStore.get(key)?.chatId;
					if (chatId) sender.sendText(chatId, `⚠️ 本轮没有产出回复（turn ended: ${reason}）。请再发一条消息重试。若仍无回复，请检查 /model 是否指向可用的模型。`).catch(() => void 0);
				}
			}
		}
	});
	const turnSupervisor = createTurnSupervisor({
		backend,
		timeoutMs: 6e5,
		logger
	});
	const compensation = createMissedCompensation({
		routes: routeStore,
		listMessages: (p) => sender.listMessages(p),
		reinject: (msg) => messageHandler.handleCompensated(msg),
		logger
	});
	let lastModelSig = liveModelSelection.provider && liveModelSelection.model ? `${liveModelSelection.provider}/${liveModelSelection.model}` : "";
	let modelPollTimer;
	const startModelDefaultPoll = () => {
		if (modelPollTimer || !admService?.currentSelection) return;
		const t = setInterval(() => {
			try {
				const cur = admService?.currentSelection?.();
				if (!cur?.provider || !cur.model) return;
				const sig = `${cur.provider}/${cur.model}`;
				if (sig === lastModelSig) return;
				lastModelSig = sig;
				liveModelSelection.provider = cur.provider;
				liveModelSelection.model = cur.model;
				logger.info(`bridge default model now ${sig} (GUI-side switch)`);
			} catch {}
		}, 1e4);
		t.unref?.();
		modelPollTimer = t;
	};
	const stopModelDefaultPoll = () => {
		if (modelPollTimer) clearInterval(modelPollTimer);
		modelPollTimer = void 0;
	};
	let lifecycleStarted = false;
	let supervisor;
	const startBridge = async () => {
		if (lifecycleStarted) return;
		const ref = getCfg().credentialRef;
		const creds = await resolveCredentials(credStore, ref);
		if (!creds) {
			startBlocker = `未配置飞书凭据（ref=${ref}）。请先运行 /lark setup 扫码，或设置 DSH_LARK_APP_ID/DSH_LARK_APP_SECRET 后再 /lark setup。`;
			logger.warn(startBlocker);
			return;
		}
		startBlocker = void 0;
		logger.info("starting bridge…");
		try {
			larkClient = await buildLarkClient({
				appId: creds.appId,
				appSecret: creds.appSecret,
				domain: creds.domain,
				logger
			});
		} catch (err) {
			startBlocker = `lark client 构建失败: ${err instanceof Error ? err.message : String(err)}`;
			logger.error(startBlocker);
			return;
		}
		bridge.setConversations(conversations);
		bridge.setOutbox(outbox);
		bridge.setForwarder(forwarder);
		bridge.setCompensation(compensation);
		outbox.rebuildFromDisk();
		outbox.start();
		turnSupervisor.start();
		startModelDefaultPoll();
		const transport = createTransport({
			getClient: () => larkClient ?? {},
			onMessage: async (msg) => {
				const pendingForChat = [...pendingQuestions.values()].find((p) => p.chatId === msg.chatId);
				if (pendingForChat && (msg.text ?? "").trim() !== "") {
					clearTimeout(pendingForChat.timer);
					pendingQuestions.delete(pendingForChat.questionId);
					const text = (msg.text ?? "").trim();
					pendingForChat.resolve({
						id: pendingForChat.questionId,
						selected: [],
						custom: text
					});
					return;
				}
				await messageHandler.handleInbound(msg);
			},
			onEvent: (event, data) => {
				if (event === "card.action.trigger") handleCardAction(data);
			},
			logger
		});
		bridge.setTransport(transport);
		supervisor = createConnectionSupervisor({
			transport,
			quota: createQuotaGovernor(join(dir, "conn-history.jsonl"), {
				windowMinutes: getCfg().quota.windowMinutes,
				limit: getCfg().quota.limit
			}),
			status,
			cfg: {
				probeIntervalMs: getCfg().supervisor.probeIntervalMs,
				probeTimeoutMs: getCfg().supervisor.probeTimeoutMs,
				probeFailThreshold: getCfg().supervisor.probeFailThreshold,
				maxReconnectAttempts: getCfg().supervisor.maxReconnectAttempts,
				idleKeepaliveMs: getCfg().supervisor.idleKeepaliveMs,
				quotaWindowMinutes: getCfg().quota.windowMinutes,
				quotaLimit: getCfg().quota.limit
			},
			logger,
			onStateChange: (state, detail) => {
				if (state === "connected") bridge.setBotOpenId(transport.botOpenId());
				logger.info(`conn state: ${state}${detail ? ` (${detail})` : ""}`);
			}
		});
		await supervisor.start();
		bridge.setBotOpenId(transport.botOpenId());
		status.refreshCounters({
			outboxPending: outbox.pendingCount(),
			outboxFailed: outbox.failedCount(),
			inboundPending: inboundWal.pendingReplays().length,
			inboundFailed: inboundWal.failedCount()
		});
		status.setConn("connected", { wsReady: transport.wsReady() });
		bridge.setStarted(true);
		lifecycleStarted = true;
		(async () => {
			let replayed = 0;
			let salvaged = 0;
			try {
				inboundWal.prune();
				for (const rec of inboundWal.pendingReplays()) {
					if (!inboundWal.markReplay(rec.messageId)) continue;
					const sessionId = convCfg.get(rec.sessionKey).activeSessionId;
					if (await replaySalvage.salvage(rec, sessionId)) {
						salvaged++;
						continue;
					}
					try {
						await messageHandler.handleCompensated({
							messageId: rec.messageId,
							chatId: rec.chatId,
							chatType: rec.chatType,
							chatMode: rec.chatType === "p2p" ? "p2p" : "group_all",
							senderOpenId: rec.senderOpenId,
							msgType: "text",
							content: rec.text,
							text: rec.text,
							mentions: [],
							timestamp: rec.acceptedAt
						});
						replayed++;
					} catch (err) {
						logger.warn(`inbound replay failed for ${rec.messageId}: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
				if (replayed > 0 || salvaged > 0) logger.info(`inbound replay: ${salvaged} answered from session logs, ${replayed} re-dispatched`);
				status.refreshCounters({
					inboundPending: inboundWal.pendingReplays().length,
					inboundFailed: inboundWal.failedCount()
				});
			} catch (err) {
				logger.warn(`inbound replay errored: ${err instanceof Error ? err.message : String(err)}`);
			}
		})();
		logger.info("bridge started (in-process) [HMR-RELOAD-MARKER-2]");
	};
	const stopBridge = async () => {
		if (!lifecycleStarted) return;
		logger.info("stopping bridge…");
		turnSupervisor.stop();
		stopModelDefaultPoll();
		await supervisor?.stop();
		supervisor = void 0;
		await outbox.stop();
		await conversations.disposeAll();
		bridge.setStarted(false);
		status.setConn("stopped");
		lifecycleStarted = false;
		logger.info("bridge stopped");
	};
	ctx.tools.register(defineTool({
		name: "lark_send_local_file",
		description: "Send a local file or image to the current Feishu chat.",
		parameters: {
			path: {
				type: "string",
				required: true,
				description: "Absolute local path"
			},
			kind: {
				type: "string",
				required: true,
				description: "image（png/jpeg/webp/gif，其他格式如 svg 自动按 file 发送）| file"
			},
			caption: {
				type: "string",
				description: "Optional caption text"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		async execute(args, exec) {
			const sessionId = exec.agent?.id ?? "";
			const convKeyForWs = bridge.backend?.keyForSessionId?.(sessionId) ?? sessionId;
			const workspaceRoot = convCfg.get(convKeyForWs).workspaceRoot ?? (getCfg().workspaceRoot || process.cwd());
			const { abs, ok: inWorkspace } = resolveInWorkspacePath(args.path, workspaceRoot);
			if (!inWorkspace) return "拒绝: 路径不在工作区内";
			const key = bridge.backend?.keyForSessionId?.(sessionId) ?? (sessionId.startsWith("lark-plus:") ? sessionId.slice(10).replace(/:[a-z0-9]{8,}$/, "") : sessionId);
			const route = routeStore.get(key);
			if (!route) return "错误: 无法定位当前飞书会话";
			const client = getLarkClient();
			if (!client) return "错误: lark 客户端未就绪";
			const isImage = args.kind === "image" && /\.(png|jpe?g|webp|gif)$/i.test(args.path);
			if (isImage ? !client.uploadImage : !client.uploadFile) return "错误: lark 客户端未就绪";
			let buf;
			try {
				if (statSync(abs).size > 26214400) return "错误: 文件超过 25MB 上限";
				buf = readFileSync(abs);
			} catch (err) {
				return `错误: 读取文件失败 (${err instanceof Error ? err.message : String(err)})`;
			}
			const fileName = args.path.split(/[\\/]/).pop() ?? "file";
			let uploadKey;
			if (isImage) uploadKey = extractUploadKey(await client.uploadImage({ image: buf }), "image_key");
			else uploadKey = extractUploadKey(await client.uploadFile({
				file_type: "file",
				file_name: fileName,
				file: buf
			}), "file_key");
			if (!uploadKey) return "错误: 上传失败";
			await sender.sendFile(route.chatId, uploadKey, isImage ? "image" : "file");
			return `已发送 ${args.path}`;
		}
	}));
	ctx.tools.register(defineTool({
		name: "lark_config_get",
		description: "Read bridge config (hot-reloadable keys).",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_a, v) => [{
				type: "text",
				text: v
			}]
		},
		async execute() {
			return JSON.stringify(getCfg(), null, 2);
		}
	}));
	const commandsCtx = ctx;
	const registerCmd = (name, description, handler, inputHint) => {
		commandsCtx.commands?.register?.({
			name,
			description,
			...inputHint !== void 0 ? { input: { hint: inputHint } } : {},
			handler: async (inv) => ({
				kind: "success",
				text: await handler(inv?.rawInput ?? "")
			})
		});
	};
	const runLarkSubcommand = async (sub) => {
		switch (sub) {
			case "status": return formatStatusLine(status.get());
			case "start":
				await startBridge();
				return lifecycleStarted ? "bridge started" : startBlocker ?? "bridge 未启动";
			case "stop":
				await stopBridge();
				return "bridge stopped";
			case "restart":
				await stopBridge();
				await startBridge();
				return lifecycleStarted ? "bridge restarted" : startBlocker ?? "bridge 未启动";
			case "setup": return await runSetup();
			case "uninstall-clean": return await runUninstallClean();
			default: return "Lark Link 用法：/lark setup | start | stop | restart | status | uninstall-clean";
		}
	};
	registerCmd("lark-plus", "Feishu/Lark bridge — usage: /lark setup|start|stop|restart|status|uninstall-clean", async (rawInput) => runLarkSubcommand((rawInput.trim().split(/\s+/)[0] ?? "").toLowerCase()), "setup|start|stop|restart|status|uninstall-clean");
	/**
	* Locate the DSH session log for a bridge session id. Persisted logs live
	* at <DSH_HOME>/sessions/<workspace-dir>/<encoded-session-id>/session.jsonl.zstd
	* where ":" encodes as "~003A" — scan every workspace dir for the match.
	*/
	/** Scan ~/.dsh/sessions for the most recently written lark-plus session id. */
	const findLatestLarkSessionId = () => {
		const sessionsRoot = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "sessions");
		if (!existsSync(sessionsRoot)) return void 0;
		let latest;
		for (const wsDir of readdirSync(sessionsRoot)) {
			const wsPath = join(sessionsRoot, wsDir);
			let entries = [];
			try {
				entries = readdirSync(wsPath);
			} catch {
				continue;
			}
			for (const name of entries) {
				if (!name.includes("lark-plus")) continue;
				const sessionDir = join(wsPath, name);
				const zstd = join(sessionDir, "session.jsonl.zstd");
				if (!existsSync(zstd)) continue;
				let mtime = 0;
				try {
					mtime = statSync(zstd).mtimeMs;
				} catch {
					continue;
				}
				if (!latest || mtime > latest.mtime) latest = {
					id: name.replace(/~003A/g, ":"),
					mtime
				};
			}
		}
		return latest?.id;
	};
	const buildSessionExportZip = async (sessionId, diagText, issueMd) => {
		try {
			const services = ctx;
			const persistence = services.get?.("sessionPersistence");
			const query = services.get?.("sessionQuery");
			const files = [];
			let root;
			if (persistence?.readRaw) try {
				root = await persistence.readRaw(sessionId);
			} catch (err) {
				logger.warn(`doctor: sessionPersistence.readRaw failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			else logger.warn("doctor: sessionPersistence service unavailable — falling back to file scan");
			if (root) {
				files.push({
					name: root.filename,
					data: Buffer.from(root.content, "utf8")
				});
				const seen = /* @__PURE__ */ new Set([sessionId]);
				const collect = async (nodes) => {
					for (const node of nodes) {
						const id = node.session.header.id;
						if (seen.has(id)) continue;
						seen.add(id);
						const raw = await persistence?.readRaw?.(id);
						if (raw !== void 0) {
							const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
							files.push({
								name: `subagents/${safe}/${raw.filename}`,
								data: Buffer.from(raw.content, "utf8")
							});
						}
						await collect(node.descendants ?? []);
					}
				};
				if (query?.traceSession) try {
					await collect((await query.traceSession(sessionId)).descendants);
				} catch (err) {
					logger.warn(`doctor: traceSession failed (subagents skipped): ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			if (files.length === 0) {
				const sessionsRoot = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "sessions");
				const encoded = sessionId.replace(/:/g, "~003A");
				let zstdPath;
				if (existsSync(sessionsRoot)) for (const wsDir of readdirSync(sessionsRoot)) {
					const candidate = join(sessionsRoot, wsDir, encoded, "session.jsonl.zstd");
					if (existsSync(candidate)) {
						zstdPath = candidate;
						break;
					}
				}
				if (!zstdPath) {
					logger.warn(`doctor: no session log found for ${sessionId} (service + file scan)`);
					return;
				}
				const jsonl = zstdDecompressSync(readFileSync(zstdPath)).toString("utf8");
				logger.info(`doctor: file-scan fallback used: ${zstdPath}`);
				files.push({
					name: "session.jsonl",
					data: Buffer.from(jsonl, "utf8")
				});
			}
			files.push({
				name: "ISSUE.md",
				data: Buffer.from(`# dsh-lark-plus 诊断包\n\n${diagText}\n\n${issueMd}\n`, "utf8")
			});
			files.push({
				name: "README.txt",
				data: Buffer.from([
					"本压缩包内容：",
					"- session.jsonl: 当前会话的 DSH session log（与 WebUI 右上角 Session log 下载一致）",
					"- subagents/: 子代理会话日志",
					"- ISSUE.md: 脱敏诊断信息（配置/连接状态/Outbox 等）",
					"",
					"将本包直接发给维护者，或贴 ISSUE.md 给 AI 即可定位问题。"
				].join("\n"), "utf8")
			});
			const { zipSync, strToU8 } = await import("fflate");
			const entries = {};
			for (const f of files) entries[f.name] = strToU8(new TextDecoder().decode(f.data));
			const buf = Buffer.from(zipSync(entries, { level: 6 }));
			logger.info(`doctor: zip built (${files.length} files, ${buf.length} bytes)`);
			return buf;
		} catch (err) {
			logger.warn(`doctor: zip build failed: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
	};
	const runSetup = async () => {
		const ref = getCfg().credentialRef;
		const envAppId = process.env.DSH_LARK_APP_ID?.trim();
		const envSecret = process.env.DSH_LARK_APP_SECRET?.trim();
		if (envAppId && envSecret) {
			const envDomain = process.env.DSH_LARK_DOMAIN === "lark" ? "lark" : "feishu";
			await persistCredentials(credStore, ref, {
				appId: envAppId,
				appSecret: envSecret,
				domain: envDomain
			});
			return `凭据已保存（env 手动，appId=${maskId(envAppId)}，domain=${envDomain}）。运行 /lark start 启动。`;
		}
		let qrInfo;
		(async () => {
			const setup = createAuthSetup({
				registerApp: registerAppWithFetch(),
				persist: async (c) => {
					await persistCredentials(credStore, ref, c);
				},
				logger
			});
			try {
				const res = await setup.run({
					onQRCodeReady(info) {
						qrInfo = info;
						QRCode.toBuffer(info.url, {
							type: "png",
							margin: 1,
							width: 256
						}).then((png) => {
							activeQr = {
								png,
								expireAt: Date.now() + info.expireIn * 1e3
							};
						}).catch((e) => logger.warn(`qr png failed: ${e instanceof Error ? e.message : String(e)}`));
						try {
							qrcode.generate(info.url, { small: true }, (qr) => console.log(`\n${qr}`));
						} catch {}
					},
					onStatusChange: (s) => logger.info(`setup: ${s}`)
				});
				logger.info(`setup complete: appId=${res.appId} domain=${res.domain}`);
				activeQr = void 0;
			} catch (err) {
				logger.warn(`setup background failed: ${err instanceof Error ? err.message : String(err)}`);
				activeQr = void 0;
			}
		})();
		const deadline = Date.now() + 3e4;
		while (!qrInfo && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
		if (!qrInfo) return "扫码流程未在 30s 内就绪。可改用手动通道：设 DSH_LARK_APP_ID + DSH_LARK_APP_SECRET 后再 /lark setup。";
		console.log(`飞书授权二维码链接: ${qrInfo.url}（${qrInfo.expireIn} 秒后过期）`);
		return [
			"📱 飞书授权二维码已生成 —— 见左侧 🪶 Lark 面板（或终端），手机飞书扫码确认。",
			"",
			`二维码 ${qrInfo.expireIn} 秒后过期。扫码后凭据在后台写入，运行 /lark start 启动。`,
			`备用链接（手机浏览器打开）：${qrInfo.url}`,
			"看不到二维码？终端也打印了；或用 DSH_LARK_APP_ID/SECRET 手动通道。"
		].join("\n");
	};
	const runUninstallClean = async () => {
		await stopBridge();
		const ref = getCfg().credentialRef;
		await clearCredentials(credStore, ref);
		larkClient = void 0;
		for (const f of [
			"config.json",
			"routes.json",
			"dedupe.jsonl",
			"conn-history.jsonl",
			"status.json",
			"runtime-overrides.json"
		]) try {
			rmSync(join(dir, f), { force: true });
		} catch {}
		try {
			rmSync(join(dir, "outbox"), {
				recursive: true,
				force: true
			});
		} catch {}
		try {
			rmSync(join(dir, "inbound-wal"), {
				recursive: true,
				force: true
			});
		} catch {}
		return `已清除凭据（ref=${ref}）并清理状态目录 ${dir}。重新使用请运行 /lark setup。`;
	};
	try {
		ctx.systemPrompt?.section?.({
			priority: 200,
			section: () => ({
				role: "system",
				content: [
					"你正在通过飞书/Lark 桥接与用户对话。",
					"可用工具: lark_send_local_file（发送本地文件到当前飞书会话）、lark_config_get（读取桥配置）。",
					"回复要简洁；长输出会自动流式呈现给用户。"
				].join("\n")
			})
		});
	} catch {}
	ctx.effect(() => {
		startBridge();
		const stopMediaSweeper = startMediaSweeper({
			mediaDir: join(getCfg().attachments.dir.trim() || join(tmpdir(), "dsh-lark-plus", "inbound"), "media"),
			retentionHours: () => getCfg().attachments.retentionHours,
			logger
		});
		const sweep = setInterval(() => {
			if (conversations.sweep() > 0) status.refreshCounters({
				outboxPending: outbox.pendingCount(),
				outboxFailed: outbox.failedCount(),
				inboundPending: inboundWal.pendingReplays().length,
				inboundFailed: inboundWal.failedCount()
			});
		}, 6e4);
		sweep.unref?.();
		return async () => {
			clearInterval(sweep);
			stopMediaSweeper();
			await stopBridge();
		};
	});
}
//#endregion
export { apply, inject, name, resolveInboundAttachments, stateDir };
