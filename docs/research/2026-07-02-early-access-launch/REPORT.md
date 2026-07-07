# Expanse — Early Access, 30-Day Ship Plan, Marketing & Branding

*Synthesis of a 103-agent deep-research workflow (5 search angles, 21 sources, 103 extracted claims, 25 adversarially verified: 12 confirmed / 2 refuted / 11 unverified-by-rate-limit) + the 2026-06-26 SaaS productization report + current repo state. Produced 2026-07-02. This doc is **uncommitted research** — move onto a `feat/*` branch when work starts, per doc-lifecycle convention.*

**Companion doc:** `docs/research/2026-06-26-saas-productization/REPORT.md` (pricing, auth/billing architecture, founder checklist). This report does not re-litigate those decisions — it sequences them into a launch.

**Verification key:** ✅ = adversarially confirmed (2-0 or 3-0 votes) · ◑ = sourced but verification errored on rate limit (not refuted) · ✗ = refuted · (k) = general knowledge, no source fetched.

---

## 1. Executive summary

1. **Ship as a free, waitlist-gated Early Access — do not block EA on billing.** "Early access" (not "beta") is the right label for a feature-complete app ◑. Billing cutover happens *during* EA, before public launch. This decouples the 30-day clock from the Stripe/AuthKit deploy.
2. **The cert clock starts today.** Windows: Azure **Artifact Signing (ex-Trusted Signing), Basic $9.99/mo, 5,000 sigs/mo** ✅, individual devs eligible (gov photo ID + matching utility bill) ◑, identity validation **20 min – 7+ business days** ◑ — the longest-lead item. macOS: Apple Developer Program **$99/yr** ✅; enroll as **individual** (org path needs D-U-N-S + verification and is materially slower) ◑. macOS **must be signed for auto-update to work at all** ✅.
3. **Deploy the waitlist site this week.** Waitlist conversion decays hard: ~50% of eventual conversions happen within 30 days of signup, ~0% after 6 months (Rows.com) ◑. An undeployed waitlist is compounding loss.
4. **The category is crowded (~130 tools ◑) but your exact combination is unclaimed:** no catalogued tool combines an infinite zoomable canvas + live responsive localhost preview + cross-platform desktop ◑. Maestri (closest comp) is macOS-26.2+/Apple-Silicon-only ✅. Windows/Linux users of this category are unserved ◑.
5. **Hacker News > Product Hunt in 2026.** PH referral traffic collapsed ~5x since 2022 and is widely gamed ◑; a Top-4 dev-tool PH launch ≈ 1,500 visitors ◑. HN delivers 3–10x more launch traffic ◑ but has strict norms (§6). Launch where the users already are: HN, Reddit, the displaced Vibe Kanban user base (§5).
6. **"Expanse" is usable but needs a knockout search.** The famous prior user (Expanse Inc., acquired by Palo Alto for ~$670M ✅) was absorbed into Cortex Xpanse ◑; the EXPANSE word-mark application tied to it is DEAD (abandoned 2022) and was filed in IC 036 (financial services), not software classes ◑. But the mark is crowded across industries ◑ and search is dominated by the TV/book franchise (k). Verdict: keep the name, do an IC 9/42 clearance search, own a compound for SEO (§7).

---

## 2. Early-access model (research Q1)

### Recommended: free EA, waitlist-gated waves

