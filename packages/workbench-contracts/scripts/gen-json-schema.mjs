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
              command: { enum: ["system/capabilities", "workspace/list", "workspace/inspect", "workspace/bind", "workspace/unbind", "icomposer/list-assets", "icomposer/sdk-list", "icomposer/sdk-query", "icomposer/util-list", "icomposer/util-query", "icomposer/init-preview", "icomposer/reload-preview", "icomposer/verify-utils", "icomposer/utils-list", "icomposer/utils-search", "ici/build", "ici/query-api", "ici/query-impact", "ici/search-index", "ici/search", "operation/record", "operation/list", "operation/decide"] },
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
