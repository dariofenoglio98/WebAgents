/**
 * Refusals and failures of link.v0 (`agentpkg/links/errors.py`, `links/resolve.py::LinkRefusal`).
 * `LinkError` (an inner run that failed) lives with the interpreter's failure classes, where
 * `failureCode` maps it to `link_error`.
 */
import { AgentPkgError } from "../errors.js";

export { LinkError } from "../workflow/errors.js";

/** A link the host refuses before the run: the code first, then the reason. */
export class LinkRefusal extends AgentPkgError {
  override readonly name: string = "LinkRefusal";
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}
