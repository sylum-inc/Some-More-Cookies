# Some More — Implementation Plan

**Status:** living document · updated continuously · last updated: session 2
**Companions:** [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) · [`ARCHITECTURE.md`](./ARCHITECTURE.md)

---

## Current state

**Session 1 complete.** The repository was empty at session start (a README
containing one line). Everything below was built from zero.

| Area | State |
| --- | --- |
| Monorepo, TypeScript, Vite, Vitest, Playwright | ✅ |
| PRODUCT_SPEC / ARCHITECTURE / 6 ADRs / README | ✅ |
| `packages/sim` simulation core | ✅ 233 tests |
| PS1 render layer + procedural materials | ✅ 32 tests |
| Procedural audio engine | ✅ 102 tests |
| `packages/content` — 26 concepts scored, 12 encoded | ✅ 79 tests |
| `packages/protocol` + `services/api` | ✅ 230 tests |
| P1 playable ritual, end to end | ✅ driven by E2E in Chromium |
| Passport, photo mode, accessibility | ✅ built, E2E-verified |
| Free movement and exploration | ✅ 37 tests |
| Wildlife, radio, secrets — wired into the ritual | ✅ 78 tests |
| Campsite memory (the significance model, persisted) | ✅ 8 tests |
| PostgreSQL adapter + hand-rolled wire protocol | ✅ 18 + 18 tests |
| Realtime transport and multiplayer authority | ✅ RFC 6455 by hand, no new deps |
| Client ↔ server seam, commerce and rewards | ✅ 10 seam tests against the real service |
| Live ops / CMS · QR and events · live-ops console | ✅ |
| Secondary activities (skipping, stars, torch, fishing, sitting) | ✅ 128 tests |
| Multiplayer client — two browsers share a fire | ✅ convergence proven patch by patch |
| Content overlay · signed codes · scan and redeem | ✅ |
| Media storage · photo upload · campsite memory sync | ✅ |
| Installable PWA · cold offline boot to a finished sandwich | ✅ |

**1,569 unit, integration and seam tests across 89 files**, plus Playwright
projects for acceptance, activities, accessibility, multiplayer, offline boot,
service-worker update, mobile layout, night legibility, code redemption, the
live-ops console, performance budgets and visual regression. 23 further tests
run only against Postgres. Every one of those thirteen projects runs in CI —
five as their own job, the rest as a named matrix entry — because eight of them
were green and enforced by nobody until this was checked.

### What "playable" currently means

A person can load the page, walk in through the dark toward a lit fire, rake
the coals, wait for the fire to burn down, take a marshmallow, roast it with
one continuous drag that controls both distance and rotation, watch it brown
unevenly if they do not turn it, take it to the plate, stack four components
by hand with visible offsets, load the SM-01, close its heavy door, throw the
latch, choose a program, confirm, pull the lever, watch amber become blue and
frost spread, hear the compressor and the relays, release the latch, open the
door into falling vapour, take out a sandwich whose appearance is derived from
everything they just did, photograph it, save it into a scrapbook Passport,
bite it from a chosen side, and be offered — only now — the chance to order a
real one.

No step in that sentence is a placeholder button.

---

## What looking at the running product found

Ten defects that reading the code would not have surfaced, all fixed, most
with regression tests:

| # | Found | Cause |
| --- | --- | --- |
| 1 | The opening image had no fire in it | An established fire decayed to embers within seconds, because fuel could only ever be as lit as its surroundings — there was no self-sustaining term |
| 2 | Every roast charred, at every distance | Flame radiance was calibrated when flames were weak; once fires actually flamed it swamped the entire browning band |
| 3 | A naturally burned-down bed could not roast at all | Coal radiance scaled linearly with pile size, so a half-spent bed radiated half as hard rather than covering half the ground |
| 4 | Frost grew past its target and then visibly retreated mid-run | The freezing stage had no cap, and the transforming stage eased *down* toward one |
| 5 | The finished sandwich rendered as an unlit silhouette | Nothing lit it; it is small, dark-backed and away from the fire |
| 6 | The whole assembly stage rendered black | It happens away from the fire, and by then the fire has burned to coals. Fixed with a camp lantern on the stump, not an invisible fill light |
| 7 | Photographs saved as black frames | A WebGL drawing buffer is cleared once composited; the capture now re-renders synchronously first |
| 8 | The blow-out gesture was inert for the first 900 ms | Its cooldown initialised to `0` rather than `-Infinity` |
| 9 | The marshmallow read as a tiny blob | Roasting was framed from standing height rather than at arm's length |
| 10 | **The reveal showed solid enamel with the sandwich sealed inside the geometry** | The SM-01's body was a single `boxGeometry` — the cabinet had no opening. The door opened onto the machine's own front panel |

Numbers 5, 6 and 10 are the ones worth dwelling on. The most important object
in the product was invisible; an entire interaction stage rendered black; and
the machine at the centre of the whole fantasy had no hole in it. All three
were invisible to a fully green test suite, and none would have been found by
reading the code.

Number 10 also took three attempts. The first two "fixes" moved the camera,
because the symptom looked like a framing problem. It was only after querying
the actual scene graph — door bounds, camera position, sandwich world
position — that the real cause showed up: the sight line was not blocked by
anything, the sandwich was simply *inside solid geometry*. Measuring beat
reasoning.

### Session 2: the eleventh, and the largest

| # | Found | Cause |
| --- | --- | --- |
| 11 | **Every random stream in the simulation was frozen.** | `Rng.split(name)` derives a child from the parent's *current* state, and nothing in the ritual ever drew from the parent — so splitting `'fire'` on every step produced the identical child on every step. Fire, weather, roasting, assembly and wildlife each sampled one value and then repeated it for the entire session. |

This surfaced because a newly wired wildlife system produced exactly zero
sightings over ten simulated minutes with a perfectly still player, when the
model's own tests said it should produce roughly one and a half. The model was
right; the ritual was handing it the same coin, flipped once, forever.

Nothing failed. Everything compiled, 887 tests passed, and the fire on screen
still flickered — because the *deterministic* parts of the fire model still
varied. What was gone was all the stochastic texture: crackle scheduling,
weather transitions, roast variation between two identical roasts. Three
regression tests now cover it, and per-step streams are derived from a tick
counter that is part of the simulation's identity.

The general lesson is the same one as #5, #6 and #10, in a different disguise:
a green suite means the assertions passed, not that the system works. Here the
assertions passed because every test that could have caught it built its own
`Rng` and passed it in directly — which is exactly what a careful unit test
does, and exactly why it could not see this.

### Session 3, part two: what wiring the seams found

Four workstreams wired the client to things that existed only server-side.
Each found something that had been invisible precisely because nothing
consumed it.

| # | Found | Cause |
| --- | --- | --- |
| 18 | **The entire WebSocket stack was unreachable in a real boot.** | `services/api/src/main.ts` never called `attachRealtime`. The module's own comment promised "a one-liner in `main.ts`", and the one-liner had never been written. Every realtime test passed, because every one of them attached it itself |
| 19 | **The service had no CORS at all**, so no browser client on another origin could ever have talked to it | Never needed until a console existed. Preflight now runs before auth, and headers are on error responses too — without which "LIVE_OPS_TOKEN is not set" arrives at a browser as an opaque network failure |
| 20 | **A player scanning a recalled wrapper was signed out.** | `ApiClient` treated any 401/403 as a bad token; a retired print run answers 403 |
| 21 | **The service worker never cached the shell.** A fully-downloaded campsite would have shown "the campsite has not been downloaded yet" | The precache list came from `Object.keys(bundle)` in `generateBundle`, and this Vite emits the HTML *after* that hook. Worse, the worker's version hash had the same blind spot: a build changing only `index.html` would have shipped a byte-identical `sw.js` and reached no device, ever |
| 22 | **A second device pitched a second campsite**, so two devices had nothing to merge | `SyncEngine.ensureCampsite` only checked `localStorage` |
| 23 | **Three HUD controls sat under the notch or the home indicator**, and the bite ring cleared the corner group by 0.7px on every notched iPhone | Each read the safe-area insets except the ones that did not. The 0.7px gap is 27px on a laptop, which is why nothing showed it |
| 24 | **Render resolution stayed at portrait's after a rotation** — roughly twice the pixels it should be | `dpr` was derived from `window.innerHeight` read once at mount. A frame-rate defect only a real rotating device would ever show |

Numbers 18 and 21 are the pair worth keeping together. Both are the same
shape: a complete, well-tested subsystem that nothing actually reached. The
realtime stack had seven test files and a full protocol; the service worker
cached every asset it was told about. In each case the tests attached the
thing under test themselves, so the one line that would have connected it to
the running product was the only line nobody wrote a test for.

