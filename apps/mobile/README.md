# The native shell

Some More is a web application that installs. This directory is what turns it
into an App Store and Play Store binary as well, and an honest account of why
that has not happened yet.

**What is in version control here:** `capacitor.config.ts`, `package.json`,
`scripts/native-assets.mjs`, and this file. That is all of it.

**What is not:** the `ios/` and `android/` projects. They are generated.

---

## The state of it, plainly

| | Status |
| --- | --- |
| Web app manifest, icons, launch images | **Built and tested.** `apps/web/src/pwa`, `e2e/offline.spec.ts` |
| Service worker, offline boot, update path | **Built and tested.** `e2e/offline.spec.ts`, `e2e/pwa-update.spec.ts` |
| Installable from a browser, offline from a cold start | **Proven.** A Playwright run makes a whole s'more with the context offline |
| Capacitor configuration | **Written and reviewable.** Not executed |
| `ios/` project | **Not generated.** Requires macOS and Xcode; neither exists here |
| `android/` project | **Not generated.** Requires the Android SDK; a JDK and Gradle are present, the SDK is not |
| Store submission | **Blocked** on Apple and Google developer accounts |

Nothing below has been run. That is stated once, here, rather than implied by
a green checkmark somewhere.

---

## Why the generated projects are not committed

This is a judgement, not an oversight, and it is the sort that should be
argued rather than assumed.

**1. They are mostly binaries, and this repository has none.** `cap add
android` writes `gradle/wrapper/gradle-wrapper.jar`, five densities of
placeholder launcher PNG, and a splash bitmap. `cap add ios` writes an
`.xcassets` catalogue of PNGs. ADR-0002 says there are no binary assets in this
repository and that everything is generated from code. The launcher icons can
be — `scripts/native-assets.mjs` draws every one of them from the same
`icon.ts` the web build uses — but a Gradle wrapper JAR cannot. Committing the
generated trees would mean breaking a rule the whole art direction rests on,
for files nobody here can build.

**2. Nothing about them could be verified.** There is no macOS, no Xcode, no
Android SDK and no simulator in this environment. Committing two hundred files
of native project that has never been compiled, let alone launched, is exactly
what spec §16 forbids: *a feature is not complete because it compiles*, and
these would not even do that. A scaffold nobody can run is a liability that
looks like progress.

**3. Everything a native shell would buy is blocked on the same missing
thing.** App Store presence, Apple Pay and Google Pay (spec §11), Sign in with
Apple (§6.1), iOS push — all four need developer accounts that do not exist.
The shell would sit unused and drift out of date with every Capacitor release.

**4. The PWA already delivers the rest of it.** Installed to a home screen the
app is fullscreen, dark from the first frame, has its own launcher icon and
launch image, and boots and plays with no network at all. That is not a
consolation prize; for this product it is most of what a native wrapper is
for, because the ritual is entirely client-side by design
(ARCHITECTURE §1.5, §7).

**What Capacitor costs, and whether it is worth it.** As a *build-time* tool it
is cheap and the right choice: it hosts the same `apps/web/dist` unchanged, so
there is no second build and no second codebase, and `capacitor.config.ts` is
thirty lines. The rule this repository has is about *runtime* dependencies, and
a bare Capacitor shell adds one small bridge script and no npm package to the
web bundle. That balance flips the moment a plugin is added: every
`@capacitor/*` plugin is a real runtime dependency of the web app, and
`plugins: {}` in the config is empty on purpose. So: right tool, correct
trade — *and* premature to commit the output of, until there is a device to run
it on and an account to ship it to.

---

## When the accounts exist

From this directory, on a machine with the relevant SDK:

```bash
npm run build --workspace @somemore/web   # the shell both platforms host
npm run add:android                       # or add:ios, on macOS
npm run assets                            # redraws every icon from code
npm run open:android                      # or open:ios
```

`npm run sync` does the build, the copy and the assets in one go, and is what
runs before any release.

`@capacitor/cli` is pinned at `8.5.0` in the scripts and fetched by `npx` on
demand rather than being added to the repository's lockfile — so a `npm ci`
for the web app does not download an Android toolchain it will never use. When
the projects become real and CI builds them, that changes: pin
`@capacitor/cli`, `@capacitor/core`, `@capacitor/ios` and `@capacitor/android`
as devDependencies here, and add a `.gitignore` exception for the generated
sources that are actually ours (`AndroidManifest.xml`, `Info.plist`, the
Gradle config, the signing configuration) while leaving the template's binaries
regenerated.

---

## The assets

```bash
npm run assets:preview     # writes the whole tree to .preview/, to look at
```

`scripts/native-assets.mjs` draws thirty-seven files: Android launcher icons at
five densities, round variants, adaptive-icon foreground and background layers
with the `mipmap-anydpi-v26` XML that pairs them, portrait and landscape launch
images at four densities, the iOS 1024px app icon, and the iOS splash image
set — each with the catalogue metadata Xcode and Android read alongside them.

Every pixel comes from `apps/web/src/pwa/icon.ts`, rasterised on a 64-pixel
grid and upscaled with nearest-neighbour, which is the same thing the renderer
does to the world (ADR-0003). The launcher icon is the same campfire as the
favicon, because it is the same drawing.

One wrinkle worth knowing: the PNG encoder writes truecolour with no alpha, so
the adaptive-icon foreground layer is opaque and the background layer behind it
is never seen. It does not matter here — the layer behind it is the same night
— but it would matter if the icon ever wanted a transparent surround.

---

## What the shell must not become

The native app is the web app in a window. It hosts `apps/web/dist` byte for
byte, and a native release is by construction the web release. If something
ever needs to be true only in the native build, that is a product decision to
argue in `IMPLEMENTATION_PLAN.md` — not a plugin to install and a branch to
add.
