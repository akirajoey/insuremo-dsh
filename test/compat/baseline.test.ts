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
const { mountWriteRoutes } = await import('../../packages/insuremo-service/src/overview/write-routes.ts');
const aggregate = await import('../../packages/icomposer-workbench-dist/src/index.ts');
const workbenchConfig = await import('../../packages/icomposer-workbench-dist/src/config.ts');
const { resolveConfig: resolveInsuremoConfig } = await import('../../packages/insuremo-service/src/config.ts');
const { IcomposerVerifyToolService } = await import('../../packages/icomposer-verify/src/tool-service.ts');
const requireForTests = createRequire(join(root, 'packages/insuremo-service/package.json'));
const requireForTs = createRequire(join(root, 'packages/icomposer-verify/package.json'));
const yaml = requireForTests('yaml') as typeof import('yaml');
const ts = requireForTs('typescript') as typeof TypeScript;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const overviewPath = '/api/icomposer-workbench/insuremo/overview';
const healthPath = `${overviewPath}/workspaces/status`;
const actionPaths = [
  'imo-upgrade', 'imo-install', 'imo-diagnosis', 'skill-activation', 'skill-catalog-refresh',
  'skill-update', 'skill-install', 'skill-remove', 'active-profile', 'default-profile',
].map(name => `${overviewPath}/actions/${name}`);
const routePaths = [overviewPath, `${overviewPath}/skill-catalog`, ...actionPaths, healthPath];
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

function logRecords(ctx: Context): unknown[][] {
  const buffer = (ctx.logger as unknown as { buffer?: Array<{ args?: unknown[] }> }).buffer ?? [];
  return buffer.map(message => message.args ?? []);
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
    // TASK-165: one plugin shape at the root — the loader selects the default
    // CLI class, and no top-level `apply` competes with it.
    assert.equal('apply' in insuremo, false, 'insuremo root must not expose a second plugin shape');
    assert.equal(typeof insuremo.insuremoServiceMount?.apply, 'function', 'the aggregate mount object still exists');
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
      // TASK-165: the aggregate mounts the explicit object plugin; the root no
      // longer exposes a top-level `apply`.
      assert.equal('apply' in insuremo, false, 'insuremo root must expose one plugin shape');
      assert.equal(ctx.registry.has(insuremo.insuremoServiceMount.apply as never), true, 'aggregate must mount the object plugin');
      t.diagnostic(`settings=${withSettings}: aggregate mounted insuremoServiceMount (explicit object plugin).`);
      await fiber.dispose();
      // Every aggregate child must be released with the owner, not just the CLI.
      for (const name of ['imoCli', 'imoSkills', 'imoAuth', 'imoOverview', 'operationLog', 'workspaceBinding', 'icomposerVerify', 'icomposerVerifyTools']) {
        assert.equal(ctx.get(name as never), undefined, `aggregate child ${name} survived unload`);
      }
      fixtureSafety(calls);
    } finally { await ctx.fiber.dispose(); }
  }
});

test('dist root inject is one source, equals the loader patch, and keeps systemPrompt child-level', () => {
  const patch = yaml.parse(readFileSync(join(root, 'packages/icomposer-workbench-dist/cordis.patch.yml'), 'utf8')) as Array<{ insert?: Array<{ name: string; inject?: string[] }> }>;
  const entry = patch.flatMap(group => group.insert ?? []).find(item => item.name === '@icomposer/workbench');
  assert.ok(entry);
  assert.deepEqual(entry.inject, [...aggregate.WORKBENCH_ROOT_INJECT]);
  assert.deepEqual([...aggregate.WORKBENCH_ROOT_INJECT], [...aggregate.default.inject]);
  assert.equal(aggregate.WORKBENCH_ROOT_INJECT.length, 10);
  assert.equal(aggregate.WORKBENCH_ROOT_INJECT.includes('systemPrompt' as never), false, 'systemPrompt must stay a child dependency');
  assert.equal(Object.hasOwn(aggregate, 'inject'), false, 'no second drifting inject export');
});

