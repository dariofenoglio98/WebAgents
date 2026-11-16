# Staymere

`org.webagents.staymere-hotels`: a fictional hotel aggregator's search as a package another publisher's agent can link (Agent Links, `link.v0`). Given a city and a stay it asks Staymere's fictional search service (`POST /api/v1/travel/hotels`), then proposes one hotel among those listed, and returns the options with its pick.

Linked from another package, it runs in your Agent Browser on your model, under what you grant it on its own card: it holds nothing of the package that asked, and of that package's data only the stay it was sent. Its worst case, which a caller's envelope includes: 1 model call, 1 call of its tool, 3 remote calls, 6,000 tokens.

All data is fictional; nothing is booked.
