import { z } from "zod";

const requestIdSchema = z.string().min(1).brand<"RequestId">();
const schemaVersionSchema = z.literal("0" as const);

export const workspaceIdSchema = z.string().min(1).brand<"WorkspaceId">();
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;

export const workspaceBindingSchema = z
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
export type WorkspaceBinding = z.infer<typeof workspaceBindingSchema>;

export const workspaceSummarySchema = z
  .object({
    workspaceId: z.string().min(1),
    displayName: z.string().min(1),
    canonicalPath: z.string().min(1),
    binding: workspaceBindingSchema.nullable(),
    status: z.enum(["ok", "missing-dir", "orphan", "unavailable"]).optional(),
  })
  .strict();
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

const reqBase = { requestId: requestIdSchema, schemaVersion: schemaVersionSchema };

export const workspaceListRequestSchema = z.object(reqBase).strict();
export type WorkspaceListRequest = z.infer<typeof workspaceListRequestSchema>;

export const workspaceListResponseSchema = z
  .object({
    ...reqBase,
    workspaces: z.array(workspaceSummarySchema),
  })
  .strict();
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;

export const workspaceInspectRequestSchema = z
  .object({
    ...reqBase,
    workspaceId: z.string().min(1),
  })
  .strict();
export type WorkspaceInspectRequest = z.infer<typeof workspaceInspectRequestSchema>;

export const workspaceInspectResponseSchema = z
  .object({
    ...reqBase,
    workspace: workspaceSummarySchema,
  })
  .strict();
export type WorkspaceInspectResponse = z.infer<typeof workspaceInspectResponseSchema>;

export const workspaceBindRequestSchema = z
  .object({
    ...reqBase,
    workspaceId: z.string().min(1),
    environmentId: z.string().min(1),
    tenantCode: z.string().min(1),
    authProfile: z.string().min(1),
    writeMode: z.enum(["read-only", "read-write"]),
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type WorkspaceBindRequest = z.infer<typeof workspaceBindRequestSchema>;

export const workspaceBindResponseSchema = z
  .object({
    ...reqBase,
    workspace: workspaceSummarySchema,
    binding: workspaceBindingSchema,
  })
  .strict();
export type WorkspaceBindResponse = z.infer<typeof workspaceBindResponseSchema>;

export const workspaceUnbindRequestSchema = z
  .object({
    ...reqBase,
    workspaceId: z.string().min(1),
    expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type WorkspaceUnbindRequest = z.infer<typeof workspaceUnbindRequestSchema>;

export const workspaceUnbindResponseSchema = z
  .object({
    ...reqBase,
    workspaceId: z.string().min(1),
    deleted: z.boolean(),
  })
  .strict();
export type WorkspaceUnbindResponse = z.infer<typeof workspaceUnbindResponseSchema>;

export const workspaceBindingErrorSchema = z
  .object({
    code: z.enum([
      "invalid-workspace-id",
      "workspace-not-found",
      "invalid-environment",
      "invalid-tenant",
      "invalid-profile",
      "invalid-write-mode",
      "invalid-revision",
      "revision-conflict",
      "binding-conflict",
      "path-already-bound",
      "not-found",
      "storage-error",
      "revision-exhausted",
      "cancelled",
      "service-disposed",
    ]),
    message: z.string().min(1),
  })
  .strict();
export type WorkspaceBindingError = z.infer<typeof workspaceBindingErrorSchema>;
