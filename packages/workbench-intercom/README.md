# @icomposer/workbench-intercom

Session registry + message store for Workbench-to-Workbench agent
communication. Intercom state is deliberately separate from the Harness
transcript: message bodies live as bounded files under
`<DSH_HOME>/intercom/<hash>/messages/<seq>.txt` (≤64KB each); the storage
domain carries only sha256 digests and content references.

Host-only. Injects `[storageDomain]`.

## Domain `workbench_intercom` v1

- global `{nextDeliverySeq}` — the durable monotonic sequence counter.
- `sessions` (key = sessionId): `{sessionId, peerName, cwd, createdAt,
  lastSeenAt, status: running|idle|waiting|stopped}`.
- `messages` (key = 12-digit zero-padded seq): `{seq, sessionId, direction,
  kind: message|ask, from, to, textDigest, contentRef, createdAt,
  deliveredAt?}`. Per send exactly one record is stored (`direction=inbound`
  addressed to the receiver; the sender derives its view from `from`).

## Face `ctx.intercom` (frozen)

- `register({peerName, cwd})` / `heartbeat({sessionId})` /
  `unregister({sessionId})` — registry lifecycle; unregister marks the
  session `stopped` (history stays auditable, new sends are refused).
- `listSessions()` — all sessions with per-session pending counts.
- `send({fromSessionId, toSessionId|toPeer, text, kind?})` — allocates the
  next seq via the domain global (all mutations serialize on one write
  chain; concurrent sends get unique ascending seqs), writes the body file
  atomically (tmp+rename), records digest+ref. Duplicate peer names are
  rejected (`peer-not-found`, use the session id).
- `inbox({sessionId})` / `pending({sessionId})` / `markDelivered({sessionId,
  seqs[]})` — undelivered projections and batched CAS delivery marking.
- `read({sessionId, seq})` — returns the full text **only** to the sender
  or the recipient; anyone else gets `denied`. The stored digest is
  re-verified on every read.
- `acquireLease({cwd, holder})` / `releaseLease({cwd, holder})` — advisory
  file lease (`<DSH_HOME>/intercom/<hash>/leases/<sha256(cwd)>.json`,
  30-minute TTL). A lease never blocks reads, inbox, or sends (advisory
  per plan §7); an expired lease can be taken over; only the holder may
  release.

## TASK-032: ask / reply / cancel

Message `kind` extends to `message | ask | reply | cancel`; ask records
carry `{askStatus: pending|replied|cancelled, askedAt, resolvedAt?}` and
reply/cancel records carry `replyToSeq`.

- `ask({fromSessionId, toSessionId, text, timeoutMs?≤600000})` — send
  semantics + `kind=ask, askStatus=pending`; the receiving session's derived
  status becomes `waiting`.
- `reply({fromSessionId, toSeq, text})` — `toSeq` must be a pending ask
  addressed to `fromSessionId` (anyone else: `denied`); writes a
  `kind=reply` message with `replyToSeq`, flips the ask to
  `replied/resolvedAt`, and releases the responder's waiting mark
  (`restored:true` when it was the last pending ask — a simplification this
  card; full original-status restoration derives from heartbeats later).
  Concurrent replies to one ask: exactly one wins (write-chain CAS), the
  rest get `invalid-state`.
- `cancel({fromSessionId, seq})` — only the asker may cancel their own
  pending ask (`denied` otherwise; `invalid-state` once replied/cancelled);
  releases the receiver's waiting mark.
- `pendingAsks({sessionId})` — asks addressed to me that are still pending
  (digest+ref only).
- `resolveStatus({sessionId})` — `{status, waitingFor}` derived fresh from
  the domain on every call (no in-memory caching): a live session with
  pending asks is `waiting`, and the stored flag is advisory only.
- Inbox includes ask/reply entries (with `askStatus`/`replyToSeq`);
  `markDelivered` never changes an ask's status — delivery ≠ answer.

## Safety properties

- Message bodies never enter the domain (digest+ref only) — verified by
  scanning the whole storage directory for plaintext in tests.
- Text payloads: 1–64KB, no NUL bytes.
- All face errors are a closed union (`session-not-found`, `peer-not-found`,
  `denied`, `storage-error`, …) with fixed messages.
- Durability: seq and all records survive provider reopen (tests close the
  domain, reopen on the same storage, and continue from seq N+1).

## Tests

`pnpm --filter @icomposer/workbench-intercom run test` covers registry
status derivation, monotonic+concurrent CAS seqs, inbox/pending/delivery,
read authorization and the 64KB boundary, zero-plaintext-in-domain, lease
acquire/expire/release/advisory semantics, dispose/abort gates, and
durability reopen.
