"""Serving WebAir's agent package at the fixed path `/agent.pkg`.

The origin publishes at most one artifact: the file its operator configured at
startup. Its bytes are read once, there, so a request can never name, widen or
swap the file being served, and nothing under the origin's directories becomes
reachable through this route. With no configured package the route answers 404.

This milestone builds no package: the signed WebAir agent.pkg arrives later and
is published by starting the origin with `--agent-package <path>`.
"""

from __future__ import annotations

import hashlib
import stat
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

# Experimental WebAgents demo conventions, not web standards.
MEDIA_TYPE = "application/vnd.webagents.agent-package"
PACKAGE_PATH = "/agent.pkg"
DISCOVERY_REL = "agent-package"
MAX_PACKAGE_BYTES = 16 * 1024 * 1024


class AgentPackageConfigError(ValueError):
    """The configured package cannot be published; the origin refuses to start."""


@dataclass(frozen=True)
class PublishedPackage:
    data: bytes
    sha256: str

    @classmethod
    def load(cls, path: str | Path) -> PublishedPackage:
        target = Path(path)
        try:
            info = target.stat()
        except OSError as exc:
            raise AgentPackageConfigError(f"Agent package not found: {target}") from exc
        if not stat.S_ISREG(info.st_mode):
            raise AgentPackageConfigError(f"Agent package is not a regular file: {target}")
        if info.st_size == 0 or info.st_size > MAX_PACKAGE_BYTES:
            raise AgentPackageConfigError(
                f"Agent package must be 1..{MAX_PACKAGE_BYTES} bytes: {target}"
            )
        data = target.read_bytes()
        if len(data) != info.st_size:
            raise AgentPackageConfigError(f"Agent package changed while being read: {target}")
        return cls(data=data, sha256=hashlib.sha256(data).hexdigest())


def router(package: PublishedPackage | None) -> APIRouter:
    routes = APIRouter()

    @routes.api_route(PACKAGE_PATH, methods=["GET", "HEAD"], include_in_schema=False)
    def agent_package(request: Request) -> Response:
        if package is None:
            return JSONResponse(
                {
                    "error": {
                        "code": "agent_package_unavailable",
                        "message": "WebAir has not published an agent package yet. The "
                        'rel="agent-package" link is an experimental WebAgents demo '
                        "convention; the signed package arrives in a later milestone.",
                        "details": [],
                    }
                },
                status_code=404,
                headers={"Cache-Control": "no-store"},
            )
        headers = {
            "Content-Disposition": 'attachment; filename="webair.agent.pkg"',
            "Cache-Control": "no-cache",
            "ETag": f'"sha256:{package.sha256}"',
            "X-Agent-Package-SHA256": package.sha256,
        }
        body = b"" if request.method == "HEAD" else package.data
        response = Response(body, media_type=MEDIA_TYPE, headers=headers)
        response.headers["Content-Length"] = str(len(package.data))
        return response

    return routes
