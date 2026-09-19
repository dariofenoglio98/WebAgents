from app.matching import confident, rank_candidates, title_score
from app.models import Author, Paper


def paper(title, doi="10.1234/example", **kwargs):
    return Paper(title=title, doi=doi, source="crossref", **kwargs)


def test_ranking_uses_lexical_similarity_not_provider_order():
    candidates, _ = rank_candidates(
        "Attention Is All You Need",
        [
            paper("Unrelated Applied Chemistry", "10.1234/other"),
            paper("ATTENTION: Is All You Need!"),
        ],
    )
    assert len(candidates) == 1
    assert candidates[0].match_score == 1
    assert confident("Attention Is All You Need", candidates)


def test_short_query_is_ambiguous_even_with_exact_match():
    candidates, _ = rank_candidates("Deep Learning", [paper("Deep Learning")])
    assert not confident("Deep Learning", candidates)


def test_close_candidates_are_ambiguous():
    candidates, _ = rank_candidates(
        "A Study of Reliable Citation",
        [
            paper("A Study of Reliable Citations", "10.1234/a"),
            paper("A Study of Reliable Citation", "10.1234/b"),
        ],
    )
    assert len(candidates) == 2
    assert not confident("A Study of Reliable Citation", candidates)


def test_weak_candidates_are_discarded():
    candidates, _ = rank_candidates("Attention Is All You Need", [paper("Marine Biology")])
    assert not candidates
    assert not confident("Attention Is All You Need", candidates)
    assert title_score("", "") == 0


def test_subset_match_is_not_perfect():
    assert title_score("Learning", "An Extensive Study of Learning in Diverse Settings") < 0.72


def test_same_title_different_identifiers_are_not_deduplicated():
    candidates, _ = rank_candidates(
        "A Study of Citations",
        [
            paper("A Study of Citations", "10.1234/a"),
            paper("A Study of Citations", "10.1234/b"),
        ],
    )
    assert len(candidates) == 2
    assert not confident("A Study of Citations", candidates)


def test_nonconflicting_duplicate_prefers_whole_crossref_record():
    a = Paper(title="A Study of Citations", doi="10.1234/a", year=2020, source="openalex")
    b = paper("A Study of Citations", "10.1234/a")
    candidates, warnings = rank_candidates(a.title, [a, b])
    assert len(candidates) == 1
    assert candidates[0].paper.source == "crossref"
    assert candidates[0].paper.year is None  # Never fill from a different record.
    assert not warnings


def test_conflicting_records_are_kept_and_reported():
    a = Paper(
        title="A Study of Citations",
        doi="10.1234/a",
        year=2020,
        source="openalex",
        authors=[Author(name="Other Author")],
    )
    b = paper(a.title, "10.1234/a", year=2021, authors=[Author(name="Ada Researcher")])
    candidates, warnings = rank_candidates(a.title, [a, b])
    assert len(candidates) == 2
    assert "year" in warnings[0] and "authors" in warnings[0]
    assert not confident(a.title, candidates)
