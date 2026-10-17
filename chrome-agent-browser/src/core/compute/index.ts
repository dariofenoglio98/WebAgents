/**
 * compute.v0 in the Chrome core (D-185, D-240…D-245, D-250…D-252): WebAssembly core modules as pure
 * functions inside workflow.v0. `module.ts` reads a module without running it (the structural
 * requirements and the feature gate both runtimes check identically); `declarations.ts` ties the
 * graph, the members and the permission together at validation; `engine.ts` runs one call in a
 * nested Worker per call; `worker-body.ts` is the pure call the Worker executes.
 */
export * from "./declarations.js";
export * from "./engine.js";
export * from "./errors.js";
export * from "./limits.js";
export { ALLOWED_FEATURES, checkModule, hasWasmHeader, MAX_LOCALS, MAX_MODULE_BYTES, MAX_PAGES, ModuleError, moduleFactsJson, readModule, type Export, type FuncType, type Import, type ModuleFacts, type ModuleInfo } from "./module.js";
export { classifyTrap, runComputeCall, type CallAnswer } from "./worker-body.js";