test('aggregate static Config is a real nested schema whose defaults match the constructors', () => {
  const schema = aggregate.WorkbenchDistService.Config;
  assert.equal(typeof schema, 'function');
  // Root is an object-validating transform: a non-object is rejected with a
  // path before schemastery's native resolver can echo the value.
  assert.throws(() => schema('SECRET_SENTINEL'), /\$ must be an object/);
  const parsed = schema({}) as Record<string, { command: string; timeoutMs: number }>;
  // lifecycle/verify/write default to their constructor defaults (imo, 30s).
  for (const field of ['lifecycle', 'verify', 'write'] as const) {
    assert.deepEqual(parsed[field], { command: 'imo', timeoutMs: 30_000 }, `${field} defaults drifted`);
  }
  // insuremoService reuses the existing Config schema unchanged.
  assert.deepEqual(parsed.insuremoService, resolveInsuremoConfig({}));
  const overridden = schema({
    lifecycle: { command: '/opt/fixture/imo', timeoutMs: 5000 },
    insuremoService: { command: 'fixture-imo', timeoutMs: 1234, skillActionTimeoutMs: 999_999, overviewTtlMs: 999_999 },
  }) as Record<string, Record<string, unknown>>;
  assert.deepEqual(overridden.lifecycle, { command: '/opt/fixture/imo', timeoutMs: 5000 });
  assert.deepEqual(overridden.verify, { command: 'imo', timeoutMs: 30_000 });
  // Existing normalization stays a clamp, not a rejection.
  const clamped = resolveInsuremoConfig(overridden.insuremoService);
  assert.equal(clamped.command, 'fixture-imo');
  assert.equal(clamped.timeoutMs, 1234);
  assert.equal(clamped.skillActionTimeoutMs, 300_000);
  assert.equal(clamped.overviewTtlMs, 5_000);
});

test('aggregate config rejects bad values with a located, value-free error', () => {
  const schema = aggregate.WorkbenchDistService.Config;
  const cases: Array<[unknown, RegExp]> = [
    // Object-level values (root and each field) must not echo either.
    ['SECRET_SENTINEL', /\$ must be an object/],
    [['SECRET_SENTINEL'], /\$ must be an object/],
    [{ lifecycle: 'SECRET_SENTINEL' }, /\$\.lifecycle must be an object/],
    [{ verify: [] }, /\$\.verify must be an object/],
    [{ write: 42 }, /\$\.write must be an object/],
    [{ insuremoService: 'SECRET_SENTINEL' }, /\$\.insuremoService must be an object/],
    // Leaf values.
    [{ lifecycle: { timeoutMs: 0 } }, /\$\.lifecycle\.timeoutMs must be between 1 and/],
    [{ lifecycle: { timeoutMs: -1 } }, /\$\.lifecycle\.timeoutMs must be between 1 and/],
    [{ verify: { timeoutMs: 1.5 } }, /\$\.verify\.timeoutMs must be an integer/],
    [{ write: { timeoutMs: 2_147_483_648 } }, /\$\.write\.timeoutMs must be between 1 and/],
    [{ lifecycle: { timeoutMs: 'SECRET_TIMEOUT' } }, /\$\.lifecycle\.timeoutMs must be an integer/],
    [{ verify: { command: '' } }, /\$\.verify\.command must be a non-empty string/],
    [{ write: { command: 'SECRET\u0000CMD' } }, /\$\.write\.command must not contain control characters/],
  ];
  for (const [input, pattern] of cases) {
    let error: unknown;
    try { schema(input); } catch (caught) { error = caught; }
    assert.ok(error instanceof Error, `expected rejection for ${JSON.stringify(input)}`);
    assert.match(error.message, pattern);
    assert.equal(error.message.includes('SECRET'), false, 'error must not echo configured values');
  }
});

test('real Loader validates the aggregate through static Config before mounting', async () => {
  const ctx = new Context();
  const calls = addFixtureFaces(ctx);
  try {
    const origin = await startHttp(ctx);
    // The aggregate root injects `tools`; real ToolRuntime/SystemPrompt satisfy it
    // so the fiber actually activates and the loader validates its config.
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, {});
    await ctx.plugin(Loader);
    ctx.loader.builtins['compat-valid-config'] = aggregate;
    const patch = patchEntry('packages/icomposer-workbench-dist/cordis.patch.yml', '@icomposer/workbench');
    const raw = { lifecycle: { command: '/opt/fixture/imo', timeoutMs: 5000 }, verify: { timeoutMs: 2000 } };
    const id = await ctx.loader.create({ name: 'cordis:compat-valid-config', ...patch, config: raw });
    await ctx.loader.await();
    const fiber = ctx.loader.resolve(id).fiber!;
    await fiber.await();
    assert.equal((fiber as unknown as { _error?: unknown })._error, undefined);
    // The loader validated with our schema, not by passing the raw object through.
    assert.deepEqual(fiber.config, aggregate.WorkbenchDistService.Config(raw));
    assert.deepEqual(fiber.config.lifecycle, { command: '/opt/fixture/imo', timeoutMs: 5000 });
    assert.deepEqual(fiber.config.verify, { command: 'imo', timeoutMs: 2000 });
    assert.deepEqual(fiber.config.write, { command: 'imo', timeoutMs: 30_000 });
    assert.ok(ctx.get('imoCli'));
    assert.equal((await request(origin, healthPath)).status, 200);
    fixtureSafety(calls);
    await fiber.dispose();
  } finally { await ctx.fiber.dispose(); }
});

