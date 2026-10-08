# Profiles extension v0 (`org.webagents:profiles-v0`)

Status: experimental, noncritical extension to [Agent Package v0](../agent-pkg-v0.md)
(`spec_version` 0.1). Schema: [`profiles-v0.schema.json`](profiles-v0.schema.json). First used by
WebAir 0.4.0 ([`agents/webair/MANIFEST.agent`](../../agents/webair/MANIFEST.agent)).

## 1. Purpose

A package declares everything it may need: permissions, tools, host resource types. Deciding on
each of them one by one is precise but long. A **profile** lets the publisher group what the package
already declares into a few named choices ("Search flights", "Search and quote", "Book"), each
with a one-line description and an estimate, so that a host can offer a short path to
authorization next to its full per-item view.

**A profile presents authority. It never grants it.** Choosing a profile produces the same
decisions a person could make item by item, and the host enforces those decisions exactly as it
enforces any other. A profile cannot name anything the package does not declare, cannot change the
package's policy, and conveys no authority by being present (Agent Package v0, §3: extensions are
noncritical).

## 2. Declaration

The value lives in the manifest's `extensions` object under the key `org.webagents:profiles-v0`:

```json
"extensions": {
  "org.webagents:profiles-v0": {
    "profiles": [
      {
        "id": "lookup",
        "title": "Look up only",
        "description": "Read the public timetable. Nothing personal is read or sent.",
        "permissions": ["network.timetable", "model.default"],
        "tools": ["read-timetable"],
        "resources": [],
        "estimate": {"model_calls": 1, "tool_calls": 1, "notes": "An illustration, not a measurement."}
      }
    ]
  }
}
```

The manifest is a payload member, so the profiles are covered by the integrity statement and the
publisher signature like every other declaration. The version is part of the key: a later format
that a v0 reader would misread gets a new key (`org.webagents:profiles-v1`), and a package may
carry both keys while hosts migrate.

## 3. Shape

All objects are closed: an unknown field fails validation.

| Field | Type | Meaning |
|---|---|---|
| `profiles` | array, 1 to 8 items | The profiles, in the order a host presents them (§4, rule 5). |
| `profiles[].id` | identifier | Unique within the package; a host may record it with the decisions it produced. Same pattern as Agent Package identifiers. |
| `profiles[].title` | one line, ≤ 60 characters | A short name for a person. |
| `profiles[].description` | one line, ≤ 240 characters | What the profile lets the agent do, for a person. |
| `profiles[].permissions` | unique identifiers | Permission ids from `policy.permissions`. |
| `profiles[].tools` | unique identifiers | Tool ids from the manifest's `tools`. |
| `profiles[].resources` | unique identifiers | Host resource types: the `resources` of the package's `personal.read` permissions. |
| `profiles[].estimate` | object, optional, at least one field | The publisher's estimate of one run (§6). |
| `estimate.model_calls` | integer ≥ 0 | Model calls. |
| `estimate.tool_calls` | integer ≥ 0 | Tool calls, including reads of host resources. |
| `estimate.tokens` | integer ≥ 0 | Total tokens the model provider reports (input and output). |
| `estimate.notes` | one line, ≤ 240 characters | How the estimate was obtained, or what makes a run larger. |

"Characters" are Unicode code points, as JSON Schema's `maxLength` counts them (a character
outside the Basic Multilingual Plane is one character, not two UTF-16 units). An "integer" is any
JSON number with a zero fractional part, as JSON Schema's `integer` type defines it: `1000` and
`1000.0` are the same estimate.

"One line" means a nonempty string with no control character (U+0000 to U+001F, U+007F to
U+009F) and no line or paragraph separator (U+2028, U+2029) anywhere, a trailing newline included:
no newline, no tab. Identifiers exclude the same characters. The schema states both rules as an
unanchored search for a forbidden character, which every regular-expression engine evaluates
alike; an anchored `^…$` pattern does not, because Python's `$` also matches before a final
newline.

## 4. Consistency rules

A value that passes the schema must also satisfy every rule below against the package it is in.

1. **Declared only.** Every permission id is declared in `policy.permissions`, every tool id in the
   manifest's `tools`, and every resource type in the `resources` of a declared `personal.read`
   permission.
2. **Required permissions included.** Every permission with `required: true` is in every profile.
   A profile without one could never be authorized.
