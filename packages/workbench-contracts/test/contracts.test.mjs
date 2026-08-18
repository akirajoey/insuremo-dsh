import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schemaFiles = [
  "system-capabilities-request.schema.json",
  "system-capabilities-response.schema.json",
  "workspace-list-request.schema.json",
  "workspace-list-response.schema.json",
];

test("generated contract schemas are valid JSON Schema documents", async () => {
  for (const file of schemaFiles) {
    const schema = JSON.parse(await readFile(new URL(`../dist/${file}`, import.meta.url), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.ok(Array.isArray(schema.required));
    assert.ok(schema.required.includes("requestId"));
    assert.ok(schema.required.includes("schemaVersion"));
  }
});

test("generated schemas use the v0 schema version", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../dist/system-capabilities-request.schema.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(schema.properties.schemaVersion, { const: "0" });
});
