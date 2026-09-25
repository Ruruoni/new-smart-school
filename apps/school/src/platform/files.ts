import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { db, type Tx } from "./db";
import { env } from "./env";
import { sha256 } from "./crypto";
import { AppError, forbidden, notFound, validation } from "./errors";
import type { SecurityContext } from "./security/context";

/** Detect a file's real type from its bytes. Client-declared MIME types are never trusted on their own. */
export type DetectedType = "png" | "jpeg" | "webp" | "pdf" | "xlsx" | "docx" | "csv" | "unknown";

const MIME: Record<Exclude<DetectedType, "unknown">, string> = {
  png: "image/png", jpeg: "image/jpeg", webp: "image/webp", pdf: "application/pdf", csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const EXT: Record<Exclude<DetectedType, "unknown">, string> = { png: "png", jpeg: "jpg", webp: "webp", pdf: "pdf", csv: "csv", xlsx: "xlsx", docx: "docx" };

export function detectType(buf: Buffer, declaredName = ""): DetectedType {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    // OOXML containers are ZIPs; tell them apart by their well-known part names within the archive header area.
    const head = buf.subarray(0, Math.min(buf.length, 8192)).toString("latin1");
    if (head.includes("xl/")) return "xlsx";
    if (head.includes("word/")) return "docx";
    return "unknown";
  }
  const lower = declaredName.toLowerCase();
  if (lower.endsWith(".csv") && looksLikeText(buf)) return "csv";
  return "unknown";
}

function looksLikeText(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  for (const b of sample) if (b === 0 || (b < 9) || (b > 13 && b < 32 && b !== 27)) return false;
  return true;
}

export type UploadProfile = "IMAGE" | "DOCUMENT" | "SPREADSHEET" | "ATTACHMENT" | "REPORT";
const PROFILES: Record<UploadProfile, { types: DetectedType[]; maxBytes: number }> = {
  IMAGE: { types: ["png", "jpeg", "webp"], maxBytes: 2 * 1024 * 1024 },
  DOCUMENT: { types: ["pdf", "png", "jpeg"], maxBytes: 5 * 1024 * 1024 },
  SPREADSHEET: { types: ["xlsx", "csv"], maxBytes: 10 * 1024 * 1024 },
  ATTACHMENT: { types: ["pdf", "png", "jpeg", "docx", "xlsx"], maxBytes: 10 * 1024 * 1024 },
  /** Files the system itself generates (never client uploads). */
  REPORT: { types: ["pdf", "xlsx", "csv"], maxBytes: 60 * 1024 * 1024 },
};

