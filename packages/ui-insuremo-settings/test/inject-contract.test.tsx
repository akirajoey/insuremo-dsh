/**
 * TASK-088 client inject-contract regression.
 *
 * The production crash class: `InsuremoCardWithRuntime` reads `ctx.sessions`
 * and `ctx.workspaces` off the client context at RENDER time (slot owner props
 * supply no runtime). cordis guards every ctx property read against the
 * plugin's declared `inject` list — an undeclared service access throws
 * `cannot get property "workspaces" without inject`, which crashes the
 * settings card entry after dispatch (`slot entry crashed in
 * 'settings.plugin.item'`). SlotTestRuntime's ctx does not enforce that guard
 * (a live harness does), so these tests pin the CONTRACT statically: the
 * declared inject must cover every ctx service the wiring dereferences, and
 * the aggregate bundle's derived union must swallow each sub-plugin's own
 * declaration so a new service requirement cannot drift again.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// vitest runs with cwd = the package root (see the theme test's process.cwd()).
const packageRoot = process.cwd();

function readSource(relative: string): string {
  return readFileSync(join(packageRoot, "src", relative), "utf8");
}

/** Every `ctx.<service>` dereference in a source string (service tokens). */
function ctxServiceReads(source: string): string[] {
  const matches = [...source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)\b/g)].map(match => match[1]);
  // `ctx.effect` is a context method, not a service read.
  return [...new Set(matches)].filter(name => name !== "effect");
}

describe("client inject contract (TASK-088)", () => {
  it("settings sub-plugin inject covers every ctx service its wiring dereferences", async () => {
    const index = await import("../src/client/index.ts");
    const declared = new Set<string>(index.inject as readonly string[]);
    const sources = [
      readSource("client/index.ts"),
      readSource("client/InsuremoCard.tsx"),
      readSource("client/diagnosis.ts"),
      readSource("client/prefill-slot.tsx"),
    ].join("\n");
    for (const service of ctxServiceReads(sources)) {
      expect(declared.has(service), `ctx.${service} is dereferenced but not declared in settings inject`).toBe(true);
    }
    // Spot-pin the two render-time faces that previously crashed prod.
    expect(declared.has("sessions")).toBe(true);
    expect(declared.has("workspaces")).toBe(true);
    expect(declared.has("slots")).toBe(true);
    expect(declared.has("locale")).toBe(true);
  });

  it("aggregate client inject is the union of the sub-plugin injects (no drift)", async () => {
    const aggregate = await import("../../icomposer-workbench-dist/src/client/index.ts");
    const settings = await import("../src/client/index.ts");
    const status = await import("../../ui-insuremo-status/src/client/index.ts");
    const jobs = await import("../../ui-workbench-jobs/src/client/index.ts");
    const expected = [...new Set([
      ...(settings.inject as readonly string[]),
      ...(status.inject as readonly string[]),
      ...(jobs.inject as readonly string[]),
    ])].sort();
    expect([...(aggregate.inject as readonly string[])].sort()).toEqual(expected);
    for (const required of ["sessions", "workspaces", "slots", "locale"]) {
      expect(aggregate.inject).toContain(required);
    }
  });

  it("settings bundle built payload declares sessions and workspaces", () => {
    // Guard the shipped artifact: the baked settings sub-union inside the
    // aggregate client bundle must carry the render-time faces the card
    // wrapper reads (sessions + workspaces) — the exact production crash
    // bytes. Requires `pnpm pack:dist` to have produced dist-release.
    const root = resolve(packageRoot, "../..");
    const tgz = join(root, "dist-release/icomposer-workbench-0.1.0.tgz");
    expect(existsSync(tgz), "dist-release tgz missing; run pnpm pack:dist first").toBe(true);
    const stage = mkdtempSync(join(tmpdir(), "dsh088-inject-artifact-"));
    try {
      execFileSync("tar", ["-xzf", tgz, "-C", stage, "--strip-components=1"]);
      const client = readFileSync(join(stage, "lib/client.js"), "utf8");
      // The settings sub-union precedes the settings.plugin.item registration
      // and the InsuremoCardWithRuntime wrapper in the bundle.
      const beforeCard = client.slice(0, client.indexOf("settings.plugin.item"));
      expect(beforeCard.includes('"workspaces"')).toBe(true);
      expect(beforeCard.includes('"sessions"')).toBe(true);
      expect(beforeCard.includes('"slots"')).toBe(true);
      expect(beforeCard.includes('"locale"')).toBe(true);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
});
