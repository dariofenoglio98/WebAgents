/**
 * The HTTP seam every network adapter uses (D-024). The core never calls `fetch`: the shell
 * (Chrome) and the CLI (Node) inject an `HttpTransport`, so the same adapter code runs in both
 * and a test can replace the network with a table of answers. A transport performs exactly
 * one request: no redirects, no retries, no cookies, no ambient credential; it rejects with
 * `signal.reason` when the signal aborts and caps the response at `maxResponseBytes`.
 */

export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body: string | null;
  signal: AbortSignal;
  maxResponseBytes: number;
}

export interface HttpResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: string;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

/**
 * Why a transport refused or could not finish a request: a stage from the closed facts
 * vocabulary and, for a stopped body, the counts. A deadline is not a transport stage: an
 * aborted signal rejects with the signal's own reason, and the caller that set the deadline
 * classifies it (T4 review 2, nit 10).
 */
export interface TransportFacts {
  stage: "transport" | "tls" | "address_policy" | "body_size";
  http_status?: number;
  response_bytes?: number;
  reason?: string;
}

/**
 * What a transport throws for its own refusals (a destination the address policy refuses, a
 * body that passed the cap, a connection or TLS failure). Each adapter maps it to its own code
 * and keeps the facts; the message carries the class name, never a service string.
 */
export class TransportError extends Error {
  override readonly name: string = "TransportError";

  constructor(
    message: string,
    readonly facts: TransportFacts,
  ) {
    super(message);
  }
}

/**
 * A privacy observer sees every outbound model request body before it leaves (D-028): in tests
 * and in the live harness it is how "no sealed value in any model request" is asserted. It
 * cannot change the request.
 */
export interface OutboundModelRequest {
  provider_id: string;
  model_id: string;
  url: string;
  body: string;
}

export type ModelRequestObserver = (request: OutboundModelRequest) => void;
