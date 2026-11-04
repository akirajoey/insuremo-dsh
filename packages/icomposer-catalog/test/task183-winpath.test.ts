import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { test } from "node:test";
import { isContainedWith as catalogContained } from "../src/scan.ts";
import { isContainedWith as referenceContained } from "../../icomposer-reference/src/scan.ts";
import { isContainedWith as lifecycleContained } from "../../icomposer-lifecycle/src/join.ts";
import { isContainedWith as graphContained } from "../../icomposer-code-intelligence/src/graph.ts";
import { isContainedWith as writeContained } from "../../icomposer-write/src/join-check.ts";

/**
 * TASK-183: the five production containment checks share this exact seam.
 * `win32` is used explicitly because the host `path.relative` on macOS cannot
 * model Windows separators; this is an algorithm test, not Windows E2E.
 */
const implementations = [
  ["catalog", catalogContained],
  ["reference", referenceContained],
  ["lifecycle", lifecycleContained],
  ["graph", graphContained],
  ["write", writeContained],
] as const;

const winCases: ReadonlyArray<readonly [string, string, string, boolean]> = [
  ["child", "D:\\ws\\.metadata\\api\\a.json", "D:\\ws", true],
  ["root itself", "D:\\ws", "D:\\ws", true],
  ["root trailing slash", "D:\\ws\\a", "D:\\ws\\", true],
  ["root drive", "D:\\ws\\a", "D:\\", true],
  ["sibling prefix", "D:\\ws2\\a", "D:\\ws", false],
  ["parent escape", "D:\\ws\\..\\evil", "D:\\ws", false],
  ["cross drive", "C:\\ws\\a", "D:\\ws", false],
  ["UNC child", "\\\\server\\share\\ws\\a", "\\\\server\\share\\ws", true],
  ["UNC root itself", "\\\\server\\share\\ws", "\\\\server\\share\\ws", true],
  ["UNC sibling share", "\\\\server\\share2\\a", "\\\\server\\share\\ws", false],
  ["case variant", "d:\\WS\\a", "D:\\ws", true],
  ["literal dotdot filename", "D:\\ws\\..evil", "D:\\ws", true],
];

const posixCases: ReadonlyArray<readonly [string, string, string, boolean]> = [
  ["child", "/ws/a", "/ws", true],
  ["root itself", "/ws", "/ws", true],
  ["root trailing slash", "/ws/a", "/ws/", true],
  ["sibling prefix", "/ws2/a", "/ws", false],
  ["parent escape", "/ws/../evil", "/ws", false],
  ["case-sensitive sibling", "/WS/a", "/ws", false],
  ["backslash filename stays inside", "/ws/..\\evil", "/ws", true],
];

test("TASK-183 all five containment checks accept Win32 children and reject escapes", () => {
  for (const [name, contained] of implementations) {
    for (const [label, real, root, expected] of winCases) {
      assert.equal(contained(win32, real, root), expected, `${name}: ${label}`);
    }
  }
});

test("TASK-183 all five containment checks keep POSIX case and backslash semantics", () => {
  for (const [name, contained] of implementations) {
    for (const [label, real, root, expected] of posixCases) {
      assert.equal(contained(posix, real, root), expected, `${name}: ${label}`);
    }
  }
});
