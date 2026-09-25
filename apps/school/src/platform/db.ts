import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "@/generated/prisma/client";
import { env } from "./env";

export type Tx = Prisma.TransactionClient;
export { Prisma };

const globalForDb = globalThis as unknown as { __db?: PrismaClient };

function create(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env().DATABASE_URL, max: 10, options: "-c timezone=UTC" });
  return new PrismaClient({ adapter });
}

/**
 * Every connection runs in UTC. Prisma stores DateTime as `timestamp` (UTC wall-clock, no zone); a session in another
 * zone makes `now()` comparisons in raw SQL silently wrong by the zone offset.
 */
/** One client per process (survives Next.js dev hot reloads). */
export const db: PrismaClient = globalForDb.__db ?? (globalForDb.__db = create());

/** Run `fn` in a transaction; the default isolation (READ COMMITTED) plus explicit row locks where needed. */
export function transact<T>(fn: (tx: Tx) => Promise<T>, opts?: { timeoutMs?: number }): Promise<T> {
  return db.$transaction(fn, { timeout: opts?.timeoutMs ?? 20_000, maxWait: 10_000 });
}

export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;