test('invalid aggregate config fails before any mount and never echoes the value', async () => {
  const ctx = new Context();
  const calls = addFixtureFaces(ctx);
  try {
    const origin = await startHttp(ctx);
    // The aggregate root injects `tools`; real ToolRuntime/SystemPrompt satisfy it
    // so the fiber actually activates and the loader validates its config.
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, {});
    await ctx.plugin(Loader);
    ctx.loader.builtins['compat-bad-config'] = aggregate;
    const patch = patchEntry('packages/icomposer-workbench-dist/cordis.patch.yml', '@icomposer/workbench');
    const id = await ctx.loader.create({
      name: 'cordis:compat-bad-config', ...patch,
      config: { lifecycle: { timeoutMs: 'SECRET_TIMEOUT' } },
    });
    await ctx.loader.await();
    const fiber = ctx.loader.resolve(id).fiber!;
    const error: unknown = await fiber.await().then(() => undefined, caught => caught);
    assert.ok(error instanceof Error, 'invalid config must fail the fiber');
    assert.match(error.message, /\$\.lifecycle\.timeoutMs must be an integer/);
    assert.equal(error.message.includes('SECRET_TIMEOUT'), false);
    // Zero partial mount: no service, no route, no brand asset registration.
    for (const name of ['imoCli', 'imoAuth', 'operationLog', 'workspaceBinding', 'icomposerVerify']) {
      assert.equal(ctx.get(name as never), undefined, `${name} must not mount with an invalid config`);
    }
    assert.equal((await request(origin, overviewPath)).status, 404);
    assert.equal((await request(origin, healthPath)).status, 404);
    fixtureSafety(calls);
  } finally { await ctx.fiber.dispose(); }
});

test('real Loader rejects non-object config without echoing it in the error or host log', async () => {
  const cases: unknown[] = ['SECRET_SENTINEL', { lifecycle: 'SECRET_SENTINEL' }];
  for (const [index, raw] of cases.entries()) {
    const ctx = new Context();
    const calls = addFixtureFaces(ctx);
    try {
      await startHttp(ctx);
      await ctx.plugin(SystemPrompt, {});
      await ctx.plugin(ToolRuntime, {});
      await ctx.plugin(Loader);
      const label = `compat-bad-shape-${index}`;
      ctx.loader.builtins[label] = aggregate;
      const patch = patchEntry('packages/icomposer-workbench-dist/cordis.patch.yml', '@icomposer/workbench');
      const id = await ctx.loader.create({ name: `cordis:${label}`, ...patch, config: raw });
      await ctx.loader.await();
      const fiber = ctx.loader.resolve(id).fiber!;
      const error: unknown = await fiber.await().then(() => undefined, caught => caught);
      assert.ok(error instanceof Error, `expected rejection for ${JSON.stringify(raw)}`);
      assert.match(error.message, /\$(\.lifecycle)? must be an object/);
      assert.equal(error.message.includes('SECRET_SENTINEL'), false, 'fiber error must not echo the value');
      // The host logs the rejection; its buffered message must be clean too.
      const logged = logRecords(ctx).flat().map(value => String(value)).join(' ');
      assert.equal(logged.includes('SECRET_SENTINEL'), false, 'host log must not echo the value');
      fixtureSafety(calls);
    } finally { await ctx.fiber.dispose(); }
  }
});

