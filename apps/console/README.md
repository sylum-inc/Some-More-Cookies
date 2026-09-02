# `@somemore/console` — live ops

The internal screen for the person who schedules a meteor-shower weekend.

Everything it does, the service could already do; `services/api/README.md`
called that Blocker 15 and said, correctly, that `curl` is fine for an engineer
and not fine at 2am before a launch weekend. This is that screen.

```bash
npm run dev --workspace @somemore/console      # http://127.0.0.1:5174
npm run build --workspace @somemore/console
npm run preview --workspace @somemore/console  # http://127.0.0.1:4174
```

Then, in the service:

```bash
LIVE_OPS_TOKEN=… CORS_ALLOWED_ORIGINS=http://127.0.0.1:4174 npm run api
```

---

## Why it is a second app

It lives here rather than behind a flag in `apps/web/`, for three reasons in
order of how much they matter.

1. **A staff capability must not ship to players.** A route inside the player
   build ships the console's code, its route table and its shape to every
   phone, whether or not anything makes it reachable. "Inert without a token"
   is a runtime property; not being in the bundle is a build property, and only
   one of those survives somebody reading the JavaScript. `e2e/console.spec.ts`
   asserts it directly: no script the player's origin serves contains
   `x-somemore-ops-token`, `/v1/live-ops/` or `LIVE_OPS_TOKEN`.
2. **The ops token must never be in a player build.** In one app the obvious
   mistake is one `VITE_LIVE_OPS_TOKEN` away, and a `VITE_` variable is a
   string in a static asset that gets served, cached and copied. There is no
   such variable here at all — look in `vite.config.ts`; the absence is the
   point. The token is typed in by a person and held in `sessionStorage` for
   the length of a tab, so it does not outlive the laptop being closed.
3. **They are different products.** The campfire is warm paper and stamped ink
   (spec §6.2). This is a terminal that has to show a hundred documents, a
   dotted validation path and a release number in the small hours. Sharing a
   visual language would make both worse.

The cost is a second deployment target. That is the right trade: it goes
behind whatever the operator network is, and a player never receives a byte of
it.

## Who may do what

Every action is gated by a named capability the signed-in account holds —
`content:draft` to write, `content:publish` to put something in front of
players, `codes:mint` to press a print run — and the screen reads them from
`/v1/operators/me` at boot. The separation this used to lack is the visible
part: an account granted `content:draft` gets a live editor and a dark
**Create run** button, rather than an enabled button and a 403 after the click.

This replaces the previous arrangement, where every action needed a bearer
token **and** the shared `LIVE_OPS_TOKEN`, with no roles, no per-person
revocation, and no separation between "may draft" and "may mint 100,000 codes".
That was `services/api` Blocker 9, and it is closed.

`LIVE_OPS_TOKEN` still has exactly one job here. On a deployment where nobody
is an operator yet, signing in with the bootstrap token in the credentials
panel appoints that account as the first administrator; from then on the string
is spent and the console works entirely on granted capabilities. An operator
who was granted their capabilities by somebody else never needs it, and the
banner no longer tells them to go and find one.

Against a dev service there is nothing to sign into, so **Sign in** bootstraps
an ordinary anonymous account. It is labelled as the stopgap it is.

## What is on the screen, and why

**A standing configuration banner, never a toast.** What this tab may do is a
*property*, not an event. The banner names the capabilities the signed-in
account holds, or says plainly that it holds none and who to ask — and the
authoring controls are disabled to match, rather than firing requests that
cannot succeed. An account without permission must never read as a broken
deployment.

**Every validation issue at once, as the dotted path it came as.**
`pine_hollow.secrets[2].rarity` is precise enough to point at one line in the
editor, so it is shown verbatim and monospaced, next to the editor, and never
summarised into "3 problems". **Validate** is a dry run of the identical gate
publishing uses and stores nothing.

**"What a phone gets".** The manifest, exactly as `GET /v1/content/manifest`
serves it, with `active` as the *server's* answer against the service clock —
which is what makes "watch a window open" a thing you can actually do. When the
browser's own clock disagrees with the server about a window, the row says so,
because knowing your laptop's clock is wrong at 2am is worth a line of code.

**Releases, append-only.** A rollback does not rewind; it publishes an earlier
release's bodies as a *new* release, and the table says which one each
reproduces.

**Minting says the response is the only copy.** The service never stores codes
(ADR-0008), so a lost print file is a reprint. That sentence is on the screen
next to the codes, because it is a thing an operator has to know *before* they
close the tab.

## Two defects this screen found by being looked at

- **The manifest panel showed release 0 while the banner said release 1 was
  live.** The manifest is served `public, max-age=60`, which is right for a
  player's phone and wrong for the person who just pressed publish. Every read
  here is now `cache: 'no-store'`; the service's cache header is unchanged.
- **The service had no CORS at all.** A browser client on another origin could
  not talk to it — which no test had noticed, because every test until now was
  either same-origin or `fetch` from node. `CORS_ALLOWED_ORIGINS` is the fix,
  and error responses carry the headers too: without that, "LIVE_OPS_TOKEN is
  not set" reaches an operator as an opaque network failure.

## Constraints it keeps

No new runtime dependencies — React and the shared protocol package, and
nothing else. TypeScript strict with `noUncheckedIndexedAccess` and
`verbatimModuleSyntax`. Every response is parsed by the same zod schema the
service produced it from, so a drift between the two is a type error rather
than a blank table.
