// Workspace session listing for the Feishu-side /resume command.
//
// Lists the HISTORICAL DSH sessions of one workspace (cwd) so a Feishu chat can
// pick one up again. Two layered sources (same discipline as doctor's export):
//
//   1. sessionPersistence service (preferred): headers carry createdAt, cwd,
//      agentPreset and origin — exact cwd equality, subagent children excluded.
//   2. filesystem scan (fallback): <DSH_HOME>/sessions/<projectKey(cwd)>/<encoded-id>/
//      session.jsonl.zstd, decoded + mtime-sorted. The projectKey encoding is
//      ported VERBATIM from dsh-session-persistence-jsonl (lossy by design —
//      separators collapse, unsafe code units escape as ~XXXX) so the scan
//      lands in exactly the directory DSH writes.
//
// Harness-agnostic: the service is injected as a narrow structural interface.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

/** Header-like row of the DSH sessionPersistence service (structural slice). */
export interface SessionHeaderLike {
	id: string;
	createdAt: number;
	cwd?: string;
	agentPreset?: string;
	origin?: string;
	title?: string;
}

export interface WorkspaceSessionInfo {
	id: string;
	/** epoch ms — header createdAt (service) or log mtime (scan). */
	createdAt: number;
	/** stored agentPreset — present on the service source only. */
	preset?: string;
	/** Human-readable session title (if available). */
	title?: string;
	source: "service" | "scan";
}

export interface PersistenceListSource {
	list(signal?: AbortSignal): Promise<SessionHeaderLike[]>;
	inspect?(id: string, signal?: AbortSignal): Promise<{ meta?: unknown; events?: readonly unknown[] } | undefined>;
	load?(id: string): Promise<{ header?: unknown; events?: readonly unknown[] } | undefined>;
	readFrom?(id: string, fromSeq: number): Promise<{ meta?: unknown; events?: readonly unknown[] } | undefined>;
}


/** Newest session-log file in one session directory, or undefined.
 *
 * DSH renamed the log to session.v4.jsonl.zstd; matching only the old
 * "session.jsonl.zstd" name made every scan-sourced listing empty (the GUI
 * showed sessions but /resume answered "该工作区暂无历史会话日志"). */
export function sessionLogPath(sessionDir: string): string | undefined {
	let names: string[];
	try {
		names = readdirSync(sessionDir);
	} catch {
		return undefined;
	}
	let best: string | undefined;
	let bestMtime = -1;
	for (const entry of names) {
		if (!/^session(\.[A-Za-z0-9]+)?\.jsonl(\.zstd)?$/.test(entry)) continue;
		let mtime: number;
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
export function titleFromSessionLog(logPath: string): string | undefined {
	try {
		const raw = readFileSync(logPath);
		const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
		const offsets: number[] = [];
		let at = raw.indexOf(magic);
		if (at < 0) return undefined;
		while (at >= 0) {
			offsets.push(at);
			at = raw.indexOf(magic, at + 4);
		}
		let text = "";
		for (let i = 0; i < offsets.length; i += 1) {
			const start = offsets[i] ?? 0;
			const end = i + 1 < offsets.length ? (offsets[i + 1] ?? raw.length) : raw.length;
			try {
				text += zstdDecompressSync(raw.subarray(start, end)).toString("utf8");
			} catch {
				// a damaged frame only costs its own records
			}
		}
		let title: string | undefined;
		for (const line of text.split("\n")) {
			if (!line.includes("session/title")) continue;
			try {
				const record = JSON.parse(line) as { type?: string; data?: { title?: string } };
				if (record.type !== "session/title") continue;
				const value = record.data?.title?.trim();
				if (value) title = value.slice(0, 36);
			} catch {
				// ignore malformed lines
			}
		}
		return title;
	} catch {
		return undefined;
	}
}

export interface ListWorkspaceSessionsDeps {
	/** DSH sessions root — <DSH_HOME>/sessions. */
	sessionsRoot: string;
	/** the workspace whose sessions to list. */
	cwd: string;
	/** live sessionPersistence service (optional — scan fallback otherwise). */
	persistence?: PersistenceListSource;
	/** Optional title resolver for session ids. */
	titleFor?: (sessionId: string) => string | undefined;
	/** ids to hide (e.g. this conversation's CURRENT session). */
	exclude?: string[];
	/** cap (default 10). */
	limit?: number;
}

/**
 * Extract a human-readable title from a session's events:
 * 1. session/title event (highest precedence)
 * 2. first user message text (deterministic fallback)
 */
export function extractTitleFromEvents(events: readonly unknown[]): string | undefined {
	if (!Array.isArray(events) || events.length === 0) return undefined;
	// 1. Look for explicit session/title event from the end
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i] as { type?: string; data?: { title?: string } };
		if (ev?.type === "session/title" && ev.data?.title) {
			const t = ev.data.title.trim();
			if (t) return t.slice(0, 36);
		}
	}
	// 2. Look for first human text-bearing user message
	for (let i = 0; i < events.length; i++) {
		const ev = events[i] as {
			type?: string;
			data?: {
				source?: { kind?: string };
				content?: Array<{ type?: string; text?: string }>;
			};
		};
		if (ev?.type === "user/message") {
			const text = (ev.data?.content ?? [])
				.filter((b) => b?.type === "text" && typeof b.text === "string")
				.map((b) => b.text?.trim())
				.filter(Boolean)
				.join(" ");
			if (text) {
				const clean = text.replace(/^\/[a-zA-Z0-9_-]+\s*/, "").trim();
				const candidate = clean || text;
				const oneLine = candidate.replace(/[\r\n\t]+/g, " ").trim();
				if (oneLine) return oneLine.slice(0, 36);
			}
		}
	}
	return undefined;
}

