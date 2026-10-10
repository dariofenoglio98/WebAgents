import hashlib
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


PACKAGE = Path(__file__).parent / "packages" / "literature-review-0.2.5.agent.pkg"

EXPECTED_SHA256 = (
    "1669f83fafac3434748fc19d38a8d3d2c3352da83cf1cbb84796ce313bd4f571"
)

VERSIONED_PATH = "/literature-review-0.2.5.agent.pkg"
LATEST_PATH = "/literature-review.agent.pkg"
# The path the WebAgents demo index 1.0.0 named for this package (T8), as the WebAir deployment serves it.
INDEXED_PATH = "/packages/literature-review-0.2.5.agent.pkg"

# The packages a demo index names at the WebAir deployment's paths, pinned by SHA-256: Literature
# Review 0.2.6, which index 1.1.0 named (T11, D-131), and 0.2.7, which index 1.2.0 names (T15, D-174).
INDEXED_PACKAGES = {
    "/packages/literature-review-0.2.6.agent.pkg": (
        Path(__file__).parent / "packages" / "literature-review-0.2.6.agent.pkg",
        "685dcc97232d278eb2a5b777dcbc621573de5c48818a95d522e647c9267ee8f1",
    ),
    "/packages/literature-review-0.2.7.agent.pkg": (
        Path(__file__).parent / "packages" / "literature-review-0.2.7.agent.pkg",
        "598d83594f128b77c11b0759468cc0eb749ba65ddcb9bec0a52d2a926799752d",
    ),
}

# The signed WebAgents demo documents (T8): fixed paths, pinned bytes, read once at startup.
# Their signatures are the documents' own; this server only refuses bytes it was not built with.
DOCUMENTS = {
    "/agent-index.json": (
        Path(__file__).parent / "documents" / "agent-index.json",
        "116920ec713309503e90000689a952e3034382d93fafe7db3cd97804e2a71e5b",
    ),
    "/policies/webagents-research.json": (
        Path(__file__).parent / "documents" / "policies" / "webagents-research.json",
        "aa36d133aeb71eb6a77306822396f57ea34efa76a9e1636904365f04c35dca75",
    ),
}


def load_documents():
    loaded = {}
    for path, (source, expected) in DOCUMENTS.items():
        data = source.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != expected:
            raise RuntimeError(f"{source.name} SHA-256 mismatch: expected {expected}, got {digest}")
        loaded[path] = (data, digest)
    return loaded


def verify_package(package=None, expected=None):
    package = PACKAGE if package is None else package
    expected = EXPECTED_SHA256 if expected is None else expected
    digest = hashlib.sha256(package.read_bytes()).hexdigest()

    if digest != expected:
        raise RuntimeError(
            f"Package SHA-256 mismatch: expected {expected}, got {digest}"
        )

    return digest


PACKAGE_SHA256 = verify_package()
INDEXED_SHA256 = {
    path: verify_package(source, expected) for path, (source, expected) in INDEXED_PACKAGES.items()
}
LOADED_DOCUMENTS = load_documents()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            body = b'{"status":"ok"}\n'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path in LOADED_DOCUMENTS:
            data, digest = LOADED_DOCUMENTS[self.path]
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Content-SHA256", digest)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
            return

        if self.path in INDEXED_PACKAGES:
            data = INDEXED_PACKAGES[self.path][0].read_bytes()

            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Agent-Package-SHA256", INDEXED_SHA256[self.path])
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            self.end_headers()
            self.wfile.write(data)
            return

        if self.path in (VERSIONED_PATH, LATEST_PATH, INDEXED_PATH):
            data = PACKAGE.read_bytes()

            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Agent-Package-SHA256", PACKAGE_SHA256)

            if self.path in (VERSIONED_PATH, INDEXED_PATH):
                self.send_header(
                    "Cache-Control",
                    "public, max-age=31536000, immutable",
                )
            else:
                self.send_header("Cache-Control", "no-cache")

            self.end_headers()
            self.wfile.write(data)
            return

        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        if self.path in LOADED_DOCUMENTS:
            data, digest = LOADED_DOCUMENTS[self.path]
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Content-SHA256", digest)
            self.end_headers()
            return

        if self.path in INDEXED_PACKAGES:
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(INDEXED_PACKAGES[self.path][0].stat().st_size))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Agent-Package-SHA256", INDEXED_SHA256[self.path])
            self.end_headers()
            return

        if self.path in (VERSIONED_PATH, LATEST_PATH, INDEXED_PATH):
            size = PACKAGE.stat().st_size

            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(size))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Agent-Package-SHA256", PACKAGE_SHA256)
            self.end_headers()
            return

        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            return

        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        print(
            "%s - - [%s] %s"
            % (self.address_string(), self.log_date_time_string(), format % args)
        )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))

    print(f"Package SHA-256: {PACKAGE_SHA256}")
    print(f"Listening on 0.0.0.0:{port}")

    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.serve_forever()
