---
id: FG-538
type: story
status: deferred
title: "Research: Crawl4AI acquisition and personal knowledge hub fit for Forge"
created: 2026-07-12
---

**Disposition (2026-07-19):** Deferred until durable external-source acquisition becomes an explicit Forge product priority. It is outside the current orchestration program.

## Problem

Forge has interactive browser tooling and a mature dual-research workflow, but it does not have a repeatable way to acquire a bounded web corpus, normalize it into durable source artifacts, reuse the same source snapshot across agents, or refresh external knowledge with explicit provenance.

Crawl4AI may fill that acquisition gap. It supports browser-backed single-page and multi-page crawling, Markdown generation, structured extraction, deep and adaptive crawling, caching, rate limiting, and a self-hosted REST/MCP server. It may be useful for a personal knowledge hub or second brain, reproducible research evidence packs, versioned external documentation context, change monitoring, and public deployment inspection.

It also introduces significant risks and ambiguity: Python/Chromium infrastructure inside a TypeScript/Docker system, mixed stable-versus-documentation versions, nontrivial memory use, SSRF and prompt-injection exposure, robots compliance disabled by default, broad MCP capabilities, authenticated-browser credential risk, an additional license attribution requirement, and the temptation to mistake a crawler for a complete knowledge platform.

The initial assessment recommends a host-owned, policy-constrained acquisition service whose immutable outputs are consumed read-only by agents. It rejects embedding Crawl4AI in every agent runtime or treating it as Forge's search engine, knowledge database, truth verifier, or merge evidence.

Primary internal reference: `docs/research/crawl4ai-integration-assessment-2026-07-12.md`.

## Goal

Determine whether Crawl4AI provides enough measurable value over Forge's existing browser tools and lighter extraction alternatives to justify a narrow optional acquisition subsystem. Produce a go/no-go recommendation, a benchmark, and an implementation-ready boundary for one selected pilot use case.

## Acceptance Criteria

- The research explicitly reviews and references `docs/research/crawl4ai-integration-assessment-2026-07-12.md` and preserves its distinction between web acquisition and a complete personal knowledge product.
- The output lives in an appropriate durable research path, such as `docs/research/crawl4ai-forge-acquisition.md`, and clearly separates sourced product facts, observed benchmark results, Forge-specific inference, and recommendations.
- Verify the exact latest stable Crawl4AI release at execution time and compare it with the public documentation version. Pin the benchmark to an immutable version or image digest; do not benchmark `latest`.
- Review Crawl4AI's license and additional attribution requirement and record the implications for private use, public Forge distribution, documentation, and derivative integration. Flag unresolved legal interpretation rather than silently calling it standard Apache-2.0.
- Compare at least:
  - Forge's existing browser-tools/Playwright path;
  - a pinned Crawl4AI release;
  - a lightweight static-page extractor such as Trafilatura;
  - Crawlee where TypeScript/runtime alignment may outweigh Crawl4AI's Markdown pipeline;
  - a hosted or self-hosted product such as Firecrawl where operational burden is relevant;
  - an existing knowledge product such as Karakeep for the build-versus-integrate second-brain decision.
- Select exactly one initial pilot use case and justify it:
  - personal knowledge capture and refresh; or
  - shared, reproducible source packs for `research-synthesis`.
  Do not build both during this ticket.
- Define the end-to-end boundary for the selected use case, including URL discovery or user capture, bounded acquisition, immutable source versions, normalization, deduplication, indexing/retrieval ownership, agent consumption, citation, refresh, retention, and deletion. Clearly identify which stages Crawl4AI supplies and which Forge or another product must own.
- Benchmark a representative corpus containing static pages, JavaScript-rendered pages, small bounded documentation sites, and public PDF/table-heavy content where supported. Exclude authenticated sources and sites requiring stealth or access-control bypass.
- Measure at minimum:
  - main-content completeness and boilerplate rate;
  - heading, code, table, and link preservation;
  - final URL and metadata correctness;
  - deterministic output across repeated runs;
  - crawl-bound and cancellation enforcement;
  - robots and rate-limit behavior;
  - provenance completeness;
  - failure classification;
  - latency, peak memory, CPU, artifact size, and setup burden.
- Define a durable source-artifact manifest including requested/final URL, timestamp, status, content type, content hashes, raw and filtered Markdown, link/crawl lineage, crawler version and image identity, configuration hash, robots decision, cache provenance, warnings, and failures.
- Evaluate a host-owned Docker/sidecar or local-service boundary. The research must explicitly compare a narrow Forge REST adapter with direct MCP exposure and explain which capabilities should be withheld from agents.
- Produce a threat model covering:
  - prompt injection in crawled content;
  - malicious JavaScript and browser exploitation;
  - SSRF to loopback, private networks, cloud metadata, Docker host, or local services;
  - redirects and cross-domain expansion;
  - credential/cookie leakage;
  - unbounded depth, page count, bytes, duration, concurrency, and storage;
  - public server exposure, authentication, and broad `execute_js`-style capabilities;
  - copyright, terms, robots directives, attribution, retention, and deletion.
- The recommended default policy must enable robots checking, identify the crawler, apply per-domain rate limits, remain same-domain unless explicitly approved, cap pages/depth/bytes/time/concurrency, block private-network targets, disable stealth mode, avoid authenticated browsing, and disable LLM extraction for the first pilot.
- Define how source artifacts remain untrusted data: agents may quote and analyze them but must not treat embedded page instructions as system or operator commands.
- Produce a concrete go/no-go decision and implementation backlog map. A no-go result is acceptable and should identify whether Forge should retain current browser tools, adopt a lighter extractor, use Crawlee, or integrate with an existing knowledge product instead.

## Non-Goals

- No production Crawl4AI dependency or service in this ticket.
- No unrestricted Crawl4AI MCP server exposed to Forge agents.
- No authenticated/private-source crawling in the pilot.
- No stealth, anti-bot, CAPTCHA, or access-control bypass.
- No vector database, complete second-brain UI, bookmarking application, or generalized knowledge graph implementation.
- No replacement of browser-based UI testing or interactive research.
- No use of crawled content as merge, CI, or deployment authorization evidence.
- No LLM extraction until deterministic acquisition and normalization are measured first.

## References

- Internal assessment: `docs/research/crawl4ai-integration-assessment-2026-07-12.md`
- Forge strategic review: `notes/forge-strategic-review-2026-07-10.md`
- Forge research workflow: `seeds/workflows/research-synthesis.yml`
- Crawl4AI documentation: https://docs.crawl4ai.com/
- Crawl4AI repository: https://github.com/unclecode/crawl4ai
- Crawl4AI releases: https://github.com/unclecode/crawl4ai/releases
- Crawl4AI license: https://github.com/unclecode/crawl4ai/blob/main/LICENSE
- Trafilatura: https://trafilatura.readthedocs.io/en/stable/
- Crawlee: https://crawlee.dev/js/
- Firecrawl: https://docs.firecrawl.dev/introduction
- Karakeep: https://docs.karakeep.app/
