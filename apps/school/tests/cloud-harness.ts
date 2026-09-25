import http from "node:http";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { db as cloudDb } from "@cloud/server/db";
import { handleBackupUpload, handleHeartbeat, handleRegister, handleSyncBatch, resetRegistrationThrottle } from "@cloud/server/api";

/** The real cloud request handlers behind a real HTTP server, with a switch to simulate the internet going away. */
export async function startCloud() {
  let online = true;
  let tamper: ((req: Request) => Request) | null = null;
  const server = http.createServer(async (nreq, nres) => {
    if (!online) return void nreq.socket.destroy();
    const url = `http://${nreq.headers.host}${nreq.url}`;
    const method = nreq.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    let req = new Request(url, { method, headers: nreq.headers as Record<string, string>, body: hasBody ? (Readable.toWeb(nreq) as ReadableStream) : undefined, duplex: "half" } as RequestInit);
    if (tamper) req = tamper(req);
    const path = new URL(url).pathname;
    const handler = path === "/api/v1/register" ? handleRegister : path === "/api/v1/heartbeat" ? handleHeartbeat : path === "/api/v1/sync/batch" ? handleSyncBatch : path === "/api/v1/backups" ? handleBackupUpload : null;
    const res = handler ? await handler(req) : new Response("not found", { status: 404 });
    nres.statusCode = res.status;
    res.headers.forEach((v, k) => nres.setHeader(k, v));
    nres.end(Buffer.from(await res.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    setOnline: (v: boolean) => void (online = v),
    setTamper: (fn: ((req: Request) => Request) | null) => void (tamper = fn),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export async function resetCloudDb() {
  const rows = await cloudDb.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await cloudDb.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  resetRegistrationThrottle();
}

export { cloudDb };
