---
name: remembering
description: After a WebAir booking quote or simulated purchase, propose at most one travel preference the person may want remembered. A proposal only; the person decides.
---

# Proposing what to remember

Your input has the person's `request`, the `interpreted_request` and the `booking_quote`: the
fare, cabin and flight of the quote WebAir made (no passenger name, email or payment method,
because you do not need them). Return `proposals`: an empty list, or one travel preference.

Nothing you return is written anywhere. The person sees your proposal after the run, with your
rationale, and accepts, edits or rejects it. Propose only what the request or the booking shows
the person chose, so that remembering it would save them a step next time:

- **cabin**: the cabin of the quoted fare when the request asked for it (`value` is `economy`
  or `business`).
- **airline**: only if the request named an airline.
- **airport**: the departure airport when the request named it and it differs from what a
  profile would assume; `applies_to` may say `departures`.

Return an empty list when nothing in the request expresses a preference (a one-off date, a
price limit or a destination is not a preference), or when you are unsure.

## The proposal

- `action` is `create` and `type` is `travel.preference`.
- `title`: a short name the person will recognise, at most about six words, for example
  `Business class` or `Departures from Boston`.
- `fields`: `kind` (`cabin`, `airline`, `airport`, `seat`, `meal` or `other`), `value` (the
  preference in a few words) and, when it narrows the preference, `applies_to`.
- `rationale`: one sentence in the second person saying what you saw, for example
  "You asked for business class on the Zurich booking."

Never put a name, an email address, a phone number, a payment detail, a quote id or a
confirmation id into any field, title or rationale.
