// Voice: fully local (offline) speech-to-text for inbound Feishu voice
// messages. Engine: SenseVoice via sherpa-onnx (CPU inference, ONNX Runtime).
// Nothing here touches the network except the one-time model download; audio
// never leaves the machine.
//
// Pipeline: OGG/Opus (Feishu) --ffmpeg--> 16 kHz mono PCM16 WAV
//           --> sherpa-onnx OfflineRecognizer --> text (+ punctuation).
//
// Fail-open by design: a missing ffmpeg, an absent model or a decode error
// must never drop a message. The caller keeps the audio file and degrades.

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** 16 kHz mono is what SenseVoice expects. */
export const TARGET_SAMPLE_RATE = 16_000;

/** Official int8 SenseVoice release (zh/en/ja/ko/yue, punctuation included). */
export const DEFAULT_MODEL_URL =
	"https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2";
export const MODEL_ARCHIVE_NAME =
	"sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2";

/** Mirrors tried in order when the primary URL fails (mainland networks). */
export const DEFAULT_MIRRORS: readonly string[] = [
	"https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx",
	"https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
	"https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
];
export const MIRROR_TOKENS_URL =
	"https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt";

export interface VoiceOptions {
	/** Model directory override. Empty = $DSH_HOME/voice/sensevoice. */
	modelDir?: string;
	/** ffmpeg executable. Empty = auto-detect (see resolveFfmpeg). */
	ffmpegPath?: string;
	/** Primary model URL override. */
	modelUrl?: string;
	/** Comma-separated mirror list override (config voice.mirrors). */
	mirrors?: string;
	/** Child process timeout for the transcode, ms. */
	ffmpegTimeoutMs?: number;
}

const require_ = createRequire(import.meta.url);

/** Resolve the model directory using the same convention as dsh-voice-local,
 *  so an already-downloaded model is shared instead of fetched twice. */
export function resolveModelDir(override?: string): string {
	const env = process.env.DSH_VOICE_MODEL_DIR;
	if (typeof override === "string" && override.trim() !== "") return override.trim();
	if (typeof env === "string" && env.trim() !== "") return env.trim();
	const home = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
	return join(home, "voice", "sensevoice");
}

export function modelFiles(dir: string): { model: string; tokens: string } {
	return { model: join(dir, "model.int8.onnx"), tokens: join(dir, "tokens.txt") };
}

export function modelReady(dir: string): boolean {
	const { model, tokens } = modelFiles(dir);
	try {
		return statSync(model).size > 0 && statSync(tokens).size > 0;
	} catch {
		return false;
	}
}

/**
 * Locate ffmpeg. Order: explicit config > DSH_VOICE_FFMPEG > PATH > common
 * install locations. Returns undefined when nothing is found (the caller
 * then reports a readable error instead of silently skipping).
 */
export function resolveFfmpeg(explicit?: string): string | undefined {
	if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim();
	const env = process.env.DSH_VOICE_FFMPEG;
	if (typeof env === "string" && env.trim() !== "") return env.trim();
	const which = spawnSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], { encoding: "utf8" });
	const found = which.status === 0 ? (which.stdout ?? "").split(/\r?\n/)[0]?.trim() : "";
	if (found && existsSync(found)) return found;
	for (const candidate of [
		"D:/ffmpeg/bin/ffmpeg.exe",
		"C:/ffmpeg/bin/ffmpeg.exe",
		"/opt/homebrew/bin/ffmpeg",
		"/usr/local/bin/ffmpeg",
		"/usr/bin/ffmpeg",
	]) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

export interface TranscodeResult {
	ok: boolean;
	wavPath?: string;
	error?: string;
}

