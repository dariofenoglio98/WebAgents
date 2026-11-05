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
# Review 0.2.6, which index 1.1.0 named (T11, D-131), 0.2.7, which index 1.2.0 named (T15, D-174),
# 0.2.8, which index 1.3.0 named (T20, D-232), and 0.2.9, which indexes 1.4.0 (T22), 1.5.0 (T24) and
# 1.6.0 (T26) name; and the travel network, which index 1.6.0 adds (T26, D-290).
INDEXED_PACKAGES = {
    "/packages/literature-review-0.2.6.agent.pkg": (
        Path(__file__).parent / "packages" / "literature-review-0.2.6.agent.pkg",
        "685dcc97232d278eb2a5b777dcbc621573de5c48818a95d522e647c9267ee8f1",
    ),
    "/packages/literature-review-0.2.7.agent.pkg": (
        Path(__file__).parent / "packages" / "literature-review-0.2.7.agent.pkg",
        "8951a14bb1f42bca1590bc7d0c9cc00cccba75b36f1488969b6b3ff47063fe61",
    ),
    "/packages/literature-review-0.2.8.agent.pkg": (
        Path(__file__).parent / "packages" / "literature-review-0.2.8.agent.pkg",
        "0d03d1c8b366aabd6343b15958185c10cdab6639828f9c73bafbb26538db8330",
    ),
    "/packages/literature-review-0.2.9.agent.pkg": (
        Path(__file__).parent / "packages" / "literature-review-0.2.9.agent.pkg",
        "00f33aea8504669080031b22c4a2903fb01812ba9f93f6deaf68fcde13891f3f",
    ),
    # The travel network (network.v0, T26), which index 1.6.0 names.
    "/packages/travel-network-0.1.0.agent.pkg": (
        Path(__file__).parent / "packages" / "travel-network-0.1.0.agent.pkg",
        "4acd67cf414f52542a855bc399e1dbc8912307c608236b866c3ce317ecf7b9ca",
    ),
}

# The signed WebAgents demo documents (T8): fixed paths, pinned bytes, read once at startup.
# Their signatures are the documents' own; this server only refuses bytes it was not built with.
DOCUMENTS = {
    "/agent-index.json": (
        Path(__file__).parent / "documents" / "agent-index.json",
        "be7dc571b44451265064d3af3c7de09be0730c50c5c82c46dd0f807d5caef9e3",
    ),
    "/policies/webagents-research.json": (
        Path(__file__).parent / "documents" / "policies" / "webagents-research.json",
        "aa36d133aeb71eb6a77306822396f57ea34efa76a9e1636904365f04c35dca75",
    ),
    # T41: the signed curated in-browser model list (examples/model-catalog.json, version 1.0.0).
    "/model-catalog.json": (
        Path(__file__).parent / "documents" / "model-catalog.json",
        "fd67ab974cf4728a02be1176afffc72ca0b1cbe256f7593b03b014187ab65624",
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
