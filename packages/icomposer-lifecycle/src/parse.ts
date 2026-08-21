import { JSON_LIMIT_BYTES } from "./capture.ts";
import type { InitPreviewGroup } from "./types.ts";

/** Planned-action list cap and per-field clip widths (emit values stay ≤ these). */
export const ACTIONS_MAX = 1000;
export const ACTION_TEXT_MAX = 200;
export const FIELD_TEXT_MAX = 128;

export interface GroupsProjection {
  readonly mode: "groups";
  readonly groups: readonly InitPreviewGroup[];
  readonly count: number;
  readonly truncated: boolean;
}

export interface PlanProjection {
  readonly mode: "plan";
  readonly groupId: string | null;
  readonly steps: readonly string[];
  readonly count: number;
  readonly truncated: boolean;
}

export type InitProjection = GroupsProjection | PlanProjection;

export type ParseInitResult =
  | { readonly ok: true; readonly value: InitProjection }
  | { readonly ok: false; readonly error: "parse-error" | "not-json" };

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + "\u2026" : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v) return undefined;
  return clip(v, max);
}

function frozen<T extends object>(value: T): T {
  return Object.freeze({ ...value }) as T;
}

/**
 * Strict allowlist projection of `imo icomposer init --dry-run --json`
 * stdout. Only `type` / `groups` (id/name/path/code) and `type` / `group_id`
 * / `steps` (strings) are read; everything else is dropped. Lists are capped
 * at 1000 with a `truncated` flag; every emitted string is bounded.
 */
export function parseInitOutput(text: string): ParseInitResult {
  if (Buffer.byteLength(text) > JSON_LIMIT_BYTES) return { ok: false, error: "parse-error" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "not-json" };
  }
  if (!isRecord(parsed)) return { ok: false, error: "parse-error" };
  if (parsed.type === "groups") {
    const raw = parsed.groups;
    if (!Array.isArray(raw)) return { ok: false, error: "parse-error" };
    const count = raw.length;
    const truncated = count > ACTIONS_MAX;
    const groups: InitPreviewGroup[] = [];
    for (const item of raw.slice(0, ACTIONS_MAX)) {
      if (!isRecord(item)) continue;
      const id = typeof item.GroupId === "number" ? String(item.GroupId) : boundedString(item.GroupId, FIELD_TEXT_MAX);
      const name = boundedString(item.Name ?? item.Code, FIELD_TEXT_MAX);
      if (id === undefined || name === undefined) continue;
      const path = boundedString(item.Path, FIELD_TEXT_MAX);
      const code = boundedString(item.Code, FIELD_TEXT_MAX);
      groups.push(frozen({
        id,
        name,
        ...(path === undefined ? {} : { path }),
        ...(code === undefined ? {} : { code }),
      } as InitPreviewGroup));
    }
    return { ok: true, value: frozen({ mode: "groups", groups: Object.freeze(groups), count, truncated }) };
  }
  if (parsed.type === "plan") {
    const raw = parsed.steps;
    if (!Array.isArray(raw)) return { ok: false, error: "parse-error" };
    const count = raw.length;
    const truncated = count > ACTIONS_MAX;
    const steps: string[] = [];
    for (const item of raw.slice(0, ACTIONS_MAX)) {
      if (typeof item !== "string") continue;
      steps.push(clip(item, ACTION_TEXT_MAX));
    }
    const groupId = typeof parsed.group_id === "number" ? String(parsed.group_id) : boundedString(parsed.group_id, FIELD_TEXT_MAX) ?? null;
    return { ok: true, value: frozen({ mode: "plan", groupId, steps: Object.freeze(steps), count, truncated }) };
  }
  return { ok: false, error: "parse-error" };
}
