// Read-only playback route for the Web GUI: /plugins/lark-plus/audio?name=…
//
// The client half renders an <audio controls> under every voice message and
// points it here, so a clip can be replayed in the GUI without going back to
// Feishu. Bytes come from the SAME file the bridge already persisted under
// <inboundDir>/media — nothing is copied or re-downloaded.
//
// Only leaf names with a whitelisted audio extension are served, and only from
// inside the media directory, so the route can never become a general file
// reader.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/** Extension → Content-Type. Persisted Feishu clips are .ogg (or .bin). */
export const VOICE_AUDIO_TYPES: Readonly<Record<string, string>> = {
	".ogg": "audio/ogg",
	".oga": "audio/ogg",
	".opus": "audio/ogg",
	".bin": "audio/ogg",
	".wav": "audio/wav",
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".flac": "audio/flac",
};

/** The request/response slice the route needs (kept structural: the web
 *  server's own types are not part of this package's contract). */
export interface VoiceAudioRequest {
	method?: string;
	url?: string;
	headers?: Record<string, string | string[] | undefined>;
}
export interface VoiceAudioResponse {
	writeHead(status: number, headers: Record<string, string>): unknown;
	end(body?: unknown): unknown;
}

/**
 * Resolve one requested clip inside mediaDir, or undefined when the name is not
 * a bare, whitelisted audio file name that exists there.
 */
export function voiceAudioFile(name: string, mediaDir: string): string | undefined {
	if (name === "" || name === "." || name === "..") return undefined;
	if (name.includes("/") || name.includes("\\") || name.includes("\0")) return undefined;
	if (basename(name) !== name) return undefined;
	const dot = name.lastIndexOf(".");
	if (dot < 0) return undefined;
	if (VOICE_AUDIO_TYPES[name.slice(dot).toLowerCase()] === undefined) return undefined;
	const file = join(mediaDir, name);
	try {
		return existsSync(file) && statSync(file).isFile() ? file : undefined;
	} catch {
		return undefined;
	}
}

/** GET/HEAD one clip, with Range support so the player can seek. */
export function voiceAudioRoute(
	req: VoiceAudioRequest,
	res: VoiceAudioResponse,
	mediaDir: string,
): void {
	const deny = (code: number, message: string): void => {
		try {
			res.writeHead(code, {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "no-store",
			});
			res.end(message);
		} catch {
			// client already gone
		}
	};
	const method = req.method ?? "GET";
	if (method !== "GET" && method !== "HEAD") return deny(405, "GET only");
	let name = "";
	try {
		name = new URL(req.url ?? "/", "http://dsh.internal").searchParams.get("name") ?? "";
	} catch {
		return deny(400, "bad url");
	}
	const file = voiceAudioFile(name, mediaDir);
	if (file === undefined) return deny(404, "voice audio not found");
	let size = 0;
	try {
		size = statSync(file).size;
	} catch {
		return deny(404, "voice audio unreadable");
	}
	const type = VOICE_AUDIO_TYPES[file.slice(file.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";
	let start = 0;
	let end = size - 1;
	let code = 200;
	const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers?.range ?? "").trim());
	if (range !== null) {
		const rawStart = range[1] ?? "";
		const rawEnd = range[2] ?? "";
		if (rawStart === "" && rawEnd === "") return deny(416, "bad range");
		if (rawStart === "") {
			const tail = Number(rawEnd);
			if (!Number.isFinite(tail) || tail <= 0) return deny(416, "bad range");
			start = Math.max(0, size - tail);
		} else {
			start = Number(rawStart);
			if (rawEnd !== "") end = Math.min(size - 1, Number(rawEnd));
		}
		if (!Number.isFinite(start) || start < 0 || start >= size || end < start) return deny(416, "bad range");
		code = 206;
	}
	let body: Buffer;
	try {
		body = readFileSync(file).subarray(start, end + 1);
	} catch {
		return deny(404, "voice audio unreadable");
	}
	const headers: Record<string, string> = {
		"Content-Type": type,
		"Content-Length": String(body.byteLength),
		"Accept-Ranges": "bytes",
		"Cache-Control": "no-store",
	};
	if (code === 206) headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
	try {
		res.writeHead(code, headers);
		res.end(method === "HEAD" ? undefined : body);
	} catch {
		// client already gone
	}
}
