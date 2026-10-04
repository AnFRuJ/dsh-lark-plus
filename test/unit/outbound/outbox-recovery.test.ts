// The outbox must never wedge itself.
//
// This shipped without that protection once, and the symptom was the worst
// kind: DSH received and answered messages, but nothing ever reached Feishu
// again — envelopes sat at "pending / attempts: 0" while inbound and the HTTP
// status route kept working fine. So: a throwing sender, a sender that never
// resolves, and a mid-flight crash must all leave later replies deliverable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutbox, type Outbox, type OutboxSender } from "../../../src/outbound/outbox.ts";

const CFG = {
  maxAttempts: 4,
  backoffMaxMs: 60,
  retainDays: 1,
  pendingCap: 100,
  blobThreshold: 1_000_000,
};

function enqueue(outbox: Outbox, key: string): void {
  outbox.enqueue({
    dedupeKey: key,
    laneKey: "dm:oc_x",
    route: { chatId: "oc_x", chatType: "p2p" } as never,
    kind: "final",
    payload: { kind: "text", text: key } as never,
  });
}

async function waitFor(predicate: () => boolean, ms = 4000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

test("a sender that THROWS does not stop later replies from being delivered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lark-plus-outbox-"));
  const sent: string[] = [];
  let explode = true;
  const outbox = createOutbox({
    dir,
    cfg: CFG,
    deliverTimeoutMs: 500,
    watchdogIntervalMs: 50,
    sender: {
      async deliver(_env, payload) {
        if (explode) throw new Error("boom");
        sent.push(String((payload as { text?: string }).text ?? ""));
        return { ok: true };
      },
    } as OutboxSender,
  });
  outbox.start();
  enqueue(outbox, "m1"); // dies on every attempt until every attempt is spent
  await waitFor(() => outbox.pendingCount() > 0);
  explode = false;
  enqueue(outbox, "m2");
  assert.equal(
    await waitFor(() => sent.includes("m2")),
    true,
    "the drain loop survives a throwing sender",
  );
  await outbox.stop();
});

test("a sender that NEVER resolves is timed out and retried (lane not wedged)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lark-plus-outbox-"));
  const sent: string[] = [];
  let hang = true;
  const outbox = createOutbox({
    dir,
    cfg: CFG,
    deliverTimeoutMs: 60,
    watchdogIntervalMs: 30,
    sender: {
      async deliver(_env, payload) {
        if (hang) return new Promise<never>(() => {}); // never settles
        sent.push(String((payload as { text?: string }).text ?? ""));
        return { ok: true };
      },
    } as OutboxSender,
  });
  outbox.start();
  enqueue(outbox, "h1");
  assert.equal(await waitFor(() => outbox.failedCount() > 0, 3000), true, "hung delivery must fail, not sit forever");
  hang = false;
  assert.equal(await waitFor(() => sent.includes("h1", ), 3000), true, "retry sweep delivers it afterwards");
  await outbox.stop();
});

test("crash mid-flight: a 'sending' envelope is re-queued and delivered on the next boot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lark-plus-outbox-"));
  // First process: the delivery hangs, then the process "dies" (stop() only
  // settles the active promise, the envelope stays recorded as 'sending').
  const dying = createOutbox({
    dir,
    cfg: CFG,
    deliverTimeoutMs: 60_000,
    sender: { async deliver() { return new Promise<never>(() => {}); } } as OutboxSender,
  });
  dying.start();
  enqueue(dying, "crash1");
  await waitFor(() => dying.pendingCount() > 0, 500);
  const sent: string[] = [];
  const revived = createOutbox({
    dir,
    cfg: CFG,
    deliverTimeoutMs: 500,
    watchdogIntervalMs: 50,
    sender: {
      async deliver(_env, payload) {
        sent.push(String((payload as { text?: string }).text ?? ""));
        return { ok: true };
      },
    } as OutboxSender,
  });
  // The host always reloads from disk before starting (index.ts / lifecycle.ts).
  revived.rebuildFromDisk();
  revived.start();
  assert.equal(await waitFor(() => sent.includes("crash1"), 4000), true, "crash recovery re-queues and sends");
  await revived.stop();
});
