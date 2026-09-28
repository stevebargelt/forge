// FG-402 contract, owned by core since FG-820: the vocabulary, item/envelope types and the
// pure compose/sort/dedupe helpers live in src/v2/attention-inbox.ts so `forge attention
// list` and this dashboard serve ONE derivation. Re-exported for the dashboard's modules.
export * from "../../src/v2/attention-inbox.js";
