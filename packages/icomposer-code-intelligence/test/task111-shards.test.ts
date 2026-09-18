import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EXPLAIN_BATCH_INLINE_MAX, EXPLAIN_BATCH_SHARD_MAX } from "@icomposer/workbench-contracts/ici-explain";
import { readBatchRecord, setExplainBatchReadObserver, setExplainWriteFailpoint, updateBatchJobIds, writeBatchRecord } from "../src/explain-artifacts.ts";

const batchDir = (root: string, batchId: string): string => join(root, ".metadata/icomposer/ici/explain/batches", batchId);
const headerPath = (root: string, batchId: string): string => join(root, ".metadata/icomposer/ici/explain/batches", `${batchId}.json`);
async function dirEntries(path: string): Promise<string[]> { try { return (await readdir(path)).sort(); } catch { return []; } }
const ids = (count: number, prefix: string): string[] => Array.from({ length: count }, (_, at) => `${prefix}${String(at).padStart(16 - prefix.length, "0")}`);

async function fixture(): Promise<string> { return mkdtemp(join(tmpdir(), "task111-shards-")); }

async function maxShardBytes(root: string, batchId: string, generation: number): Promise<number> {
  const dir = join(batchDir(root, batchId), `gen-${generation}`);
  let max = 0;
  for (const file of await readdir(dir)) max = Math.max(max, (await stat(join(dir, file))).size);
  return max;
}

function record(batchId: string, jobIds: readonly string[]): any {
  const now = new Date().toISOString();
  return { schemaVersion: 1, kind: "explain-batch", batchId, workspaceId: "ws", jobIds, jobCount: jobIds.length, maxConcurrent: 4, requestedCount: jobIds.length, selector: { kind: "all", label: "all" }, createdAt: now, updatedAt: now };
}

