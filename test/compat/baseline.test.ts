// TASK-162: source-runtime behavior observations, not browser or rc.5 certification.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import type { Context as CordisContext } from '@deepseek-ai/cordis';
import type * as TypeScript from '../../packages/icomposer-verify/node_modules/typescript/lib/typescript.js';

// Fail closed *before importing any Harness or Workbench runtime module* if a
// developer accidentally invokes this test without the isolating runner.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const h2 = resolve(root, '../deepseek-harness');
const isolated = process.env.COMPAT_ISOLATED_ROOT;
assert.equal(process.env.COMPAT_TEST_ROOT, root, 'run through test/compat/run.mjs');
assert.equal(process.env.COMPAT_H2_ROOT, h2, 'wrong Harness source');
assert.ok(isolated && isolated.startsWith(`${realpathSync('/tmp')}${sep}workbench-compat-`), 'missing isolated /tmp root');
for (const name of ['HOME', 'USERPROFILE', 'DSH_HOME', 'TMPDIR']) {
  const value = process.env[name];
  assert.ok(value && realpathSync(value).startsWith(`${realpathSync(isolated)}${sep}`), `${name} is not isolated`);
}

type Context = CordisContext;
const { Context } = await import('@deepseek-ai/cordis');
const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader');
const { WebServer } = await import('@deepseek-ai/dsh-host-webserver');
const { default: ToolRuntime, defineContentToolFixture } = await import('@deepseek-ai/dsh-tools');
const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');
const insuremo = await import('../../packages/insuremo-service/src/index.ts');
const { InsuremoRoutesService } = await import('../../packages/insuremo-service/src/overview/route-service.ts');
const aggregate = await import('../../packages/icomposer-workbench-dist/src/index.ts');
const { IcomposerVerifyToolService } = await import('../../packages/icomposer-verify/src/tool-service.ts');
const requireForTests = createRequire(join(root, 'packages/insuremo-service/package.json'));
const requireForTs = createRequire(join(root, 'packages/icomposer-verify/package.json'));
const yaml = requireForTests('yaml') as typeof import('yaml');
const ts = requireForTs('typescript') as typeof TypeScript;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const overviewPath = '/api/icomposer-workbench/insuremo/overview';
const healthPath = `${overviewPath}/workspaces/status`;
const toolNames = [
  'icomposer_catalog_list', 'icomposer_sdk_query', 'icomposer_verify_utils',
  'ici_query', 'ici_search', 'ici_build', 'ici_status', 'ici_explain',
].sort();
const promptNames = [
  'tool:icomposer_catalog_list', 'tool:icomposer_sdk_query', 'tool:icomposer_verify_utils',
  'tool:ici_query', 'tool:ici_build', 'tool:ici_status', 'tool:ici_explain',
].sort();

function patchEntry(file: string, name: string): { inject: string[] } {
  const groups = yaml.parse(readFileSync(join(root, file), 'utf8')) as Array<{ insert?: Array<{ name: string; inject?: string[] }> }>;
  const entry = groups.flatMap(group => group.insert ?? []).find(item => item.name === name);
  assert.ok(entry, `fixture requires the actual ${name} patch entry`);
  return { inject: entry.inject ?? [] };
}

function memoryTable() {
  const entries = new Map<string, unknown>();
  return {
    get: (key: string) => entries.get(key),
    entries: () => [...entries.entries()],
    keys: () => [...entries.keys()],
    get size() { return entries.size; },
    put: async (key: string, value: unknown) => { entries.set(key, value); },
    delete: async (key: string) => entries.delete(key),
    update: async (key: string, update: (value: unknown) => unknown) => {
      const value = update(entries.get(key)); entries.set(key, value); return value;
    },
  };
}

/** All non-Cordis/WebServer/ToolRuntime/SystemPrompt dependencies below are fakes. */
function addFixtureFaces(ctx: Context) {
  const calls = { spawn: 0, job: 0, settings: [] as string[] };
  const tables = new Map<string, ReturnType<typeof memoryTable>>();
  ctx.provide('subprocess', {
    resolveExecutable: async (command: string) => `/fixture/bin/${command}`,
    spawn: () => { calls.spawn++; throw new Error('fixture forbids subprocess execution'); },
  } as never);
  ctx.provide('storageDomain', {
    open: async () => ({
      global: { get: () => ({ maxConcurrent: 4 }), set: async () => {} },
      table: (name: string) => {
        if (!tables.has(name)) tables.set(name, memoryTable());
        return tables.get(name)!;
      },
      close: async () => {},
    }),
  } as never);
  ctx.provide('workspaceRegistry', { list: () => [], get: () => undefined } as never);
  ctx.provide('skills', { registerProvider: () => () => {}, snapshot: async () => ({ skills: [] }), on: () => () => {} } as never);
  ctx.provide('jobs', { start: () => { calls.job++; throw new Error('fixture forbids jobs'); } } as never);
  ctx.provide('llm', { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => undefined } as never);
  ctx.provide('agents', { roots: () => [], get: () => undefined, list: () => [], register: () => () => {} } as never);
  ctx.provide('directoryPicker', { capability: () => undefined } as never);
  return calls;
}

