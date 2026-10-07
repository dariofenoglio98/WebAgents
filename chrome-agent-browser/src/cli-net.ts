/**
 * The Node side of the network (D-067): the destination policy the Python runtime
 * (`agentpkg.netaddr`, `network.py`) and the reference plugin (`tool-broker.ts`) apply,
 * reproduced for the CLI because Node, unlike an extension, has a resolver and a socket.
 *
 * Every destination passes the core's URL gate (`validatePackageUrl`, D-039: HTTPS on 443, a
 * DNS name, no IP literal, no local name, trailing dots stripped before the name tests), is
 * resolved, has every address classified (`addressRejection`, the port of
 * `public_address_reason` checked against the reference's own verdicts in
 * `test/fixtures/netaddr-vectors.json`), and is connected to on the validated address with
 * TLS still authenticating the name. The one exception is the model transport's loopback
 * host: Ollama on this machine over plain HTTP, and only when the name resolves to loopback.
 * One request, no redirect followed, the body streamed and stopped at the cap, the signal
 * honoured from resolution to the last byte.
 */
import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

import { CoreError } from "./core/errors.js";
import type { Http } from "./core/models/catalog.js";
import { TransportError, type HttpRequest, type HttpResponse, type HttpTransport } from "./core/models/transport.js";
import { validatePackageUrl } from "./core/policy.js";

export const MAX_RESOLVED_ADDRESSES = 8;
/** The catalog probe's own bounds: a hanging provider cannot block `run --mode live` before any deadline applies. */
export const CATALOG_PROBE_TIMEOUT_MS = 20_000;
export const CATALOG_PROBE_MAX_BYTES = 4 * 1024 * 1024;
const LOOPBACK_NAMES: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

// -- address classes (agentpkg.netaddr.public_address_reason, CPython 3.13 ipaddress) --------

const METADATA_V4 = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200", "192.0.0.192"]);
const METADATA_V6 = new Set(["fd00:ec2::254"]);

