import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSkillCatalogOutput, buildSkillCatalog, isEmptySkillCatalogOutput, SKILLS_TOOL_SOURCE } from "../src/skill-actions/catalog.ts";
import { skillCatalogArgs, SKILLS_TOOL_PACKAGE, SKILLS_TOOL_REGISTRY } from "../src/skill-actions/preview.ts";
import { withFixture } from "./support/skill-actions-fixture.ts";

const REGISTRY_FLAG = `--registry=${SKILLS_TOOL_REGISTRY}`;

const CATALOG_OUTPUT = [
  "T  skills",
  "|  Tip: use the --yes (-y) and --global (-g) flags to install without prompts.",
  "o  Parsing source...",
  "o  Source: https://gitlab.insuremo.com/insuremo-public/insuremo-skills.git",
  "o  Syncing repository to store...",
  "o  Repository synced",
  "o  Discovering skills...",
  "o  Found 2 skills",
  "!  Available Skills",
  "Icomposer Full Stack",
  "|    alpha-skill",
  "|      Alpha helper",
  "|    beta-skill",
  "|      Beta helper",
  "",
  "|  Use --skill <name> to install specific skills",
  "",
].join("\n");

const ANSI_CATALOG_OUTPUT = CATALOG_OUTPUT
  .replace("Found 2 skills", "\u001b[32mFound \u001b[1m2\u001b[0m skills")
  .replace("Available Skills", "\u001b[1mAvailable Skills\u001b[0m")
  .replace("alpha-skill", "\u001b[36malpha-skill\u001b[0m");

test("catalog parser accepts the observed 1.1.2 add -l envelope and strips ANSI", () => {
  const parsed = parseSkillCatalogOutput(ANSI_CATALOG_OUTPUT);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.skills, [
    { type: "skill", name: "alpha-skill", description: "Alpha helper", group: "Icomposer Full Stack" },
    { type: "skill", name: "beta-skill", description: "Beta helper", group: "Icomposer Full Stack" },
  ]);
  assert.equal(parsed.value.foundCount, 2);
});

test("catalog parser fails closed on logs, malformed rows, duplicates, count drift, and empty output", () => {
  assert.equal(parseSkillCatalogOutput("npm warn unexpected\n" + CATALOG_OUTPUT).ok, false);
  assert.equal(parseSkillCatalogOutput(CATALOG_OUTPUT.replace("|      Beta helper", "|      Beta helper\n|      unexpected")).ok, false);
  assert.equal(parseSkillCatalogOutput(CATALOG_OUTPUT.replace("|    beta-skill", "|    alpha-skill")).ok, false);
  assert.equal(parseSkillCatalogOutput(CATALOG_OUTPUT.replace("Found 2 skills", "Found 3 skills")).ok, false);
  assert.equal(parseSkillCatalogOutput(CATALOG_OUTPUT.replace(/Available Skills[\s\S]*$/, "Available Skills\n|  Use --skill <name> to install specific skills\n")).ok, false);
  assert.equal(parseSkillCatalogOutput(`${"x".repeat(65_000)}\n${CATALOG_OUTPUT}`).ok, false);
});

test("catalog parser distinguishes the documented empty-source failure", () => {
  assert.equal(isEmptySkillCatalogOutput("o  Parsing source...\no  Found no skills\no  No skills found\n|  No valid skills found. Skills require a SKILL.md with name and description.\n"), false);
  assert.equal(isEmptySkillCatalogOutput("o  Parsing source...\no  No skills found\n—  No valid skills found. Skills require a SKILL.md with name and description.\n"), true);
});

test("catalog parser accepts the documented npm fallback status envelope", () => {
  const fallback = CATALOG_OUTPUT.replace("Found 2 skills", "Found 1 skill")
    .replace("|    beta-skill\n|      Beta helper\n", "")
    .replace("o  Syncing repository to store...\no  Repository synced", "o  Git host unreachable — using npm registry (@insuremo/skills)\no  Fetching skills from npm registry...\no  Package resolved: @insuremo/skills@1.2.3");
  assert.equal(parseSkillCatalogOutput(fallback).ok, true);
});

test("catalog parser accepts grouped and General rows, but not unknown heading syntax", () => {
  const grouped = CATALOG_OUTPUT.replace("Found 2 skills", "Found 3 skills")
    .replace("|  Use --skill", "General\n|    gamma-skill\n|      Gamma helper\n\n|  Use --skill");
  const parsed = parseSkillCatalogOutput(grouped);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value.skills.map(skill => skill.name), ["alpha-skill", "beta-skill", "gamma-skill"]);
  assert.equal(parseSkillCatalogOutput(CATALOG_OUTPUT.replace("Icomposer Full Stack", "../unexpected-heading")).ok, false);
  assert.equal(parseSkillCatalogOutput(CATALOG_OUTPUT.replace("https://gitlab.insuremo.com/insuremo-public/insuremo-skills.git", "https://evil.example/skills.git")).ok, false);
});

