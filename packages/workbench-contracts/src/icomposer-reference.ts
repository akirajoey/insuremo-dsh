import { z } from "zod";

const requestIdSchema = z.string().min(1).brand<"RequestId">();

export const sdkOperationSchema = z
  .object({
    client: z.string().min(1),
    method: z.enum(["get", "post", "put", "delete", "patch", "head", "options", "trace"]),
    path: z.string().min(1),
    operationId: z.string().min(1),
    summary: z.string().min(1).max(200).optional(),
    tag: z.string().min(1).max(200).optional(),
  })
  .strict();
export type SdkOperationProjection = z.infer<typeof sdkOperationSchema>;

export const sdkListRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    workspaceId: z.string().min(1),
  })
  .strict();
export type SdkListRequest = z.infer<typeof sdkListRequestSchema>;

export const sdkListResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    clients: z
      .array(
        z
          .object({
            client: z.string().min(1),
            swaggerPath: z.string().min(1),
            operationCount: z.number().int().min(0),
            status: z.enum(["ok", "invalid", "skipped-escape"]),
          })
          .strict(),
      )
      .max(5000),
    counts: z.object({ clients: z.number().int().min(0), operations: z.number().int().min(0) }).strict(),
  })
  .strict();
export type SdkListResponse = z.infer<typeof sdkListResponseSchema>;

export const sdkQueryRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    workspaceId: z.string().min(1),
    client: z.string().optional(),
    keyword: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
export type SdkQueryRequest = z.infer<typeof sdkQueryRequestSchema>;

export const queryResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    operations: z.array(sdkOperationSchema).max(200),
    counts: z.object({ clients: z.number().int().min(0), operations: z.number().int().min(0) }).strict(),
    limit: z.number().int().min(1).max(200),
    truncated: z.boolean(),
  })
  .strict();
export type SdkQueryResponse = z.infer<typeof queryResponseSchema>;

export const utilListRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    workspaceId: z.string().min(1),
  })
  .strict();

export const utilListResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    utils: z
      .array(
        z
          .object({
            util: z.string().min(1),
            docPath: z.string().min(1),
            methodCount: z.number().int().min(0),
            status: z.enum(["ok", "invalid"]),
          })
          .strict(),
      )
      .max(5000),
    counts: z.object({ utils: z.number().int().min(0), methods: z.number().int().min(0) }).strict(),
  })
  .strict();
export type UtilListResponse = z.infer<typeof utilListResponseSchema>;

export const utilQueryRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    workspaceId: z.string().min(1),
    util: z.string().optional(),
    keyword: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export const utilQueryResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    methods: z.array(z.object({ util: z.string().min(1), method: z.string().min(1) }).strict()).max(200),
    counts: z.object({ utils: z.number().int().min(0), methods: z.number().int().min(0) }).strict(),
    limit: z.number().int().min(1).max(200),
    truncated: z.boolean(),
  })
  .strict();

const referenceErrorCodeSchema = z.enum([
  "workspace-not-bound",
  "workspace-not-found",
  "storage-error",
  "invalid-workspace-id",
  "invalid-limit",
  "service-disposed",
  "cancelled",
]);
export type ReferenceErrorCode = z.infer<typeof referenceErrorCodeSchema>;

export const referenceErrorSchema = z
  .object({
    code: referenceErrorCodeSchema,
    message: z.string().min(1),
  })
  .strict();
