//! Bookkeeping as a compute.v0 module (Rust, `wasm32-unknown-unknown`).
//!
//! The host hands this module one JSON text and reads one JSON text back; the module imports
//! nothing, so it can only compute over those bytes (compute.v0 §3, D-185). Two functions share
//! the module, and a graph names the one a node runs:
//!
//! * `assign_ids`: every found record gets a stable handle (`P1`, `P2`, …) in input order and an
//!   identity key, and exact duplicates of that key are dropped, first record wins. The key is
//!   the first usable of DOI (lower-cased, a `https://doi.org/` prefix removed), arXiv id
//!   (lower-cased, a version suffix removed), URL (lower-cased, trailing `/` removed) and title
//!   (case-folded, whitespace collapsed). This is the deterministic deduplication a model
//!   should never be asked to do (Literature Review 0.2.7 does it with `join.unique_by`; a
//!   module can normalize first).
//! * `match_quotes`: each quote is searched verbatim in each source's text after whitespace
//!   runs are collapsed in both; the first source and offset that contains it is reported, and
//!   quotes found nowhere are listed. This is the exact check behind "the quote occurs in the
//!   abstract" (workflow.v0's `contained_in`), with the normalization made explicit.
//!
//! Every check that fails aborts, which the engine reports as a trap (`unreachable`): a module
//! never returns half an answer. The input the host sends is canonical JSON the runtime already
//! validated against the node's `input_schema`, so this reader need not be stricter than
//! `serde_json`; the output is validated against `output_schema` after the call.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------------------------
// The ABI (compute.v0 §3): `memory` is exported by the linker; `alloc` hands the host a region
// for the input; each function returns the output's pointer and length packed into one i64.

#[no_mangle]
pub extern "C" fn alloc(len: i32) -> i32 {
    let mut buffer = Vec::<u8>::with_capacity(len.max(1) as usize);
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer as i32
}

#[no_mangle]
pub extern "C" fn assign_ids(ptr: i32, len: i32) -> i64 {
    call(ptr, len, |input| serde_json::to_value(assign(input)))
}

#[no_mangle]
pub extern "C" fn match_quotes(ptr: i32, len: i32) -> i64 {
    call(ptr, len, |input| serde_json::to_value(matches(input)))
}

fn call(ptr: i32, len: i32, f: impl FnOnce(Value) -> serde_json::Result<Value>) -> i64 {
    if ptr <= 0 || len < 0 {
        std::process::abort();
    }
    // SAFETY: the host wrote `len` bytes at the pointer `alloc` returned, inside this memory.
    let input = unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) };
    let value: Value = serde_json::from_slice(input).unwrap_or_else(|_| std::process::abort());
    let output = f(value).unwrap_or_else(|_| std::process::abort());
    let bytes = serde_json::to_vec(&output).unwrap_or_else(|_| std::process::abort());
    let out_ptr = bytes.as_ptr() as u64;
    let out_len = bytes.len() as u64;
    std::mem::forget(bytes);
    ((out_ptr << 32) | out_len) as i64
}

fn required<T: for<'de> Deserialize<'de>>(value: Value) -> T {
    serde_json::from_value(value).unwrap_or_else(|_| std::process::abort())
}

// ---------------------------------------------------------------------------------------------
// assign_ids

#[derive(Deserialize)]
struct AssignInput {
    records: Vec<Record>,
}

#[derive(Deserialize, Serialize, Clone)]
struct Record {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    doi: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    arxiv: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(flatten)]
    rest: serde_json::Map<String, Value>,
}

#[derive(Serialize)]
struct Assigned {
    id: String,
    key: String,
    #[serde(flatten)]
    record: Record,
}

#[derive(Serialize)]
struct Dropped {
    id: String,
    key: String,
    record: Record,
}

#[derive(Serialize)]
struct AssignOutput {
    records: Vec<Assigned>,
    duplicates: Vec<Dropped>,
}

fn assign(input: Value) -> AssignOutput {
    let input: AssignInput = required(input);
    if input.records.is_empty() || input.records.len() > 512 {
        std::process::abort();
    }
    let mut records = Vec::new();
    let mut duplicates = Vec::new();
    for record in input.records {
        let key = identity(&record).unwrap_or_else(|| std::process::abort());
        match records.iter().find(|r: &&Assigned| r.key == key) {
            Some(existing) => duplicates.push(Dropped { id: existing.id.clone(), key, record }),
            None => {
                let id = format!("P{}", records.len() + 1);
                records.push(Assigned { id, key, record });
            }
        }
    }
    AssignOutput { records, duplicates }
}

fn identity(record: &Record) -> Option<String> {
    if let Some(doi) = nonblank(&record.doi) {
        let doi = doi.to_lowercase();
        let doi = doi.strip_prefix("https://doi.org/").unwrap_or(&doi);
        let doi = doi.strip_prefix("doi:").unwrap_or(doi);
        return Some(format!("doi:{doi}"));
    }
    if let Some(arxiv) = nonblank(&record.arxiv) {
        let arxiv = arxiv.to_lowercase();
        let arxiv = arxiv.strip_prefix("arxiv:").unwrap_or(&arxiv);
        let base = match arxiv.rfind('v') {
            Some(at) if arxiv[at + 1..].chars().all(|c| c.is_ascii_digit()) && at + 1 < arxiv.len() => &arxiv[..at],
            _ => arxiv,
        };
        return Some(format!("arxiv:{base}"));
    }
    if let Some(url) = nonblank(&record.url) {
        return Some(format!("url:{}", url.to_lowercase().trim_end_matches('/')));
    }
    nonblank(&record.title).map(|title| format!("title:{}", collapse(&title.to_lowercase())))
}

fn nonblank(value: &Option<String>) -> Option<String> {
    value.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ---------------------------------------------------------------------------------------------
// match_quotes

#[derive(Deserialize)]
struct MatchInput {
    quotes: Vec<Quote>,
    sources: Vec<Source>,
}

#[derive(Deserialize)]
struct Quote {
    id: String,
    text: String,
}

#[derive(Deserialize)]
struct Source {
    id: String,
    text: String,
}

#[derive(Serialize)]
struct Match {
    quote: String,
    source: String,
    offset: usize,
}

#[derive(Serialize)]
struct MatchOutput {
    matches: Vec<Match>,
    unmatched: Vec<String>,
}

fn matches(input: Value) -> MatchOutput {
    let input: MatchInput = required(input);
    if input.quotes.len() > 256 || input.sources.len() > 256 {
        std::process::abort();
    }
    let sources: Vec<(String, String)> = input
        .sources
        .into_iter()
        .map(|source| (source.id, collapse(&source.text)))
        .collect();
    let mut found = Vec::new();
    let mut unmatched = Vec::new();
    for quote in input.quotes {
        let needle = collapse(&quote.text);
        if needle.is_empty() {
            std::process::abort();
        }
        match sources
            .iter()
            .find_map(|(id, text)| text.find(&needle).map(|offset| (id.clone(), offset)))
        {
            Some((source, offset)) => found.push(Match { quote: quote.id, source, offset }),
            None => unmatched.push(quote.id),
        }
    }
    MatchOutput { matches: found, unmatched }
}
