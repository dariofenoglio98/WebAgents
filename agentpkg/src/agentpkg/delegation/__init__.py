"""network.v0 in the Python reference (spec/network-v0.md, agentpkg 0.7.0): bounded,
model-chosen delegation inside a workflow.v0 graph.

A delegation package declares a `network` of roles (workers with a program), the edges a role
may hand off along with their use caps, a hop cap and a shared state with per-role views; one
`network` node runs it. At a role's route the model chooses the next role among the declared
edges; the runtime checks every transition, bounds every activation by its worker's budget and
timeout, and computes the worst case from the declaration alone, so the agent page says "at
most" before the run (`analysis`). `declarations` is what the control plane reads; the loop
(`runner`) is imported by the interpreter on demand, so the control plane stays unable to
import it (D-007).
"""

from .analysis import enumerate_walks, worst_case
from .declarations import NETWORK_MINIMUM_VERSION, network_records

__all__ = ["NETWORK_MINIMUM_VERSION", "enumerate_walks", "network_records", "worst_case"]
