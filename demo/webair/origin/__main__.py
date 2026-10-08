"""Start the WebAir demo origin: `python -m origin` from demo/webair."""

from __future__ import annotations

import argparse
import os
import sys

import uvicorn

from .agent_package import AgentPackageConfigError
from .app import create_app
from .demo_documents import DemoDocumentsConfigError


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m origin", description="WebAir: a fictional airline demo origin."
    )
    parser.add_argument("--host", default="127.0.0.1")
    # A hosting platform assigns the listening port through $PORT (Railway does).
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8040")))
    parser.add_argument(
        "--agent-package",
        default=os.environ.get("WEBAIR_AGENT_PACKAGE") or None,
        metavar="PATH",
        help="the one file to publish at /agent.pkg (default: $WEBAIR_AGENT_PACKAGE; "
        "unset means /agent.pkg answers 404)",
    )
    parser.add_argument(
        "--demo-documents",
        default=os.environ.get("WEBAIR_DEMO_DOCUMENTS") or None,
        metavar="DIR",
        help="the directory holding the WebAgents demo index, policy and Literature Review "
        "package to serve beside the airline (default: $WEBAIR_DEMO_DOCUMENTS; unset means "
        "those paths answer 404)",
    )
    args = parser.parse_args(argv)
    try:
        app = create_app(args.agent_package, args.demo_documents)
    except (AgentPackageConfigError, DemoDocumentsConfigError) as exc:
        print(f"webair: {exc}", file=sys.stderr)
        return 2
    package = app.state.agent_package
    print("WebAir demo origin - fictional airline, no real booking or payment.", flush=True)
    print(f"  site:        http://{args.host}:{args.port}/", flush=True)
    print(
        "  agent.pkg:   "
        + (f"published, sha256 {package.sha256}" if package else "not published (404)"),
        flush=True,
    )
    documents = app.state.demo_documents
    print(
        "  demo docs:   "
        + (f"published, {len(documents.documents)} files" if documents else "not published (404)"),
        flush=True,
    )
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        server_header=False,
        proxy_headers=False,
        log_level="info",
        # One small process: past this many connections at once it answers 503 instead of
        # growing, and an idle connection is not held open.
        limit_concurrency=64,
        timeout_keep_alive=5,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