function addFixtureSettings(ctx: Context, calls: ReturnType<typeof addFixtureFaces>) {
  ctx.provide('settings', {
    register: (name: string, schema: unknown) => {
      assert.equal(typeof schema, 'function');
      calls.settings.push(name);
      return () => {};
    },
  } as never);
}

async function startHttp(ctx: Context): Promise<string> {
  const fiber = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  await fiber.await();
  assert.equal((fiber as unknown as { _error?: unknown })._error, undefined, 'real H2 WebServer failed to start');
  return ctx.webServer.getOrigin();
}

async function startLoaderEntry(ctx: Context, label: string, plugin: unknown, options: { inject: string[]; config?: unknown }) {
  await ctx.plugin(Loader);
  ctx.loader.builtins[label] = plugin;
  const id = await ctx.loader.create({ name: `cordis:${label}`, ...options });
  await ctx.loader.await();
  const entry = ctx.loader.resolve(id);
  assert.ok(entry.fiber, `real Loader did not create ${label}`);
  await entry.fiber.await();
  assert.equal((entry.fiber as unknown as { _error?: unknown })._error, undefined, `${label} loader fiber failed`);
  return entry.fiber;
}

async function waitFor(description: string, predicate: () => boolean) {
  for (let count = 0; count < 100; count++) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail(`timed out waiting for ${description}`);
}

