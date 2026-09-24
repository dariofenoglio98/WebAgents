"""Host tool registries, binding digests, and package/binding compatibility.

Three objects meet in this module and must not be allowed to collapse into one:

    what the package declares   what the host implements   what the person allowed

Every test below is about keeping one of those from standing in for another.
"""

from __future__ import annotations

import copy

import pytest
from shipped_keys import DIST
from tool_fakes import ECHO_TOOL, binding_for, echo_package, empty_registry, registry_for

from agentpkg.browser.errors import ControlPlaneError
from agentpkg.browser.hosttools import (
    AMBIGUOUS,
    BOUND,
    INCOMPATIBLE,
    UNAVAILABLE,
    UNBOUND,
    UNVERIFIED,
    binding_digest,
    evaluate_registry,
    normalize_registry,
    plan_tool_bindings,
    tool_contract,
    tool_requirement_set,
)
from agentpkg.package import load_package

GRANTS = {"files.echo": "session", "memory.session": "session"}


@pytest.fixture
def echo(tmp_path):
    package, _ = echo_package(tmp_path)
    return package


def evaluate(package, registry, *, grants=None, approve=True):
    approvals = {tool_id: approve for tool_id in package.tools}
    return evaluate_registry(
        package,
        normalize_registry(registry),
        decisions=grants if grants is not None else GRANTS,
        tool_approvals=approvals,
    )


# -- what the package declares ----------------------------------------------
def test_a_contract_is_read_out_of_the_signed_package(echo):
    contract = tool_contract(echo, ECHO_TOOL)
    assert contract["tool_id"] == ECHO_TOOL
    assert contract["binding"] == echo.tools[ECHO_TOOL]["binding"]
    assert contract["remote"] is False
    assert contract["permission_kinds"] == ["files.read"]
    assert len(contract["contract_sha256"]) == 64
    # The digests are of the schema documents themselves, so a package that
    # changed a schema would no longer match a binding pinned to the old one.
    # (This package's echo schemas are identical, which is why the digests
    # agree; the comparison that matters is against the host's answer.)
    assert len(contract["input_schema_sha256"]) == 64
    reference = load_package(DIST["literature-review"])
    resolver = tool_contract(reference, "citation-resolver")
    assert resolver["input_schema_sha256"] != resolver["output_schema_sha256"]
    assert resolver["endpoint_path"] == "/resolve"
    assert resolver["remote"] is True


def test_every_declared_tool_is_required_because_the_format_has_no_optional_flag(echo):
    requirements = tool_requirement_set(echo)
    assert [tool["tool_id"] for tool in requirements["tools"]] == [ECHO_TOOL]
    assert all(tool["required"] for tool in requirements["tools"])
    # It also records where the graph would use it, so a UI can say why.
    assert requirements["tools"][0]["nodes"] == ["echo"]
    assert requirements["tools"][0]["roles"] == ["EchoWorker"]


# -- the binding digest ------------------------------------------------------
def test_the_digest_covers_what_a_binding_would_do_and_not_whether_it_is_up(echo):
    registry = normalize_registry(registry_for(echo))
    original = registry["bindings"][0]["binding_sha256"]

    for field, value in (("available", False), ("display_name", "Something else")):
        moved = normalize_registry(registry_for(echo, overrides={ECHO_TOOL: {field: value}}))
        assert moved["bindings"][0]["binding_sha256"] == original, field

    for override in (
        {"implementation_version": "0.2.0"},
        {
            "implementation_kind": "json_http",
            "remote": True,
            "endpoint": {"origin": "https://example.test", "path": "/x", "method": "POST"},
        },
        {"limits": {"timeout_seconds": 11}},
        {"contract": {"side_effects": "write"}},
        {"credentials": {"required": True, "configured": True, "source": "env:TOKEN"}},
    ):
        moved = normalize_registry(registry_for(echo, overrides={ECHO_TOOL: override}))
        assert moved["bindings"][0]["binding_sha256"] != original, override


