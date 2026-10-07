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
}
