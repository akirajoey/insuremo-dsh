import { z } from "zod";

const requestIdSchema = z.string().min(1).brand<"RequestId">();

const verifyErrorCodeSchema = z.enum([
  "workspace-not-bound",
  "workspace-not-found",
  "invalid-workspace-id",
  "invalid-file-path",
  "invalid-keyword",
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
]);
export type VerifyError = z.infer<typeof verifyErrorCodeSchema>;

export const verifyUtilsRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    workspaceId: z.string().min(1),
    file: z.string().min(1).max(256),
  })
  .strict();
export type VerifyUtilsRequest = z.infer<typeof verifyUtilsRequestSchema>;

export const utilsListRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    workspaceId: z.string().min(1),
  })
  .strict();
export type UtilsListRequest = z.infer<typeof utilsListRequestSchema>;

export const utilsSearchRequestSchema = z
  .object({
    requestId: requestIdSchema,
    schemaVersion: z.literal("0"),
    workspaceId: z.string().min(1),
    keyword: z.string().min(1).max(128),
  })
  .strict();
export type UtilsSearchRequest = z.infer<typeof utilsSearchRequestSchema>;

const utilClassSummarySchema = z
  .object({
    className: z.string().min(1).max(200),
    methodCount: z.number().int().min(0),
    description: z.string().min(1).max(200).optional(),
  })
  .strict();

const searchMatchSchema = z
  .object({
    className: z.string().min(1).max(200),
    method: z.string().min(1).max(200).optional(),
    description: z.string().min(1).max(200).optional(),
  })
  .strict();

const verifyUsageSchema = z
  .object({
    className: z.string().min(1).max(200),
    methods: z.array(z.string().min(1).max(200)).max(1000),
  })
  .strict();

const verifyIssueSchema = z
  .object({
    className: z.string().min(1).max(200).optional(),
    method: z.string().min(1).max(200).optional(),
    line: z.string().min(1).max(200).optional(),
    suggestions: z.array(z.string().min(1).max(200)).max(1000).optional(),
  })
  .strict();

/** Service-view response (no transport envelope fields — TASK-020 conclusion). */
export const verifyReportViewSchema = z
  .object({
    workspaceId: z.string().min(1),
    file: z.string().min(1).max(256),
    valid: z.boolean(),
    classesChecked: z.number().int().min(0),
    used: z.array(verifyUsageSchema).max(1000),
    unknownClasses: z.array(z.string().min(1).max(200)).max(1000),
    invalidMethods: z.array(verifyIssueSchema).max(1000),
    durationMs: z.number().int().min(0),
    stdoutDigest: z.string().min(1),
  })
  .strict();
export type VerifyReportView = z.infer<typeof verifyReportViewSchema>;

export const utilsListViewSchema = z
  .object({
    workspaceId: z.string().min(1),
    classes: z.array(utilClassSummarySchema).max(1000),
    count: z.number().int().min(0),
    truncated: z.boolean(),
    durationMs: z.number().int().min(0),
    stdoutDigest: z.string().min(1),
  })
  .strict();
export type UtilsListView = z.infer<typeof utilsListViewSchema>;

export const utilsSearchViewSchema = z
  .object({
    workspaceId: z.string().min(1),
    query: z.string().min(1).max(128),
    matches: z.array(searchMatchSchema).max(1000),
    count: z.number().int().min(0),
    truncated: z.boolean(),
    durationMs: z.number().int().min(0),
    stdoutDigest: z.string().min(1),
  })
  .strict();
export type UtilsSearchView = z.infer<typeof utilsSearchViewSchema>;
