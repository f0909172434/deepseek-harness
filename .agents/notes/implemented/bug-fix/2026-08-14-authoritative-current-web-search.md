# Agent Note: Authoritative current web search

Status: implemented

English | [中文](2026-08-14-authoritative-current-web-search.zh.md)

## Problem

Current, latest, and as-of questions could produce stale comparisons even when `web_search` ran successfully. The model-facing tool accepted only a query, so the caller could not request a first-party-only verification pass. The shipped DeepSeek provider also performs search through a separate auxiliary Messages request that does not inherit the outer agent's system prompt or time context. Its previous one-line instruction neither preserved explicit temporal intent nor required current-version checks and citation excerpts. In search-only compositions, the outer agent frequently received only titles and URLs and could therefore mistake an older, top-ranked item for the current product or benchmark entry.

## Decision

`web_search` now accepts optional `allowed_domains`, mapped to the seam as `allowedDomains`. The portable contract is intentionally limited to 1–20 bare printable-ASCII hostnames. The seam lowercases and deduplicates the list, rejects schemes, paths, ports, credentials, wildcards, and IP literals before provider dispatch, and treats exact hosts and their subdomains as allowed. Exa receives `includeDomains`, Perplexity receives `search_domain_filter`, and the DeepSeek Anthropic-compatible native search tool receives `allowed_domains`.

The provider-side control is not trusted as the postcondition. After a provider returns, the seam verifies every structured source URL against the normalized allowlist before applying `maxResults`. Any violation fails with `WEB_SEARCH_FILTER_VIOLATION`; invalid input fails with `WEB_INVALID_SEARCH_FILTER`. The failure message identifies only the source position and never echoes a provider URL, because returned query strings may contain sensitive values. Provider-generated prose is not mechanically parsed, so the guarantee is deliberately limited to structured sources.

The model guidance now requires search for mutable current/latest/as-of claims, asks for an absolute date in the query, recommends a first-party allowlisted pass plus an unrestricted independent-comparison pass, prohibits substituting an older version for an unresolved current one, and asks the model to disclose missing excerpts. The separate DeepSeek auxiliary request repeats the temporal and source-authority policy and asks for citations so citation excerpts can populate normalized snippets.

## Alternatives considered

**Treat the time-context composition change as the complete fix.** Rejected. Time context reaches the outer conversation, while DeepSeek native search is planned in a separate Messages request. The additional search turn needs its own explicit instruction, and time alone does not provide a first-party retrieval control.

**Add recency, date-range, ranking, and source-policy fields together.** Rejected for this change. The current providers do not share honest hard semantics for those controls, and DeepSeek's `page_age` is a provider-supplied label rather than a comparable ISO timestamp. Promoting unsupported fields would imply guarantees the seam cannot enforce.

**Enable `web_fetch` in shipped compositions.** Rejected. The shipped fetch provider remains disabled until complete private-network and redirect-hop protection exists; freshness work must not reopen the known SSRF boundary.

**Silently discard out-of-allowlist sources.** Rejected. A provider-generated answer may already depend on a discarded source, and silent filtering would present mixed-scope evidence as if it passed verification. Failing loudly preserves an auditable boundary.

## Consequences

Callers can make a deterministic first-party structured-source pass without adding a provider-specific tool. The allowlist is portable and seam-verified, but it is not a freshness filter and it does not prove that generated provider prose used only allowed evidence. Currentness still depends on an absolute-date query, evidence completeness, and the answering model's synthesis.

The prompt changes mitigate stale query planning and missing citation excerpts but do not guarantee that an upstream search index contains the newest page or that its native ranking is temporally correct. A missing current version must remain explicit rather than being filled with an older substitute. Search result order is otherwise provider-owned, and `publishedAt` remains an opaque provider date/page-age label that must not be used for cross-provider temporal ranking without a separate normalized contract.
