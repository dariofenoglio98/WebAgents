"""F7 — output and state integrity: a model or tool answer is used only if it keeps its contract.

Generic checks (every declared output schema, parseability, a finished turn)
apply to both packages. Relational checks are only the ones Literature Review
itself declares in its graph — `check-document` / `check-abstract`,
`check-identity`, `check-direct-source`, the lookups that materialize the
review, and `validate-output`. None is invented here. Meeting Agenda's one
relation (agenda minutes sum to the requested duration) is established by its
`allocate` constructor rather than checked against a model answer, so a
corrupted answer cannot violate it; it has no relational template.

Corrupted answers are derived from the calibration run (`calibration.py`) and
checked before they enter the catalog: a schema violation must fail the
router's own schema, a relational violation and every control must pass it.
"""

from __future__ import annotations

import copy
import hashlib

from harness.synthetic import PAPERS, item_key, resolver_paper, sentences_of

from . import boundaries as B
from . import mutations
from .base import Template, base_plan, stable_hash, taint

BOTH = ("meeting-agenda", "literature-review")
LR = ("literature-review",)


def _validator(schema):
    from jsonschema import Draft202012Validator

    return Draft202012Validator(schema)


def schema_valid(schema, value) -> bool:
    return not any(True for _ in _validator(schema).iter_errors(value))


def rule(package: str, task: str, item: str, action: dict) -> dict:
    """A one-shot fault on the model call for one task (and one map item)."""
    entry = {"task": task, "action": action}
    if item:
        entry["match"] = lambda data, package=package, task=task, item=item: (
            item_key(package, task, data) == item
        )
    return entry


def _slug(text: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in text).strip("_")[:40] or "root"


# -- F7.model_output_schema -------------------------------------------------------------------
class ModelOutputSchema(Template):
    def variants(self, package, env, rng, budget):
        calibrated = env.calibrated(package)
        files = _payload(env, package)
        out = []
        for task in sorted(calibrated["tasks"]):
            entry = calibrated["tasks"][task]
            schema = entry["schema"]
            item = rng.choice(entry["items"]) if entry["map"] else ""
            answer = entry["answers"][item]
            token = taint(self.template_id, package, task)
            controls = []
            for site in mutations.control_sites(files, entry["schema_path"]):
                changed, where = mutations.valid_perturbation(answer, site.as_json(), token)
                if where is not None and changed != answer and schema_valid(schema, changed):
                    controls.append(
                        {"task": task, "item": item, "site": site.as_json(), "location": where}
                    )
            found = []
            for site in mutations.sites(files, entry["schema_path"]):
                mutated, where = mutations.apply(answer, site.as_json(), token)
                if where is None or schema_valid(schema, mutated):
                    continue  # absent in this answer, or not a violation of the router's schema
                found.append((site, where))
            for site, where in _stratified(found, budget, rng):
                params = {"task": task, "item": item, "site": site.as_json(), "location": where}
                key = f"{task}-{site.operator}-{_slug(site.pointer)}-{stable_hash(params)[:6]}"
                control = (
                    controls[int(stable_hash(key)[:8], 16) % len(controls)] if controls else None
                )
                out.append(
                    self.variant(
                        package,
                        key,
                        params,
                        f"the {task} answer{' for ' + item if item else ''} breaks its schema: "
                        f"{site.operator} at {where}",
                        control_params=control,
                        control_description=(
                            f"the {task} answer changed at {control['location']} in a way its "
                            "schema accepts"
                            if control
                            else None
                        ),
                    )
                )
        return out

    def plan(self, variant, kind, env):
        package = variant.package
        params = variant.control_params if kind == "control" else variant.params
        plan = base_plan(env, package)
        node = env.calibrated(package)["tasks"][variant.params["task"]]["node"]
        if not params:
            return plan, B.committed(node)
        token = taint(variant.case_id if kind == "violation" else variant.control_id)
        site = params["site"]
        if kind == "violation":
            action = {
                "kind": "mutate",
                "apply": lambda output, schema, site=site, token=token: mutations.apply(
                    output, site, token
                )[0],
                "expect": "invalid",
            }
        else:
            action = {
                "kind": "mutate",
                "apply": lambda output, schema, site=site, token=token: (
                    mutations.valid_perturbation(output, site, token)[0]
                ),
                "expect": "valid",
            }
        plan.faults.model.append(rule(package, params["task"], params["item"], action))
        return plan, B.committed(node)


