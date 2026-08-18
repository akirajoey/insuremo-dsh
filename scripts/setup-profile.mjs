import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceProfile = resolve(repositoryRoot, "profiles/icomposer-web");
const configuredHome = process.env.DSH_HOME?.trim();
const dshHome = resolve(configuredHome || resolve(repositoryRoot, ".dsh-home"));
const realDefaultHome = resolve(homedir(), ".dsh");

if (dshHome === realDefaultHome) {
  throw new Error(`Refusing to modify the real Harness home ${realDefaultHome}; set DSH_HOME to an isolated directory`);
}

const destinationProfile = resolve(dshHome, "profiles", "icomposer-web");
await rm(destinationProfile, { recursive: true, force: true });
await mkdir(resolve(dshHome, "profiles"), { recursive: true });
await cp(sourceProfile, destinationProfile, { recursive: true });

const manifestPath = resolve(destinationProfile, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.dependencies ??= {};
manifest.dependencies["@icomposer/bundle-workbench"] =
  `file:${resolve(repositoryRoot, "packages/bundle-icomposer-workbench")}`;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

execFileSync("pnpm", ["install"], { cwd: destinationProfile, stdio: "inherit" });
console.log(`Profile installed at ${destinationProfile}`);
