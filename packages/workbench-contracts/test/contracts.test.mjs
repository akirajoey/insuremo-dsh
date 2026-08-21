import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const baseSchemaFiles = [
  "system-capabilities-request.schema.json",
  "system-capabilities-response.schema.json",
  "workspace-list-request.schema.json",
  "workspace-list-response.schema.json",
  "workspace-inspect-request.schema.json",
  "workspace-inspect-response.schema.json",
  "workspace-bind-request.schema.json",
  "workspace-bind-response.schema.json",
  "workspace-unbind-request.schema.json",
  "workspace-unbind-response.schema.json",
  "icomposer-list-assets-request.schema.json",
  "icomposer-list-assets-response.schema.json",
  "icomposer-sdk-list-request.schema.json",
  "icomposer-sdk-list-response.schema.json",
  "icomposer-sdk-query-request.schema.json",
  "icomposer-sdk-query-response.schema.json",
  "icomposer-util-list-request.schema.json",
  "icomposer-util-list-response.schema.json",
  "icomposer-util-query-request.schema.json",
  "icomposer-util-query-response.schema.json",
  "icomposer-init-preview-request.schema.json",
  "icomposer-init-preview-response.schema.json",
  "icomposer-reload-preview-request.schema.json",
  "icomposer-reload-preview-response.schema.json",
  "icomposer-verify-utils-request.schema.json",
  "icomposer-verify-utils-response.schema.json",
  "icomposer-utils-list-request.schema.json",
  "icomposer-utils-list-response.schema.json",
  "icomposer-utils-search-request.schema.json",
  "icomposer-utils-search-response.schema.json",
  "ici-build-request.schema.json",
  "ici-build-response.schema.json",
];

const iciQuerySchemaFiles = [
  "ici-query-api.schema.json",
  "ici-query-impact.schema.json",
  "ici-search-index.schema.json",
  "ici-search.schema.json",
  "ici-build-job.schema.json",
  "ici-status.schema.json",
  "ici-cleanup-plan.schema.json",
  "ici-cleanup-apply.schema.json",
  "ici-explain-context.schema.json",
  "ici-explain-deterministic.schema.json",
  "icomposer-write-push-preview.schema.json",
  "icomposer-write-push-request.schema.json",
  "icomposer-write-push-execute.schema.json",
  "icomposer-write-push-resolve.schema.json",
  "icomposer-write-push-status.schema.json",
];
const operationSchemaFiles = [
  "operation-record.schema.json",
  "operation-list.schema.json",
  "operation-decide.schema.json",
];

async function readSchema(file) {
  return JSON.parse(await readFile(new URL(`../dist/${file}`, import.meta.url), "utf8"));
}

test("generation produces the v0 contract schema documents", async () => {
  const files = (await readdir(new URL("../dist/", import.meta.url)))
    .filter((file) => file.endsWith(".schema.json"))
    .sort();
  assert.equal(files.length, 50);
  assert.deepEqual(
    files,
    [...baseSchemaFiles, ...operationSchemaFiles, ...iciQuerySchemaFiles].sort(),
  );
});

const serviceViewResponses = [
  "icomposer-sdk-list-response.schema.json",
  "icomposer-sdk-query-response.schema.json",
  "icomposer-util-list-response.schema.json",
  "icomposer-util-query-response.schema.json",
  "icomposer-init-preview-response.schema.json",
  "icomposer-reload-preview-response.schema.json",
  "icomposer-verify-utils-response.schema.json",
  "icomposer-utils-list-response.schema.json",
  "icomposer-utils-search-response.schema.json",
  "ici-build-response.schema.json",
];

test("base contract schemas are valid JSON Schema documents", async () => {
  for (const file of baseSchemaFiles) {
    const schema = await readSchema(file);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    if (file === "icomposer-init-preview-response.schema.json") {
      // response is a discriminated union of service views
      assert.ok(Array.isArray(schema.anyOf));
      assert.equal(schema.anyOf.length, 2);
      for (const alt of schema.anyOf) {
        assert.equal(alt.additionalProperties, false);
        assert.equal(alt.type, "object");
        assert.ok(alt.required.includes("workspaceId"));
        assert.equal(alt.required.includes("requestId"), false);
      }
      continue;
    }
    assert.ok(Array.isArray(schema.required));
    if (serviceViewResponses.includes(file)) {
      // response schemas mirror the service view (no transport envelope fields)
      assert.ok(schema.required.includes("workspaceId"));
      assert.equal(schema.required.includes("requestId"), false);
      assert.equal(schema.required.includes("schemaVersion"), false);
    } else {
      assert.ok(schema.required.includes("requestId"));
      assert.ok(schema.required.includes("schemaVersion"));
    }
  }
});

test("operation schemas expose request and response alternatives", async () => {
  for (const file of operationSchemaFiles) {
    const schema = await readSchema(file);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.type, "object");
    assert.equal(schema.oneOf.length, 2);
    assert.ok(schema.$defs.operationRecord);
    assert.ok(schema.$defs.request);
    assert.ok(schema.$defs.response);
  }
});

test("ici query schemas expose request and response alternatives with recursive nodes", async () => {
  for (const file of iciQuerySchemaFiles) {
    const schema = await readSchema(file);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.type, "object");
    assert.equal(schema.oneOf.length, 2);
    assert.ok(schema.$defs.request);
    assert.ok(schema.$defs.response);
  }
  const apiSchema = await readSchema("ici-query-api.schema.json");
  assert.ok(apiSchema.$defs.node.properties.children.items.$ref === "#/$defs/node");
});

test("generated schemas use the v0 schema version", async () => {
  const schema = await readSchema("system-capabilities-request.schema.json");
  assert.deepEqual(schema.properties.schemaVersion, { const: "0" });
});