test("TASK-111 P2 a large task is stored as immutable shards and expands to every target", async () => {
  const root = await fixture();
  try {
    const batchId = "1111111111111111";
    const jobIds = ids(1200, "a");
    await writeBatchRecord(root, record(batchId, jobIds));
    const header = JSON.parse(await readFile(headerPath(root, batchId), "utf8"));
    // The header carries no prefix of the list at all: a reader that ignores the shard
    // fields cannot silently see 512 of 1200 targets.
    assert.equal(header.jobIds, undefined);
    assert.deepEqual(header.jobShards, { generation: 1, count: 3, dir: "gen-1" });
    assert.equal(header.jobCount, 1200);
    const expanded = await readBatchRecord(root, batchId);
    assert.deepEqual(expanded?.jobIds, jobIds);
    assert.equal(expanded?.jobCount, 1200);
    // Per-file bound holds while the target total stays unbounded.
    assert.ok(await maxShardBytes(root, batchId, 1) < 32 * 1024, "every shard file stays small");
    const files = await dirEntries(join(batchDir(root, batchId), "gen-1"));
    assert.equal(files.length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("TASK-111 P2 the shard count grows with the task: 5000 targets stay readable", async () => {
  const root = await fixture();
  try {
    const batchId = "2222222222222222";
    const jobIds = ids(5000, "b");
    await writeBatchRecord(root, record(batchId, jobIds));
    const header = JSON.parse(await readFile(headerPath(root, batchId), "utf8"));
    assert.equal(header.jobShards.count, Math.ceil(5000 / EXPLAIN_BATCH_SHARD_MAX));
    assert.equal(header.jobCount, 5000);
    const expanded = await readBatchRecord(root, batchId);
    assert.equal(expanded?.jobIds.length, 5000);
    assert.deepEqual(expanded?.jobIds, jobIds);
    assert.ok(await maxShardBytes(root, batchId, 1) < 32 * 1024);
    // Far below the 2 MiB single-file read bound that used to make a big task unreadable.
    assert.ok((await stat(headerPath(root, batchId))).size < 4 * 1024);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("TASK-111 P2 a missing or damaged shard makes the task unreadable instead of partial", async () => {
  const root = await fixture();
  try {
    const batchId = "3333333333333333";
    const jobIds = ids(1100, "c");
    await writeBatchRecord(root, record(batchId, jobIds));
    assert.equal((await readBatchRecord(root, batchId))?.jobIds.length, 1100);

    const shard = join(batchDir(root, batchId), "gen-1", "shard-1.json");
    const backup = await readFile(shard, "utf8");
    await rm(shard, { force: true });
    assert.equal(await readBatchRecord(root, batchId), null, "a missing shard fails the whole task");

    const shardRecord = JSON.parse(backup);
    const tampered = { ...shardRecord, jobIds: [...shardRecord.jobIds, shardRecord.jobIds[0]] };
    await writeFile(shard, JSON.stringify(tampered));
    assert.equal(await readBatchRecord(root, batchId), null, "a shard with a duplicate id fails the task");

    // Index/count consistency is enforced as well.
    await writeFile(shard, JSON.stringify({ ...shardRecord, index: 7 }));
    assert.equal(await readBatchRecord(root, batchId), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("TASK-111 P2 a crash before the header switch leaves the previous complete generation", async () => {
  const root = await fixture();
  try {
    const batchId = "4444444444444444";
    const first = ids(600, "d");
    await writeBatchRecord(root, record(batchId, first));
    assert.deepEqual((await readBatchRecord(root, batchId))?.jobIds, first);

    const second = ids(1500, "e");
    setExplainWriteFailpoint(path => { if (path.includes("/batches/") && !path.includes("/gen-") && path.endsWith(".json")) throw new Error("header-write-failed"); });
    await assert.rejects(() => writeBatchRecord(root, record(batchId, second)), /header-write-failed/);
    setExplainWriteFailpoint(undefined);
    // Generation 2 exists on disk, but the header still points at generation 1: readers
    // see a complete list, never a mixture of the two.
    assert.equal((await dirEntries(batchDir(root, batchId))).includes("gen-2"), true);
    assert.deepEqual((await readBatchRecord(root, batchId))?.jobIds, first);

    await writeBatchRecord(root, record(batchId, second));
    const header = JSON.parse(await readFile(headerPath(root, batchId), "utf8"));
    // The failed attempt's generation is never reused, so the retry publishes the next one.
    assert.equal(header.jobShards.generation, 3);
    assert.deepEqual((await readBatchRecord(root, batchId))?.jobIds, second);
    // The superseded generation survives one swap: a reader that already resolved the
    // old header still completes instead of being told the record is missing.
    assert.deepEqual(await dirEntries(batchDir(root, batchId)), ["gen-2", "gen-3"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("TASK-111 P2 small and legacy tasks keep the single inline file", async () => {
  const root = await fixture();
  try {
    const batchId = "5555555555555555";
    await writeBatchRecord(root, record(batchId, ids(EXPLAIN_BATCH_INLINE_MAX, "f")));
    const header = JSON.parse(await readFile(headerPath(root, batchId), "utf8"));
    assert.equal(header.jobIds.length, EXPLAIN_BATCH_INLINE_MAX);
    assert.equal(header.jobShards, undefined);
    assert.equal(header.jobCount, EXPLAIN_BATCH_INLINE_MAX);
    assert.deepEqual(await dirEntries(batchDir(root, batchId)), []);

    // A legacy record (no jobCount, inline ids) stays readable by the new code.
    const legacyId = "6666666666666666";
    await writeFile(headerPath(root, legacyId), JSON.stringify({ schemaVersion: 1, kind: "explain-batch", batchId: legacyId, workspaceId: "ws", jobIds: ids(3, "9"), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    const legacy = await readBatchRecord(root, legacyId);
    assert.equal(legacy?.jobIds.length, 3);
    assert.equal(legacy?.jobCount, 3);

    // Shrinking a sharded task back below the inline bound drops its shard directory.
    const shardedId = "7777777777777777";
    await writeBatchRecord(root, record(shardedId, ids(900, "7")));
    assert.deepEqual(await dirEntries(batchDir(root, shardedId)), ["gen-1"]);
    await writeBatchRecordUnderLockShrunk(root, shardedId, ids(4, "8"));
    assert.deepEqual(await dirEntries(batchDir(root, shardedId)), []);
    const shrunk = JSON.parse(await readFile(headerPath(root, shardedId), "utf8"));
    assert.equal(shrunk.jobIds.length, 4);
    assert.equal(shrunk.jobShards, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("TASK-111 P2 a retry replacement keeps the target count and publishes a new generation", async () => {
  const root = await fixture();
  try {
    const batchId = "8888888888888888";
    const jobIds = ids(1200, "a");
    await writeBatchRecord(root, record(batchId, jobIds));
    const replaced = [...jobIds];
    replaced[10] = "deadbeefdeadbeef";
    replaced[900] = "feedfacefeedface";
    await updateBatchJobIds(root, batchId, replaced);
    const expanded = await readBatchRecord(root, batchId);
    assert.equal(expanded?.jobCount, 1200, "retry replacement never changes the target count");
    assert.deepEqual(expanded?.jobIds, replaced);
    const header = JSON.parse(await readFile(headerPath(root, batchId), "utf8"));
    assert.equal(header.jobShards.generation, 2);
    assert.deepEqual(await dirEntries(batchDir(root, batchId)), ["gen-1", "gen-2"], "one generation of grace is retained");
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function writeBatchRecordUnderLockShrunk(root: string, batchId: string, jobIds: readonly string[]): Promise<void> {
  const { writeBatchRecordUnderLock } = await import("../src/explain-artifacts.ts");
  await writeBatchRecordUnderLock(root, record(batchId, jobIds));
}


test("TASK-111 P2 a controlled generation swap during a read is not reported as a missing record", async () => {
  const root = await fixture();
  try {
    const batchId = "9999999999999999";
    const first = ids(1200, "a");
    const second = ids(1200, "b");
    await writeBatchRecord(root, record(batchId, first));
    // The probe interleaves exactly between "header read" and "shards expanded": the
    // writer publishes generation 2 and removes generation 1 while this read is live.
    setExplainBatchReadObserver(async (observed: string) => {
      setExplainBatchReadObserver(undefined);
      assert.equal(observed, batchId);
      await writeBatchRecord(root, record(batchId, second));
      await rm(join(batchDir(root, batchId), "gen-1"), { recursive: true, force: true });
    });
    const expanded = await readBatchRecord(root, batchId);
    assert.ok(expanded !== null, "a normal generation swap is never recordMissing");
    assert.deepEqual(expanded?.jobIds, second, "the reader retries against the fresh header");
    assert.equal(expanded?.jobCount, 1200);

    // A stale generation number is never reused, so a leftover cannot be overwritten
    // while another reader may still reference it.
    const leftover = join(batchDir(root, batchId), "gen-9");
    await mkdir(leftover, { recursive: true });
    await writeFile(join(leftover, "shard-0.json"), "leftover-from-a-failed-swap");
    await updateBatchJobIds(root, batchId, [...first].map((id, at) => at === 0 ? "aaaaaaaaaaaaaaaa" : id));
    const header = JSON.parse(await readFile(headerPath(root, batchId), "utf8"));
    assert.equal(header.jobShards.generation, 10, "the next generation is one past the highest existing one");
    assert.equal(await readFile(join(leftover, "shard-0.json"), "utf8"), "leftover-from-a-failed-swap");
    // The superseded generation survives one swap: an in-flight reader of gen-2 still completes.
    // Generation 2 was superseded twice, so the one-generation grace no longer protects it;
    // the unreferenced leftover (gen-9) is left alone rather than reused or overwritten.
    assert.deepEqual(await dirEntries(batchDir(root, batchId)), ["gen-10", "gen-9"]);
    assert.equal((await readBatchRecord(root, batchId))?.jobIds.length, 1200);
  } finally { setExplainBatchReadObserver(undefined); await rm(root, { recursive: true, force: true }); }
});
