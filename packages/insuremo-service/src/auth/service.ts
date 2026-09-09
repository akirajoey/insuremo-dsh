import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { lstat, readdir, rmdir } from "node:fs/promises";
import { lstatSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Config, resolveConfig, type Config as ImoConfig } from "../config.ts";
import { runCapture, type RunFailure } from "../run.ts";
import { AuthLease, type AuthCacheEntry } from "./lease.ts";
import {
  authStatusFromText,
  isRecord,
  parseDefaultProfile,
  profileView,
  rawString,
  safeAuthString,
  safeEndpoint,
  safeReason,
  safeStatus,
  safeTenantDomain,
} from "./sanitize.ts";
import {
  AUTH_CACHE_INVALIDATED_EVENT,
  AUTH_PREPARE_INVALIDATED_CODE,
  AUTH_SERVICE_DISPOSED_CODE,
  type ImoAuth,
  type ImoAuthCacheStatus,
  type ImoAuthDefaultProfile,
  type ImoAuthError,
  type ImoAuthInvalidation,
  type ImoAuthInvalidateRequest,
  type ImoAuthLease,
  type ImoAuthPrepareRequest,
  type ImoAuthProfileList,
  type ImoAuthProfilesFast,
  type ImoAuthProfileView,
  type ImoAuthResult,
  type ImoAuthSecret,
  type ImoAuthValidation,
} from "./types.ts";
import {
  LIST_CACHE_TTL_MS,
  authCacheKey,
  authCacheMatches,
  authLifecycleError,
  authParseError,
  authRunError,
  authStatusError,
  type PendingAuthPrepare,
} from "./service-helpers.ts";
import { resolveWorkspace, workspaceScopeKey } from "./workspace.ts";

interface AuthScope {
  readonly workspaceId?: string;
  /** Canonical cwd selected by the trusted registry or private global dir. */
  readonly cwd: string;
  /** Includes workspace identity and canonical cwd; never just profile/env. */
  readonly key: string;
}

type ScopeResult =
  | { readonly ok: true; readonly value: AuthScope }
  | { readonly ok: false; readonly error: ImoAuthError };

export class ImoAuthService extends Service implements ImoAuth {
  static inject = ["subprocess"];
  static Config = Config;

  private readonly config: ImoConfig;
  #cache = new Map<string, AuthCacheEntry>();
  #listCache = new Map<string, { readonly at: number; readonly value: ImoAuthResult<ImoAuthProfileList> }>();
  #listInflight = new Map<string, Promise<ImoAuthResult<ImoAuthProfileList>>>();
  #defaultCache = new Map<string, { readonly at: number; readonly value: ImoAuthResult<ImoAuthDefaultProfile> }>();
  #defaultInflight = new Map<string, Promise<ImoAuthResult<ImoAuthDefaultProfile>>>();
  #inflight = new Map<string, PendingAuthPrepare>();
  #pendingMeta = new Map<string, { profile: string | null; env: string | null }>();
  #generations = new Map<string, number>();
  #globalCwd: string | undefined;
  #fastCacheEpoch = 0;
  #disposed = false;
  #epoch = 0;

  constructor(ctx: Context, config: Partial<ImoConfig> = {}) {
    super(ctx, "imoAuth");
    this.config = resolveConfig(config);
    // Cordis exposes service methods through a shadow proxy; bind methods that
    // access ECMAScript private slots back to the owning service instance.
    this.listProfiles = this.listProfiles.bind(this);
    this.listProfilesCached = this.listProfilesCached.bind(this);
    this.profilesFast = this.profilesFast.bind(this);
    this.defaultProfileCached = this.defaultProfileCached.bind(this);
    this.defaultProfile = this.defaultProfile.bind(this);
    this.validate = this.validate.bind(this);
    this.prepare = this.prepare.bind(this);
    this.invalidate = this.invalidate.bind(this);
    this.cacheStatus = this.cacheStatus.bind(this);
    this.ctx.effect(() => () => this.clearCache(), "imoAuth.cache");
  }

