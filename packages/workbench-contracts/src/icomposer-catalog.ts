import { z } from "zod";

const requestIdSchema = z.string().min(1).brand<"RequestId">();
const schemaVersionSchema = z.literal("0" as const);

export const assetTypeSchema = z.enum(["api", "function", "batch", "model"]);
export type AssetType = z.infer<typeof assetTypeSchema>;

export const assetEntrySchema = z
  .object({
    name: z.string().min(1),
    type: assetTypeSchema,
    metadata: z
      .object({
        id: z.number().optional(),
        groupId: z.number().optional(),
        moduleId: z.number().optional(),
        version: z.number().optional(),
        status: z.number().optional(),
        requestMethod: z.number().optional(),
        requestType: z.number().optional(),
        appName: z.string().optional(),
        md5Value: z.string().optional(),
        latestUpdateTime: z.string().optional(),
        jobName: z.string().optional(),
        recordUsage: z.string().optional(),
        sourceEnvironment: z.string().optional(),
      })
      .strict(),
    sourcePath: z.string().min(1).optional(),
    sourceFingerprint: z.string().min(1).optional(),
    joinStatus: z.enum(["clean", "local-modified", "no-server-md5", "source-missing", "metadata-missing"]),
    tenant: z.string().min(1).optional(),
    group: z.string().min(1).optional(),
  })
  .strict();
export type AssetEntry = z.infer<typeof assetEntrySchema>;

export const assetCatalogSchema = z
  .object({
    workspaceId: z.string().min(1),
    canonicalPath: z.string().min(1),
    entries: z.array(assetEntrySchema).max(5000),
    counts: z.object({
      api: z.number().int().min(0),
      function: z.number().int().min(0),
      batch: z.number().int().min(0),
      model: z.number().int().min(0),
      total: z.number().int().min(0),
    }),
    truncated: z.boolean(),
    sections: z.record(
      assetTypeSchema,
      z.object({ status: z.enum(["ok", "missing", "error"]), skipped: z.number().int().min(0).optional() }),
    ),
  })
  .strict();
export type AssetCatalog = z.infer<typeof assetCatalogSchema>;

export const icomposerListAssetsRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: schemaVersionSchema,
    workspaceId: z.string().min(1),
    type: assetTypeSchema.optional(),
  })
  .strict();
export type IcomposerListAssetsRequest = z.infer<typeof icomposerListAssetsRequestSchema>;

export const icomposerListAssetsResponseSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: schemaVersionSchema,
    catalog: assetCatalogSchema,
  })
  .strict();
export type IcomposerListAssetsResponse = z.infer<typeof icomposerListAssetsResponseSchema>;

export const catalogErrorSchema = z
  .object({
    code: z.enum([
      "workspace-not-bound",
      "workspace-not-found",
      "storage-error",
      "invalid-workspace-id",
      "invalid-type",
      "service-disposed",
      "cancelled",
    ]),
    message: z.string().min(1),
  })
  .strict();
export type CatalogError = z.infer<typeof catalogErrorSchema>;
