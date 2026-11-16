# Hotel Salitubam

`org.webagents.hotel-salitubam`: a fictional small hotel in Reykjavik, as a package another publisher's agent can link or find (Agent Links, `link.v0`). Given a stay it asks the hotel's own fictional availability service (`POST /api/v1/hotel/availability`), then proposes one room offer, and returns the offers with its pick.

Joined by another package during a run, it runs in your Agent Browser on your model only after you accept its card: it holds nothing of the package that asked, and of that package's data only the stay it was sent. Its worst case, which a caller's slot must hold: 1 model call, 1 call of its tool, 3 remote calls, 6,000 tokens.

All data is fictional; nothing is booked.
