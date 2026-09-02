# Some More — human test script

**Who this is for:** a person with a phone, a laptop, headphones, and forty
minutes. Preferably at night, preferably not in a bright room.

**Why it exists:** the build has over a thousand automated tests and eight
categories of measured evidence, and none of them can answer the questions
that decide whether this product works. Those questions are all of the form
*"how did that feel?"*, and the only instrument for them is a person.

This script is deliberately not a QA checklist. Nothing here asks you to
verify that a button works. It asks you what you felt, and it asks in an
order designed to catch the feeling before you start rationalising it.

---

## 0. Before you start

### Running it

```bash
npm install
npm run build
npm run preview --workspace @somemore/web   # http://127.0.0.1:4173
```

On a phone, run the preview with `--host` and open the LAN address it prints:

```bash
npm run preview --workspace @somemore/web -- --host
```

**Know what this does and does not give you.** A `http://192.168.…` address is
not a secure context, and Chrome and Safari both withhold the whole service
worker API from one — `'serviceWorker' in navigator` is literally `false`, not
merely unavailable. Measured, not assumed. So over the LAN you get the game and
none of the install: no Add to Home Screen, no fullscreen, no launch image, no
offline. Nothing breaks — registration is guarded — but §9b cannot be tested
this way.

For the whole thing, put HTTPS in front of it. A tunnel is the least ceremony:

```bash
cloudflared tunnel --url http://localhost:4173     # or: ngrok http 4173
```

Open the `https://…` address on the phone. **iOS:** Safari only — Chrome on iOS
cannot install a web app — then Share → Add to Home Screen. **Android:** Chrome
offers it, or ⋮ → Install app.

Hosting it somewhere permanent instead works too, and needs no backend at all:
the ritual is local-first and the service is optional. Anywhere serving the
build at the **root** of an origin needs nothing special. For a **subdirectory**
— a GitHub project page at `https://<account>.github.io/Some-More-Cookies/` —
build with the base:

```bash
BASE_PATH=/Some-More-Cookies/ npm run build --workspace @somemore/web
```

That one variable decides the asset URLs, the manifest's identity and scope, the
service worker's scope and every entry in its precache list. `.github/workflows/pages.yml`
does it for you; it is manual-trigger only, because publishing is a decision.

Optionally, with the service running (`npm run api` in another terminal) the
Passport syncs and the order terminal reaches a real backend. Without it,
everything still works — the world is local-first and never waits on the
network. **Do the first run without the service.** If anything about the
campsite feels like it is waiting for something, that is a finding.

### Useful URLs

| URL | What it does |
| --- | --- |
| `/` | A campsite chosen for you |
| `/?camp=anything` | Pins a campsite — same seed, same SM-01, same residents, every time |
| `/?env=pine_hollow` | Pins an environment. The catalogue is in [`packages/content/CONCEPTS.md`](../packages/content/CONCEPTS.md) |

Use a **fresh** `?camp=` seed for your first run. Then use the *same* one for
run three, which is the visit that is supposed to feel like coming back.

### Ground rules

1. **Do not read the spec first.** If you know what is supposed to happen, you
   cannot tell us whether it happened.
2. **Write down the first word you think, not the considered one.** "Fiddly"
   written at the moment is worth more than a paragraph written afterwards.
3. **If you get stuck, stay stuck for a minute before looking for the answer.**
   Where you got stuck and for how long is the finding.
4. **Headphones.** The SM-01's whole narrative is carried by sound and nobody
   has listened to it yet.

---

## 1. Arrival (2 minutes)

Open it and do nothing for thirty seconds. Just look.

- What did you think this was, before you touched anything?
- Did you want to walk toward the fire, or did you have to be told?
- Is it cosy? Is it eerie? Is it *both*? Write down which came first.
- **It must never read as horror.** If you felt threatened rather than alone,
  stop and write down exactly what did it. That is the most important finding
  in this document.

Now walk in.

- Did the walk feel like arriving somewhere, or like a loading screen?

---

## 2. The fire (5 minutes)

Walk around. Look at things. Go to the woodpile, take a log, put it on the
fire. Rake the coals.

