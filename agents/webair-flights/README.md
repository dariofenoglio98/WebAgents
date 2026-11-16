# WebAir Flights

`org.webagents.webair-flights`: WebAir's flight search as a package another publisher's agent can link (Agent Links, `link.v0`). Given two airports, a date and a number of travellers it asks the WebAir demo origin's fictional flight service (`POST /api/v1/travel/flights`), then proposes one flight among those found, and returns the options with its pick.

Linked from another package, it runs in your Agent Browser on your model, under what you grant it on its own card: it holds nothing of the package that asked, and of that package's data only the search it was sent. Its worst case, which a caller's envelope includes: 1 model call, 1 call of its tool, 3 remote calls, 6,000 tokens.

All data is fictional; nothing is booked.
