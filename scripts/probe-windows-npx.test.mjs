import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_SHIM_BYTES,
  containsCanonicalWindows,
  isNodeExecutable,
  parseNpmNpxShim,
  parsePrefixOutput,
} from "./probe-windows-npx.mjs";

const MODERN_NPX_SHIM = [
  ":: Created by npm, please don't edit manually.",
  "@ECHO OFF",
  "",
  "SETLOCAL",
  "",
  "SET \"NODE_EXE=%~dp0\\node.exe\"",
  "IF NOT EXIST \"%NODE_EXE%\" (",
  "  SET \"NODE_EXE=node\"",
  ")",
  "",
  "SET \"NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js\"",
  "SET \"NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js\"",
  "FOR /F \"delims=\" %%F IN ('CALL \"%NODE_EXE%\" \"%NPM_PREFIX_JS%\"') DO (",
  "  SET \"NPM_PREFIX_NPX_CLI_JS=%%F\\node_modules\\npm\\bin\\npx-cli.js\"",
  ")",
  "IF EXIST \"%NPM_PREFIX_NPX_CLI_JS%\" (",
  "  SET \"NPX_CLI_JS=%NPM_PREFIX_NPX_CLI_JS%\"",
  ")",
  "",
  "\"%NODE_EXE%\" \"%NPX_CLI_JS%\" %*",
].join("\r\n");

const LEGACY_NPX_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "IF EXIST \"%dp0%\\node.exe\" (",
  "  SET \"_prog=%dp0%\\node.exe\"",
  ") ELSE (",
  "  SET \"_prog=node\"",
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\" \"%dp0%\\node_modules\\npm\\bin\\npx-cli.js\" %*",
].join("\r\n");

test("standalone probe mirrors the two accepted npm shim forms and rejects wrappers", () => {
  assert.equal(parseNpmNpxShim(MODERN_NPX_SHIM), "modern");
  assert.equal(parseNpmNpxShim(LEGACY_NPX_SHIM), "legacy");
  assert.equal(parseNpmNpxShim(`${MODERN_NPX_SHIM}\r\necho C:\\attacker`), undefined);
  assert.equal(parseNpmNpxShim("x".repeat(MAX_SHIM_BYTES + 1)), undefined);
});

test("standalone probe accepts only one clean absolute prefix line", () => {
  assert.equal(parsePrefixOutput("C:\\Program Files\\npm\r\n"), "C:\\Program Files\\npm");
  assert.equal(parsePrefixOutput("C:\\one\r\nC:\\two\r\n"), undefined);
  assert.equal(parsePrefixOutput("\r\nC:\\leading-blank\r\n"), undefined);
  assert.equal(parsePrefixOutput("C:\\repeated-blank\r\n\r\n"), undefined);
  assert.equal(parsePrefixOutput(" C:\\leading-space"), undefined);
  assert.equal(parsePrefixOutput("C:\\trailing-space "), undefined);
  assert.equal(parsePrefixOutput("C:\\bad\u0001path"), undefined);
  assert.equal(parsePrefixOutput("C:\\bad\u0085path"), undefined);
  assert.equal(parsePrefixOutput("relative-prefix"), undefined);
});

test("standalone probe requires node.exe and canonical containment", () => {
  const root = "C:\\Program Files\\nodejs";
  assert.equal(isNodeExecutable("C:\\Program Files\\nodejs\\node.exe"), true);
  assert.equal(isNodeExecutable("C:\\Program Files\\nodejs\\node.cmd"), false);
  assert.equal(isNodeExecutable("C:\\Program Files\\nodejs\\node"), false);
  assert.equal(containsCanonicalWindows(root, `${root}\\node_modules\\npm\\bin\\npx-cli.js`), true);
  assert.equal(containsCanonicalWindows(root, `${root}\\NODE_MODULES\\npm\\bin\\NPX-CLI.JS`), true);
  assert.equal(containsCanonicalWindows(root, `${root}\\..\\evil\\npx-cli.js`), false);
  assert.equal(containsCanonicalWindows(root, root), false);
  assert.equal(containsCanonicalWindows(root, "C:\\Program Files\\nodejs-evil\\npx-cli.js"), false);
});
