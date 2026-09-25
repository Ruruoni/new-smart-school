import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { SIG_HEADERS, verifySignature } from "@smartschool/protocol";
import { db } from "./db";
import { env } from "./env";
import { decryptSecret, randomToken } from "./crypto";
import { badRequest, errorResponse, unauthorized, CloudError } from "./errors";
import { authenticateInstallation, registerInstallation } from "./installations";
import { processHeartbeat } from "./heartbeat";
import { ingestBatch } from "./sync";

const MAX_BODY = 2 * 1024 * 1024; // sync/heartbeat JSON bodies are small; larger is abuse
const ipOf = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? null;

async function readBody(req: Request): Promise<string> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) throw new CloudError("TOO_LARGE", "Request body too large", 413);
  const text = await req.text();
  if (text.length > MAX_BODY) throw new CloudError("TOO_LARGE", "Request body too large", 413);
  return text;
}

const json = (v: unknown, status = 200) => Response.json(v, { status, headers: { "cache-control": "no-store" } });

// Registration is unauthenticated by design (the one-time token is the credential) → throttle per IP.
const regHits = new Map<string, { n: number; reset: number }>();
export const resetRegistrationThrottle = () => regHits.clear();

export async function handleRegister(req: Request): Promise<Response> {
  try {
    const ip = ipOf(req);
    if (ip) {
      const now = Date.now(), h = regHits.get(ip);
      if (!h || h.reset < now) regHits.set(ip, { n: 1, reset: now + 3_600_000 });
      else if (++h.n > 20) throw new CloudError("RATE_LIMITED", "Too many registration attempts", 429);
    }
    return json(await registerInstallation(JSON.parse(await readBody(req) || "{}"), ip));
  } catch (err) {
    if (err instanceof SyntaxError) return errorResponse(badRequest("Body must be JSON"));
    return errorResponse(err);
  }
}

export async function handleHeartbeat(req: Request): Promise<Response> {
  try {
    const body = await readBody(req);
    const inst = await authenticateInstallation(req, body, { allow: ["ACTIVE", "SUSPENDED"] });
    return json(await processHeartbeat(inst, JSON.parse(body), ipOf(req)));
  } catch (err) {
    if (err instanceof SyntaxError) return errorResponse(badRequest("Body must be JSON"));
    return errorResponse(err);
  }
}

export async function handleSyncBatch(req: Request): Promise<Response> {
  try {
    const body = await readBody(req);
    const inst = await authenticateInstallation(req, body, { allow: ["ACTIVE", "SUSPENDED"] });
    return json(await ingestBatch(inst, JSON.parse(body)));
  } catch (err) {
    if (err instanceof SyntaxError) return errorResponse(badRequest("Body must be JSON"));
    return errorResponse(err);
  }
}

/**
 * Backup upload (cloud copy of a school's encrypted archive). The body is streamed to disk while hashing —
 * never buffered — and the request is authenticated by an HMAC over the declared checksum/name/size, so the
 * (already encrypted) payload does not need to be signed byte-by-byte.
 */
export async function handleBackupUpload(req: Request): Promise<Response> {
  let tmp: string | null = null;
  try {
    const code = req.headers.get(SIG_HEADERS.installation), ts = req.headers.get(SIG_HEADERS.timestamp), sig = req.headers.get(SIG_HEADERS.signature);
    const sha = req.headers.get("x-backup-sha256"), name = req.headers.get("x-backup-name"), size = Number(req.headers.get("content-length") ?? req.headers.get("x-backup-size"));
    if (!code || !ts || !sig || !sha || !name || !Number.isFinite(size)) throw unauthorized("Missing headers");
    const inst = await db.installation.findUnique({ where: { code } });
    if (!inst?.secretEnc || !verifySignature(decryptSecret(inst.secretEnc), ts, `${sha}|${name}|${size}`, sig)) throw unauthorized("Invalid signature");
    if (inst.status !== "ACTIVE" && inst.status !== "SUSPENDED") throw unauthorized("Installation is not active");
    if (size > 4 * 1024 ** 3) throw new CloudError("TOO_LARGE", "Backup too large", 413);
    if (!/^[a-f0-9]{64}$/.test(sha) || !/^[A-Za-z0-9._-]{3,120}$/.test(name)) throw badRequest("Invalid backup metadata");
    if (!req.body) throw badRequest("Empty body");

    const root = resolve(env().BACKUP_STORAGE_DIR);
    const dest = resolve(root, inst.code, `${Date.now()}-${name}`);
    if (!dest.startsWith(root + sep)) throw badRequest("Invalid path");
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    tmp = `${dest}.part-${randomToken(4)}`;
    const hash = createHash("sha256");
    let bytes = 0;
    await pipeline(Readable.fromWeb(req.body as never), new Transform({ transform(c, _e, cb) { bytes += c.length; hash.update(c); cb(null, c); } }), createWriteStream(tmp, { mode: 0o600 }));
    if (hash.digest("hex") !== sha || bytes !== size) { await rm(tmp, { force: true }); throw new CloudError("CHECKSUM_MISMATCH", "The uploaded file does not match its checksum", 422); }
    await rename(tmp, dest);
    tmp = null;
    const rec = await db.backupUpload.create({ data: { installationId: inst.id, fileName: name, sizeBytes: BigInt(bytes), sha256: sha, storagePath: dest } });
    return json({ id: rec.id, size: (await stat(dest)).size });
  } catch (err) {
    if (tmp) await rm(tmp, { force: true }).catch(() => undefined);
    return errorResponse(err);
  }
}
