# Cross-runtime divergence log

This is the divergence log of experiment E8 in [`experiments/PROTOCOL.md`](../experiments/PROTOCOL.md)
(section "E8 · The conformance report and the divergence log"). It lists every difference between the two
runtimes that execute the Agent Package Format and its profiles, the Python reference (`agentpkg`) and the
TypeScript core of the Chrome Agent Browser, that a conformance case, a unit or parity test, a review or a
live run found in tasks T1 to T26 and that was then fixed or kept as a documented, allowed difference. Each
row cites the task and the place where it is recorded, how it was found, which runtime differed, its class,
its resolution and the commit that resolved it. The conformance suite's own comparison rules are in
[`conformance/README.md`](../conformance/README.md); this file is the history behind them.

Reading the log. **Py** is the Python reference, **Cr** the Chrome core, **both** a difference that belongs to
neither side alone (an engine, a CLI design, a scheduler). The reference side of a few early rows (marked
"plugin ref." in the Wrong column) is the frozen OpenClaw plugin (D-029) rather than `agentpkg`. A row's **Recorded at** cites a task spec as `T<n>:<lines>`
(`.claude/project/tasks/T<n>_*.md`), a decision as `D-<n>` (`.claude/project/DECISIONS.md`), or a repository
path. The task specs and DECISIONS.md are local, git-ignored project files (D-017); every row also names a
commit, so a reader without them can follow the history in `git log`.

## Method

Read, for T1 to T26 (T1 to T7, T5a, T8 to T26; all spec files were read, six readers each took a range of tasks):
every task spec's Progress log, Completion report, Carry-over sections and every Review, Resolution and Response
section, in `.claude/project/tasks/T*.md`; the DECISIONS.md entries those sections cite (among them D-022,
D-030, D-033, D-038, D-044, D-053, D-063 to D-067, D-078 to D-092, D-107, D-115, D-121, D-125, D-151 to D-154,
D-216, D-228 to D-235, D-240 to D-254, D-292); `conformance/README.md` and the documented-difference cases of
`conformance/run.mjs`; the summary of each of the kept reports `conformance/results/*/report.json` (see below);
and the Agent Memory comparison against T19's core in `examples/verification/conformance-t20-against-t19-core/report.md`.
Search terms used to seed the reading: `diverg`, `differ`, `mismatch`, `parity`, `disagree`, `byte for byte`,
`the other runtime`, `Chrome (does|did|accepts|refuses|rejects)`, `Python (does|did|accepts|refuses)`,
`reference (does|accepts|refuses)`, `port`.

Rules for a row. (1) Both runtimes, or one runtime and a specification the other already followed, are named
in the source, and the source says they differed on the same input or the same rule. (2) The difference was
found by a check (`suite`: a conformance case; `test`: a unit, vector or parity test; `review`: a reviewer
read the code; `live`: a live run) and ended in a fix or in a recorded, allowed difference. (3) The class is one
of four. **behaviour**: a different outcome, refusal, output, audit event or accepted input. **wording**: the same
outcome with different message text, error string, label or field name. **timing**: ordering, concurrency,
timeouts, clocks or event order within a wave. **platform**: a property of the language or platform: JSON
number rendering, Unicode and regex semantics, ZIP and CRC, a crypto library, floating point, JavaScript's
inherited `Object.prototype` names, a WebAssembly engine. (4) The commit is the one that made the runtimes agree
or recorded the difference; each short SHA was resolved with `git cat-file -t`. The date column is that commit's date. Rows
are in the order of those commits. For every row, one quotation from its cited source was checked to occur verbatim in that file.

Not in the table, on purpose: differences designed in at a plan gate and never found by a check (the table of
"Designed-in differences" below), differences found and still open ("Found and not resolved"), and borderline
items ("Not counted").

Kept conformance reports. The suite's kept reports pass at every kept commit except the `pending` ones, so the
history of failures is in the task specs, not in `conformance/results/`: of the 33 report directories, the
two of 2026-10-15 (`2026-10-15T02-47-56-123Z`, `2026-10-15T04-08-54-999Z`) carry `pending_reason` for Agent Memory
cases the then-current Chrome core refused by version, and `2026-10-17T11-48-42-996Z` for the Agent Compute case
(see "Not counted"); the next kept report in each case (`2026-10-15T12-42-55-302Z`, `2026-10-17T23-36-27-118Z`) has
no pending case. Figures: see the summary.

## Summary

**67 divergences**, 40 fixed and 27 documented. The counts below are computed from the table.

### By class and resolution

| Class | fixed | documented | total |
|---|---:|---:|---:|
| behaviour | 21 | 9 | 30 |
| wording | 5 | 2 | 7 |
| timing | 1 | 6 | 7 |
| platform | 13 | 10 | 23 |
| **all** | 40 | 27 | 67 |

### By how it was found

| Found by | fixed | documented | total |
|---|---:|---:|---:|
| suite | 6 | 9 | 15 |
| test | 2 | 10 | 12 |
| review | 32 | 6 | 38 |
| live | 0 | 2 | 2 |

### By runtime that differed

| Wrong | fixed | documented | total |
|---|---:|---:|---:|
| Cr (Chrome core) | 31 | 11 | 42 |
| Py (Python reference) | 6 | 2 | 8 |
| both / neither alone | 3 | 14 | 17 |

Rows whose reference side is the OpenClaw plugin rather than `agentpkg`: 3 (DV-29, DV-31, DV-34).