/** Decode any audio file ffmpeg understands into 16 kHz mono PCM16 WAV. */
export function transcodeToWav(
	input: string,
	output: string,
	ffmpeg: string | undefined,
	timeoutMs = 60_000,
): TranscodeResult {
	if (!ffmpeg) return { ok: false, error: "未找到 ffmpeg（配置 voice.ffmpegPath 或设置 DSH_VOICE_FFMPEG）" };
	if (!existsSync(input)) return { ok: false, error: "输入音频不存在: " + input };
	try {
		const conv = spawnSync(
			ffmpeg,
			["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-ar", String(TARGET_SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", output],
			{ encoding: "utf8", timeout: timeoutMs },
		);
		if (conv.status !== 0 || !existsSync(output)) {
			const detail = (conv.stderr || conv.error?.message || "退出码 " + String(conv.status)).trim();
			return { ok: false, error: "ffmpeg 转换失败: " + detail.slice(0, 400) };
		}
		return { ok: true, wavPath: output };
	} catch (err) {
		return { ok: false, error: "ffmpeg 转换异常: " + (err instanceof Error ? err.message : String(err)) };
	}
}

// ---- recognizer -----------------------------------------------------------

interface RecognizerLike {
	createStream: () => unknown;
	decode: (stream: unknown) => void;
	getResult: (stream: unknown) => { text?: string };
}
interface StreamLike {
	acceptWaveform: (o: { samples: Float32Array; sampleRate: number }) => void;
}

let recognizer: RecognizerLike | undefined;
let recognizerDir: string | undefined;
let loading: Promise<RecognizerLike> | undefined;
let addon: { readWaveFromBinary: (b: Uint8Array) => { samples: Float32Array; sampleRate: number } } | undefined;

function loadSherpa(): { OfflineRecognizer: new (cfg: unknown) => RecognizerLike } {
	return require_("sherpa-onnx-node/non-streaming-asr.js") as { OfflineRecognizer: new (cfg: unknown) => RecognizerLike };
}

function loadAddon(): NonNullable<typeof addon> {
	// The package root deliberately re-exports only readWave/writeWave; the
	// binary-in/binary-out decoder lives on the addon module itself.
	return require_("sherpa-onnx-node/addon.js") as NonNullable<typeof addon>;
}

export function buildRecognizerConfig(dir: string): unknown {
	const { model, tokens } = modelFiles(dir);
	return {
		featConfig: { sampleRate: TARGET_SAMPLE_RATE, featureDim: 80 },
		modelConfig: {
			senseVoice: { model, language: "auto", useInverseTextNormalization: 1 },
			tokens,
			numThreads: 4,
			provider: "cpu",
			debug: 0,
		},
	};
}

/** Load (once) the SenseVoice recognizer for dir. Throws a readable error
 *  when the native addon or the model is unusable. */
export async function ensureRecognizer(dir: string): Promise<RecognizerLike> {
	if (recognizer && recognizerDir === dir) return recognizer;
	if (loading) return loading;
	loading = (async () => {
		if (!modelReady(dir)) throw new Error("语音模型未就绪（缺少 " + modelFiles(dir).model + " 或 tokens.txt）");
		const { OfflineRecognizer } = loadSherpa();
		const created = new OfflineRecognizer(buildRecognizerConfig(dir));
		recognizer = created;
		recognizerDir = dir;
		return created;
	})();
	try {
		return await loading;
	} finally {
		loading = undefined;
	}
}

export function disposeRecognizer(): void {
	recognizer = undefined;
	recognizerDir = undefined;
}

/** Drop the cached recognizer when the configured model directory changed. */
export function releaseRecognizerIfStale(dir: string): void {
	if (recognizer && recognizerDir !== dir) disposeRecognizer();
}

// ---- transcription --------------------------------------------------------

export interface TranscribeResult {
	ok: boolean;
	text?: string;
	error?: string;
	/** True when the model is still missing (caller may start a download). */
	modelMissing?: boolean;
}

/**
 * Transcribe a 16 kHz mono PCM16 WAV buffer. Returns ok:false instead of
 * throwing, so one bad voice message can never break the pipeline.
 */
export async function transcribeWavBuffer(
	wav: Uint8Array,
	opts: VoiceOptions = {},
): Promise<TranscribeResult> {
	const dir = resolveModelDir(opts.modelDir);
	if (!modelReady(dir)) return { ok: false, error: "语音模型未就绪", modelMissing: true };
	try {
		releaseRecognizerIfStale(dir);
		const rec = await ensureRecognizer(dir);
		addon ??= loadAddon();
		const wave = addon.readWaveFromBinary(wav);
		let samples = wave.samples;
		if (wave.sampleRate !== TARGET_SAMPLE_RATE) {
			const ratio = TARGET_SAMPLE_RATE / wave.sampleRate;
			const out = new Float32Array(Math.max(1, Math.round(samples.length * ratio)));
			for (let i = 0; i < out.length; i++) {
				const pos = i / ratio;
				const i0 = Math.floor(pos);
				const i1 = Math.min(samples.length - 1, i0 + 1);
				const frac = pos - i0;
				const a = samples[i0];
				const b = samples[i1];
				if (a === undefined || b === undefined) continue;
				out[i] = a * (1 - frac) + b * frac;
			}
			samples = out;
		}
		const stream = rec.createStream();
		(stream as StreamLike).acceptWaveform({ samples, sampleRate: TARGET_SAMPLE_RATE });
		rec.decode(stream);
		const result = rec.getResult(stream);
		return { ok: true, text: String(result?.text ?? "").trim() };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// ---- model download -------------------------------------------------------

export interface DownloadState {
	running: boolean;
	phase: "idle" | "download" | "extract" | "done" | "error";
	receivedBytes: number;
	totalBytes: number | null;
	error?: string;
	startedAt?: string;
}

let downloadState: DownloadState = { running: false, phase: "idle", receivedBytes: 0, totalBytes: null };

export function getDownloadState(): DownloadState {
	return { ...downloadState };
}

async function fetchToFile(url: string, dest: string, onBytes: (n: number) => void): Promise<number> {
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok || !res.body) throw new Error("HTTP " + res.status + " " + url);
	downloadState.totalBytes = Number(res.headers.get("content-length") ?? 0) || null;
	const chunks: Uint8Array[] = [];
	let received = 0;
	for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
		chunks.push(chunk);
		received += chunk.length;
		onBytes(received);
	}
	writeFileSync(dest, Buffer.concat(chunks));
	return received;
}

/**
 * Download + install the SenseVoice model into dir. Idempotent (a ready
 * directory short-circuits) and multi-mirror. Extraction uses the system
 * tar; the hf-mirror direct-file route avoids tar entirely and is listed
 * first in DEFAULT_MIRRORS for that reason.
 */
export async function downloadModel(dir: string, opts: VoiceOptions = {}): Promise<DownloadState> {
	if (modelReady(dir)) {
		downloadState = { running: false, phase: "done", receivedBytes: 0, totalBytes: null };
		return getDownloadState();
	}
	if (downloadState.running) return getDownloadState();
	downloadState = { running: true, phase: "download", receivedBytes: 0, totalBytes: null, startedAt: new Date().toISOString() };
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, ".download");
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	try {
		const mirrors = (opts.mirrors ?? "").split(",").map((s) => s.trim()).filter(Boolean);
		const urls = [opts.modelUrl?.trim(), ...mirrors, ...DEFAULT_MIRRORS].filter(
			(u): u is string => typeof u === "string" && u !== "",
		);
		let installed = false;
		let lastError = "";
		for (const url of urls) {
			try {
				if (/\.onnx(\?|$)/i.test(url)) {
					const modelOut = join(tmp, "model.int8.onnx");
					await fetchToFile(url, modelOut, (n) => { downloadState.receivedBytes = n; });
					const tokensOut = join(tmp, "tokens.txt");
					await fetchToFile(MIRROR_TOKENS_URL, tokensOut, () => {});
					renameSync(modelOut, modelFiles(dir).model);
					renameSync(tokensOut, modelFiles(dir).tokens);
					installed = true;
				} else {
					const archive = join(tmp, basename(new URL(url).pathname) || MODEL_ARCHIVE_NAME);
					await fetchToFile(url, archive, (n) => { downloadState.receivedBytes = n; });
					downloadState.phase = "extract";
					const extractDir = join(tmp, "extract");
					mkdirSync(extractDir, { recursive: true });
					const untar = spawnSync("tar", ["-xjf", archive, "--strip-components=1", "-C", extractDir], { encoding: "utf8" });
					if (untar.status !== 0) throw new Error("tar 解压失败: " + (untar.stderr || "").slice(0, 200));
					if (!existsSync(join(extractDir, "model.int8.onnx"))) throw new Error("归档内未找到 model.int8.onnx");
					renameSync(join(extractDir, "model.int8.onnx"), modelFiles(dir).model);
					renameSync(join(extractDir, "tokens.txt"), modelFiles(dir).tokens);
					installed = true;
				}
				if (installed) break;
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
			}
		}
		if (!installed) throw new Error(lastError || "所有下载源均失败");
		downloadState = { running: false, phase: "done", receivedBytes: downloadState.receivedBytes, totalBytes: downloadState.totalBytes };
		return getDownloadState();
	} catch (err) {
		downloadState = {
			running: false,
			phase: "error",
			receivedBytes: downloadState.receivedBytes,
			totalBytes: downloadState.totalBytes,
			error: err instanceof Error ? err.message : String(err),
		};
		return getDownloadState();
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** Fire-and-forget download used on first contact (never blocks a turn). */
export function startModelDownload(dir: string, opts: VoiceOptions = {}): void {
	void downloadModel(dir, opts);
}

// ---- inbound media plumbing ----------------------------------------------

export interface DecodedAudio {
	localPath?: string;
	wavPath?: string;
	durationMs: number;
	errors: string[];
}

/** Persist a downloaded audio buffer and transcode it; never throws. */
export function prepareAudio(
	buffer: Uint8Array,
	inboundDir: string | undefined,
	baseName: string,
	durationMs: number,
	opts: VoiceOptions = {},
): DecodedAudio {
	const errors: string[] = [];
	let localPath: string | undefined;
	if (inboundDir) {
		try {
			mkdirSync(join(inboundDir, "media"), { recursive: true });
			const ext = detectContainer(buffer) === "ogg" ? "ogg" : "bin";
			localPath = join(inboundDir, "media", baseName + "." + ext);
			writeFileSync(localPath, buffer);
		} catch (err) {
			errors.push("落盘失败: " + (err instanceof Error ? err.message : String(err)));
		}
	} else {
		errors.push("未配置 inboundDir，音频无法落盘");
	}
	let wavPath: string | undefined;
	if (localPath) {
		const out = localPath + "." + TARGET_SAMPLE_RATE + ".wav";
		const conv = transcodeToWav(localPath, out, resolveFfmpeg(opts.ffmpegPath), opts.ffmpegTimeoutMs);
		if (conv.ok && conv.wavPath) wavPath = conv.wavPath;
		else if (conv.error) errors.push(conv.error);
	}
	return { localPath, wavPath, durationMs, errors };
}

/** Sniff the container from magic bytes (Feishu voice is OGG/Opus). */
export function detectContainer(buf: Uint8Array): string {
	const head = Buffer.from(buf.subarray(0, 4)).toString("ascii");
	if (head.startsWith("OggS")) return "ogg";
	if (head.startsWith("RIFF")) return "wav";
	if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "webm";
	return "unknown";
}

export function readWavFile(path: string): Uint8Array {
	return new Uint8Array(readFileSync(path));
}