test('unknown aggregate config keys stay merged and warn without values', async () => {
  const ctx = new Context();
  const calls = addFixtureFaces(ctx);
  try {
    await startHttp(ctx); // provides the aggregate's webServer dependency
    // WARN is filtered by the default in-process buffer exporter; capture it
    // explicitly (the app boot configures level 2, so the warning is visible there).
    const warnings: unknown[][] = [];
    const stopExporter = ctx.logger.exporter({
      levels: { default: 2 },
      export: (message) => { if (message.type === 'warn') warnings.push(message.args); },
    });
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, {});
    await ctx.plugin(Loader);
    ctx.loader.builtins['compat-unknown-config'] = aggregate;
    const patch = patchEntry('packages/icomposer-workbench-dist/cordis.patch.yml', '@icomposer/workbench');
    const id = await ctx.loader.create({
      name: 'cordis:compat-unknown-config', ...patch,
      config: { mystery: { token: 'SECRET_VALUE' }, lifecycle: { surprise: 'SECRET_VALUE' } },
    });
    await ctx.loader.await();
    const fiber = ctx.loader.resolve(id).fiber!;
    await fiber.await();
    assert.equal((fiber as unknown as { _error?: unknown })._error, undefined, 'unknown keys must stay compatible');
    // D4: unknown keys are preserved by the non-strict resolver.
    assert.deepEqual(fiber.config.mystery, { token: 'SECRET_VALUE' });
    assert.equal(fiber.config.lifecycle.surprise, 'SECRET_VALUE');
    const warning = warnings.find(args => String(args[0]).includes('unknown keys'));
    assert.ok(warning, 'unknown keys must produce a migration warning');
    const text = warning.join(' ');
    assert.match(text, /mystery/);
    assert.match(text, /lifecycle\.surprise/);
    assert.equal(text.includes('SECRET_VALUE'), false, 'warning must not include values');
    stopExporter();
    fixtureSafety(calls);
    await fiber.dispose();
  } finally { await ctx.fiber.dispose(); }
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

test('real WebServer routes survive the sweep window, release, and remount a new generation', async (t) => {
  const ctx = new Context();
  let generation = 1;
  ctx.provide('imoOverview', {
    snapshot: async () => ({ generation }), snapshotFast: async () => ({ generation }),
  } as never);
  try {
    const origin = await startHttp(ctx);
    const releaseUnrelated = ctx.webServer.register({
      kind: 'exact', path: '/compat-unrelated', handler: (_req, res) => { res.writeHead(200); res.end('other-owner'); },
    });
    // The service inherits a name-taking constructor type, but the aggregate
    // mounts it with no config. The cast preserves the actual runtime path.
    const first = ctx.plugin(InsuremoRoutesService as never, undefined as never);
    await first.await();
    assert.deepEqual(await request(origin, overviewPath), { status: 200, body: '{"generation":1}' });
    await delay(40); // After observed readiness, cover the 25–30 ms sweep window.
    assert.deepEqual(await request(origin, overviewPath), { status: 200, body: '{"generation":1}' });
    await first.dispose();
    for (const path of routePaths) {
      assert.equal((await request(origin, path)).status, 404, `old handler survived: ${path}`);
    }
    assert.deepEqual(await request(origin, '/compat-unrelated'), { status: 200, body: 'other-owner' });

    // The now-free seat must be usable by another owner, and a repeated old
    // disposer must not remove a later Workbench generation.
    const temporary = ctx.webServer.register({ kind: 'exact', path: overviewPath, handler: (_req, res) => { res.end('replacement'); } });
    assert.deepEqual(await request(origin, overviewPath), { status: 200, body: 'replacement' });
    temporary();
    generation = 2;
    const second = ctx.plugin(InsuremoRoutesService as never, undefined as never);
    await second.await();
    assert.deepEqual(await request(origin, overviewPath), { status: 200, body: '{"generation":2}' });
    await first.dispose();
    assert.deepEqual(await request(origin, overviewPath), { status: 200, body: '{"generation":2}' });
    for (const path of routePaths) assert.notEqual((await request(origin, path)).status, 404, `new handler lost: ${path}`);
    await delay(40);
    assert.deepEqual(await request(origin, overviewPath), { status: 200, body: '{"generation":2}' });
    await second.dispose();
    for (const path of routePaths) assert.equal((await request(origin, path)).status, 404, `new handler survived: ${path}`);
    assert.deepEqual(await request(origin, '/compat-unrelated'), { status: 200, body: 'other-owner' });
    releaseUnrelated();
    t.diagnostic('TASK-162 historical direct-mount baseline was 200 after unload; TASK-163 now asserts 404 and safe new generation. Not a real HMR claim.');
  } finally { await ctx.fiber.dispose(); }

  const conflictCtx = new Context();
  try {
    const origin = await startHttp(conflictCtx);
    const releaseExternal = conflictCtx.webServer.register({
      kind: 'exact', path: overviewPath, handler: (_req, res) => { res.writeHead(200); res.end('external-owner'); },
    });
    const owner = conflictCtx.plugin(InsuremoRoutesService as never, undefined as never);
    await assert.rejects(owner.await(), /duplicate exact route/);
    assert.deepEqual(await request(origin, overviewPath), { status: 200, body: 'external-owner' });
    await owner.dispose();
    assert.deepEqual(await request(origin, overviewPath), { status: 200, body: 'external-owner' });
    releaseExternal();
  } finally { await conflictCtx.fiber.dispose(); }
});

test('route setup failures roll back in reverse without deleting external owners', async (t) => {
  const actions = `${overviewPath}/actions`;
  const cases = [
    { name: 'first duplicate', conflict: overviewPath },
    { name: 'mid-write duplicate', conflict: `${actions}/skill-update` },
    { name: 'mid-write injected failure', fault: `${actions}/skill-update` },
    { name: 'after write duplicate', conflict: healthPath },
    { name: 'rollback disposer throws', fault: `${actions}/skill-remove`, releaseThrows: `${actions}/skill-update` },
    { name: 'outer rollback disposer throws', conflict: healthPath, releaseThrows: `${actions}/skill-update` },
  ];
  for (const scenario of cases) {
    const host = new Context();
    const ownerCtx = new Context();
    try {
      const origin = await startHttp(host);
      const server = host.webServer;
      const releaseOther = server.register({
        kind: 'exact', path: '/compat-unrelated', handler: (_req, res) => { res.end('other-owner'); },
      });
      const releaseExternal = scenario.conflict === undefined ? undefined : server.register({
        kind: 'exact', path: scenario.conflict, handler: (_req, res) => { res.end('external-owner'); },
      });
      const acquired: string[] = [];
      const released: string[] = [];
      const failure = new Error('fixture injected route registration failure');
      const adapter = {
        register(route: Parameters<typeof server.register>[0]) {
          if (route.path === scenario.fault) throw failure;
          // Actual H2 WebServer owns the route table and reports collisions.
          const dispose = server.register(route);
          acquired.push(route.path);
          return () => {
            released.push(route.path);
            dispose();
            if (route.path === scenario.releaseThrows) throw new Error('fixture injected disposer failure');
          };
        },
      };
      ownerCtx.provide('webServer', adapter as never);
      const owner = ownerCtx.plugin(InsuremoRoutesService as never, undefined as never);
      const error: unknown = await owner.await().then(
        () => assert.fail(`${scenario.name} was swallowed`),
        caught => caught,
      );
      assert.ok(error instanceof Error);
      if (scenario.conflict !== undefined && scenario.releaseThrows !== undefined) {
        assert.ok(error instanceof AggregateError);
        assert.match(String(error.cause), /duplicate exact route/, 'duplicate must remain the cause even when cleanup throws');
      } else if (scenario.conflict !== undefined) assert.match(error.message, /duplicate exact route/);
      else if (scenario.releaseThrows !== undefined) {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, failure, 'registration failure must remain the cause even when cleanup throws');
      } else assert.equal(error, failure, 'original registration failure must propagate');
      assert.deepEqual(released, [...acquired].reverse(), `${scenario.name}: rollback must release every acquired route in reverse`);
      if (scenario.fault !== undefined || scenario.conflict?.startsWith(`${actions}/`)) {
        assert.ok(acquired.length > 2, 'fixture must fail inside the write-route group');
      }
      if (scenario.conflict === healthPath) assert.ok(acquired.length > 10, 'fixture must fail after the write group');
      for (const path of acquired) assert.equal((await request(origin, path)).status, 404, `${scenario.name}: leaked ${path}`);
      if (scenario.conflict !== undefined) {
        assert.deepEqual(await request(origin, scenario.conflict), { status: 200, body: 'external-owner' });
      }
      assert.deepEqual(await request(origin, '/compat-unrelated'), { status: 200, body: 'other-owner' });
      await owner.dispose();
      await owner.dispose();
      assert.deepEqual(released, [...acquired].reverse(), 'repeated teardown must not release again');
      if (scenario.conflict !== undefined) assert.equal((await request(origin, scenario.conflict)).body, 'external-owner');
      releaseExternal?.();
      releaseOther();
      t.diagnostic(`${scenario.name}: ${acquired.length} acquired routes rolled back; external owner preserved.`);
    } finally {
      await ownerCtx.fiber.dispose();
      await host.fiber.dispose();
    }
  }
});

