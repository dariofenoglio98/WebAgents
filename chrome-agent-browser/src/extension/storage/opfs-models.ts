/**
 * The model cache's files in the extension's Origin Private File System (T41, D-451): the
 * directory `models/`, one file per SHA-256, written and read through sync access handles, which
 * only a dedicated Worker has (`models-worker.ts`). A sync handle writes in place: a partial
 * download is on disk as it arrives (it survives a crash and resumes with `Range`), and a resume
 * never copies the file as `createWritable`'s swap file would. The extension's OPFS persists until
 * the extension is uninstalled (`unlimitedStorage` lifts the quota), and uninstalling removes it.
 */
import { MODELS_DIRECTORY, type BlobWriter, type ModelBlobStore } from "./models.js";

/** The part of the File System API this module uses; the DOM library carries no sync handle type. */
interface SyncAccessHandle {
  read(buffer: Uint8Array, options?: { at?: number }): number;
  write(buffer: Uint8Array, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileHandleWithSync extends FileSystemFileHandle {
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
  move?(name: string): Promise<void>;
}

/** The `models/` directory of this origin's OPFS. */
export async function modelsDirectory(root?: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle> {
  const base = root ?? (await navigator.storage.getDirectory());
  return base.getDirectoryHandle(MODELS_DIRECTORY, { create: true });
}

/** The cached files as Blobs, for the engine's `loadModel(blobs)` (no copy: OPFS hands out a File). */
export async function cachedBlobs(sha256s: readonly string[], root?: FileSystemDirectoryHandle): Promise<Blob[]> {
  const directory = await modelsDirectory(root);
  const out: Blob[] = [];
  for (const name of sha256s) out.push(await (await directory.getFileHandle(name)).getFile());
  return out;
}

const NOT_FOUND = new Set(["NotFoundError", "TypeMismatchError"]);

export class OpfsBlobStore implements ModelBlobStore {
  constructor(private readonly directory: FileSystemDirectoryHandle) {}

  static async open(root?: FileSystemDirectoryHandle): Promise<OpfsBlobStore> {
    return new OpfsBlobStore(await modelsDirectory(root));
  }

  private async handle(name: string, create = false): Promise<FileHandleWithSync | null> {
    try {
      return (await this.directory.getFileHandle(name, { create })) as FileHandleWithSync;
    } catch (error) {
      if (error instanceof Error && NOT_FOUND.has(error.name)) return null;
      throw error;
    }
  }

  async size(name: string): Promise<number | null> {
    const handle = await this.handle(name);
    return handle === null ? null : (await handle.getFile()).size;
  }

  async read(name: string, offset: number, length: number): Promise<Uint8Array> {
    const handle = await this.handle(name);
    if (handle === null) throw new Error(`${name} is not in the cache`);
    const slice = (await handle.getFile()).slice(offset, offset + length);
    return new Uint8Array(await slice.arrayBuffer());
  }

  async open(name: string): Promise<BlobWriter> {
    const handle = await this.handle(name, true);
    const access = await handle!.createSyncAccessHandle();
    let open = true;
    return {
      size: async () => access.getSize(),
      write: async (data, at) => {
        let written = 0;
        while (written < data.length) written += access.write(data.subarray(written), { at: at + written });
      },
      truncate: async (size) => access.truncate(size),
      flush: async () => access.flush(),
      close: async () => {
        if (!open) return;
        open = false;
        access.close();
      },
    };
  }

  async rename(from: string, to: string): Promise<void> {
    const handle = await this.handle(from);
    if (handle === null) throw new Error(`${from} is not in the cache`);
    if (typeof handle.move === "function") {
      await handle.move(to);
      return;
    }
    // No `move` (older Chrome): copy through a sync handle, then remove the source.
    const target = await this.open(to);
    const source = await handle.getFile();
    await target.truncate(0);
    for (let at = 0; at < source.size; at += 8 * 1024 * 1024) await target.write(new Uint8Array(await source.slice(at, at + 8 * 1024 * 1024).arrayBuffer()), at);
    await target.flush();
    await target.close();
    await this.remove(from);
  }

  async remove(name: string): Promise<void> {
    try {
      await this.directory.removeEntry(name);
    } catch (error) {
      if (error instanceof Error && NOT_FOUND.has(error.name)) return;
      throw error;
    }
  }

  async list(): Promise<Array<{ name: string; size: number }>> {
    const out: Array<{ name: string; size: number }> = [];
    for await (const [name, handle] of (this.directory as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (handle.kind === "file") out.push({ name, size: (await (handle as FileSystemFileHandle).getFile()).size });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }
}
