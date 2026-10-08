"""The WebAir origin: one ASGI app serving the human site, the semantic API and /agent.pkg.

Beside them, when configured, the WebAgents demo documents (`demo_documents.py`, T8).
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import agent_package, api, demo_documents, web
from .service import WebAirService

STYLESHEET_PATH = "/static/webair.css"
HEALTH_PATH = "/health"

_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    # No scripts at all; styles, images and form posts stay on this origin. `base-uri 'none'`
    # also keeps the relative rel="agent-package" href resolving against this origin.
    "Content-Security-Policy": (
        "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; "
        "frame-ancestors 'none'; base-uri 'none'"
    ),
}


def create_app(
    agent_package_path: str | Path | None = None,
    demo_documents_path: str | Path | None = None,
) -> FastAPI:
    """Build the origin. `agent_package_path` is the only file /agent.pkg may ever serve;
    `demo_documents_path` the only directory the three demo-document paths read from (T8)."""
    package = (
        agent_package.PublishedPackage.load(agent_package_path)
        if agent_package_path is not None
        else None
    )
    documents = (
        demo_documents.DemoDocuments.load(demo_documents_path)
        if demo_documents_path is not None
        else None
    )
    stylesheet = (Path(__file__).parent / "static" / "webair.css").read_bytes()
    templates = web.load_templates()

    # No generated docs: Swagger UI would load scripts from a CDN.
    # Exact paths only: no slash-redirects, so /agent.pkg/ is a 404 rather than a hop.
    app = FastAPI(
        title="WebAir (fictional demo airline)",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        redirect_slashes=False,
    )
    app.state.service = WebAirService()
    app.state.agent_package = package
    app.state.demo_documents = documents

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        for name, value in _SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        return response

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> Response:
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        if request.url.path.startswith(api.API_PREFIX + "/"):
            return api.error_response(exc.status_code, code, str(exc.detail))
        page = templates.get_template("error.html").render(
            title="Page not found" if exc.status_code == 404 else "Request not allowed",
            message=str(exc.detail),
        )
        return Response(
            page,
            status_code=exc.status_code,
            media_type="text/html",
            headers=dict(exc.headers or {}),
        )

    @app.get(STYLESHEET_PATH, include_in_schema=False)
    def css() -> Response:
        return Response(
            stylesheet, media_type="text/css", headers={"Cache-Control": "public, max-age=300"}
        )

    # For a hosting platform's health check. It states only public facts: that this is the
    # fictional demo, and which package /agent.pkg serves (the digest its ETag also carries).
    @app.get(HEALTH_PATH, include_in_schema=False)
    def health() -> JSONResponse:
        return JSONResponse(
            {
                "status": "ok",
                "service": "webair-origin",
                "fictional": True,
                "agent_package_sha256": package.sha256 if package else None,
                "demo_documents": documents.health() if documents else None,
            },
            headers={"Cache-Control": "no-store"},
        )

    app.include_router(web.router(templates))
    app.include_router(api.router())
    app.include_router(agent_package.router(package))
    app.include_router(demo_documents.router(documents))
    return app
