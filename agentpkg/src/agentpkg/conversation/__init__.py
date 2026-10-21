"""conversation.v0 in the Python reference (spec/conversation-v0.md, agentpkg 0.6.0).

A conversational package is a workflow.v0 graph with a top-level `conversation` object: the graph
is the turn graph, a message is its input, a reply its output, and one turn is one run of it under
one Run Plan. The persistent state, the consent steps, the per-conversation budget, the transcript
and the one audit chain across turns live here; the interpreter and the mediator gained the
`consent` node, the gate on consented permissions and the chain, and nothing package-specific.

The runner is imported on demand: `declarations` and `transcript` are what the control plane
needs to describe and check a conversational package, and the control plane must stay unable to
import the interpreter (D-007). `from agentpkg.conversation import Conversation` still works.
"""

from .errors import ConsentError, ConversationError

__all__ = ["ConsentError", "Conversation", "ConversationError"]


def __getattr__(name):
    if name == "Conversation":
        from .runner import Conversation

        return Conversation
    raise AttributeError(name)
