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
              command: { enum: ["system/capabilities", "workspace/list", "operation/record", "operation/list", "operation/decide"] },
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
              environmentId: { type: "string", minLength: 1 },
              tenantCode: { type: "string", minLength: 1 },
              authProfile: { type: "string", minLength: 1 },
              writeMode: { enum: ["read-only", "read-write"] },
            },
            ["workspaceId", "displayName", "canonicalPath", "writeMode"],
          ),
        },
      },
      ["requestId", "schemaVersion", "workspaces"],
    ),
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
