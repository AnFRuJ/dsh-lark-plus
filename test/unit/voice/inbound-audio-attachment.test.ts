// Regression guard for the Web-GUI voice player.
//
// The audio branch must surface the clip as a REAL file attachment (fileRef)
// that carries voice metadata. Without the ref the session carries only a text
// note, the GUI renders no attachment card, the client half has nothing to
// decorate — and the play bar silently disappears. That is exactly what
// shipped in 0.1.0 and had to be fixed in 0.1.1, so it gets a test that needs
// neither the SenseVoice model nor ffmpeg (everything is stubbed).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInboundAttachments } from "../../../src/application/message-handler.ts";
import type { FeishuInboundMessage } from "../../../src/common/types.ts";

/** Minimal Ogg container — only the magic matters to the container sniffer. */
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x01, 0x02, 0x03, 0x04]);
const TRANSCRIPT = "测试消息，不用回复";

function audioMsg(): FeishuInboundMessage {
	return {
		messageId: "om_voice_unit",
		chatId: "ou_x",
		chatType: "p2p",
		chatMode: "p2p",
		senderOpenId: "ou_u",
		msgType: "audio",
		content: JSON.stringify({ file_key: "file_unit", duration: 3000 }),
		text: "",
		mentions: [],
		timestamp: 1791105000000,
	};
}

const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} };

/** Voice service stub: persists the bytes, then "recognizes" a fixed line. */
function voiceStub() {
	return {
		// NOTE: persistRawAudio is SYNCHRONOUS in VoiceService — making the stub
		// async hands the caller a Promise and the branch dies on
		// "persisted.errors is not iterable".
		persistRawAudio(buf: Uint8Array, stem: string, inboundDir?: string) {
			mkdirSync(join(inboundDir ?? ".", "media"), { recursive: true });
			const localPath = join(inboundDir ?? ".", "media", stem + ".ogg");
			writeFileSync(localPath, buf);
			return { localPath, errors: [] as string[] };
		},
		async transcribeRaw() {
			return { text: TRANSCRIPT, errors: [] as string[] };
		},
	} as never;
}

test("voice attachment carries a fileRef + voice metadata (the player depends on it)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "lark-plus-unit-"));
	const saved: Array<{ data: Uint8Array; name?: string }> = [];
	const ref = { attachmentId: "att_1", bytes: OGG.byteLength, name: "clip.ogg" };
	const ctx = {
		logger,
		transport: { async downloadResource() { return OGG; } },
		attachments: {
			async saveFile(input: { data: Uint8Array; name?: string }) {
				saved.push(input);
				return ref;
			},
		},
	} as never;

	const msg = audioMsg();
	const out = await resolveInboundAttachments(msg, ctx, dir, voiceStub());

	assert.equal(out.length, 1);
	const a = out[0]!;
	assert.equal(a.kind, "file");
	assert.match(a.name ?? "", /^\[语音 3\.0s\] /, "voice label stays human-readable");
	assert.deepEqual(a.voice, { seconds: 3, transcribed: true });
	assert.deepEqual(a.fileRef, ref, "fileRef is what turns this into a real file part");
	assert.equal(msg.text, TRANSCRIPT, "the transcript is the message text");
	assert.equal(saved.length, 1, "the clip is registered with the attachment store");
	assert.ok((saved[0]?.name ?? "").endsWith(".ogg"), "stored under the clip's file name");
	assert.ok(readdirSync(join(dir, "media")).some((f) => f.endsWith(".ogg")));
});

test("no attachment store: clip still persisted, transcript intact, no fileRef", async () => {
	const dir = mkdtempSync(join(tmpdir(), "lark-plus-unit2-"));
	const ctx = {
		logger,
		transport: { async downloadResource() { return OGG; } },
	} as never;

	const msg = audioMsg();
	const out = await resolveInboundAttachments(msg, ctx, dir, voiceStub());

	assert.equal(out.length, 1);
	assert.equal(out[0]!.fileRef, undefined, "graceful degradation, not a crash");
	assert.equal(msg.text, TRANSCRIPT);
	assert.ok(readdirSync(join(dir, "media")).some((f) => f.endsWith(".ogg")));
});
