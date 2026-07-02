# Expanse Launch — Handoff & Weekly Ops

*Companion to `REPORT.md` (the research + full day-by-day plan) in this folder. This doc is the operating manual: weekly instruction sets, the GitHub board, and the prompts to run it. Uncommitted research — keep local or move to a `feat/*` branch with the rest of this folder.*

**Board:** https://github.com/users/ch923dev/projects/5 — "Expanse - Early Access Launch" (private, draft cards — the repo is public, launch strategy stays off public issues). 25 cards, `[W1]`–`[W4]`, fields: Status (Todo / In Progress / Blocked / Done) + Week (W1–W4, Post-launch). Check it every week; the Weekly Review prompt below does the walkthrough for you.

> One-time setup in the UI (30s): open the board → view dropdown → **New view → Board**, group by **Status**. Optionally a second Board view grouped by **Week** for the timeline view.

---

## State snapshot (2026-07-02)

- App feature-complete, packages cleanly. Release gated ONLY on code-signing certs.
- Landing + waitlist + admin site: **built, not deployed**.
- Auth/billing: WorkOS PKCE architecture + expanse-api + /account UI built green; remaining = live AuthKit config, deploy, cutover.
- Rebrand → Expanse: done on `chore/rebrand-expanse`, merges last before public naming.
- Pricing decided: Free tier + Pro $17/mo / $144/yr (SaaS report). EA itself is free.

## The four decisions already made (don't re-litigate)

1. **Free waitlist-gated Early Access** — label "Early Access", wave 1 = 20–50 users, 48–72h expiring invites, Discord feedback. Billing cutover during EA, never blocking it.
2. **Windows signing = Azure Artifact Signing Basic ($9.99/mo)** if available in region; fallback = OV Authenticode cert. **macOS = Apple Developer individual ($99/yr).** Both clocks start Day 1.
3. **Hacker News Show HN is the launch event** (after EA hardening); Product Hunt once, low expectations.
4. **Keep the name "Expanse"** — pending a cheap IC 9/42 trademark knockout search before brand spend.

---

## Weekly instruction sets

### Week 1 (Jul 2–8) — Unblock + deploy the funnel
- [ ] **Azure geography check** → create Artifact Signing account → submit individual identity validation (gov photo ID + utility bill, same address). If region unavailable → order OV Authenticode cert instead. *(external clock — do first)*
- [ ] **Apple Developer enrollment, individual**, $99. Budget days, not 24h. Personal legal name becomes public seller name — accepted for EA. *(external clock — do first)*
- [ ] **Deploy landing + waitlist + admin site.** Verify referral mechanic (double-sided). One announce post (X + one Reddit sub).
- [ ] Merge `chore/rebrand-expanse` (gates all public naming).
- [ ] Wire `azureSignOptions` into `electron-builder.yml` (pipeline ready the moment validation clears).
- [ ] Pre-verify updater without certs: `dev-app-update.yml` + `autoUpdater.forceDevUpdateConfig = true`. Targets: NSIS / DMG+ZIP / AppImage.
- [ ] Telemetry consent gate (opt-in before first collection, settings toggle, VS Code-tier model) + Sentry/PostHog behind it.
- [ ] Draft 8–12 waitlist emails.
- [ ] IC 9/42 trademark knockout search for "Expanse" (USPTO TESS + EUIPO), few hours, before any brand spend.

**Exit:** waitlist live + both cert clocks running + consent-gated telemetry merged.

### Week 2 (Jul 9–15) — Signed builds + EA infrastructure
- [ ] First signed Windows build (no SmartScreen) + notarized macOS build. Full release workflow end-to-end; signed auto-update verified with dummy version bump. *(If validation still pending, pull Week-3 items forward.)*
- [ ] Deploy expanse-api + live WorkOS AuthKit (`expanse://` callback). Accounts live in EA builds; billing dormant.
- [ ] Docs: quickstart (install → first canvas → first agent → first preview), known-issues page, "coming from Vibe Kanban" migration note.
- [ ] Discord server: #announcements #feedback #bugs #showcase.
- [ ] Record 60–90s loop demo video: checklist on Planning board → terminal agent builds → localhost preview updates live in device frame → resize to mobile preset.