test('standalone write-route composite is reverse-owned and idempotent', async () => {
  const ctx = new Context();
  try {
    const origin = await startHttp(ctx);
    const path = `${overviewPath}/actions/imo-upgrade`;
    const release = mountWriteRoutes(ctx);
    assert.equal((await request(origin, path)).status, 405);
    release();
    assert.equal((await request(origin, path)).status, 404);
    const releaseExternal = ctx.webServer.register({
      kind: 'exact', path, handler: (_req, res) => { res.end('new-owner'); },
    });
    release();
    assert.deepEqual(await request(origin, path), { status: 200, body: 'new-owner' });
    releaseExternal();
  } finally { await ctx.fiber.dispose(); }
});

test('real Loader aggregate releases and restores routes when webServer dependency changes', async (t) => {
  const host = new Context();
  const ctx = new Context();
  const calls = addFixtureFaces(ctx);
  try {
    const origin = await startHttp(host);
    const server = host.webServer;
    const releaseOther = server.register({
      kind: 'exact', path: '/compat-unrelated', handler: (_req, res) => { res.end('other-owner'); },
    });
    let generation = 1;
    const acquired: string[] = [];
    const released: string[] = [];
    const adapter = {
      register(route: Parameters<typeof server.register>[0]) {
        const ownerGeneration = generation;
        const release = server.register({
          ...route,
          handler: (req, res) => {
            res.setHeader('x-compat-generation', String(ownerGeneration));
            return route.handler(req, res);
          },
        });
        acquired.push(`${ownerGeneration}:${route.path}`);
        return () => { released.push(`${ownerGeneration}:${route.path}`); release(); };
      },
    };
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, {});
    const removeWebServer = ctx.provide('webServer', adapter as never);
    const patch = patchEntry('packages/icomposer-workbench-dist/cordis.patch.yml', '@icomposer/workbench');
    const aggregateFiber = await startLoaderEntry(ctx, 'compat-lifecycle-aggregate', aggregate, {
      ...patch, config: { insuremoService: { command: 'fixture-imo' } },
    });
    const waitHttp = async (status: number, expectedGeneration?: number) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await fetch(`${origin}${healthPath}`, { headers: { Connection: 'close' } });
        await response.text();
        if (response.status === status && (expectedGeneration === undefined
          || response.headers.get('x-compat-generation') === String(expectedGeneration))) return;
        await delay(20);
      }
      assert.fail(`health route did not reach HTTP ${status}, generation ${String(expectedGeneration)}`);
    };
    await waitHttp(200, 1); // Observable readiness, not a sleep used as readiness.
    await delay(40);
    await waitHttp(200, 1);
    await removeWebServer();
    await waitHttp(404);
    assert.equal(ctx.get('imoCli'), undefined, 'aggregate owner should stop when its patch dependency disappears');
    assert.deepEqual(await request(origin, '/compat-unrelated'), { status: 200, body: 'other-owner' });
    const firstHealth = `1:${healthPath}`;
    assert.equal(acquired.filter(path => path === firstHealth).length, 1);
    assert.equal(released.filter(path => path === firstHealth).length, 1);

    generation = 2;
    const removeRestored = ctx.provide('webServer', adapter as never);
    await waitHttp(200, 2);
    await waitFor('aggregate dependencies restored', () => Boolean(ctx.get('imoCli')));
    await delay(40);
    await waitHttp(200, 2);
    const secondHealth = `2:${healthPath}`;
    assert.equal(acquired.filter(path => path === secondHealth).length, 1, 'no duplicate generation-2 handler');
    await aggregateFiber.dispose();
    await waitHttp(404);
    assert.equal(released.filter(path => path === secondHealth).length, 1);
    assert.deepEqual(await request(origin, '/compat-unrelated'), { status: 200, body: 'other-owner' });
    await removeRestored();
    releaseOther();
    fixtureSafety(calls);
    t.diagnostic('Real H2 loader builtin + aggregate; real WebServer table via a tracing adapter: ready→40ms→dependency loss/404→restore generation 2→40ms→owner unload/404. Not a full HMR/package-install test.');
  } finally {
    await ctx.fiber.dispose();
    await host.fiber.dispose();
  }
});