| Decision | Recommendation | Evidence |
|---|---|---|
| Label | **"Early Access"**, not "beta" or "waitlist" | Preferred when product is nearly ready — signals real product without bug connotations ◑ |
| Price during EA | **Free** (Pro features unlocked), with an early-bird offer at public launch | EA's job is feedback + testimonials + case studies; billing lands mid-EA (§4). Early-bird 10–20% discount claims +20–30% launch conversion; "first 100 get X% off forever" framing ◑. The prior report's optional **$200 lifetime deal, EA window only** remains the answer to Maestri's one-time-price comparison. |
| First cohort | **20–50 users**, expand gradually | Recommended indie beta cohort; ~1,000 invites makes personal feedback impossible ◑ |
| Invite mechanics | **Waves with 48–72h limited-time invites**; prioritize top referrers + most responsive email subscribers; short application form (name, use case, OS) | ◑ |
| Sequencing | **Waitlist → private EA from most-engaged → open launch announced to full waitlist + HN/PH same week** | The standard three-phase funnel ◑ |
| Feedback channel | **Discord** (primary) + email. Not GitHub Discussions — the app is closed-source, and the beta-ops sources name Slack/Discord/Canny/email as the standard set ◑ | Also gives launch-day community for HN/PH threads |
| Waitlist cadence | **Weekly email minimum; draft 8–12 emails before opening**; double-sided referral rewards outperform single-sided ~3x ◑ | The landing site's waitlist needs a referral hook |
| Urgency | Launch to the list **within 30 days of peak signup** — conversion 25–85% inside 30 days vs 2–4% for cold funnels ◑; cap the waitlist period at 60–90 days ◑ | Deploy site now, launch inside the window |

### Telemetry / crash-reporting consent (norms)

- **Opt-in before first collection** — GDPR-valid consent cannot be pre-checked or opt-out; first-run flow must gate telemetry behind an explicit consent step ◑. Legitimate-interest is not a defensible basis for dev-tool telemetry ◑.
- **Withdrawal as easy as grant** — an always-available settings toggle, not just the first-run prompt ◑.
- **The VS Code pattern is the category norm**: telemetry split into crash / error / usage, one setting with four tiers (`all/error/crash/off`), plus *inspectable* telemetry (a local log users can read) ◑. Match it: Sentry + PostHog behind the existing consent-modal pattern (already the plan in the SaaS report §4), with a "show what's sent" affordance.
- **Positioning bonus:** Maestri markets itself as anti-Electron + zero-telemetry + no-account ◑. A consent-first, local-first-storage, inspectable-telemetry story pre-empts the objection rather than ceding it.

---

## 3. Competitor landscape & positioning (research Q4)

### The map (July 2026)

