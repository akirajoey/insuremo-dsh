import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  assembleLogicalLines,
  buildSkillCatalog,
  isEmptySkillCatalogOutput,
  parseSkillCatalogOutput,
  SKILL_CATALOG_DESCRIPTION_MAX,
  SKILLS_TOOL_SOURCE,
} from "../src/skill-actions/catalog.ts";
import { skillCatalogArgs, SKILLS_TOOL_PACKAGE, SKILLS_TOOL_REGISTRY } from "../src/skill-actions/preview.ts";
import { withFixture } from "./support/skill-actions-fixture.ts";
import { failureDiagnosis } from "../src/diagnosis.ts";

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
  assert.equal(parseSkillCatalogOutput(CATALOG_OUTPUT.replace("|      Beta helper", "|      Beta helper\n../unexpected")).ok, false);
  assert.equal(parseSkillCatalogOutput(CATALOG_OUTPUT.replace("|      Beta helper", "|      Beta helper\n|   odd-indent")).ok, false);
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

const REAL_FIXTURE_PATH = fileURLToPath(new URL("./fixtures/skills-catalog-1.1.2-real.txt", import.meta.url));

test("TASK-104 catalog parser accepts the real 1.1.2 macOS capture with all 36 skills", () => {
  const raw = readFileSync(REAL_FIXTURE_PATH, "utf8");
  const parsed = parseSkillCatalogOutput(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.foundCount, 36);
  assert.equal(parsed.value.skills.length, 36);
  assert.equal(new Set(parsed.value.skills.map(skill => skill.name)).size, 36);
  assert.equal(parsed.value.skills[0]?.name, "icomposer-batch");
  assert.equal(parsed.value.skills[0]?.group, "Icomposer Batch");
  const groups = [...new Set(parsed.value.skills.map(skill => skill.group))];
  assert.equal(groups.length, 35, "35 real group headings (the General tail)");
  assert.equal(groups.at(-1), "General");
  // Multi-line descriptions are joined with newlines and stay under the bound.
  const lengths = parsed.value.skills.map(skill => skill.description.length);
  assert.equal(Math.max(...lengths), 1622, "measured maximum from the real capture");
  assert.ok(parsed.value.skills.every(skill => skill.description.length <= SKILL_CATALOG_DESCRIPTION_MAX));
  assert.ok(parsed.value.skills.some(skill => skill.description.includes("\n")), "wrapped descriptions are preserved");
  // No absolute host path may survive parsing.
  assert.equal(JSON.stringify(parsed.value).includes("/Users/"), false);
});

test("TASK-104 fix 1: a box-drawing footer (└) is recognized instead of failing closed", () => {
  const parsed = parseSkillCatalogOutput(CATALOG_OUTPUT.replace("|  Use --skill", "└  Use --skill"));
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.skills.length, 2);
});

test("TASK-104 fix 2: CR + erase sequences invalidate the spinner line instead of concatenating it", () => {
  const spinner = "◒  Fetching skills from npm registry...";
  const rewrite = `\r\u001b[999D\u001b[J✔  Found 2 skills`;
  const output = CATALOG_OUTPUT.replace("o  Found 2 skills", `${spinner}${rewrite}`);
  const parsed = parseSkillCatalogOutput(output);
  assert.equal(parsed.ok, true, "the rewritten line must parse as the Found line");
  if (parsed.ok) assert.equal(parsed.value.foundCount, 2);
  assert.deepEqual(assembleLogicalLines(`spinner text${rewrite}`), ["✔  Found 2 skills"]);
  assert.deepEqual(assembleLogicalLines(`stale\r\u001b[999D\u001b[Jfresh`), ["fresh"]);
});

test("TASK-104 fix 3: the bounded clack ASCII logo is accepted while unknown decoration is not", () => {
  const logo = [
    "███████╗██╗  ██╗██╗██╗     ██╗     ███████╗",
    "██╔════╝██║ ██╔╝██║██║     ██║     ██╔════╝",
    "███████╗█████╔╝ ██║██║     ██║     ███████╗",
    "╚════██║██╔═██╗ ██║██║     ██║     ╚════██║",
    "███████║██║  ██╗██║███████╗███████╗███████║",
    "╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝╚══════╝",
  ].join("\n");
  const withLogo = `${logo}\n${CATALOG_OUTPUT}`;
  assert.equal(parseSkillCatalogOutput(withLogo).ok, true);
  assert.equal(parseSkillCatalogOutput(`${logo}\nNOT A LOGO\n${CATALOG_OUTPUT}`).ok, false);
  assert.equal(parseSkillCatalogOutput(`${"█".repeat(201)}\n${CATALOG_OUTPUT}`).ok, false);
});