function parseIpv4(text: string): number | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(text);
  if (!match) return null;
  let value = 0;
  for (const part of match.slice(1)) {
    if (part.length > 1 && part.startsWith("0")) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** Eight 16-bit groups as one 128-bit integer; a trailing dotted quad fills the last two. A `%zone` is accepted and ignored, as CPython does. */
function parseIpv6(raw: string): bigint | null {
  const text = raw.includes("%") ? raw.slice(0, raw.indexOf("%")) : raw;
  if (raw.includes("%") && raw.indexOf("%") === raw.length - 1) return null;
  if (text.length === 0 || !/^[0-9A-Fa-f:.]+$/u.test(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string, last: boolean): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (const [index, piece] of pieces.entries()) {
      if (last && index === pieces.length - 1 && piece.includes(".")) {
        const quad = parseIpv4(piece);
        if (quad === null) return null;
        out.push(Math.floor(quad / 65536), quad % 65536);
      } else {
        if (!/^[0-9A-Fa-f]{1,4}$/u.test(piece)) return null;
        out.push(Number.parseInt(piece, 16));
      }
    }
    return out;
  };
  const head = groups(halves[0]!, halves.length === 1);
  const tail = halves.length === 2 ? groups(halves[1]!, true) : [];
  if (head === null || tail === null) return null;
  let full: number[];
  if (halves.length === 2) {
    if (head.length + tail.length > 7) return null;
    full = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  } else {
    if (head.length !== 8) return null;
    full = head;
  }
  let value = 0n;
  for (const group of full) value = (value << 16n) | BigInt(group);
  return value;
}

const v4 = (text: string): number => parseIpv4(text)!;
const inV4 = (address: number, network: string, bits: number): boolean => address >>> (32 - bits) === v4(network) >>> (32 - bits);
const v6 = (text: string): bigint => parseIpv6(text)!;
const inV6 = (address: bigint, network: string, bits: number): boolean => address >> BigInt(128 - bits) === v6(network) >> BigInt(128 - bits);
const dotted = (address: number): string => [address >>> 24, (address >>> 16) & 255, (address >>> 8) & 255, address & 255].join(".");

const PRIVATE_V4: ReadonlyArray<[string, number]> = [["0.0.0.0", 8], ["10.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.0.170", 31], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["240.0.0.0", 4], ["255.255.255.255", 32]];
const PRIVATE_V4_EXCEPTIONS: ReadonlyArray<[string, number]> = [["192.0.0.9", 32], ["192.0.0.10", 32]];
const RESERVED_V6: ReadonlyArray<[string, number]> = [["::", 8], ["100::", 8], ["200::", 7], ["400::", 6], ["800::", 5], ["1000::", 4], ["4000::", 3], ["6000::", 3], ["8000::", 3], ["a000::", 3], ["c000::", 3], ["e000::", 4], ["f000::", 5], ["f800::", 6], ["fe00::", 9]];
const PRIVATE_V6: ReadonlyArray<[string, number]> = [["::1", 128], ["::", 128], ["::ffff:0:0", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["fc00::", 7], ["fe80::", 10]];
const PRIVATE_V6_EXCEPTIONS: ReadonlyArray<[string, number]> = [["2001:1::1", 128], ["2001:1::2", 128], ["2001:3::", 32], ["2001:4:112::", 48], ["2001:20::", 28], ["2001:30::", 28]];

function rejectIpv4(address: number): string | null {
  const text = dotted(address);
  if (METADATA_V4.has(text)) return "cloud_metadata_address";
  if (address === 0) return "unspecified_address";
  if (inV4(address, "127.0.0.0", 8)) return "loopback_address";
  if (inV4(address, "169.254.0.0", 16)) return "link_local_address";
  if (inV4(address, "224.0.0.0", 4)) return "multicast_address";
  if (inV4(address, "240.0.0.0", 4)) return "reserved_address";
  const listed = PRIVATE_V4.some(([network, bits]) => inV4(address, network, bits));
  const excepted = PRIVATE_V4_EXCEPTIONS.some(([network, bits]) => inV4(address, network, bits));
  if (listed && !excepted) return "private_address";
  if (inV4(address, "100.64.0.0", 10)) return "non_global_address";
  return null;
}

function rejectIpv6(address: bigint): string | null {
  const mapped = inV6(address, "::ffff:0:0", 96) ? Number(address & 0xffffffffn) : null;
  if (METADATA_V6.has(compressed(address)) || (mapped !== null && METADATA_V4.has(dotted(mapped)))) return "cloud_metadata_address";
  // CPython 3.13 answers the IPv4-mapped questions for the embedded address first.
  if (mapped !== null) {
    if (mapped === 0) return "unspecified_address";
    if (inV4(mapped, "127.0.0.0", 8)) return "loopback_address";
    if (inV4(mapped, "169.254.0.0", 16)) return "link_local_address";
    if (inV4(mapped, "224.0.0.0", 4)) return "multicast_address";
    return "ipv4_mapped_address";
  }
  if (address === 0n) return "unspecified_address";
  if (address === 1n) return "loopback_address";
  if (inV6(address, "fe80::", 10)) return "link_local_address";
  if (inV6(address, "ff00::", 8)) return "multicast_address";
  if (inV6(address, "2002::", 16)) return "sixtofour_address";
  if (inV6(address, "2001::", 32)) return "teredo_address";
  if (inV6(address, "64:ff9b::", 96) || inV6(address, "64:ff9b:1::", 48)) return "nat64_address";
  if (RESERVED_V6.some(([network, bits]) => inV6(address, network, bits))) return "reserved_address";
  const listed = PRIVATE_V6.some(([network, bits]) => inV6(address, network, bits));
  const excepted = PRIVATE_V6_EXCEPTIONS.some(([network, bits]) => inV6(address, network, bits));
  if (listed && !excepted) return "private_address";
  return null;
}

/** The RFC 5952 text of an address, for the one named IPv6 metadata address. */
function compressed(address: bigint): string {
  const groups: number[] = [];
  for (let index = 7; index >= 0; index -= 1) groups.push(Number((address >> BigInt(index * 16)) & 0xffffn));
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < 8; start += 1) {
    if (groups[start] !== 0) continue;
    let end = start;
    while (end < 8 && groups[end] === 0) end += 1;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  const hex = (group: number) => group.toString(16);
  if (bestLength < 2) return groups.map(hex).join(":");
  const left = groups.slice(0, bestStart).map(hex).join(":");
  const right = groups.slice(bestStart + bestLength).map(hex).join(":");
  return `${left}::${right}`;
}

/** `public_address_reason`: a stable class name for a refused address, or null when it may be contacted. */
export function addressRejection(address: string): string | null {
  const four = parseIpv4(address);
  if (four !== null) return rejectIpv4(four);
  const six = parseIpv6(address);
  if (six !== null) return rejectIpv6(six);
  return "unparsable_address";
}

// -- resolution ------------------------------------------------------------------------------

export type Resolver = (hostname: string) => Promise<string[]>;

export const defaultResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        reject(new TransportError("the destination host could not be resolved", { stage: "transport" }));
        return;
      }
      resolve(addresses.map((entry) => entry.address).slice(0, MAX_RESOLVED_ADDRESSES));
    });
  });

