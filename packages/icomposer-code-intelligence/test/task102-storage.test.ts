import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { Storage } from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { ExplainConfigService } from "../src/explain-config.ts";

const UNIT_FILE = "ici_explain_config.json";

interface Mounted {
  readonly ctx: any;
  readonly config: ExplainConfigService;
  readonly storageRoot: string;
  readonly backend: JsonStorageBackend;
  dispose(): Promise<void>;
}

/** Real Storage hub + JsonStorageBackend + DomainFacility over a private temp root. */
async function mount(storageRoot: string): Promise<Mounted> {
  const ctx: any = new Context();
  const storageFiber = ctx.plugin(Storage as never);
  await storageFiber.await();
  const backend = new JsonStorageBackend(join(storageRoot, "storage"));
  ctx.storage.backend.register("json", backend);
  ctx.provide("storageDomain", new DomainFacility(ctx as never, { backend: "json" }));
  const configFiber = ctx.plugin(ExplainConfigService as never);
  await configFiber.await();
  const config = ctx.get("iciExplainConfig") as ExplainConfigService;
  return {
    ctx, config, storageRoot, backend,
    dispose: async () => {
      await ctx.fiber.dispose().catch(() => undefined);
      await backend.close().catch(() => undefined);
    },
  };
}

function unitPath(mounted: Mounted): string {
  return join(mounted.storageRoot, "storage", UNIT_FILE);
}

test("TASK-102 storage: default cap is served without materializing the medium, and a saved value survives dispose/reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "task102-storage-roundtrip-"));
  try {
    const first = await mount(root);
    try {
      assert.equal(first.config.maxConcurrent, 4, "initial value comes from the domain spec");
      await assert.rejects(readFile(unitPath(first), "utf8"), /ENOENT/, "GET must not create the unit file");
      assert.deepEqual(await first.config.setMaxConcurrent(8), { ok: true, value: { maxConcurrent: 8 } });
      const persisted = JSON.parse(await readFile(unitPath(first), "utf8")) as { global: { maxConcurrent: number } };
      assert.equal(persisted.global.maxConcurrent, 8, "explicit save is durably published");
    } finally {
      await first.dispose();
    }
    const second = await mount(root);
    try {
      assert.equal(second.config.maxConcurrent, 8, "a fresh service over the same medium reads the saved value");
    } finally {
      await second.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TASK-102 storage: a corrupt or schema-invalid medium fails loud instead of silently resetting the cap", async () => {
  const cases: Array<{ readonly label: string; readonly content: string }> = [
    { label: "invalid JSON", content: "{ not json\n" },
    { label: "schema-invalid global", content: `${JSON.stringify({ unit: { name: "ici_explain_config", version: 1 }, global: { maxConcurrent: 99 }, tables: {} }, null, 2)}\n` },
  ];
  for (const item of cases) {
    const root = await mkdtemp(join(tmpdir(), "task102-storage-corrupt-"));
    try {
      const storageRoot = join(root, "storage");
      await (await import("node:fs/promises")).mkdir(storageRoot, { recursive: true });
      await writeFile(join(storageRoot, UNIT_FILE), item.content);
      const ctx: any = new Context();
      const storageFiber = ctx.plugin(Storage as never);
      await storageFiber.await();
      const backend = new JsonStorageBackend(storageRoot);
      ctx.storage.backend.register("json", backend);
      ctx.provide("storageDomain", new DomainFacility(ctx as never, { backend: "json" }));
      try {
        await assert.rejects(ctx.plugin(ExplainConfigService as never).await(), undefined, `${item.label} must fail service init`);
        assert.equal(ctx.get("iciExplainConfig"), undefined, "no service is published over a bad medium");
      } finally {
        await ctx.fiber.dispose().catch(() => undefined);
        await backend.close().catch(() => undefined);
        // The corrupt document stays untouched: a fail-loud open never rewrites it.
        assert.equal((await readFile(join(storageRoot, UNIT_FILE), "utf8")), item.content);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("TASK-102 storage: a real backend write failure answers storage-error and keeps the effective cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "task102-storage-writefail-"));
  try {
    const mounted = await mount(root);
    const storageDir = join(root, "storage");
    try {
      assert.deepEqual(await mounted.config.setMaxConcurrent(6), { ok: true, value: { maxConcurrent: 6 } });
      assert.equal(mounted.config.maxConcurrent, 6);
      // Real medium failure: the directory stops accepting the atomic temp file.
      await chmod(storageDir, 0o500);
      const failed = await mounted.config.setMaxConcurrent(9);
      assert.deepEqual(failed, { ok: false, code: "storage-error" }, "the backend rejection maps to storage-error");
      assert.equal(mounted.config.maxConcurrent, 6, "the previously effective cap stays in force");
      const persisted = JSON.parse(await readFile(unitPath(mounted), "utf8")) as { global: { maxConcurrent: number } };
      assert.equal(persisted.global.maxConcurrent, 6, "the medium still holds the last successful value");
    } finally {
      await chmod(storageDir, 0o700).catch(() => undefined);
      await mounted.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TASK-102 storage: dispose drains an in-flight write before closing the unit", async () => {
  const root = await mkdtemp(join(tmpdir(), "task102-storage-drain-"));
  try {
    const first = await mount(root);
    const pending = first.config.setMaxConcurrent(7);
    const disposal = first.config.dispose();
    const [write] = await Promise.all([pending, disposal]);
    assert.deepEqual(write, { ok: true, value: { maxConcurrent: 7 } }, "the in-flight write settles before close");
    await first.dispose();
    const second = await mount(root);
    try {
      assert.equal(second.config.maxConcurrent, 7, "the drained write is visible on reopen");
    } finally {
      await second.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
