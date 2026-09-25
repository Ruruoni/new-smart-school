/** Pure logic for the offline exam room (unit-tested). No DOM, no IndexedDB. */

export interface ServerAnswer { selectedOptionIds: string[]; flagged: boolean; visited: boolean; clientSeq: number }
export interface LocalAnswer extends ServerAnswer { examQuestionId: string; answeredAt: string | null; dirty: boolean }

/**
 * Merge what the server has with what this device has. For each question the higher `clientSeq` wins, so an
 * answer typed offline (and not yet synced) is never lost to a stale server copy after a refresh, and a newer
 * server copy (another tab) is never overwritten by a stale local one.
 */
export function mergeAnswers(server: Record<string, ServerAnswer>, local: LocalAnswer[]): Record<string, LocalAnswer> {
  const out: Record<string, LocalAnswer> = {};
  for (const [id, s] of Object.entries(server)) out[id] = { ...s, examQuestionId: id, answeredAt: null, dirty: false };
  for (const l of local) {
    const cur = out[l.examQuestionId];
    if (!cur || l.clientSeq > cur.clientSeq || (l.clientSeq === cur.clientSeq && l.dirty)) out[l.examQuestionId] = l;
  }
  return out;
}

/** Seconds left, using the SERVER's clock (offset = serverNow − deviceNow measured on each response). */
export function remainingSeconds(deadlineAtMs: number, nowMs: number, offsetMs: number): number {
  return Math.max(0, Math.ceil((deadlineAtMs - (nowMs + offsetMs)) / 1000));
}

export const clockOffset = (serverNowMs: number, deviceNowMs: number) => serverNowMs - deviceNowMs;

/** mm:ss or h:mm:ss */
export function formatClock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600), m = Math.floor((totalSeconds % 3600) / 60), s = totalSeconds % 60;
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Back-off between failed autosave attempts: 2s, 4s, 8s, 15s (cap). Resets on success. */
export function syncDelayMs(consecutiveFailures: number): number {
  return Math.min(15_000, 2_000 * 2 ** Math.max(0, consecutiveFailures - 1));
}

export type Warning = null | "10min" | "5min" | "1min" | "expired";
export function timeWarning(remaining: number, total: number): Warning {
  if (remaining <= 0) return "expired";
  if (remaining <= 60 && total > 120) return "1min";
  if (remaining <= 300 && total > 600) return "5min";
  if (remaining <= 600 && total > 1800) return "10min";
  return null;
}

export type QState = "unvisited" | "visited" | "answered" | "flagged" | "answeredFlagged";

/** Words for screen readers and the question map (a flagged question can also be answered). */
export const QSTATE_LABEL: Record<QState, string> = { unvisited: "not visited", visited: "seen, not answered", answered: "answered", flagged: "flagged, not answered", answeredFlagged: "answered and flagged" };
/** Question-map colour: flagged wins over answered (yellow), answered = green, seen-but-blank = white, untouched = grey. */
export function questionState(a: { selectedOptionIds: string[]; flagged: boolean; visited: boolean } | undefined): QState {
  if (!a) return "unvisited";
  if (a.flagged) return a.selectedOptionIds.length ? "answeredFlagged" : "flagged";
  if (a.selectedOptionIds.length) return "answered";
  return a.visited ? "visited" : "unvisited";
}

export function progress(states: QState[]) {
  const answered = states.filter((s) => s === "answered" || s === "answeredFlagged").length;
  const flagged = states.filter((s) => s === "flagged" || s === "answeredFlagged").length;
  return { total: states.length, answered, flagged, unanswered: states.length - answered, remaining: states.length - answered };
}

/** Toggle an option: single-choice replaces, multi-choice toggles. */
export function toggleOption(current: string[], optionId: string, multi: boolean): string[] {
  if (!multi) return current.length === 1 && current[0] === optionId ? [] : [optionId];
  return current.includes(optionId) ? current.filter((x) => x !== optionId) : [...current, optionId];
}
