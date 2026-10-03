import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
declare const name = "dsh-lark-voice";
declare const inject: string[];
interface LarkLinkConfig {
  enabled?: boolean;
  groupPolicy?: "open" | "mention" | "keywords" | "reply";
  denyList?: string[];
  /**
   * Local offline voice transcription (SenseVoice via sherpa-onnx).
   * Every field is optional; an unset block still transcribes with defaults.
   */
  voice?: {
    /** Master switch. false = keep the audio, skip transcription. */
    enabled?: boolean;
    /** Model directory (model.int8.onnx + tokens.txt). Empty =
     *  $DSH_HOME/voice/sensevoice (shared with dsh-voice-local). */
    modelDir?: string;
    /** ffmpeg executable used for the OGG/Opus → 16 kHz WAV step. */
    ffmpegPath?: string;
    /** Model archive URL override. */
    modelUrl?: string;
    /** Comma-separated mirror list tried before the built-in ones. */
    mirrors?: string;
    /** Transcode timeout, ms. */
    ffmpegTimeoutMs?: number;
  };
}
/** Bridge state directory (<DSH_HOME>/lark-voice, overridable). */
declare function stateDir(): string;
declare function apply(ctx: Context, rawConfig: unknown): void;
//#endregion
export { LarkLinkConfig, apply, inject, name, stateDir };