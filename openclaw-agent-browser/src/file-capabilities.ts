/**
 * Selected-file capabilities: how a person's own PDF becomes readable by one
 * run, and nothing else becomes readable at all.
 *
 * ```text
 *   operator selects a file            (an absolute path inside a configured root)
 *        │  lstat: a regular file, not a symlink; realpath inside the root
 *        │  open O_NOFOLLOW; fstat is the same inode; bounded read; %PDF- magic
 *        ▼
 *   immutable private copy             (0400, in this plugin's 0700 state dir)
 *        │  SHA-256 and size recorded at selection
 *        ▼
 *   opaque capability                  file_<32 hex>, bound to one package session
 *        │  named in execution.start's `files`, never in the package
 *        ▼
 *   the run's broker                   reads the copy, re-checks size and hash,
 *                                      and hands bytes — not a path — to the parser
 * ```
 *
 * ## What a package can say, and what it cannot
 *
 * A package can only put a *string* in a `file_id` argument. The broker looks
 * that string up in the capabilities attached to **this run** and refuses
 * anything else, so `/etc/passwd`, `../x.pdf`, `~/paper.pdf`, `file://…` and a
 * valid id from another session are all the same refusal: not a file this run
 * was given. No path, display name or directory ever crosses into a package,
 * a run plan, an audit, a report, a model or a result.
 *
 * ## Why a copy
 *
 * A capability must name exact bytes. Reading the original again at call time
 * would let the file change between the person's choice and the read, so the
 * selection copies the bytes once into a file only this process can reach, and
 * every read re-verifies the size and SHA-256 recorded at selection. A copy
 * that no longer matches is refused rather than parsed.
 *
 * Capabilities live in this process's memory, bounded per session, expire,
 * are released with their package session, and the private directory is
 * emptied at startup and shutdown. They are not a document store.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { AgentBrowserError, clip } from "./errors.js";

export const MAX_SELECTED_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES_PER_SESSION = 16;
export const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_FILE_TTL_SECONDS = 3600;
const FILE_ID = /^file_[0-9a-f]{32}$/u;
const PDF_MAGIC = Buffer.from("%PDF-", "latin1");

/** What a caller may see about one selected file. Never a path. */
export type FileCapabilityView = {
  fileId: string;
  sessionId: string;
  sha256: string;
  bytes: number;
  mediaType: "application/pdf";
  displayName: string;
  selectedAt: string;
  expiresAt: string;
};

type Stored = FileCapabilityView & { privatePath: string; expiresAtMs: number };

/** The bounded, path-free record a run's invocation binds. */
export type FileAttachment = {
  file_id: string;
  sha256: string;
  bytes: number;
  media_type: "application/pdf";
};

function refuse(title: string, detail: string, code: "not_allowed" | "invalid_request" | "source_rejected" | "limit_reached" = "not_allowed"): never {
  throw new AgentBrowserError(code, title, detail);
}

function safeDisplayName(path: string): string {
  const name = basename(path).normalize("NFC").replace(/[\u0000-\u001f\u007f]/gu, "");
  return clip(name || "selected.pdf", 128);
}

export function isFileId(value: unknown): value is string {
  return typeof value === "string" && FILE_ID.test(value);
}

export class FileCapabilityStore {
  private readonly files = new Map<string, Stored>();
  private ready = false;

