import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pickNativeFile, type NativeCommandRunner } from "../src/native-picker.ts";
import { normalizeNativePickedTarget } from "../src/explain-routes.ts";

function failure(code: string | number, stderr = ""): Error { return Object.assign(new Error(`picker command failed: ${String(code)}`), { code, stderr }); }
function signal(): AbortSignal { return new AbortController().signal; }

test("TASK-055 macOS file picker uses argv-only osascript and maps cancel", async () => {
  let command = ""; let args: readonly string[] = [];
  const run: NativeCommandRunner = async (nextCommand, nextArgs) => { command = nextCommand; args = nextArgs; return { stdout: "/tmp/workspace/ref_doc/guide.md\n", stderr: "" }; };
  assert.equal(await pickNativeFile(signal(), { platform: "darwin", run }), "/tmp/workspace/ref_doc/guide.md");
  assert.equal(command, "osascript"); assert.ok(args.includes("POSIX path of selectedFile")); assert.ok(args.every(arg => !arg.includes("sh -c") && !arg.includes("|")));
  const rooted: NativeCommandRunner = async (_command, nextArgs) => { assert.ok(nextArgs.some(arg => arg.includes("default location POSIX file \"/tmp/workspace\""))); return { stdout: "", stderr: "" }; }; await pickNativeFile(signal(), { platform: "darwin", run: rooted, defaultDirectory: "/tmp/workspace" });
  const cancelled: NativeCommandRunner = async () => { throw failure(1, "execution error: User canceled. (-128)"); };
  assert.equal(await pickNativeFile(signal(), { platform: "darwin", run: cancelled }), null);
});

test("TASK-055 Linux file picker uses zenity then kdialog without a shell", async () => {
  const calls: string[] = []; const run: NativeCommandRunner = async (command) => { calls.push(command); if (command === "zenity") throw failure("ENOENT"); return { stdout: "/tmp/workspace/ref_doc/guide.md\r\n", stderr: "" }; };
  assert.equal(await pickNativeFile(signal(), { platform: "linux", run }), "/tmp/workspace/ref_doc/guide.md"); assert.deepEqual(calls, ["zenity", "kdialog"]);
});

test("TASK-055 native picker propagates caller abort and reports unsupported platforms", async () => {
  const abort = new AbortController(); abort.abort(new Error("closed")); const run: NativeCommandRunner = async (_command, _args, received) => { assert.equal(received, abort.signal); throw received.reason; };
  await assert.rejects(() => pickNativeFile(abort.signal, { platform: "darwin", run }), /closed/);
  await assert.rejects(() => pickNativeFile(signal(), { platform: "win32", run }), /unsupported/);
});

async function workspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), "task055-picker-")); const outside = await mkdtemp(join(tmpdir(), "task055-outside-")); await mkdir(join(root, "ref_doc", "nested"), { recursive: true });
  await writeFile(join(root, "ref_doc", "guide.md"), "guide\n"); await writeFile(join(root, "ref_doc", "nested", "notes.txt"), "notes\n"); await writeFile(join(root, "ref_doc", "bad.bin"), "binary\n"); await writeFile(join(outside, "secret.md"), "secret\n");
  return { root, outside, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); } };
}

test("TASK-055 native selections become relative file and directory targets", async () => {
  const fx = await workspaceFixture(); try {
    assert.deepEqual(await normalizeNativePickedTarget(fx.root, join(fx.root, "ref_doc", "guide.md"), "file"), { path: "ref_doc/guide.md", kind: "file" });
    assert.deepEqual(await normalizeNativePickedTarget(fx.root, join(fx.root, "ref_doc", "nested"), "directory"), { path: "ref_doc/nested", kind: "directory" });
    assert.deepEqual(await normalizeNativePickedTarget(fx.root, fx.root, "directory"), { path: "", kind: "directory" });
  } finally { await fx.cleanup(); }
});

test("TASK-055 native selection containment rejects outside, symlink, and unsupported targets", async () => {
  const fx = await workspaceFixture(); try {
    await assert.rejects(() => normalizeNativePickedTarget(fx.root, join(fx.outside, "secret.md"), "file"), /reference-outside-workspace/);
    await assert.rejects(() => normalizeNativePickedTarget(fx.root, `${fx.root}/ref_doc/../ref_doc/guide.md`, "file"), /reference-outside-workspace/);
    await symlink(join(fx.root, "outside"), join(fx.root, "ref_doc", "escape"));
    await assert.rejects(() => normalizeNativePickedTarget(fx.root, join(fx.root, "ref_doc", "escape", "secret.md"), "file"), /reference-symlink/);
    await assert.rejects(() => normalizeNativePickedTarget(fx.root, join(fx.root, "ref_doc", "bad.bin"), "file"), /reference-unsupported/);
    await assert.rejects(() => normalizeNativePickedTarget(fx.root, join(fx.root, "ref_doc", "guide.md"), "directory"), /reference-unsupported/);
  } finally { await fx.cleanup(); }
});
