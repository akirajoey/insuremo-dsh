import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { Storage } from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { SKILL_ACTIVATION_CHANGED_EVENT } from "../src/index.ts";
import {
  ImoSkillActivationService,
  SkillActivationError,
  SKILL_ACTIVATION_DOMAIN_NAME,
  type ImoSkillActivation,
  type SkillActivationController,
} from "../src/skill-activation.ts";

const DISPOSED_MESSAGE = "IMO skill activation service is disposed";

async function activeFixture() {
  const storageRoot = await mkdtemp(join(tmpdir(), "imo-activation-lifecycle-"));
  const ctx = new Context();
  const storageFiber = ctx.plugin(Storage);
  await storageFiber.await();
  const backend = new JsonStorageBackend(storageRoot);
  const unregisterBackend = ctx.storage.backend.register("json", backend);
  const facility = new DomainFacility(ctx, { backend: "json" });
  ctx.provide("storageDomain", facility);
  let controller: SkillActivationController | undefined;
  const activationFiber = ctx.plugin(ImoSkillActivationService, {
    onController: (value: SkillActivationController) => { controller = value; },
  });
  await activationFiber.await();
  const face = ctx.get<ImoSkillActivation>("imoSkillActivation");
  if (face === undefined || controller === undefined) throw new Error("lifecycle fixture unavailable");
  return {
    ctx, face, controller, activationFiber, facility, storageRoot, backend, unregisterBackend, storageFiber,
    async dispose() {
      await activationFiber.dispose();
      unregisterBackend();
      await storageFiber.dispose();
      await backend.close();
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}

function isDisposed(error: unknown): boolean {
  return error instanceof SkillActivationError
    && error.code === "service-disposed"
    && error.message === DISPOSED_MESSAGE;
}

async function assertDisposed(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, isDisposed);
}

function openDomain(facility: DomainFacility): { close(): Promise<void>; table(name: string): unknown } | undefined {
  return (facility as unknown as {
    get(name: string): { close(): Promise<void>; table(name: string): unknown } | undefined;
  }).get(SKILL_ACTIVATION_DOMAIN_NAME);
}

test("disposed owner revokes captured face and controller before disposal resolves", async () => {
  const fx = await activeFixture();
  const events: unknown[] = [];
  const remove = fx.ctx.on(SKILL_ACTIVATION_CHANGED_EVENT, payload => events.push(payload));
  try {
    await fx.face.ensureInitialized(["alpha"]);
    const path = join(fx.storageRoot, `${SKILL_ACTIVATION_DOMAIN_NAME}.json`);
    const before = await readFile(path, "utf8");
    await fx.activationFiber.dispose();
    await Promise.all([
      assertDisposed(fx.face.ensureInitialized(["alpha"])),
      assertDisposed(fx.face.snapshot(["alpha"])),
      assertDisposed(fx.controller.setEnabled("alpha", false, ["alpha"], 0)),
      assertDisposed(fx.controller.reconcile(["alpha"], 0)),
    ]);
    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual(events, []);
    assert.equal(fx.ctx.get("imoSkillActivation"), undefined);
    assert.equal(openDomain(fx.facility), undefined);
  } finally {
    remove();
    await fx.dispose();
  }
});

test("dispose blocks an admitted queued mutation but drains the mutation already writing", async () => {
  const fx = await activeFixture();
  try {
    await fx.face.ensureInitialized(["alpha"]);
    const domain = openDomain(fx.facility);
    if (domain === undefined) throw new Error("activation domain unavailable");
    const table = domain.table("states") as { put(key: string, value: unknown): Promise<void> };
    const originalPut = table.put.bind(table);
    let writes = 0;
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    let writeStarted!: () => void;
    const started = new Promise<void>(resolve => { writeStarted = resolve; });
    table.put = async (key, value) => {
      writes += 1;
      if (writes === 1) {
        writeStarted();
        await writeGate;
      }
      return originalPut(key, value);
    };
    const state = await fx.face.snapshot(["alpha"]);
    const first = fx.controller.setEnabled("alpha", false, ["alpha"], state.revision);
    await started;
    const queued = fx.controller.setEnabled("alpha", true, ["alpha"], state.revision);
    const disposing = fx.activationFiber.dispose();
    releaseWrite();
    await assert.doesNotReject(first);
    await assertDisposed(queued);
    await disposing;
    assert.equal(writes, 1);
    assert.equal(openDomain(fx.facility), undefined);
  } finally {
    await fx.dispose();
  }
});

test("dispose during domain open closes the late domain and never publishes its controller", async () => {
  const ctx = new Context();
  let resolveOpen!: (domain: unknown) => void;
  const opening = new Promise<unknown>(resolve => { resolveOpen = resolve; });
  let closeCount = 0;
  const lateDomain = { close: async () => { closeCount += 1; }, table: () => undefined };
  const unregister = ctx.provide("storageDomain", { open: async () => opening } as never);
  let controller: SkillActivationController | undefined;
  const fiber = ctx.plugin(ImoSkillActivationService, {
    onController: (value: SkillActivationController) => { controller = value; },
  });
  await Promise.resolve();
  const face = (ctx.get as unknown as (name: string, strict?: boolean) => ImoSkillActivation | undefined)("imoSkillActivation", false);
  if (face === undefined) throw new Error("late-open face unavailable");
  const startup = fiber.await().then(() => undefined, error => error);
  const disposing = fiber.dispose();
  resolveOpen(lateDomain);
  await disposing;
  await startup;
  assert.equal(closeCount, 1);
  assert.equal(controller, undefined);
  await assertDisposed(face.snapshot(["alpha"]));
  unregister();
});

test("repeated owner disposal closes its domain once and late calls stay handled", async () => {
  const fx = await activeFixture();
  try {
    await fx.face.ensureInitialized(["alpha"]);
    const domain = openDomain(fx.facility);
    if (domain === undefined) throw new Error("activation domain unavailable");
    const originalClose = domain.close.bind(domain);
    let closes = 0;
    domain.close = async () => { closes += 1; await originalClose(); };
    const first = fx.activationFiber.dispose();
    const second = fx.activationFiber.dispose();
    await Promise.all([first, second]);
    assert.equal(closes, 1);
    await assertDisposed(fx.face.snapshot(["alpha"]));
    await assertDisposed(fx.controller.reconcile(["alpha"]));
  } finally {
    await fx.dispose();
  }
});
