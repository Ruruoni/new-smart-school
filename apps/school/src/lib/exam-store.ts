import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { LocalAnswer } from "./exam-logic";

/**
 * Durable, per-device exam state (IndexedDB — never localStorage): the paper as delivered and every answer the
 * student gives, written BEFORE any network call. A refresh, a browser restart, a dropped Wi-Fi or a school-server
 * hiccup cannot lose answers; they are synced whenever the server is reachable again.
 */
interface Schema extends DBSchema {
  papers: { key: string; value: { attemptId: string; savedAt: number; paper: unknown } };
  answers: { key: string; value: LocalAnswer & { key: string; attemptId: string }; indexes: { byAttempt: string } };
  meta: { key: string; value: { key: string; value: unknown } };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;
function db() {
  return (dbp ??= openDB<Schema>("smartschool-exam", 1, {
    upgrade(d) {
      d.createObjectStore("papers", { keyPath: "attemptId" });
      const a = d.createObjectStore("answers", { keyPath: "key" });
      a.createIndex("byAttempt", "attemptId");
      d.createObjectStore("meta", { keyPath: "key" });
    },
  }));
}
export const __resetForTests = () => { dbp = null; };

export async function savePaper(attemptId: string, paper: unknown) { await (await db()).put("papers", { attemptId, savedAt: Date.now(), paper }); }
export async function loadPaper<T>(attemptId: string): Promise<T | null> { return ((await (await db()).get("papers", attemptId))?.paper as T) ?? null; }

export async function putAnswer(attemptId: string, a: LocalAnswer) { await (await db()).put("answers", { ...a, key: `${attemptId}:${a.examQuestionId}`, attemptId }); }
export async function loadAnswers(attemptId: string): Promise<LocalAnswer[]> {
  const rows = await (await db()).getAllFromIndex("answers", "byAttempt", attemptId);
  return rows.map(({ key: _k, attemptId: _a, ...rest }) => rest);
}
export async function dirtyAnswers(attemptId: string): Promise<LocalAnswer[]> { return (await loadAnswers(attemptId)).filter((a) => a.dirty); }

/** After a successful sync, clear the dirty flag ONLY for what was actually sent (a newer edit made mid-flight stays dirty). */
export async function markSynced(attemptId: string, sent: Record<string, number>) {
  const d = await db();
  const tx = d.transaction("answers", "readwrite");
  for (const [qid, seq] of Object.entries(sent)) {
    const row = await tx.store.get(`${attemptId}:${qid}`);
    if (row && row.clientSeq <= seq) await tx.store.put({ ...row, dirty: false });
  }
  await tx.done;
}

export async function clearAttempt(attemptId: string) {
  const d = await db();
  const tx = d.transaction(["answers", "papers"], "readwrite");
  for (const k of await tx.objectStore("answers").index("byAttempt").getAllKeys(attemptId)) await tx.objectStore("answers").delete(k);
  await tx.objectStore("papers").delete(attemptId);
  await tx.done;
}

export async function setMeta(key: string, value: unknown) { await (await db()).put("meta", { key, value }); }
export async function getMeta<T>(key: string): Promise<T | undefined> { return (await (await db()).get("meta", key))?.value as T | undefined; }
