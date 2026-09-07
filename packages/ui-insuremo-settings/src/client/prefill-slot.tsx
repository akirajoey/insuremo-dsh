/** Session-scope prefill entry (TASK-088): registered on the official
 * `conversation.session.header.actions` list slot, it renders nothing and
 * exists only to consume the diagnosis hand-off's queued text through the
 * framework standard kit — every session-scope slot component receives
 * `useInput` and `inputActions` from ui-conversation's `sessions.provide`
 * (official rc.7 seam, no DSH patch). Delivery rules: write only while the
 * composer draft is empty (user-first — a draft the user already typed is
 * never overwritten; the queued text is dropped and the visible copy button
 * covers that case), consume at most once, and key strictly by session id so
 * switching sessions can never leak one session's diagnosis text into
 * another. Never submits: the user picks a model and presses Enter. */

import { useEffect, useReducer } from "react";
import { settleDiagnosisPrefill, subscribeDiagnosisPrefill, takeDiagnosisPrefill } from "./diagnosis.ts";

/** Minimal live view of the input machine state the entry reads. */
export interface DiagnosisInputState {
  readonly draft: string;
}

/** The kit face this entry consumes (structural subset of the official standard kit). */
export interface DiagnosisPrefillEntryProps {
  /** Framework-resolved current session id. */
  sessionId: string;
  /** Selector hook over the session's live input machine state. */
  useInput: <T>(selector: (state: DiagnosisInputState) => T) => T;
  /** The public input action face (stable identity per session). */
  inputActions?: { setDraft(text: string): void };
}

/**
 * Consume the queued diagnosis prefill for the current session. Two triggers
 * make consumption independent of mount timing: the effect after EVERY
 * render (the map lookup is the guard, so an empty map is a cheap no-op),
 * and a subscription to the registry that re-renders the entry when a queue
 * or settle lands — an ALREADY-MOUNTED entry consumes without waiting for
 * any unrelated render. Delivery rules: write only while the composer draft
 * is empty (user-first), consume at most once, settle the real outcome so
 * the card never claims a prefill that did not land.
 */
export function DiagnosisPrefillEntry({ sessionId, useInput, inputActions }: DiagnosisPrefillEntryProps): null {
  const draft = useInput(state => state.draft);
  const [, bump] = useReducer((count: number) => count + 1, 0);
  useEffect(() => subscribeDiagnosisPrefill(bump), [bump]);
  useEffect(() => {
    if (inputActions === undefined) return;
    const text = takeDiagnosisPrefill(sessionId, draft === "");
    if (text === undefined) return;
    try {
      inputActions.setDraft(text);
      settleDiagnosisPrefill(sessionId, "written");
    } catch {
      // A refused write keeps the machine state untouched; the visible copy
      // button is the fallback. The text is already consumed — requeueing
      // could loop against a persistently refusing composer.
    }
  });
  return null;
}

/** Registration options for the entry on the official list slot. */
export interface DiagnosisPrefillSlotRegistration {
  [key: string]: unknown;
  /** The slot key declared by ui-conversation; `input.dock` renders for blank/HERO sessions. */
  name: "conversation.input.dock";
  id: string;
  /** High order: diagnosis prefill is a silent consumer, never leading chrome. */
  order: number;
}

/**
 * Register the silent prefill entry once per client apply. The inject/register
 * pair mirrors the official ui-agent-preset header-actions registration. The
 * slot is `conversation.input.dock` (NOT `conversation.session.header.actions`):
 * rc.7 hides the whole session header (`ConversationSessionHeader`
 * `hideChrome`) while a fresh session is blank, so a header-actions entry can
 * never mount to prefill a NEW diagnosis session — while `input.dock` renders
 * for every current session, blank/HERO included.
 */
export function registerDiagnosisPrefillSlot(ctx: {
  slots: {
    inject(name: string, callback: () => unknown): unknown;
    register(options: DiagnosisPrefillSlotRegistration, component: unknown): unknown;
  };
}): void {
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    id: "insuremo-diagnosis-prefill",
    order: 900,
  }, DiagnosisPrefillEntry));
}
