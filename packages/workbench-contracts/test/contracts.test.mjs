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
  assert.equal(files.length, 13);
  assert.deepEqual(
    files,
    [...baseSchemaFiles, ...operationSchemaFiles].sort(),
  );
});

test("base contract schemas are valid JSON Schema documents", async () => {
  for (const file of baseSchemaFiles) {
    const schema = await readSchema(file);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.ok(Array.isArray(schema.required));
    assert.ok(schema.required.includes("requestId"));
    assert.ok(schema.required.includes("schemaVersion"));
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

test("generated schemas use the v0 schema version", async () => {
  const schema = await readSchema("system-capabilities-request.schema.json");
  assert.deepEqual(schema.properties.schemaVersion, { const: "0" });
});