test('real Loader aggregate exposes a route-child duplicate failure and preserves the foreign owner', async (t) => {
  const ctx = new Context();
  const calls = addFixtureFaces(ctx);
  try {
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, {});
    const origin = await startHttp(ctx);
    const conflict = `${overviewPath}/actions/skill-update`;
    const releaseExternal = ctx.webServer.register({
      kind: 'exact', path: conflict, handler: (_req, res) => { res.end('external-owner'); },
    });
    const releaseOther = ctx.webServer.register({
      kind: 'exact', path: '/compat-unrelated', handler: (_req, res) => { res.end('other-owner'); },
    });
    await ctx.plugin(Loader);
    ctx.loader.builtins['compat-collision-aggregate'] = aggregate;
    const patch = patchEntry('packages/icomposer-workbench-dist/cordis.patch.yml', '@icomposer/workbench');
    const id = await ctx.loader.create({ name: 'cordis:compat-collision-aggregate', ...patch });
    await ctx.loader.await();
    const rootFiber = ctx.loader.resolve(id).fiber;
    assert.ok(rootFiber);
    const rootError: unknown = await rootFiber.await().then(() => undefined, error => error);
    await waitFor('route child fiber to appear', () => Boolean(ctx.registry.get(InsuremoRoutesService as never)));
    // TASK-165: an activation-time child failure is reported through the
    // structured host log (bounded window) instead of being silent; healthy
    // siblings keep running. Later-activation failures are not covered by it.
    await waitFor('structured child-failure log', () => logRecords(ctx).some(args =>
      args[0] === 'insuremo-service: child %s failed: %s' && args[1] === 'routes' && /duplicate exact route/.test(String(args[2]))));
    for (const name of ['imoCli', 'imoAuth', 'imoOverview']) {
      assert.ok(ctx.get(name as never), `healthy sibling ${name} must keep running`);
    }
    t.diagnostic(`child-failure log captured; root state=${rootFiber.state} (ACTIVE means mount calls completed, not every child healthy).`);
    const runtime = ctx.registry.get(InsuremoRoutesService as never);
    assert.ok(runtime);
    const children = [...runtime.fibers];
    assert.equal(children.length, 1);
    await assert.rejects(children[0]!.await(), /duplicate exact route/);
    if (rootError !== undefined) assert.match(String(rootError), /duplicate exact route/);
    t.diagnostic(`Loader root state=${rootFiber.state}, root reported error=${rootError !== undefined}; route child explicitly failed. Root ACTIVE is the current unawaited-child boundary, not a permanent correctness requirement or aggregate-wide success.`);
    for (const path of [overviewPath, healthPath, `${overviewPath}/actions/imo-upgrade`]) {
      assert.equal((await request(origin, path)).status, 404, `partial route remains: ${path}`);
    }
    assert.deepEqual(await request(origin, conflict), { status: 200, body: 'external-owner' });
    assert.deepEqual(await request(origin, '/compat-unrelated'), { status: 200, body: 'other-owner' });
    await rootFiber.dispose();
    assert.deepEqual(await request(origin, conflict), { status: 200, body: 'external-owner' });
    releaseExternal();
    releaseOther();
    fixtureSafety(calls);
  } finally { await ctx.fiber.dispose(); }
});

