// src/main/localUpdateFeed.ts
/**
 * Local update channel (dev-only) — the userData feed override for PERSONAL builds.
 *
 * Lets the maintainer's own machine receive updates from a loopback feed
 * (scripts/release-local.mjs publishes there) instead of the production feed, so a local
 * build → in-app "update available" → restart, with no manual close-and-reinstall ritual.
 *
 * SECURITY POSTURE (extends the ADR 0008 invariant, does not weaken it for users):
 *  • COMPILE-GATED: the ONLY caller (index.ts) fences this behind __LOCAL_UPDATE_CHANNEL__,
 *    true solely when scripts/release-local.mjs builds with LOCAL_UPDATE_CHANNEL=1. CI
 *    (pr/staging/production) never sets it, so every shipped binary dead-code-eliminates
 *    this path — a user's app can never be steered by a dropped config file.
 *  • LOOPBACK-LITERAL ONLY: the override URL must name `127.0.0.1` or `[::1]` verbatim.
 *    `localhost` is REJECTED (it is a DNS name — hosts-file remappable, and it resolves to
 *    ::1 while the feed server binds IPv4; see releasing.md's local-test gotcha). Anything
 *    that can serve on the maintainer's loopback already has code execution as them, so the
 *    channel adds no capability an attacker lacks.
 *  • FAIL-CLOSED: a missing, malformed, or non-loopback config yields null → the normal
 *    production feed. A bad override can never widen where updates come from.
 *
 * The config lives in `app.getPath('userData')` (update-feed.local.json) — NSIS update
 * installs never touch userData, so the override survives the very updates it delivers
 * (unlike patching resources/app-update.yml, which every install rewrites).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Config filename inside userData. Shape: `{ "url": "http://127.0.0.1:8090/" }` */
export const LOCAL_FEED_CONFIG_FILE = 'update-feed.local.json'

/**
 * Literal loopback hosts only — matched against WHATWG `URL.hostname` (which keeps the
 * brackets on IPv6 and lowercases names). Deliberately NOT the whole 127.0.0.0/8 range and
 * NOT `localhost`: strictness costs nothing here and removes the DNS-indirection class.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]'])

/**
 * Parse + validate the config file's text into a feed base URL, or null. Pure (no fs, no
 * electron) so the validation matrix is unit-testable directly. Trailing slashes are
 * stripped so the result composes with both electron-updater's setFeedURL (which re-adds
 * its own separator) and the `${base}/updates.json` meta fetch.
 */
export function parseLocalFeedConfig(text: string): string | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const url = (raw as Record<string, unknown>).url
  if (typeof url !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null
  return parsed.toString().replace(/\/+$/, '')
}

/**
 * Read the override from `<userDataDir>/update-feed.local.json`. An ABSENT file is the
 * normal case (no local channel configured) and stays silent; a PRESENT-but-invalid file is
 * logged — that is a maintainer mistake worth surfacing, and silently falling back to the
 * production feed would make it look like the local channel "just stopped working".
 */
export function readLocalFeedOverride(
  userDataDir: string,
  logError: (...args: unknown[]) => void = console.error
): string | null {
  const path = join(userDataDir, LOCAL_FEED_CONFIG_FILE)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const feedUrl = parseLocalFeedConfig(text)
  if (feedUrl === null) {
    logError(
      `[local-update-channel] ${path} present but invalid — must be {"url":"http://127.0.0.1:<port>/"} ` +
        `(loopback literal only, localhost rejected). Falling back to the production feed.`
    )
  }
  return feedUrl
}