export interface Destination {
  hostname: string;
  address: string;
  port: number;
  tls: boolean;
  path: string;
  hostHeader: string;
}

/**
 * Where a request may go, decided before any socket: the gate, the resolution and the class of
 * every address. The loopback exception applies to the model transport only, and only to a name
 * that actually resolves to this machine.
 */
export async function resolveDestination(url: string, options: { allowLoopbackHttp: boolean; resolve?: Resolver }): Promise<Destination> {
  const resolve = options.resolve ?? defaultResolver;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TransportError("the destination is not a URL", { stage: "address_policy" });
  }
  if (options.allowLoopbackHttp && LOOPBACK_NAMES.includes(parsed.hostname) && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    const host = parsed.hostname.replace(/^\[|\]$/gu, "");
    const addresses = isIP(host) !== 0 ? [host] : await resolve(host);
    if (addresses.length === 0 || addresses.some((address) => addressRejection(address) !== "loopback_address")) {
      throw new TransportError("the local model host does not resolve to this machine", { stage: "address_policy", reason: "loopback_expected" });
    }
    const tls = parsed.protocol === "https:";
    return { hostname: host, address: addresses[0]!, port: parsed.port ? Number(parsed.port) : tls ? 443 : 80, tls, path: `${parsed.pathname}${parsed.search}`, hostHeader: parsed.host };
  }
  let gate: { hostname: string; target: string };
  try {
    gate = validatePackageUrl(url, "Destination");
  } catch (error) {
    throw new TransportError(`destination refused by the address policy: ${error instanceof CoreError ? error.message : "malformed URL"}`, { stage: "address_policy", reason: "url_rejected" });
  }
  const addresses = await resolve(gate.hostname);
  if (addresses.length === 0) throw new TransportError("the destination host has no addresses", { stage: "transport" });
  for (const address of addresses) {
    const reason = addressRejection(address);
    if (reason !== null) throw new TransportError(`the destination host resolves to a non-public address (${reason})`, { stage: "address_policy", reason });
  }
  return { hostname: gate.hostname, address: addresses[0]!, port: 443, tls: true, path: gate.target, hostHeader: gate.hostname };
}

// -- the request -------------------------------------------------------------------------------

function connectionFailure(error: NodeJS.ErrnoException): TransportError {
  const tls = /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|UNABLE_TO_VERIFY_|SELF_SIGNED_|ERR_OSSL_)/u.test(error.code ?? "");
  return new TransportError(tls ? "the destination's TLS handshake or certificate failed" : "the connection to the destination failed", { stage: tls ? "tls" : "transport" });
}