test("catalog source is fixed, bounded, cache-only on reads, and validates exact names before argv", async () => {
  await withFixture([], async fx => {
    fx.state.installPreview = CATALOG_OUTPUT;
    const first = await fx.actions.refreshCatalog(undefined, false);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.value.source, SKILLS_TOOL_SOURCE);
    assert.equal(first.value.entries.filter(entry => entry.type === "scenario").length, 5);
    assert.deepEqual(skillCatalogArgs(), ["-y", REGISTRY_FLAG, SKILLS_TOOL_PACKAGE, "add", SKILLS_TOOL_SOURCE, "-l", "--skip-update-check"]);
    const catalogSpawns = fx.state.invocations.filter(args => args.includes(SKILLS_TOOL_PACKAGE));
    assert.equal(catalogSpawns.length, 1);

    const cached = await fx.actions.getCatalog();
    assert.equal(cached.ok, true);
    assert.equal(fx.state.invocations.filter(args => args.includes(SKILLS_TOOL_PACKAGE)).length, 1);

    const forged = await fx.actions.runDirect({ kind: "skill-install", source: { type: "alias", value: SKILLS_TOOL_SOURCE }, agent: "universal", skills: ["not-in-catalog"] });
    assert.equal(forged.ok, false);
    if (!forged.ok) assert.equal(forged.error.code, "catalog-selection-invalid");
    assert.equal(fx.state.invocations.filter(args => args.includes(SKILLS_TOOL_PACKAGE)).length, 1);

    const requested = await fx.actions.request({ kind: "skill-install", source: { type: "alias", value: SKILLS_TOOL_SOURCE }, agent: "universal", skills: ["alpha-skill"] });
    assert.equal(requested.ok, true);
    const preview = fx.state.invocations.find(args => args.includes(SKILLS_TOOL_PACKAGE) && args.includes("-s") && args.includes("alpha-skill"));
    assert.deepEqual(preview, ["-y", REGISTRY_FLAG, SKILLS_TOOL_PACKAGE, "add", SKILLS_TOOL_SOURCE, "-g", "-a", "universal", "-s", "alpha-skill", "-l", "--skip-update-check"]);
  });
});

test("concurrent catalog refresh callers coalesce to one trusted subprocess", async () => {
  await withFixture([], async fx => {
    fx.state.installPreview = CATALOG_OUTPUT;
    const [first, second] = await Promise.all([fx.actions.refreshCatalog(), fx.actions.refreshCatalog()]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(fx.state.invocations.filter(args => args.includes(SKILLS_TOOL_PACKAGE)).length, 1);
  });
});

test("catalog cache and in-flight refreshes are isolated by the skills-tool home", async () => {
  await withFixture([], async fx => {
    fx.state.installPreview = CATALOG_OUTPUT;
    const home = process.env.HOME;
    assert.equal(home === undefined, false);
    assert.equal((await fx.actions.refreshCatalog()).ok, true);
    process.env.HOME = `${home}/other-home`;
    assert.equal((await fx.actions.getCatalog()).ok, false);
    assert.equal((await fx.actions.refreshCatalog()).ok, true);
    assert.equal(fx.state.invocations.filter(args => args.includes(SKILLS_TOOL_PACKAGE)).length, 2);
    process.env.HOME = home;
  });
});

test("approved single-skill execution revalidates after TTL and never uses an expired whitelist", async () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    await withFixture([], async fx => {
      fx.state.installPreview = CATALOG_OUTPUT;
      assert.equal((await fx.actions.refreshCatalog()).ok, true);
      const requested = await fx.actions.request({ kind: "skill-install", source: { type: "alias", value: SKILLS_TOOL_SOURCE }, agent: "universal", skills: ["alpha-skill"] });
      assert.equal(requested.ok, true);
      if (!requested.ok) return;
      await fx.approve(requested.value.operationId);
      now += 61_000;
      fx.state.previewError = { exitCode: 1, stderr: "catalog refresh failed" };
      const before = fx.state.invocations.length;
      const result = await fx.actions.execute(requested.value.operationId);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "catalog-unavailable");
      assert.equal(fx.state.invocations.slice(before).some(args => args.includes("-s") && args.includes("alpha-skill") && args.includes("add")), false);
    });
  } finally {
    Date.now = originalNow;
  }
});

test("buildSkillCatalog keeps scenario entries fixed and never exposes source paths", () => {
  const built = buildSkillCatalog({ ok: true, value: { skills: [{ type: "skill", name: "alpha-skill", description: "safe" }], foundCount: 1 } }.value, 0, 60_000);
  assert.equal(built.entries[0]?.type, "scenario");
  assert.equal(JSON.stringify(built).includes("/"), false);
  assert.equal(built.expiresAt, new Date(60_000).toISOString());
});
