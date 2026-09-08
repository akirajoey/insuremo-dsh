import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectSkillDocument } from "../src/skill-document.ts";
import { InsuremoSkillProvider } from "../src/skill-provider.ts";
import { expectOk, makeFakeIo, skillsFixture } from "./support/fake-subprocess.ts";

async function skillRoot(root: string, name: string, content: string): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), content);
  return directory;
}

test("skills list defaults to project scope and returns a digest-only inventory", async () => {
  const io = makeFakeIo({ skillsListJson: "[]" });
  const fx = await skillsFixture(io);
  try {
    const value = await expectOk(await fx.skills.list());
    assert.equal(value.scope, "project");
    assert.deepEqual(value.skills, []);
    assert.match(value.stdoutDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal("stdout" in value, false);
    assert.deepEqual(io.invocations[0], ["skills", "list", "--json"]);
  } finally {
    await fx.dispose();
  }
});

test("skills list parses global entries without changing reported paths", async () => {
  const io = makeFakeIo({ skillsListJson: JSON.stringify([
    { name: "alpha", description: "Alpha skill", path: "./.agents/skills/alpha" },
    { name: "beta", description: "Beta skill", path: "/tmp/beta" },
  ]) });
  const fx = await skillsFixture(io);
  try {
    const value = await expectOk(await fx.skills.list("global"));
    assert.equal(value.scope, "global");
    assert.deepEqual(value.skills, [
      { name: "alpha", description: "Alpha skill", path: "./.agents/skills/alpha" },
      { name: "beta", description: "Beta skill", path: "/tmp/beta" },
    ]);
    assert.deepEqual(io.invocations[0], ["skills", "list", "--json", "-g"]);
  } finally {
    await fx.dispose();
  }
});

test("skills list returns parse-error and a digest for malformed JSON", async () => {
  const io = makeFakeIo({ skillsListJson: "not-json" });
  const fx = await skillsFixture(io);
  try {
    const result = await fx.skills.list("global");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "parse-error");
      assert.match(result.error.stdoutDigest ?? "", /^sha256:[0-9a-f]{64}$/);
      assert.equal("raw" in result.error, false);
    }
  } finally {
    await fx.dispose();
  }
});

