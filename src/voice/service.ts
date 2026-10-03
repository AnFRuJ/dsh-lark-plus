// VoiceService: turns an inbound Feishu audio message into text, using a
// fully local SenseVoice model. This is the seam the message handler talks
// to; the heavy lifting lives in ./transcribe.ts.
//
// Contract: never throws. A failure yields { text: undefined, errors } and
// the caller still forwards the persisted audio path, so a broken STT setup
// degrades instead of dropping the message.

import { join } from "node:path";
import {
	DEFAULT_MODEL_URL,
	downloadModel,
	getDownloadState,
	modelFiles,
	modelReady,
	prepareAudio,
	readWavFile,
	resolveFfmpeg,
	resolveModelDir,
	startModelDownload,
	transcribeWavBuffer,
} from "./transcribe.ts";
import type { DownloadState, VoiceOptions } from "./transcribe.ts";

export interface VoiceLogger {
	warn(message: string): void;
	info(message: string): void;
}

export interface TranscribeOutcome {
	/** Recognized text, undefined when transcription was not possible. */
	text?: string;
	/** Local path of the raw received audio (kept regardless). */
	localPath?: string;
	/** Non-fatal problems, in order. */
	errors: string[];
	/** True when the model was missing and a download was started. */
	downloadStarted?: boolean;
}

export interface VoiceService {
	/** Model directory currently in use. */
	modelDir(): string;
	/** True when both model files exist and are non-empty. */
	ready(): boolean;
	/** ffmpeg that will be used (undefined = not found). */
	ffmpeg(): string | undefined;
	/** Human-readable one-liner for /lark-voice status. */
	statusLine(): string;
	/** Live download progress. */
	download(): DownloadState;
	/** Start the model download in the background (resolves immediately). */
	startDownload(): void;
	/** Await a full model download (used by /lark-voice download). */
	downloadNow(): Promise<DownloadState>;
	/**
	 * Transcribe audio bytes received from Feishu.
	 * baseName is the file stem used for the persisted raw audio; uniqueSuffix
	 * separates two voice messages that arrive inside the same millisecond.
	 */
	transcribe(
		buffer: Uint8Array,
		baseName: string,
		durationMs: number,
		inboundDir: string | undefined,
		uniqueSuffix?: string | number,
	): Promise<TranscribeOutcome>;

	/** Options change when config hot-reloads; call after each reload. */
	configure(opts: VoiceOptions): void;
}

export function createVoiceService(
	logger: VoiceLogger,
	opts: VoiceOptions = {},
): VoiceService {
	let current: VoiceOptions = { ...opts };

	const modelDir = (): string => resolveModelDir(current.modelDir);
	const diag = (): string => {
		const missing = !modelReady(modelDir());
		const ff = resolveFfmpeg(current.ffmpegPath);
		return [
			"engine=SenseVoice(sherpa-onnx, cpu)",
			"modelDir=" + modelDir(),
			"model=" + (missing ? "missing" : "ready"),
			"ffmpeg=" + (ff ?? "missing"),
		].join(" ");
	};

	return {
		modelDir,
		ready: () => modelReady(modelDir()),
		ffmpeg: () => resolveFfmpeg(current.ffmpegPath),
		statusLine: diag,
		download: () => getDownloadState(),
		configure(next) {
			current = { ...current, ...next };
		},
		startDownload() {
			if (modelReady(modelDir())) return;
			logger.info("[voice] model missing — starting background download");
			startModelDownload(modelDir(), current);
		},
		async downloadNow() {
			return downloadModel(modelDir(), current);
		},
		async transcribe(buffer, baseName, durationMs, inboundDir, uniqueSuffix) {
			const errors: string[] = [];
			const stem = uniqueSuffix === undefined ? baseName : baseName + "-" + uniqueSuffix;
			const prepared = prepareAudio(buffer, inboundDir, stem, durationMs, current);
			errors.push(...prepared.errors);
			if (!prepared.wavPath) {
				return { localPath: prepared.localPath, errors };
			}
			const result = await transcribeWavBuffer(readWavFile(prepared.wavPath), current);
			if (result.ok) {
				return { text: result.text, localPath: prepared.localPath, errors };
			}
			if (result.modelMissing) {
				// Keep the audio; the user can resend once the model lands.
				this.startDownload();
				return {
					localPath: prepared.localPath,
					errors: [...errors, "语音模型尚在下载，请稍后重发这条语音"],
					downloadStarted: true,
				};
			}
			return { localPath: prepared.localPath, errors: [...errors, result.error ?? "转写失败"] };
		},
	};
}

/** Default model URL exported for the README / doctor output. */
export const VOICE_MODEL_URL = DEFAULT_MODEL_URL;
export { modelFiles };
