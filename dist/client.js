window.__ModuleLoader__.load({
	id: "dsh-lark-plus",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region src/client/index.ts
		const { createElement: h, useState, useEffect } = require("react");
		const reactDom = require("react-dom");
		const win = globalThis;
		const bodyEl = win.document?.body;
		const portalToBody = bodyEl != null && reactDom.createPortal ? (node) => reactDom.createPortal(node, bodyEl) : (node) => node;
		const doc = globalThis.document ?? null;
		const name = "dsh-lark-plus-client";
		const inject = ["slots"];
		function deriveState(s) {
			if (!s) return "loading";
			if (!s.configured) return "setup";
			switch (s.connState) {
				case "connected": return "running";
				case "connecting":
				case "reconnecting": return "connecting";
				case "degraded":
				case "quarantined": return "error";
				default: return "ready";
			}
		}
		const STATE_VIEW = {
			setup: {
				emoji: "⚙️",
				label: "未配置",
				color: "#ffb454",
				bg: "rgba(255,180,84,.12)",
				hint: "手机飞书扫码，或在输入框运行 /lark setup"
			},
			ready: {
				emoji: "✅",
				label: "已配置 · 待启动",
				color: "#7fd1ff",
				bg: "rgba(127,209,255,.12)",
				hint: "在输入框运行 /lark start 启动桥接"
			},
			connecting: {
				emoji: "🟡",
				label: "连接中…",
				color: "#ffd66b",
				bg: "rgba(255,214,107,.12)",
				hint: "正在建立飞书长连接"
			},
			running: {
				emoji: "🟢",
				label: "运行中",
				color: "#7ee2a8",
				bg: "rgba(126,226,168,.12)",
				hint: "/lark stop · /lark restart · 发消息即可对话"
			},
			error: {
				emoji: "🔴",
				label: "连接异常",
				color: "#ff8a80",
				bg: "rgba(255,138,128,.12)",
				hint: "/lark restart 重连 · /lark status 查看详情"
			}
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
		function installVoicePlayers(ctx) {
			if (doc?.body === void 0 || doc.body === null) return;
			const AUDIO_NAME = /\.(ogg|oga|opus|mp3|wav|m4a|aac|flac|bin)$/i;
			const PLAYER = "data-lark-plus-player";
			const CARD = "data-lark-plus-card";
			const ROW = "[data-message-attachments]";
			const BASE = "/plugins/lark-plus/audio?name=";
			for (const stale of Array.from(doc.querySelectorAll("style[data-lark-plus-style]"))) stale.remove();
			const style = doc.createElement("style");
			style.setAttribute("data-lark-plus-style", "");
			if (style.textContent !== void 0) style.textContent = ["[" + CARD + "] { display: none !important; }", "[" + PLAYER + "] { display: block; height: 34px; max-width: min(320px, 100%); margin: 6px 0 0; }"].join("\n");
			doc.head?.append(style);
			/** Voice attachment name of one card (the chat sets it as the title). */
			const nameOf = (card) => (card.getAttribute("title") ?? "").trim();
			/** Hide this row's audio cards and make sure every clip has one player. */
			const decorate = (row) => {
				const wanted = [];
				const cards = row.querySelectorAll("span[title]");
				for (let i = 0; i < cards.length; i += 1) {
					const card = cards[i];
					if (card === void 0) continue;
					const name = nameOf(card);
					if (name === "" || !AUDIO_NAME.test(name)) continue;
					card.setAttribute(CARD, "");
					if (!wanted.includes(name)) wanted.push(name);
				}
				/** Players live in the message stack, i.e. below the text bubble. */
				const stack = row.parentElement ?? row;
				const players = stack.querySelectorAll("[" + PLAYER + "]");
				const keep = [];
				for (let i = 0; i < players.length; i += 1) {
					const node = players[i];
					if (node === void 0) continue;
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
			const scan = (root) => {
				if (root === null || root === void 0) return;
				const rows = [];
				if (root.matches?.(ROW) === true) rows.push(root);
				const found = root.querySelectorAll(ROW);
				for (let i = 0; i < found.length; i += 1) {
					const row = found[i];
					if (row !== void 0) rows.push(row);
				}
				for (const row of rows) decorate(row);
			};
			scan(doc.body);
			const Observer = globalThis.MutationObserver;
			if (Observer === void 0) return;
			const observer = new Observer((records) => {
				for (const record of records) for (let i = 0; i < record.addedNodes.length; i += 1) scan(record.addedNodes[i] ?? null);
			});
			observer.observe(doc.body, {
				childList: true,
				subtree: true
			});
			ctx.effect(() => () => {
				observer.disconnect();
				for (const node of Array.from(doc.querySelectorAll("[" + PLAYER + "]"))) node.remove();
				for (const card of Array.from(doc.querySelectorAll("[" + CARD + "]"))) card.removeAttribute(CARD);
				style.remove();
			}, "lark-plus: voice players");
		}
		function apply(ctx) {
			installVoicePlayers(ctx);
			const SidebarAction = () => {
				const [open, setOpen] = useState(false);
				const [st, setSt] = useState(void 0);
				const [qrTs, setQrTs] = useState(0);
				const [qrLoaded, setQrLoaded] = useState(false);
				useEffect(() => {
					if (!open) return;
					const origin = win.location?.origin ?? "";
					const fetchStatus = () => {
						win.fetch?.(`${origin}/plugins/lark-plus/status`).then((r) => r.ok ? r.json() : Promise.reject(/* @__PURE__ */ new Error("status"))).then((j) => setSt(j)).catch(() => setSt((prev) => prev));
					};
					fetchStatus();
					const stId = setInterval(fetchStatus, 3e3);
					const qrId = setInterval(() => setQrTs(Date.now()), 4e3);
					setQrTs(Date.now());
					return () => {
						clearInterval(stId);
						clearInterval(qrId);
					};
				}, [open]);
				const state = deriveState(st);
				const origin = win.location?.origin ?? "";
				const showQr = state === "setup";
				const button = h("button", {
					type: "button",
					title: "Lark Link",
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
						lineHeight: 1
					}
				}, "🪶", "Lark");
				if (!open) return button;
				const view = state === "loading" ? {
					emoji: "…",
					label: "读取状态",
					color: "#9aa0a6",
					bg: "rgba(255,255,255,.05)",
					hint: ""
				} : STATE_VIEW[state];
				const extras = [];
				if (st?.outboxPending && st.outboxPending > 0) extras.push(`待发 ${st.outboxPending}`);
				if (st?.outboxFailed && st.outboxFailed > 0) extras.push(`失败 ${st.outboxFailed}`);
				if (st?.inboundFailed && st.inboundFailed > 0) extras.push(`补发失败 ${st.inboundFailed}`);
				const banner = h("div", { style: {
					display: "flex",
					alignItems: "center",
					gap: "8px",
					padding: "10px 12px",
					marginBottom: "10px",
					background: view.bg,
					borderRadius: "8px",
					color: view.color,
					fontWeight: 600
				} }, h("span", { style: { fontSize: "16px" } }, view.emoji), h("span", null, view.label), extras.length ? h("span", { style: {
					marginLeft: "auto",
					fontWeight: 400,
					opacity: .8,
					fontSize: "11px"
				} }, extras.join(" · ")) : null);
				const hint = view.hint ? h("div", { style: {
					opacity: .8,
					marginBottom: "10px",
					whiteSpace: "pre-wrap"
				} }, view.hint) : null;
				const qrImg = showQr ? h("img", {
					src: `${origin}/plugins/lark-plus/qr?t=${qrTs}`,
					alt: "Lark Link setup QR",
					onError: () => setQrLoaded(false),
					onLoad: () => setQrLoaded(true),
					style: {
						width: "220px",
						height: "220px",
						display: qrLoaded ? "block" : "none",
						margin: "0 auto 10px"
					}
				}) : null;
				const qrHint = showQr && !qrLoaded ? h("div", { style: {
					textAlign: "center",
					opacity: .6,
					padding: "8px 0 12px",
					fontSize: "11px"
				} }, "二维码生成中…（若无，确认已在输入框运行 /lark setup）") : null;
				const footer = h("div", { style: {
					marginTop: "6px",
					paddingTop: "8px",
					borderTop: "1px solid rgba(255,255,255,.08)",
					opacity: .6,
					fontSize: "11px",
					lineHeight: 1.6
				} }, "重新配置：/lark uninstall-clean → /lark setup", h("br"), "详情与全链路：/lark status");
				const panel = h("div", { style: {
					position: "fixed",
					top: "12px",
					right: "12px",
					zIndex: 2147483e3,
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
					lineHeight: 1.5
				} }, h("div", { style: {
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					marginBottom: "10px"
				} }, h("strong", { style: { fontSize: "13px" } }, "🪶 Lark Link"), h("button", {
					type: "button",
					onClick: () => setOpen(false),
					style: {
						background: "transparent",
						border: "none",
						color: "#9aa0a6",
						cursor: "pointer",
						fontSize: "16px",
						lineHeight: 1
					},
					title: "关闭"
				}, "×")), banner, hint, qrImg, qrHint, footer);
				return h("div", null, button, portalToBody(panel));
			};
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "lark-plus-entry",
				order: 100,
				label: "Lark Link"
			}, SidebarAction));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
