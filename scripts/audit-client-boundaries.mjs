#!/usr/bin/env node
/**
 * High-confidence, offline Client dependency gate (TASK-169, Review-slimmed).
 *
 * Source: distinguishes type-only from runtime values, rejects runtime
 * `@deepseek-ai/dsh-client-*` imports and non-health `react-dom`, and rejects
 * unresolved dynamic module names. Emitted bundle: module references must stay
 * inside the React module table; `react-dom/client` is accepted only for the
 * status package, whose single use is reviewed as EX-WH-01.
 *
 * This is not a DOM-ownership analyzer, a binary/source-map attestation, or an
 * installation proof. DOM ownership at the known call sites is reviewed by
 * humans; peers are reported with `installation: unverified`.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromVerify = createRequire(resolve(root, "packages/icomposer-verify/package.json"));
const ts = requireFromVerify("typescript");
export const HEALTH_FILE = "packages/ui-insuremo-status/src/client/WorkspaceHealth.tsx";
export const HEALTH_SHA256 = "aafb5c31d58ed740ec7e059824ae7d4acf6e00b784e9c4d5803e95117ddee0a7";
const REACT_MODULES = new Set(["react", "react/jsx-runtime", "react/jsx-dev-runtime"]);

function lineOf(source, node) { return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1; }
function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))) node = node.expression;
  return node;
}
function literalArg(node) { return node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text : null; }
function typeOnlyImport(clause) {
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) return false;
  return clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(item => item.isTypeOnly);
}
function typeOnlyExport(node) {
  if (node.isTypeOnly) return true;
  return node.exportClause && ts.isNamedExports(node.exportClause)
    && node.exportClause.elements.length > 0 && node.exportClause.elements.every(item => item.isTypeOnly);
}

/** Source-level value/type classification for one Client file. */
export function analyzeClientSource(fileName, text) {
  const normalized = fileName.replaceAll("\\", "/");
  const source = ts.createSourceFile(normalized, text, ts.ScriptTarget.Latest, true, normalized.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hash = createHash("sha256").update(text).digest("hex");
  const health = normalized === HEALTH_FILE && hash === HEALTH_SHA256;
  const issues = [];
  const imports = [];
  const issue = (code, node) => issues.push({ code, file: normalized, line: lineOf(source, node) });
  if (source.parseDiagnostics.length) issue("PARSE_ERROR", source);
  if (normalized === HEALTH_FILE && !health) issue("HEALTH_EXCEPTION_CHANGED", source);

  function add(name, kind, node) {
    if (name === null) { issue("DYNAMIC_MODULE_UNRESOLVED", node); return; }
    imports.push({ file: normalized, line: lineOf(source, node), module: name, kind });
    if (kind === "type" || name.startsWith(".") || REACT_MODULES.has(name)) return;
    if (name === "react-dom/client" && health) return;
    if (name.startsWith("@deepseek-ai/dsh-client-")) issue("CLIENT_HARNESS_VALUE_IMPORT", node);
    else if (name.startsWith("react")) issue("REACT_RUNTIME_NOT_ALLOWED", node);
    else issue("CLIENT_VALUE_MODULE_UNPROVEN", node);
  }

  function visit(node) {
    if (ts.isImportDeclaration(node)) add(ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : null, typeOnlyImport(node.importClause) ? "type" : "value", node);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : null, typeOnlyExport(node) ? "type" : "value", node);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      add(expression && ts.isStringLiteralLike(expression) ? expression.text : null, node.isTypeOnly ? "type" : "value", node);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(literalArg(node), "dynamic-import", node);
    else if (ts.isCallExpression(node) && ts.isIdentifier(unwrap(node.expression)) && unwrap(node.expression).text === "require") add(literalArg(node), "require", node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { file: normalized, hash, healthException: health, imports, issues };
}

/** Emitted-bundle module-reference gate; no source-map or binary claims. */
export function auditClientBundle(code, bundleFile) {
  const normalized = bundleFile.replaceAll("\\", "/");
  const source = ts.createSourceFile("client.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const issues = [];
  const modules = [];
  const issue = code => issues.push({ code, file: normalized });
  if (source.parseDiagnostics.length) issue("BUNDLE_PARSE_ERROR");
  // The status package and the aggregate that embeds it both carry the one
  // reviewed EX-WH-01 createRoot. No other bundle may require react-dom.
  const statusBundle = normalized.includes("/packages/ui-insuremo-status/lib/client.js")
    || normalized.includes("/packages/icomposer-workbench-dist/lib/client.js")
    || normalized.endsWith("/@icomposer/workbench/lib/client.js");
  function visit(node) {
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const name = literalArg(node);
      if (name === null) issue("BUNDLE_DYNAMIC_MODULE_UNRESOLVED");
      else {
        modules.push(name);
        if (name.startsWith("@deepseek-ai/dsh-client-")) issue("CLIENT_HARNESS_VALUE_IMPORT");
        else if (name === "react-dom/client") { if (!statusBundle) issue("BUNDLE_REACT_DOM_OUTSIDE_HEALTH"); }
        else if (!REACT_MODULES.has(name)) issue("BUNDLE_VALUE_MODULE_UNPROVEN");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { modules: [...new Set(modules)].sort(), reactDomAllowed: statusBundle, issues };
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) return walk(file);
    return entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [file] : [];
  });
}

/** Repository source report: separate value, activation and host evidence. */
export function auditRepository(repository = root) {
  const packagesDir = resolve(repository, "packages");
  const clients = [];
  const manifests = [];
  const hostImports = [];
  for (const name of readdirSync(packagesDir, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) {
    const dir = resolve(packagesDir, name);
    const manifestPath = resolve(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.dsh?.client) {
      for (const file of walk(resolve(dir, "src/client"))) clients.push(analyzeClientSource(relative(repository, file).split(sep).join("/"), readFileSync(file, "utf8")));
      manifests.push({ package: name, clientInject: manifest.dsh.client.inject ?? [], peers: Object.keys(manifest.peerDependencies ?? {}).sort(), installation: "unverified" });
    }
    for (const file of walk(resolve(dir, "src"))) {
      if (file.startsWith(`${resolve(dir, "src/client")}${sep}`)) continue;
      const fileRelative = relative(repository, file).split(sep).join("/");
      const source = ts.createSourceFile(fileRelative, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      function hostVisit(node) {
        if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && !node.moduleSpecifier.text.startsWith(".")) {
          hostImports.push({ file: fileRelative, module: node.moduleSpecifier.text, kind: typeOnlyImport(node.importClause) ? "type" : "value" });
        }
        ts.forEachChild(node, hostVisit);
      }
      hostVisit(source);
    }
  }
  return {
    clients,
    manifests,
    hostImports,
    issues: clients.flatMap(client => client.issues),
    peerEvidence: "source/activation categories only; package installation unverified",
    bundleProvenance: "not evaluated by the source audit",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && !(args.length === 2 && args[0] === "--bundle")) {
    console.error("Usage: node scripts/audit-client-boundaries.mjs [--bundle <client.js>]");
    process.exitCode = 2;
  } else {
    const result = auditRepository();
    let bundle = result.bundleProvenance;
    if (args.length === 2) {
      try { bundle = auditClientBundle(readFileSync(resolve(args[1]), "utf8"), resolve(args[1])); }
      catch { bundle = { issues: [{ code: "BUNDLE_INPUT_UNREADABLE" }] }; }
    }
    const summary = {
      clientFiles: result.clients.length,
      clientTypeOnlyImports: result.clients.flatMap(client => client.imports).filter(item => item.kind === "type").length,
      clientValueModules: [...new Set(result.clients.flatMap(client => client.imports).filter(item => item.kind !== "type" && !item.module.startsWith(".")).map(item => item.module))].sort(),
      clientInject: result.manifests.map(item => ({ package: item.package, entries: item.clientInject })),
      peers: result.manifests.map(item => ({ package: item.package, entries: item.peers, installation: item.installation })),
      hostValueModules: [...new Set(result.hostImports.filter(item => item.kind === "value").map(item => item.module))].sort(),
      hostExternalEvidence: result.peerEvidence,
      bundle,
      issues: result.issues,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (result.issues.length > 0 || (typeof bundle !== "string" && bundle.issues.length > 0)) process.exitCode = 1;
  }
}