def _stratified(found: list, budget: int, rng) -> list:
    """At most `budget` sites per task, drawn round-robin across operators (stable order)."""
    if len(found) <= budget:
        return found
    by_operator: dict[str, list] = {}
    for item in found:
        by_operator.setdefault(item[0].operator, []).append(item)
    for items in by_operator.values():
        rng.shuffle(items)
    chosen: list = []
    while len(chosen) < budget:
        for operator in sorted(by_operator):
            if by_operator[operator] and len(chosen) < budget:
                chosen.append(by_operator[operator].pop())
    order = {id(item): index for index, item in enumerate(found)}
    return sorted(chosen, key=lambda item: order[id(item)])


def _payload(env, package):
    from .base import payload

    return payload(env, package)


MODEL_OUTPUT_SCHEMA = ModelOutputSchema(
    "F7.model_output_schema",
    "F7",
    "Model answer that breaks its declared output schema",
    "One model call's answer (well-formed JSON) violates the node's declared output schema at "
    "one location: a missing required field, an undeclared property, a wrong type, a value "
    "outside an enum, a bound or a pattern, or an array outside its size limits. Sites are "
    "enumerated from the package's own schemas, sampled per model task across operators (the "
    "preset's parametric budget per task), and each is checked against the router's schema.",
    "A model answer is used only if it satisfies the output schema its node declares.",
    "validation",
    "execute/model",
    ("model_output_not_conforming",),
    "The node that asked for the answer commits it to workflow state.",
    "The same answer changed at a free-text or free-enum location the schema accepts.",
    "parametric",
    BOTH,
    "minus_output_validation",
    "router schema validation",
    "schema-violating model answer",
    requires_fault=True,
)


# -- F7.model_output_unparseable --------------------------------------------------------------
NODE_TASKS = {"meeting-agenda": ("plan", "write"), "literature-review": ("plan", "verify")}


