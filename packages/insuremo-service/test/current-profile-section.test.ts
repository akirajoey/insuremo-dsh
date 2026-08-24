import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { mountCurrentProfileSection } from "../src/current-profile-section.ts";
import { AUTH_ACTION_COMPLETED_EVENT } from "../src/auth/action-types.ts";
import { AUTH_CACHE_INVALIDATED_EVENT } from "../src/auth/types.ts";

interface Contribution { name: string; order: number; text: string | ((context: unknown) => string) }

interface Deferred {
  resolve(): void;
  promise: Promise<void>;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { resolve, promise };
}

/** Fake imoAuth whose defaultProfile/listProfiles await `gate` before settling. */
function makeAuth(gate: Deferred, profileState: { name: string | null; env?: string } | { fail: true }) {
  const wait = async (): Promise<void> => { await gate.promise; };
  return {
    profilesFast: async () => {
      await wait();
      if ("fail" in profileState) return { ok: false, error: { code: "cli-error" } };
      const profiles = profileState.name === null ? [] : [{ profileName: profileState.name, ...("env" in profileState && profileState.env !== undefined ? { env: profileState.env } : {}) }];
      return { ok: true, value: { profiles, defaultProfile: profileState.name, stale: false } };
    },
  };
}

async function fixture(profileState: { name: string | null; env?: string } | { fail: true }, opts: { withSystemPrompt?: boolean; gate?: Deferred } = {}) {
  const withSystemPrompt = opts.withSystemPrompt !== false;
  const gate = opts.gate ?? (() => { const d = deferred(); d.resolve(); return d; })();
  const ctx = new Context() as unknown as {
    get(name: string): unknown;
    on(name: string, listener: (payload: unknown) => void): () => void;
    emit(name: string, payload: unknown): void;
  };
  let profile = profileState;
  const contexts: Contribution[] = [];
  const systemPrompt = {
    context(contribution: Contribution): () => void {
      contexts.push(contribution);
      return () => { const i = contexts.indexOf(contribution); if (i >= 0) contexts.splice(i, 1); };
    },
  };
  (ctx as never as { get(name: string): unknown }).get = (name: string) => {
    if (name === "systemPrompt") return withSystemPrompt ? systemPrompt : undefined;
    if (name === "imoAuth") {
      const gateNow = gate;
      return {
        profilesFast: async () => {
          await gateNow.promise;
          if ("fail" in profile) return { ok: false, error: { code: "cli-error" } };
          const profiles = profile.name === null ? [] : [{ profileName: profile.name, ...("env" in profile && profile.env !== undefined ? { env: profile.env } : {}) }];
          return { ok: true, value: { profiles, defaultProfile: profile.name, stale: false } };
        },
      };
    }
    return undefined;
  };
  const mount = mountCurrentProfileSection(ctx as never);
  const contextText = (): string => {
    const contribution = contexts[0];
    if (contribution === undefined) throw new Error("context not registered");
    return typeof contribution.text === "function" ? contribution.text({}) : contribution.text;
  };
  return { ctx, contexts, mount, contextText, setProfile: (next: typeof profile) => { profile = next; } };
}

test("FIX-2 real async mount: no registration until prewarm settles; first render is warm profile (deferred auth)", async () => {
  const gate = deferred();
  const h = await fixture({ name: "portal:microsite", env: "aws_sg_insuremo_portal" }, { gate });
  const mountPromise = h.mount;
  let mountDone = false;
  void mountPromise.then(() => { mountDone = true; });
  // before the prewarm resolves, the mount has NOT registered (and not raced)
  await new Promise(r => setImmediate(r));
  assert.equal(mountDone, false, "mount must await the prewarm");
  assert.equal(h.contexts.length, 0, "no context before prewarm resolves");
  gate.resolve();
  const dispose = await mountPromise;
  assert.equal(mountDone, true);
  assert.equal(h.contexts.length, 1);
  // first render after the waited prewarm is the profile, NOT "none"
  assert.match(h.contextText(), /InsureMO active profile: portal:microsite \(env aws_sg_insuremo_portal\)/);
  dispose();
});

test("FIX-2 missing systemPrompt THROWS (fail loud), never a warned noop", async () => {
  const gate = (() => { const d = deferred(); d.resolve(); return d; })();
  const h = await fixture({ name: "portal:microsite" }, { withSystemPrompt: false, gate });
  await assert.rejects(() => h.mount, /systemPrompt service is unavailable/);
  assert.equal(h.contexts.length, 0);
});

test("FIX-2 direct switch: AUTH_CACHE_INVALIDATED(profile) lands synchronously on the next evaluation", async () => {
  const h = await fixture({ name: "portal:microsite", env: "aws_sg_insuremo_portal" });
  const dispose = await h.mount;
  assert.match(h.contextText(), /InsureMO active profile: portal:microsite/);
  h.ctx.emit(AUTH_CACHE_INVALIDATED_EVENT, { profile: "portal:mo-re", reason: "profile-changed", invalidated: 1 });
  assert.match(h.contextText(), /InsureMO active profile: portal:mo-re/, "switch reflected synchronously");
  dispose();
});

test("FIX-2 approval-path default switch syncs name synchronously", async () => {
  const h = await fixture({ name: "portal:microsite" });
  const dispose = await h.mount;
  h.ctx.emit(AUTH_ACTION_COMPLETED_EVENT, { operationId: "op", kind: "auth-default-switch", status: "completed", profile: "portal:mo-re" });
  assert.match(h.contextText(), /InsureMO active profile: portal:mo-re/);
  dispose();
});

test("FIX-2 approval-path non-default completion drops+refreshes, render not stuck on none (background refresh)", async () => {
  const h = await fixture({ name: "portal:microsite", env: "aws_sg_insuremo_portal" });
  const dispose = await h.mount;
  h.ctx.emit(AUTH_ACTION_COMPLETED_EVENT, { operationId: "op", kind: "auth-login", status: "completed" });
  // mirror dropped → background refresh repopulates; poll briefly
  let text = "";
  for (let i = 0; i < 10; i += 1) {
    text = h.contextText();
    if (/portal:microsite/.test(text)) break;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.match(text, /InsureMO active profile: portal:microsite/, "refresh repopulated after completion");
  dispose();
});
