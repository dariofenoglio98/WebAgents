/**
 * Repository paths and the reference values recorded from `agentpkg verify` on
 * 2026-10-06 (see the T1 progress log). Shipped artifacts are never modified (D-003); tests
 * read them and build variants in memory.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The repository root (`chrome-agent-browser/..`). */
export const ROOT = resolve(here, "..", "..", "..");
export const PROJECT = resolve(here, "..", "..");

export const SHIPPED = {
  webair: {
    archive: resolve(ROOT, "dist/webair-0.3.0.agent.pkg"),
    key: resolve(ROOT, "examples/keys/webair-publisher.pub.pem"),
    packageId: "org.webagents.webair",
    version: "0.3.0",
    publisherId: "webair-demo",
    digest: "ffe8f5b344f97c631498bb6da3e17217ae7e5730721935b0e66c5d595b335e94",
    archiveSha256: "b537cf5cba06bce8137533eb75b491486f57caf3098af30f657343b741492887",
    fingerprint: "sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b",
    payloadFiles: 58,
  },
  /** T2's WebAir 0.4.0: 0.3.0 plus the profiles extension (`agentpkg verify` and `shasum`, 2026-10-06, T3 progress log). */
  webair040: {
    archive: resolve(ROOT, "dist/webair-0.4.0.agent.pkg"),
    key: resolve(ROOT, "examples/keys/webair-publisher.pub.pem"),
    packageId: "org.webagents.webair",
    version: "0.4.0",
    publisherId: "webair-demo",
    digest: "0e8317f11e8813e7d5b4b3f352f20148d114329dca3db8c725c5b0558af24fbb",
    archiveSha256: "c12f9db3bd7b3b4b6721c67e1d0b8143ebd94381df0e5e57c196357b7ca77f63",
    fingerprint: "sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b",
  },
  literatureReview: {
    archive: resolve(ROOT, "dist/literature-review-0.2.5.agent.pkg"),
    key: resolve(ROOT, "examples/keys/literature-review-publisher.pub.pem"),
    packageId: "org.webagents.literature-review",
    version: "0.2.5",
    publisherId: "webagents-research",
    digest: "cef9ebd68df9db3b36c1ffeac9069d734b0e41a40d58445aaba1a60eaac155b5",
    archiveSha256: "1669f83fafac3434748fc19d38a8d3d2c3352da83cf1cbb84796ce313bd4f571",
    fingerprint: "sha256:c5ca9763f9fc71253298ca381ec14c4d7432009c74dacc69df6344b71de05232",
  },
  meetingAgenda: {
    archive: resolve(ROOT, "dist/meeting-agenda-0.2.2.agent.pkg"),
    key: resolve(ROOT, "examples/keys/meeting-agenda-publisher.pub.pem"),
    packageId: "org.webagents.meeting-agenda",
    version: "0.2.2",
    publisherId: "webagents-research",
    archiveSha256: "7b148e845c0f9e38d752a51a8d0b60a314842a3de3a2723b3bdf1a0c041921e1",
    fingerprint: "sha256:2bcc374a7fe18e50622042b7d0375fcb24eb3607879a236f9f3c3ede1922c5c4",
  },
} as const;

/** The original development key; signs nothing current (tests/shipped_keys.py). */
export const ORIGINAL_KEY = resolve(ROOT, "examples/keys/workflow-publisher.pub.pem");
export const ORIGINAL_FINGERPRINT = "sha256:c7549e614dac7070e6b5b5355e7c2407e1185f831d7fff15670981229dd85a70";

export function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}
