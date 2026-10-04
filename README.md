<p align="center">
  <img src="assets/mascot.png" alt="dsh-lark-plus mascot" width="420"/>
</p>

<h1 align="center">🪶 dsh-lark-plus</h1>

<p align="center">
  <b>DeepSeek Harness × 飞书/Lark 双向桥接</b><br/>
  私聊 / 群聊 · 卡片按钮 · 审批与提问回传 · 任务板 · goal · 定时任务<br/>
  外加：全程本机的语音转文字 + 网页端播放条
</p>

<p align="center">
  <img src="https://img.shields.io/npm/v/dsh-lark-plus?label=npm" alt="npm"/>
  <img src="https://img.shields.io/npm/dm/dsh-lark-plus?label=downloads" alt="downloads"/>
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT"/>
  <img src="https://img.shields.io/badge/node-%3E%3D24-green" alt="node"/>
  <img src="https://img.shields.io/badge/bridge-Feishu%20%7C%20Lark-blue" alt="bridge"/>
  <img src="https://img.shields.io/badge/voice-100%25%20offline-blue" alt="offline"/>
  <img src="https://img.shields.io/badge/based%20on-dsh--lark--link-orange" alt="fork"/>
</p>

---

# 中文

**DeepSeek Harness × 飞书/Lark 双向桥接插件**：把 DSH 智能体装进飞书——扫码建应用、30 秒上线，在飞书里对话、点卡片、回审批、跑任务、看任务板。**在此基础上**还带了一条全程本机的语音链路：飞书里按住说话，音频在本机由 SenseVoice 转成文字，并可直接在 DSH 网页端回放——**音频不出本机、不调任何云端语音 API**。

