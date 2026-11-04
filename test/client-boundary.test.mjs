import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { analyzeClientSource, auditClientBundle, auditRepository, HEALTH_FILE, HEALTH_SHA256 } from "../scripts/audit-client-boundaries.mjs";

const root = resolve(import.meta.dirname, "..");
const fixtureFile = "packages/fixture/src/client/Probe.tsx";
const codes = text => analyzeClientSource(fixtureFile, text).issues.map(issue => issue.code);

test("real Client sources use only React values; the health file is the exact reviewed exception", () => {
  const report = auditRepository(root);
  const health = report.clients.filter(file => file.healthException);
  assert.equal(health.length, 1);
  assert.equal(health[0].file, HEALTH_FILE);
  assert.equal(health[0].hash, HEALTH_SHA256);
  assert.deepEqual(report.issues, []);
  assert.deepEqual(report.clients.flatMap(client => client.imports).filter(item => item.kind !== "type" && !item.module.startsWith(".")).map(item => item.module).filter((value, index, all) => all.indexOf(value) === index).sort(), ["react", "react-dom/client"]);
  assert.ok(report.manifests.some(item => item.clientInject.includes("@deepseek-ai/dsh-client-locale")));
  assert.ok(report.manifests.every(item => item.installation === "unverified"));
});

test("type-only imports/re-exports are not runtime values; Harness Client values are rejected", () => {
  assert.deepEqual(analyzeClientSource(fixtureFile, `
    import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
    import { type ReactNode } from "react";
    export type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
  `).issues, []);
  for (const source of [
    'import { Button } from "@deepseek-ai/dsh-client-ui-primitives";',
    'import { type PropsRuntime, Runtime } from "@deepseek-ai/dsh-client-ui-slots";',
    'export { Runtime } from "@deepseek-ai/dsh-client-ui-slots";',
    'const a = require("@deepseek-ai/dsh-client-ui-primitives");',
    'const a = import("@deepseek-ai/dsh-client-ui-primitives");',
  ]) assert.ok(codes(source).includes("CLIENT_HARNESS_VALUE_IMPORT"), source);
  assert.ok(codes("const x = require(someRuntimeValue);").includes("DYNAMIC_MODULE_UNRESOLVED"));
});

test("react-dom/client is limited to the exact reviewed health file, not its package or a copied file", () => {
  const real = readFileSync(resolve(root, HEALTH_FILE), "utf8");
  assert.equal(analyzeClientSource(HEALTH_FILE, real).healthException, true);
  assert.deepEqual(analyzeClientSource(HEALTH_FILE, real).issues, []);
  const changed = analyzeClientSource(HEALTH_FILE, `${real}\n`);
  assert.ok(changed.issues.some(issue => issue.code === "HEALTH_EXCEPTION_CHANGED"));
  const copied = analyzeClientSource(fixtureFile, real);
  assert.ok(copied.issues.some(issue => issue.code === "REACT_RUNTIME_NOT_ALLOWED"));
  assert.ok(codes('import { createPortal } from "react-dom";').includes("REACT_RUNTIME_NOT_ALLOWED"));
});

test("emitted module references stay in the React table and react-dom only in the status bundle", () => {
  const ok = auditClientBundle('const a = require("react"); const b = require("react/jsx-runtime");', resolve(root, "packages/ui-workbench-jobs/lib/client.js"));
  assert.deepEqual(ok.issues, []);
  const health = auditClientBundle('const a = require("react-dom/client");', resolve(root, "packages/ui-insuremo-status/lib/client.js"));
  assert.deepEqual(health.issues, []);
  assert.ok(auditClientBundle('const a = require("react-dom/client");', resolve(root, "packages/ui-workbench-jobs/lib/client.js")).issues.some(issue => issue.code === "BUNDLE_REACT_DOM_OUTSIDE_HEALTH"));
  assert.ok(auditClientBundle('const a = require("@deepseek-ai/dsh-client-ui-primitives");', resolve(root, "packages/ui-workbench-jobs/lib/client.js")).issues.some(issue => issue.code === "CLIENT_HARNESS_VALUE_IMPORT"));
  assert.ok(auditClientBundle('const a = require(name);', resolve(root, "packages/ui-workbench-jobs/lib/client.js")).issues.some(issue => issue.code === "BUNDLE_DYNAMIC_MODULE_UNRESOLVED"));
});

test("bundle relative references are rejected; source relative imports remain allowed", () => {
  const bundleFile = resolve(root, "packages/ui-insuremo-status/lib/client.js");
  for (const [label, code] of [
    ["require", 'const a = require("./evil.js");'],
    ["dynamic import", 'const a = import("./evil.js");'],
    ["parent require", 'const a = require("../evil.js");'],
  ]) {
    const result = auditClientBundle(code, bundleFile);
    assert.ok(result.issues.some(issue => issue.code === "BUNDLE_VALUE_MODULE_UNPROVEN"), label);
  }
  assert.deepEqual(analyzeClientSource(fixtureFile, 'import { helper } from "./helper.ts";').issues, []);
  assert.deepEqual(analyzeClientSource(fixtureFile, 'const helper = require("./helper.ts");').issues, []);
});
