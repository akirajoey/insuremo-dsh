import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { Storage } from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import {
  OPERATION_DECIDED_EVENT,
  OPERATION_RECORDED_EVENT,
  OPERATION_RESULT_RECORDED_EVENT,
  OperationLogError,
  applyOperationLog,
  type OperationLogService,
} from "../src/index.ts";

interface Fixture {
  directory: string;
  backend: JsonStorageBackend;
  unregisterBackend: () => void;
  service: OperationLogService;
  events: Array<{ name: string; payload: unknown }>;
  cleanupProvider: () => Promise<void>;
}

let fixture: Fixture;

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), "icomposer-operation-log-"));
  const ctx = new Context();
  const storage = new Storage(ctx);
  const backend = new JsonStorageBackend(directory);
  const unregisterBackend = storage.backend.register("json", backend);
  const storageDomain = new DomainFacility(ctx, { backend: "json" });
  const events: Array<{ name: string; payload: unknown }> = [];
  let service: OperationLogService | undefined;
  let cleanup: (() => void | Promise<void>) | undefined;

  await applyOperationLog({
    storageDomain,
    provide(name, value) {
      assert.equal(name, "operationLog");
      service = value;
      return () => { service = undefined; };
    },
    emit(name, payload) {
      events.push({ name, payload });
    },
    effect(setup) {
      cleanup = setup();
      return () => {};
    },
  });

  if (service === undefined || cleanup === undefined) {
    throw new Error("operation-log fixture did not register its provider");
  }
  fixture = {
    directory,
    backend,
    unregisterBackend,
    service,
    events,
    cleanupProvider: async () => { await cleanup?.(); },
  };
});

afterEach(async () => {
  await fixture.cleanupProvider();
  fixture.unregisterBackend();
  await fixture.backend.close();
  await rm(fixture.directory, { recursive: true, force: true });
});

test("append creates a pending digest-only record and emits recorded", async () => {
  const record = await fixture.service.append({
    id: "op-append",
    requestId: "req-append",
    kind: "push",
    paramsDigest: "sha256:params",
    artifactRefs: ["artifact://preview/1"],
  });

  assert.equal(record.id, "op-append");
  assert.equal(record.decision, "pending");
  assert.equal(record.schemaVersion, "0");
  assert.equal(record.paramsDigest, "sha256:params");
  assert.deepEqual(fixture.events[0], {
    name: OPERATION_RECORDED_EVENT,
    payload: { record },
  });
  assert.deepEqual(await readdir(fixture.directory), ["workbench_operation_log.json"]);
});

