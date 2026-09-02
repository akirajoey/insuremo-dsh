import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isSkillName } from "@deepseek-ai/dsh-skill";
import { SKILL_SCENARIOS, type SkillScenario } from "../skill-actions/types.ts";
import { OVERVIEW_PATH } from "./paths.ts";

const JSON_TYPE = "application/json; charset=utf-8";
const MAX_ACTION_BODY_BYTES = 8 * 1024;
const ACTION_HEADER = "x-workbench-action";
/** Every POST shares one prefix under the overview read path's sibling. */
const ACTIONS_PREFIX = `${OVERVIEW_PATH}/actions`;

/**
 * Uniform action envelope: UI-inline-renderable errors — human-readable
 * message with fixed machine code; `detail` carries a sanitized summary
 * (digests/codes/counts), never raw stdout or tokens.
 */
export type ActionOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly detail?: string } };

type BodyParse = { ok: true; value: Record<string, unknown> } | { ok: false; status: 400 | 403 | 413; code: string; message: string };

/** Same-origin write gate (runs before any service call). */
function sameOriginGate(req: IncomingMessage): { ok: true } | { ok: false; status: 400 | 403; code: string; message: string } {
  const host = typeof req.headers.host === "string" ? req.headers.host : undefined;
  if (host === undefined || host.length === 0) {
    return { ok: false, status: 403, code: "origin-required", message: "request must arrive from the Workbench UI (host header missing)" };
  }
  const originHeader = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const refererHeader = typeof req.headers.referer === "string" ? req.headers.referer : undefined;
  if (originHeader === undefined && refererHeader === undefined) {
    return { ok: false, status: 403, code: "origin-required", message: "Origin or Referer header is required for write actions" };
  }
  for (const header of [originHeader, refererHeader]) {
    if (header === undefined) continue;
    let parsed: URL;
    try { parsed = new URL(header); } catch {
      return { ok: false, status: 403, code: "origin-invalid", message: "Origin/Referer header is not a valid URL" };
    }
    if (parsed.host !== host) {
      return { ok: false, status: 403, code: "origin-mismatch", message: `write actions must come from the Workbench host (${host})` };
    }
  }
  if (req.headers[ACTION_HEADER] !== "1") {
    return { ok: false, status: 403, code: "action-header-required", message: "X-Workbench-Action: 1 header is required for write actions" };
  }
  const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return { ok: false, status: 400, code: "content-type", message: "Content-Type must be application/json" };
  }
  return { ok: true };
}

async function readBody(req: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false; status: 413; code: string; message: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_ACTION_BODY_BYTES) return { ok: false, status: 413, code: "body-too-large", message: "request body exceeds the 8KB action limit" };
    chunks.push(chunk as Buffer);
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

function parseBody(text: string): BodyParse {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, status: 400, code: "body-shape", message: "request body must be a JSON object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400, code: "body-json", message: "request body is not valid JSON" };
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": JSON_TYPE,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

function clipDetail(value: string): string {
  return value.length > 300 ? `${value.slice(0, 299)}…` : value;
}

type Handler = (body: Record<string, unknown>, signal: AbortSignal) => Promise<ActionOutcome<unknown>>;

/** One action route: gate + body + handler with sanitized error mapping. */
function actionRoute(path: string, handler: Handler): { path: string; handle(req: IncomingMessage, res: ServerResponse): void } {
  return {
    path,
    handle(req, res) {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "write actions accept POST only" } });
        return;
      }
      const gate = sameOriginGate(req);
      if (!gate.ok) {
        sendJson(res, gate.status, { ok: false, error: { code: gate.code, message: gate.message } });
        return;
      }
      const controller = new AbortController();
      const onClose = (): void => controller.abort();
      res.on("close", onClose);
      void (async () => {
        try {
          const body = await readBody(req);
          if (!body.ok) {
            sendJson(res, body.status, { ok: false, error: { code: body.code, message: body.message } });
            return;
          }
          const parsed = parseBody(body.text);
          if (!parsed.ok) {
            sendJson(res, parsed.status, { ok: false, error: { code: parsed.code, message: parsed.message } });
            return;
          }
          const outcome = await handler(parsed.value, controller.signal);
          if (outcome.ok) sendJson(res, 200, { ok: true, result: outcome.result });
          else sendJson(res, 200, { ok: false, error: { code: outcome.error.code, message: outcome.error.message, ...(outcome.error.detail === undefined ? {} : { detail: clipDetail(outcome.error.detail) }) } });
        } catch {
          sendJson(res, 500, { ok: false, error: { code: "internal", message: "action failed unexpectedly" } });
        } finally {
          res.off("close", onClose);
        }
      })();
    },
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseScenario(value: unknown): SkillScenario | undefined {
  return typeof value === "string" && SKILL_SCENARIOS.includes(value as SkillScenario) ? value as SkillScenario : undefined;
}

function boundedNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((name): name is string => typeof name === "string" && isSkillName(name)))].slice(0, 100);
}

/** Map a face error object ({code,message}) into the action envelope. */
function faceError(error: { code?: string; message?: string } | undefined, fallback: string): { ok: false; error: { code: string; message: string; detail?: string } } {
  const code = typeof error?.code === "string" && /^[a-z0-9-]{1,64}$/.test(error.code) ? error.code : fallback;
  const message = typeof error?.message === "string" && error.message.length > 0 ? error.message : fallback;
  return { ok: false, error: { code, message } };
}

/**
 * Mount the same-origin write bridge (TASK-039 direct-execution form): the
 * InsureMO local CLI actions run immediately through the services' direct
 * kernels — no operation-log approval chain. Every route keeps the
 * Origin/Referer + X-Workbench-Action + JSON/8KB gate; responses are
 * no-store, never CORS.
 */
export function mountWriteRoutes(ctx: Context): () => void {
  const disposers: Array<() => void> = [];
  const register = (route: { path: string; handle(req: IncomingMessage, res: ServerResponse): void }): void => {
    disposers.push(ctx.webServer.register({
      kind: "exact",
      path: route.path,
      handler: (req, res) => route.handle(req, res),
    }));
  };

  // imo-upgrade: direct one-shot kernel (no operation record).
  register(actionRoute(`${ACTIONS_PREFIX}/imo-upgrade`, async (body, signal) => {
    const upgrade = ctx.get("imoUpgrade" as never) as unknown as {
      upgradeStatus(): { running: boolean };
      executeDirect(targetVersion: string | undefined, signal?: AbortSignal): Promise<
        | { ok: true; receipt: { status: string; before: string; after: string } }
        | { ok: false; error: { code?: string; message?: string } }
      >;
    } | undefined;
    if (upgrade === undefined) return faceError(undefined, "service-unavailable");
    if (upgrade.upgradeStatus().running) return faceError({ code: "busy", message: "an IMO upgrade is already running" }, "busy");
    const targetVersion = str(body.targetVersion);
    try {
      const executed = await upgrade.executeDirect(targetVersion, signal);
      if (!executed.ok) return faceError(executed.error, "upgrade-failed");
      return { ok: true, result: { status: executed.receipt.status, currentVersion: executed.receipt.after, targetVersion: executed.receipt.after } };
    } catch {
      return faceError(undefined, "upgrade-failed");
    }
  }));

  // imo-install: one-shot installer (TASK-076). The POST body is ignored:
  // registry, scope, and package are service-side constants, so no client
  // input can reach the spawned argv.
  register(actionRoute(`${ACTIONS_PREFIX}/imo-install`, async (_body, signal) => {
    const install = ctx.get("imoInstall" as never) as unknown as {
      installStatus(): { running: boolean };
      install(signal?: AbortSignal): Promise<
        | { ok: true; receipt: { status: string; packageManager: string; after: string | null } }
        | { ok: false; error: { code?: string; message?: string } }
      >;
    } | undefined;
    if (install === undefined) return faceError(undefined, "service-unavailable");
    if (install.installStatus().running) return faceError({ code: "busy", message: "an IMO install is already running" }, "busy");
    try {
      const outcome = await install.install(signal);
      if (!outcome.ok) return faceError(outcome.error, "install-failed");
      return { ok: true, result: { status: outcome.receipt.status, packageManager: outcome.receipt.packageManager, currentVersion: outcome.receipt.after } };
    } catch {
      return faceError(undefined, "install-failed");
    }
  }));

  // skill-activation: durable activation domain (unchanged semantics).
  register(actionRoute(`${ACTIONS_PREFIX}/skill-activation`, async (body, signal) => {
    const activation = ctx.get("imoSkillActivation" as never) as unknown as {
      snapshot(installedNames: readonly string[], signal?: AbortSignal): Promise<{ enabled: readonly string[]; disabled: readonly string[]; revision: number }>;
    } | undefined;
    if (activation === undefined) return faceError(undefined, "service-unavailable");
    const name = str(body.name);
    if (name === undefined) return faceError({ code: "invalid-input", message: "skill name is required" }, "invalid-input");
    if (typeof body.enabled !== "boolean") return faceError({ code: "invalid-input", message: "enabled must be a boolean" }, "invalid-input");
    const expectedRevision = typeof body.expectedRevision === "number" && Number.isInteger(body.expectedRevision) ? body.expectedRevision : undefined;
    void activation;
    void signal;
    const controller = optionsActivationController(ctx);
    if (controller === undefined) return faceError({ code: "service-unavailable", message: "activation controller unavailable" }, "service-unavailable");
    try {
      const snapshot = await controller.setEnabled(name, body.enabled, [name], expectedRevision) as { revision: number };
      return { ok: true, result: { name, enabled: body.enabled, revision: snapshot.revision } };
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === "string" ? String((error as { code: string }).code) : "activation-failed";
      const message = error instanceof Error && error.message.length > 0 ? error.message : "skill activation failed";
      return faceError({ code: /^[a-z0-9-]{1,64}$/.test(code) ? code : "activation-failed", message }, "activation-failed");
    }
  }));

  // skill-update: whole-inventory update, direct kernel.
  register(actionRoute(`${ACTIONS_PREFIX}/skill-update`, async (_body, signal) => {
    const actions = ctx.get("imoSkillActions" as never) as unknown as DirectSkillActionsFace | undefined;
    if (actions === undefined) return faceError(undefined, "service-unavailable");
    const outcome = await actions.runDirect({ kind: "skill-update" }, signal);
    return directSkillOutcome(outcome);
  }));

  // skill-install: scenario sync is intentionally server-owned: source,
  // agent, selected skills, registry and argv are not accepted from the UI.
  register(actionRoute(`${ACTIONS_PREFIX}/skill-install`, async (body, signal) => {
    const actions = ctx.get("imoSkillActions" as never) as unknown as DirectSkillActionsFace | undefined;
    if (actions === undefined) return faceError(undefined, "service-unavailable");
    const scenario = parseScenario(body.scenario);
    if (scenario === undefined) return faceError({ code: "invalid-input", message: "scenario is not in the built-in allowlist" }, "invalid-input");
    const outcome = await actions.runDirect({ kind: "skill-install", source: { type: "scenario", scenario }, agent: "universal", skills: [] }, signal);
    return directSkillOutcome(outcome);
  }));

  // skill-remove: direct remove (new in TASK-039).
  register(actionRoute(`${ACTIONS_PREFIX}/skill-remove`, async (body, signal) => {
    const actions = ctx.get("imoSkillActions" as never) as unknown as DirectSkillActionsFace | undefined;
    if (actions === undefined) return faceError(undefined, "service-unavailable");
    const name = str(body.name);
    if (name === undefined) return faceError({ code: "invalid-input", message: "skill name is required" }, "invalid-input");
    const outcome = await actions.runDirect({ kind: "skill-remove", agent: "universal", names: [name] }, signal);
    return directSkillOutcome(outcome);
  }));

  // active-profile: Workbench-owned selection. It validates the fresh
  // sanitized inventory and never invokes the IMO default-profile command.
  register(actionRoute(`${ACTIONS_PREFIX}/active-profile`, async (body, signal) => {
    const active = ctx.get("imoActiveProfile" as never) as { select(name: string, signal?: AbortSignal): Promise<{ ok: true; value: { activeProfileName: string | null; revision: number } } | { ok: false; error: { code?: string; message?: string } }> } | undefined;
    if (active === undefined) return faceError(undefined, "service-unavailable");
    const profile = str(body.profile);
    if (profile === undefined) return faceError({ code: "invalid-input", message: "profile is required" }, "invalid-input");
    const selected = await active.select(profile, signal);
    if (!selected.ok) return faceError(selected.error, "action-failed");
    return { ok: true, result: { status: selected.value.activeProfileName === profile ? "completed" : "none", profile, revision: selected.value.revision } };
  }));

  // default-profile: direct one-shot switch, no approval chain (legacy explicit workflow).
  register(actionRoute(`${ACTIONS_PREFIX}/default-profile`, async (body, signal) => {
    const authActions = ctx.get("imoAuthActions" as never) as unknown as {
      runDirectDefaultSwitch(input: { profile: string }, signal?: AbortSignal): Promise<
        | { ok: true; receipt: { status: string } }
        | { ok: false; error: { code?: string; message?: string } }
      >;
    } | undefined;
    if (authActions === undefined) return faceError(undefined, "service-unavailable");
    const profile = str(body.profile);
    if (profile === undefined) return faceError({ code: "invalid-input", message: "profile is required" }, "invalid-input");
    try {
      const executed = await authActions.runDirectDefaultSwitch({ profile }, signal);
      if (!executed.ok) return faceError(executed.error, "action-failed");
      return { ok: true, result: { status: executed.receipt.status, profile } };
    } catch {
      return faceError(undefined, "action-failed");
    }
  }));

  return () => { for (const dispose of disposers) dispose(); };
}

