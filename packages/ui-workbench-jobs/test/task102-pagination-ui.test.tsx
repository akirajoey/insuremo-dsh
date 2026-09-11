import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import { SlotTestRuntime, usePinnedBrowserLanguages } from "@deepseek-ai/dsh-client-test-runtime";
import { IciExplainToolview } from "../src/client/IciExplainToolview.tsx";
import { apply, inject } from "../src/client/index.ts";
import { zh } from "../src/client/locales.ts";

usePinnedBrowserLanguages("zh-CN");
const batchId = "fedcba9876543210";

/** TASK-102 fixture: ten jobs across two pages with mixed statuses. */
function batchStatus(jobs = 10, scheduler: { maxConcurrent: number; inFlight: number } = { maxConcurrent: 4, inFlight: 2 }) {
  const rows = Array.from({ length: jobs }, (_, index) => ({
    jobId: `000000000000${String(index).padStart(4, "0")}`,
    apiName: `Api${index}`,
    status: index < 3 ? "final" : index < 5 ? "running" : "awaiting-input",
    provider: "mvp",
    model: "mvp-model",
    childSessionId: "123e4567-e89b-12d3-a456-426614174000",
    startedAt: "2026-08-27T01:02:03.000Z",
    finishedAt: index < 3 ? "2026-08-27T01:03:00.000Z" : undefined,
    artifactPath: index < 3 ? `.metadata/icomposer/ici/explain/Api${index}/finals/000000000000${String(index).padStart(4, "0")}.json` : undefined,
    error: index === 0 ? "model-failed: long diagnostic detail that is truncated in the compact row and shown in full inside the details fold" : undefined,
    promptBaseBytes: 1024,
    sourceBytes: 512,
  }));
  return {
    ok: true,
    result: {
      batch: { batchId, workspaceId: "batch", jobIds: rows.map(row => row.jobId), createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z" },
      jobs: rows,
      providers: [{ id: "mvp", models: [{ id: "mvp-model", name: "MVP model" }] }],
      scheduler,
      summary: { promptBaseBytes: 10240, sourceBytes: 5120, maxPromptBaseBytes: 1024, jobCount: jobs },
    },
  };
}

describe("TASK-102 batch pagination and concurrency settings", () => {
  let runtime: SlotTestRuntime; let locale: LocaleRuntime; let feature: Awaited<ReturnType<SlotTestRuntime["mount"]>>;
  beforeEach(async () => {
    vi.stubGlobal("localStorage", { clear: () => undefined, getItem: () => null, setItem: () => undefined, removeItem: () => undefined, key: () => null, length: 0 });
    runtime = await SlotTestRuntime.create(); locale = new LocaleRuntime(runtime.ctx); runtime.ctx.provide("locale", locale); runtime.slots.installLocale(locale);
    const owner: any = { callId: "batch-call", toolName: "ici_explain", block: { kind: "tool-result", call: { argsRaw: JSON.stringify({ workspace_id: "batch", queries: ["Api0"] }) }, content: [{ type: "text", text: `batch=${batchId} jobs=10` }] } };
    const Frame = ({ renderSlot }: any) => renderSlot("tool.call.toolview", owner, { entryKey: "ici_explain" });
    await runtime.root.declare({ "tool.call.toolview": { kind: "keyed", scope: "root" } } as never, Frame as never);
    feature = await runtime.mount({ inject, apply });
  });
  afterEach(async () => { await feature.dispose(); await runtime.dispose(); vi.unstubAllGlobals(); });

  it("pages five rows per page, keeps whole-batch stats on every page, and never auto-jumps on polling", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith(`/batches/${batchId}/status`) ? new Response(JSON.stringify(batchStatus()), { status: 200 }) : new Response(JSON.stringify({ ok: false }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderRoot();
    await vi.waitFor(() => expect(view.queryByText("Api0")).not.toBeNull());
    expect(view.getAllByRole("listitem")).toHaveLength(5);
    expect(view.queryByText("Api5")).toBeNull();
    const stats = view.getByTestId("ici-explain-batch-stats").textContent ?? "";
    expect(stats).toContain(`${zh["explain.jobTotal"]} 10`);
    expect(stats).toContain(`${zh["explain.statFinal"]} 3`);
    expect(stats).toContain(`${zh["explain.statRunning"]} 2`);
    expect(stats).toContain(`${zh["status.awaiting-input"]} 5`);
    expect(view.getByText(new RegExp(`${zh["explain.pageLabel"]} 1/2`))).toBeTruthy();
    // A poll must not move the user off page 1.
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(view.getByText(new RegExp(`${zh["explain.pageLabel"]} 1/2`))).toBeTruthy();
    view.getByRole("button", { name: zh["explain.nextPage"] }).click();
    await vi.waitFor(() => expect(view.queryByText("Api5")).not.toBeNull());
    expect(view.getAllByRole("listitem")).toHaveLength(5);
    expect(view.queryByText("Api0")).toBeNull();
    expect(view.getByTestId("ici-explain-batch-stats").textContent ?? "").toContain(`${zh["explain.jobTotal"]} 10`);
    expect(view.getByText(new RegExp(`${zh["explain.pageLabel"]} 2/2`))).toBeTruthy();
    // Polling on page 2 stays on page 2.
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(view.getByText(new RegExp(`${zh["explain.pageLabel"]} 2/2`))).toBeTruthy();
    expect(view.queryByText("Api5")).not.toBeNull();
  });

  it("keeps per-row details folded state across paging", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith(`/batches/${batchId}/status`) ? new Response(JSON.stringify(batchStatus()), { status: 200 }) : new Response(JSON.stringify({ ok: false }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderRoot();
    await vi.waitFor(() => expect(view.queryByText("Api0")).not.toBeNull());
    expect(view.queryByText(/finals\/0000000000000000\.json/)).toBeNull();
    view.getAllByRole("button", { name: zh["explain.details"] })[0]!.click();
    await vi.waitFor(() => expect(view.queryByText(/finals\/0000000000000000\.json/)).not.toBeNull());
    view.getByRole("button", { name: zh["explain.nextPage"] }).click();
    await vi.waitFor(() => expect(view.queryByText("Api5")).not.toBeNull());
    view.getByRole("button", { name: zh["explain.prevPage"] }).click();
    await vi.waitFor(() => expect(view.queryByText("Api0")).not.toBeNull());
    expect(view.getAllByRole("button", { name: zh["explain.hideDetails"] }).length).toBeGreaterThan(0);
    expect(view.queryByText(/finals\/0000000000000000\.json/)).not.toBeNull();
  });

  it("validates the concurrency draft locally and never fakes a save after a storage failure", async () => {
    let settingsCalls = 0; let settingsStatus = 200; let settingsBody: unknown = { ok: true, result: { maxConcurrent: 8, inFlight: 2 } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/batches/${batchId}/status`)) return new Response(JSON.stringify(batchStatus()), { status: 200 });
      if (url.endsWith("/settings")) { settingsCalls += 1; expect(JSON.parse(String(init?.body))).toEqual({ maxConcurrent: expect.any(Number) }); return new Response(JSON.stringify(settingsBody), { status: settingsStatus }); }
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = runtime.renderRoot();
    await vi.waitFor(() => expect(view.queryByText("Api0")).not.toBeNull());
    const input = view.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("4");
    fireEvent.change(input, { target: { value: "0" } });
    view.getByRole("button", { name: zh["explain.concurrencyApply"] }).click();
    await vi.waitFor(() => expect(view.queryByText(zh["explain.concurrencyInvalid"])).not.toBeNull());
    expect(settingsCalls).toBe(0);
    fireEvent.change(input, { target: { value: "33" } });
    view.getByRole("button", { name: zh["explain.concurrencyApply"] }).click();
    await vi.waitFor(() => expect(view.queryByText(zh["explain.concurrencyInvalid"])).not.toBeNull());
    expect(settingsCalls).toBe(0);
    fireEvent.change(input, { target: { value: "8" } });
    view.getByRole("button", { name: zh["explain.concurrencyApply"] }).click();
    await vi.waitFor(() => expect(view.queryByText(zh["explain.concurrencySaved"])).not.toBeNull());
    expect(settingsCalls).toBe(1);
    settingsStatus = 500; settingsBody = { ok: false, error: { code: "storage-error", message: "storage-error" } };
    fireEvent.change(input, { target: { value: "9" } });
    view.getByRole("button", { name: zh["explain.concurrencyApply"] }).click();
    await vi.waitFor(() => expect(view.queryByText(zh["explain.concurrencyFailed"])).not.toBeNull());
    expect(view.queryByText(zh["explain.concurrencySaved"])).toBeNull();
    expect(settingsCalls).toBe(2);
  });
});

/** TASK-102 P2-03: card isolation probes render the toolview directly with two blocks. */
const cardBlock = (id: string) => ({ kind: "tool-result" as const, call: null, content: [{ type: "text", text: `batch=${id}` }] });
function namedBatchStatus(id: string, cap: number) {
  return {
    ok: true,
    result: {
      batch: { batchId: id, workspaceId: "ws", jobIds: [], createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z" },
      jobs: Array.from({ length: 10 }, (_, index) => ({ jobId: `${id.slice(0, 14)}${String(index).padStart(2, "0")}`, apiName: `${id}Api${index}`, status: "running" })),
      providers: [],
      scheduler: { maxConcurrent: cap, inFlight: 0 },
      summary: { sourceBytes: 0, promptBaseBytes: 0, maxPromptBaseBytes: 0, jobCount: 10 },
    },
  };
}

describe("TASK-102 P2-03 card isolation", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("switching cards during a parked settings request keeps B clean and drops A's late reply", async () => {
    const a = "1111111111111111";
    const b = "2222222222222222";
    let release!: () => void;
    let posted = false;
    let applied = false;
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/settings")) {
        posted = true;
        signal = init?.signal;
        await new Promise<void>(resolve => { release = resolve; });
        applied = true;
        return new Response(JSON.stringify({ ok: true, result: { maxConcurrent: 8, inFlight: 0 } }), { status: 200 });
      }
      const id = String(url).includes(a) ? a : b;
      return new Response(JSON.stringify(namedBatchStatus(id, applied ? 8 : 4)), { status: 200 });
    }));
    const t = (key: string) => key;
    const view = render(React.createElement(IciExplainToolview, { block: cardBlock(a) as never, t: t as never }));
    try {
      await vi.waitFor(() => expect(view.queryByRole("spinbutton")).not.toBeNull());
      fireEvent.click(view.getByRole("button", { name: "explain.nextPage" }));
      await vi.waitFor(() => expect(view.queryByText(`${a}Api5`)).not.toBeNull());
      fireEvent.change(view.getByRole("spinbutton"), { target: { value: "8" } });
      fireEvent.click(view.getByRole("button", { name: "explain.concurrencyApply" }));
      await vi.waitFor(() => expect(posted).toBe(true));
      expect(signal, "the settings request carries an AbortSignal").toBeDefined();
      view.rerender(React.createElement(IciExplainToolview, { block: cardBlock(b) as never, t: t as never }));
      await vi.waitFor(() => expect(view.queryByText(`${b}Api0`)).not.toBeNull());
      // B is a fresh surface: page 1, its own draft, editable.
      expect(view.queryByText(`${b}Api5`)).toBeNull();
      expect(view.queryByText(`${a}Api5`)).toBeNull();
      const input = view.getByRole("spinbutton") as HTMLInputElement;
      expect(input.value).toBe("4");
      expect(input.disabled).toBe(false);
      // A's late reply must not surface on B.
      await act(async () => { release(); });
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(view.queryByText("explain.concurrencySaved")).toBeNull();
      expect((view.getByRole("spinbutton") as HTMLInputElement).value).toBe("4");
      expect((view.getByRole("spinbutton") as HTMLInputElement).disabled).toBe(false);
    } finally {
      release();
      view.unmount();
    }
  });

  it("unmounting during a parked settings request aborts it", async () => {
    const id = "3333333333333333";
    let release!: () => void;
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/settings")) {
        signal = init?.signal;
        await new Promise<void>(resolve => { release = resolve; });
        return new Response(JSON.stringify({ ok: true, result: { maxConcurrent: 8, inFlight: 0 } }), { status: 200 });
      }
      return new Response(JSON.stringify(namedBatchStatus(id, 4)), { status: 200 });
    }));
    const t = (key: string) => key;
    const view = render(React.createElement(IciExplainToolview, { block: cardBlock(id) as never, t: t as never }));
    try {
      await vi.waitFor(() => expect(view.queryByRole("spinbutton")).not.toBeNull());
      fireEvent.change(view.getByRole("spinbutton"), { target: { value: "8" } });
      fireEvent.click(view.getByRole("button", { name: "explain.concurrencyApply" }));
      await vi.waitFor(() => expect(signal).toBeDefined());
      view.unmount();
      expect(signal?.aborted).toBe(true);
    } finally {
      release();
    }
  });

  it("polling never overwrites a user-edited concurrency draft", async () => {
    const id = "4444444444444444";
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/settings")) return new Response(JSON.stringify({ ok: true, result: { maxConcurrent: 6, inFlight: 0 } }), { status: 200 });
      return new Response(JSON.stringify(namedBatchStatus(id, 4)), { status: 200 });
    }));
    const t = (key: string) => key;
    const view = render(React.createElement(IciExplainToolview, { block: cardBlock(id) as never, t: t as never }));
    try {
      await vi.waitFor(() => expect(view.queryByRole("spinbutton")).not.toBeNull());
      expect((view.getByRole("spinbutton") as HTMLInputElement).value).toBe("4");
      fireEvent.change(view.getByRole("spinbutton"), { target: { value: "6" } });
      fireEvent.click(view.getByRole("button", { name: "explain.concurrencyApply" }));
      await vi.waitFor(() => expect((view.getByRole("spinbutton") as HTMLInputElement).value).toBe("6"));
      // A user edit after the save must survive subsequent status polls.
      fireEvent.change(view.getByRole("spinbutton"), { target: { value: "7" } });
      await new Promise(resolve => setTimeout(resolve, 1_300));
      expect((view.getByRole("spinbutton") as HTMLInputElement).value).toBe("7");
      expect((view.getByRole("spinbutton") as HTMLInputElement).disabled).toBe(false);
    } finally {
      view.unmount();
    }
  });
});