test("list returns deterministic records and supports filters", async () => {
  await fixture.service.append({
    id: "op-a",
    requestId: "req-a",
    kind: "push",
    paramsDigest: "sha256:a",
    artifactRefs: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await fixture.service.append({
    id: "op-b",
    requestId: "req-b",
    kind: "release",
    paramsDigest: "sha256:b",
    artifactRefs: [],
    createdAt: "2026-01-02T00:00:00.000Z",
  });

  assert.deepEqual(fixture.service.list().map((record) => record.id), ["op-a", "op-b"]);
  assert.deepEqual(fixture.service.list({ kind: "release" }).map((record) => record.id), ["op-b"]);
  assert.deepEqual(fixture.service.list({ decision: "pending" }).map((record) => record.id), ["op-a", "op-b"]);
});

test("decide approves a pending operation and emits decided", async () => {
  await fixture.service.append({
    id: "op-approve",
    requestId: "req-approve",
    kind: "imo-upgrade",
    paramsDigest: "sha256:upgrade",
    artifactRefs: [],
  });

  const record = await fixture.service.decide("op-approve", true, "alice", "approved after review");
  assert.equal(record.decision, "approved");
  assert.equal(record.decidedBy, "alice");
  assert.equal(record.reason, "approved after review");
  assert.equal(fixture.events.at(-1)?.name, OPERATION_DECIDED_EVENT);
  assert.equal(fixture.service.list({ decision: "approved" }).length, 1);
});

test("decide rejects a pending operation and preserves the reason", async () => {
  await fixture.service.append({
    id: "op-reject",
    requestId: "req-reject",
    kind: "cleanup",
    paramsDigest: "sha256:cleanup",
    artifactRefs: [],
  });

  const record = await fixture.service.decide("op-reject", false, "bob", "scope is too broad");
  assert.equal(record.decision, "rejected");
  assert.equal(record.decidedBy, "bob");
  assert.equal(record.reason, "scope is too broad");
  assert.equal(fixture.service.list({ decision: "rejected" })[0]?.id, "op-reject");
});

test("a decided operation cannot be decided again", async () => {
  await fixture.service.append({
    id: "op-once",
    requestId: "req-once",
    kind: "push",
    paramsDigest: "sha256:once",
    artifactRefs: [],
  });
  await fixture.service.decide("op-once", true, "alice");

  await assert.rejects(
    fixture.service.decide("op-once", false, "bob"),
    (error: unknown) => error instanceof OperationLogError && error.code === "already-decided",
  );
});

test("recordResult writes an approved result exactly once and emits result-recorded", async () => {
  await fixture.service.append({
    id: "op-result",
    requestId: "req-result",
    kind: "imo-upgrade",
    paramsDigest: "sha256:upgrade",
    artifactRefs: [],
  });
  await fixture.service.decide("op-result", true, "alice");

  const record = await fixture.service.recordResult("op-result", {
    resultDigest: "sha256:receipt",
    artifactRefs: ["artifact://receipt/1"],
  });
  assert.equal(record.decision, "approved");
  assert.equal(record.resultDigest, "sha256:receipt");
  assert.deepEqual(record.artifactRefs, ["artifact://receipt/1"]);
  assert.equal(fixture.events.at(-1)?.name, OPERATION_RESULT_RECORDED_EVENT);
});

test("recordResult rejects a duplicate write on an approved operation", async () => {
  await fixture.service.append({
    id: "op-result-once",
    requestId: "req-result-once",
    kind: "imo-upgrade",
    paramsDigest: "sha256:upgrade",
    artifactRefs: [],
  });
  await fixture.service.decide("op-result-once", true, "alice");
  await fixture.service.recordResult("op-result-once", {
    resultDigest: "sha256:first",
    artifactRefs: [],
  });

  await assert.rejects(
    fixture.service.recordResult("op-result-once", {
      resultDigest: "sha256:second",
      artifactRefs: [],
    }),
    (error: unknown) => error instanceof OperationLogError && error.code === "already-has-result",
  );
});

test("recordResult rejects pending, rejected, and missing operations", async () => {
  await fixture.service.append({
    id: "op-pending",
    requestId: "req-pending",
    kind: "imo-upgrade",
    paramsDigest: "sha256:p",
    artifactRefs: [],
  });
  await fixture.service.append({
    id: "op-rejected",
    requestId: "req-rejected",
    kind: "imo-upgrade",
    paramsDigest: "sha256:r",
    artifactRefs: [],
  });
  await fixture.service.decide("op-rejected", false, "bob", "denied");

  await assert.rejects(
    fixture.service.recordResult("op-pending", { resultDigest: "sha256:x", artifactRefs: [] }),
    (error: unknown) => error instanceof OperationLogError && error.code === "not-approved",
  );
  await assert.rejects(
    fixture.service.recordResult("op-rejected", { resultDigest: "sha256:x", artifactRefs: [] }),
    (error: unknown) => error instanceof OperationLogError && error.code === "not-approved",
  );
  await assert.rejects(
    fixture.service.recordResult("op-missing", { resultDigest: "sha256:x", artifactRefs: [] }),
    (error: unknown) => error instanceof OperationLogError && error.code === "missing-operation",
  );
});

test("zod validation rejects malformed records before persistence", async () => {
  await assert.rejects(
    fixture.service.append({
      id: "bad",
      requestId: "",
      kind: "not valid kind",
      paramsDigest: "",
      artifactRefs: [""],
    }),
    (error: unknown) => error instanceof Error && error.name === "ZodError",
  );
  assert.equal(fixture.service.list().length, 0);
});
