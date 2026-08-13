/**
 * Service Definition for the web access capability seam (`ctx.web`): registries and provider-selecting execution for search and
 * fetch. Duplicate ids are rejected. At execution time, a configured provider must exist and
 * be usable; without one, exactly one usable provider is required, so selection never depends
 * on registration order.
 * @module @deepseek-ai/dsh-web
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from './types.ts'
import { WebError } from './types.ts'

export {
  WebError,
} from './types.ts'
export type {
  WebFetchBody,
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    web: WebRuntime
  }
}

/** Selection inputs for execution-time provider resolution. */
interface Selection<P> {
  /** The configured provider id for this capability, if any. */
  readonly configuredId?: string
  /** Providers registered for this capability kind. */
  readonly providers: ReadonlyMap<string, P>
}

/**
 * Config for the web seam. `searchProvider` / `fetchProvider` pin which provider
 * wins for each capability; both are optional (a single registered usable
 * provider auto-selects). Operational overrides such as environment variables
 * must feed these same fields rather than introduce a hidden priority chain.
 */
export interface WebRuntimeConfig {
  /** Explicit search provider id. Omitted = auto-select when exactly one usable. */
  readonly searchProvider?: string
  /** Explicit fetch provider id. Omitted = auto-select when exactly one usable. */
  readonly fetchProvider?: string
}

/**
 * The web access service. Registered as `ctx.web` (one instance per context).
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `WEB_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable →
 *   `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `WEB_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `WEB_PROVIDER_UNAVAILABLE`.
 */
export class WebRuntime extends Service {
  /**
   * Provider selection config. Operational env overrides feed the SAME fields:
   * `$DSH_WEB_SEARCH_PROVIDER` / `$DSH_WEB_FETCH_PROVIDER` are equivalent to
   * `searchProvider` / `fetchProvider` and are NOT a hidden priority chain.
   */
  static Config: z<WebRuntimeConfig> = z.object({
    searchProvider: z.string(),
    fetchProvider: z.string(),
  })

  private searchProviders = new Map<string, WebSearchProvider>()
  private fetchProviders = new Map<string, WebFetchProvider>()
  private readonly searchProviderId: string | undefined
  private readonly fetchProviderId: string | undefined

  constructor(ctx: Context, config: WebRuntimeConfig = {}) {
    super(ctx, 'web')
    this.searchProviderId = config.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER
    this.fetchProviderId = config.fetchProvider ?? process.env.DSH_WEB_FETCH_PROVIDER
  }

  /**
   * Register a search provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for search. Returns a disposer; disposed
   * with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerSearchProvider(provider: WebSearchProvider): () => void {
    return this.registerProvider(this.searchProviders, provider)
  }

  /**
   * Register a fetch provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for fetch. Returns a disposer; disposed
   * with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerFetchProvider(provider: WebFetchProvider): () => void {
    return this.registerProvider(this.fetchProviders, provider)
  }

  private registerProvider<P extends { readonly id: string }>(store: Map<string, P>, provider: P): () => void {
    if (store.has(provider.id)) {
      throw new WebError(`a web provider with id "${provider.id}" is already registered`, 'WEB_DUPLICATE_PROVIDER')
    }
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => store.delete(provider.id)
    }, 'web.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Run one search through the selected provider. Resolves the provider at call
   * time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. The seam defensively enforces
   * `request.allowedDomains` after the provider returns, then enforces
   * `request.maxResults`: if the provider over-returns, `sources[]` is truncated
   * and `truncated` set.
   * @param request - the query, optional domain allowlist, and result limit.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the provider's results, capped to `request.maxResults`.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const allowedDomains = normalizeAllowedDomains(request.allowedDomains)
    const normalizedRequest: WebSearchRequest = {
      ...request,
      ...allowedDomains === undefined ? {} : { allowedDomains },
    }
    const provider = resolveProvider({
      providers: this.searchProviders,
      ...this.searchProviderId !== undefined ? { configuredId: this.searchProviderId } : {},
    })
    const result = await provider.search(normalizedRequest, signal)
    enforceAllowedSources(result, allowedDomains)
    return capSources(result, request.maxResults)
  }

  /**
   * Retrieve one URL through the selected provider. Resolves the provider at
   * call time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. A non-2xx response is a result, not a throw.
   * @param request - the URL plus retrieval options.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the retrieval outcome; non-2xx responses resolve descriptively.
   */
  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const provider = resolveProvider({
      providers: this.fetchProviders,
      ...this.fetchProviderId !== undefined ? { configuredId: this.fetchProviderId } : {},
    })
    return provider.fetch(request, signal)
  }
}

/** Maximum portable allowlist size (the smallest known provider limit). */
const MAX_ALLOWED_DOMAINS = 20