**Exit:** installable signed builds on 3 OSes + auto-update proven + demo video cut.

### Week 3 (Jul 16–22) — EA wave 1
- [ ] Invite **20–50** from waitlist: top referrers + most responsive first, short application form (name, use case, OS), Windows-heavy mix, 48–72h invite expiry. Onboard personally.
- [ ] Daily Discord/email triage; fix P0s; **ship every fix via auto-update** (each update = live updater test).
- [ ] Start build-in-public on X: 2–3 posts/wk (GIFs, real numbers, engineering stories).
- [ ] First waitlist broadcast ("wave 1 is in"); collect quotes + screenshots for launch posts.

**Exit:** wave 1 active, crash rate visible in Sentry, first testimonials banked.

### Week 4 (Jul 23–31) — Wave 2 + launch prep
- [ ] Wave 2: **100–200 invites.** Watch Sentry crash-free rate + activation (first board created) as gates.
- [ ] Stripe test-mode checkout verified end-to-end behind a flag.
- [ ] Pricing page + ToS/privacy + early-bird terms live (HN norm: transparent pricing BEFORE Show HN).
- [ ] Draft Show HN post (7-part structure, REPORT §5-2 norms) + PH assets.
- [ ] Final full e2e matrix + signed-build smoke on all 3 OSes.
- [ ] **Day 30 go/no-go review** against the gates below.

### Go/no-go gates (Day 30)
1. Signed builds install warning-free on all 3 OSes; auto-update proven on signed builds.
2. Crash-free sessions ≥ 99% (Sentry, waves 1–2).
3. Activation ≥ 60% (board created + agent run in first session).
4. Waitlist ≥ 3× next wave size.
5. Pricing page + ToS/privacy live.

**Pass → open EA + schedule Show HN following week. Fail → wave 3, one more week, re-review.**

---

## Prompts

### Weekly review prompt (paste every week — Monday recommended)

```
Weekly launch review. Read docs/research/2026-07-02-early-access-launch/HANDOFF.md and REPORT.md,
then check the GitHub Project "Expanse — Early Access Launch" (owner ch923dev) with gh.
Report: (1) what moved to Done since last week, (2) what is In Progress and whether it's on
pace for this week's exit criteria, (3) anything Blocked — especially the two external clocks
(Azure identity validation, Apple enrollment) and what unblocks them, (4) this week's top 3
next actions in priority order. If we're in week 3+, also pull Sentry crash-free rate and
activation numbers against the go/no-go gates. Update card statuses on the board to match
reality before reporting. Flag any scope creep that isn't on the board.
```

### Work-session kickoff prompt (paste to start work on any card)

```
Launch work session. Read docs/research/2026-07-02-early-access-launch/HANDOFF.md, then the
board card titled "<CARD TITLE>" on the GitHub Project "Expanse — Early Access Launch"
(owner ch923dev). Execute it per the card's instructions and the matching REPORT.md section.
Repo rules apply: feature work on a fix/* or feat/* worktree branch, never main; manual dev
check with CANVAS_DEV_TITLE before any PR; full e2e matrix at pre-merge. When done, move the
card to Done with a one-line result comment, and update ACTIVE-WORK.md if you touched the repo.
```

### Board maintenance notes

- Cards are **draft items** (private project, public repo — keep it that way; convert a card to a repo issue only if it's pure code work with no strategy content).
- Columns: **Todo / In Progress / Blocked / Done**. External-clock cards (certs) live in Blocked while waiting — that's expected, not a problem.
- Week labels are in card titles (`[W1]`–`[W4]`); the board's Status is the single source of truth, this doc's checklists are the reference copy.
```
