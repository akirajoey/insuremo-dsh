import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureManagedDir,
  assertRealDirectoryChain,
  assertWithin,
  generationRecordPath,
  generationsDir,
  stagingDir,
  writeFileReplace,
} from "../packages/insuremo-dsh-workbench-bootstrap/src/paths.mjs";
import { dshLockEntryVersion } from "../packages/insuremo-dsh-workbench-bootstrap/src/channel.mjs";
import { acquireLock, readReceipts, validateReceiptSchema, writeReceipt } from "../packages/insuremo-dsh-workbench-bootstrap/src/receipts.mjs";
import { exitCodeForClose } from "../packages/insuremo-dsh-workbench-bootstrap/src/runtime.mjs";
import { doctor, generationIdFromManifest, listCommittedGenerations, recoverPending, rejectUnsafeArgs } from "../packages/insuremo-dsh-workbench-bootstrap/src/service.mjs";

test("dsh lock keys with and without the leading slash are recognized", () => {
  assert.deepEqual(dshLockEntryVersion("@deepseek-ai/dsh-agent@0.1.0-rc.7"), { name: "@deepseek-ai/dsh-agent", version: "0.1.0-rc.7" });
  assert.deepEqual(dshLockEntryVersion("/@deepseek-ai/dsh@0.1.1-rc.2"), { name: "@deepseek-ai/dsh", version: "0.1.1-rc.2" });
  assert.deepEqual(dshLockEntryVersion("/@deepseek-ai/dsh-llm@0.1.1-rc.2_@deepseek-ai+cordis@4.0.1"), { name: "@deepseek-ai/dsh-llm", version: "0.1.1-rc.2" });
  assert.equal(dshLockEntryVersion("@deepseek-ai/cordis@4.0.1"), undefined);
  assert.equal(dshLockEntryVersion("file:payload/icomposer-workbench.tgz"), undefined);
});

