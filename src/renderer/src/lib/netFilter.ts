/**
 * Data-Flow noise filter (JD-4) — screen the captured network records BEFORE they template into the
 * graph, so a real production capture (analytics beacons, CDN assets, third-party widgets) collapses to
 * "just my app's API." Two independent, composable screens, both default-on:
 *
 *  - **API only** — keep only data calls (`fetch` / `xhr` / `websocket` / `eventsource`), dropping
 *    `script` / `stylesheet` / `image` / `font` / `document`. The capture stores the RAW CDP
 *    `resourceType` (capitalized: `Fetch`, `XHR`, `Document`…), so the match is case-insensitive.
 *  - **First-party only** — keep only records whose registrable domain matches the bound Browser board's
 *    (so `app.example.com` + `api.example.com` stay, but `segment.io` / `intercom.io` / `gstatic.com`
 *    drop). Matched on the registrable domain (eTLD+1 heuristic) so subdomains of the app are kept.
 *
 * Pure (no store/React) + unit-tested. Values never enter here — only `url` + `type` strings.
 */

/** CDP resource types that carry app DATA (lower-cased for comparison). */
export const API_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  'fetch',
  'xhr',
  'websocket',
  'eventsource'
])

/** Whether a record's (raw, possibly-capitalized) resource type is a data call, not an asset/document. */
export function isApiResource(type: string): boolean {
  return API_RESOURCE_TYPES.has(type.toLowerCase())
}

// Second-level public-suffix labels (`example.co.uk`, `example.com.au`) where the registrable domain is
// the last THREE labels, not two. A small pragmatic set — full PSL would need a dependency.
const SLD_RE = /^(?:co|com|org|net|gov|edu|ac|or|ne|gob)$/i

/** The registrable domain (eTLD+1) of a host — heuristic, dependency-free. `app.onlysales.io` →
 *  `onlysales.io`; `foo.co.uk` → `foo.co.uk`; `localhost` → `localhost`. Lower-cased. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  if (SLD_RE.test(labels[labels.length - 2])) return labels.slice(-3).join('.')
  return labels.slice(-2).join('.')
}

/** The hostname (no port, no scheme) of a URL, or '' if it doesn't parse. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** The registrable domain of a URL (''-safe). */
export function urlDomain(url: string): string {
  const host = hostnameOf(url)
  return host ? registrableDomain(host) : ''
}

export interface FilterableRecord {
  url: string
  type: string
}
export interface NetFilterOpts {
  apiOnly: boolean
  firstParty: boolean
  /** The bound Browser board's registrable domain; first-party is a no-op when absent. */
  firstPartyDomain?: string
}

/** Apply the active screens to a record list, preserving order. */
export function filterNetRecords<T extends FilterableRecord>(
  records: readonly T[],
  opts: NetFilterOpts
): T[] {
  const { apiOnly, firstParty, firstPartyDomain } = opts
  const fp = firstParty && firstPartyDomain ? firstPartyDomain : undefined
  return records.filter((r) => {
    if (apiOnly && !isApiResource(r.type)) return false
    if (fp && urlDomain(r.url) !== fp) return false
    return true
  })
}