### Session 3: measuring the two things that were only ever guessed at

Roasting and the SM-01 run are the two riskiest claims in the product (R1, R2)
and both had been tuned by reading rather than measuring. Sweeping the whole
input surface found four more defects, none of which could fail a test,
because in every case nothing was broken — the system simply did the wrong
thing correctly.

| # | Found | Cause |
| --- | --- | --- |
| 12 | **Golden was unreachable over open flame.** A marshmallow held in the flames went from pale straight to blackening. | Browning and charring are both sigmoids on temperature, both saturate over a hot fire, and charring has the higher rate — so above ~300 °C char accumulated 1.18× faster than brown, forever, at every distance. Charring is now gated on the patch's own browning: sugar caramelises, then carbonises through the caramel |
| 13 | **The SM-01 said nothing for 11.9 seconds of a 50-second run**, right after the lever comes down | The amber pull-down had three scheduled beats in its first two seconds and none after. It now narrates the pull-down, scaled to the program |
| 14 | **Frost ticked like a metronome** — 129 crackles, evenly spaced at four a second for the back half | The rate was proportional to how much frost there was. It is now driven by how fast frost is *forming* and metal *contracting*, clumped by value noise, so it nucleates and then settles |
| 15 | **The machine could be permanently wedged by looking inside it.** Opening the empty SM-01 and closing it left it in a state whose only legal action led to a lever that refuses to run empty | An empty machine that is shut now returns to `idle`, where its door eases open again |
| 16 | **The renderer had no tone mapping at all**, so every value above 1.0 clipped straight to white — and next to a fire a great deal is above 1.0 | Found while chasing #17. It had already cost the project once undiagnosed: the fire-ring stones carry a hand-darkened albedo and a comment reading "raw stone albedo next to a fire blows out to paper white", which is this bug worked around one object at a time. Reinhard rather than ACES, because ACES desaturates highlights toward white — the thing being fixed |
| 17 | ~~Seventy seconds of browning was invisible on screen.~~ **Not a defect. I was wrong.** | Recorded because being wrong in a particular way is worth keeping. See below |

**Number 17 is a false positive, and the most instructive entry here.**

I spent a long time convinced that the marshmallow's browning was not
reaching the screen. Three screenshots showed it black, then cream-white, then
cold blue-grey, while the model reported it browned and the HUD said
"SCORCHING". I diagnosed it four times and was wrong every time: first that a
rock was occluding it (it was a burning log), then that vertex colours were not
reaching the shader, then that it was over-exposed — and I *added* light, which
made it worse.

It was none of those. Forcing every vertex to pure red rendered red, which
proved the colour pipeline end to end. Then, with a genuinely hot ember bed —
three oak logs and 150 seconds — the model reached brown 0.911 and the
marshmallow rendered `206,140,66`: a warm toasted amber, exactly right.

Every earlier reading was an artefact of my own test pose:

| What I saw | What it actually was |
| --- | --- |
| Black | A burning log between the camera and the marshmallow |
| Cream-white | A marshmallow browned to 0.05–0.35, which *is* pale |
| Cold blue-grey | A marshmallow over a nearly-dead fire on a moonlit night, which *is* blue-grey |

The lesson is not "measure rather than reason" — this project already knew
that, and I was measuring the whole time. It is that **a measurement of a
badly-set-up scene is worth less than no measurement**, because it carries the
authority of evidence. I built the pose myself, it never had a real fire in it,
and I read four different conclusions out of it before checking the one thing
that would have settled it in a minute.

