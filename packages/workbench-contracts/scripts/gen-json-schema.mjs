import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(packageRoot, "dist");
const draft = "https://json-schema.org/draft/2020-12/schema";
const requestProperties = {
  requestId: { type: "string", minLength: 1 },
  schemaVersion: { const: "0" },
};

const operationRecordDefinition = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    requestId: { type: "string", minLength: 1 },
    kind: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
    paramsDigest: { type: "string", minLength: 1 },
    artifactRefs: { type: "array", items: { type: "string", minLength: 1 } },
    decision: { enum: ["pending", "approved", "rejected"] },
    decidedBy: { type: "string", minLength: 1 },
    decidedAt: { type: "string", format: "date-time" },
    reason: { type: "string", minLength: 1 },
    resultDigest: { type: "string", minLength: 1 },
    schemaVersion: { const: "0" },
    createdAt: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "requestId",
    "kind",
    "paramsDigest",
    "artifactRefs",
    "decision",
    "schemaVersion",
    "createdAt",
  ],
  additionalProperties: false,
};

const operationRecordInputProperties = {
  id: { type: "string", minLength: 1 },
  kind: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
  paramsDigest: { type: "string", minLength: 1 },
  artifactRefs: { type: "array", items: { type: "string", minLength: 1 } },
  resultDigest: { type: "string", minLength: 1 },
  createdAt: { type: "string", format: "date-time" },
};

function objectSchema(properties, required) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function commandSchema(id, title, request, response) {
  return {
    $schema: draft,
    $id: `https://icomposer.workbench/schemas/${id}.json`,
    title,
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      operationRecord: operationRecordDefinition,
      request,
      response,
    },
  };
}

