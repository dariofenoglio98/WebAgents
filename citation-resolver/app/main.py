from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.config import PROVIDER_TIMEOUT_SECONDS, Settings, validate_origin
from app.models import ErrorResponse, ResolveRequest, ResolveResponse
from app.providers.arxiv import Arxiv
from app.providers.crossref import Crossref
from app.providers.openalex import OpenAlex
from app.resolver import Resolver

SKILL_PATH = Path(__file__).resolve().parent.parent / "SKILL.md"


def create_app(
    settings: Settings | None = None, transport: httpx.AsyncBaseTransport | None = None
) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(PROVIDER_TIMEOUT_SECONDS, connect=5),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
            follow_redirects=False,
            trust_env=False,
            transport=transport,
        ) as client:
            app.state.resolver = Resolver(
                Crossref(client, settings), OpenAlex(client, settings), Arxiv(client, settings)
            )
            yield

    app = FastAPI(title="Citation Resolver", version="0.1.0", lifespan=lifespan)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.allowed_hosts))

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        # Do not echo full payloads or Pydantic's input/context fields.
        error = ErrorResponse(
            message="Invalid request. Check query, query_type, and format.",
            errors=[
                {"field": ".".join(map(str, e["loc"])), "message": e["msg"]} for e in exc.errors()
            ],
        )
        return JSONResponse(error.model_dump(), status_code=400)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "citation-resolver"}

    @app.get("/SKILL.md", response_class=PlainTextResponse)
    async def skill(request: Request) -> Response:
        # Only infer an origin after TrustedHost validation. Ignore raw forwarding headers.
        origin = settings.public_base_url or validate_origin(str(request.base_url))
        text = SKILL_PATH.read_text(encoding="utf-8").replace("{{BASE_URL}}", origin)
        # The standalone skill retains its public deployment URL for direct OpenClaw use.
        # Hosted copies must also honor the configured/validated origin.
        text = text.replace("https://webagents-citation-resolver-production.up.railway.app", origin)
        return Response(text, media_type="text/markdown", headers={"Cache-Control": "no-store"})

    @app.post(
        "/resolve",
        response_model=ResolveResponse,
        responses={
            400: {"model": ErrorResponse},
            404: {"model": ResolveResponse},
            502: {"model": ResolveResponse},
        },
    )
    async def resolve(
        request: Request, body: ResolveRequest, response: Response
    ) -> ResolveResponse | JSONResponse:
        try:
            result = await request.app.state.resolver.resolve(body)
        except ValueError as exc:
            return JSONResponse(ErrorResponse(message=str(exc)).model_dump(), status_code=400)
        response.status_code = {"not_found": 404, "provider_error": 502}.get(result.status, 200)
        return result

    return app


app = create_app()