def _truncate(text: str) -> str:
    return text[: max(1, len(text) // 2)]


UNPARSEABLE = (
    ("empty", "no text at all", lambda text: ""),
    (
        "prose_only",
        "prose with no JSON value",
        lambda text: "I could not produce the requested structure.",
    ),
    ("truncated", "the JSON document cut in half", _truncate),
    (
        "trailing_comma",
        "JSON with a trailing comma",
        lambda text: text[:-1] + ",}" if text.endswith("}") else text + ",",
    ),
    ("python_literal", "a Python literal instead of JSON", lambda text: text.replace('"', "'")),
    (
        "fenced_truncated",
        "a markdown fence around a truncated document",
        lambda text: "```json\n" + _truncate(text) + "\n```",
    ),
)
WRAPPED = (
    (
        "fenced",
        "the same JSON inside a markdown json fence",
        lambda text: "```json\n" + text + "\n```",
    ),
    (
        "prose_wrapped",
        "the same JSON preceded and followed by prose",
        lambda text: "Here is the result:\n" + text + "\nDone.",
    ),
)


class OutputUnparseable(Template):
    def variants(self, package, env, rng, budget):
        out = []
        for task in NODE_TASKS[package]:
            for index, (label, description, _) in enumerate(UNPARSEABLE):
                control = WRAPPED[index % len(WRAPPED)][0]
                out.append(
                    self.variant(
                        package,
                        f"{task}-{label}",
                        {"task": task, "form": label},
                        f"the {task} answer is {description}",
                        control_params={"task": task, "form": control},
                        control_description=f"the {task} answer as "
                        + dict((w[0], w[1]) for w in WRAPPED)[control],
                    )
                )
        return out

    def plan(self, variant, kind, env):
        package = variant.package
        params = variant.control_params if kind == "control" else variant.params
        forms = {label: fn for label, _, fn in (*UNPARSEABLE, *WRAPPED)}
        plan = base_plan(env, package)
        plan.faults.model.append(
            rule(package, params["task"], "", {"kind": "text", "text": forms[params["form"]]})
        )
        node = env.calibrated(package)["tasks"][params["task"]]["node"]
        return plan, B.committed(node)


OUTPUT_UNPARSEABLE = OutputUnparseable(
    "F7.model_output_unparseable",
    "F7",
    "Model answer that is not one JSON document",
    "One model call returns no text, prose, a truncated or trailing-comma document, a Python "
    "literal, or a fenced truncated document.",
    "An answer that is not one parseable JSON document is refused, never repaired or retried.",
    "validation",
    "execute/model",
    ("model_output_not_conforming",),
    "The node that asked for the answer commits anything.",
    "The same valid JSON inside a markdown fence or surrounded by prose (forms the router reads).",
    "finite",
    BOTH,
    "minus_output_validation",
    "router parse (not removable: an unparsed answer has no value)",
    "malformed model output",
    requires_fault=True,
    ablation_removes_guard=False,
)


# -- F7.model_turn_unfinished -----------------------------------------------------------------
STOPS = (
    ("length", "stopped at its output limit"),
    ("error", "reported as an error, refusal or content filter"),
    ("aborted", "aborted"),
    ("toolUse", "ended to call a tool the adapter never offered"),
)


class TurnUnfinished(Template):
    def variants(self, package, env, rng, budget):
        out = []
        for task in NODE_TASKS[package]:
            for index, (reason, description) in enumerate(STOPS):
                control = "stop" if index % 2 == 0 else None
                out.append(
                    self.variant(
                        package,
                        f"{task}-{reason}",
                        {"task": task, "stop_reason": reason},
                        f"the {task} turn is {description}, though its text is a complete, valid "
                        "document",
                        control_params={"task": task, "stop_reason": control},
                        control_description=(
                            f"the {task} turn reported as finished ('stop')"
                            if control
                            else (
                                f"the {task} turn with no stop reason reported "
                                "(a host that reports none)"
                            )
                        ),
                    )
                )
        return out

    def plan(self, variant, kind, env):
        package = variant.package
        params = variant.control_params if kind == "control" else variant.params
        plan = base_plan(env, package)
        plan.faults.model.append(
            rule(
                package, params["task"], "", {"kind": "stop_reason", "value": params["stop_reason"]}
            )
        )
        node = env.calibrated(package)["tasks"][params["task"]]["node"]
        return plan, B.committed(node)


TURN_UNFINISHED = TurnUnfinished(
    "F7.model_turn_unfinished",
    "F7",
    "Model turn the provider did not finish",
    "One model call's text is a complete, schema-valid document, but the host reports the turn "
    "as stopped at the output limit, failed (error, refusal, filter), aborted, or ended for a "
    "tool call.",
    "Only a finished turn's answer is used; an unfinished one is classified, not parsed.",
    "validation",
    "execute/model",
    ("model_output_truncated", "model_turn_failed"),
    "The node that asked for the answer commits it.",
    "The same answer with the turn reported finished, or with no stop reason reported.",
    "finite",
    BOTH,
    "minus_output_validation",
    "router termination classification",
    "truncated or failed turn",
    requires_fault=True,
)


# -- F7.evidence_relation ---------------------------------------------------------------------
def _other_abstract_sentence(exclude_doi: str) -> str:
    for paper in PAPERS:
        if paper.doi != exclude_doi:
            for sentence in sentences_of(paper.abstract):
                return sentence
    raise LookupError("no other paper")


class EvidenceRelation(Template):
    DOCUMENT = (
        ("fabricated_quote", "a quote that occurs in no page of the document"),
        ("quote_from_other_paper", "a sentence from another paper's abstract as the quote"),
        ("wrong_paper_id", "the evidence attributed to another selected paper"),
        ("page_not_in_document", "a page number the document does not have"),
        ("quote_on_other_page", "a real quote attributed to a different page"),
    )
    ABSTRACT = (
        ("fabricated_quote", "a quote that is not in the paper's abstract"),
        ("quote_from_other_paper", "a sentence from another paper's abstract as the quote"),
        ("wrong_paper_id", "the evidence attributed to another selected paper"),
        ("scope_full_text", "abstract evidence labelled as full-text evidence"),
        ("page_on_abstract", "abstract evidence given a page number"),
    )
    CONTROLS = (
        ("shortened_quote", "the quote shortened to a verbatim part of itself"),
        ("paraphrased_text", "the evidence's free `text` paraphrased, its quote unchanged"),
    )

    def variants(self, package, env, rng, budget):
        calibrated = env.calibrated(package)
        selected = calibrated["selected"]
        extract = calibrated["tasks"]["extract"]
        document = next(
            (p for p in selected if p["has_document"] and p["doi"] in extract["answers"]), None
        )
        abstract = next(
            (p for p in selected if not p["has_document"] and p["doi"] in extract["answers"]), None
        )
        out = []
        for path, target, cases in (
            ("document", document, self.DOCUMENT),
            ("abstract", abstract, self.ABSTRACT),
        ):
            if target is None:
                continue
            others = [p for p in selected if p["paper_id"] != target["paper_id"]]
            answer = extract["answers"][target["doi"]]
            for index, (label, description) in enumerate(cases):
                if label == "wrong_paper_id" and not others:
                    continue
                control = self.CONTROLS[index % len(self.CONTROLS)][0]
                params = {
                    "path": path,
                    "doi": target["doi"],
                    "corruption": label,
                    "other_paper_id": others[0]["paper_id"] if others else None,
                }
                control_answer = self.corrupt(
                    answer, {**params, "corruption": control}, "TAINT-check"
                )
                if not (
                    schema_valid(extract["schema"], self.corrupt(answer, params, "TAINT-check"))
                    and schema_valid(extract["schema"], control_answer)
                ):
                    continue  # not schema-valid: that would be a schema case, not a relational one
                out.append(
                    self.variant(
                        package,
                        f"{path}-{label}",
                        params,
                        f"the extraction for the paper read from its {path} gives {description}",
                        control_params={"path": path, "doi": target["doi"], "corruption": control},
                        control_description=dict(self.CONTROLS)[control],
                    )
                )
        return out

    @staticmethod
    def corrupt(answer: list, params: dict, token: str) -> list:
        answer = copy.deepcopy(answer)
        first = answer[0]
        label = params["corruption"]
        if label == "fabricated_quote":
            first["quote"] = f"This sentence {token} appears in no source."
        elif label == "quote_from_other_paper":
            first["quote"] = _other_abstract_sentence(params["doi"])
        elif label == "wrong_paper_id":
            first["paper_id"] = params["other_paper_id"]
        elif label == "page_not_in_document":
            first["location"]["page"] = 99
        elif label == "quote_on_other_page":
            first["location"]["page"] = 2 if first["location"].get("page") == 1 else 1
        elif label == "scope_full_text":
            first["scope"] = "full_text"
        elif label == "page_on_abstract":
            first["location"]["page"] = 1
        elif label == "shortened_quote":
            words = first["quote"].split()
            first["quote"] = " ".join(words[: max(3, len(words) // 2)])
        elif label == "paraphrased_text":
            first["text"] = "In other words: " + first["text"]
        else:
            raise ValueError(label)
        return answer

    def plan(self, variant, kind, env):
        params = variant.control_params if kind == "control" else variant.params
        params = {**variant.params, **params}
        token = taint(variant.case_id if kind == "violation" else variant.control_id)
        plan = base_plan(env, variant.package)
        action = {
            "kind": "mutate",
            "apply": lambda output, schema, params=params, token=token: self.corrupt(
                output, params, token
            ),
            "expect": "valid",
        }
        plan.faults.model.append(rule(variant.package, "extract", params["doi"], action))
        return plan, B.committed("evidence")


EVIDENCE_RELATION = EvidenceRelation(
    "F7.evidence_relation",
    "F7",
    "Extracted evidence that its source does not support",
    "A schema-valid extraction answer quotes text that is not in the document page or abstract "
    "it cites, attributes the evidence to another paper, cites a page the document does not "
    "have, or mislabels abstract evidence as full-text.",
    "Every evidence item quotes its own paper's source verbatim, at the location it names "
    "(the package's check-document / check-abstract relations).",
    "validation",
    "validate",
    ("schema_validation",),
    "The evidence map commits the unsupported evidence to workflow state.",
    "A shortened verbatim quote, or a paraphrased free-text field with the quote unchanged.",
    "finite",
    LR,
    "minus_output_validation",
    "declared evidence relations",
    "fabricated or misattributed quote",
    requires_fault=True,
)


# -- F7.review_relation -----------------------------------------------------------------------
def review_corrupt(output: dict, state: dict) -> bool:
    """The published review cites, quotes or tabulates something its state does not support."""
    resolved = {
        record.get("paper_id")
        for record in state.get("citation_records") or []
        if record.get("status") == "resolved"
    }
    evidence = {item.get("evidence_id"): item for item in state.get("evidence_items") or []}
    for entry in output.get("bibliography") or []:
        if entry.get("paper_id") not in resolved:
            return True
    for claim in output.get("claims") or []:
        if any(eid not in evidence for eid in claim.get("evidence_ids") or []):
            return True
        if any(pid not in resolved for pid in claim.get("paper_ids") or []):
            return True
        if claim.get("support_type") == "direct_quote":
            first = evidence.get((claim.get("evidence_ids") or [None])[0]) or {}
            if (claim.get("paper_ids") or [None])[0] != first.get("paper_id"):
                return True
            if claim.get("text") != first.get("quote"):
                return True
    for row in output.get("evidence_table") or []:
        if evidence.get(row.get("evidence_id")) != row:
            return True
    return False


class ReviewRelation(Template):
    CASES = (
        (
            "bibliography_unselected_paper",
            "a bibliography entry for a paper the run never resolved",
        ),
        (
            "bibliography_fabricated_paper",
            "a bibliography entry for a paper id that does not exist",
        ),
        (
            "claim_cites_unresolved_paper",
            "a synthesis claim citing a paper whose citation did not resolve",
        ),
        (
            "claim_cites_fabricated_evidence",
            "a synthesis claim citing an evidence id that does not exist",
        ),
        (
            "direct_quote_wrong_paper",
            "a direct-quote claim attributed to another paper than its quote's",
        ),
        ("evidence_row_fabricated", "an evidence-table row whose evidence id does not exist"),
    )
    CONTROLS = (
        ("evidence_row_rewritten", "an evidence-table row rewritten but keeping its evidence id"),
        ("synthesis_text_paraphrased", "a synthesis claim's wording paraphrased"),
        ("bibliography_renumbered", "bibliography reference numbers shifted"),
    )

    def variants(self, package, env, rng, budget):
        calibrated = env.calibrated(package)
        verify = (calibrated["tasks"].get("verify") or {}).get("answers", {}).get("")
        if not verify:
            return []
        selected = {p["paper_id"] for p in calibrated["selected"]}
        unselected = [
            c["paper_id"] for c in calibrated["candidates"] if c["paper_id"] not in selected
        ]
        unresolved = [p["paper_id"] for p in calibrated["selected"] if p["resolver"] != "resolved"]
        resolved = [p["paper_id"] for p in calibrated["selected"] if p["resolver"] == "resolved"]
        kinds = {claim.get("support_type") for claim in verify.get("claims") or []}
        out = []
        for index, (label, description) in enumerate(self.CASES):
            extra = {}
            if label == "bibliography_unselected_paper":
                if not unselected:
                    continue
                extra["paper_id"] = unselected[0]
            elif label == "claim_cites_unresolved_paper":
                target = unresolved or unselected
                if not target or "model_synthesis" not in kinds:
                    continue
                extra["paper_id"] = target[0]
            elif label == "claim_cites_fabricated_evidence" and "model_synthesis" not in kinds:
                continue
            elif label == "direct_quote_wrong_paper":
                if "direct_quote" not in kinds or len(resolved) < 2:
                    continue
            elif label == "evidence_row_fabricated" and not verify.get("evidence_table"):
                continue
            control = self.CONTROLS[index % len(self.CONTROLS)][0]
            params = {"corruption": label, **extra, "resolved": resolved}
            schema = calibrated["tasks"]["verify"]["schema"]
            if not (
                schema_valid(schema, self.corrupt(verify, params, "TAINT-check"))
                and schema_valid(
                    schema, self.corrupt(verify, {**params, "corruption": control}, "TAINT-check")
                )
            ):
                continue
            out.append(
                self.variant(
                    package,
                    label,
                    params,
                    f"the verification answer gives {description}",
                    control_params={"corruption": control},
                    control_description=dict(self.CONTROLS)[control],
                )
            )
        return out

    @staticmethod
    def corrupt(answer: dict, params: dict, token: str) -> dict:
        answer = copy.deepcopy(answer)
        label = params["corruption"]
        fabricated = "paper-" + hashlib.sha256(token.encode()).hexdigest()[:16]
        claims = answer.get("claims") or []
        if label == "bibliography_unselected_paper":
            answer["bibliography"].append(
                {"reference": len(answer["bibliography"]) + 1, "paper_id": params["paper_id"]}
            )
        elif label == "bibliography_fabricated_paper":
            answer["bibliography"].append(
                {"reference": len(answer["bibliography"]) + 1, "paper_id": fabricated}
            )
        elif label == "claim_cites_unresolved_paper":
            claim = next(c for c in claims if c.get("support_type") == "model_synthesis")
            claim["paper_ids"] = [*claim["paper_ids"], params["paper_id"]]
        elif label == "claim_cites_fabricated_evidence":
            claim = next(c for c in claims if c.get("support_type") == "model_synthesis")
            claim["evidence_ids"] = [*claim["evidence_ids"], f"{claim['paper_ids'][0]}:e99"]
        elif label == "direct_quote_wrong_paper":
            claim = next(c for c in claims if c.get("support_type") == "direct_quote")
            other = next(pid for pid in params["resolved"] if pid != claim["paper_ids"][0])
            claim["paper_ids"] = [other]
        elif label == "evidence_row_fabricated":
            row = copy.deepcopy(answer["evidence_table"][0])
            row["evidence_id"] = f"{row['paper_id']}:e99"
            answer["evidence_table"].append(row)
        elif label == "evidence_row_rewritten":
            row = answer["evidence_table"][0]
            row["text"] = "Rewritten by the verifier: " + row["text"]
            row["category"] = "method" if row.get("category") != "method" else "finding"
        elif label == "synthesis_text_paraphrased":
            claim = next((c for c in claims if c.get("support_type") == "model_synthesis"), None)
            if claim is not None:
                claim["text"] = "In short, " + str(claim.get("text") or "")
        elif label == "bibliography_renumbered":
            for entry in answer["bibliography"]:
                entry["reference"] = int(entry["reference"]) + 10
        else:
            raise ValueError(label)
        return answer

    def plan(self, variant, kind, env):
        params = {**variant.params, **(variant.control_params if kind == "control" else {})}
        token = taint(variant.case_id if kind == "violation" else variant.control_id)
        plan = base_plan(env, variant.package)
        action = {
            "kind": "mutate",
            "apply": lambda output, schema, params=params, token=token: self.corrupt(
                output, params, token
            ),
            "expect": "valid",
        }
        plan.faults.model.append(rule(variant.package, "verify", "", action))
        return plan, B.published(review_corrupt)


REVIEW_RELATION = ReviewRelation(
    "F7.review_relation",
    "F7",
    "Review that cites, quotes or tabulates what its evidence does not support",
    "A schema-valid verification answer adds a bibliography entry, claim citation or "
    "evidence-table row that the run's resolved citations and extracted evidence do not "
    "support, or attributes a direct quote to another paper.",
    "The published review cites only resolved papers and existing evidence, and every direct "
    "quote is its own paper's (the package's lookups, check-direct-source and validate-output).",
    "validation",
    "validate",
    ("schema_validation",),
    "The published review contains the unsupported citation, quote or row.",
    "The answer reworded where no relation applies (a rewritten table row the package "
    "re-materializes from state, a paraphrased synthesis claim, renumbered references).",
    "finite",
    LR,
    "minus_output_validation",
    "declared review relations",
    "fabricated citation in final output",
    requires_fault=True,
)


# -- F7 tool responses ------------------------------------------------------------------------
def _resolver_rule(doi: str, change) -> dict:
    return {
        "tool": "citation-resolver",
        "match": lambda request, doi=doi: request.get("query") == doi,
        "apply": change,
    }


class ResolverResponse(Template):
    CASES = (
        ("status_not_in_enum", "reports a status outside the declared enum"),
        ("title_empty", "returns a best match with an empty title"),
        ("source_not_in_enum", "returns a best match from an undeclared source"),
        ("not_an_object", "returns a JSON array instead of a response object"),
        ("content_type_html", "labels a JSON body as text/html"),
        ("body_not_json", "returns an HTML body labelled application/json"),
    )
    CONTROLS = (
        ("informational_field", "an extra informational field the schema allows"),
        ("metadata_variant", "a different but valid venue string for the same paper"),
    )

    def variants(self, package, env, rng, budget):
        target = next(
            (p for p in env.calibrated(package)["selected"] if p["resolver"] == "resolved"), None
        )
        if target is None:
            return []
        out = []
        for index, (label, description) in enumerate(self.CASES):
            control = self.CONTROLS[index % len(self.CONTROLS)][0]
            out.append(
                self.variant(
                    package,
                    label,
                    {"doi": target["doi"], "corruption": label},
                    f"the Citation Resolver {description}",
                    control_params={"doi": target["doi"], "corruption": control},
                    control_description=(
                        f"the Citation Resolver answer with {dict(self.CONTROLS)[control]}"
                    ),
                )
            )
        return out

    @staticmethod
    def change(label: str, doi: str):
        other = next(p for p in PAPERS if p.doi != doi and p.resolver == "resolved")

        def apply(status, content_type, answer):
            answer = copy.deepcopy(answer)
            if label == "identity_other_paper":
                answer["best_match"] = resolver_paper(other)
            elif label == "identity_unknown_doi":
                answer["best_match"]["doi"] = "10.5555/wa.999"
            elif label == "resolved_without_match":
                answer["best_match"] = None
            elif label == "status_not_in_enum":
                answer["status"] = "resolved_probably"
            elif label == "title_empty":
                answer["best_match"]["title"] = ""
            elif label == "source_not_in_enum":
                answer["best_match"]["source"] = "scholar"
            elif label == "not_an_object":
                answer = [answer]
            elif label == "content_type_html":
                return status, "text/html", answer
            elif label == "body_not_json":
                return status, content_type, "<html><body>resolved</body></html>"
            elif label == "informational_field":
                answer["request_id"] = "synthetic-request-1"
            elif label == "metadata_variant":
                answer["best_match"]["venue"] = (
                    str(answer["best_match"].get("venue") or "") + " (Companion)"
                )
            else:
                raise ValueError(label)
            return status, content_type, answer

        return apply

    def plan(self, variant, kind, env):
        params = variant.control_params if kind == "control" else variant.params
        plan = base_plan(env, variant.package)
        plan.faults.tools.append(
            _resolver_rule(params["doi"], self.change(params["corruption"], params["doi"]))
        )
        return plan, B.committed("citations")


class ResolverIdentity(ResolverResponse):
    CASES = (
        ("identity_other_paper", "resolves the paper to a different paper of the corpus"),
        ("identity_unknown_doi", "resolves the paper to a DOI that is not the requested one"),
        ("resolved_without_match", "reports the paper resolved with no best match"),
    )


RESOLVER_RESPONSE = ResolverResponse(
    "F7.resolver_response",
    "F7",
    "Citation Resolver answer that breaks the tool's output contract",
    "The resolver's answer for one selected paper violates the tool's declared output schema, "
    "or is not a JSON response.",
    "A tool answer is used only if it is JSON and satisfies the tool's declared output schema.",
    "validation",
    "execute/tool",
    ("tool_response_invalid",),
    "The citations map commits the bad resolution to workflow state.",
    "A resolver answer with an informational extra field, or a different valid venue string.",
    "finite",
    LR,
    "minus_output_validation",
    "tool output schema",
    "malformed resolver response",
    requires_fault=True,
)
RESOLVER_IDENTITY = ResolverIdentity(
    "F7.resolver_identity",
    "F7",
    "Citation Resolver answer that resolves the wrong paper",
    "The resolver's schema-valid answer for one selected paper names a different paper of the "
    "corpus, a DOI that is not the requested one, or no match while claiming resolution.",
    "A resolution is used only for the paper that was asked about (the package's check-identity "
    "relation).",
    "validation",
    "validate",
    ("schema_validation",),
    "The citations map commits the wrong resolution to workflow state.",
    "A resolver answer with an informational extra field, or a different valid venue string.",
    "finite",
    LR,
    "minus_output_validation",
    "declared identity relation",
    "resolver returns wrong paper",
    requires_fault=True,
)


class SearchResponse(Template):
    CASES = (
        ("content_type_text", "labels its JSON body text/plain"),
        ("body_not_json", "returns a body that is not JSON"),
        ("status_not_ok", "returns a Crossref envelope whose status is not ok"),
        ("items_missing", "returns a message with no work list"),
        ("oversized_body", "returns a body larger than the binding's response limit"),
    )
    CONTROLS = (
        ("extra_item_fields", "work items carrying fields the adapter does not read"),
        ("extra_envelope_fields", "envelope fields the adapter does not read"),
    )

    def variants(self, package, env, rng, budget):
        queries = env.calibrated(package)["search_queries"]
        if not queries:
            return []
        out = []
        for index, (label, description) in enumerate(self.CASES):
            control = self.CONTROLS[index % len(self.CONTROLS)][0]
            out.append(
                self.variant(
                    package,
                    label,
                    {"query": queries[0], "corruption": label},
                    f"Crossref {description} for the first planned query",
                    control_params={"query": queries[0], "corruption": control},
                    control_description=f"Crossref answer with {dict(self.CONTROLS)[control]}",
                )
            )
        return out

    @staticmethod
    def change(label: str):
        def apply(status, content_type, answer):
            answer = copy.deepcopy(answer)
            if label == "content_type_text":
                return status, "text/plain", answer
            if label == "body_not_json":
                return status, content_type, "{'status': 'ok'"
            if label == "status_not_ok":
                answer["status"] = "failed"
            elif label == "items_missing":
                answer["message"] = {"total-results": 0}
            elif label == "oversized_body":
                answer["message"]["padding"] = "x" * (600 * 1024)
            elif label == "extra_item_fields":
                for item in answer["message"]["items"]:
                    item["score"] = 12.5
                    item["reference-count"] = 3
            elif label == "extra_envelope_fields":
                answer["message-version"] = "1.0.0"
                answer["message"]["total-results"] = len(answer["message"]["items"])
            else:
                raise ValueError(label)
            return status, content_type, answer

        return apply

    def plan(self, variant, kind, env):
        params = variant.control_params if kind == "control" else variant.params
        plan = base_plan(env, variant.package)
        plan.faults.tools.append(
            {
                "tool": "scholarly-search",
                "match": lambda request, query=params["query"]: request.get("query") == query,
                "apply": self.change(params["corruption"]),
            }
        )
        return plan, B.committed("search")


SEARCH_RESPONSE = SearchResponse(
    "F7.search_response",
    "F7",
    "Scholarly-search answer that is not a usable Crossref work list",
    "Crossref's answer to one planned query is mislabelled, not JSON, not an ok work list, "
    "or larger than the binding allows.",
    "A tool answer is used only if it is a JSON response of the declared type and size that "
    "the host adapter can read as the declared result.",
    "validation",
    "execute/tool",
    ("tool_response_invalid",),
    "The search map commits a result built from the bad answer.",
    "Crossref answers carrying fields the adapter does not read.",
    "finite",
    LR,
    "minus_output_validation",
    "broker content type / size / adapter",
    "malformed search response",
    requires_fault=True,
)


class ReaderResponse(Template):
    CASES = (
        ("page_zero", "numbers the first page 0"),
        ("pages_missing", "returns no pages field"),
        ("source_not_in_enum", "labels the text as coming from the web"),
        ("text_not_string", "returns a page whose text is a number"),
    )

    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package,
                label,
                {"corruption": label},
                f"the PDF reader {description}",
                control_params={"corruption": "informational_field"},
                control_description="the PDF reader's answer with an informational extra field",
            )
            for label, description in self.CASES
        ]

    @staticmethod
    def change(label: str):
        def apply(answer):
            answer = copy.deepcopy(answer)
            if label == "page_zero":
                answer["pages"][0]["page"] = 0
            elif label == "pages_missing":
                del answer["pages"]
            elif label == "source_not_in_enum":
                answer["source"] = "web"
            elif label == "text_not_string":
                answer["pages"][0]["text"] = 42
            elif label == "informational_field":
                answer["extractor"] = "synthetic-parser"
            else:
                raise ValueError(label)
            return answer

        return apply

    def plan(self, variant, kind, env):
        params = variant.control_params if kind == "control" else variant.params
        plan = base_plan(env, variant.package)
        plan.faults.pdf = self.change(params["corruption"])
        return plan, B.committed("screening")


READER_RESPONSE = ReaderResponse(
    "F7.reader_response",
    "F7",
    "PDF reader answer that breaks the tool's output schema",
    "The host's PDF text extraction for the selected document returns pages numbered from 0, "
    "no pages, an undeclared source label, or non-text page content.",
    "A tool answer is used only if it satisfies the tool's declared output schema.",
    "validation",
    "execute/tool",
    ("tool_response_invalid",),
    "The screening map commits a result built from the bad answer.",
    "The reader's answer with an informational extra field the schema allows.",
    "finite",
    LR,
    "minus_output_validation",
    "tool output schema",
    "malformed reader output",
    requires_fault=True,
)

TEMPLATES = (
    MODEL_OUTPUT_SCHEMA,
    OUTPUT_UNPARSEABLE,
    TURN_UNFINISHED,
    EVIDENCE_RELATION,
    REVIEW_RELATION,
    RESOLVER_RESPONSE,
    RESOLVER_IDENTITY,
    SEARCH_RESPONSE,
    READER_RESPONSE,
)
