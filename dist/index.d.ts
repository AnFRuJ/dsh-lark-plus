import { Context } from "@deepseek-ai/cordis";
//#region src/common/types.d.ts
/** Feishu message types we care about. */
type FeishuMsgType = "text" | "post" | "image" | "file" | "audio" | "interactive" | "unknown";
type ChatType = "p2p" | "group";
type ChatMode = "group_at" | "group_all" | "p2p";
/** Normalized inbound message (v2.0 event structure collapsed). */
interface FeishuInboundMessage {
  messageId: string;
  chatId: string;
  chatType: ChatType;
  chatMode: ChatMode;
  senderOpenId: string;
  /** Bot-internal open id, e.g. ou_… for p2p; oc_… for group chat. */
  senderOpenIdInternal?: string;
  msgType: FeishuMsgType;
  content: string;
  /** Resolved human-readable text (interactive cards flattened). */
  text?: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  mentions: string[];
  timestamp: number;
}
/** Outbound envelope kinds routed by the OutboundRouter. */
type EnvelopeKind = "final" | "assistant-output" | "tool" | "notify" | "command-reply" | "scheduled" | "media";
/** Route target — persisted in routes.json (30d). */
interface Route {
  sessionKey: string;
  sessionId?: string;
  chatId: string;
  chatType: ChatType;
  threadMessageId?: string;
  lastMessageId?: string;
  updatedAt: number;
}
/** A single durable outbound envelope. */
interface OutboundEnvelope {
  id: string;
  dedupeKey: string;
  laneKey: string;
  route: RouteRef;
  kind: EnvelopeKind;
  payload: EnvelopePayload;
  status: "pending" | "sending" | "done" | "failed" | "fatal";
  attempts: number;
  nextRetryAt: number;
  createdAt: number;
  updatedAt: number;
  /** Payload spilled to a blob file when too large. */
  blobRef?: string;
  error?: string;
}
/** Minimal route reference kept inside each envelope (snapshot at enqueue). */
interface RouteRef {
  sessionKey: string;
  chatId: string;
  chatType: ChatType;
  threadMessageId?: string;
}
type EnvelopePayload = {
  kind: "text";
  text: string;
  card?: unknown;
} | {
  kind: "card";
  card: unknown;
  text?: string;
} | {
  kind: "media";
  fileKey: string;
  type: "image" | "file";
  caption?: string;
} | {
  kind: "reaction";
  messageId: string;
  emojiType: string;
};
/**
 * One agent preset a bridge session can run on, as surfaced by DSH's
 * agentPresets service. Harness-agnostic mirror of the roster row: the DSH
 * adapter maps its `AgentPreset` onto this shape, and the memory backend
 * simulates it, so the presentation layer never touches DSH types.
 */
