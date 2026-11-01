# Expanse — The Launch Film Playbook

A production bible for the one video that puts Expanse on the map. Read it once end to end, then build the demo canvas first and the camera second.

---

## 1. TL;DR / The recommendation

- **Make ONE thing first: a 75-second narrated launch film, 16:9, 3840×2160 mastered down to 1080p.** It opens tight on a Terminal board mid-run, executes a single slow camera pull-back to reveal the whole project (the hero shot), then chains three live demo moments and a callback close. This is the product-page hero film, the Product Hunt video, and the launch-tweet asset — one master, many cuts.
- **Cut #2 — the silent hero loop (15s, muted, seamless).** A standalone edit of the zoom-out reveal only, built with its own rhythm (not a trim of the film), for the landing page above the fold. Under 5 MB, `autoplay muted loop playsinline`.
- **Cut #3 — three vertical social clips (9:16, 20-30s each).** Port-detection click; terminal-edit-to-browser-reload; checklist-fill-beside-terminal. Burned-in captions, no VO.
- **The real budget is the canvas, not the camera.** A deterministic, pre-staged demo project — real running app, scripted agent output, a checklist at exactly 3/5 done — is the premium signal. Spend your hours here.
- **Guardrails are absolute.** Brand it "Expanse." Never name the runtime or any framework. Never frame it as build-in-public, beta, or work-in-progress. Void background, one blue accent, zero glow.

---

## 2. Why this beats everything else

The thesis: **the interface is the argument, and the camera move is the verdict.**

Linear and Raycast proved a specific thing to this exact audience — that a calm, dense interface shown without apology is its own credibility signal. You don't need to convince a senior engineer that fragmentation is painful; they live it. You need to show them a surface that dissolves it, and let the surface speak. Linear's own demo philosophy is to zoom out from a single task to team goals to company strategy — tactical to strategic in one continuous gesture. Raycast's positioning is pure feeling: "it's about never feeling like you're wasting time." Neither narrates features as a list. Both let the product recede until touched.

Expanse owns a move that none of the benchmarks can make. Warp lives in a terminal. Cursor lives in an editor. Figma mocks an app; it doesn't run one. Every one of them lives inside a single context window. **Expanse is the canvas those contexts sit on** — and the only way to show that is to start inside the work and physically pull the camera back until the whole project breathes into frame. In a Linear video you reveal features one at a time. In an Expanse video, the camera movement *is* the product. That is not a metaphor you illustrate; it is the product demonstrating itself. Treat the 5-15s pull-back like an Apple hardware reveal: lit, timed, paced to perfection. Everything else is supporting evidence.

One honest caveat on the research that shaped this: the "85% surface UI in 3 seconds" and "85% chain features into workflows" figures come from a single Advids case study of seven products (6 of 7). Directionally true, statistically thin — we treat them as craft heuristics, not laws. The argument stands on its own: your audience reads UI at a glance, and your UI is novel. Open on it.

---

## 3. The concept & narrative

**Concept: "One breath."** The film is a single inhale-and-look. We begin pressed against the glass of a running agent, pull back until the entire workspace is visible in one frame, move across the live surface watching the boards talk to each other, then return to the wide view to close. A circular arc: the film ends where it conceptually began. Roughly **40% voiceover, 60% silence** — the Linear/Raycast register.

VO total: ~75 words, ~45 seconds spoken inside a 75-second film. The rest is intentional silence — the reveals, the action beats, the CTA hold. Write at 125-135 WPM and read it aloud with a stopwatch before locking; what reads as 75 seconds in your head runs long out loud.

