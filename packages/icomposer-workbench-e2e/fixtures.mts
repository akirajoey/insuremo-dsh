/**
 * Fixture builders for the POC end-to-end regression run.
 *
 * All fixtures are deterministic: a fixed small workspace (3 api + 2 function
 * assets with real join semantics) plus an optional large generator for the
 * stability pass. Nothing here touches the network; CLI-shaped subprocesses
 * are faked by the runner.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface FixtureAsset {
  readonly kind: "api" | "function";
  readonly name: string;
  readonly groovy: string;
  readonly calls?: readonly string[];
  readonly sdkClients?: readonly string[];
}

export function fixtureAssets(): readonly FixtureAsset[] {
  return [
    {
      kind: "api", name: "SearchPaymentAPI",
      groovy: `class SearchPaymentAPI {\n  def execute() {\n    def svc = getCommonService("PaymentQueryService")\n    svc.query()\n    def sdk = new PolicySdkClient()\n    sdk.find()\n  }\n}\n`,
      calls: ["PaymentQueryService"],
      sdkClients: ["PolicySdkClient"],
    },
    {
      kind: "api", name: "SaveCollectionAPI",
      groovy: `class SaveCollectionAPI {\n  def execute() {\n    def svc = getCommonService("CollectionService")\n    svc.save()\n  }\n}\n`,
      calls: ["CollectionService"],
    },
    {
      kind: "api", name: "HealthCheckAPI",
      groovy: `class HealthCheckAPI {\n  def execute() {\n    def x = 1\n  }\n}\n`,
    },
    {
      kind: "function", name: "PaymentQueryService",
      groovy: `class PaymentQueryService {\n  def query() {\n    def sdk = new PaymentSdkClient()\n    sdk.query()\n  }\n}\n`,
      sdkClients: ["PaymentSdkClient"],
    },
    {
      kind: "function", name: "CollectionService",
      groovy: `class CollectionService {\n  def save() {\n    def x = 1\n  }\n}\n`,
    },
  ];
}

export interface WorkspaceFixture {
  readonly root: string;
  readonly entries: ReadonlyArray<{ name: string; type: "api" | "function"; sourcePath: string }>;
  readonly groovyPath: (name: string) => string;
}

/** Materialize the deterministic fixture workspace under `root`. */
export async function buildWorkspaceFixture(root: string): Promise<WorkspaceFixture> {
  const entries: Array<{ name: string; type: "api" | "function"; sourcePath: string }> = [];
  for (const asset of fixtureAssets()) {
    const dir = join(root, "src/dev/Tenant/E2E", asset.kind, asset.name);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${asset.name}.groovy`);
    await writeFile(file, asset.groovy, "utf8");
    const metaDir = join(root, ".metadata", asset.kind);
    await mkdir(metaDir, { recursive: true });
    const md5 = createHash("md5").update(asset.groovy).digest("hex");
    await writeFile(join(metaDir, `${asset.name}.metadata.json`), JSON.stringify({ [asset.kind]: { Name: asset.name, Md5Value: md5 } }), "utf8");
    entries.push({ name: asset.name, type: asset.kind, sourcePath: file });
  }
  return { root, entries, groovyPath: (name) => join(root, "src/dev/Tenant/E2E", entries.find(e => e.name === name)?.type ?? "api", name, `${name}.groovy`) };
}

/**
 * Large fixture generator for the stability pass: `count` api assets each
 * calling one shared function, exercising node/edge volume and truncation
 * paths. Metadata keeps a deterministic md5 of generated content.
 */
export async function buildLargeWorkspaceFixture(root: string, count: number): Promise<{ readonly root: string; readonly entries: ReadonlyArray<{ name: string; type: "api" | "function"; sourcePath: string }> }> {
  const shared = "function StableSharedService {\n  def work() {\n    def x = 1\n  }\n}\n";
  const fnDir = join(root, "src/dev/Tenant/STRESS/function/StableSharedService");
  await mkdir(fnDir, { recursive: true });
  const fnFile = join(fnDir, "StableSharedService.groovy");
  await writeFile(fnFile, shared, "utf8");
  await mkdir(join(root, ".metadata/function"), { recursive: true });
  await writeFile(join(root, ".metadata/function/StableSharedService.metadata.json"), JSON.stringify({ function: { Name: "StableSharedService", Md5Value: createHash("md5").update(shared).digest("hex") } }), "utf8");
  const entries: Array<{ name: string; type: "api" | "function"; sourcePath: string }> = [
    { name: "StableSharedService", type: "function", sourcePath: fnFile },
  ];
  const metaDir = join(root, ".metadata/api");
  await mkdir(metaDir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const name = `StressApi${i}`;
    const groovy = `class ${name} {\n  def execute() {\n    def svc = getCommonService("StableSharedService")\n    svc.work()\n  }\n}\n`;
    const dir = join(root, "src/dev/Tenant/STRESS/api", name);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${name}.groovy`);
    await writeFile(file, groovy, "utf8");
    await writeFile(join(metaDir, `${name}.metadata.json`), JSON.stringify({ api: { Name: name, Md5Value: createHash("md5").update(groovy).digest("hex") } }), "utf8");
    entries.push({ name, type: "api", sourcePath: file });
  }
  return { root, entries };
}
