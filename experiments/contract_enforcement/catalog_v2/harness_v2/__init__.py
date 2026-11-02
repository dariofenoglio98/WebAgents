"""Machinery for catalog v2 of the contract-enforcement experiment (T30). Experiment-only.

Nothing under `experiments/` is part of agentpkg or the Chrome Agent Browser, and nothing in
`agentpkg/src` or `chrome-agent-browser/src` imports it; `tests/test_isolation.py` checks both
directions. v1's harness (`../harness/`) is imported where it is generic (the exact-match patch
machinery, the offline guard), never edited.
"""
