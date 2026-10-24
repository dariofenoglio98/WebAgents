/** The conversation's own refusals (`agentpkg/conversation/errors.py`): a code first, so a host can name it. */
import { AgentPkgError } from "../errors.js";

/** Refused before the conversation starts, or by the conversation's own rules. */
export class ConversationError extends AgentPkgError {
  override readonly name: string = "ConversationError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/** A consent host's failure: an answer outside the decision contract. */
export class ConsentError extends AgentPkgError {
  override readonly name: string = "ConsentError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}
