import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import { SlotTestRuntime, usePinnedBrowserLanguages } from "@deepseek-ai/dsh-client-test-runtime";
import { apply, inject } from "../src/client/index.ts";
import { zh } from "../src/client/locales.ts";

usePinnedBrowserLanguages("zh-CN");
const batchId = "fedcba9876543210";
const singleA = "0123456789abcdef";
const singleB = "abcdef0123456789";

type Owner = { callId: string; toolName: "ici_explain"; block: Record<string, unknown> };
function runningOwner(args: Record<string, unknown>, callId = "running-call"): Owner {
  return { callId, toolName: "ici_explain", block: { call: { argsRaw: JSON.stringify(args) } } };
}
function singleOwner(jobId: string, apiName: string, callId = "single-call"): Owner {
  return { callId, toolName: "ici_explain", block: { kind: "tool-result", call: { argsRaw: JSON.stringify({ workspace_id: "lifecycle", query: apiName }) }, content: [{ type: "text", text: `prepare=.metadata/icomposer/ici/explain/${apiName}/prepare.json job=${jobId} status=awaiting-input` }] } };
}
function batchOwner(callId = "batch-call"): Owner {
  return { callId, toolName: "ici_explain", block: { kind: "tool-result", call: { argsRaw: JSON.stringify({ workspace_id: "lifecycle", queries: ["AlphaAPI", "BetaAPI", "GammaAPI", "DeltaAPI"] }) }, content: [{ type: "text", text: `batch=${batchId} jobs=4` }] } };
}
function batchResponse(status: string = "awaiting-input"): Response {
  const names = ["AlphaAPI", "BetaAPI", "GammaAPI", "DeltaAPI"];
  return new Response(JSON.stringify({ ok: true, result: {
    batch: { batchId, workspaceId: "lifecycle", jobIds: names.map((_name, index) => index.toString(16).padStart(16, "0")), createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z" },
    jobs: names.map((apiName, index) => ({ jobId: index.toString(16).padStart(16, "0"), apiName, status, promptBaseBytes: 1024, sourceBytes: 512 })),
    providers: [{ id: "mvp", models: [{ id: "mvp-model", name: "MVP model" }] }], summary: { promptBaseBytes: 4096, sourceBytes: 2048, maxPromptBaseBytes: 1024, jobCount: 4 },
  } }), { status: 200 });
}
function singleResponse(jobId: string, apiName: string, status: string = "awaiting-input"): Response {
  return new Response(JSON.stringify({ ok: true, result: {
    job: { jobId, workspaceId: "lifecycle", apiName, provider: "mvp", model: "mvp-model", folderPath: "ref_doc", status, revision: 1 },
    summary: { nodes: 3, edges: 2, sourceFiles: 1, readableSources: 1, sourceBytes: 512, promptBaseBytes: 1024, truncated: false },
    providers: [{ id: "mvp", models: [{ id: "mvp-model", name: "MVP model" }] }],
  } }), { status: 200 });
}

async function mountTool(runtime: SlotTestRuntime, initialOwner: Owner) {
  let currentOwner = initialOwner;
  const Frame = ({ renderSlot }: any) => renderSlot("tool.call.toolview", currentOwner, { entryKey: "ici_explain" });
  const locale = new LocaleRuntime(runtime.ctx);
  runtime.ctx.provide("locale", locale);
  runtime.slots.installLocale(locale);
  await runtime.root.declare({ "tool.call.toolview": { kind: "keyed", scope: "root" } } as never, Frame as never);
  await runtime.mount({ inject, apply });
  const view = runtime.renderRoot();
  return { view, update(owner: Owner): void { currentOwner = owner; view.rerender(runtime.slots.renderSlot("root", {})); } };
}

describe("TASK-058 ICI toolview polling lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { clear: () => undefined, getItem: () => null, setItem: () => undefined, removeItem: () => undefined, key: () => null, length: 0 });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("refreshes a settled batch immediately on first mount", async () => {
    const runtime = await SlotTestRuntime.create();
    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith(`/batches/${batchId}/status`)
        ? batchResponse() : new Response(JSON.stringify({ ok: false }), { status: 404 }));
      vi.stubGlobal("fetch", fetchMock);
      const { view } = await mountTool(runtime, batchOwner());
      await vi.waitFor(() => {
        expect(view.queryByText(/DeltaAPI/)).not.toBeNull();
        expect(view.getAllByRole("listitem")).toHaveLength(4);
      });
      expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith(`/batches/${batchId}/status`))).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("starts batch polling when a running call receives its settled result and renders all APIs", async () => {
    const runtime = await SlotTestRuntime.create();
    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith(`/batches/${batchId}/status`)
        ? batchResponse() : new Response(JSON.stringify({ ok: false }), { status: 404 }));
      vi.stubGlobal("fetch", fetchMock);
      const { view, update } = await mountTool(runtime, runningOwner({ workspace_id: "lifecycle", queries: ["AlphaAPI", "BetaAPI", "GammaAPI", "DeltaAPI"] }));
      expect(view.getByText(zh["explain.prepareWaiting"])).toBeTruthy();
      update(batchOwner());
      await vi.waitFor(() => {
        expect(view.queryByText(/DeltaAPI/)).not.toBeNull();
        expect(view.getAllByRole("listitem")).toHaveLength(4);
      });
      expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith(`/batches/${batchId}/status`))).toHaveLength(1);
      expect(view.getByText(`${zh["explain.batchTitle"]} · 4 ${zh["explain.batchApis"]}`)).toBeTruthy();
    } finally {
      await runtime.dispose();
    }
  });

  it("starts single polling after running-to-settled, switches IDs, and stops when the ID is removed", async () => {
    const runtime = await SlotTestRuntime.create();
    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/jobs/${singleA}/status`)) return singleResponse(singleA, "AlphaAPI");
        if (url.endsWith(`/jobs/${singleB}/status`)) return singleResponse(singleB, "BetaAPI");
        return new Response(JSON.stringify({ ok: false }), { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const { view, update } = await mountTool(runtime, runningOwner({ workspace_id: "lifecycle", query: "AlphaAPI" }));
      update(singleOwner(singleA, "AlphaAPI"));
      await vi.waitFor(() => expect(view.queryByText(/AlphaAPI/)).not.toBeNull());
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(`/jobs/${singleA}/status`))).toBe(true);
      update(singleOwner(singleB, "BetaAPI"));
      await vi.waitFor(() => expect(view.queryByText(/BetaAPI/)).not.toBeNull());
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(`/jobs/${singleB}/status`))).toBe(true);
      const callsBeforeRemoval = fetchMock.mock.calls.length;
      update(runningOwner({ workspace_id: "lifecycle", query: "BetaAPI" }, "removed-call"));
      await vi.waitFor(() => expect(view.getByText(zh["explain.prepareWaiting"])).toBeTruthy());
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(fetchMock.mock.calls.length).toBe(callsBeforeRemoval);
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps one interval across updates and cleans it on ID removal and unmount", async () => {
    vi.useFakeTimers();
    const runtime = await SlotTestRuntime.create();
    try {
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
      const { update } = await mountTool(runtime, runningOwner({ workspace_id: "lifecycle", query: "AlphaAPI" }));
      expect(vi.getTimerCount()).toBe(0);
      update(singleOwner(singleA, "AlphaAPI"));
      expect(vi.getTimerCount()).toBe(1);
      update(singleOwner(singleA, "AlphaAPI", "same-id-update"));
      expect(vi.getTimerCount()).toBe(1);
      update(runningOwner({ workspace_id: "lifecycle", query: "AlphaAPI" }, "removed-call"));
      expect(vi.getTimerCount()).toBe(0);
      update(singleOwner(singleB, "BetaAPI"));
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await runtime.dispose();
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});