Two real improvements came out of the hunt and are kept: the tone-mapping curve
(#16), which was genuinely missing, and a properly-sized warm fill on the
marshmallow, which the raised night ambient had left undersized. Neither was
what I set out to fix.

Two things measured and found *not* to be defects, which is worth recording so
they are not re-litigated: the spin control is right (a still marshmallow comes
out visibly one-sided, and a lazy quarter-turn a second evens it), and weather
genuinely reaches the fire (rain kills the flame inside two minutes, and a gale
makes the ember bed run hotter and more even than still air).

### Session 4: what two browsers at one fire looked like

Eight defects found the only way they could be: by opening two browsers on one
campfire and looking at the pictures. Not one of them could fail a test, because
in every case the code did what it said.

| # | Found | Cause |
| --- | --- | --- |
| 26 | **The second player's browser showed a title card instead of a campsite** | Chromium throttles a backgrounded tab's animation frames to nothing, and `scene/World.tsx` publishes the ritual stage from inside its render loop — so a page never brought to the front never leaves the trail. The spec now brings each page forward before anything that needs a frame, and waits on the shared tick advancing rather than on the wall clock |
| 27 | **Two people at one fire, with no fire in shot** | `framePortrait` stood the camera a fixed 2.6 m from the pit on the bearing opposite the other player, which frames both only when they happen to be far from it |
| 28 | **A photograph taken from inside another player's jacket** — a flat brown slab filling the frame | The same fixed standoff, when *they* are near the fire, lands about a metre from where they are standing. The standoff is now measured from the person, and the spec asserts a minimum separation, so it fails rather than quietly captures that picture again |
| 29 | **Nobody had a name.** No nameplate appeared above any remote player, at any distance | `scene/Campfire.tsx` drew it as a `THREE.Sprite`, which does not survive the PS1 pass, and faded it 2.2 m → 7 m — invisible at exactly the distance people sit apart at a fire. Now a camera-facing quad with `fog: false`, faded 4 m → 11 m |
| 30 | **"[Ash Creek is coming down the trail]" stayed on screen for the rest of the night** | The simulation's own cues expire on a timer inside `onSimStep`; campfire lines arrive from the socket outside that loop and had no timer of their own |
| 31 | **Two buttons printed on top of each other** — "AT THE FIRE · 2" over "TAKE IT TO THE PLATE" | The campfire panel button was placed bottom-left, which is the HUD's own action-button zone. Moved to the top-left, the one corner nothing else uses |
| 32 | **A joining player was stranded on the trail**, drawn to everyone else as a silhouette at the treeline that never came closer | Adopting a shared world changes the campsite seed and environment, which recreates the `walkable` memo and with it the `PlayerState` — *after* `World`'s `lastStage` ref has already spent the `arriving → at-fire` transition that would have placed them |
| 33 | **A title card over a live campsite**: a player already sitting at the fire was invited to walk in to it | `arriving → at-fire` is deliberately local — it is where a camera is, not a fact about the world — but it lives on the *shared* ritual, so every snapshot rebuild undid it |

Numbers 27 and 28 are worth keeping as a pair, because they are the same
mistake twice and neither is a rendering bug: both are the *test* framing a
picture badly, and both would have been recorded as evidence about multiplayer
if nobody had looked at them. The lesson from #17 generalises — a screenshot is
only worth what the pose behind it is worth.

### Session 5: you can ask the campsite what is around you

The audit's last open accessibility item, and the one it had deliberately not
answered: everything in the product narrates *change*, and there was no way to
ask what is *here*. A campsite you can only learn about by bumping into things
is not a place you can be in.

`Q` now asks, and it answers in prose — what is in reach, how the fire is
actually burning, what is close enough to walk to and in which direction
relative to your own body, where you are standing, the weather, and whether
anything is at the edge of the light. Composed from the world the renderer
draws, so nothing in it can drift from what is on screen.

Three deliberate restraints, and one mistake worth keeping:

* **Asked for, never volunteered.** A world that describes itself unprompted is
  one nobody is standing in.
* **Shown as well as announced.** A survey only a screen reader receives would
  be the §12 single-channel rule broken by the feature written to keep it.
* **Prose, not a readout.** Bearings are "behind you and to the left" rather
  than degrees; distances are paces rather than metres.
* The first version said **"You are in water-edge."** — an identifier read
  straight into a sentence, which is the whole difference between a survey and
  a data dump. Places with no phrasing are now left out rather than mangled.

The toggle was also wrong on its first run, in a way this session has now seen
three times: it read `state.survey` from the value the key handler closed over,
and the effect does not re-register when the survey changes, so the second press
saw a stale `null` and re-opened instead of closing. Reading `store.state`
directly is the fix. Correct about the thing it was looking at, wrong about
when.

### Session 5: the last two buttons

§1.3 rules out a "Roast" button and a "Build" button. Two acts had held out as
controls anyway — taking the marshmallow to the plate, and taking the sandwich
out of the machine — and both were a button in the corner of the screen right
up until now.

They are gestures now. The stick is **pulled back past the edge of the coals**:
the band's outer end is the edge of the fire, so anything beyond it is already
off the fire, and 0.35 of a band further is about a hundred pixels of deliberate
pull. Drawing the marshmallow back to cool it cannot finish the roast by
accident, and the same key that already means "further away" carries it to the
plate on the keyboard, so there is no second mechanism to keep in step with the
first. The sandwich is **taken hold of and lifted** off the tray — `pointerdown`
and a lift, not a click, because a click is a press and a release in the same
place and this is not that.

The buttons still exist, and are still reachable, because a gesture is not a
control scheme (§12). They are in the accessibility tree and not on the screen
unless the player is actually using a keyboard — kept mounted rather than
conditionally rendered, because a virtual cursor that never fires a keydown
would otherwise be reading a document where the button does not exist.

The test for this was wrong twice before it was right, which is worth keeping:

1. `toBeHidden` — wrong, because the button is *deliberately* in the tree.
2. Measuring its box — wrong, because `overflow: hidden` on a clipped parent
   changes what is painted and not what a child measures, so the button still
   reported 179×30 while being invisible.
3. Asking whether a pointer at the button's own centre hits it — right, because
   hit-testing follows painting, and that is exactly the claim: reachable by a
   screen reader and by Tab, not there for a thumb.

### Session 6: what the verification itself was not verifying

Asked to install the coverage provider and sweep the browser suites for the
stale-build pattern found in the console. Both turned out to be larger than the
thing they were following up on.

| # | Found | Cause |
| --- | --- | --- |
| 50 | **Eleven of the thirteen Playwright projects ran against a build nothing rebuilt.** `webServer` was `vite preview`, which serves `apps/web/dist` and never builds it, with `reuseExistingServer: true` on top — so a source change with no rebuild was tested as the previous version, and a preview server left running from an earlier build was adopted silently | The console case (defect #48) was not a one-off, it was the same configuration one level up and across the *player* app rather than the admin tool. `subpath` was immune because it builds its own artifact on purpose, and its comment already gave the general reason — "a prebuilt artifact would beg the question" — which was true of every other project too. Fixed by building inside the `webServer` command and refusing to reuse a server; verified by touching a source file and confirming `dist` is rebuilt mid-run |
| 51 | **Coverage had never been measured, and the config would have understated it if it had.** `vitest.config.ts` carried a `coverage` block, but `@vitest/coverage-v8` was not installed and not declared, so the block had never executed once | Two layers. The provider was missing, so the number did not exist. And the `include` globs covered `packages/` and `services/` only, so the first number it *would* have produced was a confident 92.6% that said nothing whatsoever about `apps/web` — the largest area in the repository, and the one carrying the renderer, the audio engine and the UI. Widened to include `apps/`, which is what makes the honest number below possible |
| 52 | **One assertion tolerated an ambiguity instead of resolving it.** `access.spec.ts` accepted `/machine is (open and empty\|ready)/`, so it could not have noticed if the two narrations swapped | The door is genuinely mid-animation at boot, so the alternation was an accommodation rather than laziness — but the door value is readable, and reading it first makes exactly one sentence correct. The sweep found no other assertion of this shape: the only other alternation is a *negative* one (asserting neither identifier leaks), which is correct as written |

**The first coverage numbers this project has ever had**, unit and integration
only — Playwright is not measured here, which is why the two browser-driven
apps score as they do:

| Area | Lines |
| --- | --- |
| `packages/protocol` | 99.86 % |
| `packages/content` | 97.01 % |
| `packages/sim` | 96.99 % |
| `services/api` | 87.50 % |
| `apps/web` | 48.65 % |
| `apps/console` | 0.00 % |
| **Whole codebase** | **71.70 %** (83.32 % functions, 81.39 % branches) |

`apps/console` at zero is not a gap in disguise: it has no unit tests at all and
is driven entirely through Playwright, which this instrument cannot see. The
same is true of much of `apps/web`. The useful reading is not the headline but
the shape — the deterministic, pure parts of the system are near-total, and
everything that needs a browser is measured by a different tool or not at all.

The through-line of both sessions is worth stating plainly, because it has now
happened often enough to be a property rather than a run of bad luck: **the
defects in this repository are not found by reading it.** Seven separate things
— a resolver comment, a compiled output, a Dockerfile, a schema comment, two
build pipelines and a coverage block — were written, described confidently, and
never executed. Every one was found by running something. The narrative in this
repository is unusually thorough, and that is exactly what makes a stale
sentence in it dangerous: it reads like it was checked.

### Session 5: the operator model, and what only a real database says

Closing Blocker 9 — one shared `LIVE_OPS_TOKEN` replaced by named capabilities
— and Blocker 11, moving the velocity limiter out of process memory. Four of
the five defects below were found by running the thing rather than by reading
it.

| # | Found | Cause |
| --- | --- | --- |
| 45 | **Revoking a capability was a 500 against PostgreSQL and a pass against everything else.** The `UPDATE` bound one placeholder twice — `SET revoked_at = $3` (a `timestamptz`) and `to_jsonb($3::text)` — and Postgres rejects a parameter inferred as two types (`42P08`) | It passed in memory because there is no planner, and it passed when the same SQL was pasted into `psql` because literals are not parameters. Only a *parameterised* statement against a real server produces it. Two hours went into the array parameter that was not the problem; the fix is the `$3::text::timestamptz` pin two sibling adapters already used |
| 46 | **The concurrency suite asserted the old permission model as a feature.** Five cases in `postgres.test.ts` minted codes and published documents by presenting `LIVE_OPS_TOKEN`, which Blocker 9 had just stopped meaning anything | The suite is about races in the database, so the credential was setup nobody re-read. They now grant the capability the route actually checks, which is also a clearer statement of what each case needs |
| 47 | **The console gated every control on the spent bootstrap secret.** `canAuthor` read `credentials.opsToken.length > 0`, so after Blocker 9 it was wrong in both directions: an operator holding real capabilities but no bootstrap string saw everything greyed out, and anybody holding the spent string saw everything live until the service said 403 | The change landed in the service and the screen was never re-derived from it. Each control is now disabled from the capability its route checks, and the banner names what the account holds instead of telling everyone to paste `LIVE_OPS_TOKEN` |
| 48 | **`vite preview` served a stale console build, and the suite passed anyway.** The banner's wording changed, the *previous* wording was served, and every assertion stayed green | Two failures compounding: `preview` never rebuilds, and the assertion was `/Authoring enabled\|not configured/` against the whole panel — which the code-signing line satisfied on its own, so it had stopped saying anything about authoring. The assertion now names a capability, and the fixture refuses to run when `dist` is older than `src` |
| 49 | **`liveOps.status()` could no longer return `not_configured`.** Its `ready` branch became unconditional when authoring moved to capabilities, leaving a protocol state nothing can produce | Recorded rather than removed: the discriminated union is still the right shape for a credential-gated subsystem, and code signing still uses both branches |

Blocker 11 went the same way. Redis was the assumed answer and stayed unbought;
the database was already there, already durable, and already the thing two
instances agree on. `rate_limit_windows` counts a shared window in one atomic
upsert that decides in a single statement whether the current window is live or
expired — so no read-then-write between two instances can lose a count.

Both blockers were waiting on a purchase that turned out not to be the
dependency. Blocker 9 was framed as needing a staff identity provider; what it
actually needed was the service's own model of what a person may do, and
accounts already existed. Worth remembering the next time a blocker names
somebody else's product.

### Session 5: the service had no way to run

Asked to give the shared campfire somewhere to live. There was not a single
deployment manifest in the repository, which was the known part. The unknown
part was worse.

| # | Found | Cause |
| --- | --- | --- |
| 43 | **The compiled service could not run, and never had.** `tsc -b` emitted JavaScript into `services/api/dist`, and the first thing that JavaScript does is import `@somemore/protocol` — whose `package.json` declares `"exports": "./src/index.ts"`. Node resolves it to TypeScript source and dies on the first `./version.js` inside it | Nothing consumed that output and nothing had ever executed it. There was no working production start path at all, and the artifact that looked like one was a trap. The comment in the resolver hook even asserted the opposite — "a production build goes through `tsc`, so neither path loads this file" — which nothing had ever checked |
| 44 | **The container would have built perfectly and died on its first line.** `services/api` imports `@somemore/protocol` and `@somemore/content`; `@somemore/content` imports `@somemore/sim`, which the service never mentions | Found by assembling the runtime stage on disk exactly as the Dockerfile lays it out and booting from it. A missing `COPY` only ever announces itself by running the thing |

The resolution for #43 was to run from source in production, as development and
every test already do. The alternative — pointing the packages at built
JavaScript — would have meant tests resolving `src` while production resolved
`dist`, which is the exact shape of defect #18: a well-tested subsystem that
nothing actually reached. One loading path is worth more here than a
conventional build artifact. `tsc -b` now emits declarations only, so there is
nothing left in `dist/` that can be mistaken for something to deploy.

There is no Docker daemon in this environment, so **the image has never been
built** and no manifest has ever been applied. That is stated at the top of
`services/api/DEPLOY.md` rather than implied by a green checkmark. What was run,
step by step, is everything the image does: the dependency install in a
manifest-only tree (73 packages), the production start, the assembled runtime
stage, the migrations against a real PostgreSQL, health reporting the pool, and
a CORS preflight from a `github.io` origin.

Two smaller things the exercise surfaced, both now in the manifests and the
guide: `HOST` defaults to `127.0.0.1`, which inside a container means nothing
outside it can connect; and the service **refuses to start** in production
without `AUTH_TOKEN_SECRET` rather than signing sessions with a known
development key — correct, and exactly the sort of correctness that reads as a
broken deployment if the manifest does not set it.

### Session 4: the app could only ever be served from a root

Asked to host it on a GitHub project page, which serves from a subdirectory.
Nothing about that had ever been considered, and the result would not have been
a wonky layout — it would have been a site that does not start.

| # | Found | Cause |
| --- | --- | --- |
| 40 | **Every path in the build was root-absolute.** Assets, the manifest link, the favicons, the apple-touch icon, twenty-two launch images, the manifest's `id`/`start_url`/`scope`/icons, the worker's registration scope, its precache list and its own script path | One value, `BASE_PATH`, now threaded through all of them, with the client half reading `import.meta.env.BASE_URL` so there is no second place to keep in step |
| 41 | **The client asked the origin root for its service.** On a project page `/v1/auth/anonymous` is not this app's service — it is whatever else that account publishes at its root | The API base now falls back to the app's own base, so an app that has been moved takes its service with it. `VITE_API_URL` still overrides |
| 42 | **`realtimeUrl` silently discarded a path.** `new URL('/v1/realtime', 'http://host/prefix')` is `http://host/v1/realtime` | Found while fixing #41 — it also means a configured `VITE_API_URL` with a path has always been ignored. The path is joined relatively now |

Three things are worth keeping from how this went.

**The test found #41, not me.** The spec records every request the page makes
and asserts none falls outside the base — written that way precisely to catch
the paths nobody thought of, rather than the ones the test remembered to look
for. It immediately produced three I had not considered.

**Then my next assertion was wrong.** With #41 fixed, the API calls moved inside
the base and 404ed, and "nothing 404s" went red. But a static host *has* no
service, and the whole product is built to shrug at that. Asserting no 404s was
asserting that a GitHub Pages deployment has a backend. The suite now separates
a missing asset (a broken deploy) from a missing service (Tuesday), and asserts
the campsite reaches the fire anyway — which is the actual claim.

**The dangerous failures here are the quiet ones.** A worker registered with a
scope of `/` from a subdirectory is refused outright, and a precache list of
root paths installs another site on that origin as this app's offline shell.
Neither shows up as a broken picture, and both are found by deploying, which is
the worst place to find anything.

### Session 4: closing the audit's accessibility findings

The adversarial pass left three §12 findings written up rather than fixed,
because each needed a decision or a refactor across files somebody else was in.
They are closed now, and two of them were spec violations rather than
improvements — §12 says no information may be delivered through a single
channel, and the SM-01's state was a colour.

| # | Found | Cause |
| --- | --- | --- |
| 37 | **No overlay moved focus.** Six dialogs, every one named, every one closing on Escape, and `.focus()` was not called anywhere in `apps/web/src`. Opening the Passport on a keyboard did not take you to it, and Tab walked straight back out into the campsite behind a panel covering the screen | One shared `useDialog` hook now sets `aria-modal`, moves focus in, cycles Tab and Shift+Tab inside, and gives focus back to the control that opened it. `Scan` and `Terminal` were the sharp cases — a code entry form and a checkout |
| 38 | **The SM-01's state was a colour and nothing else.** Amber is working, blue is transforming, pulsing amber is a fault; `displayText()` exists but is drawn as a texture *inside* the canvas, so it was never a second channel | A visually-hidden live region narrates the machine in words at every stage and names the colour as well as the state, so the two channels describe the same machine. The canvas itself is no longer an anonymous rectangle |
| 39 | **A failure report could vanish silently.** "This campsite cannot sign you in yet" went out as a subtitle, and subtitles sit behind a setting | Subtitles are the text channel for something *audible*. A report that is not a transcript now goes to a `notice` channel that is never optional |

The instructive one is #37's second half. The first version of the hook passed
every assertion about the trap and failed the one about giving focus back,
because the cleanup asked `panel.contains(document.activeElement)` — and by the
time it runs React has already detached the panel, so the answer is always no.
It is the same shape as defect #25: code that is correct about the thing it is
looking at and wrong about *when* it is looking.

### Session 4: three found by reading the words on the screen

The visual suite compares whole frames against a baseline, with tolerances of
six to twelve per cent of the pixels — measured from the fire's own flicker,
and correctly so. A line of thirteen-pixel type is about three tenths of one
per cent. So the guidance line was, in practice, unverified: it could be
replaced entirely and every baseline would still pass, and
`--update-snapshots` would not even rewrite the files, because by that measure
nothing had changed.

The suite now reads that line as *text* at every stage and prints what it said.
The first run of that readout found the first of these.

| # | Found | Cause |
| --- | --- | --- |
| 34 | **The SM-01 asked to be loaded while it was running.** "Load it, shut the door, and set the machine running" was held across all twelve stages of the machine sequence, so it was still on screen three quarters of the way through freezing | One string for a stage that is really twelve. It now follows `machine.stage`: put it in, shut the door, throw the latch, pick a program, pull the lever — and, while it runs, "Nothing to do now but listen to it", because a machine that keeps issuing instructions while it works reads as one that is waiting for you |
| 35 | **The guidance line was below AA contrast on a light background.** Measured 2.87:1 over the SM-01's chamber wall | Cream type with a downward drop shadow, which works over a night campsite and nowhere else. A heavier halo made it worse — five black offsets round a small glyph fill in its counters. It now has the same scrim the subtitle has at about half the weight: 11.3:1 measured, and still a line in the world rather than a panel |
| 36 | **The sandwich was 8 % of the frame in the reveal** — the one shot the whole ritual builds to | The camera was aimed at the geometric centre of the chamber opening, 13 cm above where the sandwich actually sits, from 1.15 m at 36°. It is now aimed at the sandwich from 0.95 m at 28°, looking down onto the tray. Deliberately not pushed all the way in: the chamber mouth still frames it, because the beat is that it is *in the machine* — it is in your hands one beat later, and that shot is the close-up |

Number 35 is worth a note on method. I first called it "nearly illegible" from
a downscaled thumbnail, which is precisely the mistake defect #17 records. At
1:1 it was perfectly readable. It was still worth fixing — 2.87:1 is under AA,
and that is a number rather than an impression — but the fix was justified by
measuring the contrast, not by squinting at a picture of a picture.

### Session 4: and one found by refusing to accept a plausible diagnosis

| # | Found | Cause |
| --- | --- | --- |
| 25 | **Keyboard roasting dropped nearly every press.** Twenty-four presses of the turn key moved the marshmallow through *one* turn, so it browned on a single face — and every visual baseline downstream was generated from that marshmallow | The controller accumulated all of them correctly; the *ritual* only read it once per rendered frame, in `useFrame`. The simulation steps sixty times a second regardless of frame rate, so on a slow renderer the sim ran a full second against an input sampled at the start of it |

The harness reported this as "the keyboard-only roasting path is broken (spec
§12)", which was a reasonable reading of the symptom and the wrong diagnosis.
The path was wired correctly end to end: the handler ran, the controller took
every press, `RoastController.nudge` did exactly what it says. Under software
rendering the roasting close-up runs at about 1.5 frames a second, and ten
presses spaced 60 ms apart landed inside a single frame; waiting 1.5 s
afterwards, without touching the keyboard, made all ten appear at once. That
observation is what separated "the input never arrives" from "the input arrives
and is then held for six hundred milliseconds".

It is a real product defect and not only a harness one, and the fix is in the
product rather than in the test: `applyRoastPose` now writes the pose the
instant a key is pressed as well as on the frame. A drag can afford to be
sampled a frame late because it is continuous; a key press is a discrete act,
and the keyboard is the accessibility alternative to the drag — so the players
it exists for are precisely the ones most likely to be on the device that
renders slowly.

The test-side lesson is the sharper one. The end-to-end driver advances
simulation time through `advanceSeconds`, which steps the model directly
without rendering. That is what makes long waits bearable, and it is exactly
what hid this: input applied on the frame and time advanced off the frame are
two clocks, and every roast baseline in the repository had been generated
between them.

### Session 6: the catalogue was writing to nobody

An audit of the twelve environment manifests against the code that reads them
found **46 of 131 fields unread** by either the client or the simulation. Not
stubs — finished, evocative, authored content: a five-beat arrival sequence per
campsite, three or four described landmarks each, every soundscape, every
firewood source and how damp it is, each campsite's own firelight colour, and
what its SM-01 tends to be like. The catalogue described twelve distinct places
and the game rendered one clearing with a machine in it.

Twenty-nine of those were wired earlier this session. These are the last five,
and the two defects that turned up while wiring them.

| # | Found | Cause |
| --- | --- | --- |
| 37 | **Every visit to a campsite was the identical visit.** Sixty `SeededVariation`s across the catalogue — five per campsite, each with a range, a unit and a note written as an instruction to the implementer ("Drives fog density, star visibility and how the point light reads", "Changes footstep sound and the moisture of gathered kindling", "Never zero. Fuel is not a pressure") — and nothing had ever rolled one | `procedural` was the field that promised a place would be worth coming back to, and it was a comment. `variation.ts` now rolls each on a stream named after itself, so adding a sixth to a manifest cannot shift the five already there; `tonight.ts` applies the roll by handing each system an adjusted copy of the content it was going to be built from anyway, so no system knows §5.4 exists. Forty-seven of the sixty turn a dial; the other thirteen are recorded in the same table as driving nothing, because a cairn's restacked shape is not modelled |
| 38 | **The renderer contradicted the axis the catalogue grades campsites on.** `character.treeCover` had never been read. The treeline was summed from vegetation-kit densities instead, which drew the cedar switchback — authored `canopy`, sky openness 0.08 — with *half* the trees of a `moderate` lake shore, and put two trees on a mesa graded `none` | Two reasonable-sounding rules for one thing. The kits are the authority on what grows here; the cover axis always was the authority on how much sky is left. `treesForCover` reads the axis and lets the kits place a campsite within a band, so two dense woods are still two different woods. Verified against the budget rather than assumed: at 53 triangles a tree the largest increase in the catalogue is about 3,200 triangles against 60,000, and the treeline is instanced, so draw calls do not move |
| 39 | **A player at the fire could be told that fishing is "the most patient activity in the game and people love it".** The client had started reading activity notes out as notices, and 22 of the catalogue's 113 notes carry a sentence addressed to the team rather than the player — "the reference implementation", "the shot this environment exists to produce", "this is the reason the audio engine has a canyon impulse response" | One field, two voices. The design commentary is worth keeping — it is the clearest record anywhere of what each campsite is *for* — so `inWorld` splits the voices at presentation time rather than editing them out of the manifests, and a test pins the player-facing half of all 113. Fifteen were a single sentence carrying both voices at once and were split in the manifest, so nothing was lost |
| 42 | **And it was not only the activity notes.** The first fix filtered those and stopped, and the new end-to-end survey test immediately read a player two sentences of the cicada bottoms' own ambience prose: "that silence is the eeriest sound in the game", and "which is why the environment feels sheltered" | Nineteen more of the catalogue's **386** player-facing strings carry the same kind of sentence — ground notes, weather character, ambience, distant sounds, arrival beats, landmarks, firewood, wildlife, the SM-01's sticker. The filter now runs once, in a new `worldContent.ts` that is also the *single* builder for the object handed to the simulation; it had been copied between the solo and shared paths, and two copies that must agree is a promise rather than a guarantee. Writing that test also found a bug in the filter itself: a naive sentence split cut "DEPT. OF PARKS · CLEARED" after the abbreviation and kept only "DEPT." |
| 40 | **The eeriness of a place decided nothing**, and the survey never said what a campsite was *for* | `character.eeriness` grades all twelve 1..5 and `activities[].prominence` marks exactly one activity per campsite `signature`. Eeriness now decides how often, and how unpredictably, a place is heard from a long way off — and nothing more, because the schema's own calibration rule says the axis "never reaches *threatening*". Prominence now decides what the survey names, which matters most for the player who cannot see the screen and would otherwise find the tide pools by walking into them or not at all |

| 41 | **The fire suite ran at a different campsite on every run.** Nine end-to-end tests about the pit opened `/` with no `camp=`, and with an empty `localStorage` — which is every Playwright context — the client invents a seed with `Math.random()` *and selects the environment from it*. So the fire tests ran at a random one of the twelve campsites, with different wood, different weather and a different established fire each time | Found by reading a failure that made no sense: the page snapshot on a failing draught assertion described cedar litter and a moss carpet, at a suite developed against a pine hollow. The property it was testing holds with a margin of about 0.19 across all twelve campsites, twenty-five seeds and three arrival times — 900 combinations, none failing — so the failure was the campsite, not the claim. They are pinned now. A test that cannot be run again is not a test |

### Session 6: and nine found by opening the screenshots

The end-to-end suite was green. Every one of these was on screen the whole time.

One of them nearly went the other way. The multiplayer nameplate looked dim to
me at a glance, and defect #35 is the standing record of what that impression
is worth — so I measured it instead: **5.43:1**, comfortably past AA. Nothing
to fix. The difference between #35 and this one is only that the measurement
happened before the change rather than after.

| # | Found | Cause |
| --- | --- | --- |
| 43 | **The notice covered the reach prompt** — the sentence introducing a campsite's firewood sat squarely on top of the "Gather tinder" button, at the exact moment both appear | The HUD's channels are absolutely positioned by percentage from the bottom, and the reach prompt was at 18% with the notice at 19% — one percent apart on a button five percent tall. Both elements were present, both had the right text, and every assertion about them passed. The notice moves to 26%, and `access.spec.ts` now reads the *boxes* of every HUD channel and fails on any two that share pixels |
| 44 | **The campsite recited its own description over its title card.** The elevation remark's condition is "more than five and a half metres from the fire", which is true of every frame of the walk in — so a boxed note about the shape of the land sat under the arrival beat and on top of the title, before the player had done anything | `place.ts`'s own docstring says a campsite reciting its description on arrival would be a loading screen with trees, and the module was right; nothing stopped it. The place is silent through `arriving` now — the walk in has its own five beats, written for it |

| 45 | **The guidance line ran under the corner controls on all three phones.** Its comment said it was "placed clear of the corner controls so it never collides with them on a narrow viewport"; it overlapped them by eight pixels on the SE, the 15 and the Pixel 7 | The line sat at `46px * textScale` from the top. The buttons are `7px * textScale` of padding around `12px * textScale` of type inside a container with a *fixed* 12px pad, so their height and the line's offset scale at different rates and **no single constant clears them at every text size** — it was worst for exactly the players who most need the type large. The top band is a flex column now: the corner row takes the height it takes and the line goes under it. A column cannot get this wrong |
| 46 | **The sandwich was 3.4% of the frame in the reveal** — the shot the whole ritual builds to, and *worse than the 8% that defect #36 called a defect* | #36's fix was a composed camera pose, "0.95 m at 28°, aimed down onto the tray". Then #27 removed the camera cuts and `isCameraAnchored` became permanently `false`, so that pose went dead for this stage and the sandwich went back to being seen from wherever the body stood, through the same 48° lens as the three stages where your *hands* are busy. Nobody re-measured, and this plan still recorded #36 as fixed. Checked first that the camera had settled — identical at 0 ms and 16 s — so it was the framing and not the capture. The close-work lens is per stage now, and the value was chosen by rendering it and looking |
| 47 | **The campsite recited its own description over the reveal as well.** Walking to the SM-01 is walking away from the fire, so the elevation remark comes due and lands while the player is looking into the open chamber | The same cause as 44 at the other end of the night. Both beats are gated now, and nothing else is: roasting, assembling and working the machine are all *being at the campsite*, and the wind note landing while you tend a fire in that wind is the whole point of the remark system |
| 48 | **The assembly lantern floated ten centimetres above the table and over its edge.** Its own comment says "a lantern on the stump" | The group sat at `y = 0.09` with its base mesh another 0.02 above that, over a table top at `y = 0`, at a radius of 0.214 on a stump whose top radius is 0.2. In the assembly shot it hangs in the dark beside the table with nothing under it. No test could have caught this: nothing in the suite knows what rests on what |
| 49 | **A notice never went away.** `setNotice` has always taken `string \| null` and nothing ever passed null, so the first report of a session went up and stayed up, replaced only by the next one — a line about how the ground rises on three sides was still sitting over the SM-01 when the door opened ten minutes later | Found by noticing that *almost every screenshot in `artifacts/` has one camped on it*, which is what a whole-directory pass buys you that any single frame does not. It is an over-correction with a traceable history: the notice channel exists because reports used to go out as subtitles and vanished for anybody with subtitles off, and the fix for "it disappeared too fast" became "it never leaves". It now dwells at a reading speed — about twelve characters a second, floored at four seconds and capped at eleven — because these range from "Nothing left here worth carrying." to two lines of a campsite describing its own topography |
| 50 | **"Text size 16%".** The settings panel showed every slider's *position on its track* rather than its value. For a dial running 0..1 those are the same number, so five of the seven looked right and hid the two that did not: text size runs 0.85..1.8 and read **16%** at its own default, and fire brightness runs 0.35..1.5 and read 57% with the fire at exactly the brightness its author chose | A figure that is not a text size, shown to somebody who opened that screen *because the type was too small*. Fixed in the default formatter rather than by passing a `format` to the two offenders, so the next slider with a non-zero minimum does not arrive with the same bug. Every 0..1 dial is unchanged, which is why this survived so long |
| 51 | **"1 problem, all of them:"** in the live-ops console | "All of them" is the point of that line — the publish gate reports every failure rather than stopping at the first — and it does not survive a count of one. The clause is plural or it is absent |

And one near-miss worth writing down, because it is the same failure the
whole session has been about. `w3-walked.png` is a black rectangle: seventy
per cent of the frame is pure black and the ground the player stands on
renders at **0.58 out of 255** — a fifth of the floor `night.spec.ts` sets,
and worse than the four-to-seven that test was written to fix. I had it
written up as a defect before checking its date. It is from a session three
days earlier, no spec in the repository produces it, and
`artifacts/screenshots/` is gitignored — so it had sat there through every run
since, indistinguishable at a glance from the hundred and seventeen frames the
suite had just written.

The lesson is not about that frame. It is that a scratch directory which
accumulates across sessions will eventually be read as current by whoever
audits it, and auditing is precisely the activity that trusts it. Four stale
files removed. The check that caught it is two lines of `os.path.getmtime`
comparing every capture against the newest, and it is worth running first next
time.

Number 43 is the sharper of the two. A visual baseline compares whole frames at
a six to twelve per cent tolerance, and one UI panel moving under another is a
fraction of one per cent of the pixels — so the visual suite could not have
caught it, and the functional suite was asking the wrong question. "Is the text
right" and "can you read it" are different tests, and only one of them was
being run.


Two of these were caught by a test I nearly did not write. The eeriness gap
factor was applied twice — once when scheduling the next distant sound and
again on the countdown toward it — so the strangest campsite in the catalogue
spoke up roughly twice as often as intended. And the first attempt to test
*which* sound a strange place picks measured nothing of the kind: the fixture's
two sounds carry different `minGapSeconds`, so at a campsite that speaks up
often the sound with the long gap is usually still inside it, and frequency
decided the mix rather than the weights. The fixture now equalises the gaps and
the test measures what it says it measures.

---

### Session 7: what the runner's clock was measuring

The pull request went up with every suite green here and four of them red on
CI. None of the four was the product being wrong; all four were a test — or,
twice, the model itself — reading a clock it had no business reading. The
common root: the fixed-step clock caps catch-up at sixteen steps a frame
(`time.ts`), so on a software renderer drawing a frame every hundred and fifty
milliseconds, simulated time runs at roughly sixty per cent of wall time.
Anything that counts in wall-clock, or samples once a frame, measures the
renderer rather than the world.

| # | Found | Cause |
| --- | --- | --- |
| 53 | **The torch minded a raked beam less the slower the machine drawing it.** `activities` failed on CI with `torch.sweep` at 0.415 against a floor of 0.5, and passed here every time. | The beam's angular speed was read one fixed step at a time, and drag-to-look lands in the first step of a frame and is spent (`locomotion.ts`) — so on a renderer stepping four times a frame a smooth quarter-turn arrived as one jump and three steps of nothing, and the wildlife's alarm depended on the frame rate. `torch.ts` now averages the aim's movement over the last 0.3 s of steps, and a new test pins the same turn reading the same at one, four and sixteen steps a frame. A model fix, not a tolerance |
| 54 | **The roast loop was closing on the wrong clock.** `acceptance` failed with a mean brown of 0.297 against 0.3. | The loop turned the marshmallow for a fixed count of wall-clock iterations, so the same loop roasted for fewer fire-seconds on CI than here. It now reads the fire's own elapsed time and the mean brown, and stops on either the golden reading or a fire-second budget, logging fire-seconds against wall-seconds so the ratio is on the record |
| 55 | **"Camera still" was measured from outside, on a wall-clock interval.** `visual` failed on screenshots that would not settle, then on `assembled` alone by twelve per cent. | `waitForCameraStill` sampled the camera between round trips, which on a slow renderer compared two samples of the same frame and called that still. It now samples position, orientation and field of view on rendered frames inside the page, requires three consecutive still frames with no walk target, and says what it saw when it gives up. The `assembled` baseline had been captured before the walk to the machine had finished — the old wait could not see the difference — and was regenerated, never updated |
| 56 | **A constellation was recognised according to where the head happened to be, and what time it was.** `activities` failed on CI at 20:15 UTC with nothing recognised, and had passed at 19:23. | The test hook `lookAtSky` wrote an aim straight into the stargazing model, and the frame loop derives that aim from the player's facing and pitch on every step (`World.tsx`), so the hook's aim lasted exactly one frame. Whether anything was then recognised depended on whether a constellation lay within the field of wherever the reclined head was pointing — and the sky turns with the real clock, so the answer changed by the hour. `scene/skyAim.ts` now carries both directions of the head-to-sky conversion, the hook turns the head, and the test asserts that a frame later the model still looks where the head does before it holds |
| 57 | **The first browser at a shared fire never showed a frame in the time allowed.** `campfire` failed in the *first* `walkIn` of each two-browser test, at `awaitFrames`, while the third test — the same helper — passed every time. | Joined, socket live, `arrive` applied, and twenty seconds in which a wait polled on animation frames never saw the tick move. The first explanation written down here was shader compilation on the software renderer, twenty to thirty seconds of it, and it was wrong: once the wait was made to measure, CI reported the first page's first tick 1.6–3.3 s after joining and the second page's 3–16 s (it shares the runner with a page that is still drawing) — here, 2–2.5 s and 8–9 s. The page was ticking; the wait was not looking. Frame waits now poll on an interval rather than on animation frames, because a wait that itself needs a frame cannot report that frames are not running, and on failure they describe the page: visibility, whether an animation frame fires at all, whether the canvas exists, and where the shared timeline has got to. What is *not* established is why an animation-frame-polled wait in the first page of a fresh browser never re-evaluated; the diagnostic exists so that a recurrence answers it |
| 58 | **`npm run typecheck` — the command the workflow comment names as the local equivalent — was red at HEAD, and CI could not see it.** | CI runs `tsc -b`; the script also checks `test/integration`, where five `add-log` actions still carried the `placement` field removed when logs became things you place (`e9ba23c`). Vitest runs the file without typechecking, so the drift was invisible everywhere except the one command the comment says to run. Fixed. The same sweep found that `e2e/` is typechecked by nothing at all — recorded as S15 |
| 59 | **The first Pages deploy asked the account's root for its service.** Found by rendering the deployed bytes and recording every request: `/v1/auth/anonymous`, `/v1/codes/keys` and `/v1/content/manifest` went to `/` on `github.io`, not under `/Some-More-Cookies/` — defect 41 again, from the other side. | The workflow bakes `VITE_API_URL=""` into a build whose `api_url` input is left blank, and `""` is not `undefined`, so `import.meta.env.VITE_API_URL ?? defaultApiBaseUrl()` kept it. The `subpath` project could not see it because it built without the variable; it now builds exactly as the deploy does, and failed on the unfixed client before passing on the fixed one. `apiBaseUrlFrom` treats blank as unset, the workflow exports the variable only when there is one, and the run that found it is the first time this app was loaded from anywhere but this machine |
| 60 | **The draw-call budget warning would have thrown the first time draw calls went over budget.** `perf.spec.ts` built its message from `KNOWN_DEVIATIONS.drawCalls.status`, and there has never been a `drawCalls` entry in that table — only `dynamicLights`. | Found on the first day `e2e/` was typechecked (S15, now closed). The branch had never executed because draw calls have never exceeded the budget, which is exactly the moment the message exists for. It now looks the deviation up as something that may not exist, and says nothing when it does not |

Two of the six are model corrections that happened to be found by a slow
machine: the torch (53) and the sky aim (56) were both wrong on a phone in
exactly the way they were wrong on CI, and a fast desktop was hiding it. The
other four are the same lesson as defect 50, one level down — a wait that
measures the renderer is not a wait, it is a guess with a timeout on it. And
57 carries its own footnote: the first cause written for it was plausible,
confidently stated, and contradicted by the first number the fix produced.
That is the reason the fix prints the number.

---

## What the tools measured

Automated verification now produces numbers rather than a tick. The full
method, and what each tool can and cannot prove, is in
[`tools/README.md`](./tools/README.md).

| Budget (ARCHITECTURE §10) | Measured | Verdict |
| --- | --- | --- |
| Simulation step ≤ 1.5 ms | worst stage (roasting) **0.0156 ms mean, 0.093 ms p99** | ~96× inside |
| Retained heap growth | **0.264 B/step over 115,200 steps** (32 simulated minutes) | flat, no leak |
| ≤ 120 draw calls | **83 peak**, 78 at arrival | was 122; fixed by instancing the trees, rocks and woodpile |
| ≤ 60,000 triangles | 10,370 | 17 % |
| ≤ 24 MB textures | 1.61 MB | 7 % |
| ≤ 6 dynamic lights in the world, ≤ 10 in the anchored close-ups | 10 in reveal/eating | accepted, and the budget rewritten to say so |
| Audio: no clipping | **0 clipped samples across 25 sounds**, largest DC offset 0.0064 | pass |

Both breaches are now resolved rather than tolerated.

Draw calls crossed 120 the moment the campsite became explorable (148 → 175
objects at arrival) and reached 122 as the secondary activities landed. The
deviation entry named the fix and the fix was done: the trees, rocks and
woodpile are instanced, and the peak is **83**. The woodpile still picks its
wood by `instanceId`, so reaching for a particular log still means a particular
wood.

The light count was the finished sandwich's key/fill/rim rig, which exists
because without it the most important object in the product rendered as a
silhouette (defect #5). Rather than bake it away, §10's single figure was
replaced with a per-stage pair — ≤ 6 in the explorable world, ≤ 10 in the
anchored close-ups — because ten lights over a hundred visible triangles is
not the cost of ten lights over a forest. A lit torch would have been an
eleventh, so the simulation now stows the torch when a stage needs both hands.
You cannot hold a torch and a marshmallow, which makes it a product rule rather
than a render trick.

§10's claim of "zero per-frame allocation" was **not true** and is now
narrower: `stepRitual` was constructing a named `Rng` per subsystem per step.
The streams are cached and reseeded, and the tool reports transient churn as
an order of magnitude rather than asserting on it, because three defensible
sampling methods gave figures 30× apart for the same build. Retained growth is
what the budget stands behind.

The tools caught both of those regressions within minutes of the work that
caused them landing, which is the argument for having built them. They also
caught a third that no check would have failed on: the visual suite drives
roasting with the arrow keys, the explorable-campsite work briefly bound arrow
keys to walking, and three baselines were quietly becoming pictures of a
one-sided marshmallow while the pixel comparison passed happily against
baselines captured under the same broken driver. The suite now reads back
browning, char, rotation and one-sidedness on every run.

---

## Priorities and acceptance criteria

### P1 — Prove the magic
> boot → approach campsite → fire → roast → assemble → SM-01 → transform → reveal

| # | Work | Acceptance criteria | State |
| --- | --- | --- | --- |
| 1.1 | Deterministic sim core | Same seed + input timeline ⇒ identical sandwich, asserted by replay test. Fire, heat, roasting, assembly, machine, sandwich, eating all unit tested. | ✅ |
| 1.2 | PS1 render pipeline | Jitter, affine swim, ordered dither, low-res target, short fog — per-material, per-tier, each individually disableable. | ✅ |
| 1.3 | Procedural materials | Every surface textured from seeded runtime generators. No untextured grey. | ✅ |
| 1.4 | Arrival | The player walks toward a lit fire through the dark. Not a cutscene, not a menu. | ✅ |
| 1.5 | Fire tending | Fuel and raking change the simulated fire visibly and audibly; the ember bed is a distinct, better roasting surface. | ✅ |
| 1.6 | Roasting | One continuous drag controls distance and rotation. Per-patch browning is visible. Ignition and blow-out work. No timer, no button. | ✅ |
| 1.7 | Assembly | Each component placed freeform with magnetic assist; offsets/squish/crumbs persist to the final sandwich. | ✅ |
| 1.8 | SM-01 ritual | All stages operable, amber→blue, frost growth, mechanical audio sequence, vapour on open. | ✅ |
| 1.9 | Reveal | In-world reveal first; the sandwich renders at hero tier with its own local lighting. | ✅ |
| 1.10 | Eating | Bites remove real geometry from a chosen side, with crumbs, fracture and cold cues. | ✅ |
| 1.11 | Run + inspect | The whole loop is driven in Chromium under Playwright with a screenshot at each stage. | ✅ |

**P1 is done when** a person can walk to a fire, roast a marshmallow badly, make a lopsided s'more, run the machine, and want to eat the result — with no placeholder buttons anywhere in that path.

### P2 — Make it a place
Exploration · 10–12 environments · weather · audio · wildlife · photography · Passport · persistent campsite memory · mystery/radio.

Acceptance: 20+ concepts generated and scored, 10–12 selected and encoded as validated data; each has its own systemic personality; weather evolves in-session and affects roasting; the Passport is a scrapbook, not a grid; a campsite visibly remembers a previous visit.

### P3 — Make it shared
Avatars · multiplayer join/leave · shared interactions · persistent group campsites · spatial voice.

Acceptance: two clients share a campsite; joining is diegetic with no lobby; a roasting stick can be handed off without teleporting; privacy defaults to private; voice is spatial and never recorded by default.

### P4 — Connect digital and physical
Ordering · loyalty/rewards · CMS/live ops · event and QR architecture · physical/digital bridges.

Acceptance: MAKE THIS REAL appears only after the reveal; the fiction holds through the terminal until checkout; orders are idempotent; high-value rewards are server-validated.

---

## Known shortfalls in the current build

Recorded plainly, because a plan that only lists wins is not a plan.

| # | Shortfall | Why it matters | What it needs |
| --- | --- | --- | --- |
| S1 | **Two affordances are still HUD buttons.** Taking the marshmallow to the plate and taking the sandwich off the tray are screen buttons. The woodpile and the ember bed are now touched directly, and which log you reach for decides what wood goes on the fire. | The remaining two are transitions rather than manipulations, so they read less wrongly — but the spec's spirit is that you carry the marshmallow, not press "take". | Drag the roasting stick to the plate; pick the sandwich off the tray. Both buttons stay as an accessibility fallback for anyone who cannot drag. |
| S2 | **Never run on a touch device.** | Roasting is a two-axis drag; risk R7 is unresolved without a thumb on real glass. | A device lab, or at minimum a phone. |
| S3 | **Never profiled on real hardware.** | The 60 FPS target is unverified; SwiftShader here cannot answer it. | Real device profiling against the budgets in ARCHITECTURE §10. |
| S4 | ~~Multiplayer is architected, not built.~~ **Built.** RFC 6455 framing, handshake, rooms, authority hand-off with fencing, blocks and anti-grief, all with no new dependencies. Voice is behind a LiveKit adapter that reports "not configured" without credentials. Proximity mixing now applies `proximityGain` per track per frame, with the panner's own distance model turned off so the two curves cannot multiply. | — | Remaining: participant truth is in-process rather than read from a provider, because there is no provider and no WebRTC SDK in this build. `attach(accountId, stream)` is the seam it arrives through. |
| S5 | ~~Wildlife, radio, secrets and traces are data, not behaviour.~~ **Wired.** `stepRitual` steps all three every step; their cue field is derived from state that actually exists — the fire that is burning, the marshmallow that is browning, the compressor that is running. Animals render with eyeshine; the radio is an object you walk to and tune. | — | Remaining: a human has neither seen the animals nor heard the dial. |
| S6 | ~~The significance model is not wired to storage.~~ **Wired, and now synced.** Wildlife and discovery events become traces, and traces, resident visit counts and found secrets are folded into the Passport per campsite. The client pushes that memory to the service on join, every 30 seconds, and on `pagehide`, and merges what comes back — so losing the phone no longer loses every place that had met you. The significance score stays on the device: the protocol has nowhere to put one. | — | — |
| S8 | **The order terminal now reaches a real service, but no human has bought anything.** The whole sequence runs against the API in tests, including the payment intent and confirmation through the fake provider. | Nobody has typed a real address into it on a phone. | A person, and eventually a processor. |
| S9 | **Nothing has run on a real phone.** Every safe-area inset is zero in headless Chromium, so no test here has seen a real notch; `beforeinstallprompt` is dispatched by hand; no home-screen install, no launch image and no wake lock has ever been exercised; and there is no iOS anything — no macOS, no Safari, no simulator. | The three mobile defects found this session were found by *reasoning about* insets and painting them onto screenshots, not by measuring them. | A phone. `docs/HUMAN_TEST.md` §9b is written for exactly this. |
| S9b | ~~One visual baseline is stale, and one verification number is unmeasured.~~ **Closed.** Every one of the sixteen baselines was regenerated from scratch rather than updated — a tolerance wide enough to hide the fire's flicker is wide enough to hide a stale picture, and `roasted.png` was still showing the one-sided marshmallow from before the input fix while matching happily. `perf` was re-run serially on an idle machine: 83/120 draw calls, 10,370/60,000 triangles, 1.605/24 MB textures. | — | — |
| S10 | **The native shells are configured but not generated.** `apps/mobile/` has the Capacitor config, an asset generator that draws all 37 native icons from the same code as the favicon, and the argument in full — but no `ios/` or `android/`. | Generating them writes a Gradle wrapper JAR and placeholder PNGs, which ADR-0002 forbids, and nothing here could compile or run them. Committing two hundred files that have never been built is what §16 exists to prevent. | Developer accounts, and a machine with Xcode and the Android SDK. |
| S14 | **The night's arc does not reach the sky, and one line promises that it does.** `describeWindow('dawn')` says *"There is grey in the east. That went quickly."* The sky is a single flat `<color attach="background">` from the manifest's `nightPalette.zenith`, constant for the whole session — there is no gradient, so there is no east. Measured across the four windows at one campsite (per-channel median, stars excluded, so a drifting star field cannot fake a difference): zenith `(8,8,8) → (8,8,8) → (8,8,15) → (8,8,15)`, and the horizon band the same. The sky changes **once in four windows, and not at dawn**. | The arc itself works where it was built: the ground by the fire goes `(58,33,8) → (16,8,1) → (16,8,8) → (8,8,8)` as the fire dies through the night, and the cold, the prose and the fire model all follow it. It is only the sky that stands still — and note that at 5-bit quantisation anything under 8/255 snaps to zero (§4.1, D7), so a gradual warming of a few units would be eaten before it reached a pixel. | Either give the sky a horizon gradient that can carry a dawn (a real rendering feature on a deliberately flat PS1 sky, and an amplitude of at least 8/255 to clear the quantiser), or reword the beat so it does not promise a picture the renderer cannot draw. That is a design call rather than a correction, so it is recorded here rather than decided. |
| S15 | ~~`e2e/` is typechecked by nothing.~~ **Closed.** `e2e/tsconfig.json` is a `tsc -b` reference, so `npx tsc -b` — what CI runs — and `npm run typecheck` both cover the fifteen specs. The specs read `window.__someMore` through the one declaration the app makes (`apps/web/src/testHandle.ts`), which removed the thirty-seven `unknown` results at a stroke: they were the suite's own copy of the store type, not the app's. The three that were left were real: a bad cast in `helpers.ts`, actions typed as taking `never`, and one dormant bug (finding 60). | The first typecheck of the suite found a message that would have thrown at the one moment it existed for. | — |
| S7 | **Audio is unheard.** 102 tests cover its maths and scheduling; no human has listened to it. | The SM-01's mechanical narrative is carried by sound. | Someone with speakers. |

---

## Workstreams and dependencies

```
sim core ──┬──► render layer ──┬──► P1 ritual ──► run/inspect/improve
           │                   │
           ├──► content ───────┘
           │
audio ─────┘        protocol ──► api ──► commerce/rewards (P4)
```

`sim` blocks everything gameplay. `protocol`/`api` and `audio` are independent and run in parallel. `content` needs `sim` types only.

---

## Highest-risk questions

| # | Risk | Mitigation | Status |
| --- | --- | --- | --- |
| R1 | **Roasting may not feel good.** A thermal model can be correct and still be unsatisfying — the single biggest product risk. | Tuned against measured outcomes across the whole distance band, three times. Coals now give a wide window between golden and charred; open flame gives almost none. Still unvalidated by a human hand on a real screen. | partly open |
| R2 | **The transformation may not feel rewarding.** If the machine reads as a loading screen, the product fantasy collapses. | Built as specified: twelve operable stages, a 50 s standard run, real amber→blue lighting, growing frost, and a mechanical audio sequence. Reads well in stills; the pacing needs a human. | partly open |
| R3 | **The sandwich may not look delicious** at PS1 fidelity. | Took five passes against screenshots: local key/fill/rim lighting, warmer ice cream at both ends of the browning range, thicker chocolate, a darker cookie for contrast, and framing that turns away from the fire. Now legibly an ice cream sandwich. Appetite is a human judgement and remains the weakest-evidenced claim in this build. | partly open |
| R4 | **PS1 authenticity vs. appetite.** Dithering and low resolution can make food look unappetising. | Affine/jitter are per-material and dialled *down* on food; the fidelity bump is earned; accessibility controls double as art-direction dials. | open |
| R5 | **No assets, no artist.** | ADR-0002: everything procedural, behind swap-in interfaces. Aesthetically correct for PS1. | mitigated |
| R6 | **Determinism is load-bearing** for multiplayer and reward validation; a careless `Math.random` or wall-clock read silently breaks it. | Seeded splittable PRNG only; fixed timestep; replay tests assert identical outcomes. | mitigated by tests |
| R7 | **Mobile input for a two-axis roasting control** could be fiddly. | One continuous drag mapped to distance/rotation, unit tested for range, clamping and no-jump-on-touch; keyboard alternative and auto-rotation assist both work. **Never tested on a real touch device** — the most important untested claim here. | open |
| R8 | **60 FPS on 4–5-year-old phones.** | Rendering at 320×240 buys most of it; adaptive tiers with hysteresis are implemented and unit tested against synthetic frame times. **Never profiled on real hardware** — the SwiftShader environment here cannot answer this. | open |

---

## Blockers (external dependencies unavailable in this environment)

| Blocker | Blocks | Workaround in place |
| --- | --- | --- |
| No Stripe credentials | Live payments | `PaymentProvider` abstraction + fake provider; Stripe implementation structured against the real API. The client reads `paymentsConfigured` off `/v1/meta`, so the terminal starts taking payments the day keys are set, with no client change |
| ~~No PostgreSQL instance~~ | — | **Resolved.** A local cluster was started and the whole suite runs against it. The wire protocol client is hand-rolled over `node:net` (SCRAM-SHA-256, extended query protocol, pooling). One thing genuinely outstanding before a managed instance over the public internet: `sslmode=require` encrypts but does not verify a certificate chain |
| No object storage | Photo upload | Photo metadata modelled with storage keys; blobs held locally |
| No email provider | Magic-link login | `Mailer` interface with a console implementation |
| No WebRTC/LiveKit account | Spatial voice | Abstraction defined; panner path built so a `MediaStream` attaches later |
| No Apple/Google developer accounts | Store submission, native auth, Apple/Google Pay | **Installable PWA shipped instead**: manifest, procedurally generated icons and launch images, a service worker, and a proven cold offline boot to a finished sandwich (`e2e/offline.spec.ts`). Capacitor is configured in `apps/mobile/capacitor.config.ts` and its native assets are generated from the same code as the web icons; the `ios/` and `android/` projects are deliberately **not** generated or committed — see `apps/mobile/README.md` for the argument. Payment method types modelled in the domain |
| No art assets / no artist | Authored 3D content | ADR-0002 procedural generation behind swap-in interfaces |
| No real device lab | Touch validation, true device profiling, notch and safe-area behaviour | Touch input paths implemented and unit-tested; adaptive tiers implemented; `e2e/mobile.spec.ts` drives three real phone sizes in both orientations and screenshots them. **Headless Chromium resolves every `env(safe-area-inset-*)` to zero**, so that suite cannot measure whether a control clears a Dynamic Island — it checks instead that every edge-hugging control *asks* for the inset, and paints the bands on the screenshots for a person to look at. Real-device validation explicitly outstanding |
| No macOS, Xcode or iOS simulator | Generating, building or running the iOS shell | Configuration written and reviewable; nothing about the iOS project has been executed, and the README says so rather than implying otherwise |
| No Android SDK (a JDK 21 and Gradle 8.14 are present) | Generating, building or running the Android shell | As above. `apps/mobile/scripts/native-assets.mjs` *is* verified here, against a scratch directory |

**None of these block the Priority 1 experience.**

---

## Working agreements

- No feature is "complete" because it compiles (spec §16).
- No placeholder button may stand in for a tactile interaction, even temporarily.
- Simulation stays pure — no DOM, no Three.js, no wall clock, no unseeded randomness.
- Every content addition is data, never engine code.
- Update this document when state changes, not at the end.
