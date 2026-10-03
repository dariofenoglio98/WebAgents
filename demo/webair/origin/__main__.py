"""Start the WebAir demo origin: `python -m origin` from demo/webair."""

from __future__ import annotations

import argparse
import os
import sys

import uvicorn

from .agent_package import AgentPackageConfigError
from .app import create_app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m origin", description="WebAir: a fictional airline demo origin."
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8040)
    parser.add_argument(
        "--agent-package",
        default=os.environ.get("WEBAIR_AGENT_PACKAGE") or None,
        metavar="PATH",
        help="the one file to publish at /agent.pkg (default: $WEBAIR_AGENT_PACKAGE; "
        "unset means /agent.pkg answers 404)",
    )
    args = parser.parse_args(argv)
    try:
        app = create_app(args.agent_package)
    except AgentPackageConfigError as exc:
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
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        server_header=False,
        proxy_headers=False,
        log_level="info",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