3. **Tools bring their permissions.** For every tool in a profile, every permission the tool
   declares (its `permissions`, which the runtime checks at every call) is in the profile.
4. **Resources match their permissions.** A profile's `resources` are exactly the resource types
   named by the `personal.read` permissions it contains: a resource type is listed if and only if
   the permission that requests it is in the profile.
5. **Least authority first.** The first profile's permissions, tools and resources are each a
   subset of every other profile's. A host may therefore preselect the first profile without
   preselecting more than any alternative.
6. **Estimates within the policy.** `estimate.tokens` is at most `budget.hard_tokens`, and
   `estimate.tool_calls` is at most the sum of `budget.max_calls_per_tool` over the profile's tools.
7. **Unique ids.** No two profiles share an `id`.

The publisher's tooling checks these rules before signing; for WebAir that is
`python -m publisher check` in [`demo/webair`](../../demo/webair/README.md).

## 5. Host behaviour

- **Validate, then present or ignore.** A host that implements this extension validates the value
  against the schema and §4 after the package has been verified. If anything fails, it ignores the
  whole extension: it offers no profile, may say why, and falls back to its per-item view. It never
  applies part of an invalid value.
- **A profile becomes ordinary decisions.** Selecting a profile yields, for every member
  permission, a grant under the host's own rules (the person's defaults; a `payment` permission
  stays subject to the host's rule for consequential authority, such as a single use); for every
  member tool, the host's binding and a tool approval; for every member resource type, the person's
  choice of one resource of that type. Every declared permission and tool outside the profile is
  recorded as denied, with the profile as the source of that decision. The receipt and the run plan
  are built from these decisions exactly as from per-item ones; a host may record the selected
  profile's `id` beside them.
- **What a profile cannot do.** It does not change the policy, budgets, network rules, bindings,
  model requirements or `required` flags; it sets no grant duration; it never replaces signature,
  trust, compatibility, binding or resource checks; and it never makes the runtime call a tool or
  use a permission outside the decisions it produced. A call outside them is refused like any
  denied call.
- **The full view stays one step away.** A person can always open the per-item view and change any
  decision. Changed decisions are recorded as the person's own.
- **Present the members, not only the words.** Titles and descriptions are publisher text: render
  them as plain text, and show what a profile contains from its members (permission kinds, tool
  side effects, resource types), so that a misleading title cannot hide a payment permission.
- **Hosts that do not implement it** ignore the key like any unknown extension. The package remains
  valid and usable through per-item decisions.

Reference runtimes: since T7 the `agentpkg` control plane validates this extension and accepts the
selected profile with an authorization (`profile_id`). A declared tool outside it that the person
did not approve is then recorded as denied in the receipt and the run plan, gets no binding, and
the runtime refuses any call to it; without a profile every declared tool still needs an approval
([`docs/tool-broker.md`](../../docs/tool-broker.md) §6a). The Chrome Agent Browser applies the same
rule and records who decided each item.

## 6. Estimates

An estimate is the publisher's statement of what the largest ordinary run the profile is meant for
uses, in the units a runtime reports: model calls, tool calls (host-resource reads included) and
total reported tokens. It is information for the person, not a budget: the policy's budgets remain
the limits, and rule 6 only ensures that an estimate does not promise more than the policy allows.
It carries no cost, because cost depends on the model the person chooses; a host can derive one
from its own model catalog. A host shows it as the publisher's estimate and may compare it with its
own run records. A publisher should derive it from recorded runs and say so in `notes`.

## 7. WebAir 0.4.0

WebAir declares three profiles, each containing the previous one:

| Profile | Adds | Personal data |
|---|---|---|
| `search` "Search flights" | WebAir's network permission, the model and session memory; `search-flights`, `get-fare-rules` | none |
| `quote` "Search and quote" | `profile.travel`, `identity.passenger`; `personal.travel_profile`, `personal.passenger_identity`, `prepare-booking` | travel profile, passenger identity |
| `book` "Book (simulated)" | `wallet.payment`, `booking.simulate_purchase`; `wallet.payment_method`, `simulate-purchase` | plus the demo payment method |

The authoritative values, including the estimates and where they come from, are in the signed
manifest and in [`demo/webair/README.md`](../../demo/webair/README.md).
