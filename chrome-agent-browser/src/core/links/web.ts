/**
 * A slot's look and a linked package's download over a host's transport (link.v0 L-10, L-31, L-32).
 *
 * Both are one request under the rules the package-URL and discovery policies already state: HTTPS,
 * no redirect followed, a byte cap, a deadline, and nothing sent but the request line and an
 * `accept` header: no body, no cookie, no referrer. The transport is the host's (`cli-net.ts` in
 * Node, the extension's `browserTransport`), handed in, so nothing here touches the network and the
 * address policy stays where it is. A refusal is a `CoreError` with the code `findCandidate` lists.
 */
import { MAX_ARCHIVE_BYTES } from "../archive.js";
import { DEFAULT_LIMITS, discoverFromPage, mediaType, type DiscoveryResult } from "../discovery.js";
import { CoreError } from "../errors.js";
import { TransportError, type HttpTransport } from "../models/transport.js";
import { validatePackageUrl } from "../policy.js";

/** Milliseconds a dependency's or a candidate's download may take. */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

function transportCode(error: unknown, operation: "download" | "discovery"): string {
  if (error instanceof TransportError && error.facts.stage === "body_size") return operation === "download" ? "download_too_large" : "discovery_too_large";
  if (error instanceof Error && error.name === "TimeoutError") return `${operation}_timeout`;
  return `${operation}_failed`;
}

/** A package's bytes at a URL under the package-URL policy: no redirect, a byte cap, nothing sent but the request line. */
export async function downloadPackage(url: string, transport: HttpTransport): Promise<Uint8Array> {
  validatePackageUrl(url);
  let response;
  try {
    response = await transport({ url, method: "GET", headers: { accept: "application/octet-stream" }, body: null, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), maxResponseBytes: MAX_ARCHIVE_BYTES });
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError(transportCode(error, "download"), `Cannot download the package: ${error instanceof Error ? error.name : "error"}`, { status: 502 });
  }
  if (response.status >= 300 && response.status < 400) throw new CoreError("download_redirect_denied", "Package host returned a redirect; redirects are disabled", { status: 502 });
  if (response.status !== 200) throw new CoreError("download_failed", `Package host returned HTTP ${response.status}`, { status: 502 });
  return response.bytes ?? new TextEncoder().encode(response.body);
}

/** Website discovery of one page (`browser/discovery.py`'s rules: one page, a byte cap, no script, no redirect followed). */
export async function lookAtPage(url: string, transport: HttpTransport): Promise<DiscoveryResult> {
  const hash = url.indexOf("#");
  const document = hash >= 0 ? url.slice(0, hash) : url;
  validatePackageUrl(document, "Website");
  let response;
  try {
    // The page's first MiB, its head scanned (T66 review 1, nit 7): `browser/discovery.py` and `RecordedWeb.look` read a longer page the same way.
    response = await transport({ url: document, method: "GET", headers: { accept: "text/html, application/xhtml+xml" }, body: null, signal: AbortSignal.timeout(DEFAULT_LIMITS.timeoutSeconds * 1000), maxResponseBytes: DEFAULT_LIMITS.maxHtmlBytes, truncate: true });
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError(transportCode(error, "discovery"), `Cannot read the website: ${error instanceof Error ? error.name : "error"}`, { status: 502 });
  }
  if (response.status >= 300 && response.status < 400) throw new CoreError("discovery_redirect_refused", "The website answered with a redirect, which discovery does not follow", { status: 502 });
  if (response.status !== 200) throw new CoreError("discovery_http_status", `The website answered HTTP ${response.status} instead of a page`, { status: 502, details: { status: response.status } });
  const contentType = response.headers["content-type"] ?? "";
  const [, parameters] = mediaType(contentType);
  return discoverFromPage({ requested_url: url, final_url: document, redirects: [], content_type: contentType, charset: parameters.charset ?? null, content_coding: "identity", body: response.bytes ?? new TextEncoder().encode(response.body), truncated: response.truncated === true });
}
