import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { Config, resolveConfig, type Config as ImoConfig } from "../config.ts";
import { digest, runCapture, type RunFailure } from "../run.ts";
import {
  listEnvironmentIds as listEnvironmentIdsFromCli,
  resolveEnvironmentHint as resolveEnvironmentHintFromCli,
  type EnvironmentError,
  type ImoEnvironmentList,
  type ImoEnvironmentResolution,
} from "./environment.ts";
import { finalizeAction } from "./action-finalize.ts";
import {
  canonicalActionParamsDigest,
  normalizeDefault,
  normalizePortalLogin,
  normalizeRemote,
  validateSourceProfile,
} from "./action-validation.ts";
import type { ImoAuthError, ImoAuthProfileView } from "./types.ts";

import {
  IMO_AUTH_DEFAULT_KIND,
  IMO_AUTH_LOGIN_KIND,
  IMO_AUTH_REMOTE_KIND,
} from "./action-types.ts";
import type {
  DefaultProfileSwitchRequest,
  ImoAuthActionError,
  ImoAuthActionErrorCode,
  ImoAuthActionExecution,
  ImoAuthActionKind,
  ImoAuthActionRequest,
  ImoAuthActionResult,
  ImoAuthActionStatus,
  ImoAuthActions,
  NormalizedDefault,
  NormalizedLogin,
  NormalizedRemote,
  PendingAction,
  PortalLoginRequest,
  ReceiptInput,
  RemoteProfileRequest,
} from "./action-types.ts";

/** Approval-gated portal login, remote-profile, and default-profile actions. */
export class ImoAuthActionsService extends Service implements ImoAuthActions {
  static inject = ["imoAuth", "operationLog", "subprocess"];
  static Config = Config;

  private readonly config: ImoConfig;
  #pending = new Map<string, PendingAction>();
  #environmentIdsBySource = new Map<string, Set<string>>();
  #environmentGenerations = new Map<string, number>();
  #running: { operationId: string; kind: ImoAuthActionKind } | null = null;
  #disposed = false;

  constructor(ctx: Context, config: Partial<ImoConfig> = {}) {
    super(ctx, "imoAuthActions");
    this.config = resolveConfig(config);
    this.listEnvironmentIds = this.listEnvironmentIds.bind(this);
    this.resolveEnvironmentHint = this.resolveEnvironmentHint.bind(this);
    this.requestPortalLogin = this.requestPortalLogin.bind(this);
    this.executePortalLogin = this.executePortalLogin.bind(this);
    this.requestRemote = this.requestRemote.bind(this);
    this.executeRemote = this.executeRemote.bind(this);
    this.requestDefaultSwitch = this.requestDefaultSwitch.bind(this);
    this.executeDefaultSwitch = this.executeDefaultSwitch.bind(this);
    this.executeAction = this.executeAction.bind(this);
    this.actionStatus = this.actionStatus.bind(this);
    this.ctx.effect(() => () => {
      this.#disposed = true;
      this.#pending.clear();
      this.#environmentIdsBySource.clear();
      this.#environmentGenerations.clear();
      this.#running = null;
    }, "imoAuthActions.state");
  }

  async listEnvironmentIds(sourceProfile?: string, signal?: AbortSignal): Promise<ImoAuthActionResult<ImoEnvironmentList>> {
    const profile = validateSourceProfile(sourceProfile);
    if (!profile.ok) return profile;
    const key = sourceKey(profile.value);
    const generation = this.beginEnvironmentQuery(key);
    const result = await listEnvironmentIdsFromCli(
      this.ctx.subprocess,
      this.config.command,
      this.config.timeoutMs,
      profile.value,
      signal,
    );
    if (!result.ok) return { ok: false, error: mapEnvironmentError(result.error) };
    if (this.#environmentGenerations.get(key) === generation) {
      this.#environmentIdsBySource.set(key, new Set(result.value.environmentIds));
    }
    return result;
  }

