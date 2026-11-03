/**
 * TASK-167a negative contract: every case here MUST fail to compile against
 * the published declarations. The runner compiles this file in its own project
 * and requires a non-zero exit plus at least three diagnostics; a case that
 * starts passing means the real contract no longer rejects it and the gate
 * fails.
 */
import { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import type { WorkspaceRegistry } from "@deepseek-ai/dsh-workspace";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "sidebar.insuremo": "label";
  }
}

// 1. A locale key outside the declared namespace union must be rejected.
export function unknownLocaleKey(props: PropsLocale<"sidebar.insuremo">): string {
  return props.t("not-a-declared-key");
}

// 2. The client slot registry is not an arbitrary value.
export function slotsAreTyped(ctx: Context): void {
  const registry: string = ctx.slots;
  void registry;
}

// 3. `spawn` requires the full argv/stdout contract.
export function spawnShape(io: SubprocessRuntime): void {
  io.spawn({ argv: "imo --version" });
}

// 4. Workspace lookup takes a WorkspaceId, not a number.
export function workspaceLookup(registry: WorkspaceRegistry): void {
  registry.get(42);
}

// 5. A tool definition requires its output declaration.
export function toolShape(tool: ToolDefinition): ToolDefinition {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}
