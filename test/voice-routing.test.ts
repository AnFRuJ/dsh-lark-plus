import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
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
const ogg = join(import.meta.dirname, "fixtures", "feishu-voice-zh.ogg");
const ready = modelReady(resolveModelDir()) && Boolean(resolveFfmpeg());
async function run(text: string): Promise<{ route: unknown; received: string[] }> {
  const inboundDir = mkdtempSync(join(tmpdir(), "probe-"));
  const received: string[] = [];
  const backend = createMemoryDshBackend({ autoReply: (k, t) => { received.push(t); return "ok"; } });
  const ctx = createBridgeContext({ logger: createLogger("t"), cfg: () => ({ ...DEFAULT_CONFIG, attachments: { ...DEFAULT_CONFIG.attachments, dir: inboundDir } }), status: createStatusStore(undefined) });
  ctx.setTransport({ async downloadResource() { return readFileSync(ogg); } } as never);
  ctx.setConversations(createConversationManager({ backend, maxSessions: 4, idleTtlMs: 60000 }));
  ctx.setOutbox({ enqueue: async () => "x", start() {}, stop: async () => {}, pendingCount: () => 0, failedCount: () => 0, prune() {}, rebuildFromDisk() {}, lanes: () => [] } as never);
  const h = createMessageHandler({ ctx, commands: createCommandRouter({ ctx, commands: { has: () => false, async run() { return { kind: "success" }; } }, bridgeHandler: async () => false } as never), groupTrigger: { shouldTrigger: () => true }, dedupe: { add: () => true }, allowlist: () => [], inboundDir, voice: createVoiceService({ warn: () => {}, info: () => {} }), transcribeAudio: true });
  const r = await h.handleInbound({ messageId: "m", chatId: "c", chatType: "p2p", chatMode: "p2p", senderOpenId: "u", msgType: "audio", content: JSON.stringify({ file_key: "k", duration: 3000 }), text, mentions: [], timestamp: 1 });
  await new Promise((r) => setTimeout(r, 50));
  return { route: r, received };
}
test("voice: empty audio text is dropped, the [语音] placeholder is not", async (t) => {
  if (!ready) return t.skip("assets missing");
  const a = await run("");
  console.log("    text=\"\"      -> handleInbound:", a.route, "| agent invoked:", a.received.length);
  const b = await run("[语音]");
  console.log("    text=\"[语音]\" -> handleInbound:", b.route, "| agent invoked:", b.received.length, "|", JSON.stringify(b.received[0]));
  assert.equal(a.received.length, 0, "empty text => dropped (the upstream bug)");
  assert.equal(b.received.length, 1, "placeholder => delivered");
});
