"""The host mapping (PROTOCOL.md §2.1): the one campaign seam that is not observation only, for
`Py`.

agentpkg dials a remote tool from a spawned child (`agentpkg.network._http_child` →
`agentpkg.tools.request_json`), which resolves the declared public hostname, refuses it unless every
answer is a public address (the address policy, unchanged), and connects to the first answer with
TLS for that hostname. Under `install(mapping)` the child's **dial** goes to the campaign stack on
`127.0.0.1` instead, with a TLS context that trusts the campaign CA, and the request carries the
run's fixture key (`X-Campaign-Fixture`) when it goes to the campaign origin. Nothing else changes:
the URL check, the DNS lookup and its classification, the bounded read, the refusal of redirects,
the deadline.

How it is installed: `install` replaces `agentpkg.network._http_child`, the module global agentpkg
looks up at each call, with `functools.partial(mapped_http_child, mapping)`. The mapping travels in
that partial's arguments to the spawned child; no configuration file, flag or environment variable
of agentpkg can name it, and after `install` exits the original function is back
(tests/test_hostmap.py). Every dial is appended to the run's dial log (the lookup's answer or its
failure, the mapped address), so a failed lookup is recorded as a harness error, never as our side's
refusal.
"""

from __future__ import annotations

import contextlib
import functools
import json
import socket
import ssl
import time
from pathlib import Path
from urllib.parse import urlsplit

import agentpkg.network as agent_network

HEADER = "X-Campaign-Fixture"


def mapping(
    hosts: dict[str, tuple[str, int]],
    ca: Path,
    dial_log: Path,
    *,
    fixture_key: str | None = None,
    fixture_hosts: tuple[str, ...] = (),
    dns_override: dict[str, str] | None = None,
) -> dict:
    """The picklable mapping a run installs. `dns_override` is for offline tests only: a campaign
    refuses it (driver/campaign.py), because the protocol classifies the hostname's real answer."""
    return {
        "hosts": {host: [address, port] for host, (address, port) in hosts.items()},
        "ca": str(ca),
        "dial_log": str(dial_log),
        "fixture_key": fixture_key,
        "fixture_hosts": list(fixture_hosts),
        "dns_override": dict(dns_override or {}),
    }


def _log(path: str, entry: dict) -> None:
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, sort_keys=True) + "\n")


def mapped_http_child(table: dict, url: str, kwargs: dict, sender) -> None:
    """The child's target under the mapping: agentpkg's own `_http_child`, dialing the stack."""
    import agentpkg.tools as tools

    host = urlsplit(url).hostname
    entry = {"at": time.time(), "url": url, "host": host, "mapped": host in table["hosts"]}
    override = table["dns_override"]
    if override:
        real_getaddrinfo = socket.getaddrinfo

        def getaddrinfo(name, *args, **kw):
            if name in override:
                return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (override[name], 443))]
            return real_getaddrinfo(name, *args, **kw)

        socket.getaddrinfo = getaddrinfo
        entry["dns_override"] = True
    try:
        answers = sorted({a[4][0] for a in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})
        entry["lookup"] = {"ok": True, "addresses": answers}
    except OSError as exc:
        entry["lookup"] = {"ok": False, "error": type(exc).__name__}
    if host in table["hosts"]:
        address, port = table["hosts"][host]
        context = ssl.create_default_context(cafile=table["ca"])
        entry["dialed"] = [address, port]

        class Mapped(tools._PinnedHTTPS):
            def connect(self):  # the dial, and only the dial, goes to the stack
                sock = socket.create_connection((address, port), timeout=self.timeout)
                try:
                    self.sock = context.wrap_socket(sock, server_hostname=self.host)
                except BaseException:
                    sock.close()
                    raise

        tools._PinnedHTTPS = Mapped
        if table["fixture_key"] and host in table["fixture_hosts"]:
            kwargs = {
                **kwargs,
                "headers": {**(kwargs.get("headers") or {}), HEADER: table["fixture_key"]},
            }
            entry["fixture_key"] = table["fixture_key"]
    _log(table["dial_log"], entry)
    # A spawned child imported agentpkg afresh: this is agentpkg's own, unpatched target.
    agent_network._http_child(url, kwargs, sender)


@contextlib.contextmanager
def install(table: dict):
    """Route agentpkg's remote dials through the mapping for the duration of one run."""
    original = agent_network._http_child
    if isinstance(original, functools.partial):
        raise RuntimeError("a host mapping is already installed")
    agent_network._http_child = functools.partial(mapped_http_child, table)
    try:
        yield table
    finally:
        agent_network._http_child = original


def read_dial_log(path: Path) -> list[dict]:
    if not Path(path).exists():
        return []
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]
