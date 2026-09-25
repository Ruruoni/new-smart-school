import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "@cloud/generated/prisma/client";
import { env } from "./env";

export type Tx = Prisma.TransactionClient;
export { Prisma };
const g = globalThis as unknown as { __cloudDb?: PrismaClient };
export const db: PrismaClient = g.__cloudDb ?? (g.__cloudDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: env().CLOUD_DATABASE_URL, max: 10, options: "-c timezone=UTC" }) }));
export const transact = <T>(fn: (tx: Tx) => Promise<T>) => db.$transaction(fn, { timeout: 30_000, maxWait: 10_000 });
