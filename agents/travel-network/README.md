# Travel Network

`org.webagents.travel-network`: the travel example of network.v0 (bounded, model-chosen delegation), the shape of an agent collaboration chain. `FrontMan` (the entry) restates the trip and, at a route the model chooses, consults `Flights`, `Hotel` and `Calendar`, each at most once within six handoffs, then ends with the plan. Each specialist calls one tool on the WebAir demo origin's fictional partner services (`/api/v1/travel/flights`, `hotels`, `calendar`) and returns to the front man by a fixed route.

Before you run it your Agent Browser tells you the envelope, computed from this signed declaration: at most 6 handoffs; FrontMan at most 4 times and each specialist once; at most 8 model calls, one call of each tool, 19 remote calls and 48,000 tokens. A run can stay below these figures and cannot pass them. For this star the figures are exact: the full tour (FrontMan, Flights, FrontMan, Hotel, FrontMan, Calendar, FrontMan) attains them, and it is the fixture walk.

All data is fictional; nothing is booked.
