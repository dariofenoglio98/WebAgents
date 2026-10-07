/**
 * `urllib.parse.urlsplit` as CPython 3.13 implements it, for the checks the reference makes
 * with it: tool endpoints (`validation.py`), package and website URLs (`browser/fetch.py`),
 * and advertised candidates (`browser/discovery.py`).
 *
 * The WHATWG `URL` parser is deliberately not used for these verdicts. It agrees with
 * `urlsplit` on well-formed URLs and disagrees on malformed ones (a backslash, an odd port,
 * an empty host), and a package's declared endpoint must receive the same verdict in both
 * runtimes. `URL` is used only where the reference uses `urljoin`, to resolve an href that
 * has already passed the profile's ASCII and whitespace rules against its page.
 */

const SCHEME_CHARS = /^[A-Za-z0-9+.-]*$/u;

export interface SplitUrl {
  readonly scheme: string;
  readonly netloc: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  readonly username: string | null;
  readonly password: string | null;
  /** Lowercased, or null when absent. */
  readonly hostname: string | null;
  /** The port, null when absent; `portError` is set when it is not a valid port. */
  readonly port: number | null;
  readonly portError: boolean;
}

export class UrlSplitError extends Error {
  override readonly name = "UrlSplitError";
}

/** `urlsplit(url)`. Throws `UrlSplitError` where CPython raises `ValueError`. */
export function urlsplit(input: string): SplitUrl {
  // WHATWG C0 control or space stripped from the left, tab/CR/LF removed everywhere.
  let url = input.replace(/^[\u0000- ]+/u, "").replace(/[\t\r\n]/gu, "");
  let scheme = "";
  const colon = url.indexOf(":");
  if (colon > 0 && /^[A-Za-z]$/u.test(url[0]!) && SCHEME_CHARS.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  let netloc = "";
  if (url.startsWith("//")) {
    let end = url.length;
    for (const delimiter of "/?#") {
      const position = url.indexOf(delimiter, 2);
      if (position >= 0 && position < end) end = position;
    }
    netloc = url.slice(2, end);
    url = url.slice(end);
    const open = netloc.includes("[");
    const close = netloc.includes("]");
    if (open !== close) throw new UrlSplitError("Invalid IPv6 URL");
    if (open && close) {
      const bracketed = netloc.slice(netloc.indexOf("[") + 1, netloc.indexOf("]"));
      if (!/^(?:v[0-9A-Fa-f]+\.[A-Za-z0-9._~!$&'()*+,;=:-]+|[0-9A-Fa-f:.]+(?:%[A-Za-z0-9._~-]+)?)$/u.test(bracketed) || !bracketed.includes(":")) {
        throw new UrlSplitError("invalid bracketed host");
      }
    }
  }
  let fragment = "";
  const hash = url.indexOf("#");
  if (hash >= 0) {
    fragment = url.slice(hash + 1);
    url = url.slice(0, hash);
  }
  let query = "";
  const question = url.indexOf("?");
  if (question >= 0) {
    query = url.slice(question + 1);
    url = url.slice(0, question);
  }
  // `_checknetloc`: non-ASCII netlocs that NFKC-normalize into delimiters are refused.
  if (/[^\u0000-\u007f]/u.test(netloc)) {
    const normalized = netloc.normalize("NFKC");
    if (normalized !== netloc) {
      for (const character of "/?#@:") {
        if (normalized.includes(character) && !netloc.includes(character)) {
          throw new UrlSplitError("netloc contains invalid characters under NFKC normalization");
        }
      }
    }
  }
  const at = netloc.lastIndexOf("@");
  let username: string | null = null;
  let password: string | null = null;
  if (at >= 0) {
    const userinfo = netloc.slice(0, at);
    const separator = userinfo.indexOf(":");
    username = separator >= 0 ? userinfo.slice(0, separator) : userinfo;
    password = separator >= 0 ? userinfo.slice(separator + 1) : null;
  }
  const hostinfo = netloc.slice(at + 1);
  let hostname: string;
  let portText: string;
  const bracket = hostinfo.indexOf("[");
  if (bracket >= 0) {
    const closing = hostinfo.indexOf("]", bracket);
    hostname = hostinfo.slice(bracket + 1, closing < 0 ? hostinfo.length : closing);
    const rest = closing < 0 ? "" : hostinfo.slice(closing + 1);
    portText = rest.startsWith(":") ? rest.slice(1) : "";
  } else {
    const separator = hostinfo.indexOf(":");
    hostname = separator >= 0 ? hostinfo.slice(0, separator) : hostinfo;
    portText = separator >= 0 ? hostinfo.slice(separator + 1) : "";
  }
  let port: number | null = null;
  let portError = false;
  if (portText !== "") {
    if (/^[0-9]+$/u.test(portText) && Number(portText) <= 65535) port = Number(portText);
    else portError = true;
  }
  return {
    scheme,
    netloc,
    path: url,
    query,
    fragment,
    username,
    password,
    hostname: hostname === "" ? null : hostname.toLowerCase(),
    port,
    portError,
  };
}

/** `urllib.parse.unquote` for the ASCII-only inputs this core accepts. */
export function unquote(text: string): string {
  return text.replace(/%[0-9A-Fa-f]{2}/gu, (match) => String.fromCharCode(Number.parseInt(match.slice(1), 16)));
}