| # | Time | ON-SCREEN ACTION | VOICEOVER / CAPTION |
|---|------|------------------|---------------------|
| 1 | 0:00–0:05 | Tight on a single **Terminal board**, mid-run. Output streaming a real component refactor. Braille spinner mid-cycle. The 2px blue progress sliver crawling at ~30%. Hold the frame 2s before anything moves. | *(silence)* |
| 2 | 0:05–0:12 | The camera begins a slow, cubic-bezier pull-back. The terminal shrinks; the void and dot grid open around it. Other board edges begin to enter frame. | VO: "Your agent is running. Your app is loading. Your plan is somewhere else." |
| 3 | 0:12–0:18 | **HERO ZOOM-OUT completes.** Two Browser boards (Mobile 390 + Tablet 834, side by side) and a Planning board with a half-ticked checklist all settle into frame. Hold 2s on the wide view. | Caption card, Geist Mono, accent blue, centered in the void below the boards: **ONE SURFACE.** Fade in 100ms, hold 1.5s, fade out. |
| 4 | 0:18–0:28 | Push back in toward the Terminal. Dev server boots — `Local: http://localhost:5173` prints in the output. A faint connector arrow resolves from terminal to a Browser board. One click — the browser snaps to the running app, the connection dot turns green. | VO: "When your dev server starts, Expanse reads the port. One click — your app appears." Caption near the green dot: **ZERO CONFIG.** |
| 5 | 0:28–0:38 | Agent types an edit. Output: `+ 3 lines  src/Button.tsx`. The **Browser board (Desktop, 1280px)** visibly reloads; the changed component appears. Both boards on screen at once — no cut, no switch. | VO: "The agent edits. The app reloads. Both on screen. No switching." Caption at the midpoint between the two boards: **LIVE, SIDE BY SIDE.** |
| 6 | 0:38–0:48 | Drag-duplicate the Browser board. The copy auto-advances to Tablet. Arrange side by side: 390px left, 834px right — a real reflow, visibly different layouts. | VO: "Duplicate a board. Real reflow at every breakpoint. Not a resize — a render." Captions: **390** (left) · **834** (right). |
| 7 | 0:48–0:58 | Camera eases into the **Planning board**. Tick two checklist items — the 3px blue bar fills, the done count ticks, completed items go faint with strikethrough. Ease back out to the wide three-board view. | VO: "The plan lives on the same canvas as the code and the app. Check something off — watch the rest follow." |
| 8 | 0:58–1:15 | Return to the exact wide composition from beat 3. Boards dim slightly; the void takes over. The **Expanse** wordmark resolves in Geist, white, centered. Below it, a terminal-style CTA line with a slow cursor blink. Hold static 3s. | VO: "Expanse. Your agents, your app, your plan — one surface." CTA, Geist Mono, accent blue: `> get early access` |

VO full script (read-aloud, ~75 words): *"Your agent is running. Your app is loading. Your plan is somewhere else. … When your dev server starts, Expanse reads the port. One click — your app appears. … The agent edits. The app reloads. Both on screen. No switching. … Duplicate a board. Real reflow at every breakpoint. Not a resize — a render. … The plan lives on the same canvas as the code and the app. Check something off — watch the rest follow. … Expanse. Your agents, your app, your plan — one surface."*

---

## 4. Storyboard / shot list