| Tool | Platform | Model | Shape | Status |
|---|---|---|---|---|
| **Maestri** | macOS 26.2+ / Apple Silicon ONLY ✅ | Free (1 workspace) + **$18 one-time** Pro (unlimited workspaces, 2 Macs, 7-day trial) ✅ — *a May-2026 review instead describes $19/mo tiers ◑; trust the official site (primary, current)* | **Same category pitch: "An orchestration canvas for AI agents … an infinite canvas where your coding agents work in concert"** ✅. Agents: Claude Code, Codex, OpenCode, any CLI ✅. Embedded browser portals, sketching/diagramming ✅. Signature feature: draw a line between terminals → real PTY pipe (stdout→stdin); a reviewer measured ~70% handoff reliability ◑. Anti-Electron, zero-telemetry, no-account positioning ◑. | Active |
| **Nimbalyst** (Crystal's successor) | Cross-platform + iOS companion ◑ | Freemium + subscription ◑ | Visual workspace: parallel sessions, worktrees, kanban, multi-editor docs (markdown, spreadsheets, diagrams, Excalidraw) ◑ | **Active — the most direct live threat.** Crystal (3.1k stars, MIT, Electron) deprecated Feb 2026 → Nimbalyst ✅ |
| **Vibe Kanban** | Cross-platform web UI | Free OSS (Apache-2.0) | Kanban planning + per-agent workspace (branch/terminal/dev-server) + built-in browser preview w/ devtools + device emulation ✅ | **Sunsetting** — Bloop shut down Apr 2026, README carries sunset notice, domain dead ◑. ~27k stars of displaced users ◑ |
| **Conductor** (Melty Labs) | macOS-first | Free, BYOK | Dashboard-style worktree orchestrator ◑ | Active |
| The long tail | — | mostly free/OSS | ~130 catalogued orchestrators; dominated by parallel-worktree runners + ≥5 kanban UIs ◑ | — |

Context: multi-agent coding went mainstream Feb–Apr 2026 (OpenAI Codex App, GitHub, Anthropic, Cursor, Windsurf) ◑ — a July 2026 launch enters a hot, big-vendor-active category. Practical ceiling worth respecting in demos: most devs run **2–4 parallel agents**, not 20–30 ◑.

### Positioning verdict

**The unclaimed square: infinite canvas × live responsive localhost preview × cross-platform.** No catalogued tool combines these ◑; Maestri has the canvas but not Windows/Linux ✅ and its planning layer is a markdown-notes surface, not a whiteboard, with no localhost preview per its reviewer ◑; Vibe Kanban had the preview but was a kanban web UI ✅ and is dying ◑; Nimbalyst has breadth but no device-frame preview claim ◑.

- **Lead with the loop, not the canvas:** *plan → agents work → watch the app change, all on one surface.* The differentiated demo is a Planning board checklist feeding a Terminal agent whose output is visible live in a device-framed Browser board. Nobody else can show that loop.
- **Cross-platform is the wedge** — Windows/Linux users in this category are explicitly unserved ◑. Say "Windows, macOS, Linux" in the first sentence everywhere.
- **Agent-agnosticism is table stakes, not a differentiator** — Maestri, Vibe Kanban, and the long tail all claim it ✅◑. Mention it; don't lead with it.
- **Pre-empt the two objections you'll get on HN:** Electron (Maestri actively markets against it) and account/telemetry. Answers: perf receipts (OSR liveness caps, paint-gating — real engineering, show numbers) and local-first + consent-first + inspectable telemetry (§2).
- **Vibe Kanban's ~27k-star orphaned user base is the cheapest acquisition channel in the category right now** ◑ — a "coming from Vibe Kanban" migration note + a respectful mention in launch posts targets users already convinced of the category.
- **Free/OSS pressure is real but not fatal:** Crystal was MIT + Electron and died into a freemium successor ✅; Vibe Kanban was free with `npx` distribution and still folded ◑ — free alone isn't a business, and two freemium/paid comps (Maestri, Nimbalyst) validate charging. The prior report's Free/Pro split ($17/mo, free tier keeps all board types) stands (§8).

---

## 4. The 30-day ship plan (research Q2)

**Assumptions:** solo dev, ~2 productive app-work weeks inside the 30 days; accounts/billing code already built (WorkOS PKCE architecture + expanse-api + /account UI green — remaining: live AuthKit config, deploy, cutover); landing/waitlist/admin site built, undeployed; rebrand branch ready, merges last.

**Two external clocks run in parallel with everything:** Apple enrollment (do NOT assume 24h — the "confirmation within 24 hours" claim was **refuted 0-3** ✗; budget several days) and Azure identity validation (20 min–7+ business days ◑, can pause for extra-document requests ◑).

> ⚠️ **Day-1 geography check (blocking):** Azure Trusted/Artifact Signing has geographic availability limits (US/CA at one point, later EU/UK expansion ◑). **Verify availability for your country/billing region before anything else.** Fallback if unavailable: a traditional OV Authenticode cert (~$350–500/yr ◑, e.g. SSL.com/Certum) — order it Day 1 instead, same slot in the plan.

### Week 1 — Unblock + deploy the funnel (Jul 2–8)

| Day | Do |
|---|---|
| **1 (Jul 2)** | Azure geography check → create Artifact Signing account (billing starts immediately, full month, no pro-rating ◑) → submit **individual** identity validation (gov photo ID + utility bill, same address ◑). Enroll **Apple Developer, individual** ($99 ✅; personal legal name becomes the public seller name ◑ — accept for EA, an LLC re-enroll can come later). Both are checkbox-and-wait; start today. |
| **2** | **Deploy the landing + waitlist + admin site.** Add/verify the referral mechanic (double-sided ◑). Announce the waitlist once on X + relevant Reddit. The decay data ◑ makes every undeployed day a compounding loss. |
| **3** | Merge the rebrand branch (it gates all public naming). Wire `azureSignOptions` into `electron-builder.yml` (native electron-builder support: publisherName/endpoint/certificateProfileName/codeSigningAccountName + AZURE_* env vars ◑) so the pipeline is ready the moment validation clears. |
| **4** | Pre-verify the updater **without certs**: `dev-app-update.yml` + `autoUpdater.forceDevUpdateConfig = true` exercises the update pipeline pre-signing ◑. Confirm target set: NSIS (Win), DMG+ZIP (mac — ZIP required for latest-mac.yml ◑), AppImage (Linux) ✅◑. GitHub Releases as the free update host ◑ (owned-domain mirror later, per SaaS report). |
| **5–7** | First-run/onboarding polish + the **telemetry consent gate** (§2: opt-in before first collection, settings toggle, VS Code-tier model). Wire Sentry + PostHog behind it. Draft the 8–12 waitlist emails ◑. |

### Week 2 — Signed builds + EA infrastructure (Jul 9–15)

| Day | Do |
|---|---|
| **8–9** | Assuming validations cleared: first **signed Windows build** (verify no SmartScreen) + **notarized macOS build** (signing is a hard prerequisite for mac auto-update ✅). Run the release workflow end-to-end; verify signed auto-update with a dummy version bump. If validation is still pending, swap Week-3 work forward. |
| **10** | Deploy expanse-api + configure live WorkOS AuthKit (`expanse://` callback). Accounts go live in EA builds; **billing stays dormant** — EA is free. |
| **11–12** | Docs: quickstart (install → first canvas → first agent → first preview), an honest known-issues page, and a "coming from Vibe Kanban" note (§3). Set up Discord (channels: #announcements #feedback #bugs #showcase). |
| **13–14** | Record the **60–90s demo video**: the loop — checklist on Planning board → terminal agent builds → localhost preview updates live in a device frame → resize to mobile preset. This one asset feeds the site hero, X posts, HN comment links, and the eventual PH gallery. |

### Week 3 — EA wave 1 (Jul 16–22)

| Day | Do |
|---|---|
| **15** | **Invite wave 1: 20–50** ◑ from the waitlist — top referrers + most-responsive first ◑, short application form, mixed OS coverage (Windows especially — it's the wedge). **48–72h invite expiry** ◑. Onboard personally (1:1 is the point at this size ◑). |
| **16–19** | Daily feedback triage in Discord; fix P0s; **ship fixes via auto-update** — every update EA users receive is also a live test of the updater. Start build-in-public cadence on X (2–3 posts/wk: real numbers, GIFs of fixes, decisions) (k). |
| **20–21** | First waitlist broadcast ("wave 1 is in; here's what they built"). Collect quotes/screenshots — these become launch-post social proof. |

### Week 4 — Wave 2 + launch prep (Jul 23–31)

| Day | Do |
|---|---|
| **22–24** | **Wave 2: ~100–200 invites.** Watch Sentry crash rate + activation (first board created) as gate metrics. Stripe **test-mode** checkout verified end-to-end behind a flag (billing cutover targets public launch, not EA). |
| **25–27** | **Pricing page live** on the site (HN norm: transparent pricing + how you make money **before** any Show HN ◑). Publish the early-bird offer terms (§2). Draft the Show HN post per the 7-part structure ◑ (§6) and the PH assets. |
| **28–29** | Fix window from wave-2 findings. Final full e2e matrix + signed-build smoke on all three OSes. |
| **30 (Jul 31)** | **Go/no-go review** against §9 gates → either open EA fully (waitlist floodgate + schedule Show HN for the following week) or run wave 3 for one more week. Don't Show HN before the crash rate is boring. |

---

## 5. Channel-by-channel marketing playbook (research Q3)

Priority order for a $0-budget dev tool in 2026:

### 1. Waitlist + email (the core asset)
Deploy now; weekly cadence; 8–12 emails pre-drafted; double-sided referral ◑. Every other channel's job is to feed this list until EA opens.

### 2. Hacker News (Show HN) — the main launch event
- Traffic claim: 3–10x Product Hunt ◑ (quality disputed in-thread — expect kicked tires).
- **Norms (violations are fatal):** no marketing-speak or superlatives ◑; a free, frictionless way to try it + transparent pricing including how you make money ◑; founder responds fast and in technical depth all day ◑; **no friend/booster comments** ◑.
- **Post structure (7-part) ◑:** who you are → one clear sentence on what it does → the problem → backstory → solution + differentiation with technical detail → invite feedback. Title makes the product instantly obvious.
- HN rewards open-source/privacy-first ◑ — the public `@expanse-ade/mcp` npm package is the open-source legitimacy signal; link it. Lead the technical narrative with the OSR preview engine and PTY architecture; HN loves the how.
- Timing: after EA has hardened the app (week 5–6, post-plan), not during.

### 3. Reddit + the displaced-user play
r/ClaudeAI, r/ChatGPTCoding, r/SideProject, r/ExperiencedDevs (k). Participate before posting; share the EA as "I built this, looking for Windows/Linux testers" — the ask-for-feedback frame fits Reddit norms (k). The Vibe Kanban sunset thread/community is a direct, welcome-mat audience ◑.

### 4. Build-in-public on X
2–3 posts/week: GIFs of the canvas loop, real EA metrics, engineering war stories (the OSR occlusion saga is genuinely good content) (k). Compounds slowly; feeds waitlist between waves.

### 5. Demo video / YouTube + short-form
The 60–90s loop video (Week 2) + a 5–8 min "how it works" for YouTube search (k). Short-form clips of the canvas zooming across live terminals are inherently visual — this product demos better than the worktree-runner competition (k).

### 6. Product Hunt — do it, expect little
Referral traffic down ~5x since 2022 ◑; heavily gamed ◑; 91% of Jan–Jun 2024 PH SaaS launches had <100 active users ◑; Top-4 dev tool ≈ 1,500 visitors ◑. Still worth one launch for the backlink/badge/brand surface: self-hunt (79% of featured posts are ◑), weekend launch is viable-to-advantageous for dev tools ◑, goes live 12:01 AM PT ◑. Repeat launches are normal (Supabase ×16 ◑). Schedule the same week as Show HN, expectations low.

### 7. SEO / content — slow lane
"Expanse" the word is unwinnable (franchise dominance, k). Own compound queries: "AI agent canvas", "run multiple Claude Code sessions Windows", "Vibe Kanban alternative", "Maestri alternative Windows" (k). The docs site (26 MDX pages) is the SEO surface; add a comparison page per competitor.

---

## 6. Branding (research Q5)

### "Expanse" name verdict: **keep, with two actions**

- The heavyweight prior user — Expanse Inc., attack-surface management, acquired by Palo Alto Networks for ~$670M (2020) ✅ — was folded into **Cortex Xpanse**; the standalone brand was absorbed ◑, and the press release didn't even claim EXPANSE in its own trademark notice ◑.
- The associated EXPANSE word-mark application (SN 88109972) is **DEAD** — abandoned 2022-03-28, no Statement of Use ◑ — and was filed in **IC 036 (financial services), not IC 9/42** ◑.
- But the mark is **crowded**: multiple live/pending EXPANSE registrations across unrelated industries (audio hardware, crossbows, RVs, finance…) ◑, and none of the trademark claims got verifier votes (rate-limit), so:
- **Action 1:** run a proper **IC 9 / IC 42 knockout search** (USPTO TESS + EUIPO) before spending on brand assets. Cheap, hours of work, de-risks everything. *(All trademark observations here are research, not legal advice; a real clearance opinion needs an attorney.)*
- **Action 2:** brand the compound for search: **"Expanse"** as product name, always introduced with the category phrase (below), domain + handles on the compound (`expanse-ade`, `getexpanse`, `expanse.app`-style) since bare "expanse" search is franchise-flooded (k).

### Category naming

"**Agentic development environment**" (ADE) is the right category frame — it's already the repo's own acronym, it's descriptive, and category naming beats feature lists for a new-square product (k). Maestri went with "orchestration canvas" ✅; ADE is broader and positions the preview + planning surfaces, not just orchestration. Tagline shape: *"The agentic development environment — plan, run, and preview your AI agents on one infinite canvas. Windows, macOS, Linux."*

### Visual identity

Already decided and built: calm/dense Linear-Raycast aesthetic, one accent blue, no gradients/glow (design contract). That IS the premium-dev-tool norm — don't add brand theater for launch (k). Launch-asset needs only: OG image, PH gallery frames, the demo video end-card. The Meridian redesign epic is queued separately; do not couple launch to it.

---

## 7. Pricing benchmarks (research Q6)

Prior report's pricing stands. New data points to fold in:

- **Maestri: $18 one-time** (official site, confirmed ✅) — cheaper than expected, and one-time. The monthly-sub description ($19/mo) in a May 2026 review ◑ conflicts; the official site wins. Implication: the **$200 lifetime EA offer** (prior report §3) is the direct answer for one-time-price shoppers; the $17/mo Pro remains anchored against Cursor/Warp ($20) not Maestri.
- **Nimbalyst: freemium + subscription** ◑ — a live cross-platform comp validating recurring pricing in this exact category.
- **Free/OSS entrants keep dying into paid models** (Crystal → Nimbalyst ✅; Vibe Kanban → sunset ◑) — useful line for the inevitable "why not free?" HN comment.
- EA-specific: early-bird 10–20% off with quantity-limited framing ◑ (e.g., first-100), plus the lifetime deal, retired at public launch.

---

## 8. Cost of launch (cash)

| Item | Cost |
|---|---|
| Apple Developer Program | $99/yr ✅ |
| Azure Artifact Signing Basic | $9.99/mo, starts immediately on account creation, no pro-rating ◑ (overage $0.005/sig ◑ — irrelevant at 5k/mo quota) |
| *(fallback)* traditional OV Authenticode | ~$350–500/yr ◑ — only if Azure unavailable in region |
| Domain, hosting, Supabase/WorkOS/Sentry/PostHog free tiers | ~$0–25/mo (per SaaS report) |
| **Total to first signed release** | **≈ $110–125** (Azure path) or ≈ $450–600 (fallback path) |

## 9. Go/no-go gates for Day 30

1. Signed + notarized builds install warning-free on all three OSes; auto-update proven with a real version bump on signed builds.
2. Crash-free sessions ≥ 99% across waves 1–2 (Sentry).
3. Activation: ≥ 60% of invited users create a board + run an agent in first session (PostHog).
4. Waitlist ≥ 3× the next wave size (else more top-of-funnel before Show HN).
5. Pricing page + ToS/privacy live (HN norm ◑ + legal prerequisite from SaaS report §7).

## 10. What this research could NOT verify (rate-limited — re-check before relying)

All ◑ items above, most load-bearing: waitlist conversion-decay numbers; cohort-size guidance; Azure individual-eligibility + validation-time specifics; the "unclaimed combination" competitive claim; all USPTO trademark specifics; Vibe Kanban sunset details; Nimbalyst pricing. The 2 refuted claims: Apple 24-hour enrollment confirmation ✗ (budget days) and Crystal's original positioning-as-stated ✗ (superseded by the Nimbalyst migration anyway).

## Sources (21)

Primary: azure.microsoft.com (Artifact Signing pricing) · developer.apple.com (enrollment) · electron.build (auto-update) · themaestri.app · github.com/stravu/crystal · github.com/BloopAI/vibe-kanban · code.visualstudio.com (telemetry) · paloaltonetworks.com (Expanse acquisition).
Secondary/forum: learn.microsoft.com Q&A (validation time) · news.ycombinator.com item 45362569 (PH decline thread) · github.com/andyrewlee/awesome-agent-orchestrators · uspto.report (Expanse Inc. filings) · activemind.legal (GDPR telemetry).
Blogs: west-wind.com + hendrik-erz.de (Trusted Signing setup) · markepear.dev (HN launch) · hackmamba.io (PH launch) · waitlister.me + waitlistkit.dev (waitlist/beta ops) · nimbalyst.com (2026 tool landscape) · agent-finder.co (Maestri review).