  async listProfiles(signal?: AbortSignal, workspaceId?: string | null): Promise<ImoAuthResult<ImoAuthProfileList>> {
    const scope = this.resolveScope(workspaceId);
    if (!scope.ok) return scope;
    const args = ["auth", "profile", "list", "--format", "json"] as const;
    const run = await runCapture(this.ctx.subprocess, {
      command: this.config.command,
      args,
      timeoutMs: this.config.timeoutMs,
      signal,
      cwd: scope.value.cwd,
    });
    if (!run.ok) return { ok: false, error: authRunError(run.error, this.config.command, "profile list") };
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.value.stdout.text);
    } catch {
      return authParseError(this.config.command, "profile list", run.value.stdoutDigest, run.value.stderrDigest);
    }
    if (!Array.isArray(parsed)) {
      return authParseError(this.config.command, "profile list", run.value.stdoutDigest, run.value.stderrDigest);
    }
    const profiles = sanitizeProfiles(parsed);
    return { ok: true, value: { profiles, stdoutDigest: run.value.stdoutDigest } };
  }

  async defaultProfile(signal?: AbortSignal, workspaceId?: string | null): Promise<ImoAuthResult<ImoAuthDefaultProfile>> {
    const scope = this.resolveScope(workspaceId);
    if (!scope.ok) return scope;
    return this.defaultProfileAt(scope.value, signal);
  }

  /**
   * Cached default-profile (TASK-043 fix-3): 60s TTL + in-flight coalescing,
   * partitioned by the trusted workspace cwd.
   */
  async defaultProfileCached(signal?: AbortSignal, workspaceId?: string | null): Promise<ImoAuthResult<ImoAuthDefaultProfile>> {
    const scope = this.resolveScope(workspaceId);
    if (!scope.ok) return scope;
    return this.defaultProfileCachedAt(scope.value, signal);
  }

  private async defaultProfileCachedAt(scope: AuthScope, signal?: AbortSignal): Promise<ImoAuthResult<ImoAuthDefaultProfile>> {
    const cached = this.#defaultCache.get(scope.key);
    const now = Date.now();
    if (cached !== undefined && now - cached.at <= LIST_CACHE_TTL_MS) return cached.value;
    const existing = this.#defaultInflight.get(scope.key);
    if (existing !== undefined) return existing;
    const epoch = this.#fastCacheEpoch;
    const inflight = this.defaultProfileAt(scope, signal).then((result) => {
      if (this.#defaultInflight.get(scope.key) === inflight) this.#defaultInflight.delete(scope.key);
      if (epoch === this.#fastCacheEpoch && result.ok) this.#defaultCache.set(scope.key, { at: Date.now(), value: result });
      return result;
    }, (error) => {
      if (this.#defaultInflight.get(scope.key) === inflight) this.#defaultInflight.delete(scope.key);
      throw error;
    });
    this.#defaultInflight.set(scope.key, inflight);
    return inflight;
  }

  /**
   * Fast snapshot from the SANITIZED CLI cache only: no direct credential-store
   * read. Each workspace has an independent list/default cache namespace.
   */
  async listProfilesCached(signal?: AbortSignal, workspaceId?: string | null): Promise<ImoAuthResult<ImoAuthProfileList>> {
    const scope = this.resolveScope(workspaceId);
    if (!scope.ok) return scope;
    return this.listProfilesCachedAt(scope.value, signal);
  }

  private async listProfilesCachedAt(scope: AuthScope, signal?: AbortSignal): Promise<ImoAuthResult<ImoAuthProfileList>> {
    const cached = this.#listCache.get(scope.key);
    const now = Date.now();
    if (cached !== undefined && now - cached.at <= LIST_CACHE_TTL_MS) return cached.value;
    const existing = this.#listInflight.get(scope.key);
    if (existing !== undefined) return existing;
    const epoch = this.#fastCacheEpoch;
    const inflight = this.listProfilesAt(scope, signal).then((result) => {
      if (this.#listInflight.get(scope.key) === inflight) this.#listInflight.delete(scope.key);
      if (epoch === this.#fastCacheEpoch && result.ok) this.#listCache.set(scope.key, { at: Date.now(), value: result });
      return result;
    }, (error) => {
      if (this.#listInflight.get(scope.key) === inflight) this.#listInflight.delete(scope.key);
      throw error;
    });
    this.#listInflight.set(scope.key, inflight);
    return inflight;
  }

  async profilesFast(signal?: AbortSignal, workspaceId?: string | null): Promise<ImoAuthResult<ImoAuthProfilesFast>> {
    const scope = this.resolveScope(workspaceId);
    if (!scope.ok) return scope;
    const cached = await this.listProfilesCachedAt(scope.value, signal);
    if (!cached.ok) return cached;
    const def = await this.defaultProfileCachedAt(scope.value, signal);
    const profiles = cached.value.profiles.map((profile) => {
      const isDefault = def.ok ? def.value.profileName === profile.profileName : profile.isDefault === true;
      return isDefault === (profile.isDefault === true) ? profile : { ...profile, isDefault };
    });
    return { ok: true, value: { profiles, defaultProfile: def.ok ? def.value.profileName : null, stale: false } };
  }

  async validate(profile?: string, signal?: AbortSignal, workspaceId?: string | null): Promise<ImoAuthResult<ImoAuthValidation>> {
    const scope = this.resolveScope(workspaceId);
    if (!scope.ok) return scope;
    const args = ["auth", "profile", "validate", ...(profile === undefined ? [] : ["--profile", profile]), "--json"] as const;
    const run = await runCapture(this.ctx.subprocess, {
      command: this.config.command,
      args,
      timeoutMs: this.config.timeoutMs,
      signal,
      cwd: scope.value.cwd,
    });
    if (!run.ok) {
      const error = authRunError(run.error, this.config.command, "profile validate", true);
      if (error.code === "invalid-auth") this.invalidate({ profile: profile ?? null, reason: "unauthorized" });
      return { ok: false, error };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.value.stdout.text);
    } catch {
      return authParseError(this.config.command, "profile validate", run.value.stdoutDigest, run.value.stderrDigest);
    }
    if (!isRecord(parsed)) {
      return authParseError(this.config.command, "profile validate", run.value.stdoutDigest, run.value.stderrDigest);
    }
    const status = safeStatus(parsed.status);
    const reason = safeReason(parsed.reason);
    const statusCode = authStatusFromText(
      typeof parsed.status === "string" || typeof parsed.status === "number" ? String(parsed.status) : undefined,
      typeof parsed.reason === "string" ? parsed.reason : undefined,
      typeof parsed.code === "string" || typeof parsed.code === "number" ? String(parsed.code) : undefined,
    );
    if (statusCode !== undefined) {
      if (statusCode === "invalid-auth") this.invalidate({ profile: profile ?? null, reason: "unauthorized" });
      return authStatusError(statusCode, this.config.command, "profile validate", run.value.stdoutDigest, run.value.stderrDigest);
    }
    const profileName = rawString(parsed, "profile_name", "name") ?? safeAuthString(profile) ?? null;
    const valid = typeof parsed.valid === "boolean"
      ? parsed.valid
      : status === "valid" || status === "ok";
    return {
      ok: true,
      value: {
        profileName,
        valid,
        ...(status === undefined ? {} : { status }),
        ...(reason === undefined ? {} : { reason }),
        checkedAt: new Date().toISOString(),
        stdoutDigest: run.value.stdoutDigest,
      },
    };
  }

  async prepare(
    request: ImoAuthPrepareRequest = {},
    signal?: AbortSignal,
  ): Promise<ImoAuthResult<ImoAuthLease>> {
    if (this.#disposed) return authLifecycleError(AUTH_SERVICE_DISPOSED_CODE, this.config.command);
    const scope = this.resolveScope(request.workspaceId);
    if (!scope.ok) return scope;
    const profile = request.profile ?? null;
    const env = request.env ?? null;
    const key = authCacheKey(profile, env, scope.value.key);
    const cached = this.#cache.get(key);
    if (cached !== undefined) return { ok: true, value: new AuthLease(cached, true) };
    const existing = this.#inflight.get(key);
    if (existing !== undefined) {
      const result = await existing.promise;
      if (this.#disposed) return authLifecycleError(AUTH_SERVICE_DISPOSED_CODE, this.config.command);
      return result.ok ? { ok: true, value: new AuthLease(result.value, true) } : result;
    }
    const pending: PendingAuthPrepare = {
      profile,
      env,
      epoch: this.#epoch,
      generation: this.#generations.get(key) ?? 0,
      invalidated: false,
      promise: Promise.resolve(authLifecycleError(AUTH_PREPARE_INVALIDATED_CODE, this.config.command)),
    };
    const raw = this.executePrepare(profile, env, scope.value, signal);
    pending.promise = raw.then((result) => this.finalizePrepare(key, pending, result)).finally(() => {
      if (this.#inflight.get(key) === pending) this.#inflight.delete(key);
      this.#pendingMeta.delete(key);
    });
    this.#inflight.set(key, pending);
    this.#pendingMeta.set(key, { profile, env });
    const result = await pending.promise;
    if (this.#disposed) return authLifecycleError(AUTH_SERVICE_DISPOSED_CODE, this.config.command);
    return result.ok ? { ok: true, value: new AuthLease(result.value, false) } : result;
  }

  invalidate(request: ImoAuthInvalidateRequest): ImoAuthInvalidation {
    if (this.#disposed) return { invalidated: 0, reason: request.reason };
    const keys = new Set<string>();
    let invalidated = 0;
    for (const [key, entry] of this.#cache) {
      if (!authCacheMatches(entry, request)) continue;
      keys.add(key);
      entry.cell.revoked = true;
      this.#cache.delete(key);
      invalidated += 1;
    }
    for (const [key, entry] of this.#pendingMeta) {
      if (!authCacheMatches(entry, request)) continue;
      keys.add(key);
      const pending = this.#inflight.get(key);
      if (pending !== undefined) pending.invalidated = true;
    }
    for (const key of keys) this.#generations.set(key, (this.#generations.get(key) ?? 0) + 1);
    this.#fastCacheEpoch += 1;
    this.#listCache.clear();
    this.#defaultCache.clear();
    // An in-flight read may still finish, but its old result is never reused:
    // invalidate the map entries before releasing the next caller.
    this.#listInflight.clear();
    this.#defaultInflight.clear();
    this.ctx.emit(AUTH_CACHE_INVALIDATED_EVENT, {
      ...(request.profile === undefined ? {} : { profile: request.profile }),
      ...(request.env === undefined ? {} : { env: request.env }),
      reason: request.reason,
      invalidated,
    });
    return { invalidated, reason: request.reason };
  }

  cacheStatus(): ImoAuthCacheStatus {
    return { size: this.#cache.size };
  }

  private resolveScope(workspaceId?: string | null): ScopeResult {
    if (this.#disposed) {
      return { ok: false, error: { code: AUTH_SERVICE_DISPOSED_CODE, message: `IMO auth scope failed: ${AUTH_SERVICE_DISPOSED_CODE}`, command: this.config.command } };
    }
    if (workspaceId !== undefined && workspaceId !== null) {
      const resolved = resolveWorkspace(this.ctx, workspaceId);
      if (!resolved.ok) {
        return { ok: false, error: { code: resolved.code, message: `IMO auth workspace failed: ${resolved.code}`, command: this.config.command } };
      }
      return { ok: true, value: { workspaceId: resolved.workspaceId, cwd: resolved.cwd, key: workspaceScopeKey(resolved.workspaceId, resolved.cwd) } };
    }
    let cwd: string;
    try {
      cwd = this.ensureGlobalCwd();
      if (!this.isPrivateGlobalCwd(cwd)) throw new Error("global auth cwd is not private");
    } catch {
      return { ok: false, error: { code: "workspace-unavailable", message: "IMO auth global workspace is unavailable", command: this.config.command } };
    }
    return { ok: true, value: { cwd, key: JSON.stringify(["global", cwd]) } };
  }

  private ensureGlobalCwd(): string {
    if (this.#globalCwd === undefined) {
      // mkdtemp creates a fresh 0700 directory. The service owns this exact
      // path and never points the CLI at the system temp parent itself.
      this.#globalCwd = mkdtempSync(join(tmpdir(), "icomposer-auth-global-"));
    }
    return this.#globalCwd;
  }

  private isPrivateGlobalCwd(cwd: string): boolean {
    const stat = lstatSync(cwd);
    if (!stat.isDirectory()) return false;
    const entries = readdirSync(cwd, { withFileTypes: true });
    return entries.every(entry => entry.name !== ".insuremo");
  }

  private async listProfilesAt(scope: AuthScope, signal?: AbortSignal): Promise<ImoAuthResult<ImoAuthProfileList>> {
    const args = ["auth", "profile", "list", "--format", "json"] as const;
    const run = await runCapture(this.ctx.subprocess, {
      command: this.config.command,
      args,
      timeoutMs: this.config.timeoutMs,
      signal,
      cwd: scope.cwd,
    });
    if (!run.ok) return { ok: false, error: authRunError(run.error, this.config.command, "profile list") };
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.value.stdout.text);
    } catch {
      return authParseError(this.config.command, "profile list", run.value.stdoutDigest, run.value.stderrDigest);
    }
    if (!Array.isArray(parsed)) {
      return authParseError(this.config.command, "profile list", run.value.stdoutDigest, run.value.stderrDigest);
    }
    const profiles = sanitizeProfiles(parsed);
    return { ok: true, value: { profiles, stdoutDigest: run.value.stdoutDigest } };
  }

  private async defaultProfileAt(scope: AuthScope, signal?: AbortSignal): Promise<ImoAuthResult<ImoAuthDefaultProfile>> {
    const args = ["auth", "default-profile", "get"] as const;
    const run = await runCapture(this.ctx.subprocess, {
      command: this.config.command,
      args,
      timeoutMs: this.config.timeoutMs,
      signal,
      cwd: scope.cwd,
    });
    if (!run.ok) return { ok: false, error: authRunError(run.error, this.config.command, "default profile") };
    const profileName = parseDefaultProfile(run.value.stdout.text);
    if (profileName === undefined) {
      return authParseError(this.config.command, "default profile", run.value.stdoutDigest, run.value.stderrDigest);
    }
    return { ok: true, value: { profileName, stdoutDigest: run.value.stdoutDigest } };
  }

  private async executePrepare(profile: string | null, env: string | null, scope: AuthScope, signal?: AbortSignal): Promise<ImoAuthResult<AuthCacheEntry>> {
    const args = [
      "auth",
      "prepare",
      ...(profile === null ? [] : ["--profile", profile]),
      ...(env === null ? [] : ["--env", env]),
      "--json",
    ] as const;
    const run = await runCapture(this.ctx.subprocess, {
      command: this.config.command,
      args,
      timeoutMs: this.config.timeoutMs,
      signal,
      cwd: scope.cwd,
    });
    if (!run.ok) return { ok: false, error: authRunError(run.error, this.config.command, "prepare") };
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.value.stdout.text);
    } catch {
      return authParseError(this.config.command, "prepare", run.value.stdoutDigest, run.value.stderrDigest);
    }
    if (!isRecord(parsed)) {
      return authParseError(this.config.command, "prepare", run.value.stdoutDigest, run.value.stderrDigest);
    }
    const accessToken = rawString(parsed, "access_token");
    if (accessToken === undefined) {
      return authParseError(this.config.command, "prepare", run.value.stdoutDigest, run.value.stderrDigest);
    }
    const profileName = rawString(parsed, "profile_name", "name") ?? profile ?? undefined;
    const envName = rawString(parsed, "env") ?? env ?? undefined;
    const envId = rawString(parsed, "env_id");
    const tenantCode = rawString(parsed, "tenant_code");
    const accountName = rawString(parsed, "account_name");
    const domain = rawString(parsed, "domain");
    const gateway = rawString(parsed, "gateway");
    const tenantDomain = rawString(parsed, "tenant_domain");
    const source = rawString(parsed, "source");
    const scopeName = rawString(parsed, "scope");
    const userSourceId = rawString(parsed, "user_source_id");
    const secret = Object.freeze({
      accessToken,
      ...(profileName === undefined ? {} : { profileName }),
      ...(envName === undefined ? {} : { env: envName }),
      ...(envId === undefined ? {} : { envId }),
      ...(tenantCode === undefined ? {} : { tenantCode }),
      ...(accountName === undefined ? {} : { accountName }),
      ...(domain === undefined ? {} : { domain }),
      ...(gateway === undefined ? {} : { gateway }),
      ...(tenantDomain === undefined ? {} : { tenantDomain }),
      ...(source === undefined ? {} : { source }),
      ...(scopeName === undefined ? {} : { scope: scopeName }),
      ...(userSourceId === undefined ? {} : { userSourceId }),
    }) as ImoAuthSecret;
    const view = Object.freeze({
      profileName: profileName ?? null,
      env: envName ?? null,
      envId: envId ?? null,
      tenantCode: tenantCode ?? null,
      accountName: accountName ?? null,
      domain: safeEndpoint(domain) ?? null,
      gateway: safeEndpoint(gateway) ?? null,
      tenantDomain: safeTenantDomain(tenantDomain) ?? null,
      source: source ?? null,
      scope: scopeName ?? null,
      userSourceId: userSourceId ?? null,
    });
    return {
      ok: true,
      value: {
        key: authCacheKey(profile, env, scope.key),
        profile,
        env,
        secret,
        view,
        createdAt: new Date().toISOString(),
        cell: { revoked: false },
      },
    };
  }

  private clearCache(): Promise<void> {
    this.#disposed = true;
    this.#epoch += 1;
    for (const entry of this.#cache.values()) entry.cell.revoked = true;
    for (const pending of this.#inflight.values()) pending.invalidated = true;
    this.#cache.clear();
    this.#inflight.clear();
    this.#pendingMeta.clear();
    this.#generations.clear();
    this.#fastCacheEpoch += 1;
    this.#listCache.clear();
    this.#listInflight.clear();
    this.#defaultCache.clear();
    this.#defaultInflight.clear();
    const owned = this.#globalCwd;
    this.#globalCwd = undefined;
    return owned === undefined ? Promise.resolve() : removeOwnedEmptyDirectory(owned);
  }

  private finalizePrepare(
    key: string,
    pending: PendingAuthPrepare,
    result: ImoAuthResult<AuthCacheEntry>,
  ): ImoAuthResult<AuthCacheEntry> {
    if (this.#disposed || pending.epoch !== this.#epoch) {
      return authLifecycleError(AUTH_SERVICE_DISPOSED_CODE, this.config.command);
    }
    if (pending.invalidated || (this.#generations.get(key) ?? 0) !== pending.generation) {
      return authLifecycleError(AUTH_PREPARE_INVALIDATED_CODE, this.config.command);
    }
    if (result.ok) this.replaceCache(key, result.value);
    return result;
  }

  private replaceCache(key: string, entry: AuthCacheEntry): void {
    const previous = this.#cache.get(key);
    if (previous !== undefined) previous.cell.revoked = true;
    this.#cache.set(key, entry);
  }
}

function compareProfilePriority(left: ImoAuthProfileView, right: ImoAuthProfileView): number {
  const leftRank = profileScopeRank(left);
  const rightRank = profileScopeRank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;
  // Unknown scope metadata is intentionally left in the CLI's original order
  // for backwards compatibility with old/mocked CLI output.
  return leftRank === 2 ? 0 : left.profileName.localeCompare(right.profileName);
}

function profileScopeRank(profile: ImoAuthProfileView): number {
  return profile.scope === "workspace" ? 0 : profile.scope === "global" ? 1 : 2;
}

/** Keep the CLI's project-over-global identity rule even for old CLI output. */
function sanitizeProfiles(rows: readonly unknown[]): readonly ImoAuthProfileView[] {
  const byName = new Map<string, ImoAuthProfileView>();
  for (const row of rows) {
    const profile = profileView(row);
    if (profile === null) continue;
    const previous = byName.get(profile.profileName);
    if (previous === undefined || profileScopeRank(profile) < profileScopeRank(previous)) {
      byName.set(profile.profileName, profile);
    }
  }
  return [...byName.values()].sort(compareProfilePriority);
}

async function removeOwnedEmptyDirectory(cwd: string): Promise<void> {
  try {
    const stat = await lstat(cwd);
    if (!stat.isDirectory()) return;
    if ((await readdir(cwd)).length !== 0) return;
    // rmdir is intentional: a tampered/non-empty directory is never removed
    // by a Workbench disposer.
    await rmdir(cwd);
  } catch {
    // Cleanup is best effort and must not mask service disposal.
  }
}