Two motion types live in this film and they must never fight: **canvas-camera motion** (app-driven, the hero) and **micro-interaction** (a click that wants a focus push-in). Record them as separate takes. Below, each shot is tagged **[CANVAS]** (app's own camera, recorder zoom OFF) or **[MICRO]** (static camera, recorder auto-zoom OK).

1. **[CANVAS]** Cold open, locked frame on Terminal mid-run. No camera move for 2s. Spinner phase and progress-sliver position must be identical across takes — this is why output is scripted (see §5).
2. **[CANVAS]** Trigger the **fit** camera animation (the `f` key). The app's 200ms cubic-bezier easing carries the pull-back. Pre-arrange the three boards in a landscape layout so "fit" lands at **~45% zoom** — above the LOD threshold so no board drops to a snapshot card mid-reveal.
3. **[CANVAS]** Hold the wide composition. This is the frame that ships on the product page. Nothing moves; the ONE SURFACE card animates over the still.
4. **[CANVAS→MICRO]** Camera eases toward the terminal, then locks. **[MICRO]** the URL prints, the connector resolves, the click lands, the dot turns green. This sequence *must be a real recording* — the live arrow animation and state change sell the feature; a faked one will be spotted instantly.
5. **[MICRO]** Static two-board composition. Agent edit prints; the Browser board reloads live. Stage the demo app to reload against a `#0a0a0b` background so the reload flash matches the void instead of a white flash (1-3 frames at 60fps is visible).
6. **[MICRO]** Drag-duplicate gesture; the copy settles at Tablet. Hold on the 390/834 split.
7. **[CANVAS]** Ease into the Planning board (a gentle push-in, app camera). **[MICRO]** tick two items; the progress bar fills. Ease back out **[CANVAS]** to the wide view.
8. **[CANVAS]** Return to the beat-3 composition, static. Wordmark and CTA resolve over the held frame.

Build this as an EDL with columns: `# | Beat | Type | Duration | Screen action | Camera move | VO line | Caption | Position | Notes`. Fill it before you record — it is your edit decision list and your shot checklist in one.

---

## 5. The demo environment

The canvas state is the production. Everything here must look like a real project caught mid-flight, never a showcase.

**The seeded canvas (three board types, one coherent project):**

- **Terminal board** — a real shell running a real agentic CLI on a plausible task: a component refactor on a small React demo app. Output shows tool-call lines, a file-edit diff reading `+ 3 lines  src/Button.tsx`, the braille spinner, and the blue progress sliver. **Do not run a live agent during hero takes** — sessions are non-deterministic (rate-limit lines, retries, varying diff counts will wreck matching takes).
- **Browser board (Mobile, 390px)** and a second **Browser board (Tablet, 834px)**, side by side, both pointed at the same running localhost app. During the live-reload beat, one is switched to Desktop (1280px) so the reload is legible at board scale.
- **Planning board** — one checklist card, **5 items, exactly 3 checked, 2 remaining**. The two open items should name what the agent is visibly about to do, so plan and execution read as co-located. Two sticky notes in muted tints and one arrow pointing from the checklist toward the Terminal board complete the "this governs that" story.

**The demo app in the Browser boards** — a real, running localhost app (not a mock screenshot). Build a single component whose change is *obvious at small board size*: a hero heading or button that flips from accent blue `#4f8cff` to white, or a clear variant swap. The edit must read at 390px without zooming in. Critically: set the app's page `background-color` to `#0a0a0b` so any reload flash matches the void.

**Deterministic terminal output.** A live agent is the wrong tool for a repeatable take. Note on tooling: VHS (charmbracelet) drives *its own* terminal window — it cannot inject into Expanse's Terminal board, and it carries real Windows friction (ttyd + ffmpeg on PATH, Defender quarantine). For a Windows-first workflow, the cleaner path is a **PowerShell or Node script that echoes pre-captured agent output line-by-line with scripted sleep intervals**, piped into the shell the Terminal board spawns. That gives identical spinner phase, identical diff counts, and identical timing on every take.

**Frame hygiene.** Run Expanse maximized to fill the monitor, taskbar auto-hidden, plain `#0a0a0b` wallpaper behind it, Focus Assist / Do Not Disturb on. **Audit every frame of terminal output and any visible browser chrome for implementation details** — one stray line naming a framework or runtime violates the positioning and hands a competitor the "it's just a wrapper" line. No devtools, no console noise, no tab titles that leak the stack.

---

## 6. Tooling stack

The pipeline is **capture → assemble/grade → programmatic motion → audio → captions**. The brand-defining choice is **Remotion** for title cards and the CTA: the video is built the same way the product is — React/TypeScript, version-controlled, with Expanse's exact design tokens (`#0a0a0b`, `#4f8cff`, Geist, 8px radius, 24px dot grid) imported straight from source so the brand cannot drift between cuts.

| Tool | Stage / Use | Price (verified 2026) | Verdict |
|------|-------------|------------------------|---------|
| **OBS Studio** | Primary capture (Windows). Full-monitor **Display Capture via Windows Graphics Capture** — the only method that composites the native Browser-board preview layer correctly. | Free | **PICK (capture).** Mandatory on Windows. Test Display vs WGC Window Capture; the native preview panel can be black under the wrong method. |
| **DaVinci Resolve (free)** | Assemble, **color-grade the dark UI** (uniform `#0a0a0b` across takes), Lanczos downscale 4K→1080p, mix audio, caption burn-in (Fusion), final export. | Free (Studio $295 one-time, not needed) | **PICK (edit/grade).** The grading pass is non-negotiable for dark UI — recordings drift between monitors and the void must match. |
| **Remotion** | Title cards, the ONE SURFACE / 390·834 callouts, the terminal-cursor CTA, optionally the checklist-fill overlay. Tokens imported from the product. | Free for ≤3 people (employee-count gate, **no ARR threshold**). Company min ~$100/mo. | **PICK (motion/titles).** The on-brand differentiator. Use it for overlays and titles — never to fake live app behavior. |
| **ElevenLabs** | AI voiceover (Eleven v3), if VO is used. Voice Design to dial pacing up and warmth down. | **Commercial rights from the $5/mo Starter tier**; Creator $22/mo (~100 min). | **PICK (VO).** Best naturalness at calm pacing. Starter covers a one-off film. |
| **Epidemic Sound** | Licensed music + SFX. Dedicated Dark Ambient / Minimal Techno catalogs; deepest SFX library. | Pro $16.99/mo (annual) — required for commercial use. | **PICK (music/SFX).** Strongest dark-minimal catalog. Note: license ends on cancellation — download what you need during the cycle. |
| **Sonniss UI packs** | One-time bespoke UI SFX kit (haptic taps, soft toggles, connect tones) in a neutral electronic register. | One-time, ~$30–100/pack | **PICK (SFX kit).** Buy once, own forever. (Audition the actual current pack contents — exact pack names/counts shift.) |
| **HandBrake** | Final compression pass from the lossless master: social MP4 H.264, hero-loop WebM VP9. | Free (handbrake.fr) | **PICK (encode).** Standard final step. Never re-compress an already-lossy file. |
| **Cap (cap.so) / Rapidemo** | Windows auto-zoom recorders for **MICRO close-up takes** only (checklist tick, full-view click). Adds the focus push-in OBS won't. | Cap has a free tier; Rapidemo $139 one-time (1yr updates) | Optional. Use for micro-interactions; keep OBS for all canvas-hero takes. |
| **Screen Studio + ScreenFlow** | If a Mac is available: best-in-class polish for micro takes (auto-zoom, motion-blurred cursor) + a deep NLE. | Screen Studio $9/mo annual or ~$229 lifetime; ScreenFlow ~$199 one-time. **macOS only.** | Optional. Genuinely nicer cursor motion than Windows tools — only matters in slow-mo review, not at watch speed. |
| **Descript** | Caption generation / VO cleanup, one step only. | Starter free; Hobbyist $16/mo, Creator $35/mo (annual) | Optional helper. Not the edit suite. |

Deliberately **not** in the stack: After Effects (a 40-100hr learning curve you can't recoup on one film — hire a freelancer if you truly need cinematic compositing); Premiere (recurring cost, no advantage over free Resolve); CapCut (its templates and AI styles drag everything toward generic-social aesthetics — the exact wrong tone); PlayHT (**discontinued — Meta acquired it and shut it down end of 2025**; do not list it as a VO backup — use Murf, Cartesia, or Resemble if ElevenLabs voices don't land).

---

## 7. Capture settings & pre-flight checklist

**Settings:**
- **Resolution:** record at native monitor pixels (2560×1440 or 3840×2160). Set OBS Base = Output = native; **never let OBS downscale during capture** — do the Lanczos downscale to 1080p in Resolve on the lossless intermediate.
- **DPI:** set system display scaling to **exactly 100% (96 DPI)** for the session. Fractional scaling softens Geist Mono glyphs in a way post can't recover. Verify Expanse renders crisp at 100% before you commit.
- **FPS:** **60fps, non-negotiable.** The 200ms fit-animation and 80ms spinner render as ~6 frames at 30fps and stutter; at 60fps the easing curve is visible and smooth.
- **Codec / container:** near-lossless intermediate to **MKV** (crash-safe; or Fragmented MP4 in OBS 28+). On RTX-class GPUs, **NVENC AV1** is OBS's best quality-per-bit; **HEVC 10-bit 4:2:0** is the strong fallback (note: OBS does not expose HEVC 4:4:4 regardless of GPU). The `#202022` dot grid on `#0a0a0b` macro-blocks under any normal streaming bitrate — record near-lossless, compress only at the end.
- **Capture method:** OBS **Display Capture (WGC)**, full primary monitor. The Browser board is a native OS layer; per-window capture can render it black.
- **LOD safety:** the canvas drops boards to snapshot cards below ~40% zoom. Plan the hero pull-back to stop at **~45%** so every board stays live. If you control a build, you can raise/zero the LOD threshold for the recording session to guarantee live views at all zooms.

**Literal pre-flight checklist (run before every take):**
- [ ] Focus Assist / Do Not Disturb ON; pending tray notifications dismissed.
- [ ] Taskbar auto-hidden; wallpaper plain `#0a0a0b`; no other windows in frame.
- [ ] Display scaling = 100%; recording drive has 100GB+ free on NVMe.
- [ ] Expanse maximized; three boards pre-arranged in the locked landscape layout.
- [ ] Demo app running on localhost; page background = `#0a0a0b`; the visible change verified legible at 390px.
- [ ] Terminal output script staged; spinner phase + diff counts confirmed identical to last good take.
- [ ] OBS preview confirms the Browser board content is **visible** (not black) under Display Capture.
- [ ] Checklist card seeded at exactly 3/5 done.
- [ ] No framework/runtime/stack string anywhere in terminal output or browser chrome.
- [ ] Cursor smoothing on for MICRO takes; OFF (auto-zoom OFF) for all CANVAS takes.
- [ ] Test the fit-animation lands at ~45% zoom (all boards live, none snapped to LOD card).

---

## 8. Audio & music plan

The sonic identity mirrors the visual one: **one texture, one accent, zero ornament.**

**Voiceover.** Optional but recommended for the hero film — design the **sound-off experience first** so VO only deepens it. If the film makes sense muted with captions, the VO is polish; if it only works with VO, the edit failed. Use **ElevenLabs Eleven v3** (commercial rights from the $5 Starter tier). Audition for "calm / confident / professional," never "friendly / upbeat / energetic." Add manual SSML pauses around compound technical nouns ("localhost URL," "responsive breakpoint") where AI voices rush. Delivery: a senior engineer explaining a tool they actually use, 125-135 WPM. If budget allows one human session, use a human for the hero film and AI for social variants — but ElevenLabs v3 closes most of that gap at this register.

**Sonic palette.** One bed — sparse dark-ambient or minimal techno at 65-90 BPM, texture and forward motion but **no melodic earworm, no lyrics, no risers**. Search Epidemic Sound: `dark-ambient + focused`, `minimal-techno + dark`, `ambient-electronic + low energy`. Avoid anything tagged inspiring, motivational, corporate, or "technology" (that's the generic marimba-SaaS sound).

**SFX — three or four moments only.** Port-detection click (a single clean "connect" tone, soft transient, ~80ms tail — not a beep). Checklist tick (haptic tap, slight pitch-rise on successive ticks, never gamified). Full-view expand (a short 0.3s rise, peak ~-18 dBFS, no more than 6 dB over the bed). Everything else silent. Source from the Sonniss kit; **never use iOS/Android system UI sounds** — they read "mobile app," not "precision desktop tool."

**Mixing.** VO peaks at -6 dBFS. Music bed sits 15-20 dB under VO (around -24 to -26 dBFS) — **duck, don't silence** (full silence under narration reads amateur). Fast attack (10ms), medium release (200ms) so the bed breathes between sentences. Carve a -3 to -6 dB shelf at 1-3 kHz in the music to clear the VO fundamental. Intro/outro bed at -12 to -14 dBFS; 4-second fade-out at the end (an abrupt cut reads unfinished). **Absolutely no VO under the HERO ZOOM-OUT** — let the bed swell 2-3 dB while the camera pulls back; the silence is the statement. Final master to **-14 to -16 LUFS integrated** (YouTube normalizes to -14; for Vimeo, which does not normalize, target ~-16).

---

## 9. Distribution plan

One master cut; every channel is a derivative, never a separate video. **Captions are mandatory on all social cuts** — 80-85% of feed views are muted. White Geist, 22pt-equivalent minimum on the void.

| Channel | Cut | Aspect | Length | Caption / thumbnail note |
|---------|-----|--------|--------|--------------------------|
| **Product-page hero (above fold)** | Silent zoom-out loop | 16:9 | 15s | No captions. `autoplay muted loop playsinline` (no `playsinline` = broken iOS autoplay). MP4 H.264 primary + WebM VP9 secondary, <5MB. Poster frame <150KB. Test on throttled "Fast 4G." |
| **Product page (below fold)** | Full launch film | 16:9 | 75s | Optional captions; VO + score. The considered watch. |
| **YouTube** | Full launch film | 16:9 | 75s | Thumbnail = full-canvas overview, dark bg, 3-5 white words top-left, no faces. Title keyword-first, 50-60 chars: "Expanse — AI coding agents on one canvas." Upload an SRT separately (burned-in captions are invisible to the crawler). Add chapters. Do not flag "made for kids." |
| **X / Twitter** | Port-detection clip | 16:9 or 1:1 | 25-30s | **Native upload, no YouTube link in the post** (links throttle reach; drop the link in the first reply). Hook must land in 1s — the URL→browser-snap is the single most legible 5-second moment. Burned-in captions. |
| **LinkedIn** | Problem-card → product | 4:5 or 1:1 | <60s | Post from the **founder's personal profile**, not the company page. Open on a text pattern-interrupt ("Your terminal is in one window. Your browser in another. Your plan in a third app."). Post Tue-Thu, 9-11am US-Eastern; reply to every comment in the first 90 min. |
| **Product Hunt gallery** | Launch film | 16:9 | 75s (≤2min ok) | **PH gallery video = a YouTube URL, not a file upload** — host on YouTube first. First gallery image = hero canvas overview, 1270×760. Use Loom only for the maker's comment-thread walkthrough, never the gallery. |
| **YouTube Shorts / Reels** | FOCUS SNAP clip | 9:16 | ≤60s | Double-click → camera animate → one board fills viewport; reads instantly on a phone. Vertical <60s auto-classifies as a Short — that's intended. Burned-in captions. |

**Positioning guardrails (every channel, every frame):**
- Lead with the **problem** (fragmentation across windows/tabs/apps), then dissolve it on one surface.
- Phrases that tested well: *"your agents," "one surface," "no tabs," "live, side by side."* Plus the two concrete differentiators: the **spatial/canvas metaphor** and **real reflow at real breakpoints, not a scaled screenshot.** (Warp now also uses "one surface" language — these two angles are where Expanse is defensible and concrete.)
- **Never:** name or show the runtime/framework/any implementation detail; frame it as build-in-public, alpha, beta, or "shipping soon"; compare a competitor by name; use purple gradients, glassmorphism, glow, particles, or any caption overlay outside the Expanse token set; show setup, config, or an empty canvas as the opener.

---

## 10. Production plan

**Effort.** Realistically **3-5 focused days**, weighted heavily toward the canvas, not the camera:

1. **Day 1 — Build the demo canvas.** The running app with the legible change, the scripted terminal output, the three-board landscape layout, the 3/5 checklist. This is where the premium signal is won or lost. (~40% of total effort.)
2. **Day 2 — Capture.** OBS at native 60fps. Separate CANVAS and MICRO takes. Get five clean matching takes of the hero pull-back in one session — Focus Assist on, layout locked (PowerToys FancyZones helps keep board positions pixel-identical across takes).
3. **Day 3 — Assemble + grade in Resolve.** Cut to the EDL, grade the void uniform, Lanczos downscale.
4. **Day 4 — Remotion titles + audio.** Build the title cards / CTA from product tokens; lay the bed; place the 3-4 SFX; mix to -14 LUFS; (optional) drop in VO.
5. **Day 5 — Derive cuts + encode.** Hero loop (its own rhythm), three verticals, the social/PH variants. HandBrake final pass. QA every frame against the no-stack-leak checklist.

**Order of operations rule:** canvas → capture → grade → motion → audio → captions → derive → encode. Never re-compress a lossy file; always derive cuts from the lossless master.

**Budget.**
- **Free / scrappy (~$0-40):** OBS + Resolve free + Remotion free + HandBrake, royalty-free or a single Epidemic Sound month, AI VO on ElevenLabs Starter ($5), Sonniss UI pack one-time (~$30). Entirely viable for a premium result — the canvas does the heavy lifting.
- **Premium / outsourced ($8K-15K):** a motion/edit specialist for the hero pull-back polish and a human VO session, licensed music, multi-cut delivery. Worth it only if the canvas is already pixel-perfect — production gloss cannot rescue a fake-looking demo state.

---

## 11. Appendix

**Reference videos & pages to study (and why):**

- **Linear** ([linear.app](https://linear.app/), [design refresh](https://linear.app/now/behind-the-latest-design-refresh), [Sequoia spotlight](https://www.sequoiacap.com/article/linear-spotlight/)) — "invisible excellence": quality expressed through what the user doesn't experience. The exact tone the film must match. The spotlight's real line is worth internalizing: *"If I'm building a house, I don't want my tools to be fun. I want them to be good. I want them to be professional."*
- **Raycast** ([raycast.com](https://www.raycast.com/)) — outcome-and-feeling positioning ("never feeling like you're wasting time"). The template for Expanse's emotional frame.
- **Warp** ([warp.dev](https://www.warp.dev/), [2.0 launch](https://videohighlight.com/v/CDXqMd3klvo)) — the cautionary benchmark. Take its three-act structure (context → introduction → live demo); reject its ~20-minute length. Compress to 75s and let the UI carry the demo.
- **Arc Browser** ([Failory teardown](https://newsletter.failory.com/p/lights-camera-arction)) — the **anti-benchmark**. Its vlog, build-in-public warmth works for a consumer browser. It is exactly what Expanse must not do. Study it to know what to avoid.
- **Linear/Cursor/v0 demo analysis** ([Content Beta](https://www.contentbeta.com/blog/best-product-demo-video-examples/)) — documents the zoom-out-from-detail-to-overview structure that maps directly to the hero pull-back.
- **Framework references** — [WithLore launch framework](https://www.withlore.co/blog/launch-video-for-app-startups/) (multi-asset system, sell the outcome), [Advids SaaS teaser](https://advids.co/blog/saas-launch-teaser) and [walkthrough analysis](https://advids.co/blog/30-software-feature-walkthrough-videos-that-highlight-key-functionality) (read the stats as n=7 craft heuristics, not laws), [silent-first editing](https://www.clicks.video/blog/silent-first-editing-captions-text-overlays-and-visual-hooks-for-sound-off-viewing).

**Full tool link list:**
- Capture: [OBS Studio](https://obsproject.com/) · [Cap](https://cap.so/) · [Rapidemo](https://getrapidemo.com/) · [Screen Studio](https://screen.studio/) (macOS) · [ScreenFlow](https://www.telestream.net/screenflow/overview.htm) (macOS)
- Edit / grade: [DaVinci Resolve](https://www.blackmagicdesign.com/products/davinciresolve)
- Motion / titles: [Remotion](https://www.remotion.dev/) (and its fork [Revideo](https://re.video/) if you trip the 4-person gate) · [Motion Canvas](https://motioncanvas.io/) for choreographed explainer sequences
- VO: [ElevenLabs](https://elevenlabs.io/) (avoid PlayHT — discontinued; alternates: [Murf](https://murf.ai/), [Cartesia](https://cartesia.ai/), [Resemble](https://www.resemble.ai/))
- Music / SFX: [Epidemic Sound](https://www.epidemicsound.com/) · [Artlist](https://artlist.io/) · [Sonniss](https://sonniss.com/) · [Zapsplat](https://www.zapsplat.com/) (free SFX prototyping)
- Encode / captions: [HandBrake](https://handbrake.fr/) · [Descript](https://www.descript.com/)
- Frame hygiene (Windows): Focus Assist (built-in) · [PowerToys FancyZones](https://github.com/microsoft/PowerToys)

One last instruction to whoever holds the camera: **the zoom-out is the whole video.** Light it, time it, and pace it like the only shot that matters — because it is.