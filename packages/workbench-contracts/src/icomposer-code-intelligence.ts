import { z } from "zod";

const requestIdSchema = z.string().min(1).brand<"RequestId">();

export const iciBuildRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    workspaceId: z.string().min(1),
  })
  .strict();
export type IciBuildRequest = z.infer<typeof iciBuildRequestSchema>;

export const iciManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    engineVersion: z.string().min(1),
    sourceFingerprint: z.string().min(1),
    builtAt: z.string().min(1),
    nodeCount: z.number().int().min(0),
    edgeCount: z.number().int().min(0),
    workspaceId: z.string().min(1),
    canonicalPath: z.string().min(1),
  })
  .strict();
export type IciManifest = z.infer<typeof iciManifestSchema>;

export const iciBuildResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    manifest: iciManifestSchema,
    nodeCount: z.number().int().min(0),
    edgeCount: z.number().int().min(0),
  })
  .strict();
export type IciBuildResponse = z.infer<typeof iciBuildResponseSchema>;