/** Strip directory parts and anything unsafe; the result is only ever used for display and Content-Disposition. */
export function sanitizeFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "file";
  const cleaned = base.normalize("NFKC").replace(/[\u0000-\u001f\u007f"<>:*?|]/g, "").replace(/^\.+/, "").trim();
  const trimmed = cleaned.length > 120 ? cleaned.slice(-120) : cleaned;
  return trimmed || "file";
}

const root = () => resolve(env().STORAGE_DIR);

/** Resolve a storage key to an absolute path and prove it stays inside the storage root (path-traversal guard). */
export function storagePath(key: string): string {
  const abs = resolve(root(), key);
  if (!abs.startsWith(root() + sep)) throw new AppError("BAD_PATH", "Invalid storage path", 400);
  return abs;
}

export interface UploadInput {
  data: Buffer;
  originalName: string;
  declaredMime?: string | null;
  profile: UploadProfile;
  ownerType: string;
  ownerId?: string;
  uploadedById?: string | null;
}

export async function saveUpload(tx: Tx | typeof db, u: UploadInput) {
  const profile = PROFILES[u.profile];
  if (!u.data.length) throw validation("The uploaded file is empty");
  if (u.data.length > profile.maxBytes) throw new AppError("FILE_TOO_LARGE", `File is larger than ${Math.round(profile.maxBytes / 1024 / 1024)} MB`, 413);
  const type = detectType(u.data, u.originalName);
  if (type === "unknown" || !profile.types.includes(type)) {
    throw new AppError("FILE_TYPE_NOT_ALLOWED", `That file type is not allowed here. Allowed: ${profile.types.join(", ")}`, 415);
  }
  // A declared MIME that contradicts the real content is a red flag (renamed executable, polyglot…): reject.
  if (u.declaredMime && u.declaredMime !== "application/octet-stream" && u.declaredMime.split(";")[0]!.trim() !== MIME[type] && !(type === "csv" && /text\/(plain|csv)|application\/vnd\.ms-excel/.test(u.declaredMime))) {
    throw new AppError("FILE_TYPE_MISMATCH", "The file's contents do not match its declared type", 415);
  }
  const now = new Date();
  const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}.${EXT[type]}`;
  const abs = storagePath(key);
  await mkdir(dirname(abs), { recursive: true });
  const fh = await open(abs, "wx", 0o640); // exclusive create: never overwrite
  try {
    await fh.writeFile(u.data);
  } finally {
    await fh.close();
  }
  try {
    return await tx.fileAsset.create({
      data: { storageKey: key, originalName: sanitizeFilename(u.originalName), mimeType: MIME[type], sizeBytes: u.data.length, sha256: sha256(u.data), ownerType: u.ownerType, ownerId: u.ownerId, uploadedById: u.uploadedById ?? null },
    });
  } catch (err) {
    await rm(abs, { force: true });
    throw err;
  }
}

export async function readFileBuffer(fileId: string): Promise<{ asset: NonNullable<Awaited<ReturnType<typeof db.fileAsset.findFirst>>>; data: Buffer }> {
  const asset = await db.fileAsset.findFirst({ where: { id: fileId, deletedAt: null } });
  if (!asset) throw notFound("File");
  const { readFile } = await import("node:fs/promises");
  return { asset, data: await readFile(storagePath(asset.storageKey)) };
}

type Reader = (ctx: SecurityContext, asset: { ownerType: string | null; ownerId: string | null; uploadedById: string | null }) => Promise<boolean>;
const readers = new Map<string, Reader>();
/** Modules register how file access is decided for their owner type (deny by default). */
export const registerFileReader = (ownerType: string, fn: Reader) => void readers.set(ownerType, fn);

export async function openFile(ctx: SecurityContext, fileId: string): Promise<Response> {
  const asset = await db.fileAsset.findFirst({ where: { id: fileId, deletedAt: null } });
  if (!asset) throw notFound("File");
  const reader = asset.ownerType ? readers.get(asset.ownerType) : undefined;
  const allowed = ctx.user.isPrimaryAdmin || asset.uploadedById === ctx.user.id || (reader ? await reader(ctx, asset) : false);
  if (!allowed) throw notFound("File"); // do not reveal existence
  const abs = storagePath(asset.storageKey);
  const s = await stat(abs).catch(() => null);
  if (!s) throw notFound("File");
  const inline = asset.mimeType.startsWith("image/") || asset.mimeType === "application/pdf";
  const name = encodeURIComponent(asset.originalName);
  return new Response(Readable.toWeb(createReadStream(abs)) as ReadableStream, {
    headers: {
      "content-type": asset.mimeType,
      "content-length": String(s.size),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${name}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
    },
  });
}

export async function deleteFile(tx: Tx, fileId: string, ctx: SecurityContext) {
  const a = await tx.fileAsset.findFirst({ where: { id: fileId, deletedAt: null } });
  if (!a) throw notFound("File");
  if (!ctx.user.isPrimaryAdmin && a.uploadedById !== ctx.user.id) throw forbidden();
  await tx.fileAsset.update({ where: { id: fileId }, data: { deletedAt: new Date() } }); // soft; bytes purged by the maintenance job
}
