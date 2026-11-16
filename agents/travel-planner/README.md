# Tripwright

`org.webagents.travel-planner`: a fictional travel planner that asks other publishers' agents for help, as a page links to a page (Agent Links, `link.v0`). `FrontMan` (the entry) restates the trip and, at a route the model chooses, consults `Flights`, `Hotels` and `Calendar`, each at most once within six handoffs, then ends with the plan. `Flights` asks **WebAir Flights** (`org.webagents.webair-flights`) and `Hotels` asks **Staymere** (`org.webagents.staymere-hotels`): two signed packages from two other publishers, named in this package's signed manifest by digest and publisher key. `Calendar` calls this package's own tool on the WebAir demo origin's fictional calendar service.

Your Agent Browser fetches and verifies both linked packages before you agree to anything, shows you each publisher on its own card, and lets you deny one. A linked package runs here, on your model, under what you grant it on its card; it receives the trip's airports, dates and number of travellers, never your message or your notes, and it holds nothing this planner was granted.

The envelope, computed from this declaration and the two pinned ones before you agree: at most 6 handoffs; FrontMan at most 4 times and each specialist once; at most 10 model calls (8 of the planner, 1 of each linked package); one call each of the calendar tool, WebAir's flight search and Staymere's hotel search; 23 remote calls and 92,000 tokens. A run can stay below these figures and cannot pass them.

All data is fictional; nothing is booked.