/**
 * Port of dsh-session-persistence-jsonl's projectKey: `/`, `\` and `:` become
 * `-` (consecutive runs collapse), safe `[A-Za-z0-9._-]` passes, everything
 * else escapes as `~XXXX` (uppercase hex code unit); wrapped `--…--` with the
 * readable part bounded to 251 chars and `root` when empty.
 */
export function projectKeyOf(cwd: string): string {
	if (cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const ch = cwd[i] as string;
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
export function decodeSessionDirName(name: string): string {
	return name.replace(/~([0-9A-Fa-f]{4})/g, (_m, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	);
}

/** List historical sessions of one workspace, newest first, capped. */
export async function listWorkspaceSessions(
	deps: ListWorkspaceSessionsDeps,
): Promise<WorkspaceSessionInfo[]> {
	const limit = deps.limit ?? 10;
	const exclude = new Set(deps.exclude ?? []);
	let rows: WorkspaceSessionInfo[] = [];

	// Source 1: the persistence service — headers give exact cwd + origin.
	if (deps.persistence?.list) {
		try {
			const headers = await deps.persistence.list();
			rows = headers
				.filter(
					(h) =>
						h.cwd === deps.cwd &&
						h.origin !== "subagent" &&
						!exclude.has(h.id),
				)
				.sort((a, b) => b.createdAt - a.createdAt)
				.slice(0, limit)
				.map<WorkspaceSessionInfo>((h) => {
					const title = deps.titleFor?.(h.id) ?? h.title;
					return {
						id: h.id,
						createdAt: h.createdAt,
						...(h.agentPreset ? { preset: h.agentPreset } : {}),
						...(title ? { title } : {}),
						source: "service",
					};
				});
		} catch {
			// fall through to the filesystem scan
		}
	}

	// Source 2: filesystem scan of <sessionsRoot>/<projectKey(cwd)>/.
	if (rows.length === 0) {
		const dir = join(deps.sessionsRoot, projectKeyOf(deps.cwd));
		if (existsSync(dir)) {
			for (const name of readdirSync(dir)) {
				const log = sessionLogPath(join(dir, name));
				if (log === undefined) continue; // no materialized log — not resumable
				let mtime: number;
				try {
					mtime = statSync(log).mtimeMs;
				} catch {
					continue; // no materialized log — not resumable
				}
				const id = decodeSessionDirName(name);
				if (exclude.has(id)) continue;
				const title = deps.titleFor?.(id) ?? titleFromSessionLog(log);
				rows.push({ id, createdAt: mtime, ...(title ? { title } : {}), source: "scan" });
			}
			rows.sort((a, b) => b.createdAt - a.createdAt);
			rows = rows.slice(0, limit);
		}
	}

	// Resolve titles from persistence events if not already present
	if (deps.persistence && rows.length > 0) {
		await Promise.allSettled(
			rows.map(async (row) => {
				if (row.title) return;
				if (deps.titleFor) {
					const t = deps.titleFor(row.id);
					if (t) {
						row.title = t;
						return;
					}
				}
				try {
					let events: readonly unknown[] | undefined;
					if (deps.persistence?.inspect) {
						const res = await deps.persistence.inspect(row.id);
						events = res?.events;
					} else if (deps.persistence?.load) {
						const res = await deps.persistence.load(row.id);
						events = res?.events;
					} else if (deps.persistence?.readFrom) {
						const res = await deps.persistence.readFrom(row.id, 0);
						events = res?.events;
					}
					if (events) {
						const extracted = extractTitleFromEvents(events);
						if (extracted) row.title = extracted;
					}
				} catch {
					// best-effort
				}
			}),
		);
	}

	return rows;
}


