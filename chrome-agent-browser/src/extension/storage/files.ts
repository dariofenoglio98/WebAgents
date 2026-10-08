/**
 * The PDFs a person picked for runs (T6, D-083): Settings → Files. A pick **copies** the bytes
 * once into IndexedDB (`files`, keyed by an opaque `file_<32 hex>` id) with their SHA-256 and size,
 * because a capability must name exact bytes: reading the original again at run time would let
 * the file change between the person's choice and the read (the reference's `FileCapabilityStore`
 * keeps a private copy for the same reason). The file name is kept for the person's own lists
 * only; it never crosses into a package, a plan, an audit, a record or a model. A run reads only
 * the files its task names (`runs.ts` resolves them into the invocation's `attachments`), and the
 * execution host re-verifies the stored copy's size and hash before the parser sees a byte.
 *
 * Bounds are the reference's (`file-capabilities.ts`): one file at most 20 MiB, at most 16 files
 * and 64 MiB held, a `%PDF-` header. A file is removed only by the person ("Remove"); there is no
 * expiry, because these are the person's picks, not a session's.
 */
import { sha256HexSync } from "../../core/hash.js";
import { FILE_ID_PATTERN, PDF_LIMITS, type SelectedFileAttachment } from "../../core/tools/adapters/selected-file.js";
import { completion, Database, request } from "./database.js";

export const MAX_FILE_BYTES = PDF_LIMITS.max_bytes;
export const MAX_FILES = 16;
export const MAX_TOTAL_FILE_BYTES = 64 * 1024 * 1024;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

/** What a view may see about one picked file: never its bytes, never a path (a browser gives none). */
export interface FileView {
  file_id: string;
  display_name: string;
  sha256: string;
  bytes: number;
  media_type: "application/pdf";
  selected_at: string;
}

export interface StoredFile extends FileView {
  data: Uint8Array;
}

export class FileRefusal extends Error {
  constructor(
    readonly code: "file_invalid" | "file_limit",
    message: string,
  ) {
    super(message);
  }
}

/** A name for the person's own list: the last path segment, no controls, NFC, at most 128 characters. */
export function safeDisplayName(raw: string): string {
  const base = raw.split(/[\\/]/u).pop() ?? "";
  const cleaned = base.normalize("NFC").replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  const name = cleaned.length > 0 ? cleaned : "selected.pdf";
  return name.length > 128 ? `${name.slice(0, 127)}…` : name;
}

export function viewOf(file: StoredFile): FileView {
  const { data: _data, ...view } = file;
  return view;
}

export function attachmentOf(file: FileView): SelectedFileAttachment {
  return { file_id: file.file_id, sha256: file.sha256, bytes: file.bytes, media_type: file.media_type };
}

export interface FileStore {
  list(): Promise<FileView[]>;
  get(fileId: string): Promise<StoredFile | null>;
  put(file: StoredFile): Promise<void>;
  remove(fileId: string): Promise<boolean>;
}

/**
 * Check and record one pick: the reference's refusals, in its order, before a byte is kept.
 * Returns the stored record; the caller writes it.
 */
export function newFile(name: string, data: Uint8Array, held: readonly FileView[], now: Date, randomHex: () => string): StoredFile {
  if (!name.toLowerCase().endsWith(".pdf")) throw new FileRefusal("file_invalid", "Only .pdf files can be selected.");
  if (held.length >= MAX_FILES) throw new FileRefusal("file_limit", `This browser holds at most ${MAX_FILES} picked files; remove one first.`);
  if (data.length === 0 || data.length > MAX_FILE_BYTES) throw new FileRefusal("file_limit", `A picked PDF must be between 1 byte and ${MAX_FILE_BYTES} bytes.`);
  if (!PDF_MAGIC.every((byte, index) => data[index] === byte)) throw new FileRefusal("file_invalid", "The picked file does not begin with a PDF header.");
  if (held.reduce((sum, file) => sum + file.bytes, 0) + data.length > MAX_TOTAL_FILE_BYTES) {
    throw new FileRefusal("file_limit", `Picked files may take at most ${MAX_TOTAL_FILE_BYTES} bytes together; remove one first.`);
  }
  const fileId = `file_${randomHex()}`;
  if (!FILE_ID_PATTERN.test(fileId)) throw new FileRefusal("file_invalid", "Could not mint a file id.");
  return { file_id: fileId, display_name: safeDisplayName(name), sha256: sha256HexSync(data), bytes: data.length, media_type: "application/pdf", selected_at: now.toISOString(), data: data.slice() };
}

export class MemoryFileStore implements FileStore {
  readonly files = new Map<string, StoredFile>();

  async list(): Promise<FileView[]> {
    return [...this.files.values()].map(viewOf).sort((a, b) => (a.selected_at < b.selected_at ? -1 : a.selected_at > b.selected_at ? 1 : 0));
  }

  async get(fileId: string): Promise<StoredFile | null> {
    const file = this.files.get(fileId);
    return file ? { ...file, data: file.data.slice() } : null;
  }

  async put(file: StoredFile): Promise<void> {
    this.files.set(file.file_id, { ...file, data: file.data.slice() });
  }

  async remove(fileId: string): Promise<boolean> {
    return this.files.delete(fileId);
  }
}

export class IndexedDbFileStore implements FileStore {
  constructor(private readonly database: Database = new Database()) {}

  async list(): Promise<FileView[]> {
    // A cursor over the records, keeping the views only: the bytes are never copied out for a list.
    const transaction = await this.database.transaction(["files"], "readonly");
    const views: FileView[] = [];
    const cursor = transaction.objectStore("files").openCursor();
    await new Promise<void>((resolve, reject) => {
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return resolve();
        views.push(viewOf(current.value as StoredFile));
        current.continue();
      };
      cursor.onerror = () => reject(cursor.error ?? new Error("IndexedDB cursor failed"));
    });
    return views.sort((a, b) => (a.selected_at < b.selected_at ? -1 : a.selected_at > b.selected_at ? 1 : 0));
  }

  async get(fileId: string): Promise<StoredFile | null> {
    const file = (await request((await this.database.store("files", "readonly")).get(fileId))) as StoredFile | undefined;
    return file ?? null;
  }

  async put(file: StoredFile): Promise<void> {
    await request((await this.database.store("files", "readwrite")).put(file));
  }

  async remove(fileId: string): Promise<boolean> {
    const transaction = await this.database.transaction(["files"], "readwrite");
    const store = transaction.objectStore("files");
    const existed = (await request(store.getKey(fileId))) !== undefined;
    if (existed) store.delete(fileId);
    await completion(transaction);
    return existed;
  }
}