const schemas = {
  "system-capabilities-request.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/system-capabilities-request.json",
    title: "system/capabilities request",
    ...objectSchema(requestProperties, ["requestId", "schemaVersion"]),
  },
  "system-capabilities-response.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/system-capabilities-response.json",
    title: "system/capabilities response",
    ...objectSchema(
      {
        ...requestProperties,
        capabilities: {
          type: "array",
          items: objectSchema(
            {
              command: { enum: ["system/capabilities", "workspace/list", "workspace/inspect", "workspace/bind", "workspace/unbind", "icomposer/list-assets", "icomposer/sdk-list", "icomposer/sdk-query", "icomposer/util-list", "icomposer/util-query", "icomposer/init-preview", "icomposer/reload-preview", "icomposer/verify-utils", "icomposer/utils-list", "icomposer/utils-search", "ici/build", "ici/query-api", "ici/query-impact", "ici/search-index", "ici/search", "ici/build-job", "ici/status", "ici/cleanup-plan", "ici/cleanup-apply", "ici/explain-context", "ici/explain-deterministic", "icomposer-write/push-preview", "icomposer-write/push-request", "icomposer-write/push-execute", "icomposer-write/push-resolve", "icomposer-write/push-status", "icomposer-write/test-run", "icomposer-write/release-preview", "icomposer-write/release-repos", "icomposer-write/release-branches", "icomposer-write/release-apply", "icomposer-write/create-options", "icomposer-write/create-preview", "icomposer-write/create-execute", "icomposer-write/metadata-preview", "icomposer-write/metadata-execute", "operation/record", "operation/list", "operation/decide"] },
              description: { type: "string", minLength: 1 },
            },
            ["command"],
          ),
        },
      },
      ["requestId", "schemaVersion", "capabilities"],
    ),
  },
  "workspace-list-request.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/workspace-list-request.json",
    title: "workspace/list request",
    ...objectSchema(requestProperties, ["requestId", "schemaVersion"]),
  },
  "workspace-list-response.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/workspace-list-response.json",
    title: "workspace/list response",
    ...objectSchema(
      {
        ...requestProperties,
        workspaces: {
          type: "array",
          items: objectSchema(
            {
              workspaceId: { type: "string", minLength: 1 },
              displayName: { type: "string", minLength: 1 },
              canonicalPath: { type: "string", minLength: 1 },
              binding: {
                anyOf: [
                  { type: "null" },
                  objectSchema(
                    {
                      workspaceId: { type: "string", minLength: 1 },
                      canonicalPath: { type: "string", minLength: 1 },
                      environmentId: { type: "string", minLength: 1 },
                      tenantCode: { type: "string", minLength: 1 },
                      authProfile: { type: "string", minLength: 1 },
                      writeMode: { enum: ["read-only", "read-write"] },
                      metadataFingerprint: { type: "null" },
                      sourceFingerprint: { type: "null" },
                      revision: { type: "integer", minimum: 1, maximum: 9007199254740991 },
                      createdAt: { type: "string", format: "date-time" },
                      updatedAt: { type: "string", format: "date-time" },
                    },
                    ["workspaceId", "canonicalPath", "environmentId", "tenantCode", "authProfile", "writeMode", "revision", "createdAt", "updatedAt"],
                  ),
                ],
              },
              status: { enum: ["ok", "missing-dir", "orphan", "unavailable"] },
            },
            ["workspaceId", "displayName", "canonicalPath", "binding"],
          ),
        },
      },
      ["requestId", "schemaVersion", "workspaces"],
    ),
  },
  "workspace-inspect-request.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/workspace-inspect-request.json",
    title: "workspace/inspect request",
    ...objectSchema({ ...requestProperties, workspaceId: { type: "string", minLength: 1 } }, ["requestId", "schemaVersion", "workspaceId"]),
  },
  "workspace-inspect-response.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/workspace-inspect-response.json",
    title: "workspace/inspect response",
    ...objectSchema(
      {
        ...requestProperties,
        workspace: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1 },
            displayName: { type: "string", minLength: 1 },
            canonicalPath: { type: "string", minLength: 1 },
            binding: {
              anyOf: [
                { type: "null" },
                objectSchema(
                  {
                    workspaceId: { type: "string", minLength: 1 },
                    canonicalPath: { type: "string", minLength: 1 },
                    environmentId: { type: "string", minLength: 1 },
                    tenantCode: { type: "string", minLength: 1 },
                    authProfile: { type: "string", minLength: 1 },
                    writeMode: { enum: ["read-only", "read-write"] },
                    metadataFingerprint: { type: "null" },
                    sourceFingerprint: { type: "null" },
                    revision: { type: "integer", minimum: 1, maximum: 9007199254740991 },
                    createdAt: { type: "string", format: "date-time" },
                    updatedAt: { type: "string", format: "date-time" },
                  },
                  ["workspaceId", "canonicalPath", "environmentId", "tenantCode", "authProfile", "writeMode", "revision", "createdAt", "updatedAt"],
                ),
              ],
            },
            status: { enum: ["ok", "missing-dir", "orphan", "unavailable"] },
          },
          ["workspaceId", "displayName", "canonicalPath", "binding"],
        ),
      },
      ["requestId", "schemaVersion", "workspace"],
    ),
  },
  "workspace-bind-request.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/workspace-bind-request.json",
    title: "workspace/bind request",
    ...objectSchema(
      {
        ...requestProperties,
        workspaceId: { type: "string", minLength: 1 },
        environmentId: { type: "string", minLength: 1 },
        tenantCode: { type: "string", minLength: 1 },
        authProfile: { type: "string", minLength: 1 },
        writeMode: { enum: ["read-only", "read-write"] },
        expectedRevision: { type: "integer", minimum: 0, maximum: 9007199254740991 },
      },
      ["requestId", "schemaVersion", "workspaceId", "environmentId", "tenantCode", "authProfile", "writeMode", "expectedRevision"],
    ),
  },
  "workspace-bind-response.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/workspace-bind-response.json",
    title: "workspace/bind response",
    ...objectSchema(
      {
        ...requestProperties,
        workspace: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1 },
            displayName: { type: "string", minLength: 1 },
            canonicalPath: { type: "string", minLength: 1 },
            binding: objectSchema(
              {
                workspaceId: { type: "string", minLength: 1 },
                canonicalPath: { type: "string", minLength: 1 },
                environmentId: { type: "string", minLength: 1 },
                tenantCode: { type: "string", minLength: 1 },
                authProfile: { type: "string", minLength: 1 },
                writeMode: { enum: ["read-only", "read-write"] },
                metadataFingerprint: { type: "null" },
                sourceFingerprint: { type: "null" },
                revision: { type: "integer", minimum: 1, maximum: 9007199254740991 },
                createdAt: { type: "string", format: "date-time" },
                updatedAt: { type: "string", format: "date-time" },
              },
              ["workspaceId", "canonicalPath", "environmentId", "tenantCode", "authProfile", "writeMode", "revision", "createdAt", "updatedAt"],
            ),
            status: { enum: ["ok", "missing-dir", "orphan", "unavailable"] },
          },
          ["workspaceId", "displayName", "canonicalPath", "binding"],
        ),
        binding: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1 },
            canonicalPath: { type: "string", minLength: 1 },
            environmentId: { type: "string", minLength: 1 },
            tenantCode: { type: "string", minLength: 1 },
            authProfile: { type: "string", minLength: 1 },
            writeMode: { enum: ["read-only", "read-write"] },
            metadataFingerprint: { type: "null" },
            sourceFingerprint: { type: "null" },
            revision: { type: "integer", minimum: 1, maximum: 9007199254740991 },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
          ["workspaceId", "canonicalPath", "environmentId", "tenantCode", "authProfile", "writeMode", "revision", "createdAt", "updatedAt"],
        ),
      },
      ["requestId", "schemaVersion", "workspace", "binding"],
    ),
  },
  "workspace-unbind-request.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/workspace-unbind-request.json",
    title: "workspace/unbind request",
    ...objectSchema({ ...requestProperties, workspaceId: { type: "string", minLength: 1 }, expectedRevision: { type: "integer", minimum: 1 } }, ["requestId", "schemaVersion", "workspaceId", "expectedRevision"]),
  },
  "workspace-unbind-response.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/workspace-unbind-response.json",
    title: "workspace/unbind response",
    ...objectSchema({ ...requestProperties, workspaceId: { type: "string", minLength: 1 }, deleted: { type: "boolean" } }, ["requestId", "schemaVersion", "workspaceId", "deleted"]),
  },
  "icomposer-list-assets-request.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-list-assets-request.json",
    title: "icomposer/list-assets request",
    ...objectSchema({ ...requestProperties, workspaceId: { type: "string", minLength: 1 }, type: { enum: ["api", "function", "batch", "model"] } }, ["requestId", "schemaVersion", "workspaceId"]),
  },
  "icomposer-list-assets-response.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-list-assets-response.json",
    title: "icomposer/list-assets response",
    ...objectSchema(
      {
        ...requestProperties,
        catalog: objectSchema(
          {
            workspaceId: { type: "string", minLength: 1 },
            canonicalPath: { type: "string", minLength: 1 },
            entries: {
              type: "array",
              maxItems: 5000,
              items: objectSchema(
                {
                  name: { type: "string", minLength: 1 },
                  type: { enum: ["api", "function", "batch", "model"] },
                  metadata: objectSchema(
                    {
                      id: { type: "number" },
                      groupId: { type: "number" },
                      moduleId: { type: "number" },
                      version: { type: "number" },
                      status: { type: "number" },
                      requestMethod: { type: "number" },
                      requestType: { type: "number" },
                      appName: { type: "string" },
                      md5Value: { type: "string" },
                      latestUpdateTime: { type: "string", format: "date-time" },
                      jobName: { type: "string" },
                      recordUsage: { type: "string" },
                      sourceEnvironment: { type: "string" },
                    },
                    [],
                  ),
                  sourcePath: { type: "string", minLength: 1 },
                  sourceFingerprint: { type: "string", minLength: 1 },
                  joinStatus: { enum: ["clean", "local-modified", "no-server-md5", "source-missing", "metadata-missing"] },
                  tenant: { type: "string", minLength: 1 },
                  group: { type: "string", minLength: 1 },
                },
                ["name", "type", "metadata", "joinStatus"],
              ),
            },
            counts: objectSchema(
              {
                api: { type: "integer", minimum: 0 },
                function: { type: "integer", minimum: 0 },
                batch: { type: "integer", minimum: 0 },
                model: { type: "integer", minimum: 0 },
                total: { type: "integer", minimum: 0 },
              },
              ["api", "function", "batch", "model", "total"],
            ),
            truncated: { type: "boolean" },
            sections: {
              type: "object",
              additionalProperties: objectSchema({ status: { enum: ["ok", "missing", "error"] }, skipped: { type: "integer", minimum: 0 } }, ["status"]),
            },
          },
          ["requestId", "schemaVersion", "workspaceId", "canonicalPath", "entries", "counts", "truncated", "sections"],
        ),
      },
      ["requestId", "schemaVersion", "catalog"],
    ),
  },
  "icomposer-sdk-list-request.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-sdk-list-request.json",
    title: "icomposer/sdk-list request",
    ...objectSchema(
    { ...requestProperties, workspaceId: { type: "string", minLength: 1 } },
    ["requestId", "schemaVersion", "workspaceId"],
    ),
  },
  "icomposer-sdk-list-response.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-sdk-list-response.json",
    title: "icomposer/sdk-list response",
    ...objectSchema(
    {
      workspaceId: { type: "string", minLength: 1 },
      clients: {
        type: "array",
        maxItems: 5000,
        items: objectSchema(
          {
            client: { type: "string", minLength: 1 },
            swaggerPath: { type: "string", minLength: 1 },
            operationCount: { type: "integer", minimum: 0 },
            status: { enum: ["ok", "invalid", "skipped-escape"] },
          },
          ["client", "swaggerPath", "operationCount", "status"],
        ),
      },
      counts: objectSchema({ clients: { type: "integer", minimum: 0 }, operations: { type: "integer", minimum: 0 } }, ["clients", "operations"]),
    },
    ["workspaceId", "clients", "counts"],
    ),
  },
  "icomposer-sdk-query-request.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-sdk-query-request.json",
    title: "icomposer/sdk-query request",
    ...objectSchema(
    {
      ...requestProperties,
      workspaceId: { type: "string", minLength: 1 },
      client: { type: "string" },
      keyword: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    ["requestId", "schemaVersion", "workspaceId"],
    ),
  },
  "icomposer-sdk-query-response.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-sdk-query-response.json",
    title: "icomposer/sdk-query response",
    ...objectSchema(
    {
      workspaceId: { type: "string", minLength: 1 },
      operations: {
        type: "array",
        maxItems: 200,
        items: objectSchema(
          {
            client: { type: "string", minLength: 1 },
            method: { enum: ["get", "post", "put", "delete", "patch", "head", "options", "trace"] },
            path: { type: "string", minLength: 1 },
            operationId: { type: "string", minLength: 1 },
            summary: { type: "string", minLength: 1, maxLength: 200 },
            tag: { type: "string", minLength: 1, maxLength: 200 },
          },
          ["client", "method", "path", "operationId"],
        ),
      },
      counts: objectSchema({ clients: { type: "integer", minimum: 0 }, operations: { type: "integer", minimum: 0 } }, ["clients", "operations"]),
      limit: { type: "integer", minimum: 1, maximum: 200 },
      truncated: { type: "boolean" },
    },
    ["workspaceId", "operations", "counts", "limit", "truncated"],
    ),
  },
  "icomposer-util-list-request.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-util-list-request.json",
    title: "icomposer/util-list request",
    ...objectSchema(
    { ...requestProperties, workspaceId: { type: "string", minLength: 1 } },
    ["requestId", "schemaVersion", "workspaceId"],
    ),
  },
  "icomposer-util-list-response.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-util-list-response.json",
    title: "icomposer/util-list response",
    ...objectSchema(
    {
      workspaceId: { type: "string", minLength: 1 },
      utils: {
        type: "array",
        maxItems: 5000,
        items: objectSchema(
          {
            util: { type: "string", minLength: 1 },
            docPath: { type: "string", minLength: 1 },
            methodCount: { type: "integer", minimum: 0 },
            status: { enum: ["ok", "invalid"] },
          },
          ["util", "docPath", "methodCount", "status"],
        ),
      },
      counts: objectSchema({ utils: { type: "integer", minimum: 0 }, methods: { type: "integer", minimum: 0 } }, ["utils", "methods"]),
    },
    ["workspaceId", "utils", "counts"],
    ),
  },
  "icomposer-util-query-request.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-util-query-request.json",
    title: "icomposer/util-query request",
    ...objectSchema(
    {
      ...requestProperties,
      workspaceId: { type: "string", minLength: 1 },
      util: { type: "string" },
      keyword: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    ["requestId", "schemaVersion", "workspaceId"],
    ),
  },
  "icomposer-util-query-response.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-util-query-response.json",
    title: "icomposer/util-query response",
    ...objectSchema(
    {
      workspaceId: { type: "string", minLength: 1 },
      methods: { type: "array", maxItems: 200, items: objectSchema({ util: { type: "string", minLength: 1 }, method: { type: "string", minLength: 1 } }, ["util", "method"]) },
      counts: objectSchema({ utils: { type: "integer", minimum: 0 }, methods: { type: "integer", minimum: 0 } }, ["utils", "methods"]),
      limit: { type: "integer", minimum: 1, maximum: 200 },
      truncated: { type: "boolean" },
    },
    ["workspaceId", "methods", "counts", "limit", "truncated"],
    ),
  },
  "icomposer-init-preview-request.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-init-preview-request.json",
    title: "icomposer/init-preview request",
    ...objectSchema(
    {
      ...requestProperties,
      workspaceId: { type: "string", minLength: 1 },
      groupId: { type: "string" },
      listGroups: { type: "boolean" },
    },
    ["requestId", "schemaVersion", "workspaceId"],
    ),
  },
  "icomposer-init-preview-response.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-init-preview-response.json",
    title: "icomposer/init-preview response",
    type: "object",
    additionalProperties: false,
    anyOf: [
      objectSchema(
        {
          workspaceId: { type: "string", minLength: 1 },
          mode: { const: "groups" },
          groups: {
            type: "array",
            maxItems: 1000,
            items: objectSchema(
              {
                id: { type: "string", minLength: 1 },
                name: { type: "string", minLength: 1, maxLength: 128 },
                path: { type: "string", minLength: 1, maxLength: 128 },
                code: { type: "string", minLength: 1, maxLength: 128 },
              },
              ["id", "name"],
            ),
          },
          count: { type: "integer", minimum: 0 },
          truncated: { type: "boolean" },
          durationMs: { type: "integer", minimum: 0 },
          stdoutDigest: { type: "string", minLength: 1 },
        },
        ["workspaceId", "mode", "groups", "count", "truncated", "durationMs", "stdoutDigest"],
      ),
      objectSchema(
        {
          workspaceId: { type: "string", minLength: 1 },
          mode: { const: "plan" },
          groupId: { type: ["string", "null"] },
          steps: { type: "array", maxItems: 1000, items: { type: "string", minLength: 1, maxLength: 200 } },
          count: { type: "integer", minimum: 0 },
          truncated: { type: "boolean" },
          durationMs: { type: "integer", minimum: 0 },
          stdoutDigest: { type: "string", minLength: 1 },
        },
        ["workspaceId", "mode", "groupId", "steps", "count", "truncated", "durationMs", "stdoutDigest"],
      ),
    ],
  },
  "icomposer-reload-preview-request.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-reload-preview-request.json",
    title: "icomposer/reload-preview request",
    ...objectSchema(
    { ...requestProperties, workspaceId: { type: "string", minLength: 1 } },
    ["requestId", "schemaVersion", "workspaceId"],
    ),
  },
  "icomposer-reload-preview-response.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-reload-preview-response.json",
    title: "icomposer/reload-preview response",
    ...objectSchema(
    {
      workspaceId: { type: "string", minLength: 1 },
      distribution: objectSchema(
        {
          clean: { type: "integer", minimum: 0 },
          localModified: { type: "integer", minimum: 0 },
          noServerMd5: { type: "integer", minimum: 0 },
          sourceMissing: { type: "integer", minimum: 0 },
          metadataMissing: { type: "integer", minimum: 0 },
        },
        ["clean", "localModified", "noServerMd5", "sourceMissing", "metadataMissing"],
      ),
      total: { type: "integer", minimum: 0 },
      top: {
        type: "array",
        maxItems: 50,
        items: objectSchema({ name: { type: "string", minLength: 1 }, type: { enum: ["api", "function", "batch", "model"] } }, ["name", "type"]),
      },
      scannedAt: { type: "string", minLength: 1 },
    },
    ["workspaceId", "distribution", "total", "top", "scannedAt"],
    ),
  },
  "icomposer-verify-utils-request.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-verify-utils-request.json",
    title: "icomposer/verify-utils request",
    ...objectSchema(
    {
      ...requestProperties,
      workspaceId: { type: "string", minLength: 1 },
      file: { type: "string", minLength: 1, maxLength: 256 },
    },
    ["requestId", "schemaVersion", "workspaceId", "file"],
    ),
  },
  "icomposer-verify-utils-response.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-verify-utils-response.json",
    title: "icomposer/verify-utils response",
    ...objectSchema(
    {
      workspaceId: { type: "string", minLength: 1 },
      file: { type: "string", minLength: 1, maxLength: 256 },
      valid: { type: "boolean" },
      classesChecked: { type: "integer", minimum: 0 },
      used: {
        type: "array",
        maxItems: 1000,
        items: objectSchema(
          {
            className: { type: "string", minLength: 1, maxLength: 200 },
            methods: { type: "array", maxItems: 1000, items: { type: "string", minLength: 1, maxLength: 200 } },
          },
          ["className", "methods"],
        ),
      },
      unknownClasses: { type: "array", maxItems: 1000, items: { type: "string", minLength: 1, maxLength: 200 } },
      invalidMethods: {
        type: "array",
        maxItems: 1000,
        items: objectSchema(
          {
            className: { type: "string", minLength: 1, maxLength: 200 },
            method: { type: "string", minLength: 1, maxLength: 200 },
            line: { type: "string", minLength: 1, maxLength: 200 },
            suggestions: { type: "array", maxItems: 1000, items: { type: "string", minLength: 1, maxLength: 200 } },
          },
          [],
        ),
      },
      durationMs: { type: "integer", minimum: 0 },
      stdoutDigest: { type: "string", minLength: 1 },
    },
    ["workspaceId", "file", "valid", "classesChecked", "used", "unknownClasses", "invalidMethods", "durationMs", "stdoutDigest"],
    ),
  },
  "icomposer-utils-list-request.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-utils-list-request.json",
    title: "icomposer/utils-list request",
    ...objectSchema(
    { ...requestProperties, workspaceId: { type: "string", minLength: 1 } },
    ["requestId", "schemaVersion", "workspaceId"],
    ),
  },
  "icomposer-utils-list-response.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-utils-list-response.json",
    title: "icomposer/utils-list response",
    ...objectSchema(
    {
      workspaceId: { type: "string", minLength: 1 },
      classes: {
        type: "array",
        maxItems: 1000,
        items: objectSchema(
          {
            className: { type: "string", minLength: 1, maxLength: 200 },
            methodCount: { type: "integer", minimum: 0 },
            description: { type: "string", minLength: 1, maxLength: 200 },
          },
          ["className", "methodCount"],
        ),
      },
      count: { type: "integer", minimum: 0 },
      truncated: { type: "boolean" },
      durationMs: { type: "integer", minimum: 0 },
      stdoutDigest: { type: "string", minLength: 1 },
    },
    ["workspaceId", "classes", "count", "truncated", "durationMs", "stdoutDigest"],
    ),
  },
  "icomposer-utils-search-request.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-utils-search-request.json",
    title: "icomposer/utils-search request",
    ...objectSchema(
    {
      ...requestProperties,
      workspaceId: { type: "string", minLength: 1 },
      keyword: { type: "string", minLength: 1, maxLength: 128 },
    },
    ["requestId", "schemaVersion", "workspaceId", "keyword"],
    ),
  },
  "icomposer-utils-search-response.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-utils-search-response.json",
    title: "icomposer/utils-search response",
    ...objectSchema(
    {
      workspaceId: { type: "string", minLength: 1 },
      query: { type: "string", minLength: 1, maxLength: 128 },
      matches: {
        type: "array",
        maxItems: 1000,
        items: objectSchema(
          {
            className: { type: "string", minLength: 1, maxLength: 200 },
            method: { type: "string", minLength: 1, maxLength: 200 },
            description: { type: "string", minLength: 1, maxLength: 200 },
          },
          ["className"],
        ),
      },
      count: { type: "integer", minimum: 0 },
      truncated: { type: "boolean" },
      durationMs: { type: "integer", minimum: 0 },
      stdoutDigest: { type: "string", minLength: 1 },
    },
    ["workspaceId", "query", "matches", "count", "truncated", "durationMs", "stdoutDigest"],
    ),
  },
  "ici-build-request.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/ici-build-request.json",
    title: "ici/build request",
    ...objectSchema({ ...requestProperties, workspaceId: { type: "string", minLength: 1 } }, ["requestId", "schemaVersion", "workspaceId"]),
  },
  "ici-build-response.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/ici-build-response.json",
    title: "ici/build response",
    ...objectSchema(
      {
        workspaceId: { type: "string", minLength: 1 },
        manifest: objectSchema(
          {
            schemaVersion: { const: 1 },
            engineVersion: { type: "string", minLength: 1 },
            sourceFingerprint: { type: "string", minLength: 1 },
            builtAt: { type: "string", minLength: 1 },
            nodeCount: { type: "integer", minimum: 0 },
            edgeCount: { type: "integer", minimum: 0 },
            workspaceId: { type: "string", minLength: 1 },
            canonicalPath: { type: "string", minLength: 1 },
          },
          ["schemaVersion", "engineVersion", "sourceFingerprint", "builtAt", "nodeCount", "edgeCount", "workspaceId", "canonicalPath"],
        ),
        nodeCount: { type: "integer", minimum: 0 },
        edgeCount: { type: "integer", minimum: 0 },
      },
      ["workspaceId", "manifest", "nodeCount", "edgeCount"],
    ),
  },
  "ici-query-api.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/ici-query-api.json",
    title: "ici/query-api request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      node: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          kind: { enum: ["api", "function", "method", "model", "batch"] },
          name: { type: "string", minLength: 1 },
          path: { type: "string" },
          ref: { enum: ["seen", "cycle"] },
          edge: objectSchema(
            {
              kind: { enum: ["CONTAINS", "CALLS"] },
              source: { enum: ["static", "platform", "inferred"] },
              confidence: { enum: ["high", "medium", "inferred"] },
              evidence: { type: "string", maxLength: 160 },
              ownerFile: { type: "string" },
            },
            ["kind", "source", "confidence", "evidence", "ownerFile"],
          ),
          children: { type: "array", items: { $ref: "#/$defs/node" } },
        },
        required: ["id", "kind", "name", "path"],
      },
      request: objectSchema(
        {
          ...requestProperties,
          workspaceId: { type: "string", minLength: 1 },
          query: { type: "string", minLength: 1 },
          depth: { type: "integer", minimum: 1, maximum: 50 },
          focus: { type: "string", minLength: 1 },
          maxNodes: { type: "integer", minimum: 1, maximum: 2000 },
        },
        ["requestId", "schemaVersion", "workspaceId", "query"],
      ),
      response: objectSchema(
        {
          workspaceId: { type: "string", minLength: 1 },
          matched: { type: "array", items: { type: "string", minLength: 1 } },
          roots: { type: "array", items: { $ref: "#/$defs/node" } },
          truncated: { type: "boolean" },
          truncatedAt: { type: "array", items: { type: "string", minLength: 1 } },
          stale: { const: true },
        },
        ["workspaceId", "matched", "roots", "truncated", "truncatedAt"],
      ),
    },
  },
  "ici-query-impact.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/ici-query-impact.json",
    title: "ici/query-impact request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      hop: objectSchema(
        {
          nodeId: { type: "string", minLength: 1 },
          edge: objectSchema(
            {
              kind: { enum: ["CONTAINS", "CALLS"] },
              source: { enum: ["static", "platform", "inferred"] },
              confidence: { enum: ["high", "medium", "inferred"] },
              evidence: { type: "string", maxLength: 160 },
              ownerFile: { type: "string" },
            },
            ["kind", "source", "confidence", "evidence", "ownerFile"],
          ),
        },
        ["nodeId"],
      ),
      request: objectSchema(
        {
          ...requestProperties,
          workspaceId: { type: "string", minLength: 1 },
          query: { type: "string", minLength: 1 },
        },
        ["requestId", "schemaVersion", "workspaceId", "query"],
      ),
      response: objectSchema(
        {
          workspaceId: { type: "string", minLength: 1 },
          matched: { type: "array", items: { type: "string", minLength: 1 } },
          paths: {
            type: "array",
            maxItems: 200,
            items: objectSchema(
              {
                apiId: { type: "string", minLength: 1 },
                hops: { type: "array", items: { $ref: "#/$defs/hop" } },
              },
              ["apiId", "hops"],
            ),
          },
          confidenceCounts: objectSchema(
            {
              static: { type: "integer", minimum: 0 },
              platform: { type: "integer", minimum: 0 },
              inferred: { type: "integer", minimum: 0 },
            },
            ["static", "platform", "inferred"],
          ),
          truncated: { type: "boolean" },
          stale: { const: true },
        },
        ["workspaceId", "matched", "paths", "confidenceCounts", "truncated"],
      ),
    },
  },
  "ici-search-index.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/ici-search-index.json",
    title: "ici/search-index request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        {
          ...requestProperties,
          workspaceId: { type: "string", minLength: 1 },
          mode: { enum: ["technical", "business", "all"] },
          rebuild: { type: "boolean" },
        },
        ["requestId", "schemaVersion", "workspaceId"],
      ),
      response: objectSchema(
        {
          workspaceId: { type: "string", minLength: 1 },
          total: { type: "integer", minimum: 0 },
          embedded: { type: "integer", minimum: 0 },
          reused: { type: "integer", minimum: 0 },
          stale: { const: true },
        },
        ["workspaceId", "total", "embedded", "reused"],
      ),
    },
  },
  "ici-search.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/ici-search.json",
    title: "ici/search request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        {
          ...requestProperties,
          workspaceId: { type: "string", minLength: 1 },
          query: { type: "string", minLength: 1 },
          mode: { enum: ["technical", "business", "all"] },
          top: { type: "integer", minimum: 1, maximum: 50 },
        },
        ["requestId", "schemaVersion", "workspaceId", "query"],
      ),
      response: objectSchema(
        {
          workspaceId: { type: "string", minLength: 1 },
          truncated: { type: "boolean" },
          stale: { const: true },
          rows: {
            type: "array",
            maxItems: 50,
            items: objectSchema(
              {
                apiId: { type: "string", minLength: 1 },
                apiName: { type: "string", minLength: 1 },
                score: { type: "number" },
                evidence: { type: "string", maxLength: 200 },
                downstream: { type: "array", maxItems: 5, items: { type: "string", minLength: 1 } },
              },
              ["apiId", "apiName", "score", "evidence", "downstream"],
            ),
          },
        },
        ["workspaceId", "rows", "truncated"],
      ),
    },
  },
  "ici-build-job.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/ici-build-job.json",
    title: "ici/build-job request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        {
          ...requestProperties,
          workspaceId: { type: "string", minLength: 1 },
          mode: { enum: ["graph", "search-index"] },
          rebuild: { type: "boolean" },
        },
        ["requestId", "schemaVersion", "workspaceId"],
      ),
      response: objectSchema(
        {
          workspaceId: { type: "string", minLength: 1 },
          kind: { enum: ["inline", "background"] },
          jobId: { type: "string", minLength: 1 },
          label: { type: "string", minLength: 1 },
          detail: objectSchema(
            {
              nodeCount: { type: "integer", minimum: 0 },
              edgeCount: { type: "integer", minimum: 0 },
              builtAt: { type: "string", minLength: 1 },
              total: { type: "integer", minimum: 0 },
              embedded: { type: "integer", minimum: 0 },
              reused: { type: "integer", minimum: 0 },
            },
            [],
          ),
          error: objectSchema({ code: { type: "string", minLength: 1 } }, ["code"]),
        },
        ["workspaceId", "kind"],
      ),
    },
  },
  "ici-status.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/ici-status.json",
    title: "ici/status request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        { ...requestProperties, workspaceId: { type: "string", minLength: 1 } },
        ["requestId", "schemaVersion", "workspaceId"],
      ),
      response: objectSchema(
        {
          workspaceId: { type: "string", minLength: 1 },
          builtAt: { type: "string" },
          nodeCount: { type: "integer", minimum: 0 },
          edgeCount: { type: "integer", minimum: 0 },
          searchVectors: { type: "integer", minimum: 0 },
          stale: { type: "boolean" },
          engineVersion: { type: "string", minLength: 1 },
          schemaVersion: { type: "integer", minimum: 1 },
          requiredFiles: objectSchema(
            {
              nodes: { type: "boolean" },
              edges: { type: "boolean" },
              manifest: { type: "boolean" },
            },
            ["nodes", "edges", "manifest"],
          ),
          error: objectSchema({ code: { type: "string", minLength: 1 } }, ["code"]),
        },
        ["workspaceId"],
      ),
    },
  },
  "ici-cleanup-plan.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/ici-cleanup-plan.json",
    title: "ici/cleanup-plan request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        { ...requestProperties, workspaceId: { type: "string", minLength: 1 } },
        ["requestId", "schemaVersion", "workspaceId"],
      ),
      response: objectSchema(
        {
          workspaceId: { type: "string", minLength: 1 },
          paths: { type: "array", items: { type: "string", minLength: 1 } },
        },
        ["workspaceId", "paths"],
      ),
    },
  },
  "ici-cleanup-apply.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/ici-cleanup-apply.json",
    title: "ici/cleanup-apply request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        {
          ...requestProperties,
          workspaceId: { type: "string", minLength: 1 },
          expectedPaths: { type: "array", items: { type: "string", minLength: 1 } },
        },
        ["requestId", "schemaVersion", "workspaceId", "expectedPaths"],
      ),
      response: objectSchema(
        {
          workspaceId: { type: "string", minLength: 1 },
          removed: { type: "array", items: { type: "string", minLength: 1 } },
          skipped: { type: "array", items: { type: "string", minLength: 1 } },
        },
        ["workspaceId", "removed", "skipped"],
      ),
    },
  },
  "ici-explain-context.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/ici-explain-context.json",
    title: "ici/explain-context request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        {
          ...requestProperties,
          workspaceId: { type: "string", minLength: 1 },
          query: { type: "string", minLength: 1 },
        },
        ["requestId", "schemaVersion", "workspaceId", "query"],
      ),
      response: objectSchema(
        {
          workspaceId: { type: "string", minLength: 1 },
          api: objectSchema(
            { id: { type: "string", minLength: 1, required: true }, name: { type: "string", minLength: 1, required: true }, path: { type: "string" } },
            ["id", "name"],
          ),
          technicalText: { type: "string" },
          downstream: { type: "array", items: { type: "object" } },
          impact: { type: "array", items: objectSchema({ apiId: { type: "string", minLength: 1 }, hops: { type: "array", items: objectSchema({ nodeId: { type: "string", minLength: 1 } }, ["nodeId"]) } }, ["apiId", "hops"]) },
          businessReference: { type: "array", items: { type: "string" } },
          manifest: objectSchema(
            {
              schemaVersion: { type: "integer", minimum: 1 },
              engineVersion: { type: "string", minLength: 1 },
              sourceFingerprint: { type: "string", minLength: 1 },
              stale: { const: true },
            },
            ["schemaVersion", "engineVersion", "sourceFingerprint"],
          ),
        },
        ["workspaceId", "api", "technicalText", "downstream", "impact", "businessReference", "manifest"],
      ),
    },
  },
  "ici-explain-deterministic.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/ici-explain-deterministic.json",
    title: "ici/explain-deterministic request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        {
          ...requestProperties,
          workspaceId: { type: "string", minLength: 1 },
          query: { type: "string", minLength: 1 },
        },
        ["requestId", "schemaVersion", "workspaceId", "query"],
      ),
      response: objectSchema(
        {
          workspaceId: { type: "string", minLength: 1 },
          generatedBy: { const: "deterministic-v1" },
          promptVersion: { const: "none" },
          sourceFingerprint: { type: "string", minLength: 1 },
          generatedAt: { type: "string", minLength: 1 },
          technical: { type: "string", minLength: 1 },
          business: { type: "string", minLength: 1 },
          method: { type: "array", items: { type: "string", minLength: 1 } },
        },
        ["workspaceId", "generatedBy", "promptVersion", "sourceFingerprint", "generatedAt", "technical", "business", "method"],
      ),
    },
  },
  "icomposer-write-push-preview.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-write-push-preview.json",
    title: "icomposer-write/push-preview request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        {
          ...requestProperties,
          workspaceId: { type: "string", minLength: 1 },
          files: { type: "array", minItems: 1, maxItems: 200, items: { type: "string", minLength: 1, maxLength: 256 } },
          batch: { type: "boolean" },
        },
        ["requestId", "schemaVersion", "workspaceId", "files"],
      ),
      response: objectSchema(
        {
          workspaceId: { type: "string", minLength: 1 },
          mode: { enum: ["current", "batch"] },
          files: {
            type: "array",
            maxItems: 200,
            items: objectSchema(
              {
                file: { type: "string", minLength: 1, maxLength: 256 },
                target: { type: "string", minLength: 1, maxLength: 200 },
                localVersion: { type: "string", pattern: "^(sha256:[0-9a-f]{64})?$" },
                serverVersion: { type: "string", maxLength: 200 },
                conflict: { type: "boolean" },
                compileChecks: objectSchema(
                  {
                    compile: { type: "boolean" },
                    callersFound: { type: "integer", minimum: 0 },
                    callersCompiled: { type: "integer", minimum: 0 },
                    callerFailures: { type: "integer", minimum: 0 },
                  },
                  ["compile", "callersFound", "callersCompiled", "callerFailures"],
                ),
                warnings: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 200 } },
              },
              ["file", "target", "localVersion", "serverVersion", "conflict", "warnings"],
            ),
          },
          conflictFiles: { type: "array", items: { type: "string", minLength: 1, maxLength: 256 } },
          count: { type: "integer", minimum: 0 },
          truncated: { type: "boolean" },
          durationMs: { type: "integer", minimum: 0 },
          stdoutDigest: { type: "string", minLength: 1 },
        },
        ["workspaceId", "mode", "files", "conflictFiles", "count", "truncated", "durationMs", "stdoutDigest"],
      ),
    },
  },
  "icomposer-write-push-request.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-write-push-request.json",
    title: "icomposer-write/push-request request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        {
          ...requestProperties,
          workspaceId: { type: "string", minLength: 1 },
          files: { type: "array", minItems: 1, maxItems: 200, items: { type: "string", minLength: 1, maxLength: 256 } },
          batch: { type: "boolean" },
          checkUsages: { type: "boolean" },
          skipCompile: { type: "boolean" },
        },
        ["requestId", "schemaVersion", "workspaceId", "files"],
      ),
      response: objectSchema(
        {
          operationId: { type: "string", minLength: 1 },
          kind: { enum: ["imo-icomposer-push", "imo-icomposer-push-resolve"] },
          mode: { enum: ["current", "batch"] },
          files: { type: "array", items: { type: "string", minLength: 1, maxLength: 256 } },
          paramsDigest: { type: "string", minLength: 1 },
          decision: { const: "pending" },
          preview: { $ref: "#/$defs/preview" },
        },
        ["operationId", "kind", "mode", "files", "paramsDigest", "decision", "preview"],
      ),
      preview: {
        type: "object",
        properties: {
          workspaceId: { type: "string", minLength: 1 },
          mode: { enum: ["current", "batch"] },
          count: { type: "integer", minimum: 0 },
          truncated: { type: "boolean" },
          conflictFiles: { type: "array", items: { type: "string" } },
          stdoutDigest: { type: "string" },
        },
        required: ["workspaceId", "mode", "count", "truncated", "conflictFiles", "stdoutDigest"],
        additionalProperties: false,
      },
    },
  },
  "icomposer-write-push-execute.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-write-push-execute.json",
    title: "icomposer-write/push-execute request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        { ...requestProperties, operationId: { type: "string", minLength: 1 } },
        ["requestId", "schemaVersion", "operationId"],
      ),
      response: objectSchema(
        {
          operationId: { type: "string", minLength: 1 },
          status: { enum: ["completed", "failed", "conflict"] },
          mode: { enum: ["current", "batch"] },
          files: { type: "array", items: { type: "string" } },
          requestedFlags: objectSchema(
            {
              checkUsages: { type: "boolean" },
              skipCompile: { type: "boolean" },
              prefer: { enum: ["prefer-local", "prefer-server"] },
            },
            [],
          ),
          exitCode: { type: "integer" },
          stdoutDigest: { type: "string" },
          stderrDigest: { type: "string" },
          conflictFiles: { type: "array", items: { type: "string" } },
          conflictSummary: { type: "string" },
          pushDigest: { type: "string" },
          startedAt: { type: "string", format: "date-time" },
          finishedAt: { type: "string", format: "date-time" },
        },
        ["operationId", "status", "mode", "files", "requestedFlags", "exitCode", "stdoutDigest", "stderrDigest", "conflictFiles", "conflictSummary", "pushDigest", "startedAt", "finishedAt"],
      ),
    },
  },
  "icomposer-write-push-resolve.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-write-push-resolve.json",
    title: "icomposer-write/push-resolve request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        {
          ...requestProperties,
          operationId: { type: "string", minLength: 1 },
          choice: { enum: ["prefer-local", "prefer-server", "cancel"] },
          by: { type: "string", minLength: 1, maxLength: 128 },
        },
        ["requestId", "schemaVersion", "operationId", "choice", "by"],
      ),
      response: {
        type: "object",
        properties: {
          ok: { const: true },
          value: {
            type: "object",
            properties: {
              operationId: { type: "string", minLength: 1 },
              kind: { const: "imo-icomposer-push-resolve" },
              choice: { enum: ["prefer-local", "prefer-server", "cancel"] },
              decision: { enum: ["rejected", "pending"] },
              reason: { type: "string" },
              originalOperationId: { type: "string", minLength: 1 },
              paramsDigest: { type: "string" },
              mode: { enum: ["current", "batch"] },
              files: { type: "array", items: { type: "string" } },
            },
            required: ["operationId", "kind", "choice", "decision", "originalOperationId"],
            additionalProperties: false,
          },
        },
        required: ["ok", "value"],
        additionalProperties: false,
      },
    },
  },
  "icomposer-write-push-status.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-write-push-status.json",
    title: "icomposer-write/push-status request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        { ...requestProperties, operationId: { type: "string", minLength: 1 } },
        ["requestId", "schemaVersion", "operationId"],
      ),
      response: objectSchema(
        {
          operationId: { type: "string", minLength: 1 },
          kind: { enum: ["imo-icomposer-push", "imo-icomposer-push-resolve"] },
          decision: { enum: ["pending", "approved", "rejected"] },
          paramsDigest: { type: "string", minLength: 1 },
          resultDigest: { type: "string", minLength: 1 },
          executed: { type: "boolean" },
          status: { enum: ["completed", "failed", "conflict"] },
          conflictFiles: { type: "array", items: { type: "string" } },
          prefer: { enum: ["prefer-local", "prefer-server"] },
          originalOperationId: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1 },
        },
        ["operationId", "kind", "decision", "paramsDigest", "executed", "conflictFiles"],
      ),
    },
  },
  "icomposer-write-test-run.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-write-test-run.json",
    title: "icomposer-write/test-run request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        {
          ...requestProperties,
          workspaceId: { type: "string", minLength: 1 },
          kind: { enum: ["api", "function"] },
          name: { type: "string", minLength: 1, maxLength: 200 },
          data: { type: "string", maxLength: 65536 },
          method: { type: "string", minLength: 1, maxLength: 128 },
          overrideUnpushed: { type: "boolean" },
        },
        ["requestId", "schemaVersion", "workspaceId", "kind", "name"],
      ),
      response: objectSchema(
        {
          operationId: { type: "string", minLength: 1 },
          kind: { const: "imo-icomposer-test" },
          assetKind: { enum: ["api", "function"] },
          name: { type: "string", minLength: 1, maxLength: 200 },
          paramsDigest: { type: "string", minLength: 1 },
          decision: { const: "pending" },
          joinState: { enum: ["clean", "local-modified", "no-server-md5", "source-missing", "metadata-missing"] },
          overrideUnpushed: { type: "boolean" },
        },
        ["operationId", "kind", "assetKind", "name", "paramsDigest", "decision", "joinState", "overrideUnpushed"],
      ),
    },
  },
  "icomposer-write-release-preview.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-write-release-preview.json",
    title: "icomposer-write/release-preview request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        {
          ...requestProperties,
          workspaceId: { type: "string", minLength: 1 },
          type: { enum: ["api", "function"] },
          name: { type: "string", minLength: 1, maxLength: 200 },
          repo: { type: "string", minLength: 1, maxLength: 512 },
          branch: { type: "string", minLength: 1, maxLength: 128 },
          message: { type: "string", minLength: 1, maxLength: 500 },
        },
        ["requestId", "schemaVersion", "workspaceId", "type", "name", "repo", "branch", "message"],
      ),
      response: objectSchema(
        {
          workspaceId: { type: "string", minLength: 1 },
          type: { enum: ["api", "function"] },
          name: { type: "string", minLength: 1, maxLength: 200 },
          valid: { type: "boolean" },
          warnings: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 200 } },
          durationMs: { type: "integer", minimum: 0 },
          stdoutDigest: { type: "string", minLength: 1 },
        },
        ["workspaceId", "type", "name", "valid", "warnings", "durationMs", "stdoutDigest"],
      ),
    },
  },
  "icomposer-write-release-repos.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-write-release-repos.json",
    title: "icomposer-write/release-repos request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        { ...requestProperties, workspaceId: { type: "string", minLength: 1 } },
        ["requestId", "schemaVersion", "workspaceId"],
      ),
      response: objectSchema(
        {
          workspaceId: { type: "string", minLength: 1 },
          repos: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 512 } },
          count: { type: "integer", minimum: 0 },
          truncated: { type: "boolean" },
          stdoutDigest: { type: "string", minLength: 1 },
        },
        ["workspaceId", "repos", "count", "truncated", "stdoutDigest"],
      ),
    },
  },
  "icomposer-write-release-branches.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-write-release-branches.json",
    title: "icomposer-write/release-branches request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        {
          ...requestProperties,
          workspaceId: { type: "string", minLength: 1 },
          repo: { type: "string", minLength: 1, maxLength: 512 },
        },
        ["requestId", "schemaVersion", "workspaceId", "repo"],
      ),
      response: objectSchema(
        {
          workspaceId: { type: "string", minLength: 1 },
          repo: { type: "string", minLength: 1, maxLength: 512 },
          branches: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 128 } },
          count: { type: "integer", minimum: 0 },
          truncated: { type: "boolean" },
          stdoutDigest: { type: "string", minLength: 1 },
        },
        ["workspaceId", "repo", "branches", "count", "truncated", "stdoutDigest"],
      ),
    },
  },
  "icomposer-write-release-apply.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-write-release-apply.json",
    title: "icomposer-write/release-apply request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        {
          ...requestProperties,
          workspaceId: { type: "string", minLength: 1 },
          type: { enum: ["api", "function"] },
          name: { type: "string", minLength: 1, maxLength: 200 },
          repo: { type: "string", minLength: 1, maxLength: 512 },
          branch: { type: "string", minLength: 1, maxLength: 128 },
          message: { type: "string", minLength: 1, maxLength: 500 },
        },
        ["requestId", "schemaVersion", "workspaceId", "type", "name", "repo", "branch", "message"],
      ),
      response: objectSchema(
        {
          operationId: { type: "string", minLength: 1 },
          kind: { const: "imo-icomposer-release" },
          type: { enum: ["api", "function"] },
          name: { type: "string", minLength: 1, maxLength: 200 },
          repo: { type: "string", minLength: 1, maxLength: 512 },
          branch: { type: "string", minLength: 1, maxLength: 128 },
          paramsDigest: { type: "string", minLength: 1 },
          decision: { const: "pending" },
        },
        ["operationId", "kind", "type", "name", "repo", "branch", "paramsDigest", "decision"],
      ),
    },
  },
  "icomposer-write-create-options.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-write-create-options.json",
    title: "icomposer-write/create-options request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        {
          ...requestProperties,
          workspaceId: { type: "string", minLength: 1 },
          kind: { enum: ["api", "function"] },
        },
        ["requestId", "schemaVersion", "workspaceId", "kind"],
      ),
      response: objectSchema(
        {
          workspaceId: { type: "string", minLength: 1 },
          kind: { enum: ["api", "function"] },
          status: { type: "array", maxItems: 50, items: { $ref: "#/$defs/option" } },
          funcScope: { type: "array", maxItems: 50, items: { $ref: "#/$defs/option" } },
          requestMethod: { type: "array", maxItems: 50, items: { $ref: "#/$defs/option" } },
          requestType: { type: "array", maxItems: 50, items: { $ref: "#/$defs/option" } },
          responseType: { type: "array", maxItems: 50, items: { $ref: "#/$defs/option" } },
          stdoutDigest: { type: "string", minLength: 1 },
        },
        ["workspaceId", "kind", "status", "funcScope", "requestMethod", "requestType", "responseType", "stdoutDigest"],
      ),
      option: objectSchema(
        {
          code: { type: "integer" },
          label: { type: "string", minLength: 1, maxLength: 200 },
          canonicalInput: { type: "string", minLength: 1, maxLength: 200 },
          allowedMethods: { type: "array", maxItems: 16, items: { type: "string", minLength: 1, maxLength: 32 } },
        },
        ["code", "label", "canonicalInput"],
      ),
    },
  },
  "icomposer-write-create-preview.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-write-create-preview.json",
    title: "icomposer-write/create-preview request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        {
          ...requestProperties,
          workspaceId: { type: "string", minLength: 1 },
          kind: { enum: ["api", "function"] },
          params: { $ref: "#/$defs/params" },
        },
        ["requestId", "schemaVersion", "workspaceId", "kind", "params"],
      ),
      params: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          moduleId: { type: "string", pattern: "^[0-9]{1,19}$" },
          groupId: { type: "string", pattern: "^[0-9]{1,19}$" },
          status: { type: "string", minLength: 1, maxLength: 64 },
          requestMethod: { type: "string", minLength: 1, maxLength: 64 },
          requestType: { type: "string", minLength: 1, maxLength: 64 },
          responseType: { type: "string", minLength: 1, maxLength: 64 },
          requestModelId: { type: "string", pattern: "^[0-9]{1,19}$" },
          responseModelId: { type: "string", pattern: "^[0-9]{1,19}$" },
          path: { type: "string", minLength: 1, maxLength: 256 },
          description: { type: "string", minLength: 1, maxLength: 500 },
          sse: { type: "boolean" },
          integration: { type: "string", minLength: 1, maxLength: 200 },
          funcScope: { type: "string", minLength: 1, maxLength: 64 },
        },
        required: ["name", "moduleId", "groupId", "status"],
        additionalProperties: false,
      },
      response: objectSchema(
        {
          workspaceId: { type: "string", minLength: 1 },
          kind: { enum: ["api", "function"] },
          name: { type: "string", minLength: 1, maxLength: 200 },
          valid: { type: "boolean" },
          warnings: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 200 } },
          durationMs: { type: "integer", minimum: 0 },
          stdoutDigest: { type: "string", minLength: 1 },
        },
        ["workspaceId", "kind", "name", "valid", "warnings", "durationMs", "stdoutDigest"],
      ),
    },
  },
  "icomposer-write-create-execute.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-write-create-execute.json",
    title: "icomposer-write/create-execute request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        { ...requestProperties, operationId: { type: "string", minLength: 1 } },
        ["requestId", "schemaVersion", "operationId"],
      ),
      response: objectSchema(
        {
          operationId: { type: "string", minLength: 1 },
          kind: { const: "imo-icomposer-create" },
          assetKind: { enum: ["api", "function"] },
          name: { type: "string", minLength: 1, maxLength: 200 },
          status: { enum: ["completed", "failed"] },
          exitCode: { type: "integer" },
          stdoutDigest: { type: "string", minLength: 1 },
          stderrDigest: { type: "string", minLength: 1 },
          catalogVerified: { type: "boolean" },
          startedAt: { type: "string", format: "date-time" },
          finishedAt: { type: "string", format: "date-time" },
        },
        ["operationId", "kind", "assetKind", "name", "status", "exitCode", "stdoutDigest", "stderrDigest", "catalogVerified", "startedAt", "finishedAt"],
      ),
    },
  },
  "icomposer-write-metadata-preview.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-write-metadata-preview.json",
    title: "icomposer-write/metadata-preview request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        {
          ...requestProperties,
          workspaceId: { type: "string", minLength: 1 },
          file: { type: "string", minLength: 1, maxLength: 256 },
          fields: objectSchema(
            {
              status: { type: "string", minLength: 1, maxLength: 64 },
              description: { type: "string", maxLength: 500 },
              sse: { type: "boolean" },
              integration: { type: "string", minLength: 1, maxLength: 200 },
              funcScope: { type: "string", minLength: 1, maxLength: 64 },
            },
            [],
          ),
        },
        ["requestId", "schemaVersion", "workspaceId", "file", "fields"],
      ),
      response: objectSchema(
        {
          workspaceId: { type: "string", minLength: 1 },
          file: { type: "string", minLength: 1, maxLength: 256 },
          valid: { type: "boolean" },
          warnings: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 200 } },
          durationMs: { type: "integer", minimum: 0 },
          stdoutDigest: { type: "string", minLength: 1 },
        },
        ["workspaceId", "file", "valid", "warnings", "durationMs", "stdoutDigest"],
      ),
    },
  },
  "icomposer-write-metadata-execute.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/icomposer-write-metadata-execute.json",
    title: "icomposer-write/metadata-execute request or response",
    type: "object",
    oneOf: [{ $ref: "#/$defs/request" }, { $ref: "#/$defs/response" }],
    $defs: {
      request: objectSchema(
        { ...requestProperties, operationId: { type: "string", minLength: 1 } },
        ["requestId", "schemaVersion", "operationId"],
      ),
      response: objectSchema(
        {
          operationId: { type: "string", minLength: 1 },
          kind: { const: "imo-icomposer-metadata-update" },
          file: { type: "string", minLength: 1, maxLength: 256 },
          fieldsApplied: { type: "array", minItems: 1, items: { enum: ["status", "description", "sse", "integration", "funcScope"] } },
          status: { enum: ["completed", "failed"] },
          exitCode: { type: "integer" },
          stdoutDigest: { type: "string", minLength: 1 },
          stderrDigest: { type: "string", minLength: 1 },
          startedAt: { type: "string", format: "date-time" },
          finishedAt: { type: "string", format: "date-time" },
        },
        ["operationId", "kind", "file", "fieldsApplied", "status", "exitCode", "stdoutDigest", "stderrDigest", "startedAt", "finishedAt"],
      ),
    },
  },
  "operation-record.schema.json": commandSchema(
    "operation-record",
    "operation/record request or response",
    objectSchema(
      {
        ...requestProperties,
        ...operationRecordInputProperties,
      },
      ["requestId", "schemaVersion", "kind", "paramsDigest", "artifactRefs"],
    ),
    objectSchema(
      {
        ...requestProperties,
        operation: { $ref: "#/$defs/operationRecord" },
      },
      ["requestId", "schemaVersion", "operation"],
    ),
  ),
  "operation-list.schema.json": commandSchema(
    "operation-list",
    "operation/list request or response",
    objectSchema(
      {
        ...requestProperties,
        filter: {
          ...objectSchema(
            {
              requestId: { type: "string", minLength: 1 },
              kind: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
              decision: { enum: ["pending", "approved", "rejected"] },
            },
            [],
          ),
        },
      },
      ["requestId", "schemaVersion"],
    ),
    objectSchema(
      {
        ...requestProperties,
        operations: { type: "array", items: { $ref: "#/$defs/operationRecord" } },
      },
      ["requestId", "schemaVersion", "operations"],
    ),
  ),
  "operation-decide.schema.json": commandSchema(
    "operation-decide",
    "operation/decide request or response",
    objectSchema(
      {
        ...requestProperties,
        id: { type: "string", minLength: 1 },
        approved: { type: "boolean" },
        by: { type: "string", minLength: 1 },
        reason: { type: "string", minLength: 1 },
      },
      ["requestId", "schemaVersion", "id", "approved", "by"],
    ),
    objectSchema(
      {
        ...requestProperties,
        operation: { $ref: "#/$defs/operationRecord" },
      },
      ["requestId", "schemaVersion", "operation"],
    ),
  ),
};

await mkdir(outputDirectory, { recursive: true });
for (const [fileName, schema] of Object.entries(schemas)) {
  await writeFile(`${outputDirectory}/${fileName}`, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
}

console.log(`Generated ${Object.keys(schemas).length} JSON Schema files in ${outputDirectory}`);
