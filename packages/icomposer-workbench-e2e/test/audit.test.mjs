import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const promisified = (command, args, options = {}) => new Promise((resolvePromise) => {
  execFile(command, args, { encoding: "utf8", ...options }, (error, stdout, stderr) => {
    resolvePromise({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr });
  });
});

test("audit-secrets: passes on the real repository (read-only, no findings)", async () => {
  const result = await promisified("node", [join(repoRoot, "scripts", "audit-secrets.mjs")]);
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /secrets audit PASSED/);
});

test("audit-secrets: detects planted tokens and foreign home paths, exits non-zero", async () => {
  const dirty = await mkdtemp(join(tmpdir(), "audit-dirty-"));
  try {
    await mkdir(join(dirty, "src"), { recursive: true });
    // JWT-shaped token (assembled at runtime so this source file itself
    // stays clean) + a non-allowlisted absolute home path
    const plantedJwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N65IWyYqdiXfQIDAQAB"].join(".");
    await writeFile(join(dirty, "src", "leak.ts"), [
      `const token = "${plantedJwt}";`,
      `const legacy = "${join(homedir(), "notallowlisted", "secret")}";`,
      "",
    ].join("\n"), "utf8");
    const result = await promisified("node", [join(repoRoot, "scripts", "audit-secrets.mjs"), dirty]);
    assert.notEqual(result.code, 0, "planted secrets were not detected");
    const combined = result.stdout + result.stderr;
    assert.match(combined, /jwt/);
    assert.match(combined, /home-path/);
  } finally {
    await rm(dirty, { recursive: true, force: true });
  }
});

test("audit-secrets: sha256 digests and allowed fake tokens are not flagged", async () => {
  const clean = await mkdtemp(join(tmpdir(), "audit-clean-"));
  try {
    await mkdir(join(clean, "src"), { recursive: true });
    await writeFile(join(clean, "src", "fine.ts"), [
      "const digest = \"sha256:0f933dcdbd4f785f25f0cbcffc02e17d5a881ebfbf5c8e42b42fb481dacde3b8\";",
      "",
    ].join("\n"), "utf8");
    await mkdir(join(clean, "test"), { recursive: true });
    await writeFile(join(clean, "test", "spec.ts"), "const token = \"sekret-token\"; // deliberate fixture\nconst other = \"e2e-fake-token\";\n", "utf8");
    const result = await promisified("node", [join(repoRoot, "scripts", "audit-secrets.mjs"), clean]);
    assert.equal(result.code, 0, `expected clean exit 0: ${result.stdout}${result.stderr}`);
  } finally {
    await rm(clean, { recursive: true, force: true });
  }
});

test("audit-compat: passes on the real repository and writes the snapshot", async () => {
  const result = await promisified("node", [join(repoRoot, "scripts", "audit-compat.mjs")]);
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /compat audit PASSED/);
  const { readFileSync } = await import("node:fs");
  const snapshot = readFileSync(join(repoRoot, "docs", "compat-audit.json"), "utf8");
  const parsed = JSON.parse(snapshot);
  assert.equal(parsed.harnessCommit, "99f6f02fecdb7dff40c3fbc9470f5907c29f74ca");
  assert.equal(parsed.harnessClean, true);
  assert.equal(parsed.pluginCount, 14);
  assert.equal(parsed.checks.every(check => check.ok), true);
});
