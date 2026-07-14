# Pinecone / Forge Assessment

Date: 2026-07-13

Sources reviewed:

- [Pinecone product and pricing](https://www.pinecone.io/pricing/)
- [Pinecone Database overview](https://docs.pinecone.io/guides/get-started/overview)
- [Data modeling](https://docs.pinecone.io/guides/index-data/data-modeling)
- [Data freshness and consistency](https://docs.pinecone.io/guides/index-data/check-data-freshness)
- [Pinecone Local](https://docs.pinecone.io/guides/operations/local-development)
- [Pinecone Assistant architecture](https://docs.pinecone.io/reference/architecture/assistant-architecture)
- [Pinecone MCP server](https://docs.pinecone.io/guides/operations/mcp-server)
- [Security overview](https://docs.pinecone.io/guides/production/security-overview)
- [Data deletion](https://docs.pinecone.io/guides/production/data-deletion)
- [Index export limitations](https://docs.pinecone.io/troubleshooting/export-indexes)
- [Pinecone Nexus public preview](https://www.pinecone.io/blog/pinecone-nexus-public-preview/)
- [Nexus early-access benchmarks](https://www.pinecone.io/blog/nexus-ea-benchmarks/)

This is a lightweight product and architecture assessment, not a formal Forge
research run or an implementation contract. Product availability, preview
status, limits, and prices are current as of the date above.

## Executive Take

Pinecone is relevant to Forge, but it solves a different problem from
Graphify. Graphify should remain Forge's local, exact-revision structural
code-intelligence layer. Pinecone could become an optional semantic retrieval
plane spanning all managed projects. Pinecone must not become authoritative
for orchestration, task state, exact-SHA dependencies, continuation claims,
publication safety, or any other correctness-bearing transition.

The most promising mature surface is Pinecone Database: semantic retrieval,
lexical retrieval, metadata filtering, and reranking over a derived corpus.
Pinecone Assistant is likely too opinionated for Forge because it owns
chunking, embedding, query formulation, ranking, and LLM response generation.
Pinecone Nexus is strategically more interesting than either because it aims
to compile bounded corpora into versioned, typed knowledge artifacts ahead of
query time, but it is currently a request-access public preview and is not a
safe foundation for a binding Forge design.

The provisional recommendation is a bounded Database experiment over
non-critical project knowledge, with Nexus evaluated separately if preview
access is available. No implementation should make Pinecone a required Forge
dependency.

## The Pinecone Product Stack

| Product | What it does | Potential Forge fit |
|---|---|---|
| Pinecone Database | Dense semantic search, sparse/lexical search, metadata filtering, and reranking | Cross-project retrieval over ADRs, tickets, memories, incidents, research, and selected source artifacts |
| Pinecone Assistant | Managed document ingestion, chunking, embedding, retrieval, ranking, and LLM answer generation | Probably too opaque and policy-owning for Forge's initial use |
| Pinecone Nexus | Compiles a bounded corpus into persistent structured knowledge artifacts queried through KnowQL | Potential future institutional-knowledge layer; not mature enough to bind Forge to today |

Pinecone Database supports dense vectors for semantic similarity, sparse
vectors for lexical similarity, metadata filters, and hosted reranking. Its
newer document-schema model can carry dense, sparse, and full-text fields in a
single index. That model is currently a public preview: schema migration is
not supported after index creation, and document-schema indexes are excluded
from the current serverless backup feature. A first Forge experiment should
not quietly make preview-only full-text behavior part of a durable contract.

Pinecone can host the embedding model or accept externally generated vectors.
Integrated embedding is simpler operationally, but the embedding model is
fixed when the index is created. A model change therefore becomes an explicit
reindex/version migration. Bringing Forge-generated vectors provides more
model and provenance control, but Forge must then operate the embedding path
and ensure the same model and parameters are used for documents and queries.

## Relationship To Graphify

Graphify and Pinecone are complementary, not substitutes:

- **Graphify:** "What statically imports `executor.ts` in this graph built for
  this revision?"
- **Pinecone Database:** "Where have our projects previously encountered a
  durable record contradicting an operator-facing status?"
- **Pinecone Nexus:** "Compile our publication invariants, incidents, ADRs,
  and implementation evidence into a typed answer for this class of failure."

Graphify supplies structural candidates from an AST-derived graph. Pinecone
supplies semantic analogies and institutional history. Neither is proof of
correctness: Graphify has known extraction gaps such as dynamic imports, and
vector similarity is evidence for where to look rather than proof of a
dependency or invariant.

A future Forge dispatch packet could combine:

1. Graphify's exact-SHA affected-node result.
2. Pinecone's related decisions, incidents, tickets, and prior solutions.
3. The task's explicit files, acceptance criteria, and binding constraints.
4. Compiler, tests, gates, and source inspection as the final authority.

The structural and semantic results should remain visibly attributed. Forge
must not merge them into an untraceable "recommended context" blob.

## The Broader Forge Opportunity

The strongest use case is not Forge-on-Forge. It is Forge acting as a
knowledge broker across every managed workspace.

Candidate questions include:

- Where did another project already solve a similar ownership or publication
  problem?
- Which prior incidents involved cancellation racing recovery?
- Which ADRs and backlog findings are relevant to adding a new task status?
- Which memories are likely contradicted by the current diff?
- Which GasCity or GasTown decisions are relevant to the current Forge work?
- What prior review finding established the rule now being exercised?
- Which research, operational evidence, and source artifacts support a
  proposed design assumption?

This attacks the semantic half of Forge's context problem. Graphify attacks
the structural half. Forge's existing files, Git history, SQLite ledger, and
receipts continue to carry canonical truth.

## Binding Boundary If Forge Experiments

Any Pinecone integration should start with the following boundary:

1. Git, Forge SQLite, and original documents remain authoritative.
2. Pinecone holds only reproducible, derived records.
3. Every record carries stable provenance: project identity, source type,
   source ID, path where applicable, commit SHA, content hash, embedding model
   and version, ingestion generation, and sensitivity classification.
4. Forge owns ingestion and retrieval. Agent containers do not receive an
   account-wide Pinecone key or unrestricted index-management tools.
5. Pinecone unavailability or an empty result degrades context quality only;
   it does not stop core orchestration.
6. No Pinecone result can authorize publication, continuation claiming,
   cancellation reversal, retry, close, merge, or lifecycle transition.
7. Every index can be deleted and rebuilt from canonical sources.
8. Retrieved context names its sources and the indexed revision. A consumer
   can distinguish current evidence from historical evidence.
9. Exact-SHA structural questions remain with Graphify/source inspection, not
   embedding similarity.
10. Secrets, credentials, raw private transcripts, and unclassified agent
    logs are excluded unless a separate data-governance decision admits them.

The rebuild rule is load-bearing. Pinecone does not currently provide a
general index-export function; its own guidance is to retain source data and
reindex when moving. A Pinecone backup is useful for restoring an index inside
Pinecone, not for making Pinecone the portable source of truth.

## Freshness And Versioning

Pinecone serverless is eventually consistent. A successful write does not by
itself prove that an immediate query observes that write. Pinecone exposes a
monotonically increasing log sequence number per namespace: writes return a
request LSN and queries return a maximum indexed LSN. A consumer can compare
them to establish that a query reflects at least a particular write.

That creates a concrete Forge requirement if fresh context is promised:

- persist the ingestion generation and write LSN;
- do not mark that generation queryable until observed query freshness reaches
  the required LSN;
- preserve the prior complete generation until promotion;
- make incomplete or stale generations visible rather than silently querying
  them;
- treat Pinecone as a derived cache even after promotion.

Namespace-per-commit is unlikely to be a sound default because it grows
without bound and complicates cross-revision retrieval. A more plausible
experiment is namespace-per-project with content-addressed records and
metadata for commit SHA and ingestion generation. That remains a hypothesis
to test: filtering and cleanup behavior must be measured against realistic
history before it becomes a design decision.

## Pinecone Local Is Not A Durable Local Store

Pinecone Local is an in-memory Docker emulator intended for development. It
loses all records when stopped, is limited to 100,000 records per index, uses
an older API version, ignores authentication, and omits namespace management,
Inference, Assistant, imports, and backups.

It is useful for API compatibility and failure-path tests. It cannot serve as
Forge's persistent host-local knowledge database, offline production mode, or
durable fallback when the hosted service is unavailable. If durable local or
offline vector retrieval becomes a requirement, that is a different product
evaluation rather than a Pinecone Local deployment decision.

## Security And Data Governance

Pinecone encrypts stored data with AES-256 and uses TLS for data in transit.
More stringent controls are plan-dependent: private networking,
customer-managed encryption keys, audit logs, and service accounts are listed
under Enterprise. Pinecone's documented deletion process soft-deletes
customer data and permanently deletes it before the end of a maximum 90-day
retention window.

These facts do not block a sanitized experiment, but they rule out treating a
free or Builder-plan index as an unexamined destination for every private
repository, raw task transcript, or secret-bearing artifact. Forge would need
an explicit inclusion policy, redaction before ingestion, API-key isolation,
and deletion/rebuild controls before wider use.

Pinecone's MCP server is an integration convenience, not the desired Forge
trust boundary. It can create and inspect indexes, upsert records, search, and
rerank, and currently supports integrated-embedding indexes. Exposing those
management tools directly to arbitrary agents would let the consumer mutate
the context substrate it is supposed to read. Forge should instead expose a
bounded retrieval operation backed by a host-side credential owner.

## Cost

Cost is unlikely to be the first constraint at Forge's current scale. As of
2026-07-13:

- Starter is free, with up to 2 GB of Database storage, five indexes, one
  million read units per month, two million write units per month, and hosted
  embedding allowances.
- Builder is $20/month flat, with up to 10 GB, ten indexes per project, larger
  read/write allowances, multiple projects/users, and broader region choice.
- Standard carries a $50/month minimum usage charge and adds pay-as-you-go
  usage, backups, import, RBAC, and SAML SSO.
- Enterprise carries a $500/month minimum and adds the private networking,
  customer-managed keys, audit logs, service accounts, and uptime SLA relevant
  to more sensitive production deployments.

The dominant early costs are likely to be lifecycle design, stale-data
prevention, provenance, redaction, relevance evaluation, and model-version
migration rather than Pinecone usage charges.

## Pinecone Assistant

Assistant manages document upload, chunking, embeddings, storage, retrieval
query formulation, ranking, and LLM answer generation. It can return citations
and expose context through a dedicated MCP endpoint.

That is attractive for a standalone document assistant, but it crosses too
many Forge ownership boundaries for an initial integration:

- Forge cannot directly govern the chunking contract.
- Retrieval formulation and ranking become service-owned behavior.
- LLM selection and response generation overlap Forge's runtime/model policy.
- Exact Git revision and cross-artifact provenance are not native Forge
  invariants unless Forge reconstructs them around the service.
- Managed answers make it harder to distinguish retrieved evidence from model
  synthesis.

Database retrieval is the cleaner first experiment because Forge can retain
ownership of source selection, record identity, prompting, synthesis, and
evidence display.

## Pinecone Nexus

Nexus is strategically the most relevant Pinecone product. It describes
itself as a knowledge engine rather than a retrieval system: a context compiler
uses a manifest, source corpus, task/evaluation set, and iterative build loop
to create persistent structured knowledge artifacts. Agents query those
artifacts through KnowQL, whose advertised primitives include intent,
deterministic filters, provenance, typed output shape, confidence, and token or
latency budget.

This resembles Forge's larger institutional-context goal more closely than a
plain vector index. It could eventually address cross-document and
cross-project questions that require relationships to be compiled before the
task begins rather than rediscovered through repeated retrieval loops.

However, the evidence is not yet strong enough to make Nexus a Forge design
dependency:

- Nexus entered public preview on 2026-07-01.
- Preview access is request-based rather than a generally self-service,
  contract-stable API surface.
- The production deployment described publicly is dedicated BYOC.
- The context compiler is itself an autonomous agentic build loop, which may
  overlap the knowledge-lifecycle decisions Forge intends to own.
- Public material does not yet establish enough about incremental rebuilds,
  exact source-version binding, schema evolution, compiler failure recovery,
  artifact deletion, deterministic promotion, or portability.
- Published results are Pinecone-run benchmarks. They are promising evidence,
  not independent proof for Forge's corpus or questions.

Nexus should therefore be benchmarked, not adopted by assumption. A preview
evaluation should attempt to falsify its versioning, provenance, refresh,
governance, and recovery claims using Forge's real knowledge corpus.

## Recommended Experiment

Do not begin with source-code-wide ingestion or agent-autonomous use. Begin
with a bounded, non-critical corpus:

- Forge and GasCity/GasTown ADRs;
- selected backlog stories and closeout evidence;
- operational incident reports;
- current memories and handoff records after redaction;
- research documents;
- a small, deliberately selected set of source excerpts linked to exact SHAs.

Build 30–50 questions with known source evidence. Include easy lookup,
cross-document synthesis, cross-project analogy, stale-source traps, exact-SHA
questions, and questions that should return "insufficient evidence."

Compare:

1. `rg` and normal agent exploration.
2. Pinecone dense semantic retrieval.
3. Pinecone lexical or hybrid retrieval.
4. Graphify structural context plus Pinecone historical/semantic context.
5. Pinecone Nexus, if preview access is available.

Measure:

- source-level recall and precision;
- citation correctness;
- stale-revision and wrong-project retrieval rate;
- false confidence when evidence is absent;
- input context tokens delivered to the agent;
- total inference tokens, including retrieval loops;
- latency and Pinecone usage cost;
- ingestion/rebuild time;
- deletion and redaction behavior;
- failure behavior when Pinecone is unavailable or behind its write LSN;
- whether cross-project results are genuinely useful rather than merely
  semantically similar.

The experiment succeeds only if Pinecone improves evidence recall or context
cost without weakening provenance, exact-revision visibility, or graceful
degradation.

## Provisional Decisions

1. **Do not replace Graphify with Pinecone.** They answer different questions.
2. **Do not place Pinecone on Forge's correctness path.** It is an optional
   derived retrieval plane.
3. **Prefer Database over Assistant for the first experiment.** Forge should
   own the context lifecycle and synthesis.
4. **Retain canonical source outside Pinecone.** Rebuildability is mandatory.
5. **Treat freshness and model version as explicit provenance.** A successful
   upsert is not sufficient evidence that a query is current.
6. **Keep credentials host-side and expose bounded retrieval.** Do not give
   arbitrary agents management access to the knowledge substrate.
7. **Evaluate Nexus separately.** It is strategically interesting but too new
   to bind an implementation plan to.
8. **Run a measured corpus experiment before allocating integration work.**
   The decision should rest on Forge-specific recall, provenance, token, and
   failure evidence rather than generic RAG claims.

