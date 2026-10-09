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

# The package the demo index 1.1.0 names (T11, D-131), at the same path as the WebAir deployment serves it.
CURRENT_PACKAGE = Path(__file__).parent / "packages" / "literature-review-0.2.6.agent.pkg"
CURRENT_EXPECTED_SHA256 = (
    "685dcc97232d278eb2a5b777dcbc621573de5c48818a95d522e647c9267ee8f1"
)
CURRENT_INDEXED_PATH = "/packages/literature-review-0.2.6.agent.pkg"

# The signed WebAgents demo documents (T8): fixed paths, pinned bytes, read once at startup.
# Their signatures are the documents' own; this server only refuses bytes it was not built with.
DOCUMENTS = {
    "/agent-index.json": (
        Path(__file__).parent / "documents" / "agent-index.json",
        "79d4492cda8bb1d6252358aad1c5efbb2cb0f0dad521ac268b68aa37cc711898",
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
CURRENT_PACKAGE_SHA256 = verify_package(CURRENT_PACKAGE, CURRENT_EXPECTED_SHA256)
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

        if self.path == CURRENT_INDEXED_PATH:
            data = CURRENT_PACKAGE.read_bytes()

            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Agent-Package-SHA256", CURRENT_PACKAGE_SHA256)
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

        if self.path == CURRENT_INDEXED_PATH:
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(CURRENT_PACKAGE.stat().st_size))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Agent-Package-SHA256", CURRENT_PACKAGE_SHA256)
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
