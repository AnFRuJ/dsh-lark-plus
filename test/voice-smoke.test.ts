// Voice lane smoke test (real model, real ffmpeg).
//
//   node --experimental-strip-types test/voice-smoke.test.ts
//
// Asset-dependent: when the SenseVoice model or ffmpeg is missing the test
// SKIPS instead of failing, so CI without those assets stays green. Point
// it at your own clip with DSH_VOICE_SMOKE_OGG=<path>.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVoiceService } from "../src/voice/service.ts";
import { detectContainer, resolveFfmpeg, resolveModelDir, modelReady } from "../src/voice/transcribe.ts";

const oggPath = process.env.DSH_VOICE_SMOKE_OGG ?? join(import.meta.dirname, "fixtures", "feishu-voice-zh.ogg");

test("container sniffing recognizes the Feishu OGG container", () => {
	const buf = readFileSync(oggPath);
	assert.equal(detectContainer(buf), "ogg");
});

test("end-to-end: downloaded OGG is kept on disk and transcribed", async (t) => {
	const modelDir = resolveModelDir();
	if (!modelReady(modelDir)) return t.skip("SenseVoice model not installed: " + modelDir);
	if (!resolveFfmpeg()) return t.skip("ffmpeg not found");

	const ogg = readFileSync(oggPath);
	const inboundDir = mkdtempSync(join(tmpdir(), "lark-plus-smoke-"));
	const voice = createVoiceService({ warn: () => {}, info: () => {} });

	const outcome = await voice.transcribe(ogg, "feishu-om_smoke", 3000, inboundDir, 1);

	// The raw clip must survive regardless of what STT does (that is the
	// whole point of keeping it: replay in Feishu, re-read from tools).
	assert.ok(outcome.localPath, "raw audio path must be persisted");
	assert.ok(existsSync(outcome.localPath!), "raw audio file must exist on disk");
	assert.equal(detectContainer(readFileSync(outcome.localPath!)), "ogg");
	assert.deepEqual(outcome.errors, [], "no degradation errors expected");
	assert.ok(outcome.text && outcome.text.length > 0, "expected recognized text");
	console.log("    recognized:", JSON.stringify(outcome.text));

	// The transcoded 16 kHz WAV sits next to it (that is what STT consumed).
	const media = readdirSync(join(inboundDir, "media"));
	assert.ok(media.some((f) => f.endsWith(".wav")), "16k wav expected next to the raw clip");
});

test("degradation: a bad ffmpeg path keeps the audio and reports the error", async (t) => {
	const modelDir = resolveModelDir();
	if (!modelReady(modelDir)) return t.skip("SenseVoice model not installed");

	const ogg = readFileSync(oggPath);
	const inboundDir = mkdtempSync(join(tmpdir(), "lark-plus-degrade-"));
	const voice = createVoiceService({ warn: () => {}, info: () => {} }, { ffmpegPath: "definitely-not-ffmpeg" });
	const outcome = await voice.transcribe(ogg, "feishu-om_bad", 1000, inboundDir, 2);

	assert.equal(outcome.text, undefined, "no text without a working transcode");
	assert.ok(outcome.localPath, "audio still persisted");
	assert.ok(outcome.errors.length > 0, "the failure must be reported, not swallowed");
	console.log("    degraded errors:", JSON.stringify(outcome.errors));
});
