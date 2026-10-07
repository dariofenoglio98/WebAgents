/**
 * The URL policy for package, website and tool addresses (D-026), mirroring the syntax gate
 * of `agentpkg/browser/fetch.py::validate_package_url` and the URL helpers of
 * `browser/discovery.py`.
 *
 * Syntax: HTTPS only, port 443, no credentials, no fragment, no whitespace, control bytes
 * or backslashes, at most 2048 characters, a host required. The Chrome line adds, at the
 * syntax stage, what the reference enforces at resolution: no IP literals, no `localhost`,
 * no `.localhost` or `.local` names.
 *
 * Two parsers read every URL (D-039). `urlsplit` gives the reference's verdicts, so both
 * runtimes refuse the same strings for the same stated reasons. The WHATWG `URL` parser
 * gives the host **Chrome will actually connect to**: it folds `127.1`, `2130706433`,
 * `0x7f.1`, `%31%32%37.0.0.1` and fullwidth digits into `127.0.0.1`, and reads a backslash
 * as a path separator. The IP-literal and local-name checks therefore run on that host as
 * well, one trailing dot is ignored before the name tests, and an ASCII host the two
 * parsers disagree about is refused outright. **Address classification does not happen
 * here.** The reference resolves every hostname and refuses private, loopback, link-local,
 * multicast, reserved and cloud-metadata destinations before connecting, and pins the
 * connection to the validated address; an extension has no resolver and no socket, so a
 * DNS name that resolves to such an address is Chrome's network stack's to refuse, and the
 * threat model says so.
 */
import { CoreError } from "./errors.js";
import { pyRepr } from "./repr.js";
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

/** The urlsplit view: a bracketed IPv6 literal (already unbracketed) or four decimal labels. */
function isIpLiteral(hostname: string): boolean {
  if (hostname.includes(":")) return true;
  const labels = hostname.split(".");
  return labels.length === 4 && labels.every((label) => /^[0-9]{1,3}$/u.test(label));
}

/** The WHATWG view: every IPv4 form it recognizes is serialized dotted-decimal; IPv6 stays bracketed. */
const DOTTED_DECIMAL = /^(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/u;

function isFetchedIpLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || DOTTED_DECIMAL.test(hostname);
}

/**
 * `localhost`, `.localhost`, `.local` and the `/etc/hosts` loopback aliases. Every trailing dot
 * is ignored before the test (T1 review 2, nit 11: `localhost..` is otherwise read as a name
 * ending in `localhost.`); an empty label anywhere else is refused by `validatePackageUrl`.
 */
function isLocalName(hostname: string): boolean {
  const name = hostname.replace(/\.+$/u, "");
  return (
    name === "localhost" ||
    name === "ip6-localhost" ||
    name === "ip6-loopback" ||
    name.endsWith(".localhost") ||
    name.endsWith(".local")
  );
}

function hasEmptyLabel(hostname: string): boolean {
  if (hostname.startsWith("[")) return false; // an IPv6 literal, refused separately
  const name = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  return name.split(".").includes("");
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
  if (url.includes("\\")) throw reject(`${subject} URL must not contain a backslash, which browsers read as a path separator`);
  let parts: SplitUrl;
  try {
    parts = urlsplit(url);
  } catch {
    throw reject(`${subject} URL is malformed`);
  }
  if (parts.scheme !== "https") {
    throw reject(`Only https:// ${noun} URLs are accepted; refused scheme ${pyRepr(parts.scheme || "none")}`);
  }
  if (parts.username || parts.password || parts.netloc.includes("@")) throw reject(`${subject} URLs must not embed credentials`);
  if (parts.fragment) throw reject(`${subject} URLs must not contain a fragment`);
  if (parts.portError) throw reject(`${subject} URL has an invalid port`);
  if (parts.port !== null && parts.port !== 443) throw reject(`${subject} URLs must use the default HTTPS port 443`);
  const hostname = parts.hostname;
  if (!hostname || hostname.length > 253) throw reject(`${subject} URL must name a host`);
  // The host Chrome will connect to (D-039). A string the WHATWG parser refuses is refused
  // here too: the browser could not fetch it, and the reference would have had to resolve
  // a name no browser agrees on.
  let fetched: URL;
  try {
    fetched = new URL(url);
  } catch {
    throw reject(`${subject} URL is malformed`);
  }
  const fetchedHost = fetched.hostname;
  if (fetched.protocol !== "https:" || fetched.username || fetched.password || (fetched.port !== "" && fetched.port !== "443")) {
    throw reject(`${subject} URL is read differently by this policy and by the browser; refused`);
  }
  if (isIpLiteral(hostname) || isFetchedIpLiteral(fetchedHost)) {
    throw reject(
      `${subject} URLs must name a DNS host, not an IP literal; this browser cannot classify addresses itself`,
      403,
    );
  }
  if (isLocalName(hostname) || isLocalName(fetchedHost)) {
    throw reject(`${subject} URLs must not name a local host (${hostname})`, 403);
  }
  // One trailing dot is a fully qualified name; any other empty label is not a DNS name.
  if (hasEmptyLabel(hostname) || hasEmptyLabel(fetchedHost)) {
    throw reject(`${subject} URL host ${pyRepr(hostname)} has an empty label`);
  }
  // An ASCII host both parsers read must be the same host; a disagreement means the policy
  // would judge one name and Chrome would connect to another. Non-ASCII names differ only
  // by IDNA encoding, which the reference's resolver performs too, and were IP-checked above.
  if (/^[\u0000-\u007f]*$/u.test(hostname) && fetchedHost !== hostname) {
    throw reject(`${subject} URL names host ${pyRepr(hostname)} but the browser would connect to ${pyRepr(fetchedHost)}; refused`);
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
