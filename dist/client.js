window.__ModuleLoader__.load({
	id: "dsh-lark-voice",
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
		const name = "dsh-lark-voice-client";
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
				hint: "手机飞书扫码，或在输入框运行 /lark-voice setup"
			},
			ready: {
				emoji: "✅",
				label: "已配置 · 待启动",
				color: "#7fd1ff",
				bg: "rgba(127,209,255,.12)",
				hint: "在输入框运行 /lark-voice start 启动桥接"
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
				hint: "/lark-voice stop · /lark-voice restart · 发消息即可对话"
			},
			error: {
				emoji: "🔴",
				label: "连接异常",
				color: "#ff8a80",
				bg: "rgba(255,138,128,.12)",
				hint: "/lark-voice restart 重连 · /lark-voice status 查看详情"
			}
		};
		function apply(ctx) {
			const SidebarAction = () => {
				const [open, setOpen] = useState(false);
				const [st, setSt] = useState(void 0);
				const [qrTs, setQrTs] = useState(0);
				const [qrLoaded, setQrLoaded] = useState(false);
				useEffect(() => {
					if (!open) return;
					const origin = win.location?.origin ?? "";
					const fetchStatus = () => {
						win.fetch?.(`${origin}/plugins/lark-voice/status`).then((r) => r.ok ? r.json() : Promise.reject(/* @__PURE__ */ new Error("status"))).then((j) => setSt(j)).catch(() => setSt((prev) => prev));
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
					src: `${origin}/plugins/lark-voice/qr?t=${qrTs}`,
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
				} }, "二维码生成中…（若无，确认已在输入框运行 /lark-voice setup）") : null;
				const footer = h("div", { style: {
					marginTop: "6px",
					paddingTop: "8px",
					borderTop: "1px solid rgba(255,255,255,.08)",
					opacity: .6,
					fontSize: "11px",
					lineHeight: 1.6
				} }, "重新配置：/lark-voice uninstall-clean → /lark-voice setup", h("br"), "详情与全链路：/lark-voice status");
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
				id: "lark-voice-entry",
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