def test_the_digest_never_hashes_a_credential_value(echo):
    """Only *whether* one is attached, which is enough to invalidate a plan."""
    binding = normalize_registry(registry_for(echo))["bindings"][0]
    assert "secret" not in str(binding).lower()
    with_source = copy.deepcopy(binding)
    with_source["credentials"] = {
        "required": True,
        "configured": True,
        "source": "env:ECHO_TOKEN",
    }
    assert binding_digest(with_source) != binding["binding_sha256"]
    # Two hosts holding *different* secrets under the same name agree, because
    # no value took part; attaching or detaching one does not.
    detached = copy.deepcopy(with_source)
    detached["credentials"] = {"required": True, "configured": False, "source": "env:ECHO_TOKEN"}
    assert binding_digest(detached) != binding_digest(with_source)


def test_a_registry_hash_binds_the_whole_host_statement(echo):
    first = normalize_registry(registry_for(echo))
    again = normalize_registry(registry_for(echo))
    assert first["registry_sha256"] == again["registry_sha256"]
    changed = normalize_registry(registry_for(echo, overrides={ECHO_TOOL: {"available": False}}))
    assert changed["registry_sha256"] != first["registry_sha256"]


# -- what a host may say -----------------------------------------------------
@pytest.mark.parametrize(
    "override, match",
    [
        ({"implementation_kind": "shell"}, "implementation_kind"),
        ({"remote": True}, "must agree"),
        ({"contract": {"side_effects": "delete"}}, "side_effects"),
        ({"contract": {"input_schema_sha256": "nope"}}, "hex"),
        ({"limits": {"timeout_seconds": 10_000}}, "exceeds"),
    ],
)
def test_a_malformed_binding_is_refused(echo, override, match):
    with pytest.raises(ControlPlaneError, match=match):
        normalize_registry(registry_for(echo, overrides={ECHO_TOOL: override}))


def test_a_host_cannot_smuggle_a_header_credential_or_second_endpoint(echo):
    for extra in ("headers", "authorization", "api_key", "command", "url"):
        registry = registry_for(echo)
        registry["bindings"][0][extra] = "x"
        with pytest.raises(ControlPlaneError, match="Unknown fields"):
            normalize_registry(registry)


def test_a_remote_binding_must_be_an_https_origin_without_a_path(echo):
    package = load_package(DIST["literature-review"])
    for origin in (
        "http://api.example.test",
        "https://api.example.test/v1",
        "https://user:pw@api.example.test",
        "https://api.example.test:8443",
    ):
        with pytest.raises(ControlPlaneError, match="origin"):
            normalize_registry(
                registry_for(
                    package,
                    only=["citation-resolver"],
                    overrides={"citation-resolver": {"endpoint": {"origin": origin}}},
                )
            )


# -- compatibility -----------------------------------------------------------
def test_an_exact_binding_is_bound_and_a_missing_one_is_unbound(echo):
    assert evaluate(echo, registry_for(echo))["tools"][0]["status"] == BOUND
    missing = evaluate(echo, empty_registry())["tools"][0]
    assert missing["status"] == UNBOUND
    assert missing["binding"] is None


def test_a_different_schema_digest_is_incompatible_not_merely_unverified(echo):
    evaluated = evaluate(
        echo,
        registry_for(echo, overrides={ECHO_TOOL: {"contract": {"input_schema_sha256": "a" * 64}}}),
    )
    assert evaluated["tools"][0]["status"] == INCOMPATIBLE
    assert "input_schema" in evaluated["tools"][0]["binding"]["violated"]


def test_a_host_that_states_no_schema_digest_is_unverified(echo):
    evaluated = evaluate(
        echo,
        registry_for(
            echo,
            overrides={
                ECHO_TOOL: {"contract": {"input_schema_sha256": None, "output_schema_sha256": None}}
            },
        ),
    )
    tool = evaluated["tools"][0]
    assert tool["status"] == UNVERIFIED
    assert set(tool["binding"]["unknown"]) == {"input_schema", "output_schema"}


