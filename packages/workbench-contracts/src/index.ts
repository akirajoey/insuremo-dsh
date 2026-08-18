import { z } from "zod";

/** The first stable Workbench API schema version. */
export const schemaVersion = "0" as const;
/** Upper-case alias for consumers that use constants by convention. */
export const SCHEMA_VERSION = schemaVersion;
/** Numeric API generation corresponding to `schemaVersion`. */
export const API_VERSION = 0 as const;

export type SchemaVersion = typeof schemaVersion;

export const requestIdSchema = z.string().min(1).brand<"RequestId">();
export const jobIdSchema = z.string().min(1).brand<"JobId">();
export type RequestId = z.infer<typeof requestIdSchema>;
export type JobId = z.infer<typeof jobIdSchema>;
export const RequestIdSchema = requestIdSchema;
export const JobIdSchema = jobIdSchema;
export const schemaVersionSchema = z.literal(schemaVersion);
export const SchemaVersionSchema = schemaVersionSchema;

export const COMMANDS = {
  systemCapabilities: "system/capabilities",
  workspaceList: "workspace/list",
} as const;

export type WorkbenchCommand = (typeof COMMANDS)[keyof typeof COMMANDS];

const requestShape = {
  requestId: requestIdSchema,
  schemaVersion: schemaVersionSchema,
};

export const systemCapabilitiesRequestSchema = z.object(requestShape).strict();
export type SystemCapabilitiesRequest = z.infer<typeof systemCapabilitiesRequestSchema>;
export const SystemCapabilitiesRequestSchema = systemCapabilitiesRequestSchema;

export const capabilitySchema = z
  .object({
    command: z.enum([COMMANDS.systemCapabilities, COMMANDS.workspaceList]),
    description: z.string().min(1).optional(),
  })
  .strict();
export type Capability = z.infer<typeof capabilitySchema>;
export const CapabilitySchema = capabilitySchema;

export const systemCapabilitiesResponseSchema = z
  .object({
    ...requestShape,
    capabilities: z.array(capabilitySchema),
  })
  .strict();
export type SystemCapabilitiesResponse = z.infer<typeof systemCapabilitiesResponseSchema>;
export const SystemCapabilitiesResponseSchema = systemCapabilitiesResponseSchema;

export const workspaceListRequestSchema = z.object(requestShape).strict();
export type WorkspaceListRequest = z.infer<typeof workspaceListRequestSchema>;
export const WorkspaceListRequestSchema = workspaceListRequestSchema;

export const workspaceSummarySchema = z
  .object({
    workspaceId: z.string().min(1),
    displayName: z.string().min(1),
    canonicalPath: z.string().min(1),
    environmentId: z.string().min(1).optional(),
    tenantCode: z.string().min(1).optional(),
    authProfile: z.string().min(1).optional(),
    writeMode: z.enum(["read-only", "read-write"]),
  })
  .strict();
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export const WorkspaceSummarySchema = workspaceSummarySchema;

export const workspaceListResponseSchema = z
  .object({
    ...requestShape,
    workspaces: z.array(workspaceSummarySchema),
  })
  .strict();
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;
export const WorkspaceListResponseSchema = workspaceListResponseSchema;
