import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import {
  SlotTestRuntime,
  usePinnedBrowserLanguages,
} from "@deepseek-ai/dsh-client-test-runtime";
import { resolveSlotLabel } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import { apply, inject, NS } from "../src/client/index.ts";
import { en, zh } from "../src/client/locales.ts";

usePinnedBrowserLanguages("zh-CN");

describe("InsureMO Settings section", () => {
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
    await runtime.declare({ "settings.section": { kind: "list", scope: "root" } });
    locale = new LocaleRuntime(runtime.ctx);
    runtime.ctx.provide("locale", locale);
    runtime.slots.installLocale(locale);
    feature = await runtime.mount({ inject, apply });
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  it("registers a localized InsureMO nav row in both Chinese and English", () => {
    const entry = runtime.slots.entries("settings.section")[0];
    expect(entry?.locale).toBe(NS);
    expect(resolveSlotLabel(entry?.options.label)).toBe(zh.nav);

    locale.setLocale("en");
    expect(resolveSlotLabel(entry?.options.label)).toBe(en.nav);
  });

  it("renders the placeholder panel and static status", () => {
    const view = runtime.renderSlot("settings.section", { close: vi.fn() });
    expect(view.view.getByRole("heading", { name: zh.title })).toBeTruthy();
    expect(view.view.getByText(zh.placeholder)).toBeTruthy();
    expect(view.view.getByText(zh.status)).toBeTruthy();
  });

  it("removes the section registration when the feature is disposed", async () => {
    expect(runtime.slots.entries("settings.section")).toHaveLength(1);
    await feature.dispose();
    expect(runtime.slots.entries("settings.section")).toHaveLength(0);
  });
});
