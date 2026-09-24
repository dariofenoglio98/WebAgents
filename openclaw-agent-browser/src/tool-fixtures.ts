/**
 * Host-owned probe fixtures: what the tool probe is allowed to ask for.
 *
 * The probe exists to verify the broker, not to make a request. If its caller
 * could supply arguments, the operator-only operation behind it would be a
 * general JSON client with a package's schema bolted on; if it could supply an
 * endpoint it would be `curl` inside OpenClaw. So the caller chooses a
 * **fixture id** from this table and nothing else, and every byte the fixture
 * sends is written here, in trusted host code.
 *
 * Two kinds of value live in each entry, and they are not the same thing:
 *
 * * `args` — what the tool is called with. The package's own declared input
 *   schema validates it inside `Runtime.call_tool` before anything leaves;
 * * `workflowInput` — what `execution.begin` validates against the package's
 *   own workflow input schema, because binding a session validates its task
 *   before it will bind. The probe never reaches the graph, so this exists to
 *   satisfy that check and for no other reason.
 *
 * The identifiers below are the ones this repository already uses as its
 * public examples of the service's own contract — they are in its `SKILL.md`,
 * its README and its test suite — rather than something invented here.
 */

export type ToolProbeFixture = {
  id: string;
  toolId: string;
  description: string;
  args: unknown;
  workflowInput: unknown;
  /**
   * The fixture reads a selected file. Its only argument is then the opaque id
   * of a capability the operator selected in the probing session, supplied by
   * the host at probe time — never a path and never a value the caller writes.
   */
  requiresFile?: boolean;
};

/**
 * A workflow input that satisfies the reference package's declared schema.
 *
 * Nothing about it is used: the probe makes one tool call and never
 * instantiates a workflow. It is here because binding a session validates its
 * input first, and refusing to bind would mean the probe could not run.
 */
const INERT_REVIEW_INPUT = {
  question: "Host tool-broker conformance probe; no workflow is executed.",
  seeds: [],
  documents: {},
  mode: "live",
} as const;

export const TOOL_PROBE_FIXTURES: readonly ToolProbeFixture[] = Object.freeze([
  {
    id: "echo",
    toolId: "test.echo",
    description: "The deterministic local implementation, with no I/O at all.",
    args: { value: "tool broker probe" },
    workflowInput: { value: "tool broker probe" },
  },
  {
    id: "doi",
    toolId: "citation-resolver",
    description:
      "One DOI this repository already uses as its published example of the service's own " +
      "contract, resolved as JSON with BibTeX requested.",
    args: { query: "10.1038/nphys1170", query_type: "doi", format: "bibtex" },
    workflowInput: INERT_REVIEW_INPUT,
  },
  {
    id: "arxiv",
    toolId: "citation-resolver",
    description: "One arXiv identifier from the same published examples.",
    args: { query: "arXiv:1706.03762", query_type: "arxiv", format: "json" },
    workflowInput: INERT_REVIEW_INPUT,
  },
  {
    id: "title",
    toolId: "citation-resolver",
    description:
      "One title lookup from the same published examples. A title is a heuristic match, so " +
      "this one may legitimately answer `ambiguous`.",
    args: { query: "Attention Is All You Need", query_type: "title", format: "bibtex" },
    workflowInput: INERT_REVIEW_INPUT,
  },
  {
    id: "bibliographic",
    toolId: "scholarly-search",
    description:
      "One bibliographic query for a widely indexed title, three rows. A search ranks; it " +
      "does not resolve, so the probe checks the shape and provenance of what came back, " +
      "not which paper is first.",
    args: { query: "Attention Is All You Need", limit: 3 },
    workflowInput: INERT_REVIEW_INPUT,
  },
  {
    id: "topic",
    toolId: "scholarly-search",
    description: "One topical query of the kind a literature plan produces, five rows.",
    args: { query: "communication topology multi-agent large language models", limit: 5 },
    workflowInput: INERT_REVIEW_INPUT,
  },
  {
    id: "selected-pdf",
    toolId: "paper-reader",
    description:
      "Reads the one PDF the operator selected in the probing session, by the opaque id the " +
      "host issued for it.",
    args: { file_id: "<selected at probe time>" },
    workflowInput: INERT_REVIEW_INPUT,
    requiresFile: true,
  },
]);

/** Fixture ids this host offers for one declared tool. */
export function fixturesFor(toolId: string): ToolProbeFixture[] {
  return TOOL_PROBE_FIXTURES.filter((fixture) => fixture.toolId === toolId);
}

/**
 * The one fixture a probe will send, or a refusal naming what is on offer.
 *
 * A tool with no fixture cannot be probed. That is the intended answer: the
 * alternative would be inventing a request for a service whose contract this
 * host has not written down.
 */
export function pickFixture(toolId: string, fixtureId?: string): ToolProbeFixture {
  const candidates = fixturesFor(toolId);
  if (candidates.length === 0) {
    throw new Error(
      `This host has no probe fixture for ${toolId}. A probe sends host-owned input only, so ` +
        "a tool without one cannot be probed.",
    );
  }
  if (!fixtureId) return candidates[0]!;
  const chosen = candidates.find((fixture) => fixture.id === fixtureId);
  if (!chosen) {
    throw new Error(
      `Unknown probe fixture ${fixtureId} for ${toolId}; this host offers ` +
        candidates.map((fixture) => fixture.id).join(", "),
    );
  }
  return chosen;
}
