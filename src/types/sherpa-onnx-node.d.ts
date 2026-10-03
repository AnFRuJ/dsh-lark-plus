// Minimal ambient types for the sherpa-onnx-node surface this plugin uses.
// The package ships JSDoc-only types; declaring the narrow surface keeps
// `tsc --noEmit` fast and pins the exact contract we depend on.

declare module "sherpa-onnx-node/non-streaming-asr.js" {
	export interface OfflineStream {
		acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
		setOption(key: string, value: string): void;
	}
	export interface OfflineRecognizerResult {
		text?: string;
		lang?: string;
		tokens?: string[];
	}
	export class OfflineRecognizer {
		constructor(config: unknown);
		static createAsync(config: unknown): Promise<OfflineRecognizer>;
		createStream(hotwords?: string): OfflineStream;
		decode(stream: OfflineStream): void;
		decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>;
		getResult(stream: OfflineStream): OfflineRecognizerResult;
		setConfig(config: unknown): void;
	}
}

declare module "sherpa-onnx-node/addon.js" {
	export function readWaveFromBinary(wav: Uint8Array | Buffer): {
		samples: Float32Array;
		sampleRate: number;
	};
	export function readWave(path: string): { samples: Float32Array; sampleRate: number };
	export const version: string;
	export const onnxruntimeVersion: string;
}
