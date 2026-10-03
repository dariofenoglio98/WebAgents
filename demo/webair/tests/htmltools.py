"""A tiny stdlib HTML reader so tests can follow links and submit forms like a browser."""

from __future__ import annotations

from dataclasses import dataclass, field
from html.parser import HTMLParser


@dataclass
class Form:
    action: str
    method: str
    fields: list[dict] = field(default_factory=list)

    def values(self) -> dict[str, str]:
        """What a browser submits without user edits."""
        values: dict[str, str] = {}
        for f in self.fields:
            kind = f.get("type", "text")
            if f["tag"] == "select":
                selected = [o for o in f["options"] if o["selected"]] or f["options"][:1]
                if selected:
                    values[f["name"]] = selected[0]["value"]
            elif kind in ("radio", "checkbox"):
                if "checked" in f:
                    values[f["name"]] = f.get("value", "on")
            elif kind not in ("submit", "button"):
                values[f["name"]] = f.get("value", "")
        return values

    def names(self) -> set[str]:
        return {f["name"] for f in self.fields}


class Page(HTMLParser):
    def __init__(self, html: str):
        super().__init__(convert_charrefs=True)
        self.forms: list[Form] = []
        self.anchors: list[dict] = []
        self.link_elements: list[tuple[dict, bool]] = []  # (attributes, inside <head>)
        self.bases: list[dict] = []
        self.data: list[dict] = []
        self.text_parts: list[str] = []
        self._in_head = False
        self._form: Form | None = None
        self._select: dict | None = None
        self.feed(html)
        self.close()

    @property
    def text(self) -> str:
        return " ".join(" ".join(self.text_parts).split())

    def handle_starttag(self, tag, attrs):
        a = {k: (v if v is not None else "") for k, v in attrs}
        if any(k.startswith("data-") for k in a):
            self.data.append(a)
        if tag == "head":
            self._in_head = True
        elif tag == "link":
            self.link_elements.append((a, self._in_head))
        elif tag == "base":
            self.bases.append(a)
        elif tag == "a":
            self.anchors.append(a)
        elif tag == "form":
            self._form = Form(action=a.get("action", ""), method=a.get("method", "get").lower())
        elif self._form is not None and tag in ("input", "textarea") and "name" in a:
            self._form.fields.append({"tag": tag, **a})
        elif self._form is not None and tag == "select" and "name" in a:
            self._select = {"tag": "select", "options": [], **a}
            self._form.fields.append(self._select)
        elif tag == "option" and self._select is not None:
            self._select["options"].append(
                {"value": a.get("value", ""), "selected": "selected" in a}
            )

    def handle_endtag(self, tag):
        if tag == "head":
            self._in_head = False
        elif tag == "form" and self._form is not None:
            self.forms.append(self._form)
            self._form = None
        elif tag == "select":
            self._select = None

    def handle_data(self, data):
        self.text_parts.append(data)

    def form(self, action: str) -> Form:
        matches = [f for f in self.forms if f.action == action]
        assert len(matches) == 1, f"expected one form posting to {action}, found {len(matches)}"
        return matches[0]

    def hrefs(self, prefix: str) -> list[str]:
        return [a["href"] for a in self.anchors if a.get("href", "").startswith(prefix)]

    def agent_package_links(self) -> list[tuple[dict, bool]]:
        return [
            (a, in_head)
            for a, in_head in self.link_elements
            if "agent-package" in a.get("rel", "").lower().split()
        ]