def test_a_binding_for_another_tool_id_does_not_satisfy_this_one(echo):
    registry = registry_for(echo)
    registry["bindings"][0]["tool_id"] = "something.else"
    assert evaluate(echo, registry)["tools"][0]["status"] == UNBOUND


def test_two_bindings_for_one_tool_are_ambiguous_rather_than_chosen_between(echo):
    extra = binding_for(echo, ECHO_TOOL, id="host:test.echo:2")
    evaluated = evaluate(echo, registry_for(echo, extra=[extra]))
    assert evaluated["tools"][0]["status"] == AMBIGUOUS
    assert evaluated["tools"][0]["binding"] is None


@pytest.mark.parametrize("field", ["available", "enabled"])
def test_a_registered_but_unusable_binding_is_unavailable(echo, field):
    evaluated = evaluate(echo, registry_for(echo, overrides={ECHO_TOOL: {field: False}}))
    assert evaluated["tools"][0]["status"] == UNAVAILABLE


def test_a_local_binding_cannot_satisfy_a_remote_declaration():
    package = load_package(DIST["literature-review"])
    registry = registry_for(
        package,
        only=["citation-resolver"],
        overrides={
            "citation-resolver": {
                "implementation_kind": "local_builtin",
                "remote": False,
                "endpoint": None,
            }
        },
    )
    evaluated = evaluate_registry(package, normalize_registry(registry))
    tool = next(item for item in evaluated["tools"] if item["tool_id"] == "citation-resolver")
    assert tool["status"] == INCOMPATIBLE
    assert "execution_locality" in tool["binding"]["violated"]


def test_a_remote_binding_must_land_inside_the_declared_domains():
    """A package's endpoint constrains a host downwards; it never grants."""
    package = load_package(DIST["literature-review"])
    registry = registry_for(
        package,
        only=["citation-resolver"],
        overrides={
            "citation-resolver": {
                "endpoint": {
                    "origin": "https://elsewhere.example",
                    "path": "/resolve",
                    "method": "POST",
                }
            }
        },
    )
    evaluated = evaluate_registry(package, normalize_registry(registry))
    tool = next(item for item in evaluated["tools"] if item["tool_id"] == "citation-resolver")
    assert tool["status"] == INCOMPATIBLE
    assert "endpoint_domain" in tool["binding"]["violated"]


def test_a_remote_binding_must_keep_the_declared_path_and_method():
    package = load_package(DIST["literature-review"])
    for override, violated in (
        ({"path": "/somewhere-else"}, "endpoint_path"),
        ({"method": "GET"}, "method"),
    ):
        registry = registry_for(
            package,
            only=["citation-resolver"],
            overrides={"citation-resolver": {"endpoint": override}},
        )
        evaluated = evaluate_registry(package, normalize_registry(registry))
        tool = next(item for item in evaluated["tools"] if item["tool_id"] == "citation-resolver")
        assert tool["status"] == INCOMPATIBLE
        assert violated in tool["binding"]["violated"]


# -- consent is a separate fact ---------------------------------------------
def test_a_bound_tool_is_not_a_usable_tool_without_an_approval(echo):
    evaluated = evaluate(echo, registry_for(echo), approve=False)
    tool = evaluated["tools"][0]
    assert tool["status"] == BOUND
    assert tool["approved"] is False
    assert tool["usable"] is False
    assert tool["blocks_plan"] is True


def test_an_approval_is_not_a_permission(echo):
    evaluated = evaluate(echo, registry_for(echo), grants={"memory.session": "session"})
    tool = evaluated["tools"][0]
    assert tool["approved"] is True
    assert tool["denied_permission_ids"] == ["files.echo"]
    assert tool["usable"] is False


