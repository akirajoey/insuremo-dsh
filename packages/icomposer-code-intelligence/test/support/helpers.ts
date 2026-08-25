import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { IciEngineService } from "../../src/service.ts";

export const validEnv = "portal:microsite";

export function makeBinding(root: string, mode: "bound" | "unbound" | "not-found" = "bound") {
  return {
    get: async (id: string) => {
      if (mode === "not-found") return { ok: false, error: { code: "workspace-not-found" } };
      if (mode === "unbound") return { ok: true, value: { workspaceId: id, canonicalPath: root, binding: null } };
      return { ok: true, value: { workspaceId: id, canonicalPath: root, binding: { authProfile: "portal:demo", environmentId: validEnv } } };
    },
  };
}

export function makeCatalog(entries: Array<{ name: string; type: string; sourcePath?: string }>) {
  return {
    listAssets: async () => ({ ok: true, value: { entries, counts: { api: 0, function: 0, batch: 0, model: 0, total: entries.length }, truncated: false } }),
  };
}

export async function harness(opts: { root?: string; bindingMode?: "bound" | "unbound" | "not-found"; catalogEntries?: Array<{ name: string; type: string; sourcePath?: string }>; dshHome?: string; imoAuth?: unknown }) {
  const ctx = new Context();
  const root = opts.root ?? await mkdtemp(join(tmpdir(), "ici-"));
  const dshHome = opts.dshHome ?? await mkdtemp(join(tmpdir(), "ici-dsh-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  ctx.provide("workspaceBinding", makeBinding(root, opts.bindingMode ?? "bound") as never);
  ctx.provide("icomposerCatalog", makeCatalog(opts.catalogEntries ?? []) as never);
  ctx.provide("imoAuth" as never, opts.imoAuth ?? {
    prepare: async () => ({ ok: false, error: { code: "invalid-auth" } }),
  } as never);
  ctx.provide("imoActiveProfile" as never, {
    get: async () => ({ ok: true, value: { status: "active", activeProfileName: "portal:demo", profile: { profileName: "portal:demo" } } }),
  } as never);
  // Jobs are started by Agent tools, never by the engine itself; tests that
  // exercise job lifecycles drive their own registry.
  ctx.provide("jobs" as never, {
    start: () => { throw new Error("jobs registry not wired in this harness"); },
  } as never);
  const fiber = await ctx.plugin(IciEngineService);
  await fiber.await();
  const engine = ctx.get("iciEngine") as IciEngineService;
  return {
    ctx, engine, fiber, root, dshHome, prev,
    dispose: async () => {
      await fiber.dispose();
      if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
      await rm(dshHome, { recursive: true, force: true });
      if (!opts.root) await rm(root, { recursive: true, force: true });
    },
  };
}

export async function writeGroovy(root: string, kind: string, name: string, body: string) {
  const dir = join(root, "src", "dev", "Tenant", "Group", kind, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.groovy`), body, "utf8");
  return join(dir, `${name}.groovy`);
}

export async function writeMeta(root: string, kind: string, name: string) {
  const dir = join(root, ".metadata", kind);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.metadata.json`), JSON.stringify({ [kind]: { Name: name } }), "utf8");
}

export { assert, mkdtemp, rm, mkdir, writeFile, tmpdir, join, test, Context };
