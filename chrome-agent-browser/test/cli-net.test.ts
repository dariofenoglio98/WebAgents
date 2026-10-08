/**
 * The Node transport (D-067): the address classes against the Python reference's verdicts,
 * the gate and the resolution refusals before any socket, and the request itself over a
 * local server (one request, the body streamed and stopped at the cap, a redirect returned
 * and never followed, the signal honoured, the probe bounded by its own deadline).
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addressRejection, catalogHttp, nodeTransport, resolveDestination, type Resolver } from "../src/cli-net.js";
import type { HttpRequest } from "../src/core/models/transport.js";
import { jsonHttpCall } from "../src/core/tools/adapters/json-http.js";
import type { ToolImplementationDefinition } from "../src/core/tools/definitions.js";
import { CancelledError } from "../src/core/workflow/errors.js";
import { PROJECT } from "./helpers/paths.js";

const VECTORS = JSON.parse(readFileSync(join(PROJECT, "test", "fixtures", "netaddr-vectors.json"), "utf8")) as { python: string; vectors: Array<{ address: string; reason: string | null }> };

describe("addressRejection is agentpkg.netaddr.public_address_reason", () => {
  it("covers every class the reference names", () => {
    const reasons = new Set(VECTORS.vectors.map((vector) => vector.reason));
    for (const reason of ["cloud_metadata_address", "unspecified_address", "loopback_address", "link_local_address", "multicast_address", "ipv4_mapped_address", "sixtofour_address", "teredo_address", "nat64_address", "reserved_address", "private_address", "non_global_address", "unparsable_address", null]) {
      expect(reasons.has(reason), String(reason)).toBe(true);
    }
  });
  for (const vector of VECTORS.vectors) {
    it(`${vector.address || "<empty>"} is ${vector.reason ?? "public"}`, () => {
      expect(addressRejection(vector.address)).toBe(vector.reason);
    });
  }
});

describe("resolveDestination", () => {
  const never: Resolver = async () => {
    throw new Error("the resolver must not be reached");
  };

  it("refuses, before resolving, every URL the core's gate refuses", async () => {
    const refused = ["https://localhost./x", "https://localhost/x", "https://localhost../x", "https://127.0.0.1/x", "https://[::1]/x", "https://2130706433/x", "https://0x7f.1/x", "http://service.example/x", "https://service.example:8443/x", "https://dev.local/x", "https://user:pw@service.example/x", "https://service.example/x#frag", "not a url"];
    for (const url of refused) {
      await expect(resolveDestination(url, { allowLoopbackHttp: false, resolve: never }), url).rejects.toMatchObject({ facts: { stage: "address_policy" } });
    }
  });

  it("refuses a name that resolves to any non-public address, naming the class", async () => {
    const cases: Array<[string, string]> = [["127.0.0.1", "loopback_address"], ["10.1.2.3", "private_address"], ["169.254.169.254", "cloud_metadata_address"], ["::ffff:10.0.0.1", "ipv4_mapped_address"], ["100.64.1.1", "non_global_address"], ["fe80::1", "link_local_address"]];
    for (const [address, reason] of cases) {
      await expect(resolveDestination("https://service.example/v1", { allowLoopbackHttp: false, resolve: async () => ["93.184.216.34", address] }), address).rejects.toMatchObject({ message: expect.stringContaining(reason), facts: { stage: "address_policy", reason } });
    }
    await expect(resolveDestination("https://service.example/v1", { allowLoopbackHttp: false, resolve: async () => [] })).rejects.toMatchObject({ facts: { stage: "transport" } });
  });

  it("pins a public name to its first address on 443 with the request target, keeping every classified address for fallback (T4 review 2, nit 1)", async () => {
    const destination = await resolveDestination("https://service.example/v1/call?x=1", { allowLoopbackHttp: false, resolve: async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] });
    expect(destination).toEqual({ hostname: "service.example", address: "93.184.216.34", addresses: ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"], port: 443, tls: true, path: "/v1/call?x=1", hostHeader: "service.example" });
  });

  it("the resolver is raced against the signal: a hanging lookup ends with the signal's reason (T4 review 2, nit 5)", async () => {
    const hanging: Resolver = () => new Promise(() => undefined);
    const controller = new AbortController();
    const transport = nodeTransport({ allowLoopbackHttp: false, resolve: hanging });
    const pending = transport({ url: "https://service.example/v1", method: "GET", headers: {}, body: null, signal: controller.signal, maxResponseBytes: 1024 });
    setTimeout(() => controller.abort(new CancelledError()), 30);
    const started = Date.now();
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("the loopback exception belongs to the model transport, for a name that resolves to this machine only", async () => {
    expect(await resolveDestination("http://127.0.0.1:11434/api/chat", { allowLoopbackHttp: true, resolve: never })).toEqual({ hostname: "127.0.0.1", address: "127.0.0.1", addresses: ["127.0.0.1"], port: 11434, tls: false, path: "/api/chat", hostHeader: "127.0.0.1:11434" });
    expect(await resolveDestination("http://localhost:11434/api/tags", { allowLoopbackHttp: true, resolve: async () => ["::1"] })).toMatchObject({ hostname: "localhost", address: "::1", tls: false });
    expect(await resolveDestination("http://[::1]:11434/api/tags", { allowLoopbackHttp: true, resolve: never })).toMatchObject({ address: "::1", port: 11434 });
    await expect(resolveDestination("http://localhost:11434/api/tags", { allowLoopbackHttp: true, resolve: async () => ["8.8.8.8"] })).rejects.toMatchObject({ facts: { stage: "address_policy", reason: "loopback_expected" } });
    await expect(resolveDestination("http://127.0.0.1:11434/api/chat", { allowLoopbackHttp: false, resolve: never })).rejects.toMatchObject({ facts: { stage: "address_policy" } });
    await expect(resolveDestination("http://10.0.0.5:11434/api/chat", { allowLoopbackHttp: true, resolve: never })).rejects.toMatchObject({ facts: { stage: "address_policy" } });
    // A public hosted provider goes through the gate and the classification like a tool does.
    expect(await resolveDestination("https://api.openai.com/v1/responses", { allowLoopbackHttp: true, resolve: async () => ["104.18.33.45"] })).toMatchObject({ tls: true, port: 443, path: "/v1/responses" });
  });
});

describe("the transport over a local server", () => {
  let server: Server;
  let base = "";
  const seen: string[] = [];

  beforeAll(async () => {
    server = createServer((incoming, outgoing) => {
      seen.push(`${incoming.method} ${incoming.url}`);
      let body = "";
      incoming.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      incoming.on("end", () => {
        if (incoming.url === "/echo") {
          outgoing.writeHead(200, { "Content-Type": "application/json", "X-Answered": "Yes" });
          outgoing.end(JSON.stringify({ got: JSON.parse(body || "null"), host: incoming.headers.host, agent: incoming.headers["user-agent"] ?? null, te: incoming.headers["transfer-encoding"] ?? null, cl: incoming.headers["content-length"] ?? null }));
        } else if (incoming.url === "/big") {
          outgoing.writeHead(200, { "content-type": "application/json" });
          const chunk = Buffer.alloc(64 * 1024, 0x61);
          let sent = 0;
          const push = () => {
            while (sent < 64) {
              sent += 1;
              if (!outgoing.write(chunk)) {
                outgoing.once("drain", push);
                return;
              }
            }
            outgoing.end();
          };
          push();
        } else if (incoming.url === "/declared") {
          outgoing.writeHead(200, { "content-type": "application/json", "content-length": "5000000" });
          outgoing.write("x");
        } else if (incoming.url === "/redirect") {
          outgoing.writeHead(302, { location: "https://elsewhere.example/" });
          outgoing.end("moved");
        } else if (incoming.url === "/hang") {
          // never answers
        } else if (incoming.url === "/reset") {
          // Reads the whole request (the side effect would have happened), then resets the connection.
          incoming.socket.destroy();
        } else {
          outgoing.writeHead(404, { "content-type": "application/json" });
          outgoing.end("{}");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const transport = nodeTransport({ allowLoopbackHttp: true });
  const request = (path: string, extra: Partial<HttpRequest> = {}): HttpRequest => ({ url: `${base}${path}`, method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: '{"a":1}', signal: new AbortController().signal, maxResponseBytes: 1024 * 1024, ...extra });

  it("performs one request with the host header and returns the body with lower-cased header names", async () => {
    const answer = await transport(request("/echo"));
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("application/json");
    expect(answer.headers["x-answered"]).toBe("Yes");
    // The body travels with a Content-Length, never chunked (T4 review 2, nit 2).
    expect(JSON.parse(answer.body)).toEqual({ got: { a: 1 }, host: new URL(base).host, agent: null, te: null, cl: "7" });
    expect(seen.filter((line) => line.endsWith("/echo"))).toHaveLength(1);
  });

  it("tries the next classified address when the first refuses the connection (T4 review 2, nit 1)", async () => {
    // The server listens on 127.0.0.1 only; a resolver that answers ::1 first makes the first dial fail.
    const port = (server.address() as AddressInfo).port;
    const fallback = nodeTransport({ allowLoopbackHttp: true, resolve: async () => ["::1", "127.0.0.1"] });
    const answer = await fallback(request("/echo", { url: `http://localhost:${port}/echo` }));
    expect(answer.status).toBe(200);
    // Every address refusing is the last failure, a transport stage.
    const refusing = nodeTransport({ allowLoopbackHttp: true, resolve: async () => ["::1", "::1"] });
    await expect(refusing(request("/echo", { url: `http://localhost:1/echo` }))).rejects.toMatchObject({ name: "TransportError", facts: { stage: "transport" } });
  });

  it("never sends a request twice: a reset after the body was written is the request's failure, not a reason to try the next address (T5 review 1, finding 4)", async () => {
    const before = seen.filter((line) => line.endsWith("/reset")).length;
    const port = (server.address() as AddressInfo).port;
    const twoAddresses = nodeTransport({ allowLoopbackHttp: true, resolve: async () => ["127.0.0.1", "127.0.0.1"] });
    await expect(twoAddresses(request("/reset", { url: `http://localhost:${port}/reset` }))).rejects.toMatchObject({ name: "TransportError", facts: { stage: "transport" } });
    expect(seen.filter((line) => line.endsWith("/reset")).length - before).toBe(1);
    // Whereas a refused connection (nothing listening on the first address) still moves on.
    const refusedThenOk = nodeTransport({ allowLoopbackHttp: true, resolve: async () => ["::1", "127.0.0.1"] });
    expect((await refusedThenOk(request("/echo", { url: `http://localhost:${port}/echo` }))).status).toBe(200);
  });

  it("stops a streamed body at the cap instead of buffering it, and refuses a declared length above the cap before reading", async () => {
    await expect(transport(request("/big", { maxResponseBytes: 100_000 }))).rejects.toMatchObject({ name: "TransportError", facts: { stage: "body_size", http_status: 200 } });
    await expect(transport(request("/declared", { maxResponseBytes: 100_000 }))).rejects.toMatchObject({ facts: { stage: "body_size", response_bytes: 5_000_000 } });
    expect(await transport(request("/big", { maxResponseBytes: 8 * 1024 * 1024 }))).toMatchObject({ status: 200 });
  });

  it("returns a redirect as its status with an empty body and never follows it", async () => {
    const answer = await transport(request("/redirect"));
    expect(answer).toMatchObject({ status: 302, body: "" });
    expect(answer.headers.location).toBe("https://elsewhere.example/");
    expect(seen.some((line) => line.includes("elsewhere"))).toBe(false);
  });

  it("rejects with the signal's reason when the signal aborts, before and during the request", async () => {
    const controller = new AbortController();
    const pending = transport(request("/hang", { signal: controller.signal }));
    setTimeout(() => controller.abort(new CancelledError()), 50);
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    const early = new AbortController();
    early.abort(new CancelledError());
    await expect(transport(request("/echo", { signal: early.signal }))).rejects.toBeInstanceOf(CancelledError);
  });

  it("a refused destination reaches the tool adapter with its stage, and a refused connection is a transport failure", async () => {
    const definition: ToolImplementationDefinition = { id: "demo:service:1", toolId: "service", binding: "service.call", kind: "json_http", implementationId: "openclaw.tool.json_http", implementationVersion: "0.1.0", displayName: "Service", origin: "https://service.example", path: "/v1/call", method: "POST", inputSchemaSha256: null, outputSchemaSha256: null, permissionKinds: ["network"], sideEffects: "read", timeoutSeconds: 10 };
    const toolTransport = nodeTransport({ allowLoopbackHttp: false, resolve: async () => ["127.0.0.1"] });
    await expect(jsonHttpCall({ definition, args: {}, transport: toolTransport, signal: new AbortController().signal })).rejects.toMatchObject({ code: "tool_transport_error", message: expect.stringContaining("loopback_address"), audit_facts: { stage: "address_policy" } });
    await expect(transport(request("/x", { url: "http://127.0.0.1:1/x" }))).rejects.toMatchObject({ name: "TransportError", facts: { stage: "transport" } });
  });

  it("the catalog probe parses JSON, sends the provider's credential header only, and runs under one deadline for the whole probe (T4 review 2, nit 4)", async () => {
    const http = catalogHttp({ openai: "sk-test", anthropic: null }, { timeoutMs: 300 });
    const answer = await http({ provider: "openai", method: "POST", url: `${base}/echo`, headers: {}, body: { probe: true } });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ got: { probe: true } });
    await expect(http({ provider: "ollama", method: "GET", url: `${base}/hang`, headers: {} })).rejects.toMatchObject({ name: "TimeoutError" });
    // The deadline is the probe's, not the request's: once spent, the next request of the same probe is refused at once.
    const started = Date.now();
    await expect(http({ provider: "ollama", method: "GET", url: `${base}/missing`, headers: {} })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(200);
    expect((await catalogHttp({ openai: null, anthropic: null })({ provider: "ollama", method: "GET", url: `${base}/missing`, headers: {} })).body).toEqual({});
  });
});
