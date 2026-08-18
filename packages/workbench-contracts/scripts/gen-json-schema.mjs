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

const schemas = {
  "system-capabilities-request.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/system-capabilities-request.json",
    title: "system/capabilities request",
    type: "object",
    properties: requestProperties,
    required: ["requestId", "schemaVersion"],
    additionalProperties: false,
  },
  "system-capabilities-response.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/system-capabilities-response.json",
    title: "system/capabilities response",
    type: "object",
    properties: {
      ...requestProperties,
      capabilities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            command: { enum: ["system/capabilities", "workspace/list"] },
            description: { type: "string", minLength: 1 },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
    },
    required: ["requestId", "schemaVersion", "capabilities"],
    additionalProperties: false,
  },
  "workspace-list-request.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/workspace-list-request.json",
    title: "workspace/list request",
    type: "object",
    properties: requestProperties,
    required: ["requestId", "schemaVersion"],
    additionalProperties: false,
  },
  "workspace-list-response.schema.json": {
    $schema: draft,
    $id: "https://icomposer.workbench/schemas/workspace-list-response.json",
    title: "workspace/list response",
    type: "object",
    properties: {
      ...requestProperties,
      workspaces: {
        type: "array",
        items: {
          type: "object",
          properties: {
            workspaceId: { type: "string", minLength: 1 },
            displayName: { type: "string", minLength: 1 },
            canonicalPath: { type: "string", minLength: 1 },
            environmentId: { type: "string", minLength: 1 },
            tenantCode: { type: "string", minLength: 1 },
            authProfile: { type: "string", minLength: 1 },
            writeMode: { enum: ["read-only", "read-write"] },
          },
          required: ["workspaceId", "displayName", "canonicalPath", "writeMode"],
          additionalProperties: false,
        },
      },
    },
    required: ["requestId", "schemaVersion", "workspaces"],
    additionalProperties: false,
  },
};

await mkdir(outputDirectory, { recursive: true });
for (const [fileName, schema] of Object.entries(schemas)) {
  await writeFile(`${outputDirectory}/${fileName}`, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
}

console.log(`Generated ${Object.keys(schemas).length} JSON Schema files in ${outputDirectory}`);