  constructor(
    private readonly root: string,
    private readonly options: { ttlSeconds?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Create the private directory and discard anything a previous process left. */
  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.root).catch(() => [] as string[])) {
      if (/^file_[0-9a-f]{32}\.pdf$/u.test(name)) {
        await rm(join(this.root, name), { force: true }).catch(() => undefined);
      }
    }
    this.ready = true;
  }

  /**
   * Select one local PDF for a package session, and return its capability.
   *
   * `roots` are operator configuration. A path outside them, a symlink, a
   * non-regular file, a file that changes identity while being opened, an
   * oversized file and a file that is not a PDF are each refused before a
   * byte is kept.
   */
  async selectLocal(sessionId: string, candidate: string, roots: readonly string[]): Promise<FileCapabilityView> {
    if (!this.ready) await this.initialize();
    this.sweep();
    if (roots.length === 0) {
      refuse(
        "Local file selection is not enabled",
        "This host has no configured local file directory. An operator must set " +
          "plugins.entries.agent-browser.config.localFiles.roots before a file can be selected.",
      );
    }
    if (typeof candidate !== "string" || !isAbsolute(candidate) || candidate.includes("\u0000")) {
      refuse("Absolute path required", "Enter the full path of a PDF inside an allowed directory.");
    }
    if (!candidate.toLowerCase().endsWith(".pdf")) {
      refuse("Not a PDF", "Only .pdf files can be selected.");
    }
    const held = [...this.files.values()].filter((file) => file.sessionId === sessionId);
    if (held.length >= MAX_FILES_PER_SESSION) {
      refuse(
        "Too many selected files",
        `A package session may hold at most ${MAX_FILES_PER_SESSION} selected files.`,
        "limit_reached",
      );
    }
    let link;
    try {
      link = await lstat(candidate);
    } catch {
      refuse("File not found", "No readable file exists at that path.", "source_rejected");
    }
    if (link.isSymbolicLink()) {
      refuse(
        "Symbolic links are not selectable",
        "Select the file itself; a link could point somewhere its selector did not choose.",
      );
    }
    if (!link.isFile()) refuse("Not a regular file", "Only a regular file can be selected.");
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      refuse("File not found", "No readable file exists at that path.", "source_rejected");
    }
    let inside = false;
    for (const root of roots) {
      const realRoot = await realpath(root).catch(() => null);
      if (!realRoot) continue;
      if (real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) inside = true;
    }
    if (!inside) {
      refuse(
        "Path outside the allowed directories",
        "That file is not inside a directory this host allows the Agent Browser to read.",
      );
    }

    const handle = await open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() =>
      refuse("File not readable", "The selected file could not be opened.", "source_rejected"),
    );
    let data: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.ino !== link.ino || info.dev !== link.dev) {
        refuse(
          "The file changed while it was being selected",
          "Select it again; a file swapped between checking and opening is not accepted.",
          "source_rejected",
        );
      }
      if (info.size <= 0 || info.size > MAX_SELECTED_FILE_BYTES) {
        refuse(
          "File size not accepted",
          `A selected PDF must be between 1 byte and ${MAX_SELECTED_FILE_BYTES} bytes.`,
          "limit_reached",
        );
      }
      const buffer = Buffer.alloc(info.size + 1);
      let read = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
        if (read > MAX_SELECTED_FILE_BYTES || read > info.size) {
          refuse("File size not accepted", "The file grew while it was being read.", "limit_reached");
        }
      }
      data = buffer.subarray(0, read);
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (!data.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      refuse("Not a PDF", "The selected file does not begin with a PDF header.", "source_rejected");
    }
    const sessionBytes = held.reduce((total, file) => total + file.bytes, 0);
    if (sessionBytes + data.length > MAX_SESSION_FILE_BYTES) {
      refuse(
        "Selected files too large",
        `A package session may hold at most ${MAX_SESSION_FILE_BYTES} bytes of selected files.`,
        "limit_reached",
      );
    }

    const fileId = `file_${randomBytes(16).toString("hex")}`;
    const privatePath = join(this.root, `${fileId}.pdf`);
    const out = await open(
      privatePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o400,
    );
    try {
      await out.writeFile(data);
      await out.sync();
    } finally {
      await out.close();
    }
    const now = this.now();
    const ttl = (this.options.ttlSeconds ?? DEFAULT_FILE_TTL_SECONDS) * 1000;
    const record: Stored = {
      fileId,
      sessionId,
      sha256: createHash("sha256").update(data).digest("hex"),
      bytes: data.length,
      mediaType: "application/pdf",
      displayName: safeDisplayName(real),
      selectedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
      privatePath,
      expiresAtMs: now + ttl,
    };
    this.files.set(fileId, record);
    return this.view(record);
  }

  private view(record: Stored): FileCapabilityView {
    const { privatePath: _path, expiresAtMs: _expiry, ...view } = record;
    return view;
  }

  /** Drop expired capabilities and their copies. */
  private sweep(): void {
    const now = this.now();
    for (const [id, record] of [...this.files]) {
      if (record.expiresAtMs <= now) {
        this.files.delete(id);
        void rm(record.privatePath, { force: true }).catch(() => undefined);
      }
    }
  }

  list(sessionId: string): FileCapabilityView[] {
    this.sweep();
    return [...this.files.values()]
      .filter((record) => record.sessionId === sessionId)
      .map((record) => this.view(record));
  }

  /**
   * The capabilities a run may read, resolved against one session.
   *
   * Every id must be a live capability of *this* session; anything else is
   * refused by name, before a run exists.
   */
  attach(sessionId: string, fileIds: readonly string[]): Map<string, FileCapabilityView> {
    this.sweep();
    if (fileIds.length > MAX_FILES_PER_SESSION) {
      refuse("Too many files", `A run may be given at most ${MAX_FILES_PER_SESSION} files.`, "invalid_request");
    }
    const attached = new Map<string, FileCapabilityView>();
    for (const fileId of fileIds) {
      const record = isFileId(fileId) ? this.files.get(fileId) : undefined;
      if (!record || record.sessionId !== sessionId) {
        refuse(
          "Unknown selected file",
          "A run can only be given files selected in its own package session.",
          "invalid_request",
        );
      }
      attached.set(fileId, this.view(record));
    }
    return attached;
  }

  /**
   * The exact bytes of one capability, re-verified, or a refusal.
   *
   * Opened without following links, required to be the size and hash the
   * selection recorded. The path stays inside this function.
   */
  async readVerified(capability: FileCapabilityView): Promise<Buffer> {
    const record = this.files.get(capability.fileId);
    if (
      !record ||
      record.sessionId !== capability.sessionId ||
      record.sha256 !== capability.sha256 ||
      record.bytes !== capability.bytes
    ) {
      throw new AgentBrowserError(
        "not_allowed",
        "Selected file unavailable",
        "tool_unavailable: the selected file is no longer held by this host",
      );
    }
    const handle = await open(record.privatePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== record.bytes) {
        throw new AgentBrowserError(
          "not_allowed",
          "Selected file changed",
          "tool_unavailable: the selected file no longer has the size it was selected with",
        );
      }
      const data = Buffer.alloc(record.bytes);
      let read = 0;
      while (read < data.length) {
        const { bytesRead } = await handle.read(data, read, data.length - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      if (read !== record.bytes || createHash("sha256").update(data).digest("hex") !== record.sha256) {
        throw new AgentBrowserError(
          "not_allowed",
          "Selected file changed",
          "tool_unavailable: the selected file's bytes no longer match what was selected",
        );
      }
      return data;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async release(sessionId: string, fileId: string): Promise<boolean> {
    const record = this.files.get(fileId);
    if (!record || record.sessionId !== sessionId) return false;
    this.files.delete(fileId);
    await rm(record.privatePath, { force: true }).catch(() => undefined);
    return true;
  }

  async releaseSession(sessionId: string): Promise<number> {
    let released = 0;
    for (const record of [...this.files.values()]) {
      if (record.sessionId === sessionId && (await this.release(sessionId, record.fileId))) released += 1;
    }
    return released;
  }

  async stop(): Promise<void> {
    for (const record of [...this.files.values()]) {
      await rm(record.privatePath, { force: true }).catch(() => undefined);
    }
    this.files.clear();
  }

  /** For diagnostics and tests: the private directory exists and is owner-only. */
  async rootMode(): Promise<number> {
    return (await stat(resolvePath(this.root))).mode & 0o777;
  }
}

/** The path-free record a run's invocation binds, in a stable order. */
export function attachmentsOf(files: ReadonlyMap<string, FileCapabilityView>): FileAttachment[] {
  return [...files.values()]
    .map((file) => ({
      file_id: file.fileId,
      sha256: file.sha256,
      bytes: file.bytes,
      media_type: file.mediaType,
    }))
    .sort((a, b) => a.file_id.localeCompare(b.file_id));
}
