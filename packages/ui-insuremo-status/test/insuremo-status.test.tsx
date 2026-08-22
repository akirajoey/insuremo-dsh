import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import {
  SlotTestRuntime,
  usePinnedBrowserLanguages,
} from "@deepseek-ai/dsh-client-test-runtime";
import { resolveSlotLabel } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import { apply, inject, NS } from "../src/client/index.ts";
import { en, zh } from "../src/client/locales.ts";

usePinnedBrowserLanguages("zh-CN");

describe("InsureMO sidebar status", () => {
  let runtime: SlotTestRuntime;
  let locale: LocaleRuntime;
  let feature: Awaited<ReturnType<SlotTestRuntime["mount"]>>;

  beforeEach(async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => { values.clear(); },
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    });
    runtime = await SlotTestRuntime.create();
    await runtime.declare({ "sidebar.footer.action": { kind: "list", scope: "root" } });
    locale = new LocaleRuntime(runtime.ctx);
    runtime.ctx.provide("locale", locale);
    runtime.slots.installLocale(locale);
    feature = await runtime.mount({ inject, apply });
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  it("registers and renders the InsureMO footer badge + workspace health strip", () => {
    const entries = runtime.slots.entries("sidebar.footer.action");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.options.id).toBe("insuremo-status");
    expect(entries[1]?.options.id).toBe("insuremo-workspace-health");
    expect(entries[0]?.locale).toBe(NS);
    expect(resolveSlotLabel(entries[0]?.options.label)).toBe(zh.label);
    expect(resolveSlotLabel(entries[1]?.options.label)).toBe(zh["health.strip"]);

    const view = runtime.renderSlot("sidebar.footer.action", { wide: true });
    expect(view.view.getByRole("status", { name: zh.label })).toBeTruthy();
    expect(view.view.getByText("InsureMO", { exact: false })).toBeTruthy();
  });

  it("switches between Chinese and English status copy", async () => {
    const view = runtime.renderSlot("sidebar.footer.action", { wide: true });
    expect(view.view.getByText(zh.label)).toBeTruthy();

    locale.setLocale("en");
    await runtime.flush();
    expect(view.view.getByText(en.label)).toBeTruthy();
  });

  it("removes both footer registrations when disposed", async () => {
    expect(runtime.slots.entries("sidebar.footer.action")).toHaveLength(2);
    await feature.dispose();
    expect(runtime.slots.entries("sidebar.footer.action")).toHaveLength(0);
  });
});

describe("WorkspaceHealth", () => {
  it("parseWorkspaceHealthRows clamps states and drops garbage", async () => {
    const { parseWorkspaceHealthRows } = await import("../src/client/WorkspaceHealth.tsx");
    const rows = parseWorkspaceHealthRows({ workspaces: [
      { workspaceId: "a", detected: true, autoBindState: "bound", graphReady: true, explainReady: true },
      { workspaceId: "b", detected: true, autoBindState: "weird", graphReady: false, explainReady: false },
      { workspaceId: "c" },
      "garbage",
    ] });
    expect(rows).toHaveLength(3);
    const [a, b, c] = rows as ReadonlyArray<{ detected: boolean; autoBindState: string; graphReady: boolean; explainReady: boolean }>;
    expect([a.autoBindState, a.graphReady, a.explainReady]).toEqual(["bound", true, true]);
    expect(b.autoBindState).toBe("none");
    expect([c.detected, c.autoBindState]).toEqual([false, "none"]);
    expect(parseWorkspaceHealthRows({})).toBeNull();
    expect(parseWorkspaceHealthRows({ workspaces: "no" })).toBeNull();
  });

});