/** One request on a pinned connection; the body streamed and stopped at the cap; no redirect followed. */
function perform(destination: Destination, request: HttpRequest): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      outcome();
    };
    let socket: Socket;
    try {
      // The connection is pinned to the address this process classified; TLS still verifies the
      // certificate against the name the binding or the provider holds.
      socket = destination.tls
        ? tlsConnect({ host: destination.address, port: destination.port, ...(isIP(destination.hostname) === 0 ? { servername: destination.hostname } : {}), ALPNProtocols: ["http/1.1"] })
        : netConnect({ host: destination.address, port: destination.port });
    } catch (error) {
      finish(() => reject(connectionFailure(error as NodeJS.ErrnoException)));
      return;
    }
    socket.on("error", (error: NodeJS.ErrnoException) => finish(() => reject(request.signal.aborted ? (request.signal.reason as Error) : connectionFailure(error))));
    const headers: Record<string, string> = { ...request.headers, host: destination.hostHeader };
    // No `agent` at all: with one, even `agent: false`, Node ignores `createConnection` and
    // dials the host name itself, which would resolve it a second time (BACKLOG B-116 for the
    // reference plugin, which sets both). Without an agent the request uses exactly this socket.
    const options: RequestOptions = {
      host: destination.hostname,
      path: destination.path,
      method: request.method,
      headers,
      createConnection: () => socket,
      signal: request.signal,
    };
    const onResponse = (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      const responseHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (typeof value === "string") responseHeaders[name.toLowerCase()] = value;
        else if (Array.isArray(value)) responseHeaders[name.toLowerCase()] = value.join(", ");
      }
      const stop = (outcome: () => void) => {
        response.destroy();
        socket.destroy();
        finish(outcome);
      };
      if (status >= 300 && status < 400) {
        // Each hop would need the whole policy re-applied to a destination nobody authorized.
        stop(() => resolve({ status, headers: responseHeaders, body: "" }));
        return;
      }
      const declared = Number.parseInt(responseHeaders["content-length"] ?? "", 10);
      if (Number.isFinite(declared) && declared > request.maxResponseBytes) {
        stop(() => reject(new TransportError("the response exceeds the byte cap", { stage: "body_size", http_status: status, response_bytes: declared })));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > request.maxResponseBytes) {
          stop(() => reject(new TransportError("the response exceeds the byte cap", { stage: "body_size", http_status: status, response_bytes: size })));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        socket.destroy();
        finish(() => resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks).toString("utf8") }));
      });
      response.on("error", () => stop(() => reject(request.signal.aborted ? (request.signal.reason as Error) : new TransportError("the response failed mid-transfer", { stage: "transport" }))));
    };
    const outbound = destination.tls ? httpsRequest(options, onResponse) : httpRequest(options, onResponse);
    outbound.on("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      finish(() => reject(request.signal.aborted ? (request.signal.reason as Error) : connectionFailure(error)));
    });
    if (request.body !== null) outbound.write(request.body);
    outbound.end();
  });
}

/**
 * The Node transport (D-024, D-067): the policy above, then one request. `allowLoopbackHttp`
 * is the model transport's Ollama exception; the tool transport never sets it.
 */
export function nodeTransport(options: { allowLoopbackHttp: boolean; resolve?: Resolver }): HttpTransport {
  return async (request) => {
    if (request.signal.aborted) throw (request.signal.reason as Error | undefined) ?? new TransportError("the request was cancelled", { stage: "transport" });
    const destination = await resolveDestination(request.url, options);
    if (request.signal.aborted) throw (request.signal.reason as Error | undefined) ?? new TransportError("the request was cancelled", { stage: "transport" });
    return perform(destination, request);
  };
}

/** The catalog probe's HTTP over the same transport: the provider's credential header, a deadline of its own, a bounded JSON body. */
export function catalogHttp(keys: { openai: string | null; anthropic: string | null }, options: { resolve?: Resolver; timeoutMs?: number } = {}): Http {
  const transport = nodeTransport({ allowLoopbackHttp: true, resolve: options.resolve });
  return async (request) => {
    const headers: Record<string, string> = { accept: "application/json", ...request.headers };
    if (request.provider === "openai" && keys.openai) headers.authorization = `Bearer ${keys.openai}`;
    if (request.provider === "anthropic" && keys.anthropic) headers["x-api-key"] = keys.anthropic;
    if (request.body !== undefined) headers["content-type"] = "application/json";
    const response = await transport({
      url: request.url,
      method: request.method,
      headers,
      body: request.body === undefined ? null : JSON.stringify(request.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? CATALOG_PROBE_TIMEOUT_MS),
      maxResponseBytes: CATALOG_PROBE_MAX_BYTES,
    });
    let body: unknown = null;
    try {
      body = JSON.parse(response.body);
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };
}
