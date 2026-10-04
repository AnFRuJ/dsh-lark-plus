// dsh-lark-plus client half (browser). Reuses the DSH Web GUI entirely
// (spec §7). This client adds one surface — a sidebar footer action whose
// popover is a small STATE MACHINE over (configured × connection):
//   not-configured → show the setup QR
//   configured + stopped/idle → "ready, run /lark start"
//   configured + connecting → "connecting…"
//   configured + connected → "running" (stop/restart)
//   configured + degraded/quarantined → "error"
// State comes from the host /plugins/lark-plus/status route (JSON: connState,
// outbox counters, configured). The QR is a host-served PNG at
// /plugins/lark-plus/qr (the GUI markdown image sanitizer drops data: URLs,
// and a plugin can't push over ctx.remote — so we poll a local image we own).
//
// Slot registration: `sidebar.footer.action` is a `list` slot (declared by
// ui-sidebar); `register` takes the parent name + an entry `id`. The component
// owns its open/close state; the popover is position:fixed and is rendered
// through a React portal to document.body — it escapes the sidebar footer slot
// container, so peer footer-slot plugins (e.g. dsh-cost-meter, which rewrites
// that container's children/order) can never reshape or dislocate it.

import type { Context } from "@deepseek-ai/cordis";

type ReactApi = {
	createElement: (
		type: unknown,
		props?: Record<string, unknown> | null,
		...children: unknown[]
	) => unknown;
	useState: <S>(initial: S) => [S, (next: S | ((prev: S) => S)) => void];
	useEffect: (setup: () => (() => void) | void, deps?: unknown[]) => void;
};
const R = require("react") as ReactApi;
const { createElement: h, useState, useEffect } = R;
// render the popover through a portal to document.body so it escapes the
// shared sidebar footer slot container. The sidebar.footer.action slot is a
// LIST where other plugins (e.g. dsh-cost-meter) legitimately reorder the
// container's children / rewrite its inline flex styles while watching it with
// a MutationObserver — a popover left as a slot child gets reshuffled by that
// churn and visibly deforms (GH issue #3). A body portal keeps it stable.
const reactDom = require("react-dom") as {
	createPortal?: (node: unknown, container: unknown) => unknown;
};

const win = globalThis as unknown as {
	location?: { origin?: string };
	fetch?: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
	// Browser-only, used as the portal mount target. Kept out of the TS dom lib
	// (this package's lib is ES2023); accessed lazily through globalThis.
	document?: { body?: unknown } | null;
};

// If react-dom.createPortal is available (and we're in a browser), mount via a
// body portal; otherwise fall back to rendering in place (older runtimes).
const bodyEl = win.document?.body;
const portalToBody =
	bodyEl != null && reactDom.createPortal
		? (node: unknown) => reactDom.createPortal!(node, bodyEl)
		: (node: unknown) => node;

/** Minimal DOM surface for the voice-player decorator: this bundle compiles
 *  without lib.dom, so every node is described structurally here. */
interface DomNode {
	getAttribute(name: string): string | null;
	setAttribute(name: string, value: string): void;
	removeAttribute(name: string): void;
	remove(): void;
	append(child: unknown): void;
	querySelector(selector: string): DomNode | null;
	querySelectorAll(selector: string): ArrayLike<DomNode>;
	matches?(selector: string): boolean;
	parentElement?: DomNode | null;
	style?: { cssText?: string };
	textContent?: string | null;
}
interface DomDocument {
	body?: DomNode | null;
	head?: DomNode | null;
	querySelectorAll(selector: string): ArrayLike<DomNode>;
	createElement(tag: string): DomNode;
}
const doc =
	(globalThis as unknown as { document?: DomDocument | null }).document ?? null;

export const name = "dsh-lark-plus-client";
export const inject = ["slots"];

export interface ClientContext extends Context {
	slots: {
		inject(name: string, register: () => () => void): void;
		register(
			opts: { name: string; id: string; order?: number; label?: string },
			Component: (props?: unknown) => unknown,
		): () => void;
	};
}

interface StatusPayload {
	connState?: string;
	configured?: boolean;
	outboxPending?: number;
	outboxFailed?: number;
	inboundFailed?: number;
}

type PanelState =
	| "loading"
	| "setup"
	| "ready"
	| "connecting"
	| "running"
	| "error";

