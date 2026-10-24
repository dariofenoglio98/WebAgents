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
  /** T24: the current WebAir (conversation.v0, runtime minimum 0.6.0), which the demo index 1.5.0 names. */
  webair080: {
    archive: resolve(ROOT, "dist/webair-0.8.0.agent.pkg"),
    key: resolve(ROOT, "examples/keys/webair-publisher.pub.pem"),
    packageId: "org.webagents.webair",
    version: "0.8.0",
    publisherId: "webair-demo",
    digest: "b346a4740b3b1052bb77f781ec4c2cbb4d29644a71f9a3c29e1cd8921d9572c2",
    archiveSha256: "9c81a9362754fc3c48c923b4968e75daa9e0260ae422be7e77b30f1df1a7eae0",
    fingerprint: "sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b",
  },
  /** T22: WebAir 0.7.0 (compute.v0, runtime minimum 0.5.0), which the demo index 1.4.0 named. */
  webair070: {
    archive: resolve(ROOT, "dist/webair-0.7.0.agent.pkg"),
    key: resolve(ROOT, "examples/keys/webair-publisher.pub.pem"),
    packageId: "org.webagents.webair",
    version: "0.7.0",
    publisherId: "webair-demo",
    digest: "abab1e37fcf85b04d51b65ce60febc7fd823af77b56ec6d0634ed7287355409b",
    archiveSha256: "c0265a283d0b2edd5c919e1bb7cb3a95e6ccfc449d76590d62b1a47ff3fbd808",
    fingerprint: "sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b",
  },
  /** T20: WebAir 0.6.0 (memory.v0, runtime minimum 0.4.0), which the demo index 1.3.0 named. */
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
  /** T20: Literature Review 0.2.8 (memory.v0, runtime minimum 0.4.0), which the demo index 1.3.0 named. */
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
  /** T22: the current Literature Review (compute.v0, runtime minimum 0.5.0), which the demo index 1.4.0 names. */
  literatureReview029: {
    archive: resolve(ROOT, "dist/literature-review-0.2.9.agent.pkg"),
    key: resolve(ROOT, "examples/keys/literature-review-publisher.pub.pem"),
    packageId: "org.webagents.literature-review",
    version: "0.2.9",
    publisherId: "webagents-research",
    digest: "87732ea9b587df4ffe84c779f3b553d25a95f64911b374134d30e293c573cdfc",
    archiveSha256: "00f33aea8504669080031b22c4a2903fb01812ba9f93f6deaf68fcde13891f3f",
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
/** T21's compute-test 0.1.0 (compute.v0, runtime minimum 0.5.0): the model-free package over the two example modules, signed with a development key (`examples/compute/README.md`). */
export const COMPUTE_TEST = {
  archive: resolve(ROOT, "examples/compute/compute-test.agent.pkg"),
  key: resolve(ROOT, "examples/keys/compute-test-publisher.pub.pem"),
  grants: resolve(ROOT, "examples/compute/compute-test-grants.json"),
  packageId: "org.webagents.compute-test",
  version: "0.1.0",
  digest: "3d174d573a8f7d36be2e4700e5319de280788bec101613816a301e6b2387decd",
  archiveSha256: "8bbbd42a9c50c27b339e00653990449781fac5d58694216c890585561a800ff4",
};

/** conversation.v0's test package (T23): the ticket desk, signed with its development key. */
export const CONVERSATION_TEST = {
  archive: resolve(ROOT, "examples/conversation/conversation-test.agent.pkg"),
  key: resolve(ROOT, "examples/keys/conversation-test-publisher.pub.pem"),
  grants: resolve(ROOT, "examples/conversation/conversation-test-grants.json"),
  packageId: "org.webagents.conversation-test",
  version: "0.1.0",
  digest: "cd9cfc7f5f819110cf8b39cd8c15b2133283f834c1f4c9ef6d183e481e9582ab",
  archiveSha256: "4b7c8eba80d62afcf0ad3d303f15ae9a736540230255ee4debaa083e60cbb230",
  fingerprint: "sha256:8fd73c6495de3610c6bc41f9950abec90cee118e6932df8d9beef81176988e10",
};

export const ORIGINAL_KEY = resolve(ROOT, "examples/keys/workflow-publisher.pub.pem");
export const ORIGINAL_FINGERPRINT = "sha256:c7549e614dac7070e6b5b5355e7c2407e1185f831d7fff15670981229dd85a70";

export function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}
