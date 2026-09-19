import pytest

from app.identifiers import detect_query, parse_arxiv, parse_doi
from app.matching import normalize_title


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("10.1234/ABC.Def", "10.1234/abc.def"),
        (" doi: 10.1234/ABC ", "10.1234/abc"),
        ("https://doi.org/10.1234/ABC", "10.1234/abc"),
        ("http://dx.doi.org/10.1234%2FABC?tracking=1#top", "10.1234/abc"),
        ("https://doi.org/10.1234/abc%23def", "10.1234/abc#def"),
        ("10.1234/a(1).", "10.1234/a(1)."),
    ],
)
def test_doi_formats(value, expected):
    assert parse_doi(value) == expected
    assert detect_query(value, "auto") == ("doi", expected)


@pytest.mark.parametrize(
    "value",
    [
        "10.123/abc",
        "10.1234/",
        "10.1234/a b",
        "a title",
        "https://doi.org.evil.test/10.1234/a",
        "https://doi.org@evil.test/10.1234/a",
        "https://evil.test/10.1234/a",
        "https://doi.org:bad/10.1234/a",
        "https://user@doi.org/10.1234/a",
        "https://doi.org:8080/10.1234/a",
    ],
)
def test_invalid_doi(value):
    assert parse_doi(value) is None
    with pytest.raises(ValueError):
        detect_query(value, "doi")


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("1706.03762", "1706.03762"),
        ("arXiv:1706.03762v2", "1706.03762v2"),
        ("https://arxiv.org/abs/1706.03762", "1706.03762"),
        ("https://arxiv.org/pdf/1706.03762v2.pdf?download=1", "1706.03762v2"),
        ("https://arxiv.org/pdf/1706.03762", "1706.03762"),
        ("0704.0001", "0704.0001"),
        ("1412.9999", "1412.9999"),
        ("1501.00001", "1501.00001"),
        ("hep-th/9901001", "hep-th/9901001"),
        ("arXiv:math.GT/0301001v3", "math.GT/0301001v3"),
        ("https://arxiv.org/pdf/hep-th/9901001.pdf", "hep-th/9901001"),
    ],
)
def test_arxiv_formats(value, expected):
    assert parse_arxiv(value) == expected
    assert detect_query(value, "auto") == ("arxiv", expected)


@pytest.mark.parametrize(
    "value",
    [
        "123456789",
        "2024",
        "17.03762",
        "1713.03762",
        "1700.03762",
        "1706.00000",
        "1706.0376",
        "1412.12345",
        "0703.0001",
        "0001.00001",
        "1706.03762v0",
        "hep-th/0801001",
        "hep-th/9012001",
        "hep-th/9913001",
        "hep-th/9901000",
        "https://arxiv.org.evil.test/abs/1706.03762",
        "https://arxiv.org/user/1706.03762",
    ],
)
def test_invalid_arxiv(value):
    assert parse_arxiv(value) is None
    with pytest.raises(ValueError):
        detect_query(value, "arxiv")


def test_plain_numbers_are_title_queries():
    assert detect_query("123456789", "auto") == ("title", "123456789")


def test_explicit_title_overrides_detection():
    assert detect_query("1706.03762", "title") == ("title", "1706.03762")


@pytest.mark.parametrize("value", ["arxiv:123", "doi:bad", "https://localhost/private"])
def test_auto_does_not_search_malformed_explicit_identifiers(value):
    with pytest.raises(ValueError):
        detect_query(value, "auto")


def test_title_normalization():
    assert normalize_title("  ATTENTION—is All: You Need!\n") == "attention is all you need"
    assert normalize_title("Ｆｕｌｌ Width / naïve") == "full width naïve"
