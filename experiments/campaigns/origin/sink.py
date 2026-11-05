"""The logging sink (PROTOCOL.md §2.1): `sink.invalid` mapped to it on the baselines' side; it
records every request it receives (method, host, path, headers, body) and answers 200. On our side
the sink's log must stay empty: an undeclared destination is refused before a dial (P-8)."""

from __future__ import annotations

import json
import time


class Sink:
    def __init__(self) -> None:
        self.log: list[dict] = []

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if scope["type"] != "http":
            return
        body = bytearray()
        more = True
        while more:
            message = await receive()
            body.extend(message.get("body", b""))
            more = message.get("more_body", False)
        headers = {k.decode("latin-1"): v.decode("latin-1") for k, v in scope.get("headers") or []}
        self.log.append(
            {
                "at": time.time(),
                "method": scope["method"],
                "host": headers.get("host"),
                "path": scope["path"],
                "query": scope.get("query_string", b"").decode("latin-1"),
                "headers": headers,
                "body": bytes(body).decode("utf-8", "replace"),
            }
        )
        answer = json.dumps({"ok": True}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(answer)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": answer})