test("path guards reject Windows drive and UNC targets", async () => {
  const home = await tempHome("drive-guard");
  try {
    await mkdir(join(home, "managed"), { recursive: true });
    await assert.rejects(() => assertWithin(home, "C:\\Users\\evil"), /foreign drive or UNC/u);
    await assert.rejects(() => assertWithin(home, "\\\\server\\share\\evil"), /foreign drive or UNC/u);
    const root = join(home, "managed");
    const link = join(root, "evil-link");
    await symlink("C:\\evil", link);
    const { assertContainedSymlinks } = await import("../packages/insuremo-dsh-workbench-bootstrap/src/paths.mjs");
    await assert.rejects(() => assertContainedSymlinks(root), /foreign drive or UNC/u);
    await assertWithin(home, join(home, "managed"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function tempHome(prefix) {
  return mkdtemp(join(tmpdir(), `${prefix}-中文-`));
}

function syntheticManifest(overrides = {}) {
  return {
    channel: "stable",
    bootstrapVersion: "1.0.0",
    runtime: {
      dsh: { version: "0.1.0-rc.7" },
      pnpm: { version: "11.7.0" },
      base: { version: "0.1.0-rc.7" },
      webApp: { version: "0.1.0-rc.7" },
      lockSha256: "a".repeat(64),
      dshPackages: { "@deepseek-ai/dsh": "0.1.0-rc.7" },
    },
    workbench: { version: "0.1.0", treeSha256: "b".repeat(64), tgzSha256: "c".repeat(64), payloadFile: "payload/x.tgz" },
    ...overrides,
  };
}

test("receipt schema rejects traversal ids, unknown fields, and bad status", () => {
  const base = { schemaVersion: 1, operationId: "abc12345-0123456789abcdef", operation: "setup", status: "prepared", channel: "stable", bootstrapVersion: "1.0.0", startedAt: new Date().toISOString() };
  validateReceiptSchema(base);
  assert.throws(() => validateReceiptSchema({ ...base, operationId: "../../evil" }), /invalid operationId/u);
  assert.throws(() => validateReceiptSchema({ ...base, operationId: "/etc/passwd" }), /invalid operationId/u);
  assert.throws(() => validateReceiptSchema({ ...base, transactionDir: ".." }), /unknown fields/u);
  assert.throws(() => validateReceiptSchema({ ...base, status: "applying" }), /invalid status/u);
  assert.throws(() => validateReceiptSchema({ ...base, channel: "edge" }), /invalid channel/u);
});

test("readReceipts fails closed when the filename does not match the operationId", async () => {
  const home = await tempHome("receipt-name");
  try {
    const valid = { schemaVersion: 1, operationId: "abc12345-0123456789abcdef", operation: "setup", status: "prepared", channel: "stable", bootstrapVersion: "1.0.0", startedAt: new Date().toISOString() };
    await mkdir(join(home, "insuremo-dsh", "receipts"), { recursive: true });
    await writeFile(join(home, "insuremo-dsh", "receipts", "zzzz0000-0123456789abcdef.json"), JSON.stringify(valid));
    await assert.rejects(() => readReceipts(home), /filename does not match/u);
    await rm(join(home, "insuremo-dsh", "receipts", "zzzz0000-0123456789abcdef.json"));
    await writeFile(join(home, "insuremo-dsh", "receipts", "abc12345-0123456789abcdef.json"), "{ not json");
    await assert.rejects(() => readReceipts(home), /unreadable receipt/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("stale locks are reclaimed; live owners and unreadable locks stay busy", async () => {
  const home = await tempHome("lock");
  try {
    const child = spawnSync(process.execPath, ["-e", ""]);
    assert.equal(child.status, 0);
    const deadPid = child.pid;
    await mkdir(join(home, "insuremo-dsh", "locks"), { recursive: true });
    await writeFile(join(home, "insuremo-dsh", "locks", "icomposer-web.lock"), `${JSON.stringify({ pid: deadPid, token: "dead", startedAt: new Date().toISOString() })}\n`);
    const release = await acquireLock(home);
    const held = JSON.parse(await readFile(join(home, "insuremo-dsh", "locks", "icomposer-web.lock"), "utf8"));
    assert.notEqual(held.token, "dead");
    await assert.rejects(() => acquireLock(home), /another insuremo-dsh profile operation/u);
    await release();
    await writeFile(join(home, "insuremo-dsh", "locks", "icomposer-web.lock"), "not json at all");
    await assert.rejects(() => acquireLock(home), /unreadable/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("managed directory chains reject symlink ancestors", async () => {
  const home = await tempHome("symlink");
  try {
    await mkdir(join(home, "insuremo-dsh", "generations"), { recursive: true });
    await mkdir(join(home, "outside"), { recursive: true });
    await assertRealDirectoryChain(home, join(home, "insuremo-dsh", "generations"));
    await symlink(join(home, "outside"), join(home, "insuremo-dsh", "evil"));
    await assert.rejects(() => assertRealDirectoryChain(home, join(home, "insuremo-dsh", "evil", "deeper")), /not a real directory/u);
    await assert.rejects(() => ensureManagedDir(home, join(home, "insuremo-dsh", "evil", "deeper")), /not a real directory/u);
    await assert.rejects(() => assertRealDirectoryChain(home, join(home, "..", "escape")), /escapes DSH_HOME/u);
    await ensureManagedDir(home, join(home, "insuremo-dsh", "staging", "newdir"));
    await assertRealDirectoryChain(home, join(home, "insuremo-dsh", "staging", "newdir"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("exit codes: signals never map to success", () => {
  assert.equal(exitCodeForClose(0, null), 0);
  assert.equal(exitCodeForClose(7, null), 7);
  assert.equal(exitCodeForClose(null, null), 1);
  assert.equal(exitCodeForClose(null, "SIGTERM"), 143);
  assert.equal(exitCodeForClose(null, "SIGINT"), 130);
  assert.equal(exitCodeForClose(null, "SIGKILL"), 137);
  assert.equal(exitCodeForClose(0, "SIGTERM"), 143);
});

test("CLI arg guard rejects split and = forms of owned options", () => {
  assert.throws(() => rejectUnsafeArgs(["--profile", "x"]), /not accepted/u);
  assert.throws(() => rejectUnsafeArgs(["--profile=other"]), /not accepted/u);
  assert.throws(() => rejectUnsafeArgs(["--channel=beta"]), /not accepted/u);
  assert.throws(() => rejectUnsafeArgs(["--CHANNEL=x"]), /not accepted/u);
  assert.throws(() => rejectUnsafeArgs(["plugin"]), /not accepted/u);
  assert.throws(() => rejectUnsafeArgs(["dump-config"]), /not accepted/u);
  rejectUnsafeArgs([]);
  rejectUnsafeArgs(["-x", "--flag=value"]);
});

test("generation ids are deterministic per artifact and sensitive to every pin", () => {
  const manifest = syntheticManifest();
  const id = generationIdFromManifest(manifest);
  assert.match(id, /^[0-9a-f]{8}$/u);
  assert.equal(id, generationIdFromManifest(syntheticManifest()));
  assert.notEqual(id, generationIdFromManifest(syntheticManifest({ bootstrapVersion: "1.0.1" })));
  assert.notEqual(id, generationIdFromManifest({ ...manifest, workbench: { ...manifest.workbench, treeSha256: "d".repeat(64) } }));
});

test("crash before commit: recovery removes staging, abandons the receipt, and leaves generations untouched", async () => {
  const home = await tempHome("recover");
  try {
    const manifest = syntheticManifest();
    const receipt = { schemaVersion: 1, operationId: "abc12345-0123456789abcdef", operation: "setup", status: "prepared", channel: "stable", bootstrapVersion: "1.0.0", generationId: "deadbeef", startedAt: new Date().toISOString() };
    await writeReceipt(home, receipt);
    const staging = stagingDir(home, receipt.operationId);
    await mkdir(join(staging, "home", "profiles"), { recursive: true });
    await writeFile(join(staging, "marker.txt"), "partial build");
    await mkdir(generationsDir(home), { recursive: true });
    const committedRecord = { schemaVersion: 1, generationId: "00000001", channel: "stable", bootstrapVersion: "0.9.0", dshVersion: "0.1.0-rc.7", pnpmVersion: "11.7.0", workbench: { version: "0.1.0", treeSha256: "b".repeat(64), tgzSha256: "c".repeat(64) }, profileName: "icomposer-web-stable-00000001", profileDigest: "e".repeat(64), dshPackages: {}, runtimeLockSha256: "a".repeat(64), committedAt: new Date().toISOString() };
    await writeFile(generationRecordPath(home, "stable", "00000001"), JSON.stringify(committedRecord));
    await recoverPending(home);
    assert.equal(await readFile(staging).then(() => true, () => false), false);
    const receipts = await readReceipts(home);
    assert.deepEqual(receipts.map(record => record.status), ["abandoned"]);
    assert.equal((await listCommittedGenerations(home, "stable")).length, 1);
    assert.equal(generationIdFromManifest(manifest), generationIdFromManifest(manifest));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("generation records with wrong ids are rejected when listed", async () => {
  const home = await tempHome("gen-record");
  try {
    await mkdir(generationsDir(home), { recursive: true });
    const bad = { schemaVersion: 1, generationId: "ffffffff", channel: "stable", bootstrapVersion: "1.0.0", dshVersion: "0.1.0-rc.7", pnpmVersion: "11.7.0", workbench: { version: "0.1.0", treeSha256: "b".repeat(64), tgzSha256: "c".repeat(64) }, profileName: "icomposer-web-stable-deadbeef", profileDigest: "e".repeat(64), dshPackages: {}, runtimeLockSha256: "a".repeat(64), committedAt: new Date().toISOString() };
    await writeFile(generationRecordPath(home, "stable", "deadbeef"), JSON.stringify(bad));
    await assert.rejects(() => listCommittedGenerations(home, "stable"), /generationId mismatch/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("doctor reports an empty home as unhealthy without touching files", async () => {
  const home = await tempHome("doctor-empty");
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const packageRoot = await mkdtemp(join(tmpdir(), "doctor-pkg-"));
    try {
      await mkdir(join(packageRoot, "payload"), { recursive: true });
      await writeFile(join(packageRoot, "payload", "x.tgz"), "payload-bytes");
      const manifest = syntheticManifest();
      manifest.workbench.tgzSha256 = (await import("node:crypto")).createHash("sha256").update("payload-bytes").digest("hex");
      const result = await doctor(manifest, packageRoot);
      assert.equal(result.ok, false);
      assert.equal(result.set, false);
      assert.equal(result.verified, false);
      assert.equal(result.payloadMatches, true);
      assert.equal(result.pendingReceipts, 0);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
