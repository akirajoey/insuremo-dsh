import { createHash } from "node:crypto";

export interface MethodInfo {
  readonly name: string;
  readonly signature: string;
  readonly body: string;
  readonly startLine: number;
  readonly endLine: number;
}

export function stableHashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export function isIdentifier(value: string): boolean {
  if (!value) return false;
  const first = value[0];
  if (!(first === "_" || (first >= "a" && first <= "z") || (first >= "A" && first <= "Z"))) return false;
  for (const ch of value) {
    if (!(ch === "_" || (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9"))) return false;
  }
  return true;
}

export function stripLineComments(text: string): string {
  return text.split("\n").map(line => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//")) return "";
    const idx = line.indexOf("//");
    return idx >= 0 ? line.slice(0, idx) : line;
  }).join("\n");
}

export function extractQuotedAfter(line: string, marker: string): string | undefined {
  const idx = line.indexOf(marker);
  if (idx < 0) return undefined;
  const after = line.slice(idx + marker.length);
  const qIdx = after.search(/["']/);
  if (qIdx < 0) return undefined;
  const quote = after[qIdx];
  const rest = after.slice(qIdx + 1);
  const end = rest.indexOf(quote);
  if (end < 0) return undefined;
  return rest.slice(0, end);
}

export function assignedVariableName(line: string): string | undefined {
  const eq = line.indexOf("=");
  if (eq < 0) return undefined;
  const before = line.slice(0, eq).trim();
  const candidate = before.split(/\s+/).pop()?.trim();
  if (candidate && isIdentifier(candidate)) return candidate;
  return undefined;
}

export function calledMethodsOnVariable(code: string, varName: string): string[] {
  const marker = `${varName}.`;
  const result: string[] = [];
  let rest = code;
  while (true) {
    const idx = rest.indexOf(marker);
    if (idx < 0) break;
    const after = rest.slice(idx + marker.length);
    const m = after.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    if (m) {
      const method = m[1];
      const tail = after.slice(method.length).trimStart();
      if (tail.startsWith("(") && method !== "getClass" && method !== "toString") result.push(method);
      rest = after.slice(method.length);
    } else {
      rest = after;
    }
  }
  return [...new Set(result)].sort();
}

export function containsLocalMethodCall(code: string, method: string): boolean {
  // word-boundary anchored so `this.local(` and `local(` match but
  // `rebuild(` / `mylocal(` do not.
  return new RegExp(`\\b${method}\\s*\\(`).test(code);
}

export function extractMethods(source: string): MethodInfo[] {
  const lines = source.split("\n");
  const methods: MethodInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("class ") || !trimmed.includes("{") || !trimmed.includes("(")) continue;
    const paren = trimmed.indexOf("(");
    const beforeParen = trimmed.slice(0, paren).trim();
    const methodName = beforeParen.split(/\s+/).pop();
    if (!methodName || !isIdentifier(methodName)) continue;
    if (["if", "for", "while", "switch", "catch", "return", "new"].includes(methodName)) continue;
    const params = trimmed.slice(paren + 1, trimmed.indexOf(")", paren)).trim();
    let brace = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      brace += (lines[j].match(/{/g) || []).length - (lines[j].match(/}/g) || []).length;
      end = j;
      if (brace <= 0) break;
    }
    const body = lines.slice(i, end + 1).join("\n");
    methods.push({
      name: methodName,
      signature: `${methodName}(${params})`,
      body,
      startLine: i + 1,
      endLine: end + 1,
    });
  }
  return methods;
}

export function confidenceForSource(source: string): "high" | "medium" | "inferred" {
  if (source.startsWith("platform:")) return "high";
  if (source === "inferred") return "inferred";
  return "medium";
}

export function truncateChars(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

export function stableEdgeId(from: string, to: string, kind: string, ownerFile: string, evidence: string): string {
  const key = `${from}|${to}|${kind}|${ownerFile}|${evidence}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}