test("skills configPath returns a missing path without throwing, then detects a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-skills-config-"));
  const config = join(root, "skills-config.json");
  const io = makeFakeIo({ skillsConfigPath: config });
  const fx = await skillsFixture(io);
  try {
    const missing = await expectOk(await fx.skills.configPath());
    assert.deepEqual(missing, { path: config, exists: false });
    await writeFile(config, "{}");
    const present = await expectOk(await fx.skills.configPath());
    assert.deepEqual(present, { path: config, exists: true });
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("skills validate marks a healthy inventory complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-skills-valid-"));
  const skill = join(root, "alpha");
  await mkdir(skill);
  await writeFile(join(skill, "SKILL.md"), "---\ntitle: Alpha\n---\n# Alpha\n");
  const io = makeFakeIo({ skillsListJson: JSON.stringify([
    { name: "alpha", description: "Alpha", path: skill },
  ]) });
  const fx = await skillsFixture(io, {}, root);
  try {
    const value = await expectOk(await fx.skills.validate("global"));
    assert.equal(value.inventoryComplete, true);
    assert.deepEqual(value.items, [{ name: "alpha", description: "Alpha", path: await realpath(skill), valid: true, reasons: [] }]);
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("skills validate keeps damaged rows and marks inventory incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-skills-damaged-"));
  const good = join(root, "good");
  const bad = join(root, "bad");
  await mkdir(good);
  await mkdir(bad);
  await writeFile(join(good, "SKILL.md"), "# Good\n");
  const io = makeFakeIo({ skillsListJson: JSON.stringify([
    { name: "good", description: "Good", path: good },
    { name: "bad", description: "Bad", path: bad },
    { name: "missing", description: "Missing", path: join(root, "missing") },
  ]) });
  const fx = await skillsFixture(io, {}, root);
  try {
    const value = await expectOk(await fx.skills.validate());
    assert.equal(value.inventoryComplete, false);
    assert.equal(value.items.find((item) => item.name === "good")?.valid, true);
    assert.deepEqual(value.items.find((item) => item.name === "bad")?.reasons, ["missing-skill-md"]);
    assert.deepEqual(value.items.find((item) => item.name === "missing")?.reasons, ["missing-directory"]);
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("skills validate and provider share canonical format decisions while retaining safe fallbacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-skills-format-diagnostics-"));
  const valid = await skillRoot(root, "valid", "# Valid body\n");
  const multiline = await skillRoot(root, "multiline", "---\ndescription: |\n  first line\n  second line\n---\n# Multiline\n");
  const fallback = await skillRoot(root, "fallback", "---\ntitle: 42\nwhenToUse: 42\nunknown: [one, two]\n---\n# Fallback\n");
  const yamlBroken = await skillRoot(root, "yaml-broken", "---\ntitle: [unterminated\n---\n# Broken\n");
  const fieldBroken = await skillRoot(root, "field-broken", "---\ndescription: [not a string]\n---\n# Broken field\n");
  const unclosed = await skillRoot(root, "unclosed", "---\ntitle: Unclosed\n# Body\n");
  const io = makeFakeIo({ skillsListJson: JSON.stringify([
    { name: "valid", description: "Valid", path: valid },
    { name: "multiline", description: "CLI multiline", path: multiline },
    { name: "fallback", description: "Fallback", path: fallback },
    { name: "yaml-broken", description: "Broken YAML", path: yamlBroken },
    { name: "field-broken", description: "Broken field", path: fieldBroken },
    { name: "unclosed", description: "Unclosed", path: unclosed },
    { name: "missing", description: "Missing", path: join(root, "missing") },
  ]) });
  const fx = await skillsFixture(io, {}, root);
  const controller = new AbortController();
  try {
    const multilineInspection = await inspectSkillDocument(join(multiline, "SKILL.md"));
    assert.equal(multilineInspection.invalid, false);
    assert.equal(multilineInspection.frontmatter?.description, "first line\nsecond line\n");
    const fallbackInspection = await inspectSkillDocument(join(fallback, "SKILL.md"));
    assert.equal(fallbackInspection.invalid, false, "non-canonical metadata remains a supported fallback");

    const validation = await expectOk(await fx.skills.validate("global"));
    const item = (name: string) => validation.items.find(entry => entry.name === name)!;
    assert.equal(item("valid").valid, true);
    assert.equal(item("multiline").valid, true);
    assert.equal(item("fallback").valid, true);
    assert.equal(item("fallback").diagnostic, undefined);
    assert.deepEqual(item("yaml-broken").diagnostic, { code: "frontmatter-yaml-invalid", line: 2, canonicalInvalid: false });
    assert.deepEqual(item("field-broken").diagnostic, { code: "frontmatter-field-type-invalid", line: 2, canonicalInvalid: true });
    assert.deepEqual(item("unclosed").diagnostic, { code: "frontmatter-unclosed", line: 1, canonicalInvalid: false });
    assert.deepEqual(item("missing").diagnostic, { code: "missing-directory" });
    assert.equal(validation.inventoryComplete, false);

    const provider = new InsuremoSkillProvider(fx.ctx, { signal: controller.signal, invalidate() {} }, fx.skills, "global");
    const listed = await provider.list({});
    assert.equal(Array.isArray(listed), false);
    if (!Array.isArray(listed)) {
      assert.equal(listed.complete, false);
      assert.deepEqual(listed.candidates.map(candidate => candidate.name), ["valid", "multiline", "fallback", "yaml-broken", "unclosed"]);
      assert.equal(listed.candidates.some(candidate => candidate.name === "field-broken"), false, "canonical-invalid candidate stays omitted from provider catalog");
      assert.equal(await provider.get(listed.candidates.find(candidate => candidate.name === "yaml-broken")!, {}), undefined);
      assert.equal((await provider.get(listed.candidates.find(candidate => candidate.name === "fallback")!, {}))?.content, "# Fallback\n");

      await writeFile(join(yamlBroken, "SKILL.md"), "# Fixed YAML\n");
      const refreshed = await expectOk(await fx.skills.validate("global"));
      assert.equal(refreshed.items.find(entry => entry.name === "yaml-broken")?.valid, true);
      assert.equal(refreshed.items.find(entry => entry.name === "yaml-broken")?.diagnostic, undefined);
      const relisted = await provider.list({});
      assert.equal(Array.isArray(relisted), false);
      if (!Array.isArray(relisted)) {
        const fixed = relisted.candidates.find(candidate => candidate.name === "yaml-broken");
        assert.ok(fixed !== undefined);
        assert.equal((await provider.get(fixed!, {}))?.content, "# Fixed YAML\n");
      }
    }
  } finally {
    controller.abort();
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("skills list emits inventory-updated after completion", async () => {
  const io = makeFakeIo({ skillsListJson: JSON.stringify([{ name: "alpha", description: "A", path: "/tmp/a" }]) });
  const fx = await skillsFixture(io);
  const events: unknown[] = [];
  fx.ctx.on("skills/inventory-updated", (payload: unknown) => { events.push(payload); });
  try {
    const result = await fx.skills.list("global");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      scope: "global",
      skills: [{ name: "alpha", description: "A", path: "/tmp/a" }],
      stdoutDigest: result.value.stdoutDigest,
    });
  } finally {
    await fx.dispose();
  }
});