- Could you see well enough to move around? **Once the fire burns down to
  coals the campsite is lit only by the moon, and how dark that should be is
  a judgement nobody has made yet with human eyes.** Too dark to walk? Too
  bright to be night? Say which.
- Did the fire respond in a way that made sense, or did you feel like you were
  poking at something with rules you could not see?
- Did you *want* to sit down?

Then sit still, doing nothing, for two full minutes. This is not a trick.

- Was that boring, or was it pleasant? Both are useful answers.
- Did anything happen? Did you notice an animal? Did you hear one you never
  saw?

---

## 3. Roasting — the single biggest risk (10 minutes)

**Do this on a phone if you possibly can.** Roasting is a two-axis drag and
has never once been done with a thumb on real glass. This is risk R7 and R1
together, and they are the two most likely reasons this product fails.

Roast a marshmallow. Then roast another one and try to burn it. Then roast a
third and try to get it perfect.

For each one:

- Did you feel in control of the distance? Of the rotation? Of both at once?
- Was the difference between "over the flames" and "over the coals" something
  you could *feel*, or something you had to be told?
- When it browned unevenly, did you understand why?
- When it caught fire, was that a disaster or a story? **It is supposed to be
  a story.** If it felt like failing, that is a defect.
- Did you ever want a timer, a meter, or a "done" indicator? If yes: at what
  moment exactly?

Then, honestly: **did you want to eat it?**

---

## 4. Assembly (3 minutes)

Build the s'more by hand. Place the pieces badly on purpose at least once.

- Did the pieces feel like objects with weight, or like icons snapping to a
  grid?
- Did the assist help or did it fight you?
- When you placed something crooked, did it stay crooked? Did you *like* that?

---

## 5. The SM-01 (10 minutes)

Operate the machine. Read its panel. Look at its wear, its stickers, its
serial number. Try a different program on your second run.

- Does it read as a real appliance, or as a game object?
- Late-90s industrial refrigeration meets early-Y2K plastic meets restrained
  Rams minimalism — did any of that come across? What did it actually remind
  you of?
- **Watch the run with your eyes on the machine, not on a progress bar.**
  Amber for the hot phase, blue for the cold one. Did the transition land?
- **Time it.** A standard run is about fifty seconds. Was that too long? Too
  short? At what second did your attention start to wander?
- With headphones on: did the compressor, the relays, the latch and the frost
  crackle tell you what was happening without any text? **Nobody has heard
  this.** Anything that sounds wrong, thin, harsh, or like a video game rather
  than a machine is a finding.
- Did you ever feel like you were watching a loading screen? If yes, at what
  second?

---

## 6. The reveal (2 minutes)

- What did you say out loud, if anything?
- **Does the sandwich look like something you would eat?** This is risk R3 and
  it is the weakest-evidenced claim in the whole build. Be brutal.
- Does it look like *your* sandwich — like the thing you just made — or like a
  generic object that appeared?

Photograph it. Look at the photo.

- Is the photo something you would send to someone?

---

## 7. Eating, and the offer (3 minutes)

Take a bite. Take several. Finish it.

- Did biting feel like biting?
- Then — and only then — the terminal offers to make you a real one.
- **Did that offer feel like a natural end to the ritual, or like an
  advertisement?** If at any point before this moment you felt like you were
  being sold something, say exactly where.
- Would you have tapped it?

---

## 8. The Passport (2 minutes)

Open it.

- Does it read as a field journal, a campground booklet, a scrapbook, a
  disposable photo album, a memory card? Or does it read as a dashboard?
- Is there anything in it that looks like a score, a percentage, a completion
  meter, or an "X of Y"? **There must not be.** If you can find one, that is a
  defect regardless of how it got there.

---

## 9. Coming back (5 minutes)

Reload with the **same** `?camp=` seed you used at the start.

- Is it the same place? Do you recognise anything?
- Does the campsite behave as though it has met you before?
- Is that pleasant, or is it uncanny?

---

## 9b. Install it, then turn the network off (5 minutes)

This is the one section nothing automated can stand in for. Everything below
has been proven in a headless browser; none of it has been proven on a phone
you can hold.

Open it on a phone, and add it to your home screen (iOS: Share → Add to Home
Screen. Android: the browser will offer it, or the menu will).

