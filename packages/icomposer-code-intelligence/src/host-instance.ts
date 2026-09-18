import { randomUUID } from "node:crypto";

/**
 * TASK-111: identity of the running Host process.
 *
 * Recovery may only repair state that belongs to a *previous* process. Timestamps
 * cannot prove ownership (same-millisecond writes, repeated recovery), so every
 * record a process creates carries this id, and recovery skips anything stamped
 * with its own id. A crash + restart therefore produces a new id and heals the old
 * records, while a live confirmation is never mistaken for a leftover.
 */
export const HOST_INSTANCE_ID: string = `host-${randomUUID()}`.slice(0, 40);
