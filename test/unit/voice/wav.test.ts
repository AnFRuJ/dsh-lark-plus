// Unit tests for the pure-JS WAV decoder (src/voice/wav.ts).
//
// The decoder exists because the DSH host (Electron 44 / Node 24) disables napi
// external buffers, so sherpa-onnx's native decoders throw
// "External buffers are not allowed". These tests build WAVs by hand and check
// the parsing, down-mixing and resampling without any native dependency.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readWavSamples } from "../../../src/voice/wav.ts";

/** Build a minimal PCM WAV from samples (16-bit little-endian). */
function buildWav(samples: number[], sampleRate: number, channels = 1, bits = 16): Uint8Array {
	const bytesPerSample = bits / 8;
	const dataSize = samples.length * bytesPerSample;
	const buffer = new Uint8Array(44 + dataSize);
	const view = new DataView(buffer.buffer);
	const ascii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i += 1) buffer[offset + i] = text.charCodeAt(i);
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * bytesPerSample, true);
	view.setUint16(32, channels * bytesPerSample, true);
	view.setUint16(34, bits, true);
	ascii(36, "data");
	view.setUint32(40, dataSize, true);
	samples.forEach((value, index) => {
		view.setInt16(44 + index * bytesPerSample, value, true);
	});
	return buffer;
}

test("wav: 16 kHz mono passes through unchanged", () => {
	const wav = buildWav([0, 16384, -16384, 32767, -32768], 16_000);
	const decoded = readWavSamples(wav);
	assert.equal(decoded.sampleRate, 16_000);
	assert.equal(decoded.samples.length, 5);
	assert.equal(decoded.samples[0], 0);
	assert.ok(Math.abs((decoded.samples[1] ?? 0) - 0.5) < 1e-4);
	assert.ok(Math.abs((decoded.samples[2] ?? 0) + 0.5) < 1e-4);
	assert.ok((decoded.samples[3] ?? 0) > 0.999);
	assert.ok((decoded.samples[4] ?? 0) <= -0.999);
});

test("wav: 8 kHz is resampled to 16 kHz with double the frames", () => {
	const wav = buildWav(Array.from({ length: 80 }, (_, i) => i * 100), 8_000);
	const decoded = readWavSamples(wav, 16_000);
	assert.equal(decoded.sampleRate, 16_000);
	assert.equal(decoded.samples.length, 160);
});

test("wav: stereo is averaged to mono", () => {
	const interleaved = [32767, -32768, 32767, -32768];
	const wav = buildWav(interleaved, 16_000, 2);
	const decoded = readWavSamples(wav);
	assert.equal(decoded.samples.length, 2);
	assert.ok(Math.abs((decoded.samples[0] ?? 0) - 0) < 1e-3);
});

test("wav: empty buffer and bad container are rejected or empty", () => {
	assert.equal(readWavSamples(new Uint8Array(0)).samples.length, 0);
	assert.throws(() => readWavSamples(new Uint8Array(64)), /过短|RIFF/);
	const notRiff = new Uint8Array(64);
	notRiff.set([1, 2, 3, 4], 0);
	assert.throws(() => readWavSamples(notRiff), /RIFF|WAVE/);
});
