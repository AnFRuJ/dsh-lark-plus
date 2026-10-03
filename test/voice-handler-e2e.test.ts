// Voice end-to-end through the message handler: an inbound Feishu audio event
// must reach the agent as TEXT (never as the raw {file_key,duration} JSON),
// with the clip kept on disk.
//
//   node --experimental-strip-types --test test/voice-handler-e2e.test.ts
//
// Asset-dependent (real model + ffmpeg); skips without them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageHandler } from "../src/application/message-handler.ts";
import { createBridgeContext } from "../src/application/bridge-context.ts";
import { createCommandRouter } from "../src/application/command-router.ts";
import { createConversationManager } from "../src/sessions/conversation-manager.ts";
import { createMemoryDshBackend } from "../src/sessions/dsh-session-backend.ts";
import { createStatusStore } from "../src/common/connection-status.ts";
import { createLogger } from "../src/common/logger.ts";
import { DEFAULT_CONFIG } from "../src/common/config.ts";
import { createVoiceService } from "../src/voice/service.ts";
import { modelReady, resolveFfmpeg, resolveModelDir } from "../src/voice/transcribe.ts";

const oggPath = process.env.DSH_VOICE_SMOKE_OGG ?? join(import.meta.dirname, "fixtures", "feishu-voice-zh.ogg");
const assetsReady = modelReady(resolveModelDir()) && Boolean(resolveFfmpeg());

test("voice e2e: audio event reaches the agent as text, clip kept on disk", async (t) => {
	if (!assetsReady) return t.skip("needs the SenseVoice model + ffmpeg");

	const inboundDir = mkdtempSync(join(tmpdir(), "lark-voice-e2e-"));
	const ogg = readFileSync(oggPath);
	// What the agent receives, captured at the backend seam.
	const received: Array<{ key: string; text: string }> = [];
	const backend = createMemoryDshBackend({
		autoReply: (key, text) => {
			received.push({ key, text });
			return "ok";
		},
	});
	const ctx = createBridgeContext({
		logger: createLogger("test"),
		cfg: () => ({ ...DEFAULT_CONFIG, attachments: { ...DEFAULT_CONFIG.attachments, dir: inboundDir } }),
		status: createStatusStore(undefined),
	});
	ctx.setTransport({
		async downloadResource() { return ogg; },
	} as never);
	ctx.setConversations(createConversationManager({ backend, maxSessions: 4, idleTtlMs: 60_000 }));
	ctx.setOutbox({ enqueue: async () => "x", start() {}, stop: async () => {}, pendingCount: () => 0, failedCount: () => 0, prune() {}, rebuildFromDisk() {}, lanes: () => [] } as never);

	const handler = createMessageHandler({
		ctx,
		commands: createCommandRouter({
			ctx,
			commands: { has: () => false, async run() { return { kind: "success" }; } },
			bridgeHandler: async () => false,
		} as never),
		groupTrigger: { shouldTrigger: () => true },
		dedupe: { add: () => true },
		allowlist: () => [],
		inboundDir,
		voice: createVoiceService({ warn: () => {}, info: () => {} }),
		transcribeAudio: true,
	});

	const result = await handler.handleInbound({
		messageId: "om_e2e_1",
		chatId: "oc_x",
		chatType: "p2p",
		chatMode: "p2p",
		senderOpenId: "ou_u",
		msgType: "audio",
		content: JSON.stringify({ file_key: "file_v3_e2e", duration: 3000 }),
		// Exactly what normalizeInbound produces for audio (this placeholder is
		// what stops the command router from answering "skipped").
		text: "[语音]",
		mentions: [],
		timestamp: 1791044000000,
	});
	assert.equal(result, "processed");
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(received.length, 1, "the agent must be invoked once");
	const text = received[0]!.text;
	console.log("    agent received:", JSON.stringify(text));
	assert.ok(text.includes("附件") || text.length > 0, "agent got a prompt");
	assert.ok(!text.includes("file_key"), "raw content JSON must not leak into the prompt");
	// The recognized Chinese text must be in there (the fixture says so).
	assert.ok(/[\u4e00-\u9fa5]/.test(text), "prompt carries recognized Chinese text");
	const files = readdirSync(join(inboundDir, "media"));
	assert.ok(files.some((f) => f.endsWith(".ogg")), "raw clip kept");
	assert.ok(files.some((f) => f.endsWith(".wav")), "16k wav kept");
});
