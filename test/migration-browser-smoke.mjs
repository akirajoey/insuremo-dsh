#!/usr/bin/env node
// Opt-in: connect to an ALREADY started isolated server. Never starts a service.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "../../deepseek-harness/node_modules/playwright-core/index.mjs";

const root = resolve(import.meta.dirname, "..");
const home = resolve(process.env.DSH_HOME || resolve(root, ".dsh-home/migration"));
assert.ok(home.startsWith(`${resolve(root, "..")}/`), "DSH_HOME must be inside the isolated upgrade workspace");
const url = new URL(process.env.DSH_SMOKE_URL || "");
assert.equal(url.hostname, "127.0.0.1");
assert.ok(url.port && !["80", "443"].includes(url.port));
const output = resolve(root, ".migration-logs");
await mkdir(output, { recursive: true });
await mkdir(resolve(home, "install-diagnostics"), { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
const scopedRequests = [];
page.on("request", req => { if (req.url().includes("/insuremo/overview?") && req.url().includes("workspaceId=")) scopedRequests.push(req.url()); });
const prefix = "/api/icomposer-workbench/insuremo/overview";
const evidence = [];
try {
  await page.goto(url.href);
  await page.waitForTimeout(1500);
  for (let i = 0; i < 2; i++) {
    const next = page.getByRole("button", { name: "Continue", exact: true });
    const close = page.getByRole("button", { name: "Close", exact: true });
    if (await next.isVisible()) await next.click();
    else if (await close.isVisible()) await close.click();
    await page.waitForTimeout(300);
  }
  const overview = await page.evaluate(async path => { const r = await fetch(`${path}?fast=0`); return { status: r.status, body: await r.json() }; }, prefix);
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.body.auth.profiles.map(row => row.name).sort(), ["migration-other", "migration-test"]);
  evidence.push("Latest dsh boot/client activation + real HTTP overview with fixture-only profiles: 200");
  const asset = await page.request.get(new URL("/api/icomposer-workbench/ui/assets/insuremo-globe.png", url).href);
  assert.equal(asset.status(), 200);
  assert.deepEqual((await asset.body()).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  evidence.push("Owned raster asset route: 200, PNG signature valid");

  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.getByRole("menuitem", { name: /Settings/ }).click();
  await page.getByRole("button", { name: "InsureMO", exact: true }).click();
  await page.getByRole("button", { name: /Expand: InsureMO/ }).waitFor();
  evidence.push("Settings > InsureMO independent section reachable");

  // Simulate ONLY a failed installer (never execute npm/global installation).
  // Navigation, workspace/session creation and input prefill remain the real latest dsh.
  await page.route(`**${prefix}?*`, route => route.fulfill({ json: { ...overview.body, imo: { ...overview.body.imo, status: "error", code: "not-found", available: false, updateAvailable: false } } }));
  await page.route(`**${prefix}/actions/imo-install`, route => route.fulfill({ json: { ok: false, error: { code: "install-failed", message: "Test-only install failure" } } }));
  await page.route(`**${prefix}/actions/imo-diagnosis`, route => route.fulfill({ json: { ok: true, result: {
    available: true, diagnosisCwd: resolve(home, "install-diagnostics"), diagnosis: {
      kind: "imo-cli", operation: "imo-install", commands: ["fixture-only-command"], exitCode: 1,
      stdout: "migration-smoke-marker", stderr: "fixture failure", stdoutTruncated: false, stderrTruncated: false,
      nodeVersion: process.version, platform: process.platform, arch: process.arch, occurredAt: new Date().toISOString(),
    },
  } } }));
  await page.getByRole("button", { name: /Expand: InsureMO/ }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Install IMO CLI", exact: true }).click();
  await page.getByRole("button", { name: /Diagnose/ }).click();
  await page.waitForTimeout(1500);
  const draft = await page.locator('[contenteditable="true"]').allTextContents();
  assert.ok(draft.some(text => text.includes("migration-smoke-marker")), `Diagnosis draft missing: ${JSON.stringify(draft)}`);
  await page.unroute(`**${prefix}?*`);
  await page.waitForTimeout(500);
  assert.ok(scopedRequests.length > 0, "Main-view selection did not produce workspace-scoped profile reads");
  evidence.push("Simulated installer failure -> real uiWorkspace connect/open -> session kit draft prefill (not sent)");
  evidence.push("Current mainView session causes workspace-scoped profile HTTP reads");
  const workspaceId = new URL(scopedRequests.at(-1)).searchParams.get("workspaceId");
  const selection = await page.evaluate(async ({ prefix, workspaceId }) => {
    const r = await fetch(`${prefix}/actions/active-profile`, { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Action": "1" }, body: JSON.stringify({ profile: "migration-other", workspaceId }) });
    return { status: r.status, body: await r.json() };
  }, { prefix, workspaceId });
  assert.equal(selection.status, 200);
  assert.equal(selection.body.ok, true);
  const scoped = await page.evaluate(async ({ prefix, workspaceId }) => {
    const r = await fetch(`${prefix}?fast=1&workspaceId=${workspaceId}`); return await r.json();
  }, { prefix, workspaceId });
  assert.equal(scoped.auth.activeProfileName, "migration-other");
  evidence.push("Real workspace-scoped Active Profile POST + persisted overview readback: migration-other");

  assert.deepEqual(errors, []);
  await page.screenshot({ path: resolve(output, "migration-browser.png") });
  await writeFile(resolve(output, "migration-smoke.json"), `${JSON.stringify({ runtime: "0.2.1-rc.2", home, origin: url.origin, evidence, browserErrors: errors }, null, 2)}\n`);
  console.log(JSON.stringify({ evidence, browserErrors: errors }, null, 2));
} finally { await browser.close(); }
