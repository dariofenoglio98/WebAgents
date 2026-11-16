"""A dependency's bytes from its locator (link.v0 L-10) on a host without a control plane: the
real download path of `browser/fetch.py`, its child included, with only the network read
replaced. An injected transport would hide what the child does with its destination file."""

import json
import multiprocessing

import pytest
from link_probe import scenario, write

from agentpkg.browser import fetch as package_fetch
from agentpkg.browser.errors import ControlPlaneError
from agentpkg.cli import main
from agentpkg.links.fetch import fetch_dependency
from agentpkg.links.resolve import LinkRefusal


def serve(monkeypatch, pages):
    """The download child run in this process, the socket read answered from `pages` by URL;
    everything else of the path (the URL gate, the staging file, the child's write, its one
    message) is the shipped code. Returns the URLs asked for."""
    asked = []

    def read(url, *, limits):
        asked.append(url)
        if url not in pages:
            raise ControlPlaneError("download_failed", "Package download failed: 404", status=502)
        return pages[url]

    def in_this_process(target, args, *, timeout_seconds, operation, **_):
        receiver, sender = multiprocessing.Pipe(duplex=False)
        target(*args, sender)
        message = json.loads(receiver.recv_bytes())
        receiver.close()
        if not message.get("ok"):
            raise ControlPlaneError(
                message["code"], message["message"], status=message.get("status", 502)
            )
        return message

    monkeypatch.setattr(package_fetch, "fetch_https_package", read)
    monkeypatch.setattr(package_fetch, "run_in_killable_child", in_this_process)
    return asked


def test_a_dependency_is_fetched_from_its_locator_by_the_real_download_child(monkeypatch):
    locator = "https://packages.example/index.agent.pkg"
    asked = serve(monkeypatch, {locator: b"the archive's bytes"})
    assert fetch_dependency({"id": "index", "locator": locator}) == b"the archive's bytes"
    assert asked == [locator]


def test_a_locator_that_cannot_be_read_refuses_the_link(monkeypatch):
    serve(monkeypatch, {})
    with pytest.raises(LinkRefusal, match="^link_fetch_failed: dependency 'index'") as refusal:
        fetch_dependency({"id": "index", "locator": "https://packages.example/index.agent.pkg"})
    assert refusal.value.code == "link_fetch_failed"


def test_the_cli_resolves_a_link_from_its_locator_when_no_archive_is_supplied(
    tmp_path, keys, monkeypatch, capsys
):
    """`agentpkg run` without `--link`: both dependencies come from their locators."""
    built = write(tmp_path / "probe", scenario("planned-walk"), keys)
    pages = {
        f"https://packages.example/{name}.agent.pkg": archive.read_bytes()
        for name, archive in built.archives.items()
    }
    asked = serve(monkeypatch, pages)
    grants = tmp_path / "grants.json"
    grants.write_text(json.dumps(built.grants), encoding="utf-8")
    link_args = built.argv(tmp_path)
    without_archives = []
    skip = False
    for position, value in enumerate(link_args):
        if skip:
            skip = False
        elif value == "--link":
            skip = True
        else:
            without_archives.append(link_args[position])
    assert "--link" not in without_archives and "--link-grants" in without_archives
    out = tmp_path / "out"
    argv = ["run", str(built.caller), "--mode", "fixture", "--grants", str(grants)]
    assert main(argv + without_archives + ["--out", str(out)]) == 0, capsys.readouterr().err
    assert json.loads(capsys.readouterr().out)["passed"]
    assert sorted(asked) == sorted(pages)
    assert len(json.loads((out / "links.json").read_text())["runs"]) == 3