- **Look at the icon on your home screen.** Every icon in this product is drawn
  in code — there is not a single image file in the repository — so this is the
  first time anyone will have seen them at the size they are actually used.
  Does it read as a campfire at that size, next to your other apps?
- Launch it from the home screen. **Watch the first half-second.** Is there a
  white flash before the campsite appears? There should not be, and a white
  flash on a dark app is the most jarring thing a phone can do.
- On iOS, look at the seam between the status bar and the sky. The colours are
  meant to match exactly. Do they?
- Now **turn on aeroplane mode** and launch it again, cold.
- Make a whole s'more. Arrive, tend the fire, roast, assemble, run the SM-01,
  eat it. All of it should work — the campsite is local-first by design and
  nothing in the ritual needs a network.
- Anything that hangs, spins, or says it cannot reach something is a defect.
  Note exactly where.
- Turn the network back on. Does the Passport still have your sandwich?

Then, if you have a second phone or a tablet, try it at a couple of sizes and
in landscape. Specifically look for anything under the notch, under the home
indicator, or clipped at an edge — the automated checks reason about safe-area
insets, but a headless browser reports every inset as zero, so no test here has
ever seen a real one.

---

## 10. The radio (optional, 5 minutes)

Walk to the log by the fire and pick up the radio. Tune it by ear.

- Could you find a station without looking at the numbers?
- Was tuning satisfying or fiddly?
- Is the hiss between stations pleasant enough to leave on?
- Would you leave it playing while you did something else? That is the bar.

---

## 11. Put the mouse down (5 minutes)

Do a whole s'more without touching the pointer, trackpad or touchscreen once —
walk in, tend the fire, roast, assemble, run the SM-01, take it out and eat it.

**Do not read the key list first.** Open Settings, where every key is written
down under "Keys", only when you get stuck — and when you do, tell us what you
were stuck on. That is the measurement: the guidance line follows whatever you
last used, so once you are playing on the keys it should be naming keys, and
anything you still had to look up is somewhere it failed to.

The short version, for when you have finished: `W`/`A`/`S`/`D` or the arrows
walk, `E` reaches for what is in front of you, the arrows move and turn the
marshmallow, `B` blows it out, `L`/`D`/`X` and `1`/`2`/`3`/`Enter`/`P` work the
SM-01, and everything in the corners of the screen is a real button you can
reach with Tab.

This is the alternate control scheme (spec §12) and it is a real path, not a
fallback — so it should feel like a way of playing rather than a way of coping.

- Did you ever have to guess a key? The guidance line follows whatever you last
  used and should have named the keys for you. If it told you to drag something
  after you had been playing on the keys, that is a bug — say where.
- Roasting is the one that matters. Could you get it golden with the arrows,
  and did each press feel like it landed?
- Was there anything you simply could not reach without a pointer? Anything at
  all counts, including a button you could not tab to.
- If you use a screen reader, keyboard or switch access normally, please ignore
  the key list above and tell us what you actually reached for. Where we have
  guessed wrong is more useful to us than where we have guessed right.

---

## What we most want to know

In priority order, because a report that says everything is fine is a report
that says nothing:

1. **Does roasting feel good with a thumb, on glass?** (R1, R7)
2. **Do you want to eat the sandwich?** (R3)
3. **Does the machine feel like a ritual or a loading bar?** (R2)
4. **Does it hold 60 fps on your phone, and does it get hot?** (R8)
5. **Does the audio sound like a machine, or like a game?** (S7)
6. **Is the night navigable?** (new in this build, tuned against measurements
   rather than eyes)
7. **Does it survive a phone?** Installed, offline, rotated, and at a size
   nothing here has ever rendered at for real.
8. **Did you ever feel sold to before the reveal?**
9. **Did it ever feel like horror rather than solitude?**

---

## Reporting

For each finding, three lines is enough:

```
WHERE   roasting, about 40 seconds in, on iPhone
WHAT    couldn't tell if I was turning it or moving it closer
FELT    frustrating — gave up and just held it still
```

`FELT` is the line that matters. We can find the code from the other two.

Send findings to [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md) — every
one becomes a row in "What looking at the running product found", which is
where this build's ten most valuable defects already live.
