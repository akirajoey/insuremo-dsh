import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import { SlotTestRuntime, usePinnedBrowserLanguages } from "@deepseek-ai/dsh-client-test-runtime";
import { apply, inject } from "../src/client/index.ts";
import { zh } from "../src/client/locales.ts";

usePinnedBrowserLanguages("zh-CN");
const batchId = "fedcba9876543210";
const jobA = "0123456789abcdef";
const jobB = "abcdef0123456789";

type Phase = "awaiting-input" | "scheduled" | "failed" | "cancelled" | "mixed-failed-awaiting" | "mixed-final-awaiting" | "mixed-running-awaiting" | "mixed-final-failed";
function batchStatus(phase: Phase) {
  const jobs = phase === "failed" || phase === "mixed-final-failed" ? [
    { jobId: jobA, apiName: "AlphaAPI", status: "failed", provider: "mvp", model: "mvp-model", childSessionId: "123e4567-e89b-12d3-a456-426614174000", startedAt: "2026-08-27T01:02:03.000Z", finishedAt: "2026-08-27T01:03:00.000Z", error: "model-failed", promptBaseBytes: 1024, sourceBytes: 512 },
    { jobId: jobB, apiName: "BetaAPI", status: "final", provider: "mvp", model: "mvp-model", childSessionId: "223e4567-e89b-12d3-a456-426614174001", startedAt: "2026-08-27T01:04:00.000Z", finishedAt: "2026-08-27T01:05:00.000Z", artifactPath: ".metadata/icomposer/ici/explain/BetaAPI/finals/abcdef0123456789.json", promptBaseBytes: 1024, sourceBytes: 512 },
  ] : phase === "mixed-failed-awaiting" ? [
    { jobId: jobA, apiName: "AlphaAPI", status: "failed", error: "model-failed", promptBaseBytes: 1024, sourceBytes: 512 },
    { jobId: jobB, apiName: "BetaAPI", status: "awaiting-input", promptBaseBytes: 1024, sourceBytes: 512 },
  ] : phase === "mixed-final-awaiting" ? [
    { jobId: jobA, apiName: "AlphaAPI", status: "final", artifactPath: ".metadata/icomposer/ici/explain/AlphaAPI/finals/0123456789abcdef.json", promptBaseBytes: 1024, sourceBytes: 512 },
    { jobId: jobB, apiName: "BetaAPI", status: "awaiting-input", promptBaseBytes: 1024, sourceBytes: 512 },
  ] : phase === "mixed-running-awaiting" ? [
    { jobId: jobA, apiName: "AlphaAPI", status: "running", promptBaseBytes: 1024, sourceBytes: 512 },
    { jobId: jobB, apiName: "BetaAPI", status: "awaiting-input", promptBaseBytes: 1024, sourceBytes: 512 },
  ] : [
    { jobId: jobA, apiName: "AlphaAPI", status: phase, promptBaseBytes: 1024, sourceBytes: 512 },
    { jobId: jobB, apiName: "BetaAPI", status: phase, promptBaseBytes: 1024, sourceBytes: 512 },
  ];
  return { ok: true, result: { batch: { batchId, workspaceId: "batch", jobIds: [jobA, jobB], createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z" }, jobs, providers: [{ id: "mvp", models: [{ id: "mvp-model", name: "MVP model" }] }], summary: { promptBaseBytes: 2048, sourceBytes: 1024, maxPromptBaseBytes: 1024, jobCount: 2 } } };
}

describe("TASK-056 batch ICI toolview", () => {
  let runtime: SlotTestRuntime; let locale: LocaleRuntime; let feature: Awaited<ReturnType<SlotTestRuntime["mount"]>>;
  beforeEach(async () => { vi.stubGlobal("localStorage", { clear: () => undefined, getItem: () => null, setItem: () => undefined, removeItem: () => undefined, key: () => null, length: 0 }); runtime = await SlotTestRuntime.create(); locale = new LocaleRuntime(runtime.ctx); runtime.ctx.provide("locale", locale); runtime.slots.installLocale(locale); const owner: any = { callId: "batch-call", toolName: "ici_explain", block: { kind: "tool-result", call: { argsRaw: JSON.stringify({ workspace_id: "batch", queries: ["AlphaAPI", "BetaAPI"] }) }, content: [{ type: "text", text: `batch=${batchId} jobs=2` }] } }; const Frame = ({ renderSlot }: any) => renderSlot("tool.call.toolview", owner, { entryKey: "ici_explain" }); await runtime.root.declare({ "tool.call.toolview": { kind: "keyed", scope: "root" } } as never, Frame as never); feature = await runtime.mount({ inject, apply }); });
  afterEach(async () => { await feature.dispose(); await runtime.dispose(); vi.unstubAllGlobals(); });

  it("uses one batch card, confirms all jobs once, and renders each API", async () => {
    let phase: Phase = "awaiting-input"; const calls: string[] = []; const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const url = String(input); calls.push(url); if (url.endsWith(`/batches/${batchId}/status`)) return new Response(JSON.stringify(batchStatus(phase)), { status: 200 }); if (url.includes(`/batches/${batchId}/native-pick`)) return new Response(JSON.stringify({ ok: true, result: { path: "ref_doc/selected", kind: "directory" } })); if (url.includes(`/batches/${batchId}/confirm`)) { expect(JSON.parse(String(init?.body))).toMatchObject({ provider: "mvp", model: "mvp-model", referenceTarget: { path: "ref_doc/selected", kind: "directory" }, consent: true }); phase = "scheduled"; return new Response(JSON.stringify({ ok: true, result: { batchId, status: "scheduled" } })); } if (url.includes(`/batches/${batchId}/cancel`)) { phase = "cancelled"; return new Response(JSON.stringify({ ok: true, result: { batchId, status: "cancelled" } })); } if (url.includes(`/batches/${batchId}/retry`)) { phase = "awaiting-input"; return new Response(JSON.stringify({ ok: true, result: { batchId, jobIds: [jobA, jobB] } })); } return new Response(JSON.stringify({ ok: false, error: { code: "not-found" } }), { status: 404 }); }); vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderRoot(); await vi.waitFor(async () => { expect(await view.findByText(/AlphaAPI/)).toBeTruthy(); expect(await view.findByText(/BetaAPI/)).toBeTruthy(); expect(await view.findByText(new RegExp(zh["explain.batchTitle"]))).toBeTruthy(); expect(await view.findAllByTestId("ici-explain-card")).toHaveLength(1); });
    const folder = await view.findByRole("button", { name: zh["explain.chooseDirectory"] }); folder.click(); await vi.waitFor(() => expect(view.findByText("ref_doc/selected")).toBeTruthy()); const start = await view.findByRole("button", { name: zh["explain.start"] }); start.click(); await vi.waitFor(() => expect(phase).toBe("scheduled")); expect(calls.filter(url => url.includes(`/batches/${batchId}/confirm`))).toHaveLength(1); expect(await view.findByText(zh["status.scheduled"])).toBeTruthy();
    phase = "failed"; await new Promise(resolve => setTimeout(resolve, 1100)); const retry = await view.findByRole("button", { name: zh["explain.batchRetryFailed"] }); expect(retry).toBeTruthy(); retry.click(); await vi.waitFor(() => expect(calls.some(url => url.includes(`/batches/${batchId}/retry`))).toBe(true));
    const cancel = await view.findByRole("button", { name: zh["explain.batchCancelAll"] }); cancel.click(); await vi.waitFor(() => expect(calls.some(url => url.includes(`/batches/${batchId}/cancel`))).toBe(true)); expect(await view.findAllByTestId("ici-explain-card")).toHaveLength(1);
  });

  it("TASK-059 shows retry instead of Start for a legacy failed-plus-awaiting batch", async () => {
    const phase: Phase = "mixed-failed-awaiting"; const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith(`/batches/${batchId}/status`) ? new Response(JSON.stringify(batchStatus(phase)), { status: 200 }) : new Response(JSON.stringify({ ok: false }), { status: 404 })); vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderRoot(); await vi.waitFor(() => expect(view.queryByText(/AlphaAPI/)).not.toBeNull()); expect(view.getByText(zh["status.failed"])).toBeTruthy(); expect(view.getByRole("button", { name: zh["explain.batchRetryFailed"] })).toBeTruthy(); expect(view.queryByRole("button", { name: zh["explain.start"] })).toBeNull();
  });

  it("TASK-059 keeps final members untouched while showing confirmation for final-plus-awaiting", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith(`/batches/${batchId}/status`) ? new Response(JSON.stringify(batchStatus("mixed-final-awaiting")), { status: 200 }) : new Response(JSON.stringify({ ok: false }), { status: 404 })); vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderRoot(); await vi.waitFor(() => expect(view.queryByText(/BetaAPI/)).not.toBeNull()); expect(view.getByRole("button", { name: zh["explain.start"] })).toBeTruthy(); expect(view.queryByRole("button", { name: zh["explain.batchRetryFailed"] })).toBeNull();
  });

  it("TASK-059 shows running progress and cancel, not retry, for running-plus-awaiting", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith(`/batches/${batchId}/status`) ? new Response(JSON.stringify(batchStatus("mixed-running-awaiting")), { status: 200 }) : new Response(JSON.stringify({ ok: false }), { status: 404 })); vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderRoot(); await vi.waitFor(() => expect(view.queryByText(/AlphaAPI/)).not.toBeNull()); expect(view.getByText(zh["status.running"])).toBeTruthy(); expect(view.getByRole("button", { name: zh["explain.batchCancelAll"] })).toBeTruthy(); expect(view.queryByRole("button", { name: zh["explain.batchRetryFailed"] })).toBeNull(); expect(view.queryByRole("button", { name: zh["explain.start"] })).toBeNull();
  });

  it("TASK-060 report rows show session, provider/model, times, and error without absolute paths", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith(`/batches/${batchId}/status`) ? new Response(JSON.stringify(batchStatus("failed")), { status: 200 }) : new Response(JSON.stringify({ ok: false }), { status: 404 })); vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderRoot(); await vi.waitFor(() => expect(view.queryByText(/AlphaAPI/)).not.toBeNull());
    const container = view.container.textContent ?? "";
    expect(container).toContain("mvp/mvp-model");
    expect(container).toContain(zh["explain.session"]);
    expect(container).toContain("123e4567");
    expect(container).toContain("223e4567");
    expect(container).toContain(zh["explain.startedAt"]);
    expect(container).toContain(zh["explain.finishedAt"]);
    expect(container).toContain("model-failed");
    expect(container).toContain("abcdef0123456789.json");
    expect(container).not.toMatch(/\/(Users|home|private|tmp)\/|C:\\/);
  });
});