test('real HTTP write routes retain method, origin, header, body and response gates', async () => {
  const ctx = new Context();
  let directCalls = 0;
  ctx.provide('imoUpgrade', {
    upgradeStatus: () => ({ running: false }),
    executeDirect: async () => { directCalls++; return { ok: true, receipt: { status: 'completed', before: '1.0.0', after: '1.1.0' } }; },
  } as never);
  try {
    const origin = await startHttp(ctx);
    const fiber = ctx.plugin(InsuremoRoutesService as never, undefined as never);
    await fiber.await();
    const url = `${origin}${overviewPath}/actions/imo-upgrade`;
    const send = async (options: RequestInit = {}) => {
      const res = await fetch(url, { ...options, headers: { Connection: 'close', ...options.headers } });
      return { response: res, body: await res.json() as { ok: boolean; error?: { code: string }; result?: unknown } };
    };
    let result = await send();
    assert.equal(result.response.status, 405);
    assert.equal(result.body.error?.code, 'method-not-allowed');
    result = await send({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(result.response.status, 403);
    assert.equal(result.body.error?.code, 'origin-required');
    result = await send({ method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench-action': '1', origin: 'http://example.invalid' }, body: '{}' });
    assert.equal(result.response.status, 403);
    assert.equal(result.body.error?.code, 'origin-mismatch');
    result = await send({ method: 'POST', headers: { 'content-type': 'text/plain', 'x-workbench-action': '1' }, body: '{}' });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error?.code, 'content-type');
    result = await send({ method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench-action': '1' }, body: 'x'.repeat(9000) });
    assert.equal(result.response.status, 413);
    assert.equal(result.body.error?.code, 'body-too-large');
    assert.equal(directCalls, 0, 'security gate must precede the fixture service');
    result = await send({ method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench-action': '1' }, body: '{}' });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.ok, true);
    assert.deepEqual(result.body.result, { status: 'completed', currentVersion: '1.1.0', targetVersion: '1.1.0' });
    assert.equal(result.response.headers.get('cache-control'), 'no-store');
    assert.equal(result.response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(result.response.headers.get('access-control-allow-origin'), null);
    assert.equal(directCalls, 1, 'only the in-memory fake upgrade face may execute');
    await fiber.dispose();
    assert.equal((await request(origin, `${overviewPath}/actions/imo-upgrade`)).status, 404);
  } finally { await ctx.fiber.dispose(); }
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
    // Same-turn: this is the retained `internal/plugin` listener, not the
    // public effect teardown (the effect-only control below needs an await).
    assert.deepEqual(allTools(ctx), [], 'workbench listener releases its own tools in the same turn');
    for (const name of promptNames) {
      // A real duplicate check on the same turn also proves each prompt name
      // is released before awaiting the owner's dispose promise.
      const release = ctx.systemPrompt.section({ name, order: 150, text: 'isolated fixture' });
      release();
    }
    // No duplicate window for this owner: another owner may take a name now.
    const sameTurnReuse = ctx.tools.register(defineContentToolFixture({ name: 'ici_query', description: 'reuse probe', parameters: {}, async execute() { return []; } }));
    sameTurnReuse();
    await stopping;
    const afterSections = (await ctx.systemPrompt.assemble()).sections.map(section => section.name).filter(name => name.startsWith('tool:'));
    assert.deepEqual(afterSections, []);
    const again = ctx.plugin(IcomposerVerifyToolService);
    await again.await();
    assert.equal((again as unknown as { _error?: unknown })._error, undefined);
    assert.deepEqual(allTools(ctx), toolNames);
    await again.dispose();
    assert.deepEqual(allTools(ctx), []);
    // A second teardown of an already-released owner is a no-op.
    await again.dispose();
    assert.deepEqual(allTools(ctx), []);
    t.diagnostic('Real W tool service + H2 registries: 8 tools/7 prompts exactly once, same-turn release (retained internal listener), immediate name reuse, awaited remount; not an HMR test.');
  } finally { await ctx.fiber.dispose(); }
});

test('partial tool registration failure rolls back every acquired handle and stays loud', async (t) => {
  for (const conflict of ['tool:ici_query', 'ici_status'] as const) {
    const ctx = new Context();
    try {
      await ctx.plugin(SystemPrompt, {});
      await ctx.plugin(ToolRuntime, {});
      // A foreign owner already holds a name this registration needs.
      const releaseForeign = conflict.startsWith('tool:')
        ? ctx.systemPrompt.section({ name: conflict, order: 150, text: 'foreign section' })
        : ctx.tools.register(defineContentToolFixture({ name: conflict, description: 'foreign tool', parameters: {}, async execute() { return []; } }));
      const fiber = ctx.plugin(IcomposerVerifyToolService);
      const error: unknown = await fiber.await().then(() => undefined, caught => caught);
      assert.ok(error instanceof Error, `${conflict}: duplicate must fail loudly`);
      assert.match(error.message, /already registered/, `${conflict}: original error must stay visible`);
      assert.deepEqual(allTools(ctx), conflict.startsWith('tool:') ? [] : [conflict], `${conflict}: no leaked workbench tools`);
      const sections = (await ctx.systemPrompt.assemble()).sections.map(section => section.name).filter(name => name.startsWith('tool:'));
      assert.deepEqual(sections, conflict.startsWith('tool:') ? [conflict] : [], `${conflict}: no leaked prompt sections`);
      await fiber.dispose();
      // The foreign owner is untouched by the failed/rolled-back workbench owner.
      assert.deepEqual(allTools(ctx), conflict.startsWith('tool:') ? [] : [conflict]);
      assert.equal((await ctx.systemPrompt.assemble()).sections.filter(section => section.name === conflict).length, conflict.startsWith('tool:') ? 1 : 0);
      releaseForeign();
      t.diagnostic(`${conflict}: failure propagated, foreign registration preserved, all partial handles rolled back.`);
    } finally { await ctx.fiber.dispose(); }
  }
});

test('tool owner releases on dependency loss and re-registers exactly once on restore', async (t) => {
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt, {});
    const toolsFiber = ctx.plugin(ToolRuntime, {});
    await toolsFiber.await();
    const fiber = ctx.plugin(IcomposerVerifyToolService);
    await fiber.await();
    assert.equal((fiber as unknown as { _error?: unknown })._error, undefined);
    assert.deepEqual(allTools(ctx), toolNames);
    assert.equal((await ctx.systemPrompt.assemble()).sections.filter(section => section.name.startsWith('tool:')).length, promptNames.length);
    // The real tool service disappears: the owner must unload rather than
    // keep a stale generation, and its prompt sections must go with it.
    await toolsFiber.dispose();
    await waitFor('tool owner to unload without tools', () => ctx.get('icomposerVerifyTools') === undefined);
    assert.equal(ctx.get('tools'), undefined);
    assert.equal((await ctx.systemPrompt.assemble()).sections.filter(section => section.name.startsWith('tool:')).length, 0, 'prompts released with the owner');
    const restored = ctx.plugin(ToolRuntime, {});
    await restored.await();
    await waitFor('tool owner to re-register after tools return', () => Boolean(ctx.get('icomposerVerifyTools')));
    assert.deepEqual(allTools(ctx), toolNames, 'exactly one new generation, no duplicates');
    assert.equal((await ctx.systemPrompt.assemble()).sections.filter(section => section.name.startsWith('tool:')).length, promptNames.length);
    await fiber.dispose();
    await restored.dispose();
    assert.equal((await ctx.systemPrompt.assemble()).sections.filter(section => section.name.startsWith('tool:')).length, 0);
    t.diagnostic('Real ToolRuntime dependency withdrawal/restore: owner unloaded, prompts/tools removed, single re-registration; not HMR.');
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
