import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { mountCurrentProfileSection } from "../src/current-profile-section.ts";
import { AUTH_ACTION_COMPLETED_EVENT } from "../src/auth/action-types.ts";

interface Section { name: string; order: number; text: string | ((context: unknown) => string) }

async function fixture(profileState: { name: string | null; env?: string } | { fail: true }) {
  const ctx = new Context() as unknown as {
    get(name: string): unknown;
    on(name: string, listener: (payload: unknown) => void): () => void;
    emit(name: string, payload: unknown): void;
    systemPrompt: { section(section: Section): () => void };
  };
  let profile = profileState;
  const sections: Section[] = [];
  (ctx as never as { systemPrompt: unknown }).systemPrompt = {
    section: (section: Section) => { sections.push(section); return () => { const i = sections.indexOf(section); if (i >= 0) sections.splice(i, 1); }; },
  };
  (ctx as never as { get(name: string): unknown }).get = (name: string) => name === "imoAuth" ? {
    defaultProfile: async () => ("fail" in profile ? { ok: false, error: { code: "cli-error" } } : { ok: true, value: { profileName: profile.name, stdoutDigest: "d" } }),
    listProfiles: async () => ("fail" in profile ? { ok: false, error: { code: "cli-error" } } : { ok: true, value: { profiles: profile.name === null ? [] : [{ profileName: profile.name, ...(profile.env === undefined ? {} : { env: profile.env }) }] } }),
  } : undefined;
  const unregister = mountCurrentProfileSection(ctx as never);
  const text = (): string => {
    const section = sections[0];
    if (section === undefined) throw new Error("section not registered");
    return typeof section.text === "function" ? section.text({}) : section.text;
  };
  const flush = async (): Promise<void> => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
  return { ctx, sections, unregister, text, flush, setProfile: (next: typeof profile) => { profile = next; } };
}

test("current-profile section: registered with dynamic text; two states; refresh on auth action", async () => {
  const h = await fixture({ name: "portal:microsite", env: "aws_sg_insuremo_portal" });
  try {
    assert.equal(h.sections.length, 1);
    assert.equal(h.sections[0].name, "insuremo:current-profile");
    assert.equal(h.sections[0].order, 160);
    assert.equal(typeof h.sections[0].text, "function");
    // first read triggers async refresh → after flush the mirror is warm
    h.text();
    await h.flush();
    assert.match(h.text(), /InsureMO current auth profile: portal:microsite \(env aws_sg_insuremo_portal\)/);
    assert.match(h.text(), /Workbench remote operations use this profile\./);
    // switch: emit auth action completed → mirror invalidated → next read refreshes to the new name
    h.setProfile({ name: "portal:mo-re", env: "aws_sg_insuremo_portal" });
    h.ctx.emit(AUTH_ACTION_COMPLETED_EVENT, { operationId: "op", kind: "auth-default-switch", status: "completed" });
    h.text();
    await h.flush();
    assert.match(h.text(), /portal:mo-re/);
    // no profile → not-configured hint
    h.setProfile({ name: null });
    h.ctx.emit(AUTH_ACTION_COMPLETED_EVENT, { operationId: "op2", kind: "auth-default-switch", status: "completed" });
    h.text();
    await h.flush();
    assert.match(h.text(), /not-configured/);
    assert.match(h.text(), /imo auth login/);
  } finally { h.unregister(); }
});

test("current-profile section: CLI failures degrade to not-configured, never throw", async () => {
  const h = await fixture({ fail: true });
  try {
    h.text();
    await h.flush();
    assert.match(h.text(), /not-configured/);
  } finally { h.unregister(); }
});