def test_a_denied_optional_permission_leaves_a_tool_unusable_but_not_blocking():
    """The package itself declared that profile; its graph must cope with it."""
    package = load_package(DIST["literature-review"])
    registry = normalize_registry(registry_for(package))
    grants = {
        permission["id"]: ("session" if permission["required"] else "deny")
        for permission in package.policy["permissions"]
    }
    evaluated = evaluate_registry(
        package,
        registry,
        decisions=grants,
        tool_approvals={tool_id: True for tool_id in package.tools},
    )
    reader = next(item for item in evaluated["tools"] if item["tool_id"] == "paper-reader")
    assert reader["status"] == BOUND
    assert reader["usable"] is False
    assert reader["blocks_plan"] is False
    assert reader["denied_required_permission_ids"] == []


# -- what a plan freezes -----------------------------------------------------
def test_a_plan_binding_carries_identity_and_no_secret(echo):
    evaluated = evaluate(echo, registry_for(echo))
    bindings = plan_tool_bindings(evaluated)
    assert len(bindings) == 1
    record = bindings[0]
    assert record["tool_id"] == ECHO_TOOL
    assert len(record["binding_sha256"]) == 64
    assert record["approved"] is True
    assert record["credentials_configured"] is False
    # `approval_source` legitimately names the receipt, so the scan is over
    # values rather than keys: no credential-shaped *value* is present.
    values = " ".join(str(value).lower() for value in record.values())
    for forbidden in ("secret", "token", "bearer", "password", "header", "api_key"):
        assert forbidden not in values


# -- the third implementation category ---------------------------------------
def test_a_selected_file_binding_is_a_local_category_that_can_satisfy_a_local_tool(echo):
    registry = registry_for(echo, overrides={ECHO_TOOL: {"implementation_kind": "selected_file"}})
    result = evaluate(echo, registry)
    tool = result["tools"][0]
    assert tool["status"] == BOUND
    assert tool["binding"]["implementation_kind"] == "selected_file"
    assert tool["binding"]["remote"] is False
    assert tool["binding"]["endpoint_origin"] is None
    # Changing the category is a different implementation, so a different digest.
    plain = normalize_registry(registry_for(echo))["bindings"][0]
    files = normalize_registry(registry)["bindings"][0]
    assert binding_digest(plain) != binding_digest(files)


def test_a_selected_file_binding_cannot_claim_to_be_remote_or_carry_an_endpoint(echo):
    with pytest.raises(ControlPlaneError):
        normalize_registry(
            registry_for(
                echo,
                overrides={ECHO_TOOL: {"implementation_kind": "selected_file", "remote": True}},
            )
        )
    with pytest.raises(ControlPlaneError):
        normalize_registry(
            registry_for(
                echo,
                overrides={
                    ECHO_TOOL: {
                        "implementation_kind": "selected_file",
                        "endpoint": {"origin": "https://example.org", "path": "/", "method": "GET"},
                    }
                },
            )
        )


def test_the_shipped_review_package_is_fully_bound_by_this_host_s_three_categories():
    package = load_package(DIST["literature-review"])
    registry = registry_for(
        package, overrides={"paper-reader": {"implementation_kind": "selected_file"}}
    )
    result = evaluate_registry(
        package,
        normalize_registry(registry),
        decisions={
            "network.scholarly": "session",
            "network.citations": "session",
            "memory.session": "session",
            "model.reasoning": "session",
            "files.pdfs": "deny",
        },
        tool_approvals={tool_id: True for tool_id in package.tools},
    )
    by_id = {tool["tool_id"]: tool for tool in result["tools"]}
    assert result["all_tools_bound"] is True
    # A denied optional files permission leaves the reader bound and approved,
    # unusable, and not blocking: the graph's own conditions keep it unreached.
    assert by_id["paper-reader"]["usable"] is False
    assert by_id["paper-reader"]["blocks_plan"] is False
    assert by_id["scholarly-search"]["usable"] is True
    assert by_id["citation-resolver"]["usable"] is True
