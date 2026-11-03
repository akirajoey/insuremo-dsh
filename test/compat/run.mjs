#!/usr/bin/env node
// TASK-162: H2 source-runtime baseline only. Never installs or builds either checkout.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const harness = resolve(root, '../deepseek-harness');
const expectedH2 = '687f282e8625c6b8d11ff58211a90524be2e4317';
const requireFromVerify = createRequire(join(root, 'packages/icomposer-verify/package.json'));

function git(...args) {
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', harness, ...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Cannot verify the H2 checkout with git ${args.join(' ')}: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function main() {
  const head = git('rev-parse', 'HEAD');
  if (head !== expectedH2) throw new Error(`H2 checkout must be ${expectedH2}; got ${head}`);
  // Tracked H2 changes would make these source-runtime observations ambiguous.
  if (git('status', '--porcelain', '--untracked-files=no') !== '') {
    throw new Error('H2 has tracked changes; use the clean pinned source checkout.');
  }

  const tmpParent = await realpath('/tmp');
  const tmp = await mkdtemp(join(tmpParent, 'workbench-compat-'));
  try {
    const home = join(tmp, 'home');
    const dshHome = join(tmp, 'dsh-home');
    const scratch = join(tmp, 'tmp');
    for (const dir of [home, dshHome, scratch]) await mkdir(dir);

    // Retain the repo's source aliases, but make them absolute for a tsconfig
    // in /tmp. Additional aliases expose the real loader/webserver and repair
    // *test-time source resolution* of missing/stale H2 libs; they do not install packages, build lib,
    // replace real implementations with shims, or validate published d.ts.
    const config = JSON.parse(await readFile(join(root, 'tsconfig.base.json'), 'utf8'));
    for (const [name, targets] of Object.entries(config.compilerOptions.paths)) {
      config.compilerOptions.paths[name] = targets.map(target => resolve(root, target));
    }
    Object.assign(config.compilerOptions.paths, {
      '@deepseek-ai/cordis-plugin-loader': [join(harness, 'vendor/loader/src/index.ts')],
      '@deepseek-ai/dsh-host-webserver': [join(harness, 'packages/host/webserver/src/index.ts')],
      '@deepseek-ai/dsh-util-values': [join(harness, 'packages/util/values/src/index.ts')],
      '@deepseek-ai/dsh-util-crypto': [join(harness, 'packages/util/crypto/src/index.ts')],
      '@deepseek-ai/dsh-brand': [join(harness, 'packages/util/brand/src/index.ts')],
      '@deepseek-ai/dsh-typert-protocol': [join(harness, 'packages/typert/protocol/src/index.ts')],
      '@deepseek-ai/dsh-sandbox': [join(harness, 'packages/sandbox/sandbox/src/index.ts')],
    });
    config.compilerOptions.baseUrl = root;
    const tsconfig = join(tmp, 'tsconfig.json');
    await writeFile(tsconfig, `${JSON.stringify(config, null, 2)}\n`);

    const tsx = pathToFileURL(requireFromVerify.resolve('tsx')).href;
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: home,
      USERPROFILE: home,
      DSH_HOME: dshHome,
      TMPDIR: scratch,
      TSX_TSCONFIG_PATH: tsconfig,
      COMPAT_TEST_ROOT: root,
      COMPAT_H2_ROOT: harness,
      COMPAT_ISOLATED_ROOT: tmp,
      CI: '1',
      LANG: 'C.UTF-8',
      TZ: 'UTC',
    };
    console.log(`H2 source checkout: ${harness} @ ${head} (tracked files clean)`);
    console.log('Isolation: new /tmp HOME, USERPROFILE, DSH_HOME and TMPDIR; fixture subprocess and storage.');
    console.log('Aliases are runtime source mappings, not published declaration/type-contract validation.');
    const child = spawnSync(process.execPath, [
      '--import', tsx, '--test', '--test-concurrency=1', join(root, 'test/compat/baseline.test.ts'),
    ], { cwd: root, env, stdio: 'inherit' });
    if (child.error) throw child.error;
    if (child.signal) throw new Error(`Baseline test terminated by ${child.signal}`);
    if (child.status !== 0) process.exitCode = child.status ?? 1;
  } finally {
    // Only this mkdtemp-created directory is deleted; no checkout or user path.
    await rm(tmp, { recursive: true, force: true });
    console.log('Removed the isolated /tmp test directory.');
  }
}

main().catch(error => {
  console.error(`compat baseline failed: ${error.message}`);
  process.exitCode = 1;
});
