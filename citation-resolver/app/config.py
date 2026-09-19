import os
import re
from dataclasses import dataclass
from urllib.parse import urlsplit

# Title matching policy: lexical heuristics, never calibrated probabilities.
TITLE_RESOLVED_THRESHOLD = 0.93
TITLE_CREDIBLE_THRESHOLD = 0.72
TITLE_AMBIGUITY_MARGIN = 0.05
TITLE_MIN_RESOLVED_WORDS = 3
SEARCH_LIMIT = 8
MAX_ALTERNATIVES = 3
PROVIDER_TIMEOUT_SECONDS = 12.0
ARXIV_INTERVAL_SECONDS = 3.0
ARXIV_CACHE_SECONDS = 86400
ARXIV_CACHE_SIZE = 128


def validate_origin(value: str) -> str:
    if any(c.isspace() or ord(c) < 32 for c in value):
        raise ValueError("PUBLIC_BASE_URL must not contain whitespace or control characters")
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or not re.fullmatch(r"[A-Za-z0-9.\-:\[\]]+", parsed.netloc)
    ):
        raise ValueError("PUBLIC_BASE_URL must be an HTTP(S) origin without credentials or a path")
    _ = parsed.port  # Reject malformed ports at startup.
    return value.rstrip("/")


@dataclass(frozen=True)
class Settings:
    contact_email: str = ""
    public_base_url: str = ""
    allowed_hosts: tuple[str, ...] = ("localhost", "127.0.0.1", "[::1]", "healthcheck.railway.app")

    @classmethod
    def from_env(cls) -> "Settings":
        email = os.getenv("CONTACT_EMAIL", "").strip()
        if email and not re.fullmatch(r"[^\s@<>();]+@[^\s@<>();]+\.[^\s@<>();]+", email):
            raise ValueError("CONTACT_EMAIL must be a valid contact email")
        origin = os.getenv("PUBLIC_BASE_URL", "").strip()
        railway_domain = os.getenv("RAILWAY_PUBLIC_DOMAIN", "").strip()
        if not origin and railway_domain:
            origin = "https://" + railway_domain
        if origin:
            origin = validate_origin(origin)
        extra = tuple(h.strip() for h in os.getenv("ALLOWED_HOSTS", "").split(",") if h.strip())
        if any(not re.fullmatch(r"[A-Za-z0-9.\-:\[\]]+", h) for h in extra):
            raise ValueError("ALLOWED_HOSTS must contain explicit hostnames, without wildcards")
        hosts = cls.allowed_hosts + extra
        if origin:
            hosts += (urlsplit(origin).hostname,)
        return cls(email, origin, hosts)

    @property
    def user_agent(self) -> str:
        contact = f" (mailto:{self.contact_email})" if self.contact_email else ""
        return "CitationResolver/0.1" + contact
