# agentpkg 0.2.2

Installable tooling for agent.pkg format 0.1 and the generic workflow.v0 interpreter. From the repository root:

```sh
python3 -m venv agentpkg/.venv
agentpkg/.venv/bin/python -m pip install -e './agentpkg[dev]'
agentpkg/.venv/bin/agentpkg --help
```

`build`, `validate`, `inspect`, `permissions`, `unpack`, `keygen`, `sign`, `verify`, and `install-openclaw` retain their existing container/security behavior. Builds, exports and staging require new destinations; `sign` supports explicit atomic in-place signing. `validate` does not authenticate a publisher; `verify` needs an external trusted public key.

`run PACKAGE --mode fixture --grants HOST_GRANTS.json --out NEW_DIRECTORY` executes any workflow.v0 package. Optional `--input JSON` must satisfy its input schema; without it fixture mode uses the package's declared sample input. Optional `--limits JSON` can lower global token/remote-call/parallelism ceilings. `--trust-key PUBLIC.pem` authenticates the artifact and is mandatory in live mode. `eval PACKAGE` runs the package-owned fixture through the same interpreter under test grants. Neither command imports an application workflow.

`browser-serve` runs the loopback [agent browser control plane](../docs/browser-control-plane.md):
package opening, immutable snapshots, layered validation, signature checking,
publisher-trust evaluation, inspection and authorization receipts. It binds only
a loopback address, requires a bearer token, and executes nothing. `trust
list|add|remove` manages the operator's publisher key pins, which are the input
to `trust_status` and live outside every package.

```sh
agentpkg trust add --public-key PUBLISHER.pem --display-name "Name" --publisher-id claimed-id
agentpkg browser-serve --host 127.0.0.1 --port 8765 --token-file /run/agentpkg.token
```

For a host integration:

```python
from agentpkg.workflow import run_workflow

result = await run_workflow(
    verified_package,
    input_value,
    grants=host_grants,
    router=host_model_router,
    handlers=host_tool_bindings,
)
```

The interface is in `interfaces.py`; model requirements and tool declarations remain package data. `Workflow` additionally exposes host cancellation. `WorkflowError.execution_report` retains settled usage and audit on failure; cancellation propagates as `asyncio.CancelledError` with the same report attribute.

Current adapters are generic fixture replay, the pre-existing vendor-neutral HTTP model adapter, and the existing trusted tool providers. Fixture mode is deterministic simulation, not inference. Live generic execution requires explicit `--input`, a configured compatible router via `--router-config`, host grants and a signed package. This milestone adds no model vendor integration. Optional selected-file and resolver-origin settings retain their host-controlled semantics.

The old application runner is now the explicit development command `agentpkg-legacy` (or `python -m agentpkg.dev.legacy_cli`), operating on the archived legacy package. Its `--question`, seed/PDF options and specialized eval harness remain there. Python callers migrate old imports to `agentpkg.dev.literature` and `agentpkg.dev.literature_evals`; new callers use `agentpkg.workflow`.

See the [normative workflow spec](../spec/workflow-v0.md), [migration notes](../docs/workflow-migration.md), and [repository commands](../README.md).
