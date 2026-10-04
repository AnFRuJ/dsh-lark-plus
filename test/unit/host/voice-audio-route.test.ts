// Unit tests for the Web-GUI playback route (src/host/voice-audio-route.ts):
// the client half points an <audio> at /plugins/lark-plus/audio?name=…, and
// this is what answers it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	VOICE_AUDIO_TYPES,
	voiceAudioFile,
	voiceAudioRoute,
} from "../../../src/host/voice-audio-route.ts";

function makeMedia(): { dir: string; name: string; bytes: number } {
	const dir = mkdtempSync(join(tmpdir(), "lark-plus-audio-"));
	const name = "feishu-om_x-123-abc.ogg";
	const data = Buffer.alloc(64, 7);
	data.write("OggS", 0, "ascii");
	writeFileSync(join(dir, name), data);
	return { dir, name, bytes: data.length };
}

function capture(): {
	out: { status?: number; headers?: Record<string, string>; body?: unknown };
	res: { writeHead(s: number, h: Record<string, string>): void; end(b?: unknown): void };
} {
	const out: { status?: number; headers?: Record<string, string>; body?: unknown } = {};
	return {
		out,
		res: {
			writeHead(status: number, headers: Record<string, string>) {
				out.status = status;
				out.headers = headers;
			},
			end(body?: unknown) {
				out.body = body;
			},
		},
	};
}

test("voiceAudioFile: bare audio names inside the media dir only", () => {
	const { dir, name } = makeMedia();
	assert.equal(voiceAudioFile(name, dir), join(dir, name));
	assert.equal(voiceAudioFile("../" + name, dir), undefined, "no traversal");
	assert.equal(voiceAudioFile(name + ".exe", dir), undefined, "extension whitelist");
	assert.equal(voiceAudioFile("missing.ogg", dir), undefined, "must exist");
	writeFileSync(join(dir, "notes.txt"), "x");
	assert.equal(voiceAudioFile("notes.txt", dir), undefined, "text is not served");
});

test("voiceAudioRoute: 200 full body / 206 range / 404 / 405", () => {
	const { dir, name, bytes } = makeMedia();
	const url = "/plugins/lark-plus/audio?name=" + encodeURIComponent(name);

	const full = capture();
	voiceAudioRoute({ method: "GET", url }, full.res, dir);
	assert.equal(full.out.status, 200);
	assert.equal(full.out.headers?.["Content-Type"], VOICE_AUDIO_TYPES[".ogg"]);
	assert.equal(full.out.headers?.["Accept-Ranges"], "bytes");
	assert.equal((full.out.body as Buffer).byteLength, bytes);

	const ranged = capture();
	voiceAudioRoute({ method: "GET", url, headers: { range: "bytes=4-9" } }, ranged.res, dir);
	assert.equal(ranged.out.status, 206);
	assert.equal(ranged.out.headers?.["Content-Range"], "bytes 4-9/" + String(bytes));
	assert.equal((ranged.out.body as Buffer).byteLength, 6);

	const head = capture();
	voiceAudioRoute({ method: "HEAD", url }, head.res, dir);
	assert.equal(head.out.status, 200);
	assert.equal(head.out.body, undefined);

	const missing = capture();
	voiceAudioRoute({ method: "GET", url: "/plugins/lark-plus/audio?name=nope.ogg" }, missing.res, dir);
	assert.equal(missing.out.status, 404);

	const posted = capture();
	voiceAudioRoute({ method: "POST", url }, posted.res, dir);
	assert.equal(posted.out.status, 405);
});