### By task

A row that names two tasks (the finding in one, the fix or the carry-over in the other) is counted under the task of its first number, which is where it was found; the Task column of the table keeps both.

| Task | behaviour | wording | timing | platform | fixed | documented | total |
|---|---:|---:|---:|---:|---:|---:|---:|
| T1 | 6 | 1 | 0 | 7 | 12 | 2 | 14 |
| T2 | 0 | 0 | 0 | 1 | 1 | 0 | 1 |
| T3 | 2 | 0 | 0 | 4 | 3 | 3 | 6 |
| T4 | 2 | 1 | 3 | 3 | 4 | 5 | 9 |
| T5 | 1 | 0 | 0 | 0 | 0 | 1 | 1 |
| T6 | 0 | 0 | 1 | 2 | 0 | 3 | 3 |
| T7 | 2 | 4 | 1 | 2 | 5 | 4 | 9 |
| T18 | 1 | 0 | 0 | 0 | 1 | 0 | 1 |
| T19 | 1 | 0 | 0 | 0 | 1 | 0 | 1 |
| T20 | 6 | 0 | 1 | 0 | 6 | 1 | 7 |
| T21 | 3 | 0 | 1 | 4 | 1 | 7 | 8 |
| T23 | 0 | 1 | 0 | 0 | 1 | 0 | 1 |
| T24 | 4 | 0 | 0 | 0 | 4 | 0 | 4 |
| T25 | 1 | 0 | 0 | 0 | 1 | 0 | 1 |
| T26 | 1 | 0 | 0 | 0 | 0 | 1 | 1 |

Tasks that no row names: T9, T10, T11, T12, T13, T14, T15, T16, T17. T5a (a Demo 3 fix task) and T9, T10, T13, T15 appear only in the sections below; T11, T12, T14, T16 and T17 changed one runtime or the extension only. A task that is the Python half of a pair (T23, T25) is named in the row of the Chrome task that ported its finding. The class is by symptom except where the cause is a language, library or engine property (see the rules).

## The log

