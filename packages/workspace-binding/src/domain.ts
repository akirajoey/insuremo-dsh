import { z } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";

export const bindingRecordSchema = z
  .object({
    workspaceId: z.string().min(1),
    canonicalPath: z.string().min(1),
    environmentId: z.string().min(1),
    tenantCode: z.string().min(1),
    authProfile: z.string().min(1),
    writeMode: z.enum(["read-only", "read-write"]),
    metadataFingerprint: z.null(),
    sourceFingerprint: z.null(),
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type BindingRecord = z.infer<typeof bindingRecordSchema>;

export const workspaceBindingDomain = defineDomain({
  name: "workbench_workspace_binding",
  version: 1,
  tables: {
    bindings: domainTable<string, BindingRecord>(bindingRecordSchema),
  },
});