test("TASK-104 fix 4: description bound follows the measured real maximum with margin and still rejects overflow", () => {
  assert.equal(parseSkillCatalogOutput(CATALOG_OUTPUT.replace("Alpha helper", "A".repeat(800))).ok, true);
  assert.equal(parseSkillCatalogOutput(CATALOG_OUTPUT.replace("Alpha helper", "A".repeat(SKILL_CATALOG_DESCRIPTION_MAX))).ok, true);
  assert.equal(parseSkillCatalogOutput(CATALOG_OUTPUT.replace("Alpha helper", "A".repeat(SKILL_CATALOG_DESCRIPTION_MAX + 1))).ok, false);
  // Multi-line continuation rows accumulate into one description.
  const wrapped = CATALOG_OUTPUT.replace("|      Beta helper", "|      Beta helper\n|  continued line");
  const parsed = parseSkillCatalogOutput(wrapped);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.skills[1]?.description, "Beta helper\ncontinued line");
});

test("TASK-104 empty-envelope check tolerates the logo and erase shapes", () => {
  const empty = `████████╗███╗\r\u001b[999D\u001b[Jo  No skills found\n|  No valid skills found. Skills require a SKILL.md with name and description.\n`;
  assert.equal(isEmptySkillCatalogOutput(empty), true);
  assert.equal(isEmptySkillCatalogOutput(`${empty}|  unexpected trailing`), false);
});

test("buildSkillCatalog keeps scenario entries fixed and never exposes source paths", () => {
  const built = buildSkillCatalog({ ok: true, value: { skills: [{ type: "skill", name: "alpha-skill", description: "safe" }], foundCount: 1 } }.value, 0, 60_000);
  assert.equal(built.entries[0]?.type, "scenario");
  assert.equal(JSON.stringify(built).includes("/"), false);
  assert.equal(built.expiresAt, new Date(60_000).toISOString());
});

test("TASK-106: a failed catalog refresh records a bounded redacted diagnosis", async () => {
  await withFixture([], async fx => {
    try {
      fx.state.previewError = { exitCode: 1, stderr: "registry unreachable https://user:secret@example.test/skills" };
      const result = await fx.actions.refreshCatalog(undefined, true);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "catalog-unavailable");
      const diagnosis = failureDiagnosis.snapshot("skill");
      assert.ok(diagnosis, "a failed catalog run must be diagnosable");
      assert.equal(diagnosis.operation, "skill-catalog");
      assert.equal(diagnosis.exitCode, 1);
      assert.equal(diagnosis.commands.some(line => line.includes("@insuremo/skills-tool") && line.includes("insuremo-skills") && line.includes("-l")), true);
      assert.equal(diagnosis.registry.includes("public.insuremo.com"), true);
      assert.equal(diagnosis.stderr.includes("user:secret"), false, "credentials in stderr stay redacted");
      assert.equal(diagnosis.error?.code, "non-zero-exit");
    } finally {
      fx.state.previewError = null;
      failureDiagnosis.clear("skill");
    }
  });
});

test("TASK-106: an unresolvable npx stays diagnosable as tool-unavailable", async () => {
  await withFixture([], async fx => {
    try {
      fx.state.npxMissing = true;
      const result = await fx.actions.refreshCatalog(undefined, true);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "catalog-unavailable");
      const diagnosis = failureDiagnosis.snapshot("skill");
      assert.ok(diagnosis);
      assert.equal(diagnosis.operation, "skill-catalog");
      assert.equal(diagnosis.error?.code, "not-found");
    } finally {
      fx.state.npxMissing = false;
      failureDiagnosis.clear("skill");
    }
  });
});

test("TASK-106: the catalog child gets only the deterministic env overlay, never ambient secrets", async () => {
  await withFixture([], async fx => {
    fx.state.installPreview = CATALOG_OUTPUT;
    const previousKey = process.env.AIGW_SSAPOC_INSUREMO_API_KEY;
    const previousPath = process.env.PATH;
    process.env.AIGW_SSAPOC_INSUREMO_API_KEY = "must-not-reach-the-child";
    process.env.PATH = "/usr/bin:/bin";
    try {
      assert.equal((await fx.actions.refreshCatalog(undefined, true)).ok, true);
      const index = fx.state.invocations.findIndex(args => args.includes("@insuremo/skills-tool"));
      assert.ok(index >= 0);
      const env = fx.state.spawnEnvs[index];
      // The harness merges this map onto its scrubbed parent env, so the service
      // must never spread process.env here: explicit entries survive the scrub.
      assert.deepEqual(env, { CI: "true", FORCE_COLOR: "0", TERM: "dumb" });
      assert.equal(Object.keys(env ?? {}).includes("AIGW_SSAPOC_INSUREMO_API_KEY"), false);
      assert.equal(Object.keys(env ?? {}).includes("PATH"), false);
    } finally {
      if (previousKey === undefined) delete process.env.AIGW_SSAPOC_INSUREMO_API_KEY;
      else process.env.AIGW_SSAPOC_INSUREMO_API_KEY = previousKey;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
