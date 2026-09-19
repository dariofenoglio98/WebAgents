from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

QueryType = Literal["auto", "doi", "arxiv", "title"]
DetectedType = Literal["doi", "arxiv", "title"]
ProviderName = Literal["crossref", "openalex", "arxiv"]


class ResolveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=1, max_length=500)
    query_type: QueryType = "auto"
    format: Literal["json", "bibtex"] = "json"

    @field_validator("query")
    @classmethod
    def clean_query(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ord(c) < 32 and c not in "\n\r\t" for c in value):
            raise ValueError("query must contain nonempty text without control characters")
        return value


class Author(BaseModel):
    name: str
    given: str | None = None
    family: str | None = None
    orcid: str | None = None


class Paper(BaseModel):
    title: str = Field(min_length=1)
    authors: list[Author] = Field(default_factory=list)
    year: int | None = None
    venue: str | None = None
    publisher: str | None = None
    doi: str | None = None
    arxiv_id: str | None = None
    url: str | None = None
    publication_type: str | None = None
    abstract: str | None = None
    volume: str | None = None
    issue: str | None = None
    pages: str | None = None
    journal_reference: str | None = None
    provider_ids: dict[str, str] = Field(default_factory=dict)
    source: ProviderName
    bibtex: str | None = None


class Candidate(BaseModel):
    paper: Paper
    match_score: float = Field(ge=0, le=1)


class SourceAttempt(BaseModel):
    provider: ProviderName
    status: Literal["ok", "not_found", "error"]
    error_code: str | None = None


class ResolveResponse(BaseModel):
    status: Literal["resolved", "ambiguous", "not_found", "provider_error"]
    query: str
    detected_type: DetectedType
    best_match: Paper | None = None
    match_score: float | None = None
    alternatives: list[Candidate] = Field(default_factory=list)
    sources: list[SourceAttempt] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    message: str


class ErrorResponse(BaseModel):
    status: Literal["invalid_request"] = "invalid_request"
    message: str
    errors: list[dict[str, str]] = Field(default_factory=list)
