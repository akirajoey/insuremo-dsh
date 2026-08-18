# `@icomposer/workbench-contracts`

`workbench-contracts` is the dependency-light, non-UI contract package for the
Workbench API. It keeps command names, request/response types, runtime Zod
schemas, and the API schema version in one place so Host, Web, and future GPUI
clients can share the same boundary.

The Phase 0 contract includes:

- `system/capabilities`
- `workspace/list`
- branded `RequestId` and `JobId` types
- runtime validation schemas for every request and response

## Development

From the repository root:

```sh
pnpm install
pnpm --filter @icomposer/workbench-contracts run typecheck
pnpm --filter @icomposer/workbench-contracts run gen-json-schema
pnpm --filter @icomposer/workbench-contracts run test
```

`gen-json-schema` writes standalone JSON Schema documents to `dist/`. The
runtime Zod schemas are exported from `src/index.ts` and are intentionally
usable without React or Harness internals.
