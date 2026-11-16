# Tripwright

`org.webagents.travel-planner` 0.2.0: the fictional travel planner of 0.1.0 (it asks **WebAir Flights** and **Staymere**, two other publishers' signed packages named in its manifest by digest and key, and checks the calendar) with one more role, `FindHotel`, for a hotel you name that Staymere does not list (Agent Links, `link.v0`, a link made during the run).

`FindHotel` searches the web for the hotel's name with the planner's own `web.search` tool, then holds a **slot**: your Agent Browser looks at the address you gave in the request (`hotel_url`), else at the first search result's, never at an address a model wrote; if that page advertises an agent package, the browser fetches and verifies it and shows you its card: who signed it, what it asks for, what it can cost at most, and what the planner may send it (the check-in and check-out dates and the number of travellers, never your message or your notes). Nothing of that package reaches the planner's model before you decide, and without you there is no join.

The envelope, computed before you agree, already holds the join at its declared ceiling: at most 8 handoffs; FrontMan at most 5 times and each specialist once; for the package joined during the run at most 1 model call, 1 tool call, 3 remote calls and 6,000 tokens, with at most three pages looked at and one package fetched. A run can stay below these figures and cannot pass them.

All data is fictional; nothing is booked.
