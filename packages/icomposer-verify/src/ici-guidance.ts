import type { Context } from "@deepseek-ai/cordis";

interface WorkspaceListEntryLike {
  readonly workspaceId: string;
  readonly displayName?: string;
  readonly autoBindState?: "bound" | "pending" | "none";
  readonly detectedIcomposer?: boolean;
}

/**
 * Build the guided `workspace-not-bound` error payload: the Agent reads the
 * guidance text and can walk the user through binding without any tool
 * spelunking — lists every workspace with its identity state and gives the
 * exact phrase to say.
 */
export async function notBoundError(ctx: Context, workspaceId: string): Promise<{ code: string; guidance: string }> {
  const lines: string[] = [
    `Workspace '${workspaceId}' is not bound to an InsureMO environment yet — Code Intelligence tools need a binding before they can run.`,
  ];
  const binding = ctx.get("workspaceBinding" as never) as unknown as {
    list(signal?: AbortSignal): Promise<{ ok: boolean; value?: readonly WorkspaceListEntryLike[] }>;
  } | undefined;
  if (binding !== undefined) {
    try {
      const res = await binding.list();
      if (res.ok === true && Array.isArray(res.value) && res.value.length > 0) {
        lines.push("Known workspaces:");
        for (const entry of res.value.slice(0, 20)) {
          const state = entry.autoBindState ?? (entry.detectedIcomposer === true ? "pending-detected" : "unbound");
          lines.push(`  - ${entry.workspaceId}${entry.displayName !== undefined && entry.displayName !== entry.workspaceId ? ` (${entry.displayName})` : ""}: ${state}`);
        }
      } else {
        lines.push("No workspaces are added yet — add one in the UI (or say which directory to use) first.");
      }
    } catch { /* listing is best-effort guidance */ }
  }
  lines.push('To continue, say: "绑定工作区 <workspaceId> 用 profile <authProfile>" (or in English: "bind workspace <id> with profile <name>") — for a detected iComposer workspace you can reference it directly.');
  return { code: "workspace-not-bound", guidance: lines.join("\n") };
}
