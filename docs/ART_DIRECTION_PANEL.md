# The art-direction panel, round five

Five rounds of critic grading, and for the fifth one the instrument
changed: three critics instead of one, identical briefs, the same 36
frames, no knowledge of each other or of the four previous rounds.

## The scores

| Round | Instrument | Score |
| ----- | ---------- | ----- |
| 1 | one critic | 6.1 |
| 2 | one critic | 6.4 |
| 3 | one critic | 6.5 |
| 4 | one critic | 6.2 |
| 5 | three critics | **6.5** median — 6.4, 6.5, 6.6 |

**The spread is the finding.** Three critics grading the same thirty-six
files on the same day disagree by 0.2. Four single-critic rounds, across
which a great deal of work landed, span 0.5 — 6.1 to 6.6, and not
monotonically. The round-to-round movement has been the same size as the
measurement noise the whole time, which means the four earlier numbers
were never really tracking the build. They were tracking who was looking.

So: the score has been flat at about 6.4 for four rounds, and one critic
cannot tell you otherwise. Panels, or nothing.

## What all three said

Convergence this strong is itself evidence. Named independently by all
three, in three different vocabularies:

1. **The ground.** All three named it the single highest-leverage change,
   unprompted, as their own answer to a question that did not suggest it.
   It is over half the pixels of every campsite frame and it is one
   continuous brown wash: no value structure, no wear, no zones, no
   change between five weather states and four hours. `hour-morning.png`
   carries narration promising ground "worn to bare soil in a ring around
   the fire and along the path to the creek"; the picture under it shows
   neither ring nor path.
2. **Snow does not accumulate.** Ground measured at RGB (39,23,16) in
   `weather-snow.png` against (36,19,10) in `weather-overcast.png`. Snow
   is an accumulation medium; here it is airborne specks and a HUD glyph.
3. **The weather states are one composition with a sky swap.** Same eye
   height, same yaw, same lens, same prop positions across all five.
4. **The treeline is one cone repeated.** Silhouette is the cheapest
   legibility tool at 426x240 and it is unused.
5. **The first-person hand is the least-designed object in the build and
   the largest thing on screen when it is there.**
6. **`ritual-machine-armed.png` is mostly void.** Measured at 75.5% of
   the frame below luminance 16.
7. **The HUD outbids the fire.** Chrome peaks at luminance 241 against
   the fire's 245-247 — and in `weather-snow.png` the fire peaks at 223,
   which makes the brightest thing in a game about a campfire an
   inventory chip.
8. **Phone portrait clips the fire off the bottom edge** and spends the
   top 60% on empty sky.
9. **The overlays are drawn at three times the world's resolution.** All
   three called them the best-designed objects in the package and all
   three said they belong to a different product.

And one capture bug, reported by all three and fixed in `0db2299`: the
contact strip named `motion-fire` contained no fire, so the flame's
motion had never been graded in five rounds.

## Where they disagreed

Only meaningfully in one place, and it is worth keeping. Two critics
praised the camera's settle after a whip-pan as a real second-order
spring; the third measured frame-to-frame registration in the same strip
at 7px, then 1px for the remaining six frames, and called the settle over
before the sheet begins. Both readings are of the same eight images. The
strip samples every 70 ms, which is probably too coarse to hold a settle
that fast — the instrument, again, rather than the thing.

## The sunset question

Put to all three blind, as an A/B with no indication of which ships:

**Unanimous: B, at both sunset and dawn.**

B is the authored `#d4703a`. A is the `#a8290b` ember red that actually
shipped, because a colour-space bug was compensated for by eye at the
horizon and the compensation was then approved. All three gave
substantially the same three reasons without having seen each other:

- The fire must own the most saturated red in the frame, and A puts a
  larger, hotter red across the upper third in the same hue family.
- The treeline exists only as a silhouette, so it exists only to the
  degree the sky behind it is brighter. Sky-band mean luminance measured
  at 44.5 (A) against 76.5 (B) at sunset.
- A reads apocalyptic. The brief is a place you would want to sit down in.

No change was needed: `#d4703a` is already in the tree. The panel
ratified the colour that was restored on structural grounds, which is the
cleanest outcome this question could have had.

## What is capping it

The ground, and it is not close.

It is the largest surface in almost every frame, it never changes, and
because it never changes every hour and every weather state is forced to
communicate through sky tint alone. That single fact is why five weather
frames read as one frame with a filter swapped, why the firelight falls
off a cliff instead of falling off into something, why the rocks read as
decals rather than as objects sitting in dirt, and why the fifty-five per
cent of each picture that the fire does not light is the weakest material
in the package.

Three critics arrived at it separately, from different complaints, and
each named it as the one change that buys the most. Until it is a place
rather than a surface, the score does not move — and four rounds of
evidence say it has not.
