"""Serving the WebAgents demo documents beside the airline (T8): an index, a policy, a package.

The WebAgents Chrome browser searches a signed agent index and lets a person subscribe to a
signed policy. Neither belongs to the fictional airline; they are served from this origin only
because it is the demo deployment that exists (a new hosting project is not available on the
free plan). The origin publishes them the way it publishes its own package: the operator names a
directory at startup, exactly three files are read from it once, there, and each is served at
one fixed path. A request can never name, widen or swap a file, and nothing else in that
directory becomes reachable. Without a directory the three paths answer 404.

    /agent-index.json                              the signed WebAgents demo index
    /policies/webagents-research.json              the signed example research policy
    /packages/literature-review-0.2.5.agent.pkg    the signed package the index lists

The signatures are the documents' own (Ed25519 under development keys); this module only
serves bytes and checks nothing about them.
"""

from __future__ import annotations

import hashlib
import stat
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, Response
from fastapi.responses import JSONResponse

from .agent_package import MEDIA_TYPE

# path served → (file inside the configured directory, media type, byte limit)
DOCUMENTS: dict[str, tuple[str, str, int]] = {
    "/agent-index.json": ("agent-index.json", "application/json", 1024 * 1024),
    "/policies/webagents-research.json": (
        "policies/webagents-research.json",
        "application/json",
        1024 * 1024,
    ),
    "/packages/literature-review-0.2.5.agent.pkg": (
        "packages/literature-review-0.2.5.agent.pkg",
        MEDIA_TYPE,
        16 * 1024 * 1024,
    ),
}


class DemoDocumentsConfigError(ValueError):
    """The configured directory cannot be published; the origin refuses to start."""


@dataclass(frozen=True)
class PublishedDocument:
    data: bytes
    sha256: str
    media_type: str


@dataclass(frozen=True)
class DemoDocuments:
    documents: dict[str, PublishedDocument]

    @classmethod
    def load(cls, directory: str | Path) -> DemoDocuments:
        root = Path(directory)
        if not root.is_dir():
            raise DemoDocumentsConfigError(f"Demo documents directory not found: {root}")
        documents = {}
        for path, (name, media_type, limit) in DOCUMENTS.items():
            target = root / name
            try:
                info = target.lstat()
            except OSError as exc:
                raise DemoDocumentsConfigError(f"Demo document missing: {target}") from exc
            # A regular file, not a link: what is served is what was put there.
            if not stat.S_ISREG(info.st_mode):
                raise DemoDocumentsConfigError(f"Demo document is not a regular file: {target}")
            if info.st_size == 0 or info.st_size > limit:
                raise DemoDocumentsConfigError(f"Demo document must be 1..{limit} bytes: {target}")
            data = target.read_bytes()
            if len(data) != info.st_size:
                raise DemoDocumentsConfigError(f"Demo document changed while being read: {target}")
            documents[path] = PublishedDocument(
                data=data, sha256=hashlib.sha256(data).hexdigest(), media_type=media_type
            )
        return cls(documents=documents)

    def health(self) -> dict[str, str]:
        return {path: document.sha256 for path, document in sorted(self.documents.items())}


def router(published: DemoDocuments | None) -> APIRouter:
    routes = APIRouter()

    def serve(path: str):
        def handler() -> Response:
            if published is None:
                return JSONResponse(
                    {
                        "error": {
                            "code": "not_published",
                            "message": "This origin does not publish the WebAgents demo documents.",
                            "details": [],
                        }
                    },
                    status_code=404,
                    headers={"Cache-Control": "no-store"},
                )
            document = published.documents[path]
            return Response(
                document.data,
                media_type=document.media_type,
                headers={
                    "Cache-Control": "no-cache",
                    "ETag": f'"sha256:{document.sha256}"',
                    "X-Content-SHA256": document.sha256,
                },
            )

        return handler

    for path in DOCUMENTS:
        routes.add_api_route(path, serve(path), methods=["GET", "HEAD"], include_in_schema=False)
    return routes
