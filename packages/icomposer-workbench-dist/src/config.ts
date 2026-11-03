import z from "@deepseek-ai/schemastery";
import { Config as InsuremoServiceConfig } from "../../insuremo-service/src/config.ts";

/**
 * Real nested loader schema for the aggregate (`WorkbenchDistService.Config`).
 *
 * Every field is an optional object. Object-level and leaf validators are
 * transform-based because schemastery's built-in messages echo the offending
 * value (`expected object but got …`, `expected number but got …`); with a real
 * config value that text would land in the fiber error log. The messages here
 * carry the field path and the rule only. `insuremoService` reuses the existing
 * Insuremo `Config` schema and rewrites the host's `but got …` tail, so its
 * defaults and clamps stay exactly as before (`resolveConfig` still normalizes
 * 300_000/5_000; it does not reject).
 *
 * `lifecycle`/`verify`/`write` come from one definition whose defaults match
 * their service constructors (`imo`, 30_000 ms); only the diagnostic prefix
 * differs so a rejection names the right field.
 */
const MAX_TIMER_MS = 2_147_483_647;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function reject(label: string, rule: string): never {
  throw new TypeError(`${label} ${rule}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip the host's `but got <value>` tail while keeping its path/rule prefix. */
function withoutValueEcho(error: unknown, fallback: string): TypeError {
  const message = error instanceof Error ? error.message : fallback;
  return new TypeError(message.replace(/ but got[\s\S]*$/, ""));
}

/**
 * Object-level field: reject a non-object before schemastery's native object
 * resolver can echo it, then validate the real nested shape (unknown keys are
 * still merged by the non-strict resolver).
 */
function objectField(prefix: string, shape: Record<string, unknown>) {
  const schema = z.object(shape);
  return z.transform(z.any(), (value) => {
    if (!isPlainObject(value)) reject(prefix, "must be an object");
    try {
      return schema(value as never);
    } catch (error) {
      throw withoutValueEcho(error, `${prefix} is invalid`);
    }
  });
}

const commandField = (label: string) => z.transform(z.any(), (value) => {
  if (typeof value !== "string" || value.length === 0) reject(label, "must be a non-empty string");
  if (CONTROL_CHARACTERS.test(value)) reject(label, "must not contain control characters");
  return value;
}).default("imo");

const timeoutField = (label: string) => z.transform(z.any(), (value) => {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    reject(label, "must be an integer");
  }
  if (value < 1 || value > MAX_TIMER_MS) reject(label, `must be between 1 and ${MAX_TIMER_MS}`);
  return value;
}).default(30_000);

/** Shared CLI sub-config definition; defaults match the service constructors. */
const createCliServiceConfig = (prefix: string) => objectField(prefix, {
  command: commandField(`${prefix}.command`),
  timeoutMs: timeoutField(`${prefix}.timeoutMs`),
});

export const cliServiceConfig = createCliServiceConfig("$.cli");

/**
 * Insuremo's existing schema, reused unchanged, with the host's value echo
 * removed from validation messages. No field is re-declared here.
 */
const insuremoServiceField = z.transform(z.any(), (value) => {
  if (!isPlainObject(value)) reject("$.insuremoService", "must be an object");
  try {
    return InsuremoServiceConfig(value as never, { path: ["insuremoService"] });
  } catch (error) {
    throw withoutValueEcho(error, "$.insuremoService is invalid");
  }
}).default({});

/** Loader-validated aggregate config; each field may be omitted. */
export const workbenchConfigSchema = objectField("$", {
  lifecycle: createCliServiceConfig("$.lifecycle").default({}),
  verify: createCliServiceConfig("$.verify").default({}),
  write: createCliServiceConfig("$.write").default({}),
  insuremoService: insuremoServiceField,
});

const INSUREMO_KEYS = [
  "command",
  "timeoutMs",
  "skillActionTimeoutMs",
  "upgradeTimeoutMs",
  "smokeCommands",
  "allowedGitHosts",
  "overviewTtlMs",
  "skillOverlayEnabled",
  "skillOverlayNames",
] as const;

/** Known keys per top-level field (unknown keys stay merged, D4 compatibility). */
const KNOWN_KEYS: Record<string, readonly string[]> = {
  lifecycle: ["command", "timeoutMs"],
  verify: ["command", "timeoutMs"],
  write: ["command", "timeoutMs"],
  insuremoService: INSUREMO_KEYS,
};

const SAFE_KEY = /^[A-Za-z0-9_-]{1,64}$/;

function keyText(key: string): string {
  return SAFE_KEY.test(key) ? key : "<unprintable-key>";
}

/**
 * Unknown key paths retained by the non-strict object resolver. Returns key
 * names only — never values — so a secret accidentally written as a key name
 * cannot reach the log verbatim; unsafe characters are redacted. Detection is
 * one level deep inside the four known top-level fields: a deeper unknown
 * object (e.g. `lifecycle.surprise.deeper`) is reported as its first unknown
 * segment only. That bound keeps the warning short and value-free.
 */
export function unknownConfigKeys(config: unknown): string[] {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    const known = KNOWN_KEYS[key];
    if (known === undefined) {
      found.push(keyText(key));
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    for (const nested of Object.keys(value as Record<string, unknown>)) {
      if (!known.includes(nested)) found.push(`${keyText(key)}.${keyText(nested)}`);
    }
  }
  return found.slice(0, 20);
}