interface DirectSkillReceipt {
  status: string;
  beforeCount?: number;
  afterCount?: number;
  added?: readonly string[];
  removed?: readonly string[];
  updated?: readonly string[];
}

interface DirectSkillActionsFace {
  runDirect(input: { kind: string; source?: unknown; agent?: string; skills?: readonly string[]; names?: readonly string[] }, signal?: AbortSignal): Promise<
    | { ok: true; receipt: DirectSkillReceipt }
    | { ok: false; error: { code?: string; message?: string } }
  >;
}

function directSkillOutcome(outcome: Awaited<ReturnType<DirectSkillActionsFace["runDirect"]>>): ActionOutcome<unknown> {
  if (!outcome.ok) return faceError(outcome.error, "action-failed");
  // A receipt is evidence even when the mutation failed or was partial. Keep
  // the structured diff in the result; the UI must inspect status explicitly.
  return { ok: true, result: directSkillResult(outcome.receipt) };
}

function directSkillResult(receipt: DirectSkillReceipt): Record<string, unknown> {
  // The three diff arrays are always reported separately (never a legacy
  // collapsed "names"); counts ride along only when the receipt has them.
  return {
    status: receipt.status,
    ...(receipt.beforeCount === undefined ? {} : { beforeCount: receipt.beforeCount }),
    ...(receipt.afterCount === undefined ? {} : { afterCount: receipt.afterCount }),
    added: boundedNames(receipt.added ?? []),
    updated: boundedNames(receipt.updated ?? []),
    removed: boundedNames(receipt.removed ?? []),
  };
}

/** Activation controller seam resolved through the composed context. */
function optionsActivationController(ctx: Context): { setEnabled(name: string, enabled: boolean, installedNames: readonly string[], expectedRevision?: number): Promise<unknown> } | undefined {
  const holder = (ctx as unknown as { __insuremoActivationController?: { setEnabled(name: string, enabled: boolean, installedNames: readonly string[], expectedRevision?: number): Promise<unknown> } }).__insuremoActivationController;
  return holder;
}
