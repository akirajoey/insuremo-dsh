import { z } from "zod";

const requestIdSchema = z.string().min(1).brand<"RequestId">();

export const initPreviewRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    workspaceId: z.string().min(1),
    groupId: z.string().optional(),
    listGroups: z.boolean().optional(),
  })
  .strict();
export type InitPreviewRequest = z.infer<typeof initPreviewRequestSchema>;

export const initPreviewGroupSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(128),
    path: z.string().min(1).max(128).optional(),
    code: z.string().min(1).max(128).optional(),
  })
  .strict();
export type InitPreviewGroup = z.infer<typeof initPreviewGroupSchema>;

export const initPreviewGroupsViewSchema = z
  .object({
    workspaceId: z.string().min(1),
    mode: z.literal("groups"),
    groups: z.array(initPreviewGroupSchema).max(1000),
    count: z.number().int().min(0),
    truncated: z.boolean(),
    durationMs: z.number().int().min(0),
    stdoutDigest: z.string().min(1),
  })
  .strict();
export type InitPreviewGroupsView = z.infer<typeof initPreviewGroupsViewSchema>;

export const initPreviewPlanViewSchema = z
  .object({
    workspaceId: z.string().min(1),
    mode: z.literal("plan"),
    groupId: z.string().nullable(),
    steps: z.array(z.string().min(1).max(200)).max(1000),
    count: z.number().int().min(0),
    truncated: z.boolean(),
    durationMs: z.number().int().min(0),
    stdoutDigest: z.string().min(1),
  })
  .strict();
export type InitPreviewPlanView = z.infer<typeof initPreviewPlanViewSchema>;

export const initPreviewResponseSchema = z.union([initPreviewGroupsViewSchema, initPreviewPlanViewSchema]);
export type InitPreviewResponse = z.infer<typeof initPreviewResponseSchema>;

export const reloadPreviewRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    workspaceId: z.string().min(1),
  })
  .strict();
export type ReloadPreviewRequest = z.infer<typeof reloadPreviewRequestSchema>;

export const joinSampleSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(["api", "function", "batch", "model"]),
  })
  .strict();

export const reloadPreviewResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    distribution: z
      .object({
        clean: z.number().int().min(0),
        localModified: z.number().int().min(0),
        noServerMd5: z.number().int().min(0),
        sourceMissing: z.number().int().min(0),
        metadataMissing: z.number().int().min(0),
      })
      .strict(),
    total: z.number().int().min(0),
    top: z.array(joinSampleSchema).max(50),
    scannedAt: z.string().min(1),
  })
  .strict();
export type ReloadPreviewResponse = z.infer<typeof reloadPreviewResponseSchema>;

export const lifecycleErrorSchema = z
  .object({
    code: z.enum([
      "workspace-not-bound",
      "workspace-not-found",
      "invalid-workspace-id",
      "invalid-group-id",
      "service-disposed",
      "cancelled",
      "invalid-auth",
      "forbidden",
      "prepare-invalidated",
      "lease-revoked",
      "command-failed",
      "timeout",
      "parse-error",
      "cli-error",
    ]),
    message: z.string().min(1),
  })
  .strict();
export type LifecycleError = z.infer<typeof lifecycleErrorSchema>;
