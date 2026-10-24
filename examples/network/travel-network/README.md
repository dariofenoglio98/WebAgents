# Travel Network

`org.webagents.travel-network`: the travel example of [network.v0](../../../spec/network-v0.md), the shape of the deck's agent collaboration chain. `FrontMan` (the entry) restates the trip and, at a model-chosen route, consults `Flights`, `Hotel` and `Calendar` (each a local, fictional tool and a fixed return), each at most once within six handoffs, then ends with the plan. The worst case is exact for this star: the fixture walk is the full tour (FrontMan, Flights, FrontMan, Hotel, FrontMan, Calendar, FrontMan, done), and `agentpkg/tests/test_network_travel.py` enumerates every allowed walk and checks that the bound is attained. All data is fictional; nothing is booked.

An unsigned source in T25; T26 ships it signed from `agents/travel-network/`. Regenerate with `python3 examples/network/make_network_examples.py`.