function deriveState(s: StatusPayload | undefined): PanelState {
	if (!s) return "loading";
	if (!s.configured) return "setup";
	switch (s.connState) {
		case "connected":
			return "running";
		case "connecting":
		case "reconnecting":
			return "connecting";
		case "degraded":
		case "quarantined":
			return "error";
		default: // stopped | idle | undefined
			return "ready";
	}
}

const STATE_VIEW: Record<
	Exclude<PanelState, "loading">,
	{ emoji: string; label: string; color: string; bg: string; hint: string }
> = {
	setup: {
		emoji: "⚙️",
		label: "未配置",
		color: "#ffb454",
		bg: "rgba(255,180,84,.12)",
		hint: "手机飞书扫码，或在输入框运行 /lark setup",
	},
	ready: {
		emoji: "✅",
		label: "已配置 · 待启动",
		color: "#7fd1ff",
		bg: "rgba(127,209,255,.12)",
		hint: "在输入框运行 /lark start 启动桥接",
	},
	connecting: {
		emoji: "🟡",
		label: "连接中…",
		color: "#ffd66b",
		bg: "rgba(255,214,107,.12)",
		hint: "正在建立飞书长连接",
	},
	running: {
		emoji: "🟢",
		label: "运行中",
		color: "#7ee2a8",
		bg: "rgba(126,226,168,.12)",
		hint: "/lark stop · /lark restart · 发消息即可对话",
	},
	error: {
		emoji: "🔴",
		label: "连接异常",
		color: "#ff8a80",
		bg: "rgba(255,138,128,.12)",
		hint: "/lark restart 重连 · /lark status 查看详情",
	},
};

/**
 * Voice players: every inbound clip the bridge persisted is served read-only
 * at /plugins/lark-plus/audio?name=…, so a voice message only needs a play
 * bar under its text. This hides the raw attachment card and appends an
 * <audio controls> to the message stack (bubble first, player second).
 *
 * Ownership: the bubble belongs to React, so nothing here rewrites React's
 * children — a card is only marked with an attribute, players are appended as
 * siblings, and a re-render that drops them is re-decorated by the observer.
 * The per-name check keeps repeated mutations from stacking duplicates.
 */
