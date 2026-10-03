// Voice message lane: the exact branch this fork adds.
//
//   node --experimental-strip-types --test test/voice-attachments.test.ts
//
// Asset-dependent (real SenseVoice model + real ffmpeg); SKIPS instead of
// failing when the assets are absent, so CI without them stays green.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInboundAttachments } from "../src/application/message-handler.ts";
import { createVoiceService } from "../src/voice/service.ts";
import { modelReady, resolveFfmpeg, resolveModelDir } from "../src/voice/transcribe.ts";
import type { FeishuInboundMessage } from "../src/common/types.ts";

const oggPath = process.env.DSH_VOICE_SMOKE_OGG ?? join(import.meta.dirname, "fixtures", "feishu-voice-zh.ogg");
const assetsReady = modelReady(resolveModelDir()) && Boolean(resolveFfmpeg());

function audioMsg(fileKey: string, duration = 3000): FeishuInboundMessage {
	return {
		messageId: "om_voice_test",
		chatId: "ou_x",
		chatType: "p2p",
		chatMode: "p2p",
		senderOpenId: "ou_u",
		msgType: "audio",
		content: JSON.stringify({ file_key: fileKey, duration }),
		text: "",
		mentions: [],
		timestamp: 1791041665835,
	};
}

const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never;

test("voice: audio message becomes text AND keeps the raw clip on disk", async (t) => {
	if (!assetsReady) return t.skip("needs the SenseVoice model + ffmpeg");

	const ogg = readFileSync(oggPath);
	const inboundDir = mkdtempSync(join(tmpdir(), "lark-voice-att-"));
	const voice = createVoiceService({ warn: () => {}, info: () => {} });
	const downloads: string[] = [];
	const ctx = {
		logger,
		transport: {
			async downloadResource(p: { fileKey: string; type: string }) {
				downloads.push(p.fileKey + ":" + p.type);
				return ogg;
			},
		},
	} as never;

	const msg = audioMsg("file_v3_test");
	const out = await resolveInboundAttachments(msg, ctx, inboundDir, voice);

	// 1) the Feishu resource is fetched as a FILE (that is the API contract).
	assert.deepEqual(downloads, ["file_v3_test:file"]);
	// 2) the raw {file_key,duration} JSON must NOT survive as the message text.
	const text = msg.text ?? "";
	assert.ok(text.length > 0, "audio message must carry recognized text");
	assert.ok(!text.includes("file_key"), "raw content JSON must not leak into text");
	console.log("    msg.text =", JSON.stringify(text));
	// 3) the audio is reported to the agent with its local path.
	assert.equal(out.length, 1);
	assert.equal(out[0]!.kind, "file");
	assert.match(out[0]!.name ?? "", /^\[语音 3\.0s\] /);
	assert.ok(out[0]!.path !== "feishu://audio", "expected a real local path");
	assert.ok(existsSync(out[0]!.path), "reported path must exist");
	// 4) transcript + raw clip + 16k wav all live under inboundDir/media.
	const media = readdirSync(join(inboundDir, "media"));
	assert.ok(media.some((f) => f.endsWith(".ogg")), "raw clip kept");
	assert.ok(media.some((f) => f.endsWith(".wav")), "16k wav kept");

	// 5) two voice messages in the same millisecond must not collide.
	const second = audioMsg("file_v3_test2");
	await resolveInboundAttachments(second, ctx, inboundDir, voice);
	const media2 = readdirSync(join(inboundDir, "media"));
	assert.equal(media2.filter((f) => f.endsWith(".ogg")).length, 2, "both clips persisted");
});

test("voice: transcription disabled still keeps the clip (no text)", async () => {
	const inboundDir = mkdtempSync(join(tmpdir(), "lark-voice-off-"));
	const ctx = {
		logger,
		transport: { async downloadResource() { return readFileSync(oggPath); } },
	} as never;
	const msg = audioMsg("file_v3_off");
	const out = await resolveInboundAttachments(msg, ctx, inboundDir, undefined);

	assert.equal(msg.text, "", "no transcription when the feature is off");
	assert.equal(out.length, 1, "the attachment is still surfaced");
	// Even with no voice service the audio must be kept — the branch falls back
	// to a plain persist so replay/resend never depends on STT being wired up.
	assert.ok(existsSync(out[0]!.path), "raw clip persisted even when voice is off");
	// The fallback has no container sniffing, so it writes .bin — what matters
	// is that bytes landed on disk next to a reported path.
	assert.ok(readdirSync(join(inboundDir, "media")).length > 0);
});
