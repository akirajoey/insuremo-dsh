import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isSkillName } from "@deepseek-ai/dsh-skill";
import { SKILL_CATALOG_PATH } from "./paths.ts";
import { SKILL_SCENARIOS, type ImoSkillActions, type SkillActionResult, type SkillScenario } from "../skill-actions/types.ts";
import {
  SKILL_CATALOG_DESCRIPTION_MAX,
  SKILL_CATALOG_MAX_ENTRIES,
  SKILL_CATALOG_SCHEMA_VERSION,
  SKILLS_TOOL_SOURCE,
  type SkillCatalogEntry,
  type SkillCatalogSnapshot,
} from "../skill-actions/catalog.ts";

const JSON_TYPE = "application/json; charset=utf-8";
const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * Mount the cache-only Skills catalog read bridge. It deliberately calls
 * `getCatalog`, never `refreshCatalog`: GET must not make npx install a tool,
 * contact a registry, or otherwise perform an implicit network operation.
 */
export function mountSkillCatalogRoute(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: "exact",
    path: SKILL_CATALOG_PATH,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        writeJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "skill catalog accepts GET only" } }, req.method === "HEAD");
        return;
      }
      const actions = ctx.get("imoSkillActions" as never) as unknown as Pick<ImoSkillActions, "getCatalog"> | undefined;
      if (actions === undefined || typeof actions.getCatalog !== "function") {
        writeJson(res, 503, { ok: false, error: { code: "service-unavailable", message: "Skills catalog service is unavailable" } }, req.method === "HEAD");
        return;
      }
      const controller = new AbortController();
      const onClose = (): void => controller.abort();
      res.on("close", onClose);
      void (async () => {
        try {
          const result = await actions.getCatalog(controller.signal);
          if (!result.ok) {
            writeJson(res, 200, { ok: false, error: safeError(result) }, req.method === "HEAD");
            return;
          }
          const snapshot = sanitizeSkillCatalogSnapshot(result.value);
          if (snapshot === undefined) {
            writeJson(res, 200, { ok: false, error: { code: "catalog-unavailable", message: "the trusted Skills catalog is unavailable" } }, req.method === "HEAD");
            return;
          }
          writeJson(res, 200, { ok: true, result: snapshot }, req.method === "HEAD");
        } catch {
          writeJson(res, 500, { ok: false, error: { code: "catalog-unavailable", message: "the trusted Skills catalog is unavailable" } }, req.method === "HEAD");
        } finally {
          res.off("close", onClose);
        }
      })();
    },
  });
}

/** Sanitize the face result before either read or explicit-refresh output. */
export function sanitizeSkillCatalogSnapshot(value: SkillCatalogSnapshot): SkillCatalogSnapshot | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as unknown as Record<string, unknown>;
  if (candidate.schemaVersion !== SKILL_CATALOG_SCHEMA_VERSION || candidate.source !== SKILLS_TOOL_SOURCE) return undefined;
  const status = candidate.status;
  if (status !== "ready" && status !== "empty") return undefined;
  const fetchedAt = candidate.fetchedAt;
  if (typeof fetchedAt !== "string" || fetchedAt.length > 64 || !Number.isFinite(Date.parse(fetchedAt))) return undefined;
  const expiresAt = candidate.expiresAt;
  if (typeof expiresAt !== "string" || expiresAt.length > 64 || !Number.isFinite(Date.parse(expiresAt))) return undefined;
  if (!Array.isArray(candidate.entries) || candidate.entries.length > SKILL_CATALOG_MAX_ENTRIES + SKILL_SCENARIOS.length) return undefined;
  const entries: SkillCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const raw of candidate.entries) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const entry = raw as Record<string, unknown>;
    if (entry.type === "scenario") {
      if (!isScenario(entry.name) || !safeDescription(entry.description)) return undefined;
      const key = `scenario:${entry.name}`;
      if (seen.has(key)) return undefined;
      seen.add(key);
      entries.push({ type: "scenario", name: entry.name, description: entry.description });
      continue;
    }
    const name = entry.name;
    const description = entry.description;
    if (entry.type !== "skill" || typeof name !== "string" || name.length > 128 || !isSkillName(name) || !safeDescription(description)) return undefined;
    const key = `skill:${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const group = entry.group;
    if (group !== undefined && !safeGroup(group)) return undefined;
    entries.push({ type: "skill", name, description, ...(group === undefined ? {} : { group }) });
  }
  const skillCount = entries.filter(entry => entry.type === "skill").length;
  if ((status === "empty") !== (skillCount === 0)) return undefined;
  return Object.freeze({
    schemaVersion: SKILL_CATALOG_SCHEMA_VERSION,
    status,
    source: SKILLS_TOOL_SOURCE,
    fetchedAt,
    expiresAt,
    entries: Object.freeze(entries),
  });
}

function isScenario(value: unknown): value is SkillScenario {
  return typeof value === "string" && SKILL_SCENARIOS.includes(value as SkillScenario);
}

function safeDescription(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= SKILL_CATALOG_DESCRIPTION_MAX && !/[\u0000-\u001F\u007F]/u.test(value);
}

function safeGroup(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9 _-]*$/u.test(value);
}

function safeError(result: Extract<SkillActionResult<SkillCatalogSnapshot>, { ok: false }>): { code: string; message: string } {
  const code = /^[a-z0-9-]{1,64}$/u.test(result.error.code) ? result.error.code : "catalog-unavailable";
  return { code, message: code === "catalog-unavailable" ? "the trusted Skills catalog is unavailable; refresh it explicitly" : "the Skills catalog could not be read" };
}

function writeJson(res: ServerResponse, status: number, payload: unknown, head: boolean): void {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    res.writeHead(503, {
      "Content-Type": JSON_TYPE,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(head ? undefined : JSON.stringify({ ok: false, error: { code: "catalog-unavailable", message: "the Skills catalog response is too large" } }));
    return;
  }
  res.writeHead(status, {
    "Content-Type": JSON_TYPE,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(head ? undefined : body);
}