  async resolveEnvironmentHint(hint: string, sourceProfile?: string, signal?: AbortSignal): Promise<ImoAuthActionResult<ImoEnvironmentResolution>> {
    const profile = validateSourceProfile(sourceProfile);
    if (!profile.ok) return profile;
    if (typeof hint !== "string" || hint.trim().length === 0 || hint.length > 512) {
      return failure("invalid-input", "environment hint is invalid");
    }
    const key = sourceKey(profile.value);
    const generation = this.beginEnvironmentQuery(key);
    const result = await resolveEnvironmentHintFromCli(
      this.ctx.subprocess,
      this.config.command,
      this.config.timeoutMs,
      hint,
      profile.value,
      signal,
    );
    if (!result.ok) return { ok: false, error: mapEnvironmentError(result.error) };
    if (this.#environmentGenerations.get(key) === generation) {
      this.#environmentIdsBySource.set(key, new Set(result.value.environmentIds));
    }
    return result;
  }

  async requestPortalLogin(input: PortalLoginRequest = {}, signal?: AbortSignal): Promise<ImoAuthActionResult<ImoAuthActionRequest>> {
    if (signal?.aborted) return failure("cancelled", "auth action request was cancelled");
    if (this.#disposed) return failure("action-state-lost", "auth action service is disposed");
    if (input === null || typeof input !== "object") return failure("invalid-input", "portal login parameters are invalid");
    const normalized = normalizePortalLogin(input);
    if (!normalized.ok) return normalized;
    return this.append(IMO_AUTH_LOGIN_KIND, normalized.value, signal);
  }

  async executePortalLogin(operationId: string, signal?: AbortSignal): Promise<ImoAuthActionExecution> {
    return this.executeExpected(operationId, IMO_AUTH_LOGIN_KIND, signal);
  }

  async requestRemote(input: RemoteProfileRequest, signal?: AbortSignal): Promise<ImoAuthActionResult<ImoAuthActionRequest>> {
    if (signal?.aborted) return failure("cancelled", "auth action request was cancelled");
    if (this.#disposed) return failure("action-state-lost", "auth action service is disposed");
    if (input === null || typeof input !== "object") return failure("invalid-input", "remote profile parameters are invalid");
    const environmentId = input.environmentId ?? input.env;
    const sourceProfile = input.sourceProfile ?? input.profile;
    const resolved = this.#environmentIdsBySource.get(sourceKey(sourceProfile))?.has(environmentId ?? "") === true;
    const normalized = normalizeRemote(input, resolved);
    if (!normalized.ok) return normalized;
    return this.append(IMO_AUTH_REMOTE_KIND, normalized.value, signal);
  }

  async executeRemote(operationId: string, signal?: AbortSignal): Promise<ImoAuthActionExecution> {
    return this.executeExpected(operationId, IMO_AUTH_REMOTE_KIND, signal);
  }

  async requestDefaultSwitch(input: DefaultProfileSwitchRequest, signal?: AbortSignal): Promise<ImoAuthActionResult<ImoAuthActionRequest>> {
    if (signal?.aborted) return failure("cancelled", "auth action request was cancelled");
    if (this.#disposed) return failure("action-state-lost", "auth action service is disposed");
    if (input === null || typeof input !== "object") return failure("invalid-input", "default profile parameters are invalid");
    const normalized = normalizeDefault(input);
    if (!normalized.ok) return normalized;
    return this.append(IMO_AUTH_DEFAULT_KIND, normalized.value, signal);
  }

  async executeDefaultSwitch(operationId: string, signal?: AbortSignal): Promise<ImoAuthActionExecution> {
    return this.executeExpected(operationId, IMO_AUTH_DEFAULT_KIND, signal);
  }

  /**
   * Direct one-shot default-profile switch for the UI (TASK-039): same CLI
   * kernel as request→approve→execute but no operation record. Shares the
   * single-flight lock and receipt builder.
   */
  async runDirectDefaultSwitch(input: DefaultProfileSwitchRequest, signal?: AbortSignal): Promise<ImoAuthActionExecution> {
    if (signal?.aborted) return { ok: false, error: failure("cancelled", "auth action was cancelled", "").error };
    if (this.#disposed) return { ok: false, error: failure("action-state-lost", "auth action service is disposed", "").error };
    if (input === null || typeof input !== "object") return { ok: false, error: failure("invalid-input", "default profile parameters are invalid", "").error };
    const normalized = normalizeDefault(input);
    if (!normalized.ok) return { ok: false, error: normalized.error };
    if (this.#running !== null) return { ok: false, error: failure("busy", "another auth action is already running", "").error };
    const operationId = `direct:${IMO_AUTH_DEFAULT_KIND}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    this.#running = { operationId, kind: IMO_AUTH_DEFAULT_KIND };
    try {
      return await this.executeDefaultProfile(operationId, normalized.value, signal);
    } finally {
      this.#running = null;
    }
  }

  async executeAction(operationId: string, signal?: AbortSignal): Promise<ImoAuthActionExecution> {
    return this.executePending(operationId, undefined, signal);
  }

  actionStatus(): ImoAuthActionStatus {
    return this.#running === null
      ? { running: false }
      : { running: true, current: { ...this.#running } };
  }

  private beginEnvironmentQuery(key: string): number {
    const generation = (this.#environmentGenerations.get(key) ?? 0) + 1;
    this.#environmentGenerations.set(key, generation);
    return generation;
  }

  private async append(
    kind: ImoAuthActionKind,
    input: PendingAction["input"],
    signal?: AbortSignal,
  ): Promise<ImoAuthActionResult<ImoAuthActionRequest>> {
    if (signal?.aborted) return failure("cancelled", "auth action request was cancelled");
    const paramsDigest = canonicalActionParamsDigest(kind, input);
    const record = await this.ctx.operationLog.append({
      requestId: `${kind}:${Date.now()}`,
      kind,
      paramsDigest,
      artifactRefs: [],
    });
    this.#pending.set(record.id, { kind, input } as PendingAction);
    return { ok: true, value: { operationId: record.id, kind, paramsDigest } };
  }

  private async executeExpected(
    operationId: string,
    expected: ImoAuthActionKind,
    signal?: AbortSignal,
  ): Promise<ImoAuthActionExecution> {
    return this.executePending(operationId, expected, signal);
  }

  private async executePending(
    operationId: string,
    expected: ImoAuthActionKind | undefined,
    signal?: AbortSignal,
  ): Promise<ImoAuthActionExecution> {
    const record = this.ctx.operationLog.list().find((candidate) => candidate.id === operationId);
    if (record === undefined) return { ok: false, error: failure("missing-operation", "auth action operation does not exist", operationId).error };
    if (record.decision !== "approved") return { ok: false, error: failure("not-approved", "only approved auth actions may run", operationId).error };
    if (record.resultDigest !== undefined) return { ok: false, error: failure("already-executed", "auth action operation already has a result", operationId).error };
    if (this.#disposed) return { ok: false, error: failure("action-state-lost", "auth action service is disposed", operationId).error };
    const pending = this.#pending.get(operationId);
    if (pending === undefined) return { ok: false, error: failure("missing-pending-input", "auth action parameters are unavailable; re-request the action", operationId).error };
    if (record.kind !== pending.kind || (expected !== undefined && pending.kind !== expected) || record.paramsDigest !== canonicalActionParamsDigest(pending.kind, pending.input)) {
      return { ok: false, error: failure("operation-params-mismatch", "auth action operation parameters do not match", operationId).error };
    }
    if (this.#running !== null) return { ok: false, error: failure("busy", "another auth action is already running", operationId).error };
    this.#running = { operationId, kind: pending.kind };
    try {
      if (pending.kind === IMO_AUTH_LOGIN_KIND) return await this.executeLogin(operationId, pending.input, signal);
      if (pending.kind === IMO_AUTH_REMOTE_KIND) return await this.executeRemoteProfile(operationId, pending.input, signal);
      return await this.executeDefaultProfile(operationId, pending.input, signal);
    } finally {
      this.#running = null;
    }
  }

  private async executeLogin(operationId: string, input: NormalizedLogin, signal?: AbortSignal): Promise<ImoAuthActionExecution> {
    const startedAt = new Date().toISOString();
    const args = [
      "auth", "login", "--env", "portal",
      ...(input.tenantCode === undefined ? [] : ["--tenant-code", input.tenantCode]),
      ...(input.userSourceId === undefined ? [] : ["--user-source-id", input.userSourceId]),
      ...(input.force ? ["--force"] : []),
      ...(input.scope === undefined ? [] : ["--scope", input.scope]),
    ] as const;
    const run = await runCapture(this.ctx.subprocess, { command: this.config.command, args, timeoutMs: this.config.timeoutMs, signal });
    if (!run.ok) return this.finishRun(operationId, IMO_AUTH_LOGIN_KIND, run.error, startedAt);
    this.ctx.imoAuth.invalidate({ reason: "profile-changed" });
    const profiles = await this.ctx.imoAuth.listProfiles(signal);
    if (!profiles.ok) return this.finishAuthError(operationId, IMO_AUTH_LOGIN_KIND, profiles.error, startedAt, run.value.stdoutDigest, run.value.stderrDigest);
    const snapshot = selectPortalProfile(profiles.value.profiles);
    return this.finishReceipt({
      operationId,
      kind: IMO_AUTH_LOGIN_KIND,
      status: "completed",
      exitCode: run.value.exitCode,
      stdoutDigest: run.value.stdoutDigest,
      stderrDigest: run.value.stderrDigest,
      startedAt,
      ...(snapshot === null ? {} : { profileName: snapshot.profileName, profileSnapshot: snapshot }),
    });
  }

  private async executeRemoteProfile(operationId: string, input: NormalizedRemote, signal?: AbortSignal): Promise<ImoAuthActionExecution> {
    const startedAt = new Date().toISOString();
    const args = [
      "auth", "remote-profile", "create", "--env", input.environmentId,
      ...(input.sourceProfile === undefined ? [] : ["--profile", input.sourceProfile]),
      ...(input.targetProfile === undefined ? [] : ["--target-profile", input.targetProfile]),
      ...(input.targetTenant === undefined ? [] : ["--target-tenant", input.targetTenant]),
      ...(input.scope === undefined ? [] : ["--scope", input.scope]),
    ] as const;
    const run = await runCapture(this.ctx.subprocess, { command: this.config.command, args, timeoutMs: this.config.timeoutMs, signal });
    if (!run.ok) return this.finishRun(operationId, IMO_AUTH_REMOTE_KIND, run.error, startedAt, input);
    this.ctx.imoAuth.invalidate({
      ...(input.targetProfile === undefined ? {} : { profile: input.targetProfile }),
      env: input.environmentId,
      reason: "profile-changed",
    });
    return this.finishReceipt({
      operationId,
      kind: IMO_AUTH_REMOTE_KIND,
      status: "completed",
      exitCode: run.value.exitCode,
      stdoutDigest: run.value.stdoutDigest,
      stderrDigest: run.value.stderrDigest,
      startedAt,
      environmentId: input.environmentId,
      ...(input.targetProfile === undefined ? {} : { profileName: input.targetProfile, targetProfile: input.targetProfile }),
    });
  }

  private async executeDefaultProfile(operationId: string, input: NormalizedDefault, signal?: AbortSignal): Promise<ImoAuthActionExecution> {
    const startedAt = new Date().toISOString();
    const profiles = await this.ctx.imoAuth.listProfiles(signal);
    if (!profiles.ok) return this.finishAuthError(operationId, IMO_AUTH_DEFAULT_KIND, profiles.error, startedAt, profiles.error.stdoutDigest ?? digest(""), profiles.error.stderrDigest ?? digest(""), input.profile);
    if (!profiles.value.profiles.some((profile) => profile.profileName === input.profile)) {
      return this.finishReceipt({
        operationId,
        kind: IMO_AUTH_DEFAULT_KIND,
        status: "failed",
        exitCode: null,
        stdoutDigest: profiles.value.stdoutDigest,
        stderrDigest: digest(""),
        startedAt,
        profileName: input.profile,
      });
    }
    const args = [
      "auth", "default-profile", "set", input.profile,
      ...(input.scope === undefined ? [] : ["--scope", input.scope]),
    ] as const;
    const run = await runCapture(this.ctx.subprocess, { command: this.config.command, args, timeoutMs: this.config.timeoutMs, signal });
    if (!run.ok) return this.finishRun(operationId, IMO_AUTH_DEFAULT_KIND, run.error, startedAt, input);
    this.ctx.imoAuth.invalidate({ profile: input.profile, reason: "profile-changed" });
    return this.finishReceipt({
      operationId,
      kind: IMO_AUTH_DEFAULT_KIND,
      status: "completed",
      exitCode: run.value.exitCode,
      stdoutDigest: run.value.stdoutDigest,
      stderrDigest: run.value.stderrDigest,
      startedAt,
      profileName: input.profile,
    });
  }

  private async finishRun(
    operationId: string,
    kind: ImoAuthActionKind,
    error: RunFailure,
    startedAt: string,
    input?: NormalizedRemote | NormalizedDefault,
  ): Promise<ImoAuthActionExecution> {
    return this.finishReceipt({
      operationId,
      kind,
      status: "failed",
      exitCode: error.exitCode ?? null,
      stdoutDigest: error.stdoutDigest ?? digest(""),
      stderrDigest: error.stderrDigest ?? digest(""),
      startedAt,
      ...(input !== undefined && "environmentId" in input ? { environmentId: input.environmentId } : {}),
      ...(input !== undefined && "targetProfile" in input && input.targetProfile !== undefined ? { profileName: input.targetProfile, targetProfile: input.targetProfile } : {}),
      httpStatus: error.httpStatus,
    });
  }

  private async finishAuthError(
    operationId: string,
    kind: ImoAuthActionKind,
    error: ImoAuthError,
    startedAt: string,
    stdoutDigest: string,
    stderrDigest: string,
    profileName?: string,
  ): Promise<ImoAuthActionExecution> {
    return this.finishReceipt({
      operationId,
      kind,
      status: "failed",
      exitCode: error.exitCode ?? null,
      stdoutDigest,
      stderrDigest,
      startedAt,
      ...(profileName === undefined ? {} : { profileName }),
      httpStatus: error.httpStatus,
    });
  }

  private finishReceipt(input: ReceiptInput): Promise<ImoAuthActionExecution> {
    return finalizeAction({
      recordResult: (id, result) => this.ctx.operationLog.recordResult(id, result),
      emit: (event, payload) => this.ctx.emit(event, payload),
      removePending: (id) => { this.#pending.delete(id); },
    }, input);
  }
}

function selectPortalProfile(profiles: readonly ImoAuthProfileView[]): ImoAuthProfileView | null {
  return profiles.find((profile) => profile.env?.toLowerCase() === "portal" && profile.isDefault)
    ?? profiles.find((profile) => profile.env?.toLowerCase() === "portal")
    ?? profiles.find((profile) => profile.isDefault)
    ?? profiles[0]
    ?? null;
}

function failure<T = never>(code: ImoAuthActionErrorCode, message: string, operationId?: string): { readonly ok: false; readonly error: ImoAuthActionError } {
  return { ok: false, error: { code, message, ...(operationId === undefined ? {} : { operationId }) } };
}

function sourceKey(profile?: string): string {
  return JSON.stringify([profile ?? null]);
}

function mapEnvironmentError(error: EnvironmentError): ImoAuthActionError {
  return {
    code: error.code,
    message: error.message,
    ...(error.candidates === undefined ? {} : { candidates: error.candidates }),
    ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
    ...(error.signal === undefined ? {} : { signal: error.signal }),
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    ...(error.stdoutDigest === undefined ? {} : { stdoutDigest: error.stdoutDigest }),
    ...(error.stderrDigest === undefined ? {} : { stderrDigest: error.stderrDigest }),
  };
}

