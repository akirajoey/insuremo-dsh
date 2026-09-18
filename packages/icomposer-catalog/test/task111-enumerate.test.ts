import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { enumerateSources, listSourceGroups } from "../src/enumerate.ts";
import { scanWorkspace } from "../src/scan.ts";

async function api(root: string, tenant: string, group: string, name: string): Promise<void> {
  const dir = join(root, "src", "dev", tenant, group, "api", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.groovy`), `class ${name} { def run() { 1 } }\n`);
}

/**
 * TASK-111 safety parity: the task-facing enumeration must obey the exact rules
 * the summary scan and the graph builder use for the same tree — tenant/group
 * layout, regular non-symlink files, and real-path containment from every level —
 * so "no count cap" never turns into "walked something the workspace does not own".
 */
test("TASK-111 complete enumeration keeps layout, symlink, and containment rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "task111-enumerate-rules-"));
  const outside = await mkdtemp(join(tmpdir(), "task111-outside-"));
  try {
    await api(root, "acme", "Payments", "Alpha");
    await api(root, "acme", "Payments", "Beta");
    await api(root, "acme", "Billing", "Gamma");
    // A tenant-level symlink to a tree outside the workspace must never be walked.
    await writeFile(join(outside, "Escape.groovy"), "class Escape {}\n");
    await mkdir(join(outside, "api", "Escape"), { recursive: true });
    await symlink(outside, join(root, "src", "dev", "linked-tenant"));
    // A symlinked leaf file must be rejected even though its name matches the layout.
    const leafDir = join(root, "src", "dev", "acme", "Billing", "api", "Linked");
    await mkdir(leafDir, { recursive: true });
    await symlink(join(root, "src", "dev", "acme", "Billing", "api", "Gamma", "Gamma.groovy"), join(leafDir, "Linked.groovy"));

    const discovered: string[] = [];
    for await (const item of enumerateSources(root)) discovered.push(`${item.tenant}/${item.group}/${item.name}`);
    assert.deepEqual(discovered, ["acme/Billing/Gamma", "acme/Payments/Alpha", "acme/Payments/Beta"]);
    assert.deepEqual(await listSourceGroups(root), [{ tenant: "acme", group: "Billing" }, { tenant: "acme", group: "Payments" }]);

    // Rule parity with the summary scan on the same tree. Layout and containment are
    // identical (neither walks the escaping tenant, neither is capped here); the ONE
    // deliberate difference is an internal symlinked leaf: the summary scan resolves
    // it, while the task enumeration rejects it — the strict rule the prepare/source
    // layer enforces (`explain-artifacts.containedFile` rejects symlinks), so a task
    // never prepares a source through a link.
    const scan = await scanWorkspace(root, "api");
    const scanned = scan.entries.filter(entry => entry.type === "api").map(entry => entry.name).sort();
    assert.deepEqual(scanned, ["Alpha", "Beta", "Gamma", "Linked"]);
    assert.deepEqual(discovered.map(item => item.split("/")[2]).sort(), ["Alpha", "Beta", "Gamma"]);
    assert.equal(scan.truncated, false);
    assert.equal(scanned.includes("Escape"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
