# `@icomposer/workbench-contracts`

`workbench-contracts` is the dependency-light, non-UI contract package for the
Workbench API. It keeps command names, request/response types, runtime Zod
schemas, and the API schema version in one place so Host, Web, and future GPUI
clients can share the same boundary.

The Phase 0/1 contract includes:

- `system/capabilities`
- `workspace/list`
- `operation/record`
- `operation/list`
- `operation/decide`
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

`gen-json-schema` writes seven standalone JSON Schema documents to `dist/`.
The operation command documents contain both request and response alternatives
under `$defs`. Runtime Zod schemas are exported from `src/index.ts` and are
intentionally usable without React or Harness internals.
