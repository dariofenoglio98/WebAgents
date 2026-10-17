"""compute.v0: WebAssembly core modules as pure functions inside workflow.v0 (D-185, D-240…D-244).

A package ships a module under `modules/*.wasm`, declares it in the graph with its SHA-256, and
runs it from `compute` nodes under the host's and the node's limits. Nothing here gives a module
any authority: a tier-1 module has no imports, so it can only compute over the bytes it is given.

`module.py` reads a module without running it (the structural requirements and the feature gate
both runtimes check identically); `engine.py` runs one under wasmtime; `declarations.py` is the
validation hook that ties the graph, the members and the permission together.
"""

from .module import (
    ALLOWED_FEATURES,
    MAX_MODULE_BYTES,
    MAX_PAGES,
    PAGE_BYTES,
    ModuleError,
    ModuleFacts,
    check_module,
    read_module,
)

__all__ = [
    "ALLOWED_FEATURES",
    "MAX_MODULE_BYTES",
    "MAX_PAGES",
    "PAGE_BYTES",
    "ModuleError",
    "ModuleFacts",
    "check_module",
    "read_module",
]