async function request(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`, { headers: { Connection: 'close' } });
  return { status: response.status, body: await response.text() };
}

function allTools(ctx: Context): string[] {
  return ctx.tools.schemas().map(tool => tool.name).sort();
}

function fixtureSafety(calls: ReturnType<typeof addFixtureFaces>) {
  assert.equal(calls.spawn, 0, 'no subprocess, including a real IMO/Skills CLI, may run');
  assert.equal(calls.job, 0, 'no fixture job may run');
}

test('H2 runtime imports resolve to pinned source and process uses a new isolated HOME', (t) => {
  assert.ok(root && h2 && isolated, 'run through test/compat/run.mjs');
  for (const name of ['HOME', 'USERPROFILE', 'DSH_HOME', 'TMPDIR']) {
    const value = process.env[name];
    assert.ok(value && resolve(value).startsWith(`${resolve(isolated)}/`), `${name} is not isolated`);
  }
  const expected: Record<string, string> = {
    '@deepseek-ai/cordis': 'vendor/cordis/src/index.ts',
    '@deepseek-ai/cordis-plugin-loader': 'vendor/loader/src/index.ts',
    '@deepseek-ai/dsh-host-webserver': 'packages/host/webserver/src/index.ts',
    '@deepseek-ai/dsh-tools': 'packages/core/tools/src/index.ts',
    '@deepseek-ai/dsh-system-prompt': 'packages/core/system-prompt/src/index.ts',
    '@deepseek-ai/dsh-util-values': 'packages/util/values/src/index.ts',
    '@deepseek-ai/dsh-util-crypto': 'packages/util/crypto/src/index.ts',
    '@deepseek-ai/dsh-brand': 'packages/util/brand/src/index.ts',
    '@deepseek-ai/dsh-typert-protocol': 'packages/typert/protocol/src/index.ts',
    '@deepseek-ai/dsh-sandbox': 'packages/sandbox/sandbox/src/index.ts',
  };
  for (const [specifier, path] of Object.entries(expected)) {
    const actual = fileURLToPath(import.meta.resolve(specifier));
    assert.equal(actual, join(h2, path), `${specifier} must resolve to the H2 source`);
    t.diagnostic(`${specifier} -> ${actual}`);
  }
  t.diagnostic('Runtime source resolution only; not real d.ts, package-closure or rc.5 validation.');
});

test('standalone real Loader unwraps to CLI with the patch inject and isolated command fixture', async () => {
  const ctx = new Context();
  const calls = addFixtureFaces(ctx);
  // This face is required by the actual legacy standalone patch; it is not imoAuth/imoSkills.
  ctx.provide('operationLog', {} as never);
  try {
    await startHttp(ctx);
    const patch = patchEntry('packages/bundle-icomposer-workbench/cordis.patch.yml', '@icomposer/insuremo-service');
    const fiber = await startLoaderEntry(ctx, 'compat-standalone', insuremo, {
      ...patch, config: { command: 'fixture-imo', timeoutMs: 1234 },
    });
    assert.equal(ctx.loader.unwrapExports(insuremo), insuremo.default);
    assert.equal(fiber.runtime?.callback, insuremo.default);
    assert.equal(fiber.config.command, 'fixture-imo');
    assert.equal(fiber.config.timeoutMs, 1234);
    assert.ok(ctx.get('imoCli'));
    assert.equal(ctx.get('imoAuth'), undefined);
    assert.equal(ctx.get('imoSkills'), undefined);
    assert.deepEqual(await ctx.imoCli.probe(), {
      ok: true, value: { command: 'fixture-imo', executablePath: '/fixture/bin/fixture-imo' },
    });
    await fiber.dispose();
    assert.equal(ctx.get('imoCli'), undefined);
    fixtureSafety(calls);
  } finally { await ctx.fiber.dispose(); }
});

test('aggregate real Loader preserves child capabilities with settings absent/present', async (t) => {
  for (const withSettings of [false, true]) {
    const ctx = new Context();
    const calls = addFixtureFaces(ctx);
    if (withSettings) addFixtureSettings(ctx, calls);
    try {
      await ctx.plugin(SystemPrompt, {});
      await ctx.plugin(ToolRuntime, {});
      const origin = await startHttp(ctx);
      const patch = patchEntry('packages/icomposer-workbench-dist/cordis.patch.yml', '@icomposer/workbench');
      const fiber = await startLoaderEntry(ctx, `compat-aggregate-${withSettings}`, aggregate, {
        ...patch, config: { insuremoService: { command: 'fixture-imo' } },
      });
      assert.equal(ctx.loader.unwrapExports(aggregate), aggregate.default);
      assert.equal(fiber.runtime?.callback, aggregate.default);
      assert.equal(Object.hasOwn(fiber.inject, 'systemPrompt'), false, 'root must not gain systemPrompt as a hard dependency');
      await waitFor('aggregate service activation', () => Boolean(ctx.get('icomposerVerifyTools')));
      for (const name of ['imoCli', 'imoSkills', 'imoAuth', 'imoOverview', 'operationLog', 'workspaceBinding', 'icomposerVerify']) {
        assert.ok(ctx.get(name as never), `aggregate service ${name} missing`);
      }
      assert.deepEqual(allTools(ctx), toolNames);
      assert.deepEqual(calls.settings, withSettings ? ['insuremo'] : []);
      const health = await request(origin, healthPath);
      assert.equal(health.status, 200);
      assert.deepEqual(JSON.parse(health.body), { workspaces: [] });
      const usesNamedApply = typeof insuremo.apply === 'function' && ctx.registry.has(insuremo.apply as never);
      t.diagnostic(`settings=${withSettings}: aggregate child uses named insuremo apply = ${usesNamedApply} (observation, not a permanent export-shape requirement)`);
      await fiber.dispose();
      assert.equal(ctx.get('imoCli'), undefined);
      fixtureSafety(calls);
    } finally { await ctx.fiber.dispose(); }
  }
});

test('aggregate without systemPrompt keeps independent services active while tool child waits', async () => {
  const ctx = new Context();
  const calls = addFixtureFaces(ctx);
  // ToolRuntime requires the real prompt service, so this test intentionally uses
  // a fake tools FACE to isolate missing-systemPrompt activation. No tool executes.
  ctx.provide('tools', { register: () => () => {}, restrict: () => {}, schemas: () => [] } as never);
  try {
    await startHttp(ctx);
    const patch = patchEntry('packages/icomposer-workbench-dist/cordis.patch.yml', '@icomposer/workbench');
    const fiber = await startLoaderEntry(ctx, 'compat-no-prompt', aggregate, { ...patch });
    await waitFor('CLI and auth without systemPrompt', () => Boolean(ctx.get('imoCli')) && Boolean(ctx.get('imoAuth')));
    assert.equal(Object.hasOwn(fiber.inject, 'systemPrompt'), false);
    assert.ok(ctx.get('imoAuth'));
    assert.equal(ctx.get('icomposerVerifyTools'), undefined);
    await fiber.dispose();
    fixtureSafety(calls);
  } finally { await ctx.fiber.dispose(); }
});

test('real WebServer route owner/unload: report existing residue without requiring it forever', async (t) => {
  const ctx = new Context();
  try {
    const origin = await startHttp(ctx);
    const releaseUnrelated = ctx.webServer.register({
      kind: 'exact', path: '/compat-unrelated', handler: (_req, res) => { res.writeHead(200); res.end('other-owner'); },
    });
    // The route service inherits a name-taking Service constructor type; the
    // actual aggregate mounts it without config. The cast preserves that runtime path.
    const first = ctx.plugin(InsuremoRoutesService as never, undefined as never);
    await first.await();
    assert.equal((first as unknown as { _error?: unknown })._error, undefined);
    await delay(40); // Explicitly cover the documented 25–30 ms effect-sweep window.
    assert.deepEqual(await request(origin, overviewPath), { status: 200, body: '{}' });
    await first.dispose();
    const after = await request(origin, overviewPath);
    assert.ok([200, 404].includes(after.status), `unexpected response after await unload: ${after.status}`);
    assert.deepEqual(await request(origin, '/compat-unrelated'), { status: 200, body: 'other-owner' });

    let replacement: (() => void) | undefined;
    let duplicate = false;
    try {
      replacement = ctx.webServer.register({ kind: 'exact', path: overviewPath, handler: (_req, res) => { res.end('replacement'); } });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('duplicate')) throw error;
      duplicate = true;
    }
    assert.equal(duplicate, after.status === 200, 'response and registration must agree on the remaining owner');
    replacement?.();
    t.diagnostic(`direct ctx.plugin(InsuremoRoutesService), real H2 WebServer 127.0.0.1:0: GET ${overviewPath} after 40ms=200, after await dispose=${after.status}, direct duplicate=${duplicate}; unrelated owner remains 200.`);
    if (duplicate) t.diagnostic('OPEN C-05: old route persists in this direct-mount fixture; not a claim about loader entry or real HMR.');
    else t.diagnostic('C-05 direct-mount observation changed: route released; review before marking the issue fixed elsewhere.');

    // Legacy service swallows duplicate; a future implementation may instead fail
    // loudly. Record either outcome; never encode swallowed failure as success.
    const again = ctx.plugin(InsuremoRoutesService as never, undefined as never);
    await again.await();
    t.diagnostic(`direct remount fiber state=${again.state}; review duplicate handling separately (not a release gate).`);
    await again.dispose();
    assert.deepEqual(await request(origin, '/compat-unrelated'), { status: 200, body: 'other-owner' });
    releaseUnrelated();
  } finally { await ctx.fiber.dispose(); }

  // A distinct owner already holds the exact same path. Regardless of whether
  // the Workbench service swallows the conflict today or fails loudly later,
  // its teardown must not remove the other owner's handler.
  const conflictCtx = new Context();
  try {
    const origin = await startHttp(conflictCtx);
    const releaseExternal = conflictCtx.webServer.register({
      kind: 'exact', path: overviewPath, handler: (_req, res) => { res.writeHead(200); res.end('external-owner'); },
    });
    const owner = conflictCtx.plugin(InsuremoRoutesService as never, undefined as never);
    await owner.await();
    assert.deepEqual(await request(origin, overviewPath), { status: 200, body: 'external-owner' });
    t.diagnostic(`same-path external-owner collision: Workbench fiber state=${owner.state}; no claim that swallowed duplicate is acceptable.`);
    await owner.dispose();
    assert.deepEqual(await request(origin, overviewPath), { status: 200, body: 'external-owner' });
    releaseExternal();
  } finally { await conflictCtx.fiber.dispose(); }
});

test('real ToolRuntime/SystemPrompt preserve workbench owner same-turn cleanup and remount', async (t) => {
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, {});
    const fiber = ctx.plugin(IcomposerVerifyToolService);
    await fiber.await();
    assert.equal((fiber as unknown as { _error?: unknown })._error, undefined);
    assert.deepEqual(allTools(ctx), toolNames);
    const sections = (await ctx.systemPrompt.assemble()).sections.map(section => section.name).filter(name => name.startsWith('tool:')).sort();
    assert.deepEqual(sections, promptNames);
    const stopping = fiber.dispose();
    assert.deepEqual(allTools(ctx), [], 'existing workbench listener releases its own tools in the same turn');
    for (const name of promptNames) {
      // A real duplicate check on the same turn also proves each prompt name
      // is released before awaiting the owner's dispose promise.
      const release = ctx.systemPrompt.section({ name, order: 150, text: 'isolated fixture' });
      release();
    }
    await stopping;
    const afterSections = (await ctx.systemPrompt.assemble()).sections.map(section => section.name).filter(name => name.startsWith('tool:'));
    assert.deepEqual(afterSections, []);
    const again = ctx.plugin(IcomposerVerifyToolService);
    await again.await();
    assert.equal((again as unknown as { _error?: unknown })._error, undefined);
    assert.deepEqual(allTools(ctx), toolNames);
    await again.dispose();
    assert.deepEqual(allTools(ctx), []);
    t.diagnostic('Real W tool service + H2 registries: 8 tools/7 prompts, same-turn release and awaited remount; not an HMR test.');
  } finally { await ctx.fiber.dispose(); }
});

test('real ToolRuntime compares automatic same-turn cleanup with awaited release', async (t) => {
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, {});
    const probe = defineContentToolFixture({ name: 'compat_probe', description: 'isolated fixture', parameters: {}, async execute() { return []; } });
    const owner = ctx.plugin(Object.assign((inner: Context) => { inner.tools.register(probe); }, { inject: ['tools'] }));
    await owner.await();
    assert.ok(ctx.tools.get('compat_probe'));
    const stopping = owner.dispose();
    let sameTurn: 'registered' | 'duplicate' = 'registered';
    let replacement: (() => void) | undefined;
    try { replacement = ctx.tools.register(probe); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('already registered')) throw error;
      sameTurn = 'duplicate';
    }
    await stopping;
    replacement?.();
    assert.equal(ctx.tools.get('compat_probe'), undefined);
    const afterAwait = ctx.tools.register(probe);
    assert.ok(ctx.tools.get('compat_probe'));
    afterAwait();
    t.diagnostic(`Real Cordis + ToolRuntime effect-only fixture: same-turn direct registration=${sameTurn}; after await dispose registration succeeds. Observation is not an HMR claim or a requirement to retain a duplicate window.`);
  } finally { await ctx.fiber.dispose(); }
});

test('EX-WH-01 exact source and health footer registration guard (static only)', (t: TestContext) => {
  const healthFile = join(root, 'packages/ui-insuremo-status/src/client/WorkspaceHealth.tsx');
  const health = readFileSync(healthFile, 'utf8');
  assert.equal(hash(health), '76e84d4b6b9d832cd203a02355f2448dd61aad820d1ba74de8af84cbb3bdb44e', 'health source changed: review the authorized driver/position before updating this baseline');
  for (const required of [
    'setInterval(() => void this.load(), 60_000)', 'new MutationObserver(() => this.syncRows())',
    'this.#observer.observe(this.#driverRef.ownerDocument.body', '[role="treeitem"][aria-expanded]',
    '[class*="projectText"]', '[class*="rowActions"]', 'treeitem.insertBefore(host, anchor)',
    'createRoot(host)', 'this.#observer?.disconnect()', 'port.root.unmount()', 'port.host.remove()',
    'data-icomposer-workspace-health-driver',
  ]) assert.ok(health.includes(required), `health driver baseline missing: ${required}`);

  const indexFile = join(root, 'packages/ui-insuremo-status/src/client/index.ts');
  const index = readFileSync(indexFile, 'utf8');
  const parsed = ts.createSourceFile(indexFile, index, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const healthRegistrations: string[] = [];
  function visit(node: TypeScript.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'ctx.slots.inject'
      && node.arguments[0]?.getText(parsed) === '"sidebar.footer.action"'
      && node.getText(parsed).includes('id: "insuremo-workspace-health"')) {
      healthRegistrations.push(node.getText(parsed));
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.equal(healthRegistrations.length, 1);
  assert.equal(hash(healthRegistrations[0]!), 'b49f9196c1f3abd7626112bd7203130c66241d3dd029239e58aea074358a5a64', 'health footer registration changed: review before updating baseline');
  assert.ok(healthRegistrations[0]!.includes('WorkspaceHealth'));
  t.diagnostic('Source/hash + AST registration guard only: no claim that a real page rendered, had no duplicates or cleaned up. BrandChrome/Picker are not included in EX-WH-01.');
});
