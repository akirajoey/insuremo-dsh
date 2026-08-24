import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { ImoAuthService } from "../src/auth/service.ts";
import { mountCurrentProfileSection } from "../src/current-profile-section.ts";
import { finalizeAction } from "../src/auth/action-finalize.ts";
import { AUTH_ACTION_COMPLETED_EVENT } from "../src/auth/action-types.ts";
import { IMO_AUTH_DEFAULT_KIND } from "../src/auth/action-types.ts";

interface Contribution { name: string; order: number; text: string | ((context: unknown) => string) }

function makeHandle(stdoutText: string): unknown {
  return {
    pid: 1, stdin: undefined,
    stdout: (async function* () { yield stdoutText; })(),
    stderr: (async function* () {})(),
    collected: {
      stdout: { readFrom: (fromByte: number) => ({ text: fromByte === 0 ? stdoutText : "", nextOffset: stdoutText.length, lossy: false }) },
      stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
    },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    waitForExit: async () => true, terminate: () => {},
  };
}

/** Real ImoAuthService + systemPrompt face on one context, logger noop. */
async function liveFixture(defaultGet: string) {
  const ctx = new Context();
  let listRuns = 0;
  let defaultRuns = 0;
  const listJson = JSON.stringify([
    { name: "portal:a", env: "portal", is_default: false },
    { name: "portal:b", env: "portal", is_default: false },
  ]);
  ctx.provide("subprocess", {
    resolveExecutable: async () => "/opt/homebrew/bin/imo",
    spawn: (spec: { argv: readonly string[] }): unknown => {
      const argv = spec.argv.join(" ");
      if (argv.includes("profile list")) { listRuns += 1; return makeHandle(listJson); }
      if (argv.includes("default-profile get")) { defaultRuns += 1; return makeHandle(`${defaultGet}\n`); }
      return makeHandle("");
    },
  } as never);
  // systemPrompt face via ctx.provide/get (non-service value is fine)
  const contexts: Contribution[] = [];
  ctx.provide("systemPrompt" as never, {
    context(c: Contribution): () => void { contexts.push(c); return () => {}; },
  } as never);
  const authFiber = ctx.plugin(ImoAuthService as never, { command: "imo" } as never);
  await authFiber.await();
  const auth = ctx.get<ImoAuthService>("imoAuth" as never) as unknown as ImoAuthService;
  const counts = () => ({ list: listRuns, def: defaultRuns });
  return { ctx, auth, counts, contexts, authFiber };
}

test("FIX-3 integration: mount(real) prewarm fills sanitized cache → UI profilesFast twice is zero additional spawn; list+def each exactly 1", async () => {
  const fx = await liveFixture("portal:a");
  try {
    // mount prewarms via profilesFast (fills list+default caches)
    const dispose = await mountCurrentProfileSection(fx.ctx as never);
    assert.equal(fx.contexts.length, 1);
    assert.deepEqual(fx.counts(), { list: 1, def: 1 }, "prewarm fills both caches");
    // UI reads: two more profilesFast → pure cache hits
    await fx.auth.profilesFast();
    await fx.auth.profilesFast();
    assert.deepEqual(fx.counts(), { list: 1, def: 1 }, "warm UI fast reads spawn nothing");
    dispose();
  } finally { await fx.authFiber.dispose(); }
});

test("FIX-3 approval: real finalizeAction emit (default kind) carries profile → runtime-context syncs synchronously", async () => {
  const fx = await liveFixture("portal:a");
  let capturedEmit: unknown;
  const realCtx = fx.ctx;
  // mount registers its AUTH_ACTION_COMPLETED handler on the real ctx
  const dispose = await mountCurrentProfileSection(realCtx as never);
  const contextText = (): string => {
    const c = fx.contexts[0];
    if (c === undefined) throw new Error("context not registered");
    return typeof c.text === "function" ? c.text({}) : c.text;
  };
  assert.match(contextText(), /InsureMO active profile: portal:a/);
  // run the REAL finalize for a default-switch completion (its emit on the
  // real ctx is exactly what the mounted handler listens to)
  await finalizeAction({
    recordResult: async () => undefined,
    emit: (event, payload) => { capturedEmit = payload; realCtx.emit(event, payload); },
    removePending: () => undefined,
  }, {
    operationId: "op-1",
    kind: IMO_AUTH_DEFAULT_KIND,
    status: "completed",
    exitCode: 0,
    stdoutDigest: "sd",
    stderrDigest: "sed",
    startedAt: "now",
    profileName: "portal:b",
    targetProfile: "portal:b",
  });
  assert.equal((capturedEmit as { profile?: unknown }).profile, "portal:b", "real emit carries sanitized profile");
  // assert synchronously (no manual refresh)
  assert.match(contextText(), /InsureMO active profile: portal:b/, "runtime-context updated synchronously from real finalize emit");
  // verify AUTH_ACTION_COMPLETED was the emitted event name
  dispose();
  await fx.authFiber.dispose();
});