function installVoicePlayers(ctx: ClientContext): void {
	if (doc?.body === undefined || doc.body === null) return;
	// A clip name inside a card title, e.g. "[语音 3.0s] feishu-…-baeb1g.ogg",
	const PLAYER = "data-lark-plus-player";
	const CARD = "data-lark-plus-card";
	const ROW = "[data-message-attachments]";
	const BASE = "/plugins/lark-plus/audio?name=";
	/** Extensions the host route will serve (keep in sync with
	 *  src/host/voice-audio-route.ts). */
	const CLIP = /([^\\/\s]+\.(?:ogg|oga|opus|mp3|wav|m4a|aac|flac|weba|bin))/i;
	for (const stale of Array.from(doc.querySelectorAll("style[data-lark-plus-style]"))) stale.remove();
	const style = doc.createElement("style");
	style.setAttribute("data-lark-plus-style", "");
	if (style.textContent !== undefined) {
		style.textContent = [
			"[" + CARD + "] { display: none !important; }",
			"[" + PLAYER + "] { display: block; height: 34px; max-width: min(320px, 100%); margin: 6px 0 0; }",
		].join("\n");
	}
	doc.head?.append(style);

	/** Voice attachment name of one card (the chat sets it as the title). */
	const nameOf = (card: DomNode): string => (card.getAttribute("title") ?? "").trim();

	/** Hide this row's audio cards and make sure every clip has one player. */
	const decorate = (row: DomNode): void => {
		const wanted: string[] = [];
		const cards = row.querySelectorAll("span[title]");
		for (let i = 0; i < cards.length; i += 1) {
			const card = cards[i];
			if (card === undefined) continue;
			// Extract the FILE NAME the playback route needs — the title is a
			// display string (voice label, absolute path, maybe a trailing
			// "（未能提取文本）"-style note), so match the clip inside it instead
			// of requiring the whole title to be a file name. Requiring that is
			// exactly why decorated attachments got no player before.
			const name = CLIP.exec(nameOf(card))?.[1];
			if (name === undefined) continue;
			card.setAttribute(CARD, "");
			if (!wanted.includes(name)) wanted.push(name);
		}
		/** Players live in the message stack, i.e. below the text bubble. */
		const stack = row.parentElement ?? row;
		const players = stack.querySelectorAll("[" + PLAYER + "]");
		const keep: string[] = [];
		for (let i = 0; i < players.length; i += 1) {
			const node = players[i];
			if (node === undefined) continue;
			const name = node.getAttribute(PLAYER) ?? "";
			if (!wanted.includes(name)) node.remove();
			else keep.push(name);
		}
		for (const name of wanted) {
			if (keep.includes(name)) continue;
			const audio = doc.createElement("audio");
			audio.setAttribute(PLAYER, name);
			audio.setAttribute("controls", "");
			audio.setAttribute("preload", "metadata");
			audio.setAttribute("src", BASE + encodeURIComponent(name));
			stack.append(audio);
		}
	};

	/** Decorate every message stack inside a (possibly new) subtree. */
	const scan = (root: DomNode | null | undefined): void => {
		if (root === null || root === undefined) return;
		const rows: DomNode[] = [];
		if (root.matches?.(ROW) === true) rows.push(root);
		const found = root.querySelectorAll(ROW);
		for (let i = 0; i < found.length; i += 1) {
			const row = found[i];
			if (row !== undefined) rows.push(row);
		}
		for (const row of rows) decorate(row);
	};

	scan(doc.body);
	const Observer = (globalThis as unknown as {
		MutationObserver?: new (
			cb: (records: Array<{ addedNodes: ArrayLike<DomNode> }>) => void,
		) => { observe(target: DomNode, options: { childList: boolean; subtree: boolean }): void; disconnect(): void };
	}).MutationObserver;
	if (Observer === undefined) return;
	const observer = new Observer((records) => {
		for (const record of records) {
			for (let i = 0; i < record.addedNodes.length; i += 1) scan(record.addedNodes[i] ?? null);
		}
	});
	observer.observe(doc.body, { childList: true, subtree: true });
	ctx.effect(
		() => () => {
			observer.disconnect();
			for (const node of Array.from(doc.querySelectorAll("[" + PLAYER + "]"))) node.remove();
			for (const card of Array.from(doc.querySelectorAll("[" + CARD + "]"))) card.removeAttribute(CARD);
			style.remove();
		},
		"lark-plus: voice players",
	);
}
export function apply(ctx: ClientContext): void {
	// Voice players: a voice message is text + a play bar, nothing else.
	installVoicePlayers(ctx);
	const SidebarAction = (): unknown => {
		const [open, setOpen] = useState<boolean>(false);
		const [st, setSt] = useState<StatusPayload | undefined>(undefined);
		const [qrTs, setQrTs] = useState<number>(0);
		const [qrLoaded, setQrLoaded] = useState<boolean>(false);

		useEffect(() => {
			if (!open) return;
			const origin = win.location?.origin ?? "";
			const fetchStatus = (): void => {
				void win
					.fetch?.(`${origin}/plugins/lark-plus/status`)
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error("status"))))
					.then((j) => setSt(j as StatusPayload))
					.catch(() => setSt((prev) => prev));
			};
			fetchStatus();
			const stId = setInterval(fetchStatus, 3000);
			// QR only matters in the setup state; poll a fresh PNG while unconfigured.
			const qrId = setInterval(() => setQrTs(Date.now()), 4000);
			setQrTs(Date.now());
			return () => {
				clearInterval(stId);
				clearInterval(qrId);
			};
		}, [open]);

		const state = deriveState(st);
		const origin = win.location?.origin ?? "";
		const showQr = state === "setup";

		const button = h(
			"button",
			{
				type: "button",
				title: "Lark Plus",
				onClick: () => setOpen((v) => !v),
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: "6px",
					padding: "6px 10px",
					border: "1px solid rgba(127,127,127,.25)",
					borderRadius: "8px",
					background: open ? "rgba(127,127,127,.18)" : "transparent",
					color: "inherit",
					cursor: "pointer",
					fontSize: "13px",
					lineHeight: 1,
				},
			},
			"🪶",
			"Lark",
		);

		if (!open) return button;

		const view =
			state === "loading"
				? {
						emoji: "…",
						label: "读取状态",
						color: "#9aa0a6",
						bg: "rgba(255,255,255,.05)",
						hint: "",
					}
				: STATE_VIEW[state];

		const extras: string[] = [];
		if (st?.outboxPending && st.outboxPending > 0)
			extras.push(`待发 ${st.outboxPending}`);
		if (st?.outboxFailed && st.outboxFailed > 0)
			extras.push(`失败 ${st.outboxFailed}`);
		if (st?.inboundFailed && st.inboundFailed > 0)
			extras.push(`补发失败 ${st.inboundFailed}`);

		const banner = h(
			"div",
			{
				style: {
					display: "flex",
					alignItems: "center",
					gap: "8px",
					padding: "10px 12px",
					marginBottom: "10px",
					background: view.bg,
					borderRadius: "8px",
					color: view.color,
					fontWeight: 600,
				},
			},
			h("span", { style: { fontSize: "16px" } }, view.emoji),
			h("span", null, view.label),
			extras.length
				? h(
						"span",
						{
							style: {
								marginLeft: "auto",
								fontWeight: 400,
								opacity: 0.8,
								fontSize: "11px",
							},
						},
						extras.join(" · "),
					)
				: null,
		);

		const hint = view.hint
			? h(
					"div",
					{
						style: {
							opacity: 0.8,
							marginBottom: "10px",
							whiteSpace: "pre-wrap",
						},
					},
					view.hint,
				)
			: null;

		// QR only while unconfigured; hidden (but fetched) until it loads.
		const qrImg = showQr
			? h("img", {
					src: `${origin}/plugins/lark-plus/qr?t=${qrTs}`,
					alt: "Lark Plus setup QR",
					onError: () => setQrLoaded(false),
					onLoad: () => setQrLoaded(true),
					style: {
						width: "220px",
						height: "220px",
						display: qrLoaded ? "block" : "none",
						margin: "0 auto 10px",
					},
				})
			: null;
		const qrHint =
			showQr && !qrLoaded
				? h(
						"div",
						{
							style: {
								textAlign: "center",
								opacity: 0.6,
								padding: "8px 0 12px",
								fontSize: "11px",
							},
						},
						"二维码生成中…（若无，确认已在输入框运行 /lark setup）",
					)
				: null;

		const footer = h(
			"div",
			{
				style: {
					marginTop: "6px",
					paddingTop: "8px",
					borderTop: "1px solid rgba(255,255,255,.08)",
					opacity: 0.6,
					fontSize: "11px",
					lineHeight: 1.6,
				},
			},
			"重新配置：/lark uninstall-clean → /lark setup",
			h("br"),
			"详情与全链路：/lark status",
		);

		const panel = h(
			"div",
			{
				style: {
					position: "fixed",
					top: "12px",
					right: "12px",
					zIndex: 2147483000,
					minWidth: "300px",
					maxWidth: "360px",
					padding: "14px 16px",
					background: "rgba(24,26,32,.97)",
					color: "#e6e8eb",
					border: "1px solid rgba(255,255,255,.16)",
					borderRadius: "12px",
					boxShadow: "0 16px 48px rgba(0,0,0,.5)",
					fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
					fontSize: "12px",
					lineHeight: 1.5,
				},
			},
			h(
				"div",
				{
					style: {
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						marginBottom: "10px",
					},
				},
				h("strong", { style: { fontSize: "13px" } }, "🪶 Lark Plus"),
				h(
					"button",
					{
						type: "button",
						onClick: () => setOpen(false),
						style: {
							background: "transparent",
							border: "none",
							color: "#9aa0a6",
							cursor: "pointer",
							fontSize: "16px",
							lineHeight: 1,
						},
						title: "关闭",
					},
					"×",
				),
			),
			banner,
			hint,
			qrImg,
			qrHint,
			footer,
		);

		// The popover goes through portalToBody (document.body) so another
		// footer-slot plugin (dsh-cost-meter) reordering the shared sidebar
		// footer container can never dislocate or deform it. Only the trigger
		// button stays inside the sidebar footer slot.
		return h("div", null, button, portalToBody(panel));
	};

	ctx.slots.inject("sidebar.footer.action", () =>
		ctx.slots.register(
			{
				name: "sidebar.footer.action",
				id: "lark-plus-entry",
				order: 100,
				label: "Lark Plus",
			},
			SidebarAction,
		),
	);
}