> **本仓库是 [`dsh-lark-link`](https://github.com/amlyczz/dsh-lark-link) 的 fork**（MIT，原作者及贡献者版权保留）。桥接部分沿用上游实现，语音链路为新增。详见文末[归属与许可](#归属与许可)。

## 🌟 桥接能力（沿用上游）

- **零门槛**：`/lark setup` 扫码即建飞书应用，不用手搓开放平台、不用配回调、不用公网服务器
- **零丢失**：出站 Outbox + 入站 WAL 双持久化，进程崩溃 / 插件热更 / dsh 重启后消息与回答都补得回来
- **零学习成本**：切换类命令都是单选卡片，点一下即生效；DSH 原生命令直接用
- **真 Agent**：不是聊天机器人——bash / 文件 / 子代理 / 工作流全套工具，飞书里跑完整 Harness

## ✨ 特性

| 能力 | 说明 |
| ---- | ---- |
| 🎙 **本地语音转写** | 飞书发语音 → 本机 SenseVoice 转文字（见上文）；音频原文件始终保留 |
| 🎯 **一键认证** | `/lark setup` 扫码创建飞书应用（自动订阅消息事件 + 群聊全量 + 表情权限 + 用户基本信息），**30 秒上线**；也支持 `DSH_LARK_APP_ID/SECRET` 手动通道 |
| 🧠 **多模式 Agent** | 标准 / PTC / 极简 / Cordis preset + 你在 GUI 自建的 preset，飞书发 `/mode` 出**单选卡片**即切 |
| 🎛 **权限分级** | 只读 / 工作区写 / **Full access** 三种权限，`/permission` 卡片即切 |
| 🎨 **卡片化命令** | `/mode` `/permission` `/model` 全是**单选按钮卡片**——点一下即切换 |
| 💬 **意图确认转发** | 模型提问（`ask_user_question`）→ **飞书意图确认卡片**，答完模型继续 |
| 😊 **表情回执** | 收到消息随机表情；回复完成 / 命令完成打 **DONE ✅** |
| 💪 **出站零丢失** | 持久 Outbox（JSONL + at-least-once + 幂等键 + 分航道并行 + 周期清理） |
| 🆕 **入站请求补发** | Agent 处理到一半插件/dsh 崩溃，重启后自动重新触发该消息 |
| 🛡 **连接自愈** | probe 驱动受控重连 + 配额熔断 + 断连补偿；环境代理自动规避 |
| 🔀 **命令三级分流** | 桥特有命令桥处理；DSH 注册命令原生执行；其余原样注入 Agent |
| 📎 **入站多媒体** | 飞书图片 → 视觉模型看图；文件 → 有界文本提取；**语音 → 本地转写** |
| 📤 **出站多媒体** | 模型经 `lark_send_local_file` 主动回传本地图片/文件 |
| 🩺 **一键诊断** | `/doctor` → **ZIP 诊断包**（含当前会话 session log + 脱敏配置） |
| ✍️ **Markdown 渲染** | 回复自动检测 markdown → **CardKit 卡片**渲染，纯文本走文本消息 |
| 🌊 **可选流式输出** | `/lark-config streaming.enabled=true` 热开流式卡片（默认关，省流量） |
| 🖥 **复用 DSH Web GUI** | 桥 Agent = 原生 DSH session，聊天/工具卡/设置全由 GUI 呈现 |
| 👥 **访问控制** | `allowlist` 白名单；`groupPolicy` 群聊触发策略；`denyList` 命令前缀拒绝兜底 |
## 🚀 快速开始

**前置**：Node.js ≥ 24，已安装 DeepSeek Harness。语音功能另需 **ffmpeg**（见上文）。

安装（DSH 官方 bundle 机制，产物已随仓库提交，不执行构建脚本）：

```bash
# 从 npm 安装（推荐，已发布 0.1.0）
dsh plugin --profile <你的档> add dsh-lark-plus

# 从 GitHub 仓库安装（跟进尚未发版的提交用这条）
dsh plugin --profile <你的档> add github:AnFRuJ/dsh-lark-plus

# 或本地目录（源码开发时）
dsh plugin --profile <你的档> add link:/path/to/dsh-lark-plus
```

装完在 DSH 输入框执行一次扫码上线：

```
/lark setup      # 手机飞书扫码，自动创建应用并写入凭据
/lark start      # 建立长连接
/lark status     # 查看连接/会话/补发计数
```

之后在飞书里直接发文字、图片、文件，**或按住说话发语音**。

> 桌面版 DSH 的 `desktop` 档由 Electron 独占，CLI 会拒绝；那种情况请走 GUI 侧边栏「插件」页添加同一条地址。

## 🎙 附加能力：本地离线语音转文字（+ 网页端回放）

### 它是怎么工作的

```
飞书语音（OGG/Opus）
   ↓  下载（本机 → 飞书 API，唯一的网络请求）
   ↓  原文件落盘保留      ← 你随时能在飞书回听，agent 也能复读同一份文件
   ↓  ffmpeg 转 16 kHz 单声道 WAV
   ↓  SenseVoice（sherpa-onnx，CPU 推理）
   文字 → 作为这条消息的正文交给智能体
```

- **引擎**：SenseVoice（int8，中/英/日/韩/粤 + 自动标点），通过 `sherpa-onnx-node` 在本机 CPU 上跑。
- **音频去向**：只有一次联网——首次使用时下载约 230 MB 的模型。之后完全离线。
- **失败不丢消息**：模型没下好、ffmpeg 缺失、解码失败时，音频照样落盘，正文留空并把原因写进日志。同一条语音永远不会因为转写失败而消失。
- **可关**：配置里 `voice.enabled: false` 就只保留音频、不做转写。
- **可回放**：DSH Web UI 里每条语音正文下面直接有一条播放条（宿主只读路由
  `GET /plugins/lark-plus/audio?name=…`，支持 Range），不用回飞书重听；原始附件卡片会被隐藏，一屏只剩「文字 + 播放条」。

### 前置条件

| 依赖 | 说明 |
|:--|:--|
| **ffmpeg** | 必须。飞书语音是 OGG/Opus，模型只吃 16 kHz WAV。默认按 PATH 查找，也认 `voice.ffmpegPath` / `DSH_VOICE_FFMPEG`。 |
| **模型** | 首次自动下载到 `$DSH_HOME/voice/sensevoice/`（默认 `~/.dsh/voice/sensevoice/`），**与 `dsh-voice-local` 共用同一目录**——已经装过那个插件的话不会重复下载。 |

手动放置模型（内网 / 下载慢时）：解压官方归档，保证目录里有 `model.int8.onnx` 和 `tokens.txt` 即可：

```bash
mkdir -p ~/.dsh/voice/sensevoice
# 官方：https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/
#       sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2
tar -xjf sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2 \
    --strip-components=1 -C ~/.dsh/voice/sensevoice
```

### 配置

```yaml
# cordis.patch.yml（profile 的 patch 层）
- id: lark-plus
  config:
    voice:
      enabled: true
      modelDir: ''        # 空 = $DSH_HOME/voice/sensevoice
      ffmpegPath: ''      # 空 = 自动探测
      modelUrl: ''        # 主下载源覆盖
      mirrors: ''         # 逗号分隔，优先于内置镜像（hf-mirror / ghfast / gh-proxy）
      ffmpegTimeoutMs: 60000
```

### 本地转写接口

语音链路把转写能力也开成了本机路由（可直接被其他工具复用；只服务本机）：

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| `GET` | `/dsh-voice-local/v1/health` | 引擎 / 模型 / ffmpeg / 下载状态 |
| `GET` | `/dsh-voice-local/v1/model/status` | 模型文件与下载进度 |
| `POST` | `/dsh-voice-local/v1/model/download` | 触发后台模型下载 |
| `POST` | `/dsh-voice-local/v1/transcribe` | body = **16 kHz 单声道 PCM16 WAV**，返回 `{ ok, text }` |

### 自测

```bash
npm run test:voice      # 真实模型 + 真实 ffmpeg；资产缺失时自动 skip
npm run check           # tsc --noEmit
```

## 📖 完整文档

下面保留上游的中文文档（命令、卡片、诊断、配置项等），其中的命令名已同步为 `/lark`。

---

## ⌨️ 命令

### DSH 侧（GUI 或终端）

```
/lark setup            扫码一键建应用（或 DSH_LARK_APP_ID/SECRET 手动通道）
/lark start|stop|restart|status   桥接生命周期与全链路健康
/lark uninstall-clean  清除凭据与状态目录
```

### 飞书侧（卡片化单选，无需记忆拼写）

| 类别 | 命令 | 行为 |
| ---- | ---- | ---- |
| 选择类 | `/mode` `/permission` `/model` | **单选按钮卡片**，点选即切换（动态感知自建 preset 与提供商） |
| 目标类 | `/goal [目标\|pause\|resume\|clear]` | 启动长任务自主执行 / 暂停 / 恢复 / 清除当前目标 |
| 状态类 | `/status` `/sessions` `/help` | 全链路健康（含 Outbox/补发计数）/ 会话列表 / 帮助卡片 |
| 会话类 | `/new` `/resume [序号\|id]` `/stop` `/workspace <路径>` | 新会话 / 极简恢复历史会话 / 停当前任务 / 切工作区 |
| 诊断 | `/doctor` | ZIP 诊断包（session log + 配置 + ISSUE.md） |
| 热改 | `/lark-config key=value` | 热改配置（如 `groupPolicy=open`、`agentPreset=standard`、`streaming.enabled=true`） |
| DSH 命令 | `/compact` 等 | 原生执行，结果回飞书 |
| 多媒体 | 发图片/文件 | 图片→视觉模型；文件→文本提取 |
| 意图确认 | 模型提问 | 自动转**飞书意图确认卡片**，选项或输入作答 |

> 命令无拦截、无门禁：一切 `/` 消息要么桥处理，要么原样交 DSH——绝不静默丢弃。skill 无前缀，直接说任务即可。

## ⚙️ 常用配置（`/lark-config` 热改，立即生效并持久化）

| 配置键 | 默认 | 说明 |
| ------ | ---- | ---- |
| `groupPolicy` | `open` | 群聊触发策略：`open`（免 @ 全触发）/ `mention` / `keywords` / `reply` |
| `groupKeywords` | `["lark","bot"]` | `keywords` 模式下的触发词 |
| `agentPreset` | `ptc` | Agent preset（shipped：standard/ptc/minimal/cordis，或 GUI 自建 id；历史别名 `code` 会自动映射为 `ptc`） |
| `permissionMode` | `danger-full-access` | 权限：read-only / workspace-write / danger-full-access |
| `streaming.enabled` | `false` | CardKit 流式卡片（开=逐字打印） |
| `reactions.enabled` | `true` | 表情回执 |
| `allowlist` | `[]` | open_id 白名单，空 = 所有人可对话 |
| `denyList` | `[]` | 命令前缀拒绝兜底 |
| `workspaceRoot` | `` | 桥会话工作区根目录（空 = process.cwd()） |
| `attachments.retentionHours` | `168` | 入站图片/文件的保留时长（小时，默认 7 天；`0` = 永久保留）。默认存系统临时目录，到期自动清扫 |
| `attachments.dir` | `` | 入站媒体根目录覆盖（空 = 系统 tmpdir；重启生效） |

> 凭据（appId/appSecret）存放在 DSH credentials 服务，不进配置文件；`/lark setup` 扫码自动写入。

## 🩺 遇到问题？

1. 飞书发 `/doctor`，得到 ZIP 诊断包（完整 session log + 脱敏配置 + ISSUE.md 模板）
2. 把诊断包贴给任意 AI（或在 GitHub Issue 中发出来），即可快速定位
3. `/status` 可随时看连接 / Outbox / 补发 / 会话全链路健康

## 🛠 开发者

```bash
npm run dev:link   # 链接本地 DSH checkout（类型检查/测试需要）
npm run check      # tsc --noEmit
npm test           # 264 项单元 + 集成测试
npm run build      # tsdown → dist/（宿主 ESM + client bundle）
npm pack           # 产出可分发 tarball
```

**架构**：桥 = Cordis 插件（`dsh.bundle` 格式），分层清晰：

`host`（SDK 适配/认证）→ `inbound`（传输/群触发/断连补偿/Inbound WAL）→ `application`（命令路由/消息编排/诊断）→ `outbound`（Outbox/事件转发/卡片）→ `sessions`（每会话 Agent 管理）。

CI（GitHub Actions）：push/PR 自动跑类型检查 + 264 项测试 + 构建；发布 npm 走 tag release 的 Publish workflow。

## 📄 许可

MIT — 自由使用、修改、分发。

本项目为社区插件，与 DeepSeek、飞书或 Lark 无隶属关系。

---

# English

<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/AnFRuJ/dsh-lark-plus@main/assets/mascot.png" alt="dsh-lark-plus mascot" width="420"/>
</p>

**DeepSeek Harness × Feishu/Lark bridge** — put your DSH agent inside Feishu. Scan a QR code and go live in 30 seconds; chat from anywhere. Plus fully local voice transcription and a play bar in the Web GUI.

## 🌟 Why dsh-lark-plus

- **Zero setup friction**: QR-scan app creation — no Open Platform fiddling, no callback URL, no public server
- **Zero message loss**: durable Outbox (outbound) + Inbound WAL — crashes, hot reloads, and dsh restarts all recover
- **Zero learning curve**: every toggle is a single-select card; native DSH commands (`/goal` `/compact` …) just work
- **A real agent**: full tool belt (bash / files / subagents / workflows) driven from Feishu

## ✨ Features

| Capability | Description |
| ---- | ---- |
| 🎯 **One-click auth** | `/lark setup` scans a QR to create the Feishu app (auto-subscribes message events + group-all + reactions). 30-second onboarding; manual `DSH_LARK_APP_ID/SECRET` channel also supported |
| 🧠 **Multi-mode Agent** | Standard / Code / Minimal / Cordis presets + your custom GUI presets; `/mode` shows a **single-select card** — tap to switch (default Code: multi-step tools in one shot) |
| 🎛 **Permission tiers** | Read-only / workspace-write / **Full access**; `/permission` card switches instantly (Full access by default) |
| 🎨 **Card-based commands** | `/mode` `/permission` `/model` are all **single-select button cards** — tap, no typing; models grouped by provider |
| 💬 **Intent confirmation** | Model questions (`ask_user_question`) land as **Feishu intent-confirmation cards** (option buttons + multi-select dropdown + custom text); answer and the agent resumes |
| 😊 **Reaction receipts** | Random "got it" reaction on inbound; **DONE ✅** on completion (only Feishu-validated emojis) |
| 💪 **Outbound zero-loss** | Persistent Outbox (JSONL + at-least-once + idempotency + per-lane parallel + failure quarantine + periodic prune), resumes after kill/restart; bridge command replies ride the Outbox too |
| 🆕 **Inbound request replay** | If the agent dies / plugin reloads / dsh restarts MID-TURN, the interrupted user message is auto re-triggered on boot (no more silently dropped requests) — durable Inbound WAL + boot reconciliation + attempt/time caps; `/status` shows the pending-replay count |
| 🛡 **Self-healing connection** | Probe-driven controlled reconnect + QuotaGovernor circuit breaker (auto-unblocks and reconnects after the quota window) + missed-message compensation; auto-avoids proxy env |
| 🔀 **3-tier command routing** | Bridge commands → bridge; DSH commands → native; `/goal`, unknown `/xxx`, plain text → injected verbatim (no gates). **Skills need no prefix** — just describe the task |
| 📎 **Inbound media** | Feishu images → **visual model** (attachment-backed); files → bounded text extraction |
| 📤 **Outbound media** | Model sends local files/images via `lark_send_local_file` (workspace whitelist + size/format checks) |
| 🩺 **One-click diagnostics** | `/doctor` → **ZIP bundle** (full DSH session log + sanitized config + ISSUE.md) back to the chat |
| ✍️ **Markdown rendering** | Replies auto-render as CardKit cards (headings/lists/code/tables); plain text stays plain |
| 🌊 **Optional streaming** | `/lark-config streaming.enabled=true` hot-enables CardKit schema 2.0 streaming cards (off by default, saves traffic) |
| 🆕 **Goal-driven long tasks** | `/goal <objective>` launches autonomous long-running task loops directly from Feishu; `/goal pause` / `resume` / `clear` manage execution via clean natural conversation |
| 🆕 **Session management** | `/new` opens a fresh session; `/resume` clean-restores a historical session (button/index/id-prefix, resolves true titles, fixes cross-restart session collision); `/workspace <path>` switches; per-session isolated configuration |
| 🖥 **Reuses DSH Web GUI** | Bridge agents are native DSH sessions; conversations auto-group under their workspace; the web panel shows live Outbox/replay counters |
| 👥 **Access control** | `allowlist` restricts inbound to specific open_ids; `groupPolicy` (open / mention / keywords / reply); `denyList` command-prefix deny |
| 🔓 **Full access by default** | Sandbox full access + never-ask approvals |

## 🚀 Quickstart

Prerequisites: Node.js ≥ 24 and DeepSeek Harness installed (`npm i -g @deepseek-ai/dsh`).

```bash
dsh plugin --profile web add dsh-lark-plus@latest --ignore-scripts
dsh web
/lark setup          # scan QR (30s)
/lark start
```

Open Feishu, find your bot, send anything — reaction receipt + full reply = end-to-end. **Group chats need no @-mention.**

Install variants: local tarball (`npm pack`, then `dsh plugin --profile web add ./dsh-lark-plus-<version>.tgz --ignore-scripts`) or GitHub source (`github:amlyczz/dsh-lark-plus`, requires build approval). Upgrade with `dsh plugin --profile web update dsh-lark-plus --latest --ignore-scripts`.

### Updating after each release

**Don't rely on `@latest`**: it resolves the mirror's `dist-tags.latest` label — npmmirror-style mirrors can serve a **stale tag** (version metadata synced, tag still pointing at an older release), so pnpm sees *Already up to date* even though a newer version exists. The tag is what the mirror says; the version number is what you say.

```bash
# 1. See the real version list, bypassing tags:
npm view dsh-lark-plus versions --registry https://registry.npmjs.org

# 2. Install by explicit version (most reliable):
dsh plugin --profile web add dsh-lark-plus@<new-version> --ignore-scripts

# 3. Or force the official registry with @latest:
dsh plugin --profile web add dsh-lark-plus@latest --ignore-scripts --registry https://registry.npmjs.org
```

Suspicious *Already up to date*? Run `dsh plugin --profile web outdated` first — if it also shows the old version, the mirror tag is stale; use an explicit version. **Restart `dsh web`** after installing.

## ⌨️ Commands (Feishu side)

- **Selectors** (single-select cards): `/mode` `/permission` `/model`
- **Goals**: `/goal [objective|pause|resume|clear]` (autonomous tasks / pause / resume / clear)
- **Status**: `/status` `/sessions` `/help`
- **Sessions**: `/new` `/resume [index|id]` `/stop` `/workspace <path>`
- **Diagnostics**: `/doctor` (ZIP with session log)
- **Hot reload**: `/lark-config key=value`
- **DSH commands** run natively: `/compact` …
- **Media**: send images/files to the bot
- **Intent confirmations** auto-arrive as cards

## ⚙️ Configuration (`/lark-config`, hot-reloaded & persisted)

| Key | Default | Meaning |
| --- | --- | --- |
| `groupPolicy` | `open` | group trigger: open / mention / keywords / reply |
| `agentPreset` | `ptc` | agent preset (standard/ptc/minimal/cordis or custom; legacy alias `code` maps to `ptc`) |
| `permissionMode` | `danger-full-access` | read-only / workspace-write / danger-full-access |
| `streaming.enabled` | `false` | CardKit streaming cards |
| `reactions.enabled` | `true` | reaction receipts |
| `allowlist` | `[]` | open_id allowlist (empty = everyone) |
| `denyList` | `[]` | command-prefix deny |
| `workspaceRoot` | `` | workspace root for bridge sessions |
| `attachments.retentionHours` | `168` | retention (hours) for inbound images/files (default 7 days; `0` = keep forever). Stored under the OS temp dir and swept by age |
| `attachments.dir` | `` | inbound media root override (empty = OS tmpdir; applies after reload) |

Credentials (appId/appSecret) live in the DSH credentials service, never in config files.

## 🩺 Troubleshooting

Send `/doctor` in Feishu — you get a ZIP with the full session log, sanitized config, and an ISSUE.md template. Hand it to any AI (or open a GitHub Issue). `/status` shows live connection / Outbox / replay health.

## 🛠 Development

```bash
npm run dev:link && npm run check && npm test && npm run build
```

264 unit + integration tests. GitHub Actions CI runs typecheck + tests + build on every push/PR; npm publishing rides the release-tagged Publish workflow.

Architecture (Cordis plugin, `dsh.bundle` format):
`host` (SDK adapter/auth) → `inbound` (transport/group policy/compensation/Inbound WAL) → `application` (command routing/orchestration/diagnostics) → `outbound` (Outbox/event forwarding/cards) → `sessions` (per-chat agent management).

## 📄 License

MIT — free to use, modify, and distribute.

This is a community plugin, not affiliated with DeepSeek, Feishu, or Lark.

---

## 归属与许可

- 本项目基于 [`dsh-lark-link`](https://github.com/amlyczz/dsh-lark-link)（MIT License，Copyright (c) 2026 dsh-lark-link contributors）二次开发，**保留了原项目的全部版权与许可声明**（见 `LICENSE`）。
- 新增部分：本地离线语音转写链路（`src/voice/`、消息链路的 `audio` 分支、本机转写路由）以及相应的测试。
- 语音引擎 [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) 与运行时 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 由各自作者以 Apache-2.0 许可发布；模型文件不随本仓库分发，首次使用时从官方发布页下载。
- 本仓库以 MIT License 发布，见 [LICENSE](LICENSE)。
