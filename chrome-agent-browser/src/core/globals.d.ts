/**
 * The ambient globals the portable core may use, and nothing else (D-024, D-031).
 *
 * `tsconfig.core.json` compiles the core with no DOM, Node or Chrome type library, so every
 * global the core touches has to be declared here. The list is the WHATWG surface that
 * exists identically in Node, Chrome extension contexts and web pages: UTF-8 coding, URL
 * parsing and WebCrypto. Adding a name here is an architectural decision, not a convenience:
 * `test/core/boundary.test.ts` also scans the sources for `chrome`, `document`, `window`,
 * `fetch` and friends.
 */

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string;
}

declare class URL {
  constructor(url: string, base?: string | URL);
  static canParse(url: string, base?: string | URL): boolean;
  href: string;
  readonly origin: string;
  protocol: string;
  username: string;
  password: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
  toString(): string;
}

interface CoreCryptoKey {
  readonly type: string;
  readonly algorithm: { name: string };
}

interface CoreSubtleCrypto {
  digest(algorithm: "SHA-256" | "SHA-512", data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer>;
  importKey(
    format: "raw",
    keyData: ArrayBuffer | ArrayBufferView,
    algorithm: { name: string; hash?: string },
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<CoreCryptoKey>;
  /** HMAC-SHA256 for the vault's resource digests (D-051) and the tool layer's resource digests. */
  sign(algorithm: { name: string }, key: CoreCryptoKey, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer>;
  verify(
    algorithm: { name: string },
    key: CoreCryptoKey,
    signature: ArrayBuffer | ArrayBufferView,
    data: ArrayBuffer | ArrayBufferView,
  ): Promise<boolean>;
  /** AES-256-GCM for the secret store (T16, D-191): a fresh IV per message, the entry name as additional data. */
  encrypt(algorithm: { name: "AES-GCM"; iv: ArrayBufferView; additionalData?: ArrayBufferView; tagLength?: number }, key: CoreCryptoKey, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer>;
  decrypt(algorithm: { name: "AES-GCM"; iv: ArrayBufferView; additionalData?: ArrayBufferView; tagLength?: number }, key: CoreCryptoKey, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer>;
}

declare const crypto: {
  readonly subtle: CoreSubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  randomUUID(): string;
};

// Timers and abort signals (T4): deadlines and cancellation in the interpreter and the
// adapters. Both are the WHATWG surface, identical in Node, extension contexts and pages.
declare function setTimeout(handler: () => void, timeout?: number): unknown;
declare function clearTimeout(handle: unknown): void;

declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

declare class AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
  throwIfAborted(): void;
  /** A signal that aborts after `milliseconds` with a `TimeoutError` (Chrome 103+, Node 17.3+). */
  static timeout(milliseconds: number): AbortSignal;
  /** A signal that aborts when any of `signals` does, with that signal's reason (Chrome 116+, Node 20.3+). */
  static any(signals: AbortSignal[]): AbortSignal;
}

// WebAssembly (T22, compute.v0): the engine every host has. The core compiles a module (the
// preflight of D-245) and the pure call body instantiates one; where it runs is the host's
// Worker. Only what the body touches is declared.
declare namespace WebAssembly {
  class Module {
    constructor(bytes: ArrayBuffer | ArrayBufferView);
  }
  class Instance {
    constructor(module: Module, importObject?: Record<string, Record<string, unknown>>);
    readonly exports: Record<string, unknown>;
  }
  class Memory {
    readonly buffer: ArrayBuffer;
  }
  class CompileError extends Error {}
  class LinkError extends Error {}
  class RuntimeError extends Error {}
  function compile(bytes: ArrayBuffer | ArrayBufferView): Promise<Module>;
  function validate(bytes: ArrayBuffer | ArrayBufferView): boolean;
}
