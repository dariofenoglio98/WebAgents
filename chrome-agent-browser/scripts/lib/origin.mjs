/**
 * A local HTTPS origin for the headless harnesses (D-105's files, byte for byte from the repository):
 * a throwaway certificate for one hostname, whose key alone Chrome is told to trust
 * (`--ignore-certificate-errors-spki-list`), and a server that answers exactly the files it is given.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";

export function certificate(directory, host) {
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", `/CN=${host}`, "-addext", `subjectAltName=DNS:${host}`], { stdio: ["ignore", "ignore", "ignore"] });
  const spki = execFileSync("openssl", ["pkey", "-pubin", "-outform", "der"], { input: execFileSync("openssl", ["x509", "-in", cert, "-pubkey", "-noout"]) });
  return { key: readFileSync(key), cert: readFileSync(cert), spkiHash: createHash("sha256").update(spki).digest("base64") };
}

/**
 * Serve `files` (`{ "/path": { path, type } }`, or `{ bytes, type }` for bytes held in memory) on
 * 127.0.0.1; every other path is a 404, unless `answer(method, path, body)` returns
 * `{ status, value }` for it (a JSON answer, T14).
 */
export function serveFiles(tls, files, answer = null) {
  const hits = [];
  const server = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
    hits.push(`${request.method} ${request.url}`);
    const file = files[request.url];
    if (!file && answer) {
      // Chunks joined as bytes first: a UTF-8 sequence split across two chunks stays whole (T14 review 1, nit 8).
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const answered = answer(request.method, request.url, Buffer.concat(chunks).toString("utf8"));
        const text = answered ? JSON.stringify(answered.value) : "not found";
        response.writeHead(answered ? answered.status : 404, { "content-type": answered ? "application/json" : "text/plain", "content-length": String(Buffer.byteLength(text)), "cache-control": "no-cache", "x-content-type-options": "nosniff" });
        response.end(text);
      });
      return undefined;
    }
    if (!file) {
      response.writeHead(404, { "content-type": "text/plain" });
      return response.end("not found");
    }
    // A file on disk is streamed (a model file can exceed Node's one-Buffer limit of 2 GiB; T40); bytes in memory are sent as before.
    if (file.bytes === undefined) {
      // A vanished or unreadable file is a 500 for that request, never a crash of the shared harness (T40 review 1, nit 12).
      let size;
      try {
        size = statSync(file.path).size;
      } catch {
        response.writeHead(500, { "content-type": "text/plain" });
        return response.end("file unavailable");
      }
      // One `bytes=<start>-[<end>]` range is answered 206 (T41: the model downloader resumes with it);
      // anything else is the whole file.
      const range = /^bytes=(\d+)-(\d*)$/u.exec(String(request.headers.range ?? ""));
      const start = range ? Number(range[1]) : 0;
      const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (range && (start >= size || start > end)) {
        response.writeHead(416, { "content-range": `bytes */${size}` });
        return response.end();
      }
      const stream = createReadStream(file.path, { start, end });
      stream.on("error", () => {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "text/plain" });
          response.end("file unavailable");
        } else response.destroy();
      });
      // A client that goes away (a cancelled download, Chrome closing) releases the file at once (T40 review 2).
      response.on("close", () => stream.destroy());
      stream.once("open", () => {
        const headers = { "content-type": file.type, "content-length": String(end - start + 1), "cache-control": "no-cache", "x-content-type-options": "nosniff", "accept-ranges": "bytes" };
        if (range) response.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}` });
        else response.writeHead(200, headers);
        stream.pipe(response);
      });
      return undefined;
    }
    response.writeHead(200, { "content-type": file.type, "content-length": String(file.bytes.length), "cache-control": "no-cache", "x-content-type-options": "nosniff" });
    return response.end(file.bytes);
  });
  return new Promise((resolveServer) => server.listen(0, "127.0.0.1", () => resolveServer({ server, port: server.address().port, hits })));
}
