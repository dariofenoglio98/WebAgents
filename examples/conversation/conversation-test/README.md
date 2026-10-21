# Ticket Desk

`org.webagents.conversation-test`: a `workflow.v0` package with a `conversation` object, which
exists to exercise [conversation.v0](../../../spec/conversation-v0.md) in both runtimes. You talk
to a fictional ticket desk: a `Clerk` step reads each message with the conversation's history and
orders (persistent state), a **consent step** asks before an order is placed, the `place-order`
tool (write side effects, behind that consent) places it, and the conversation ends when you say
you are done. Its fixture transcript is two turns: an order confirmed, then goodbye.

It is signed with a development key (`examples/keys/conversation-test-publisher.pub.pem`) for the
test suites and the conformance suite, and is not shipped in `dist/`. A changed source is a new
version of this package and a new signature (D-003).