interface AgentPresetOption {
  /** Stable id (the preset directory name); also the /mode argument. */
  id: string;
  /** Display label; falls back to `id` when the preset publishes none. */
  label: string;
  /** One sentence on what the preset is for. */
  desc?: string;
  /** 'system' ships with DSH; 'user' was authored locally. */
  trust?: "system" | "user";
  /** Why this preset cannot compose a session (absent = usable). */
  broken?: string;
}
/** Connection state machine. */
type ConnState = "idle" | "connecting" | "connected" | "degraded" | "reconnecting" | "quarantined" | "stopped";
/** Public bridge status snapshot (rendered by status-formatter). */
interface BridgeStatus {
  connState: ConnState;
  connectedAt?: number;
  lastProbeAt?: number;
  lastProbeOk?: boolean;
  outboxPending: number;
  outboxFailed: number;
  /** Accepted-but-undelivered inbound requests awaiting (possible) replay — a
   *  crash/restart mid-turn re-triggers these. Zero when everything answered. */
  inboundPending: number;
  /** GH #9: inbound requests that exhausted their replay budget without a
   *  delivery (terminal). Shown separately so inboundPending=0 is never
   *  mistaken for "everything answered". */
  inboundFailed: number;
  sessions: number;
  quarantinedUntil?: number;
  quarantinedReason?: string;
  lastError?: string;
  wsReady: boolean;
  owner?: {
    pid: number;
    host: string;
    startedAt: number;
  };
}
/** Lifecycle phase of an agent goal (mirroring @deepseek-ai/dsh-goal). */
type GoalPhase = "active" | "paused" | "blocked" | "complete";
/** Goal snapshot state within a bridge session. */
interface GoalSnapshotState {
  id: string;
  revision: number;
  objective: string;
  phase: GoalPhase;
  roundsStarted: number;
  maxGoalRounds: number;
  blockedReason?: {
    code: string;
    message: string;
  };
  createdAt?: number;
  updatedAt?: number;
}
/** Single todo item state (mirroring @deepseek-ai/dsh-tool-todo). */
interface TodoItemState {
  content: string;
  status: "pending" | "in_progress" | "completed";
}
//#endregion
//#region src/common/config.d.ts
type GroupPolicy = "open" | "mention" | "keywords" | "reply";
interface FeishuConfig {
  /** Ref key into ctx.credentials for the app secret (never the secret itself).
   * Must match credentialRef() pattern ^[A-Za-z_][A-Za-z0-9_]*$ (no dots). */
  credentialRef: string;
  /** Group trigger policy. */
  groupPolicy: GroupPolicy;
  /** Keyword triggers when groupPolicy = "keywords". */
  groupKeywords: string[];
  /** Also trigger when the bot is replied to (groupPolicy reply/mention). */
  alsoOnReply: boolean;
  /** Streaming: CardKit schema 2.0. Default OFF (省流量 — pi 31dc3c9:
   * 每轮输出直发完整回复；需要流式再热改开启). */
  streaming: {
    enabled: boolean;
    printFrequencyMs: number;
    printStep: number;
  };
  /** Reaction receipts: random on inbound (pool excludes DONE), ✅ on completion. */
  reactions: {
    enabled: boolean;
    /** Default random pool — only Feishu-valid emoji types. */
    pool: string[];
    /** Completion marker (never in the random pool). */
    done: string;
  };
  /** Inbound media (downloaded Feishu images/files).
   * Transient turn artifacts: default root is the OS temp dir with
   * age-based sweeping — see attachments.dir / retentionHours. */
  attachments: {
    /** Root override for inbound media. Empty = OS temp dir
     * (recommended: the OS may clear it at any time, the sweeper bounds
     * growth). Applied at startup — changing it needs a reload. */
    dir: string;
    /** Hours an inbound image/file survives on disk. 0 = keep forever
     * (pin attachments.dir to a durable location first). Hot-reloadable. */
    retentionHours: number;
  };
  /** Outbox tuning. */
  outbox: {
    /** Max attempts before an envelope becomes fatal. */
    maxAttempts: number;
    /** Bounded backoff ceiling, ms. */
    backoffMaxMs: number;
    /** Terminal-state retention, days. */
    retainDays: number;
    /** Hard cap of pending envelopes (spill protection). */
    pendingCap: number;
    /** Payloads above this many bytes spill to a blob file. */
    blobThreshold: number;
  };
  /** Connection supervision. */
  supervisor: {
    probeIntervalMs: number;
    probeTimeoutMs: number;
    /** Consecutive probe failures before degrade. */
    probeFailThreshold: number;
    /** Max reconnect attempts before quarantine. */
    maxReconnectAttempts: number;
    /** Quiet threshold: probe healthy => never rebuild idle connections. */
    idleKeepaliveMs: number;
  };
  /** Quota circuit breaker: window/limit of connect attempts. */
  quota: {
    windowMinutes: number;
    limit: number;
  };
  /** Deny list: exact command prefixes rejected outright (no prompt, no card). */
  denyList: string[];
  /** Session retention: idle TTL before agent dispose (memory). */
  sessionIdleTtlMs: number;
  /** Max concurrently hosted sessions. */
  maxSessions: number;
  /** Owner allowlist (optional): restrict inbound to these open_ids. Empty = all. */
  allowlist: string[];
  /** Bridge agent workspace root (cwd for created sessions). Empty = process.cwd(). */
  workspaceRoot: string;
  /**
   * Agent preset for bridge sessions. Any preset id the deployment supplies —
   * the shipped `standard | ptc | minimal | cordis`, OR a locally authored
   * (user) preset id created in the DSH GUI — is valid. `/mode` renders the
   * live roster (shipped + custom); `/lark-config agentPreset=<id>` accepts
   * any id verbatim. Historical bridge alias `code` is normalized to `ptc`
   * at use time (GH #11) — DSH has no `code` preset.
   */
  agentPreset: string;
  /** Default DSH permission preset (read-only | workspace-write | danger-full-access). */
  permissionMode: string;
}
interface ConfigStore {
  get(): FeishuConfig;
  /** Hot reload a whitelisted partial; returns the effective config. */
  update(partial: Partial<FeishuConfig>): FeishuConfig;
  /** Persist the current config to disk (for hot overrides). */
  save(): void;
  /** Persist overrides to the runtime-overrides.json. */
  saveOverrides(): void;
  path(): string;
}
//#endregion
//#region src/common/logger.d.ts
interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}
//#endregion
//#region src/common/connection-status.d.ts
interface StatusStore {
  get(): BridgeStatus;
  update(patch: Partial<BridgeStatus>): BridgeStatus;
  setConn(state: ConnState, extra?: Partial<BridgeStatus>): BridgeStatus;
  /** Refresh any subset of the bridge counters (outbox + inbound replay). */
  refreshCounters(counters: Partial<Pick<BridgeStatus, "outboxPending" | "outboxFailed" | "inboundPending" | "inboundFailed">>): void;
}
//#endregion
//#region src/sessions/dsh-session-backend.d.ts
interface AttachmentInput {
  /** Local file path (image/file). */
  path: string;
  kind: "image" | "file";
  name?: string;
  /** Extracted text preview (bounded) for inbound files. */
  textPreview?: string;
  /** Inbound voice note: lets the adapter emit a voice-aware note AND attach
   *  the clip as a real file part (see ./dsh-adapter.ts). */
  voice?: {
    seconds: number;
    transcribed: boolean;
  };
  /** Durable ref from ctx.attachments.saveFile — makes a real FileBlock. */
  fileRef?: unknown;
  /** Inbound Feishu image — durable attachment ref for an ImageBlock. */
  imageRef?: {
    attachmentId: string;
    mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    bytes: number;
    width: number;
    height: number;
    name?: string;
  };
}
/** Events the bridge consumes from a DSH session (normalized slice). */
type SessionEventOut = {
  type: "turn/start";
} | {
  type: "assistant/chunk";
  text: string;
} | {
  type: "assistant/message";
  text: string;
} | {
  type: "turn/end";
  reason: string;
  finalText?: string;
} | {
  type: "tool/call";
  name: string;
} | {
  type: "tool/result";
  name: string;
  error?: {
    name: string;
    code: string;
  };
} | {
  type: "todo/write";
  todos: TodoItemState[];
} | {
  type: "goal/change";
  goal: GoalSnapshotState;
};
interface AgentHandle {
  agentId: string;
  sessionId: string;
  /** Live underlying DSH Agent instance if running on real DSH harness. */
  rawAgent?: unknown;
  /** Ask the agent to handle a user message (queue; wake on idle). */
  followup(text: string, attachments?: AttachmentInput[]): Promise<void>;
  /** Cancel the current turn (only this session). */
  cancel(): Promise<void>;
  /** Subscribe to session events; returns an unsubscribe. */
  onEvent(fn: (e: SessionEventOut) => void): () => void;
  /** Idle when no turn is running. */
  isIdle(): boolean;
  dispose(): Promise<void>;
}
interface DshSessionBackend {
  /** Get-or-create an agent for a conversation key (persisted mapping). */
  ensureAgent(key: string, seed?: {
    chatId: string;
    chatType: string;
  }): Promise<AgentHandle>;
  /**
   * Resume a PERSISTED historical session in this conversation (/resume):
   * detach the current agent (never dispose — its session row must survive)
   * and load the stored log as the live agent identity. `opts.preset`
   * carries the session's STORED agent preset (resume must recompose the
   * same world, not the conversation's current override).
   */
  resumeAgent(key: string, sessionId: string, opts?: {
    preset?: string;
  }): Promise<AgentHandle>;
  /** Look up a previously created agent (no creation). */
  get(key: string): AgentHandle | undefined;
  /** Map sessionId back to conversation key (for event routing). */
  keyForSessionId(sessionId: string): string | undefined;
  /**
   * The agent presets this deployment currently supplies — shipped AND
   * user-authored (custom) rows. When DSH's agentPresets service is
   * unavailable, the memory backend returns the shipped roster only.
   */
  listPresets(): Promise<AgentPresetOption[]>;
  /** Dispose idle agents beyond ttl; returns disposed count. */
  disposeIdle(idleTtlMs: number): number;
  /** Bump a conversation's session generation — next ensureAgent uses a fresh id (/new). */
  rotate(key: string): void;
  /** Dispose one conversation's agent (mode/model/workspace switches rebuild it). */
  dispose(key: string): Promise<void>;
  /** ONE-SHOT grace: true exactly once after an image-degrade retry was
   * issued for `key` (agent/error "does not support image input" → text-only
   * re-send). The turn supervisor consumes it on a silent turn/end to skip
   * agent recovery — otherwise it would dispose the agent and kill the
   * retry mid-flight (the retry's turn/start lands BEFORE the original
   * turn's turn/end(error)). One-shot: a retry that itself dies gets normal
   * recovery on the second turn/end. */
  consumeImageRetryGrace?(key: string): boolean;
  /** Clear any remembered image-unsupported marks (e.g. after a /model switch). */
  clearImageUnsupported?(key?: string): void;
  /** Number of hosted agents. */
  size(): number;
  /** Dispose everything (bridge teardown). */
  disposeAll(): Promise<void>;
}
//#endregion
//#region src/sessions/conversation-manager.d.ts
interface ConversationManager {
  /** Handle an inbound Feishu message: enqueue into the per-key FIFO. */
  handleMessage(msg: FeishuInboundMessage, attachments?: AttachmentInput[]): Promise<void>;
  /** Key for a message (dm:* for p2p, group:* for group chats). */
  keyFor(msg: FeishuInboundMessage): string;
  /** Cancel the current turn of one conversation (does not touch others). */
  stop(key: string): Promise<void>;
  /** Dispose one conversation's agent (next message rebuilds it under new config). */
  dispose(key: string): Promise<void>;
  /** /new — bump session generation and dispose, so the next message starts fresh. */
  rotate(key: string): Promise<void>;
  /** Reap idle agents; returns disposed count. */
  sweep(): number;
  size(): number;
  keys(): string[];
  disposeAll(): Promise<void>;
}
//#endregion
//#region src/outbound/outbox.d.ts
interface Outbox {
  enqueue(input: {
    dedupeKey: string;
    laneKey: string;
    route: RouteRef;
    kind: OutboundEnvelope["kind"];
    payload: EnvelopePayload;
    /** True to skip the idempotency check (missed-compensation replay). */
    skipDedupe?: boolean;
  }): string | undefined;
  /** Start draining all lanes. */
  start(): void;
  /** Stop draining (in-flight deliveries settle). */
  stop(): Promise<void>;
  pendingCount(): number;
  failedCount(): number;
  /** Remove terminal envelopes older than retainDays. */
  prune(): void;
  /** Crash recovery: anything left 'sending' returns to 'pending'. */
  rebuildFromDisk(): void;
  /** Internal: lanes currently draining (for tests/status). */
  lanes(): string[];
}
//#endregion
//#region src/outbound/event-forwarder.d.ts
/** A normalized slice of the DSH session event surface we care about. */
type BridgeSessionEvent = {
  type: "turn/start";
} | {
  type: "assistant/chunk";
  text: string;
} | {
  type: "assistant/message";
  text: string;
} | {
  type: "turn/end";
  reason: string;
  finalText?: string;
} | {
  type: "tool/call";
  name: string;
} | {
  type: "tool/result";
  name: string;
  error?: {
    name: string;
    code: string;
  };
} | {
  type: "todo/write";
  todos: TodoItemState[];
} | {
  type: "goal/change";
  goal: GoalSnapshotState;
};
interface EventForwarder {
  /** Feed one normalized DSH session event for a session key. */
  onSessionEvent(sessionKey: string, event: BridgeSessionEvent): Promise<void>;
  /** Finalize any in-flight streaming cards for a session. */
  finalizeSession(sessionKey: string): Promise<void>;
}
//#endregion
//#region src/outbound/outbound-router.d.ts
interface RouteStore {
  get(key: string): Route | undefined;
  all(): Route[];
  upsert(route: Route): void;
  touch(key: string, lastMessageId?: string): void;
  remove(key: string): void;
  prune(maxAgeMs: number): void;
  persist(): void;
}
//#endregion
//#region src/inbound/transport.d.ts
interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;
  wsReady(): boolean;
  /** REST probe used by the supervisor. */
  probe(): Promise<boolean>;
  botOpenId(): string | undefined;
  /** Download a message resource (image/file) — inbound multimedia. */
  downloadResource(params: {
    messageId: string;
    fileKey: string;
    type: "image" | "file";
  }): Promise<Buffer>;
}
//#endregion
//#region src/inbound/missed-compensation.d.ts
interface MissedCompensation {
  /** Called when the connection recovers. */
  onRecovered(): Promise<void>;
  /** Record a delivered message id so compensation can skip it. */
  noteDelivered(messageId: string): void;
}
//#endregion
//#region src/voice/transcribe.d.ts
interface VoiceOptions {
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
interface DownloadState {
  running: boolean;
  phase: "idle" | "download" | "extract" | "done" | "error";
  receivedBytes: number;
  totalBytes: number | null;
  error?: string;
  startedAt?: string;
}
//#endregion
//#region src/voice/service.d.ts
interface TranscribeOutcome {
  /** Recognized text, undefined when transcription was not possible. */
  text?: string;
  /** Local path of the raw received audio (kept regardless). */
  localPath?: string;
  /** Non-fatal problems, in order. */
  errors: string[];
  /** True when the model was missing and a download was started. */
  downloadStarted?: boolean;
}
interface VoiceService {
  /** Model directory currently in use. */
  modelDir(): string;
  /** True when both model files exist and are non-empty. */
  ready(): boolean;
  /** ffmpeg that will be used (undefined = not found). */
  ffmpeg(): string | undefined;
  /** Human-readable one-liner for /lark status. */
  statusLine(): string;
  /** Live download progress. */
  download(): DownloadState;
  /** Start the model download in the background (resolves immediately). */
  startDownload(): void;
  /** Await a full model download (used by /lark download). */
  downloadNow(): Promise<DownloadState>;
  /**
   * Transcribe audio bytes received from Feishu.
   * baseName is the file stem used for the persisted raw audio; uniqueSuffix
   * separates two voice messages that arrive inside the same millisecond.
   */
  transcribe(buffer: Uint8Array, baseName: string, durationMs: number, inboundDir: string | undefined, uniqueSuffix?: string | number): Promise<TranscribeOutcome>;
  /**
   * Persist raw audio bytes without transcribing. Used when transcription is
   * disabled: the clip must survive either way (the raw path is what the
   * agent is told about, and what the user can replay in Feishu).
   */
  persistRawAudio(buffer: Uint8Array, baseName: string, inboundDir: string | undefined): {
    localPath?: string;
    errors: string[];
  };
  /** Transcribe an already-persisted audio file (no re-download). */
  transcribeRaw(localPath: string, durationMs: number): Promise<TranscribeOutcome>;
  /** Options change when config hot-reloads; call after each reload. */
  configure(opts: VoiceOptions): void;
}
//#endregion
//#region src/application/bridge-context.d.ts
/** Sender abstraction: how the bridge actually writes to Feishu. */
interface FeishuSender {
  replyTo(msg: FeishuInboundMessage, textOrCard: string | unknown): Promise<void>;
  sendText(chatId: string, text: string): Promise<unknown>;
  sendCard(chatId: string, card: unknown): Promise<unknown>;
  addReaction(messageId: string, emojiType: string): Promise<void>;
  sendFile(chatId: string, fileKey: string, type: "image" | "file"): Promise<unknown>;
  listMessages(params: {
    chatId: string;
    startTimeMs: number;
    endTimeMs: number;
  }): Promise<Array<{
    messageId: string;
    timestampMs: number;
  }>>;
}
/** DSH attachment service surface (ctx.attachments). */
interface ImageAttachmentService {
  /**
   * Persist a non-image file (voice clips). The returned ref is what makes the
   * followup carry a REAL file part instead of a mere text note — without it
   * the Web GUI has nothing to render, so the audio player never appears.
   */
  saveFile?(input: {
    data: Uint8Array;
    name?: string;
  }): Promise<unknown>;
  saveImage(input: {
    data: Uint8Array;
    mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    name?: string;
  }): Promise<{
    attachmentId: string;
    mediaType: string;
    bytes: number;
    width: number;
    height: number;
    name?: string;
  }>;
}
/** Read-side surface used by application services. */
interface BridgeContextRead {
  get conversations(): ConversationManager | undefined;
  get backend(): DshSessionBackend | undefined;
  get transport(): Transport | undefined;
  get outbox(): Outbox | undefined;
  get router(): RouteStore | undefined;
  get forwarder(): EventForwarder | undefined;
  get compensation(): MissedCompensation | undefined;
  get sender(): FeishuSender | undefined;
  get attachments(): ImageAttachmentService | undefined;
  /** Local offline voice transcription (undefined = feature off). */
  get voice(): VoiceService | undefined;
  get logger(): Logger;
  get cfg(): () => FeishuConfig;
  get configStore(): ConfigStore | undefined;
  get status(): StatusStore;
  botOpenId(): string | undefined;
  started(): boolean;
  conversationKeyFor(msg: FeishuInboundMessage): string;
  routeFor(key: string): Route | undefined;
  markDone(key: string, triggerMessageId?: string): Promise<void>;
}
//#endregion
//#region src/application/message-handler.d.ts
declare function resolveInboundAttachments(msg: FeishuInboundMessage, ctx: BridgeContextRead, inboundDir?: string, voice?: VoiceService, transcribe?: boolean): Promise<AttachmentInput[]>;
//#endregion
//#region src/index.d.ts
declare const name = "dsh-lark-plus";
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
/** Bridge state directory (<DSH_HOME>/lark, overridable). */
declare function stateDir(): string;
declare function apply(ctx: Context, rawConfig: unknown): void;
//#endregion
export { LarkLinkConfig, apply, inject, name, resolveInboundAttachments, stateDir };