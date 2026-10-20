#!/usr/bin/env node
// No filesystem/network/credential access. Used only by the isolated migration smoke.
const args = process.argv.slice(2).join(" ");
if (args === "--version") console.log("0.2.17");
else if (args === "upgrade --check") console.log("Current version: 0.2.17\nLatest version: 0.2.17");
else if (args.startsWith("auth profile list")) console.log(JSON.stringify([
  { name: "migration-test", env: "test", scope: "global", is_default: true },
  { name: "migration-other", env: "test", scope: "global" },
]));
else if (args === "auth default-profile get") console.log("migration-test");
else if (args.startsWith("auth profile validate")) console.log(JSON.stringify({ status: "valid", valid: true }));
else if (args.startsWith("skills list")) console.log("[]");
else if (args.startsWith("skills validate")) console.log(JSON.stringify({ valid: true, skills: [] }));
else { console.error(`Fixture refuses command: ${args}`); process.exitCode = 1; }