test("provider list issues a candidate and get loads bounded frontmatter/body", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-skills-provider-"));
  const skill = join(root, "alpha");
  await mkdir(skill);
  await writeFile(join(skill, "SKILL.md"), "---\ntitle: Alpha title\ndescription: ignored\n---\n# Alpha\n");
  const io = makeFakeIo({ skillsListJson: JSON.stringify([{ name: "alpha", description: "Alpha", path: skill }]) });
  const fx = await skillsFixture(io, {}, root);
  const controller = new AbortController();
  try {
    const provider = new InsuremoSkillProvider(fx.ctx, { signal: controller.signal, invalidate() {} }, fx.skills, "global");
    const listed = await provider.list({});
    assert.equal(Array.isArray(listed), true);
    if (!Array.isArray(listed)) return;
    assert.equal(listed[0]?.provider, "insuremo");
    assert.equal(listed[0]?.path, await realpath(join(skill, "SKILL.md")));
    const loaded = await provider.get(listed[0]!, {});
    assert.equal(loaded?.content, "# Alpha\n");
    assert.deepEqual(loaded?.metadata, { title: "Alpha title" });
  } finally {
    controller.abort();
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("skills validate rejects a relative path escape before candidate filesystem checks", async () => {
  const root = homedir();
  const io = makeFakeIo({ skillsListJson: JSON.stringify([
    { name: "escape", description: "Escape", path: "../../etc" },
  ]) });
  const fx = await skillsFixture(io, {}, root);
  try {
    const value = await expectOk(await fx.skills.validate("global"));
    assert.equal(value.inventoryComplete, false);
    assert.deepEqual(value.items[0]?.reasons, ["outside-allowed-root"]);
    assert.equal(value.items[0]?.path, "/etc");
  } finally {
    await fx.dispose();
  }
});

test("skills validate rejects an absolute path outside the allowed root", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-skills-absolute-"));
  const io = makeFakeIo({ skillsListJson: JSON.stringify([
    { name: "escape", description: "Escape", path: "/etc" },
  ]) });
  const fx = await skillsFixture(io, {}, root);
  try {
    const value = await expectOk(await fx.skills.validate("global"));
    assert.equal(value.inventoryComplete, false);
    assert.deepEqual(value.items[0]?.reasons, ["outside-allowed-root"]);
    assert.equal(value.items[0]?.path, "/etc");
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("skills validate rejects a home-contained symlink whose target escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-skills-symlink-root-"));
  const outside = await mkdtemp(join(tmpdir(), "imo-skills-symlink-outside-"));
  const target = join(outside, "alpha");
  const link = join(root, "alpha");
  await mkdir(target);
  await writeFile(join(target, "SKILL.md"), "---\ntitle: should not be read\n---\n");
  await symlink(target, link, "dir");
  const io = makeFakeIo({ skillsListJson: JSON.stringify([
    { name: "alpha", description: "Alpha", path: link },
  ]) });
  const fx = await skillsFixture(io, {}, root);
  try {
    const value = await expectOk(await fx.skills.validate("global"));
    assert.equal(value.inventoryComplete, false);
    assert.deepEqual(value.items[0]?.reasons, ["outside-allowed-root"]);
    const controller = new AbortController();
    const provider = new InsuremoSkillProvider(fx.ctx, { signal: controller.signal, invalidate() {} }, fx.skills, "global");
    const listed = await provider.list({});
    assert.equal(Array.isArray(listed), false);
    if (!Array.isArray(listed)) assert.deepEqual(listed.candidates, []);
    controller.abort();
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("provider omits frontmatter when the closing delimiter is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-skills-unclosed-"));
  const skill = join(root, "alpha");
  await mkdir(skill);
  await writeFile(join(skill, "SKILL.md"), "---\ntitle: visible\nbody: should-not-appear\n# body: should-not-appear\n");
  const io = makeFakeIo({ skillsListJson: JSON.stringify([{ name: "alpha", description: "Alpha", path: skill }]) });
  const fx = await skillsFixture(io, {}, root);
  try {
    const controller = new AbortController();
    const provider = new InsuremoSkillProvider(fx.ctx, { signal: controller.signal, invalidate() {} }, fx.skills, "project");
    const listed = await provider.list({});
    assert.equal(Array.isArray(listed), false);
    if (!Array.isArray(listed)) {
      assert.equal(listed.complete, false);
      const loaded = await provider.get(listed.candidates[0]!, {});
      assert.equal(loaded, undefined);
    }
    controller.abort();
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("provider skips invalid inventory entries and reads only valid entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-skills-provider-filter-"));
  const valid = join(root, "valid");
  await mkdir(valid);
  await writeFile(join(valid, "SKILL.md"), "---\ntitle: Valid\n---\n");
  const io = makeFakeIo({ skillsListJson: JSON.stringify([
    { name: "valid", description: "Valid", path: valid },
    { name: "invalid", description: "Invalid", path: "/etc" },
  ]) });
  const fx = await skillsFixture(io, {}, root);
  try {
    const controller = new AbortController();
    const provider = new InsuremoSkillProvider(fx.ctx, { signal: controller.signal, invalidate() {} }, fx.skills, "global");
    const listed = await provider.list({});
    assert.equal(Array.isArray(listed), false);
    if (!Array.isArray(listed)) {
      assert.deepEqual(listed.candidates.map((item) => item.name), ["valid"]);
      const loaded = await provider.get(listed.candidates[0]!, {});
      assert.equal(loaded?.content, "");
    }
    controller.abort();
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

