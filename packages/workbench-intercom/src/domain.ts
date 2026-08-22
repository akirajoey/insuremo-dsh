import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { intercomGlobalSchema, messageRecordSchema, sessionRecordSchema, type IntercomGlobal, type MessageRecord, type SessionRecord } from "./types.ts";

/**
 * Durable storage unit for Intercom session registry and message
 * *metadata*. Message bodies never enter the domain — only their sha256
 * digest and a content reference live here; the text itself is a bounded
 * file under `<DSH_HOME>/intercom/<hash>/messages/<seq>.txt`.
 */
export const intercomDomain = defineDomain({
  name: "workbench_intercom",
  version: 1,
  global: {
    schema: intercomGlobalSchema,
    initial: { nextDeliverySeq: 1 } satisfies IntercomGlobal,
  },
  tables: {
    sessions: domainTable<string, SessionRecord>(sessionRecordSchema),
    /** Key: zero-padded 12-digit seq (lexicographic == numeric order). */
    messages: domainTable<string, MessageRecord>(messageRecordSchema),
  },
});

export type IntercomDomain = typeof intercomDomain;

/** Zero-pad a seq into its lexicographically sortable table key. */
export function messageKey(seq: number): string {
  return String(seq).padStart(12, "0");
}

export function seqFromKey(key: string): number {
  const parsed = Number.parseInt(key, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
