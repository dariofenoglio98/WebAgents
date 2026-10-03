/**
 * Backend-only HTTP client for agentpkgd.
 *
 * The bearer token lives here and in the supervisor that read it. It is never
 * returned from a feature operation, never logged, and never reaches the
 * browser bundle: the Control UI can only call typed feature operations, which
 * run in this process.
 *
 * This uses `node:http` rather than global `fetch` on purpose. Node's fetch
 * sends `sec-fetch-mode: cors`, and the control plane refuses any request
 * carrying browser fetch-metadata headers — that rule is its DNS-rebinding
 * defense against a page that discovers the loopback port. Sending an explicit,
 * minimal header set keeps that defense intact instead of relaxing it for a
 * trusted caller.
 */
import { request as httpRequest } from "node:http";
import { AgentBrowserError, clip, fromControlPlane, serviceUnavailable } from "./errors.js";

export type ControlPlaneEndpoint = {
  /** Loopback origin, for example http://127.0.0.1:53124 */
  readonly url: string;
  readonly token: string;
};

export type TransportResponse = { status: number; body: string };
export type ControlPlaneTransport = (
  endpoint: ControlPlaneEndpoint,
  path: string,
  options: { method: string; body?: string; timeoutMs: number },
) => Promise<TransportResponse>;

const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const LEASE_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;

/**
 * Path segments are passed through verbatim after a shape check.
 *
 * The control plane matches raw path segments and does not percent-decode them,
 * so encoding a fingerprint's colon would turn a valid id into a 404. Both id
 * shapes are already constrained by the feature contract and re-validated by
 * the control plane; this check keeps anything else out of a request line.
 */
