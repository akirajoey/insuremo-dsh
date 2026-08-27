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

function lexicalBraceDelta(line: string): number {
  let delta = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (quote !== undefined) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "\"" || ch === "'") { quote = ch; continue; }
    if (ch === "/" && next === "/") break;
    if (ch === "{") delta++;
    if (ch === "}") delta--;
  }
  return delta;
}

function isDeclarationPrefix(prefix: string, methodName: string): boolean {
  if (["if", "for", "while", "switch", "catch", "return", "new"].includes(methodName)) return false;
  if (/\b(?:new|return)\b/.test(prefix) || prefix.includes("=") || prefix.trim().endsWith(".")) return false;
  const words = prefix.trim().split(/\s+/).filter(Boolean);
  return words.includes("def") || words.some(word => ["private", "protected", "public", "static", "final", "abstract"].includes(word)) || words.length >= 1;
}

/** Extract only class-body method declarations, not calls/constructors/closures. */
export function extractMethods(source: string): MethodInfo[] {
  const lines = source.split("\n");
  const methods: MethodInfo[] = [];
  let depth = 0;
  let classBodyDepth: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const beforeDepth = depth;
    const classMatch = /^(?:(?:public|private|protected|final|abstract|static)\s+)*class\s+[A-Za-z_][A-Za-z0-9_]*/.test(trimmed);
    if (classMatch && classBodyDepth === undefined && lexicalBraceDelta(line) > 0) classBodyDepth = beforeDepth + 1;
    const paren = trimmed.indexOf("(");
    if (paren >= 0 && trimmed.includes("{") && (classBodyDepth === undefined ? beforeDepth === 0 : beforeDepth === classBodyDepth)) {
      const beforeParen = trimmed.slice(0, paren).trim();
      const methodName = beforeParen.split(/\s+/).pop();
      const closeParen = trimmed.indexOf(")", paren);
      if (methodName && isIdentifier(methodName) && closeParen >= 0 && isDeclarationPrefix(beforeParen.slice(0, beforeParen.length - methodName.length), methodName)) {
        const params = trimmed.slice(paren + 1, closeParen).trim();
        let brace = lexicalBraceDelta(line);
        let end = i;
        for (let j = i + 1; j < lines.length && brace > 0; j++) {
          brace += lexicalBraceDelta(lines[j]);
          end = j;
        }
        if (brace <= 0) {
          const body = lines.slice(i, end + 1).join("\n");
          methods.push({ name: methodName, signature: `${methodName}(${params})`, body, startLine: i + 1, endLine: end + 1 });
        }
      }
    }
    depth += lexicalBraceDelta(line);
    if (depth < 0) depth = 0;
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
