/** Canonical JSON output schemas for the iComposer Agent tools (dsh-tools DSL). */

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  const requiredSet = new Set(required);
  return {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, requiredSet.has(key) ? { ...(value as Record<string, unknown>), required: true } : value])),
  };
}

const errorProperty: Record<string, unknown> = {
  error: objectSchema({ code: { type: "string", required: true } }, ["code"]),
};

export function catalogListOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      workspace_id: { type: "string", required: true },
      counts: objectSchema(
        {
          api: { type: "integer" },
          function: { type: "integer" },
          batch: { type: "integer" },
          model: { type: "integer" },
          total: { type: "integer" },
        },
        ["api", "function", "batch", "model", "total"],
      ),
      truncated: { type: "boolean" },
      entries: {
        type: "array",
        items: objectSchema(
          {
            name: { type: "string", required: true },
            type: { type: "string", required: true },
            joinStatus: { type: "string", required: true },
          },
          ["name", "type", "joinStatus"],
        ),
      },
      ...errorProperty,
    },
  };
}

export function sdkQueryOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      workspace_id: { type: "string", required: true },
      count: { type: "integer" },
      total: { type: "integer" },
      truncated: { type: "boolean" },
      operations: {
        type: "array",
        items: objectSchema(
          {
            client: { type: "string", required: true },
            method: { type: "string", required: true },
            path: { type: "string", required: true },
            operationId: { type: "string", required: true },
          },
          ["client", "method", "path", "operationId"],
        ),
      },
      ...errorProperty,
    },
  };
}

export function verifyUtilsOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      workspace_id: { type: "string", required: true },
      mode: { type: "string", enum: ["list", "search"], required: true },
      count: { type: "integer" },
      truncated: { type: "boolean" },
      classes: {
        type: "array",
        items: objectSchema(
          {
            className: { type: "string", required: true },
            methodCount: { type: "integer" },
            description: { type: "string" },
          },
          ["className", "methodCount"],
        ),
      },
      matches: {
        type: "array",
        items: objectSchema(
          {
            className: { type: "string", required: true },
            method: { type: "string" },
            description: { type: "string" },
          },
          ["className"],
        ),
      },
      ...errorProperty,
    },
  };
}