function segment(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) {
    throw new AgentBrowserError(
      "invalid_request",
      "Malformed identifier",
      `The ${label} is not in the expected form.`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The default loopback transport: explicit headers, bounded body, no redirects. */
export const nodeTransport: ControlPlaneTransport = (endpoint, path, options) =>
  new Promise<TransportResponse>((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(endpoint.url);
    } catch {
      reject(serviceUnavailable("The control-plane address is invalid."));
      return;
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${endpoint.token}`,
      accept: "application/json",
      connection: "close",
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(options.body));
    }
    const request = httpRequest(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path,
        method: options.method,
        headers,
        // A fresh, unpooled connection per request. The control plane answers
        // `Connection: close`, and Node's keep-alive agent would otherwise hand
        // the next request a socket the server has already closed.
        agent: false,
        setHost: true,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.destroy();
          reject(serviceUnavailable("The control plane returned an unexpected redirect."));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy();
            reject(serviceUnavailable("The control plane returned an oversized response."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", () =>
          reject(serviceUnavailable("The control-plane response failed mid-transfer.")),
        );
      },
    );
    request.setTimeout(options.timeoutMs, () => {
      request.destroy();
      reject(serviceUnavailable("The control-plane request timed out."));
    });
    request.on("error", (cause: Error) =>
      reject(
        serviceUnavailable(
          `The Agent Browser control plane is not reachable (${(cause as NodeJS.ErrnoException).code ?? cause.message}).`,
        ),
      ),
    );
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });

export type RequestOptions = {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
};

/** One request to the control plane, with bounded time and response size. */
export async function controlPlaneRequest(
  endpoint: ControlPlaneEndpoint,
  path: string,
  options: RequestOptions = {},
  transport: ControlPlaneTransport = nodeTransport,
): Promise<unknown> {
  const response = await transport(endpoint, path, {
    method: options.method ?? "GET",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  let payload: unknown = null;
  if (response.body.length > 0) {
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw serviceUnavailable("The control plane returned a malformed response.");
    }
  }
  if (response.status >= 200 && response.status < 300) return payload;

  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === "string") {
    throw fromControlPlane(
      payload.error.code,
      typeof payload.error.message === "string"
        ? clip(payload.error.message, 4096)
        : "The control plane refused this request.",
      isRecord(payload.error.details) ? payload.error.details : undefined,
    );
  }
  throw new AgentBrowserError(
    "control_plane_error",
    "Request failed",
    `The control plane returned HTTP ${response.status}.`,
    response.status >= 500,
  );
}

/** Typed helpers used by the feature handlers. */
export class ControlPlaneClient {
  constructor(
    private readonly endpoint: ControlPlaneEndpoint,
    private readonly transport: ControlPlaneTransport = nodeTransport,
  ) {}

  private request(path: string, options?: RequestOptions): Promise<unknown> {
    return controlPlaneRequest(this.endpoint, path, options, this.transport);
  }

  health(timeoutMs = 5_000): Promise<unknown> {
    return this.request("/v0/health", { timeoutMs });
  }

  status(): Promise<unknown> {
    return this.request("/v0/status");
  }

  listSessions(): Promise<unknown> {
    return this.request("/v0/packages");
  }

  openUrl(url: string, timeoutMs = 120_000): Promise<unknown> {
    return this.request("/v0/packages/open-url", { method: "POST", body: { url }, timeoutMs });
  }

  /** Read one web page for advertised agent packages. Opens nothing. */
  discoverWebsite(url: string, timeoutMs = 60_000): Promise<unknown> {
    return this.request("/v0/websites/discover", { method: "POST", body: { url }, timeoutMs });
  }

  openFile(path: string, timeoutMs = 60_000): Promise<unknown> {
    return this.request("/v0/packages/open-file", { method: "POST", body: { path }, timeoutMs });
  }

  getPackage(sessionId: string): Promise<unknown> {
    return this.request(`/v0/packages/${segment(sessionId, SESSION_ID, "session id")}`);
  }

  getPermissions(sessionId: string): Promise<unknown> {
    return this.request(`/v0/packages/${segment(sessionId, SESSION_ID, "session id")}/permissions`);
  }

  getAuthorization(sessionId: string): Promise<unknown> {
    return this.request(`/v0/packages/${segment(sessionId, SESSION_ID, "session id")}/authorization`);
  }

  authorize(
    sessionId: string,
    packageDigest: string,
    decisions: Record<string, string>,
    toolApprovals: Record<string, boolean>,
  ): Promise<unknown> {
    return this.request(`/v0/packages/${segment(sessionId, SESSION_ID, "session id")}/authorize`, {
      method: "POST",
      body: { package_digest: packageDigest, decisions, tool_approvals: toolApprovals },
    });
  }

  /** Evaluate a host-supplied model catalog against one open package. */
  evaluateModels(sessionId: string, packageDigest: string, catalog: unknown): Promise<unknown> {
    return this.request(
      `/v0/packages/${segment(sessionId, SESSION_ID, "session id")}/models/evaluate`,
      { method: "POST", body: { package_digest: packageDigest, catalog } },
    );
  }

  /** Check one proposed task against the package's own input schema. Read-only. */
  validateInput(sessionId: string, input: unknown): Promise<unknown> {
    return this.request(
      `/v0/packages/${segment(sessionId, SESSION_ID, "session id")}/input/validate`,
      { method: "POST", body: { input } },
    );
  }

  modelRequirements(sessionId: string): Promise<unknown> {
    return this.request(`/v0/packages/${segment(sessionId, SESSION_ID, "session id")}/models`);
  }

  /** What this package asks a host to implement, host-neutrally. */
  toolRequirements(sessionId: string): Promise<unknown> {
    return this.request(`/v0/packages/${segment(sessionId, SESSION_ID, "session id")}/tools`);
  }

  /** Evaluate a host-supplied tool registry against one open package. */
  evaluateTools(sessionId: string, packageDigest: string, registry: unknown): Promise<unknown> {
    return this.request(
      `/v0/packages/${segment(sessionId, SESSION_ID, "session id")}/tools/evaluate`,
      { method: "POST", body: { package_digest: packageDigest, tool_registry: registry } },
    );
  }

  prepareRunPlan(
    sessionId: string,
    body: {
      packageDigest: string;
      receiptId: string;
      modelId?: string;
      executionMode: string;
      catalog: unknown;
      toolRegistry?: unknown;
      probeToolId?: string;
    },
  ): Promise<unknown> {
    return this.request(`/v0/packages/${segment(sessionId, SESSION_ID, "session id")}/run-plan`, {
      method: "POST",
      body: {
        package_digest: body.packageDigest,
        receipt_id: body.receiptId,
        ...(body.modelId === undefined ? {} : { model_id: body.modelId }),
        execution_mode: body.executionMode,
        binding_strategy: "single_model",
        catalog: body.catalog,
        ...(body.toolRegistry === undefined ? {} : { tool_registry: body.toolRegistry }),
        ...(body.probeToolId === undefined ? {} : { probe_tool_id: body.probeToolId }),
      },
    });
  }

  getRunPlan(sessionId: string): Promise<unknown> {
    return this.request(`/v0/packages/${segment(sessionId, SESSION_ID, "session id")}/run-plan`);
  }

  clearRunPlan(sessionId: string): Promise<unknown> {
    return this.request(`/v0/packages/${segment(sessionId, SESSION_ID, "session id")}/run-plan`, {
      method: "DELETE",
    });
  }

  /**
   * Ask for one private, one-time copy of this session's immutable snapshot.
   *
   * The response carries a local path, which is exactly why it stops in this
   * process: the backend turns it into an inherited descriptor and never
   * projects it into a feature result.
   */
  issueExecutionLease(
    sessionId: string,
    packageDigest: string,
    runPlanId: string,
    runPlanSha256: string,
  ): Promise<unknown> {
    return this.request(
      `/v0/packages/${segment(sessionId, SESSION_ID, "session id")}/execution-lease`,
      {
        method: "POST",
        body: {
          package_digest: packageDigest,
          run_plan_id: runPlanId,
          run_plan_sha256: runPlanSha256,
        },
      },
    );
  }

  releaseExecutionLease(sessionId: string, leaseId: string): Promise<unknown> {
    return this.request(
      `/v0/packages/${segment(sessionId, SESSION_ID, "session id")}/execution-lease/` +
        segment(leaseId, LEASE_ID, "lease id"),
      { method: "DELETE" },
    );
  }

  closeSession(sessionId: string): Promise<unknown> {
    return this.request(`/v0/packages/${segment(sessionId, SESSION_ID, "session id")}`, {
      method: "DELETE",
    });
  }

  listTrust(): Promise<unknown> {
    return this.request("/v0/trust");
  }

  pinSessionPublisher(
    sessionId: string,
    signerFingerprint: string,
    scope: string,
  ): Promise<unknown> {
    return this.request(
      `/v0/packages/${segment(sessionId, SESSION_ID, "session id")}/trust-publisher`,
      {
        method: "POST",
        body: { signer_fingerprint: signerFingerprint, scope },
      },
    );
  }

  removeTrust(fingerprint: string): Promise<unknown> {
    return this.request(`/v0/trust/${segment(fingerprint, FINGERPRINT, "fingerprint")}`, {
      method: "DELETE",
    });
  }
}
