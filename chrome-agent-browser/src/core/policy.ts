/**
 * The URL policy for package, website and tool addresses (D-026), mirroring the syntax gate
 * of `agentpkg/browser/fetch.py::validate_package_url` and the URL helpers of
 * `browser/discovery.py`.
 *
 * Syntax: HTTPS only, port 443, no credentials, no fragment, no whitespace or control
 * bytes, at most 2048 characters, a host required. The Chrome line adds, at the syntax
 * stage, what the reference enforces at resolution: no IP literals, no `localhost`, no
 * `.localhost` or `.local` names. **Address classification does not happen here.** The
 * reference resolves every hostname and refuses private, loopback, link-local, multicast,
 * reserved and cloud-metadata destinations before connecting, and pins the connection to
 * the validated address; an extension has no resolver and no socket, so those checks are
 * performed by Chrome's network stack when it connects, and the threat model says so.
 */
import { CoreError } from "./errors.js";
import { urlsplit, type SplitUrl } from "./urls.js";

export const MAX_URL_CHARS = 2048;
/** `(scheme, host, effective port)` of an http(s) URL. */
export type Origin = readonly [scheme: string, host: string, port: number];

function reject(message: string, status = 400): CoreError {
  return new CoreError("url_rejected", message, { status });
}

function hasUnsafeCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || /\s/u.test(character)) return true;
  }
  return false;
}

function isIpLiteral(hostname: string): boolean {
  if (hostname.includes(":")) return true; // a bracketed IPv6 literal, already unbracketed
  const labels = hostname.split(".");
  return labels.length === 4 && labels.every((label) => /^[0-9]{1,3}$/u.test(label));
}

/**
 * `validate_package_url`: the syntax gate. Returns `(hostname, request target)` or throws
 * `url_rejected`. `subject` only names the URL in messages ("Package", "Website").
 */
export function validatePackageUrl(url: unknown, subject = "Package"): { hostname: string; target: string } {
  const noun = subject.toLowerCase();
  if (typeof url !== "string" || !url || url.length > MAX_URL_CHARS) {
    throw reject(`${subject} URL must be a string of at most ${MAX_URL_CHARS} characters`);
  }
  if (hasUnsafeCharacters(url)) throw reject(`${subject} URL must not contain whitespace or control bytes`);
  let parts: SplitUrl;
  try {
    parts = urlsplit(url);
  } catch {
    throw reject(`${subject} URL is malformed`);
  }
  if (parts.scheme !== "https") {
    throw reject(`Only https:// ${noun} URLs are accepted; refused scheme ${JSON.stringify(parts.scheme || "none")}`);
  }
  if (parts.username || parts.password || parts.netloc.includes("@")) throw reject(`${subject} URLs must not embed credentials`);
  if (parts.fragment) throw reject(`${subject} URLs must not contain a fragment`);
  if (parts.portError) throw reject(`${subject} URL has an invalid port`);
  if (parts.port !== null && parts.port !== 443) throw reject(`${subject} URLs must use the default HTTPS port 443`);
  const hostname = parts.hostname;
  if (!hostname || hostname.length > 253) throw reject(`${subject} URL must name a host`);
  if (isIpLiteral(hostname)) {
    throw reject(
      `${subject} URLs must name a DNS host, not an IP literal; this browser cannot classify addresses itself`,
      403,
    );
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw reject(`${subject} URLs must not name a local host (${hostname})`, 403);
  }
  let target = parts.path || "/";
  if (parts.query) target += `?${parts.query}`;
  return { hostname, target };
}

/** `discovery.py::_origin`: (scheme, host, effective port) of an http(s) URL, or null. */
export function origin(url: string): Origin | null {
  let parts: SplitUrl;
  try {
    parts = urlsplit(url);
  } catch {
    return null;
  }
  if (parts.portError) return null;
  if ((parts.scheme !== "http" && parts.scheme !== "https") || !parts.hostname) return null;
  const fallback = parts.scheme === "https" ? 443 : 80;
  return [parts.scheme, parts.hostname, parts.port === null ? fallback : parts.port];
}

/** `discovery.py::origin_text`. */
export function originText(value: Origin): string {
  const [scheme, host, port] = value;
  const shown = host.includes(":") ? `[${host}]` : host;
  const fallback = scheme === "https" ? 443 : 80;
  return port === fallback ? `${scheme}://${shown}` : `${scheme}://${shown}:${port}`;
}

export function sameOrigin(a: Origin | null, b: Origin | null): boolean {
  return a !== null && b !== null && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** `discovery.py::_canonical`: lowercased host, default port dropped, no fragment. */
export function canonicalUrl(url: string): string {
  const where = origin(url);
  if (where === null) return url;
  const parts = urlsplit(url);
  const path = parts.path || "/";
  return originText(where) + path + (parts.query ? `?${parts.query}` : "");
}

/**
 * `discovery.py::_document_url`: the website URL to request. A fragment is dropped rather
 * than refused, since it is never sent; everything else is the package URL policy.
 */
export function documentUrl(url: unknown): string {
  if (typeof url !== "string" || !url || url.length > MAX_URL_CHARS) {
    throw reject(`Website URL must be a string of at most ${MAX_URL_CHARS} characters`);
  }
  const hash = url.indexOf("#");
  const document = hash >= 0 ? url.slice(0, hash) : url;
  const fragment = hash >= 0 ? url.slice(hash + 1) : "";
  validatePackageUrl(document, "Website");
  if (hasUnsafeCharacters(fragment)) throw reject("Website URL must not contain whitespace or control bytes");
  return canonicalUrl(document);
}

/** Whether an address bar entry should be opened as a package rather than read as a page. */
export function looksLikePackageUrl(url: string): boolean {
  try {
    const parts = urlsplit(url.split("#")[0]!);
    const last = parts.path.split("/").pop() ?? "";
    return last.toLowerCase().endsWith(".pkg");
  } catch {
    return false;
  }
}