/**
 * Normalize and validate a portable domain allowlist before provider dispatch.
 * The shared contract accepts only ASCII hostnames: no schemes, paths,
 * credentials, ports, wildcards, or IP literals. Exact duplicates collapse in
 * first-seen order. An absent list stays absent rather than becoming an
 * accidental deny-all filter.
 *
 * @param values - caller-supplied hostnames, or `undefined` for no restriction.
 * @returns a lower-case, deduplicated allowlist, or `undefined`.
 * @throws {@link WebError} `WEB_INVALID_SEARCH_FILTER` for an invalid list.
 */
function normalizeAllowedDomains(values: readonly string[] | undefined): readonly string[] | undefined {
  if (values === undefined) return undefined
  if (values.length === 0) throw invalidSearchFilter('allowedDomains must contain at least one domain')
  if (values.length > MAX_ALLOWED_DOMAINS) {
    throw invalidSearchFilter(`allowedDomains supports at most ${MAX_ALLOWED_DOMAINS} domains`)
  }
  const domains = values.map((value) => {
    if (value !== value.trim() || value.length === 0) {
      throw invalidSearchFilter('allowedDomains entries must be non-empty and have no surrounding whitespace')
    }
    if (!/^[\x21-\x7e]+$/u.test(value)) {
      throw invalidSearchFilter('allowedDomains entries must contain only printable ASCII')
    }
    if (value.length > 253 || value.includes('://') || value.includes('/') || value.includes('\\')
      || value.includes('?') || value.includes('#') || value.includes('@') || value.includes(':')) {
      throw invalidSearchFilter('allowedDomains entries must be bare hostnames without scheme, path, credentials, port, query, or fragment')
    }
    const hostname = value.toLowerCase()
    const labels = hostname.split('.')
    let parsedHostname: string
    try {
      parsedHostname = new URL(`http://${hostname}`).hostname.toLowerCase()
    } catch {
      throw invalidSearchFilter('allowedDomains entries must be valid ASCII hostnames, not IP literals')
    }
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(hostname)
      || parsedHostname !== hostname
      || labels.length < 2
      || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
      throw invalidSearchFilter('allowedDomains entries must be valid ASCII hostnames, not IP literals')
    }
    return hostname
  })
  return [...new Set(domains)]
}

/** Build the stable error used for invalid search-domain controls. */
function invalidSearchFilter(message: string): WebError {
  return new WebError(message, 'WEB_INVALID_SEARCH_FILTER')
}

interface ResolvableProvider {
  readonly id: string
  available(): boolean
}

/** Resolve the selected provider or throw the matching {@link WebError}. */
function resolveProvider<P extends ResolvableProvider>(selection: Selection<P>): P {
  const { configuredId, providers } = selection
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw new WebError(`configured web provider "${configuredId}" is not registered`, 'WEB_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new WebError(`configured web provider "${configuredId}" is registered but unavailable`, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  const usable = [...providers.values()].filter(provider => provider.available())
  const [single] = usable
  if (single === undefined) {
    throw new WebError('no usable web provider is registered', 'WEB_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new WebError(`multiple usable web providers are registered (${ids}); configure one explicitly`, 'WEB_PROVIDER_AMBIGUOUS')
  }
  return single
}

/** Enforce `maxResults` on a search result: truncate `sources[]` and flag it. */
function capSources(result: WebSearchResult, maxResults: number | undefined): WebSearchResult {
  if (maxResults === undefined || result.sources.length <= maxResults) return result
  return { ...result, sources: result.sources.slice(0, maxResults), truncated: true }
}

/**
 * Enforce a provider-neutral hostname allowlist over normalized source URLs.
 * Providers receive the same list so they can constrain retrieval; this second
 * pass fails loudly when an adapter or upstream ignores it. Silently dropping a
 * source is unsafe because provider-generated prose may already cite it.
 */
function enforceAllowedSources(result: WebSearchResult, allowedDomains: readonly string[] | undefined): void {
  if (allowedDomains === undefined) return
  const violatingIndex = result.sources.findIndex(source => !allowedDomains.some(domain => sourceMatchesDomain(source.url, domain)))
  if (violatingIndex === -1) return
  throw new WebError(
    `web search provider returned source ${violatingIndex + 1} outside allowedDomains`,
    'WEB_SEARCH_FILTER_VIOLATION',
  )
}

/** Match one HTTP(S) source URL against an exact hostname or its subdomains. */
function sourceMatchesDomain(sourceUrl: string, domain: string): boolean {
  let url: URL
  try {
    url = new URL(sourceUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const sourceHost = url.hostname.toLowerCase()
  const allowedHost = domain.toLowerCase()
  return sourceHost === allowedHost || sourceHost.endsWith(`.${allowedHost}`)
}

export default WebRuntime
