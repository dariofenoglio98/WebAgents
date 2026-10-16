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
  /** T9's WebAir 0.5.0: 0.4.0 plus the departure-airport answer (`agentpkg verify` and `shasum`, 2026-10-09, T9 progress log). */
  webair050: {
    archive: resolve(ROOT, "dist/webair-0.5.0.agent.pkg"),
    key: resolve(ROOT, "examples/keys/webair-publisher.pub.pem"),
    packageId: "org.webagents.webair",
    version: "0.5.0",
    publisherId: "webair-demo",
    digest: "6192614e86ae4b18ba135f17120d4f616feac082c4ab09283221da7194c0bb48",
    archiveSha256: "4b087557cbd2b0ff186391dfd00f9068739f9a727ab2fd916a6512da1fde101b",
    fingerprint: "sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b",
  },
  /** T20: the current WebAir (memory.v0, runtime minimum 0.4.0), which the demo index 1.3.0 names. */
  webair060: {
    archive: resolve(ROOT, "dist/webair-0.6.0.agent.pkg"),
    key: resolve(ROOT, "examples/keys/webair-publisher.pub.pem"),
    packageId: "org.webagents.webair",
    version: "0.6.0",
    publisherId: "webair-demo",
    digest: "e1ef5ad07f5be9148d5d7b5d6f6e88e3ba9cfdb291d8d2ba2fb9bc0f06d6022f",
    archiveSha256: "3055dd93a9f4e5f81f3ccddac77ccc9ce2c10b1e10dec35d9864fddf6fb58862",
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
  /** T10: the current Literature Review, which the demo index 1.1.0 names (T11); `literatureReview` stays 0.2.5, which index 1.0.0, the reader schemas and the summaries describe. */
  literatureReview026: {
    archive: resolve(ROOT, "dist/literature-review-0.2.6.agent.pkg"),
    key: resolve(ROOT, "examples/keys/literature-review-publisher.pub.pem"),
    packageId: "org.webagents.literature-review",
    version: "0.2.6",
    publisherId: "webagents-research",
    digest: "09399b953afd487ee87dcf321a32ff1e735c8d862ac662ea2c4ee1f8ef1b6e4e",
    archiveSha256: "685dcc97232d278eb2a5b777dcbc621573de5c48818a95d522e647c9267ee8f1",
    fingerprint: "sha256:c5ca9763f9fc71253298ca381ec14c4d7432009c74dacc69df6344b71de05232",
  },
  /** T15: the current Literature Review, which the demo index 1.2.0 names; 0.2.6 above stays what index 1.1.0 named. */
  literatureReview027: {
    archive: resolve(ROOT, "dist/literature-review-0.2.7.agent.pkg"),
    key: resolve(ROOT, "examples/keys/literature-review-publisher.pub.pem"),
    packageId: "org.webagents.literature-review",
    version: "0.2.7",
    publisherId: "webagents-research",
    digest: "9274a5ce46275e6817ae2706791c19a8066e523776cb9eb348a76b83396a99cb",
    archiveSha256: "8951a14bb1f42bca1590bc7d0c9cc00cccba75b36f1488969b6b3ff47063fe61",
    fingerprint: "sha256:c5ca9763f9fc71253298ca381ec14c4d7432009c74dacc69df6344b71de05232",
  },
  /** T20: the current Literature Review (memory.v0, runtime minimum 0.4.0), which the demo index 1.3.0 names. */
  literatureReview028: {
    archive: resolve(ROOT, "dist/literature-review-0.2.8.agent.pkg"),
    key: resolve(ROOT, "examples/keys/literature-review-publisher.pub.pem"),
    packageId: "org.webagents.literature-review",
    version: "0.2.8",
    publisherId: "webagents-research",
    digest: "fb107c188d6995c5308e06b6ade751604455245c2413fce7a39c92841d4652b6",
    archiveSha256: "0d03d1c8b366aabd6343b15958185c10cdab6639828f9c73bafbb26538db8330",
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
