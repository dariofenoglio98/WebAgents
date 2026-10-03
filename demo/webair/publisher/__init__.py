"""WebAir as the publisher of its own agent package.

Build-time tooling only. It derives the package's tool contracts from the origin's own
published API schemas and records the package's deterministic fixture by running the
package through the generic WebAgents runtime against this origin. The package source
lives in `agents/webair/`; it is data, and nothing here is part of it.
"""
