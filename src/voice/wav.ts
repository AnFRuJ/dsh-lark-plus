// Pure-JS WAV decoder for the voice pipeline.
//
// WHY THIS EXISTS (2026-10-04): under Electron 44 / Node 24 — and the DSH
// desktop host runs exactly that — napi *external buffers* are disabled.
// sherpa-onnx's native decoders (\`readWaveFromBinary\` on the addon module and
// \`readWave\` from the package root) BOTH throw
// "External buffers are not allowed", so the transcribe route answered
// 400 decode-failed and every voice message came back as "（未能提取文本）".
//
// Recognition itself is unaffected: it goes through
// \`stream.acceptWaveform({ samples: Float32Array })\`, which copies into the
// addon instead of handing over an external buffer.
//
// So this module parses RIFF/PCM in plain JS: PCM 8/16/24/32-bit and float32,
// any channel count (averaged to mono), and linear-interpolation resampling to
// the recognizer's rate. No native decoding anywhere.

/** One decoded clip: mono float samples plus the rate they were decoded at. */
export interface DecodedWave {
	samples: Float32Array;
	sampleRate: number;
}

/** SenseVoice wants 16 kHz. */
const DEFAULT_TARGET_SAMPLE_RATE = 16_000;

/** Read one byte, 0 when past the end (keeps the parser total without casts). */
function byteAt(bytes: Uint8Array, offset: number): number {
	return bytes[offset] ?? 0;
}

/**
 * Decode a WAV buffer into mono float samples at \`targetSampleRate\`.
 * @param input - WAV bytes (Buffer, Uint8Array or any typed-array view).
 * @param targetSampleRate - rate to resample to when the file disagrees.
 * @returns mono samples and the sample rate they are at.
 * @throws Error when the container or the PCM format is unsupported.
 */
export function readWavSamples(input: Uint8Array, targetSampleRate = DEFAULT_TARGET_SAMPLE_RATE): DecodedWave {
	const bytes = input;
	if (bytes.byteLength === 0) return { samples: new Float32Array(0), sampleRate: targetSampleRate };
	if (bytes.byteLength < 12) throw new Error("WAV 数据过短，无法解析");

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const tag = (offset: number): string =>
		String.fromCharCode(byteAt(bytes, offset), byteAt(bytes, offset + 1), byteAt(bytes, offset + 2), byteAt(bytes, offset + 3));
	if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("不是合法的 RIFF/WAVE 音频");

	let offset = 12;
	let fmt: { code: number; channels: number; sampleRate: number; bits: number } | undefined;
	let data: { start: number; size: number } | undefined;
	while (offset + 8 <= bytes.byteLength) {
		const id = tag(offset);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (id === "fmt " && body + 16 <= bytes.byteLength) {
			fmt = {
				code: view.getUint16(body, true),
				channels: view.getUint16(body + 2, true),
				sampleRate: view.getUint32(body + 4, true),
				bits: view.getUint16(body + 14, true),
			};
		} else if (id === "data") {
			data = { start: body, size: Math.min(size, Math.max(0, bytes.byteLength - body)) };
		}
		offset = body + size + (size % 2);
		if (fmt !== undefined && data !== undefined) break;
	}
	if (fmt === undefined || data === undefined) throw new Error("WAV 缺少 fmt/data 数据块");

	const { code, channels, bits, sampleRate } = fmt;
	if (!(channels >= 1)) throw new Error("WAV 声道数非法：" + String(channels));
	if (!(sampleRate > 0)) throw new Error("WAV 采样率非法：" + String(sampleRate));
	const bytesPerSample = bits / 8;
	if (!(bytesPerSample >= 1)) throw new Error("WAV 位深非法：" + String(bits));
	if (code !== 1 && code !== 3) throw new Error("暂不支持的 WAV 编码格式：" + String(code));

	const frames = Math.floor(data.size / (bytesPerSample * channels));
	if (frames <= 0) return { samples: new Float32Array(0), sampleRate: targetSampleRate };

	const pcm = new Float32Array(frames);
	for (let i = 0; i < frames; i += 1) {
		let sum = 0;
		for (let c = 0; c < channels; c += 1) {
			const p = data.start + (i * channels + c) * bytesPerSample;
			let value: number;
			if (code === 3) value = view.getFloat32(p, true);
			else if (bits === 8) value = (view.getUint8(p) - 128) / 128;
			else if (bits === 16) value = view.getInt16(p, true) / 32768;
			else if (bits === 24) {
				const lo = view.getUint8(p);
				const mid = view.getUint8(p + 1);
				const hi = view.getInt8(p + 2);
				value = ((hi << 16) | (mid << 8) | lo) / 8388608;
			} else if (bits === 32) value = view.getInt32(p, true) / 2147483648;
			else throw new Error("暂不支持的 WAV 位深：" + String(bits));
			sum += value;
		}
		pcm[i] = sum / channels;
	}

	if (sampleRate === targetSampleRate) return { samples: pcm, sampleRate: targetSampleRate };
	// Linear interpolation instead of the native LinearResampler: its return
	// value is another external buffer.
	const target = Math.max(1, Math.round((pcm.length * targetSampleRate) / sampleRate));
	const out = new Float32Array(target);
	const ratio = target > 1 ? (pcm.length - 1) / (target - 1) : 0;
	for (let i = 0; i < target; i += 1) {
		const x = i * ratio;
		const i0 = Math.floor(x);
		const i1 = Math.min(pcm.length - 1, i0 + 1);
		const f = x - i0;
		out[i] = (pcm[i0] ?? 0) * (1 - f) + (pcm[i1] ?? 0) * f;
	}
	return { samples: out, sampleRate: targetSampleRate };
}
