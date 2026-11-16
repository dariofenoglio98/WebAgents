"""Agent Links (link.v0, spec/link-v0.md): one publisher's package asking another's for help.

A link names a package; it grants nothing. What is here is host-neutral, so that the developer
CLI, the control plane and the execution host compose the same rules:

* `declarations`: what a package may declare about links, checked at validation;
* `analysis`: the worst case of a package and the composed bound across its links, pure
  arithmetic over declarations;
* `resolve`: a dependency's bytes verified and checked against its record (preparation: nothing
  of a linked package runs there);
* `host`: what a run holds about its links, and the runner that starts an inner run.

Nothing in this package is package-specific: the dependencies, the ceilings and the views come
from signed declarations, the decisions from the person.
"""

from .analysis import composed_requirement, link_operations, package_worst_case
from .declarations import LINK_MINIMUM_VERSION, check_link_declarations

__all__ = [
    "LINK_MINIMUM_VERSION",
    "check_link_declarations",
    "composed_requirement",
    "link_operations",
    "package_worst_case",
]
