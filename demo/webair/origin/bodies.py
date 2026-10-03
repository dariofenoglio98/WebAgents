"""Bounded request-body reading shared by the JSON API and the HTML forms."""

from __future__ import annotations

from fastapi import Request


class BodyTooLarge(Exception):
    pass


async def read_bounded_body(request: Request, limit: int) -> bytes:
    """Read at most `limit` bytes, refusing early on a larger declared length."""
    declared = request.headers.get("content-length")
    if declared is not None and (not declared.isdigit() or int(declared) > limit):
        raise BodyTooLarge()
    chunks, total = [], 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise BodyTooLarge()
        chunks.append(chunk)
    return b"".join(chunks)


def media_type(request: Request) -> str:
    return request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
