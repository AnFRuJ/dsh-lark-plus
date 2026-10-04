import { test } from "node:test";
import assert from "node:assert/strict";
// Platform-aware expectations: these cases use POSIX-looking inputs, but on
// Windows `path.resolve` turns "/data/proj" into "C:\\data\\proj". Asserting the
// literal POSIX string made the suite fail on Windows for no real reason.
import { join, resolve } from "node:path";
import {
	resolveWorkspaceTarget,
	resolveInWorkspacePath,
} from "../../../src/common/paths.ts";

// ---- resolveWorkspaceTarget (/workspace 命令) ------------------------------
// GH #7: `startsWith("/")` 判绝对路径 —— Windows 盘符路径全部被误判为相对路径。

test("paths: absolute arg stays absolute", () => {
	const t = resolveWorkspaceTarget("/data/proj", "/cur/ws");
	assert.equal(t, resolve("/data/proj"));
	assert.ok(!t.includes("cur"), "must not be joined under the current workspace");
});

test("paths: relative arg joins the current workspace", () => {
	const t = resolveWorkspaceTarget("sub/dir", "/cur/ws");
	assert.ok(t.endsWith(join("sub", "dir")), `relative arg must join, got ${t}`);
	assert.ok(t.includes("cur"), `keeps the workspace root, got ${t}`);
});

test("paths: ~ expands to homedir", () => {
	const t = resolveWorkspaceTarget("~/proj", "/cur/ws");
	assert.ok(!t.includes("~"));
	assert.ok(t.endsWith("proj"));
});

test("paths: windows drive-letter absolute is ABSOLUTE (GH #7)", () => {
	// win32 格式的 D:\... 在任何平台上都不得被 join 到当前工作区后面。
	const t = resolveWorkspaceTarget("D:\\Users\\kitti\\ws", "/cur/ws");
	assert.ok(
		t === "D:\\Users\\kitti\\ws" || t.includes("D:"),
		`drive-letter path must stay absolute, got ${t}`,
	);
	assert.ok(!t.startsWith("/cur/ws"), "must not be joined under the cwd");
});

test("paths: windows forward-slash drive path is absolute (D:/...)", () => {
	const t = resolveWorkspaceTarget("D:/Users/kitti/ws", "/cur/ws");
	assert.ok(!t.startsWith("/cur/ws"), "must not be joined under the cwd");
});

test("paths: UNC path is absolute", () => {
	const t = resolveWorkspaceTarget("\\\\server\\share\\ws", "/cur/ws");
	assert.ok(!t.startsWith("/cur/ws"), "UNC must not be joined under the cwd");
});

// ---- resolveInWorkspacePath (lark_send_local_file 工具) --------------------

test("paths: absolute input inside root resolves and passes containment", () => {
	const { abs, ok } = resolveInWorkspacePath("/ws/a/b.txt", "/ws/a");
	assert.equal(abs, resolve("/ws/a/b.txt"));
	assert.equal(ok, true);
});

test("paths: relative input resolves against the root", () => {
	const { abs, ok } = resolveInWorkspacePath("b.txt", "/ws/a");
	assert.equal(abs, resolve("/ws/a", "b.txt"));
	assert.equal(ok, true);
});

test("paths: traversal outside the root is rejected", () => {
	const { ok } = resolveInWorkspacePath("../../etc/passwd", "/ws/a");
	assert.equal(ok, false);
});

test("paths: absolute input OUTSIDE the root is rejected", () => {
	const { ok } = resolveInWorkspacePath("/etc/passwd", "/ws/a");
	assert.equal(ok, false);
});

test("paths: windows drive absolute inside root passes containment (GH #7)", () => {
	const { abs, ok } = resolveInWorkspacePath("D:\\ws\\a\\b.txt", "D:\\ws\\a");
	assert.equal(ok, true);
	assert.ok(String(abs).includes("b.txt"));
});

test("paths: windows drive absolute outside root is rejected (GH #7)", () => {
	const { ok } = resolveInWorkspacePath("E:\\other\\b.txt", "D:\\ws\\a");
	assert.equal(ok, false);
});

test("paths: same-directory root edge (file IS in root dir)", () => {
	const { ok } = resolveInWorkspacePath("D:\\ws\\a", "D:\\ws\\a");
	assert.equal(ok, true);
});
