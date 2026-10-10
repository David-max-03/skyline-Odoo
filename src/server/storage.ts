import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { all, dbFile, get, newId, nowIso, run } from "./db";
import { invalid, notFound } from "./errors";

/**
 * Uploaded evidence (payment screenshots, receipts).
 *
 * Files are private. They are written outside anything the web server serves
 * statically, under a random id rather than the uploader's file name, and are
 * only ever returned through a route that has checked who is asking. This
 * module does no authorisation itself: callers decide who may read a file.
 *
 * Only JPEG, PNG and WebP are accepted, and the type is decided from the
 * file's first bytes, never from the name or the type the browser claimed.
 */

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Allowance for a whole upload request: one image plus the form's text fields. */
export const MAX_UPLOAD_REQUEST_BYTES = MAX_IMAGE_BYTES + 64 * 1024;

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";
export type FilePurpose = "application_payment" | "claim_receipt" | "product_image";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

export function sniffImage(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && PNG.every((byte, i) => bytes[i] === byte)) return "image/png";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  return null;
}

export function uploadDir(): string {
  if (process.env.SKYLINE_UPLOAD_DIR) return process.env.SKYLINE_UPLOAD_DIR;
  const file = dbFile();
  return file === ":memory:"
    ? path.join(os.tmpdir(), "skyline-uploads")
    : path.join(path.dirname(file), "uploads");
}

// Ids are generated here, but the pattern is still checked before one is used
// in a path, so no caller can make this module read outside the uploads folder.
const FILE_ID = /^fil_[A-Za-z0-9_-]{6,40}$/;

function pathFor(id: string): string {
  if (!FILE_ID.test(id)) throw notFound("File");
  return path.join(uploadDir(), id);
}

/** Pulls one uploaded file out of a form, or null when the field is empty. */
export async function readUpload(form: FormData | null, field: string): Promise<Buffer | null> {
  const value = form?.get(field);
  if (!value || typeof value === "string" || value.size === 0) return null;
  if (value.size > MAX_IMAGE_BYTES) {
    throw invalid("That image is too large.", { [field]: "The image must be 5 MB or smaller" });
  }
  return Buffer.from(await value.arrayBuffer());
}

/**
 * Checks and stores an image, and returns its id. Call it inside the database
 * transaction that records what the image is evidence for; if that
 * transaction then fails, call `discardFile` with the id.
 */
export function storeImage(bytes: Buffer, purpose: FilePurpose, field = "evidence"): string {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw invalid("That image is too large.", { [field]: "The image must be 5 MB or smaller" });
  }
  const mime = sniffImage(bytes);
  if (!mime) {
    throw invalid("That file is not a photo we can accept.", {
      [field]: "Upload a JPEG, PNG or WebP image",
    });
  }
  const id = newId("fil");
  fs.mkdirSync(uploadDir(), { recursive: true, mode: 0o700 });
  // "wx" refuses to overwrite, so an id collision cannot replace someone else's file.
  fs.writeFileSync(pathFor(id), bytes, { flag: "wx", mode: 0o600 });
  try {
    run(
      "INSERT INTO files (id, purpose, mime, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      purpose,
      mime,
      bytes.length,
      createHash("sha256").update(bytes).digest("hex"),
      nowIso(),
    );
  } catch (error) {
    discardFile(id);
    throw error;
  }
  return id;
}

/** Removes a stored file's bytes. Used when the record it belonged to was not saved. */
export function discardFile(id: string): void {
  try {
    fs.rmSync(pathFor(id), { force: true });
  } catch {
    // nothing to remove
  }
}

export interface StoredFile {
  mime: ImageMime;
  bytes: Buffer;
}

/** Reads a stored file. The caller must already have checked that the reader may see it. */
export function openFile(id: string): StoredFile {
  const row = get<{ mime: ImageMime }>("SELECT mime FROM files WHERE id = ?", id);
  if (!row) throw notFound("File");
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(pathFor(id));
  } catch {
    throw notFound("File");
  }
  return { mime: row.mime, bytes };
}

/** Deletes the bytes of every recorded file. The seed script calls this before wiping the tables. */
export function removeAllUploads(): void {
  for (const row of all<{ id: string }>("SELECT id FROM files")) discardFile(row.id);
}