| ID | Date | Task | Recorded at | Found | Wrong | Class | Resolution | Commit | Divergence |
|---|---|---|---|---|---|---|---|---|---|
| DV-1 | 2026-10-06 | T2 | T2:202 (review 1, finding 1; response 216-227; round 2 255-266), D-044 | review | Py | platform | fixed | `5fdddd4` | Python's `re` lets `$` match before a trailing newline, so the publisher's profile check accepted a title, description or id ending in a line break that a JavaScript validator (the Chrome host's copy) refuses; the schema now uses an engine-independent pattern. (The Python side here is the publisher tooling, not the agentpkg runtime.) |
| DV-2 | 2026-10-06 | T1 | T1:350-362 (review 1, finding 1; response 448-456), D-030 | review | Cr | behaviour | fixed | `835f9de` | A package member whose `$id` is the draft 2020-12 meta-schema poisoned the Chrome core's process-wide schema dialect, so later invalid integrity, manifest and policy documents were accepted; Python's per-call registry stayed strict. |
| DV-3 | 2026-10-06 | T1 | T1:375-382 (review 1, finding 3; response 463-468), D-033, B-109 | review | Cr | behaviour | documented | `5cbdada` | Website discovery in the Chrome core followed redirects without checking hops; it now refuses every redirect (`discovery_redirect_refused`), while the reference follows same-origin hops (difference kept in D-033). |
| DV-4 | 2026-10-06 | T1 | T1:383-389 (review 1, finding 4; response 469-476) | review | Cr | platform | fixed | `5cbdada` | The TypeScript ZIP reader accepted central flags 0x20 and 0x40 and a multi-disk last record that Python's zipfile refuses; it now refuses them with zipfile's messages. |
| DV-5 | 2026-10-06 | T1 | T1:390-392, 282, 601-605 (review 1 finding 4; review 2 nit 9), D-038, B-108 | review | Py | platform | documented | `5cbdada` | The Chrome ZIP reader is stricter than Python's on flag bits, disk-number-start and internal attributes, so Python accepts archive layouts the Chrome core refuses (B-108 keeps the tightening of agentpkg open). |
| DV-6 | 2026-10-06 | T1 | T1:393-398 (review 1, finding 5; response 477-486) | review | Cr | platform | fixed | `5cbdada` | A step reference `/constructor` or a profile with `tools: ["toString"]` hit JavaScript's inherited `Object.prototype` members and ended in `internal_error` or a CLI crash where Python reports a validation error. |
| DV-7 | 2026-10-06 | T1 | T1:399 (review 1, finding 5; response 483-484) | review | Cr | platform | fixed | `5cbdada` | `properties["toString"]` made the Chrome core refuse an open-schema path that Python accepts (inherited-name lookup). |
| DV-8 | 2026-10-06 | T1 | T1:407-412 (review 1, finding 8; response 494-498) | review | Cr | behaviour | fixed | `5cbdada` | The Chrome HTML attribute unescaper decoded six named references where Python's `html.unescape` decodes the full set, so `&sol;&sol;evil.example/...` was refused as cross-origin by Python and accepted as a same-origin path by the Chrome core. |
| DV-9 | 2026-10-06 | T1 | T1:413-415 (review 1, nit 9; response 499) | review | Cr | platform | fixed | `779e9c7` | The Ed25519 fallback library verified with cofactored ZIP-215 rules (accepting non-canonical encodings) where the reference's OpenSSL verification is strict. |
| DV-10 | 2026-10-06 | T1 | T1:420-421 (review 1, nit 11; response 504-506) | review | Cr | platform | fixed | `779e9c7` | The trust store's text limit counted UTF-16 units where Python counts code points (150 emoji refused in Chrome, accepted in Python). |
| DV-11 | 2026-10-06 | T1 | T1:421-422 (review 1, nit 11; response 504-506) | review | Cr | platform | fixed | `779e9c7` | JavaScript `trim()` and Python `str.strip()` strip different whitespace sets in the trust store's text; the Chrome core now strips Python's set. |
| DV-12 | 2026-10-06 | T1 | T1:433-436 (review 1, nit 14; response 518-522), D-038 | review | Cr | wording | fixed | `5cbdada` | Refusal messages quoted differently: the Chrome core printed `Bad CRC-32 for file graph.json` and `"../evil.txt"` where Python prints `file 'graph.json'` and `'../evil.txt'`; a `repr`-style quoter was added. |
| DV-13 | 2026-10-06 | T3 | T3:118 (progress log, commit 2), D-053 | test | Cr | behaviour | documented | `63aa2c2` | The Chrome receipt and plan carry fields the Python records do not (`control_plane.service`, `provenance`, `execution.denied_tool_ids`, `execution.note`); the field-by-field fixture comparison masks them as documented differences. |
| DV-14 | 2026-10-06 | T3 | T3:118 (same sentence); chrome-agent-browser/test/core/runplan.test.ts:33-35 | test | both | platform | documented | `63aa2c2` | The two runtimes format ISO timestamps in the receipt and plan differently, so the fixture comparison compares them by epoch. |
| DV-15 | 2026-10-06 | T3 | T3:412-416 (review 1, nit 18), T3:212-214, D-053 | review | Cr | behaviour | documented | `63aa2c2` | The Chrome plan's `execution.required_tool_ids` lists only approved tools while the reference lists every declared tool, so the same field holds different content once tools are denied (kept; the user confirmed D-053's meaning). |
| DV-16 | 2026-10-07 | T3 | T3:321-328 (review 1, finding 1; answer 147-155; verified 453-455) | review | Cr | platform | fixed | `e14be90` | `authorize` with `decisions: {"constructor": "session"}` made the Chrome core issue a receipt granting `constructor` (inherited property name) where Python refuses `unknown_permission`. |
| DV-17 | 2026-10-07 | T3 | T3:150-152 (progress log, found while testing finding 1) | test | Cr | platform | fixed | `e14be90` | The Chrome message parser silently dropped a `__proto__` key (assigning it sets the prototype), so it was never refused by name as the reference does. |
| DV-18 | 2026-10-07 | T1/T4 | T1:560-569 (review 2, should-fix 1), carried at T4:104-110, fixed per T4:255 | review | Cr | behaviour | fixed | `f2597e0` | The Chrome core's schema registry fetched a remote `$ref` (a probe made a real GET) where Python's registry never retrieves. |
| DV-19 | 2026-10-07 | T1/T4 | T1:576-582 (review 2, should-fix 3), carried at T4:111-115, fixed per T4:255 | review | Cr | behaviour | fixed | `f2597e0` | A declared schema with `$dynamicAnchor` and no `$dynamicRef` made the Chrome fixture check throw `invalid JSON Schema` where agentpkg accepts the package. |
| DV-20 | 2026-10-07 | T1/T4 | T1:613-614 (review 2, nit 12), carried at T4:116-118 | review | Cr | behaviour | fixed | `f2597e0` | The Chrome CLI ignored unknown flags and exited 0 where `agentpkg` exits 2 with `unrecognized arguments`. |
| DV-21 | 2026-10-07 | T4 | T4:137-140, 229-232, 256, 323-324; D-063 | test | Cr | timing | documented | `43e3607` | Schema validation is asynchronous in the Chrome core, so coordinator-level audit events of nodes in one wave interleave at `await` where Python records them back to back; the audit is compared as an ordered backbone plus a per-wave multiset. |
| DV-22 | 2026-10-07 | T4 | T4:256, 327; D-063 | test | both | timing | documented | `43e3607` | Worker instance suffixes in `usage.json` (Literature Review) follow spawn order, which concurrency decides, so rows are folded by role before comparison. |
| DV-23 | 2026-10-07 | T4 | T4:140-143, 228-229; D-063; BACKLOG B-115 | test | Cr | platform | documented | `43e3607` | Python writes the fixture's integral JSON floats as `1.0` where JavaScript cannot tell them from `1`, so Literature Review's synthetic token count could differ; the value is allowlisted and printed (both runtimes agree today, 35732). |
| DV-24 | 2026-10-07 | T4 | T4:227-228, 322-323; D-063 | test | both | wording | documented | `43e3607` | `provenance.interpreter` names the runtime (`agentpkg.workflow.Workflow` against `chrome-agent-browser.workflow.Workflow`), masked in the comparison. |
| DV-25 | 2026-10-07 | T4 | T4:260 (progress log, commits 6-7), D-064 | test | Cr | behaviour | fixed | `43e3607` | Without `--limits` the Chrome CLI applied a host ceiling, so the `limits` recorded in usage differed from agentpkg's; it now applies none (`PERMISSIVE_HOST_LIMITS`). |
| DV-26 | 2026-10-07 | T4 | T4:481-486 (review 1, finding 3; fix row 551; review 2 595-596), D-066 | review | Cr | platform | fixed | `cc69b6a` | The `sum` assertion added naively in the Chrome core where CPython 3.12 and later compensates, so `sum([0.1,0.2,0.3]) == 0.6` held in Python and not in Node; `pySum` reproduces CPython's sum (23 vectors). |
| DV-27 | 2026-10-07 | T4 | T4:384-386, 262; D-066; B-115 | test | Cr | platform | documented | `cc69b6a` | The Chrome core reads a safe integral JSON number as a Python int, so a `1.0` between large floats sums differently (`[1e16, 1.0, -1e16]` is `1.0` in Python, `0` in the port); printed by the vector test. |
| DV-28 | 2026-10-07 | T4 | T4:487-494 (review 1, finding 4; fix row 552; review 2 597-603), D-067 | review | Cr | behaviour | fixed | `99b0b7a` | The Chrome Node transport did not resolve and classify addresses, so `https://localhost./` passed where agentpkg's `netaddr` (and the plugin broker) refuse non-public addresses; two CPython address-list details were corrected from 116 vectors. |
| DV-29 | 2026-10-07 | T4 | T4:495-500 (review 1, finding 5; fix row 553), D-066 | review | Cr (plugin ref.) | timing | fixed | `fdc972d` | The Chrome core never enforced a binding's own `timeoutSeconds`; the reference broker bounds the pacer wait and the dispatch by min(bound, definition). |
| DV-30 | 2026-10-07 | T3/T5 | T3:476-489 (review 2, nit 19), carried at T5:87-90 and fixed per T5:243, T5:349 | review | Cr | platform | fixed | `9356fa4` | For a task capability named `constructor`, `toString` or `valueOf`, the Chrome compatibility check read an inherited `Object.prototype` member and said `incompatible` where Python says `unverified`. |
| DV-31 | 2026-10-07 | T5 | T5:316 (completion report, deviations); D-022, D-090 | live | Cr (plugin ref.) | behaviour | documented | `457bb95` | For an unapproved tool the reference records `permission.checked allowed=false`; the Chrome core refuses before the permission check and records `tool.failed PolicyError`; the cross-runtime live verifier accepts either form. |
| DV-32 | 2026-10-08 | T6 | T6:117, 193; D-082 | test | both | platform | documented | `ccc8377` | For a PDF byte with no glyph in StandardEncoding, pypdf falls back to Latin-1 and pdf.js yields a space; asserted by the pypdf-generated vectors. |
| DV-33 | 2026-10-08 | T6 | T6:119 (progress log, `b739d5a`); D-082 | test | both | platform | documented | `ccc8377` | pdf.js omits text placed past the page edge where pypdf extracts it, so a page pypdf refuses as `page_text_too_large_on_page` can be accepted by the Chrome reader. |
| DV-34 | 2026-10-08 | T6 | T6:122-123, 149, 188-190; D-081 (amendment) | live | Cr (plugin ref.) | timing | documented | `c915f8a` | The reference's Node transport opens one connection per request, so its start-to-start pacing holds; Chrome reuses a connection and the second Crossref request arrived under a second later (HTTP 429), so the Chrome pacer also waits after the previous answer and the two pacers follow different rules (D-081). |
| DV-35 | 2026-10-08 | T7 | T7:63, 81; D-090; conformance/README.md (Recorded differences) | suite | Cr | behaviour | documented | `1c552fd` | Without a profile the Chrome runtime treats every unapproved tool as denied and plans without it, while the Python control plane requires every declared tool approved before a plan exists. |
| DV-36 | 2026-10-08 | T7 | T7:63, 90; D-090 | suite | Py | wording | fixed | `1c552fd` | Python's profile refusal was `unknown_profile` (status and message differing); renamed to Chrome's `profile_unknown`. |
| DV-37 | 2026-10-08 | T7 | T7:63, 81; D-091 | suite | Cr | wording | fixed | `1c552fd` | For a failure inside a map step the Chrome CLI printed `at node <node>/<step>` where agentpkg prints the node only; pinned by a CLI test. |
| DV-38 | 2026-10-08 | T7 | T7:63, 81; D-091; conformance/README.md | suite | both | behaviour | documented | `1c552fd` | For a denied required permission or an over-used `once`, `agentpkg run` refuses at the first use with artifacts written while the Chrome CLI refuses before anything runs; the suite checks each CLI and both execution layers (same code and message). |
| DV-39 | 2026-10-08 | T7 | D-091 (suite design); conformance/README.md (One normalization) | suite | both | wording | documented | `1c552fd` | A spent `once` is refused as `authorization_once_spent` by the Chrome lease and as `run_plan_stale` carrying that stale reason by the Python control plane; the suite compares the reason and prints both raw codes. |
| DV-40 | 2026-10-08 | T7 | T7:63, 81, 119-120; D-092 | suite | both | timing | documented | `1c552fd` | With `files.pdfs` denied, the refusal happens inside the screening map; Python had charged two `screen-one` calls (32,175 tokens) and Chrome none (6,350), so partial sibling events and tokens are not compared. |
| DV-41 | 2026-10-08 | T7/T8 | T7:163-169 (review 1, finding 2); T8:70-72; D-107 | review | Py | platform | fixed | `03eb922` | A profile with `estimate: {tokens: 1000.0}` was ignored as a whole by agentpkg and offered by the Chrome core (`Number.isInteger`); an integer is now any number with a zero fractional part in both. |
| DV-42 | 2026-10-08 | T7/T8 | T7:171-174 (review 1, finding 3); T8:70-72; D-107 | review | Cr | platform | fixed | `03eb922` | Python counted profile title and description length in code points and Chrome in UTF-16 units, so a 60-character title of astral characters passed Python and failed Chrome. |
| DV-43 | 2026-10-08 | T7/T8 | T7:175-178 (review 1, nit 4); T8:73; D-107 | review | Py | wording | fixed | `03eb922` | Python's note quoter escaped only `\` and `"`, so a control character in an unknown profile field name produced a note different from Chrome's `JSON.stringify`; it now uses `json.dumps(ensure_ascii=False)`. |
| DV-44 | 2026-10-14 | T18/T20 | T18:146 (progress log, session 2); T20:108, 186-187; D-216 | review | Py | behaviour | fixed | `e45d059` | The Chrome core scanned tool arguments for sealed values while agentpkg's runtime had no scan of its own; T20 added agentpkg's tool and model egress scans (M-36, M-37). No same-input run is reported. |
| DV-45 | 2026-10-15 | T19/T20 | T19:128, 143; T20:299-306 (review 1, finding 2), 358-360; D-228, D-234 | review | Py | behaviour | fixed | `ef8b387` | Python refused every custom-type proposal with `memory_proposal_type_undeclared` while the Chrome core resolved the type's local id through the package's aliases (Chrome fixed first in `2ab27f6`). |
| DV-46 | 2026-10-15 | T20 | T20:314-317 (review 1, finding 4), 365-367, 238, 456; D-234 | review | both | timing | documented | `ef8b387` | Python commits the agent document at the terminal event, before `memory.agent.committed`, and has a `store_failed` discard reason; the Chrome store commits after the run and never emits it. |
| DV-47 | 2026-10-15 | T20 | T20:307-313 (review 1, finding 3), 361-364, 139-141; D-234 | review | both | behaviour | fixed | `f64762c` | A grant of a package's custom type by its local id was refused by Python (`memory_type_unknown`, `memory_proposal_target_not_granted`) and the Chrome `MemoryRun` lacked the same alias resolution; both resolve it now. |
| DV-48 | 2026-10-15 | T20 | T20:286-298 (review 1, blocker 1), 352-357, 139-140; D-234 | suite | both | behaviour | fixed | `f64762c` | After Python's tool scan checked every sealed value, T19's Chrome scan still stopped at the first hit and let an echo carrying a granted and an ungranted value through (case `memory/m36-two-sealed-values`); Chrome now checks all (`findAllSealed`). |
| DV-49 | 2026-10-15 | T20 | T20:126-127, 139-141; examples/verification/conformance-t20-against-t19-core/report.md (cases literature-review-0.2.8/memory, memory-probe/fixture); D-230 | suite | Cr | behaviour | fixed | `f64762c` | Python derived a grant for each replayed `host.memory.<type>` view in fixture mode while T19's Chrome core held none, so Chrome failed `memory_proposal_link_not_granted` / `memory_proposal_target_not_granted` where Python completed. |
| DV-50 | 2026-10-15 | T20 | T20:126-127; report.md (cases memory-probe/granted-sealed-value, memory/m36-sealed-value-to-a-tool); D-230 | suite | Cr | behaviour | fixed | `f64762c` | Python held a replayed legacy `host.resource.<legacy>` answer as a granted pseudo-record (`fixture:<binding>`); Chrome held no grant, so one case was refused where Python completed and the other recorded `permission.checked` decision `deny` against `session`. |
| DV-51 | 2026-10-15 | T20 | T20:127, 208; report.md (case memory/n6-view-mismatch); D-230, D-234 | suite | Cr | behaviour | fixed | `f64762c` | N6 (a memory view of the wrong schema): Python refused before the run with `binding_schema_mismatch` and wrote nothing, while the Chrome CLI ran, refused `permission_denied` at runtime and wrote files; it now checks before planning with the same message. |
| DV-52 | 2026-10-15 | T20 | T20:435-440 (review 2, nit 4), 478-482; D-235 | review | both | behaviour | fixed | `cf649ef` | A `memory.read` of `host.memory.agent.notes` was refused `memory_type_unknown` by Python and run by Chrome (which skipped the whole `agent.` prefix); both now refuse `memory_type_reserved` at validation. |
| DV-53 | 2026-10-17 | T21/T22 | T21:425 (review 1, nit 6), 464-466; T22:89-90, 128-130; D-251; B-224 | review | Py | timing | documented | `e67ffeb` | The Chrome core terminates the nested Worker at once on cancel or node timeout, while the Python thread keeps running to `timeout + 1` s (and to the wall bound after cancel, a workflow deadline or a map timeout); the node's reason is the same. Recorded in D-251, not printed by the suite. |
| DV-54 | 2026-10-17 | T21/T22 | T22:127-135, 150-152; D-244 (DECISIONS:3321-3323); conformance/README.md | suite | both | platform | documented | `174564d` | wasmtime meters fuel and ends a runaway module with `fuel_exhausted`; V8 meters none, so the Chrome wall deadline reports `deadline`; the normalizer folds both to `bound_reached`. |
| DV-55 | 2026-10-17 | T21/T22 | T22:216-218; D-250 (DECISIONS:3368-3370); spec C-46 | test | Cr | platform | documented | `174564d` | After a deadline wasmtime can still read the memory size, a terminated Chrome Worker cannot, so `compute.failed` carries `memory_pages: null` and the field is not compared after either bound. |
| DV-56 | 2026-10-17 | T21/T22 | D-244 (DECISIONS:3311-3316); D-250 (3362-3365, 3374-3376); T22:132-137 | suite | both | platform | documented | `174564d` | `engine` (`wasmtime-py/...` against `chrome/<UA>` or `node/<version>`) and `limits.fuel` in the compute audit facts are the engines' own and are dropped from the comparison. |
| DV-57 | 2026-10-17 | T21/T22 | conformance/README.md (compute.v0, N-17); conformance/run.mjs:653-656, 672-682; D-091 | suite | both | behaviour | documented | `174564d` | A module whose memory maximum is over the host ceiling (N-17) is refused in the runtime preflight by `agentpkg run` (`compute_limit_exceeded`) and in the execution layer by the Chrome CLI; both execution layers refuse `execution_compute_limit_exceeded` identically. |
| DV-58 | 2026-10-17 | T21/T22 | conformance/README.md (compute.v0, N-19); conformance/run.mjs:684-688; D-091 | suite | both | behaviour | documented | `174564d` | A denied `compute.modules` permission (N-19) is `permission_denied at node compute` after the run started in `agentpkg run` and a refusal before the run in the Chrome CLI (`execution_permission_denied` in the execution layers). |
| DV-59 | 2026-10-17 | T21/T22 | T22:259-261, 460-471 (review 1, finding 1), 518-528, 584-599 (review 2), 628-639; D-254; spec C-42, C-46 | review | Cr | platform | documented | `0361864` | wasmtime reports a `call_indirect` through a null slot and a signature mismatch separately; the V8 in Node 24 and 26 reports one message for both (Chrome 155's V8 tells them apart), so the normalizer compares both as `indirect_call_failed`. |
| DV-60 | 2026-10-17 | T21/T22 | T22:472-478 (review 1, finding 2), 529-531; T21:497, T22:95-97, 220-223 | review | Cr | behaviour | fixed | `d0b53a0` | After a refused compute preflight the Chrome `cancel()` kept answering `running: true`, while the Python session (fixed in `8615205`) answers `running: false`. |
| DV-61 | 2026-10-21 | T23/T24 | T24:470 (review 1, nit 11), 501 | review | Cr | wording | fixed | `52f2399` | The Chrome `converse` CLI kept a duplicate `--approve-tool` check that T23 removed from `agentpkg converse`, so the same undeclared tool was refused with different messages. |
| DV-62 | 2026-10-21 | T24 | T24:559-562 (review 2, nit 5), 589 | review | Cr | behaviour | fixed | `45c50df` | In live mode an undeclared `--approve-tool` was refused by agentpkg before any network and by the Chrome CLI only after it had queried model providers (with an unreachable Ollama: `selected_model_unavailable`). |
| DV-63 | 2026-10-21 | T24 | T24:636-640 (review 3, nit 3, first half), 667 | review | Cr | behaviour | fixed | `6bc61b2` | A bad `conversation_*` host limit was validated by the Chrome CLI only after `bindLive`, so live mode answered `selected_model_unavailable` where agentpkg refuses the limit. |
| DV-64 | 2026-10-21 | T24 | T24:638-639 (review 3, nit 3, second half), 667 | review | Cr | behaviour | fixed | `6bc61b2` | The Chrome CLI normalized limits before the grant check while the reference checks grants, tools, then limits, so two wrong inputs produced different refusals. |
| DV-65 | 2026-10-24 | T25/T26 | T25:504-508 (review 1, nit 9), 248; T26:53-63, 85, 131-132 | review | Cr | behaviour | fixed | `8c71a6c` | After the schema sync the Chrome core admitted `network` without the `network_minimum_version` rule, so with `minimum_version` lowered to 0.6.0 the shipped examples were refused for a different reason than the reference's rule. |
| DV-66 | 2026-10-24 | T26 | conformance/README.md (network.v0, N-28, N-29; Recorded differences); T26:120; D-091; conformance/run.mjs:749-754 | suite | both | behaviour | documented | `8c71a6c` | A `once` grant used by more than one delegation is refused by `agentpkg run` at the first use (`permission_denied` at `delegate`) and by the Chrome CLI before the run; both execution layers refuse `execution_grant_unsupported` with one message. |
| DV-67 | 2026-10-24 | T24/T26 | T24:708-713 (review 4, nit 2); T26:47-49, 87 | review | Cr | behaviour | fixed | `f4f7c2d` | In fixture mode, a bad conversation limit with an existing `--out` was refused for the limit by the Chrome CLI and for `--out` by agentpkg (a regression of the previous fix). |

## Designed-in differences

Differences chosen at a plan gate or in a design decision and implemented on purpose, not found by a check.
They are recorded allowed differences and none is counted above. Where the suite prints one, the row says so.

| Task | Recorded at | Class | Commit | Difference |
|---|---|---|---|---|
| T13 | T13:77-78, 153, 165, 192, 202; D-151, D-154; spec section 7 | behaviour | `e622d64` (Chrome re-asks), `0ffc670` (agentpkg 0.3.0 evaluates the checks, no re-ask), `5ea8911` (spec), task merge `d1c0c17` | On a refused live answer (schema miss or failed answer check) the Chrome bound router asks up to two more times with a feedback line; agentpkg fails the node at once with `model_error`. Fixture mode declares no re-asks, so fixture parity holds; the port is B-153 and is open. |
| T13 | T13:79, 90, 156, 166-167, 187; D-152, D-153, D-154 | behaviour | `77f5016` | The Chrome host retries read-only tool calls on transient failures (up to twice) and falls back to `api.crossref.org/works/{doi}` for a DOI `citation.resolve`; the Python tool path ends the call with the first failure. Fixture tools are never retried. |
| T9 | T9:144; D-115 | behaviour | `a33f616` | In live runs the Chrome core re-asks once after a `model_output_not_conforming` answer; the reference does not. |
| T10 | T10:262; D-121, D-122 | behaviour | `bcceb05` | Chrome sends a strict `json_schema` format to OpenAI (decoding optional-property nulls, unwrapping array-root envelopes); the reference's OpenAI route sends no format. Fixture mode is unconstrained. |
| T7 | T7:35-37; D-022, D-090 | behaviour | `ff60b74` | Python ignored the profiles extension until T7 ported it (`browser/profiles.py`); a known gap closed as a planned deliverable, not found by a check. |
| T7 | D-090 (DECISIONS:1245-1247) | wording | `ff60b74` | For an unreachable plan shape (some tools denied, the rest unbound, none bound) Chrome refuses `tools_not_supported` and Python `tool_not_bound`; stated by the implementer, no case reaches it. |
| T4 | T4:376-377; D-064 | behaviour | `43e3607` | The Chrome `run` executes signed packages only and takes the host execution limits document for `--limits`; `agentpkg run` accepts an unsigned development build. |
| T4 | T4:386-387; D-067 | timing | `99b0b7a` | The Node transport destroys the socket where the Python runtime kills a child process. |
| T21 | spec/compute-v0.md C-19, C-47; D-241 | platform | `ab3f9b9` | The bit pattern of a NaN produced by a floating-point operation: the reference's wasmtime canonicalizes it, Chrome's engine may not; the publisher owns it. |
| T26 | spec/network-v0.md R-28; D-282, D-292 (host fact 1); T25:401 (B-241) | behaviour | `8c71a6c` | When a chosen route fails the transition check, Python fails the call (`model_output_not_conforming`); the Chrome core re-asks up to twice inside the bound, each attempt charged and audited. Fixture conformance does not exercise it. |

## Found and not resolved

Found by a review or test, recorded in the backlog, and still open at the commit this file is written on.

| Task | Recorded at | Class | Difference |
|---|---|---|---|
| T2 | T2:253; BACKLOG B-106 | platform | agentpkg's own `graph`, `eval`, `audit-event` and `integrity` schemas use anchored `^...$` patterns; under Python's `jsonschema` `$` also matches before a final newline, so an id `"search\n"` passes in Python and fails in the Chrome core's copy. |
| T2 | T2:249-253 | platform | The Chrome `profiles.ts` one-line check used a control-character class and `String.length`; the length unit was fixed in DV-42 (`03eb922`); the character class is not recorded as fixed: `chrome-agent-browser/src/core/profiles.ts:16` and `agentpkg/src/agentpkg/browser/profiles.py:26` still use the same `[^\u0000-\u001f\u007f]` class (not compared here with the D-044 schema). |
| T4 | T4:623-627 (review 2, nit 3), 657-658; B-115 | platform | `pySum` treats integers above 2^53 as floats where CPython keeps its integer phase exact (`[0.1, 2**60, -2**60]` is `0.0` in Python and `0.1` in Node). |
| T4 | T4:472-480 (review 1, blocker 2); B-114; Chrome fix `337e157` | behaviour | After the Chrome fix, its egress scan refuses a sealed value nested 41 deep or after 5,000 strings; the frozen reference plugin's walk stops at depth 32 or 4,096 strings and lets it leave (a bug-fix item for the reference line). |
| T9, T10 | T9:249-256 (review 1, finding 4); T10:107-111, 316-317; D-125; B-142 | behaviour | Chrome stopped charging a token count as a remote call (one remote call per model request); agentpkg still charges two. D-125 decides both adopt the rule; the agentpkg change is staged as B-142 (no `remote_count` in `agentpkg/src`). Fixture conformance cannot see it. |
| T13 | T13:249 (review, finding 10); T15:31; B-170 | behaviour | `agentpkg/src/agentpkg/hostbridge/router.py:173-174` treats `feedback: null` in a model request as absent where the Chrome renderer refuses it; unreachable because both validate the request first. |
| T22 | T22:264-265, 370-371, 553-554; B-230 | wording | For a module the reader accepts and the engine refuses, Python's `module_invalid` message carries wasmtime's first line (`agentpkg/src/agentpkg/compute/engine.py:216`) and Chrome's carries none (`chrome-agent-browser/src/core/compute/engine.ts:89`); no conformance case reaches it. |

## Not counted

Borderline items read and excluded, with the reason.

- **Version skew between parallel task branches (the `pending` rule).** Agent Memory (T20 against T19's core,
  `conformance/results/2026-10-15T02-47-56-123Z`, `2026-10-15T04-08-54-999Z`; T20:101-102, 126; D-227, D-234;
  `conformance/README.md`), Agent Compute (T21:111-115, 264-267, 331-336; `64a36f7`, D-240, D-243) and the transient
  N5 refusal that named each runtime's own version (T21:89-90; `ab3f9b9`; D-240). One runtime was a version behind
  because the other branch was not yet merged; the next kept report has none pending (`2026-10-15T12-42-55-302Z`,
  `2026-10-17T23-36-27-118Z`). Not a difference between runtimes at equal versions.
- **T21 review 1, finding 3 (`e67ffeb`): `instantiation_failed` carried wasmtime's text in the audit.** Found before the
  Chrome port existed, as a violation of the spec's C-41, with the argument that a V8 port could never reproduce
  the text; no pair of runs is reported.
- **T20: agentpkg's copy of the proposals schema lagged the specification (`a94416a`).** A sync of a copy; the source
  states no observed difference between runs.
- **T1 (`ef8c644`): the Chrome CLI's refusals "now match agentpkg" (stderr line, status 2).** The spec does not say what
  the Chrome CLI did before.
- **T1 review 1, finding 2 (D-039): the URL gate, `urlsplit` against the WHATWG host parser.** The Chrome core's gate is
  compared with Chrome's own fetch parser; no Python behaviour is compared.
- **T5a (`5d61809`, D-078): `openai/gpt-6-astra` "unverified" for reasoning in Chrome while it worked through OpenClaw.**
  The reference side is OpenClaw's own model catalog row, host data rather than runtime behaviour.
- **T11 (`3a16382`, D-130): the built-in adapter hard-coded `reasoning=false`.** A mismatch between preflight and
  execution inside the Chrome core.
- **T24 (conformance README): N-26 `host-refused` and N-30 `route-cap-too-large`.** N-26 is "a recorded difference of the
  CLIs in form only" but both CLIs refuse by `conversation_profile` with one message; for N-30 the suite compares only
  the execution layers, which agree, and the source does not say what the Chrome CLI does.
- **T24 review 2 finding 1 and review 3 finding 1 (turn limits from Settings).** A Chrome-extension bug against rule
  V-10; the reference has no mutable-settings counterpart, so the input is never the same.
- **Pre-emptive alignments with no observed difference.** T18's six spec reviews ("two runtimes would settle those
  differently", fixed in the specification before any Python runtime existed), T23 review 2 nits 2 and 4 and the T23
  carry-over on `str(exc).split` ("Same value today"), T25 review 1 finding 1 and review 2 nits 2, 4 and 6 (Python-side
  cleanups ported together in `8c71a6c`), the Chrome async answer check (D-292 host fact 2), the `roles` order of a
  built archive (D-293, B-247), and the 120-random-network bound comparison and the WebAir 0.8.0 `converse` runs, which
  found no difference (T26:88; T24:354).
- **The same bug in both runtimes, fixed in both.** A record granted under two permissions (T19 review 1 nit 9,
  `2ab27f6`; T20 review 1 nit 6, `ef8b387`); the refusal text carrying the code twice (T22 review 1 nit 6, `d0b53a0`).
- **Nested sealed pointers (T20 review 2 nit 5, `cf649ef`).** "Same shape in Chrome, so conformance agrees."
- **T20 review 3 nits 1 and 2 (B-213).** A hand-edited Python folder admits short sealed values into the scan set where a
  Chrome store refuses them at write (different input paths); the proposal-index sentence differs from the spec in all
  three implementations.
- **Zip bytes under Node 24 and 26 (T7:65, 82, D-093).** One runtime under two Node versions (zlib).
- **T6 review nit 5 (4 KiB URL bound against a 500-character query).** Two gates inside the Chrome core, kept for parity
  with the reference.
- **T4 `tool_dispatches` in the Chrome result record (T4:380-381).** An addition against the plugin's `RunRecord`, not
  against agentpkg.
- **T4 review 1 finding 8 (vacuous conformance checks, `fdc972d`) and T20 review 1 finding 5.** Gaps in the test and
  conformance harness, not runtime behaviour.
- **Single-runtime bugs and extension or UI differences with no cross-runtime aspect.** The OpenClaw plugin's Control UI
  against the Chrome extension's pages, the extension's secret store, permissions and origin guard (T16), the native
  helper and installer (T17), the Open page and Runs page (T12, T14), the Chrome-only items of the T1, T3, T4, T5,
  T22 and T24 reviews (for example the URL parser against Chrome's `response.url`, the `$dynamicAnchor` keyword set
  inside the Chrome schema engine apart from DV-19's symptom, the extension MV3 content-security-policy rule D-253),
  and a WebAssembly stack-overflow depth (C-49: the depth differs, both report `stack_overflow`).
- **Tests and kept results.** `consent-timeout` and `consent-host-invalid` have no CLI form and run only in each
  runtime's unit suite, so a difference there would not show in the suite; the Agent Compute case `engine-unavailable`
  runs only in Python's unit suite because the Chrome core always has an engine.

## Limits of this log

It is a reading of the project's own records, not an audit of the code: a difference that no task or review wrote
down is not in it. A few rows rest on a single sentence of a spec (the rows' Recorded at column gives the lines), and
the merged-tree conformance run of T20 (64 of 71 cases, T20:139-141) behind DV-47 and DV-48 was not kept, so
the mapping of those two rows to case names is an inference from T20:139-141 and the kept comparison report. The conformance counts of the
current suite (224 cases at `d5631ed`; `conformance/results/2026-10-25T02-53-07-223Z/`, rerun on 2026-11-03 in
`2026-11-03T03-18-24-077Z` and `2026-11-03T03-58-02-915Z`) are the report's, not this file's.
