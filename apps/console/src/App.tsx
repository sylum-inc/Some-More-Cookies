/**
 * The live-ops console.
 *
 * What a person actually does here, in the order they do it on a launch night:
 *
 *   connect → check the service can author at all → write a document →
 *   validate it → stage it → publish it → watch the window open in the
 *   manifest → roll it back when it turns out to be wrong.
 *
 * And, separately: open a print run, mint it, retire it when a pallet ends up
 * on eBay.
 *
 * Three things this screen refuses to do:
 *
 *  - **Look broken when it is not.** An account that holds no operator
 *    capabilities, or a subsystem with no credentials, is a fact about the
 *    deployment rather than a failure. Both are rendered as a standing banner
 *    that says what is missing and what still works, and every control the
 *    account may not use is disabled rather than firing a request that cannot
 *    succeed.
 *  - **Hide a validation error.** Issues come back as dotted paths
 *    (`pine_hollow.secrets[2].rarity`) and appear beside the editor, all of
 *    them at once, because the point of a CMS is that a person can fix the
 *    document rather than play whack-a-mole.
 *  - **Pretend a mint can be recovered.** The service never stores codes; the
 *    response is the only copy. That sentence is on the screen next to them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ContentKindValues,
  isWindowOpen,
  type CodeBatch,
  type ContentDocument,
  type ContentKind,
  type ContentManifest,
  type ContentRelease,
  type ContentStatus,
  type MintCodesResult,
} from '@somemore/protocol';
import {
  NEXT_STATUS,
  OpsClient,
  TEMPLATES,
  forgetCredentials,
  loadCredentials,
  saveCredentials,
  type Credentials,
  type OpsFailure,
} from './ops.js';
import { C, MONO, STATUS_COLOUR } from './theme.js';

type Tab = 'content' | 'releases' | 'codes';

interface Banner {
  tone: 'ok' | 'warn' | 'bad';
  text: string;
  /** Dotted paths from the publish gate, when there are any. */
  issues?: { path: string; message: string }[];
}

function bannerFor(failure: OpsFailure): Banner {
  if (failure.kind === 'invalid') {
    return { tone: 'bad', text: failure.message, issues: failure.issues };
  }
  if (failure.kind === 'not_configured') return { tone: 'warn', text: failure.message };
  return { tone: 'bad', text: failure.message };
}

export function App(): React.ReactElement {
  const [credentials, setCredentials] = useState<Credentials>(() => loadCredentials());
  const client = useMemo(() => new OpsClient(credentials), []);
  useEffect(() => {
    client.update(credentials);
    saveCredentials(credentials);
  }, [client, credentials]);

  const [tab, setTab] = useState<Tab>('content');
  const [banner, setBanner] = useState<Banner | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Whether this deployment can author at all.
   *
   * `null` means "not asked yet"; the two configured states are the service's
   * own words. Nothing on this screen guesses.
   */
  const [authoring, setAuthoring] = useState<
    null | { ready: true; releaseVersion: number } | { ready: false; reason: string }
  >(null);
  const [signing, setSigning] = useState<
    null | { ready: true; keyIds: string[]; canMint: boolean } | { ready: false; reason: string }
  >(null);

  const [documents, setDocuments] = useState<ContentDocument[]>([]);
  const [releases, setReleases] = useState<ContentRelease[]>([]);
  const [batches, setBatches] = useState<CodeBatch[]>([]);
  const [manifest, setManifest] = useState<ContentManifest | null>(null);

  /**
   * What this account may actually do (README, Blocker 9).
   *
   * Empty until asked, and empty for an ordinary player. Every authoring
   * control on this screen is disabled from this set rather than from the
   * presence of a secret, which is the whole point of the change: the console
   * shows an operator the surfaces they hold and greys out the rest, instead of
   * offering everything to whoever pasted the right string.
   */
  const [capabilities, setCapabilities] = useState<ReadonlySet<string>>(new Set());

  const connected = credentials.bearer.length > 0;
  /**
   * The bootstrap token deliberately does not appear here.
   *
   * Before Blocker 9 it did, and after Blocker 9 that was wrong in both
   * directions: an operator holding real capabilities but no bootstrap string
   * saw every control greyed out, and anybody holding the spent string saw
   * every control live and learned it meant nothing only when the service said
   * 403. The service checks a capability, so this checks the same capability.
   */
  const can = useCallback(
    (capability: string): boolean => connected && capabilities.has(capability),
    [capabilities, connected],
  );

  const run = useCallback(
    async <T,>(action: () => Promise<{ ok: true; value: T } | { ok: false; error: OpsFailure }>): Promise<T | null> => {
      setBusy(true);
      try {
        const result = await action();
        if (!result.ok) {
          setBanner(bannerFor(result.error));
          return null;
        }
        return result.value;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const refreshStatus = useCallback(async () => {
    if (!connected) return;
    const status = await client.status();
    if (!status.ok) {
      // `/v1/live-ops/status` needs only a bearer token, so a failure here is a
      // connection or a token problem, not a missing ops secret.
      setBanner(bannerFor(status.error));
      setAuthoring(null);
      return;
    }
    setAuthoring(
      status.value.liveOps.status === 'ready'
        ? { ready: true, releaseVersion: status.value.liveOps.releaseVersion }
        : { ready: false, reason: status.value.liveOps.reason },
    );
    setSigning(
      status.value.codes.status === 'ready'
        ? { ready: true, keyIds: [...status.value.codes.keyIds], canMint: status.value.codes.canMint }
        : { ready: false, reason: status.value.codes.reason },
    );
  }, [client, connected]);

  const refreshAll = useCallback(async () => {
    await refreshStatus();
    // The manifest is public, so it works even before anybody signs in — which
    // is useful: "what would a player's phone get right now" is the question
    // this whole console exists to answer.
    const live = await client.manifest();
    if (live.ok) setManifest(live.value);
    // An account, or none of the rest can succeed. Asking anyway would only
    // fill the service's log with 401s an operator did nothing to cause.
    if (!connected) return;
    const held = await client.capabilities();
    const may = new Set(held.ok ? held.value.capabilities : []);
    setCapabilities(may);
    // And each list only if this account may read it, for the same reason: a
    // 403 an operator cannot act on is noise in somebody's log, not feedback.
    if (may.has('content:draft')) {
      const docs = await client.listDocuments();
      if (docs.ok) setDocuments(docs.value);
    }
    if (may.has('content:publish')) {
      const rels = await client.listReleases();
      if (rels.ok) setReleases(rels.value);
    }
    if (may.has('codes:mint')) {
      const runs = await client.listBatches();
      if (runs.ok) setBatches(runs.value);
    }
  }, [client, connected, refreshStatus]);

  useEffect(() => {
    void refreshAll();
    // Only on mount and when credentials change; everything else refreshes on
    // the action that changed it, so the screen never lies about what is live.
  }, [refreshAll]);

  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <Header
        credentials={credentials}
        onChange={setCredentials}
        onSignIn={async () => {
          const session = await run(() => client.signInAnonymously());
          if (!session) return;
          setCredentials((current) => ({ ...current, bearer: session.token }));

          /*
           * Spend the bootstrap token, once (README, Blocker 9).
           *
           * It used to be the permission itself: every authoring call carried
           * it, and holding the string was holding the power. Now it can make
           * the first operator on a deployment that has none, and nothing else
           * — so signing in appoints this account if nobody has been appointed,
           * and from then on the console works on capabilities that can be
           * revoked from one person.
           *
           * A refusal here is not an error to show: on a deployment that
           * already has an operator it means somebody else has to grant you,
           * which the capability check will say plainly at the first action.
           */
          const signedIn = new OpsClient({ ...credentials, bearer: session.token });
          const held = await signedIn.capabilities();
          if (held.ok && held.value.capabilities.length === 0) {
            await signedIn.appointSelf(session.accountId);
          }
        }}
        onForget={() => {
          forgetCredentials();
          setCredentials({ ...credentials, bearer: '', opsToken: '' });
          setAuthoring(null);
          setDocuments([]);
        }}
        onRefresh={() => void refreshAll()}
        busy={busy}
      />

      <ConfigurationBanner authoring={authoring} signing={signing} connected={connected} capabilities={capabilities} />

      {banner !== null && <BannerStrip banner={banner} onDismiss={() => setBanner(null)} />}

      <nav
        style={{
          display: 'flex',
          gap: 2,
          padding: '0 20px',
          borderBottom: `1px solid ${C.panelEdge}`,
          background: C.panel,
        }}
      >
        {(['content', 'releases', 'codes'] as const).map((name) => (
          <button
            key={name}
            data-testid={`tab-${name}`}
            onClick={() => setTab(name)}
            style={{
              background: 'transparent',
              border: 'none',
              borderBottom: `2px solid ${tab === name ? C.accent : 'transparent'}`,
              color: tab === name ? C.text : C.textSoft,
              padding: '11px 14px',
              fontSize: 12,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            {name}
          </button>
        ))}
      </nav>

      <main style={{ flex: 1, padding: 20, display: 'grid', gap: 20 }}>
        {tab === 'content' && (
          <ContentTab
            client={client}
            documents={documents}
            manifest={manifest}
            canDraft={can('content:draft')}
            canPublish={can('content:publish')}
            run={run}
            onChanged={() => void refreshAll()}
            setBanner={setBanner}
          />
        )}
        {tab === 'releases' && (
          <ReleasesTab
            client={client}
            releases={releases}
            manifest={manifest}
            canPublish={can('content:publish')}
            run={run}
            onChanged={() => void refreshAll()}
            setBanner={setBanner}
          />
        )}
        {tab === 'codes' && (
          <CodesTab
            client={client}
            batches={batches}
            signing={signing}
            canMintCodes={can('codes:mint')}
            run={run}
            onChanged={() => void refreshAll()}
            setBanner={setBanner}
          />
        )}
      </main>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Chrome                                                                      */
/* -------------------------------------------------------------------------- */

function Header({
  credentials,
  onChange,
  onSignIn,
  onForget,
  onRefresh,
  busy,
}: {
  credentials: Credentials;
  onChange: (next: Credentials) => void;
  onSignIn: () => void;
  onForget: () => void;
  onRefresh: () => void;
  busy: boolean;
}): React.ReactElement {
  return (
    <header
      style={{
        background: C.panel,
        borderBottom: `1px solid ${C.panelEdge}`,
        padding: '12px 20px',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        gap: 16,
        alignItems: 'end',
      }}
    >
      <div>
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.28em', color: C.textFaint }}>
          SOME MORE
        </div>
        <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '0.01em' }}>Live Ops</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr', gap: 10 }}>
        <Field label="Service">
          <input
            data-testid="cred-base-url"
            value={credentials.baseUrl}
            onChange={(event) => onChange({ ...credentials, baseUrl: event.target.value })}
            spellCheck={false}
          />
        </Field>
        <Field label="Bearer token">
          <input
            data-testid="cred-bearer"
            type="password"
            value={credentials.bearer}
            placeholder="sign in, or paste one"
            onChange={(event) => onChange({ ...credentials, bearer: event.target.value })}
            spellCheck={false}
          />
        </Field>
        {/* Needed once per deployment, to appoint its first operator. */}
        <Field label="Bootstrap token">
          <input
            data-testid="cred-ops"
            type="password"
            value={credentials.opsToken}
            placeholder="LIVE_OPS_TOKEN (first operator only)"
            onChange={(event) => onChange({ ...credentials, opsToken: event.target.value })}
            spellCheck={false}
          />
        </Field>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <Button data-testid="sign-in" onClick={onSignIn} disabled={busy}>
          Sign in
        </Button>
        <Button data-testid="refresh" onClick={onRefresh} disabled={busy}>
          Refresh
        </Button>
        <Button onClick={onForget} tone="quiet">
          Forget
        </Button>
      </div>
    </header>
  );
}

/**
 * The standing truth about this deployment.
 *
 * Always visible, never a toast: whether authoring is possible is not an event,
 * it is a property, and an operator who scrolled past a toast should not have
 * to guess why the publish button is grey.
 */
/**
 * What this tab can do, in the service's own words (README, Blocker 9).
 *
 * This used to report on a secret: no ops token meant "paste LIVE_OPS_TOKEN".
 * That is the wrong advice for the ordinary case now — an operator who was
 * granted capabilities by an admin never sees the bootstrap string and should
 * never be told to go looking for one. So the banner names the capabilities
 * this account actually holds, and mentions the bootstrap only in the one
 * situation where it is still the answer: a deployment that has no operators
 * at all, where somebody has to be first.
 */
function ConfigurationBanner({
  authoring,
  signing,
  connected,
  capabilities,
}: {
  authoring: null | { ready: true; releaseVersion: number } | { ready: false; reason: string };
  signing: null | { ready: true; keyIds: string[]; canMint: boolean } | { ready: false; reason: string };
  connected: boolean;
  capabilities: ReadonlySet<string>;
}): React.ReactElement {
  const lines: { tone: Banner['tone']; text: string }[] = [];

  if (!connected) {
    lines.push({ tone: 'warn', text: 'Not signed in. Sign in, or paste a bearer token, to read anything but the manifest.' });
  } else if (authoring === null) {
    lines.push({ tone: 'warn', text: 'Have not asked the service about itself yet.' });
  } else if (!authoring.ready) {
    lines.push({ tone: 'warn', text: authoring.reason });
  } else if (capabilities.size === 0) {
    lines.push({
      tone: 'warn',
      text:
        `The service is up (release ${authoring.releaseVersion}), but this account holds no operator ` +
        'capabilities, so everything below is read-only. Ask an operator to grant them — or, if this ' +
        'deployment has no operators at all yet, paste LIVE_OPS_TOKEN above and sign in again to ' +
        'appoint yourself as the first one.',
    });
  } else {
    lines.push({
      tone: 'ok',
      text: `Authoring as ${[...capabilities].sort().join(', ')} · release ${authoring.releaseVersion} is live.`,
    });
  }

  if (signing !== null) {
    lines.push(
      signing.ready
        ? {
            tone: 'ok',
            text: `Code signing: ${signing.keyIds.join(', ')}${signing.canMint ? ' · can mint' : ' · verify only, no private key'}.`,
          }
        : { tone: 'warn', text: signing.reason },
    );
  }

  return (
    <div data-testid="configuration-banner" style={{ padding: '10px 20px', display: 'grid', gap: 6 }}>
      {lines.map((line) => (
        <div
          key={line.text}
          style={{
            fontSize: 12.5,
            color: line.tone === 'ok' ? C.textSoft : C.accent,
            borderLeft: `3px solid ${line.tone === 'ok' ? C.live : C.accent}`,
            paddingLeft: 10,
            lineHeight: 1.5,
          }}
        >
          {line.text}
        </div>
      ))}
    </div>
  );
}

function BannerStrip({ banner, onDismiss }: { banner: Banner; onDismiss: () => void }): React.ReactElement {
  const colour = banner.tone === 'ok' ? C.live : banner.tone === 'warn' ? C.accent : C.danger;
  return (
    <div
      data-testid="banner"
      style={{
        margin: '0 20px 4px',
        padding: 12,
        border: `1px solid ${colour}`,
        borderRadius: 4,
        background: 'rgba(0,0,0,0.25)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <strong style={{ color: colour, fontSize: 13 }}>{banner.text}</strong>
        <button onClick={onDismiss} style={{ background: 'none', border: 'none', color: C.textFaint }}>
          ×
        </button>
      </div>
      {banner.issues !== undefined && banner.issues.length > 0 && <IssueList issues={banner.issues} />}
    </div>
  );
}

/**
 * The dotted paths, verbatim.
 *
 * `pine_hollow.secrets[2].rarity` is precise enough to point at one line in the
 * editor, so it is shown as it came, monospaced, and never summarised into "3
 * problems".
 */
function IssueList({ issues }: { issues: { path: string; message: string }[] }): React.ReactElement {
  return (
    <ul data-testid="issues" style={{ margin: '10px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 5 }}>
      {issues.map((issue, index) => (
        <li key={`${issue.path}-${index}`} style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          <code style={{ color: C.accent }}>{issue.path}</code>
          <span style={{ color: C.textSoft }}> — {issue.message}</span>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/* Content                                                                     */
/* -------------------------------------------------------------------------- */

interface TabProps {
  client: OpsClient;
  run: <T>(action: () => Promise<{ ok: true; value: T } | { ok: false; error: OpsFailure }>) => Promise<T | null>;
  onChanged: () => void;
  setBanner: (banner: Banner | null) => void;
}

function ContentTab({
  client,
  documents,
  manifest,
  canDraft,
  canPublish,
  run,
  onChanged,
  setBanner,
}: TabProps & {
  documents: ContentDocument[];
  manifest: ContentManifest | null;
  canDraft: boolean;
  canPublish: boolean;
}): React.ReactElement {
  const [kind, setKind] = useState<ContentKind>('seasonal_event');
  const [slug, setSlug] = useState('perseids_weekend');
  const [title, setTitle] = useState('Perseids Weekend');
  const [body, setBody] = useState(TEMPLATES.seasonal_event);
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [notes, setNotes] = useState('');
  const [issues, setIssues] = useState<{ path: string; message: string }[] | null>(null);
  const [valid, setValid] = useState<boolean | null>(null);

  const parsed = useMemo((): { ok: true; value: unknown } | { ok: false; message: string } => {
    try {
      return { ok: true, value: JSON.parse(body) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'not JSON' };
    }
  }, [body]);

  const chooseKind = (next: ContentKind): void => {
    setKind(next);
    setBody(TEMPLATES[next]);
    setValid(null);
    setIssues(null);
    try {
      const template = JSON.parse(TEMPLATES[next]) as Record<string, unknown>;
      // `reward_definition` is addressed by `code`; everything else by `id`.
      const identifier = next === 'reward_definition' ? template['code'] : template['id'];
      if (typeof identifier === 'string') setSlug(identifier);
      const name = template['name'];
      if (typeof name === 'string') setTitle(name);
    } catch {
      /* the templates parse; this is belt and braces */
    }
  };

  const activation = (): { startsAt: string | null; endsAt: string | null } | null =>
    startsAt.length === 0 && endsAt.length === 0
      ? null
      : {
          startsAt: startsAt.length === 0 ? null : new Date(startsAt).toISOString(),
          endsAt: endsAt.length === 0 ? null : new Date(endsAt).toISOString(),
        };

  return (
    <>
      <Panel
        title="Author"
        subtitle="Validation is a dry run of the same gate publishing uses. Nothing is stored."
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
          <Field label="Kind">
            <select data-testid="doc-kind" value={kind} onChange={(event) => chooseKind(event.target.value as ContentKind)}>
              {ContentKindValues.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Slug">
            <input data-testid="doc-slug" value={slug} onChange={(event) => setSlug(event.target.value)} spellCheck={false} />
          </Field>
          <Field label="Title">
            <input data-testid="doc-title" value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 12, marginBottom: 12 }}>
          <Field label="Window opens (local)" hint="Blank means live as soon as it is published.">
            <input
              data-testid="doc-starts"
              type="datetime-local"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
            />
          </Field>
          <Field label="Window closes (local)" hint="Half-open: the event is over at this instant.">
            <input
              data-testid="doc-ends"
              type="datetime-local"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
            />
          </Field>
          <Field label="Note" hint="Goes in the audit trail, not to players.">
            <input value={notes} onChange={(event) => setNotes(event.target.value)} />
          </Field>
        </div>

        <Field label="Body">
          <textarea
            data-testid="doc-body"
            rows={16}
            value={body}
            spellCheck={false}
            onChange={(event) => {
              setBody(event.target.value);
              setValid(null);
              setIssues(null);
            }}
          />
        </Field>

        {!parsed.ok && (
          <p style={{ color: C.danger, fontSize: 12.5, margin: '8px 0 0' }}>
            Not valid JSON yet — {parsed.message}
          </p>
        )}

        {/*
          The typo that costs the most time at 2am.

          A document is addressed by its slug, and its body has to agree —
          `id` for content, `code` for a reward. The service catches it and
          says so with a dotted path, but it catches it at *publish*, which is
          three clicks and one adrenaline spike later than here.
        */}
        {parsed.ok && bodyIdentifier(parsed.value, kind) !== null && bodyIdentifier(parsed.value, kind) !== slug && (
          <p style={{ color: C.accent, fontSize: 12.5, margin: '8px 0 0' }}>
            The slug is <code>{slug}</code> but the body calls itself{' '}
            <code>{bodyIdentifier(parsed.value, kind)}</code>. Publishing will be refused until they match.
          </p>
        )}

        {valid === true && (
          <p data-testid="validate-ok" style={{ color: C.live, fontSize: 13, margin: '10px 0 0' }}>
            Valid. This would publish.
          </p>
        )}
        {issues !== null && issues.length > 0 && (
          <div data-testid="validate-issues" style={{ marginTop: 10 }}>
            <div style={{ color: C.danger, fontSize: 13, fontWeight: 600 }}>
              {issues.length} problem{issues.length === 1 ? '' : 's'}, all of them:
            </div>
            <IssueList issues={issues} />
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <Button
            data-testid="validate"
            disabled={!canDraft || !parsed.ok}
            onClick={async () => {
              if (!parsed.ok) return;
              setBanner(null);
              const result = await run(() => client.validate(kind, parsed.value));
              if (result === null) return;
              setValid(result.valid);
              setIssues(result.valid ? null : [...result.issues]);
            }}
          >
            Validate
          </Button>
          <Button
            data-testid="draft"
            tone="primary"
            disabled={!canDraft || !parsed.ok}
            onClick={async () => {
              if (!parsed.ok) return;
              setBanner(null);
              const created = await run(() =>
                client.createDocument({ kind, slug, title, body: parsed.value, activation: activation(), notes }),
              );
              if (created !== null) {
                setBanner({ tone: 'ok', text: `Drafted ${created.kind}/${created.slug} v${created.version}.` });
                onChanged();
              }
            }}
          >
            Save as draft
          </Button>
        </div>
      </Panel>

      <Panel
        title="Documents"
        subtitle="Every version, in every status. Versions are immutable; a change is a new one."
      >
        {documents.length === 0 ? (
          <Empty>Nothing here. Either nothing has been authored, or this tab has no ops token.</Empty>
        ) : (
          <table data-testid="documents">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Slug</th>
                <th>v</th>
                <th>Status</th>
                <th>Window</th>
                <th>Updated</th>
                <th>Move to</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((document) => (
                <tr key={document.id} data-testid={`doc-${document.slug}-${document.version}`}>
                  <td style={{ color: C.textSoft }}>{document.kind}</td>
                  <td>
                    <code>{document.slug}</code>
                  </td>
                  <td style={{ color: C.textSoft }}>{document.version}</td>
                  <td>
                    <Pill value={document.status} />
                  </td>
                  <td style={{ color: C.textSoft, fontSize: 12 }}>{describeWindow(document.activation)}</td>
                  <td style={{ color: C.textFaint, fontSize: 12 }}>
                    {new Date(document.updatedAt).toLocaleString()}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {NEXT_STATUS[document.status].map((next) => (
                        <Button
                          key={next}
                          data-testid={`transition-${document.slug}-${next}`}
                          tone={next === 'published' ? 'primary' : next === 'retired' ? 'danger' : 'quiet'}
                          disabled={!canPublish}
                          onClick={async () => {
                            setBanner(null);
                            const moved = await run(() => client.transition(document.id, next as ContentStatus));
                            if (moved !== null) {
                              setBanner({ tone: 'ok', text: `${moved.slug} v${moved.version} is now ${moved.status}.` });
                              onChanged();
                            }
                          }}
                        >
                          {next}
                        </Button>
                      ))}
                      {NEXT_STATUS[document.status].length === 0 && (
                        <span style={{ color: C.textFaint, fontSize: 12 }}>—</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <ManifestPanel manifest={manifest} />
    </>
  );
}

/**
 * What a player's phone would receive, right now.
 *
 * The single most useful thing on this screen, and the reason "watch a window
 * open" is a thing you can actually do: `active` is the *server's* answer,
 * computed against the service clock, so a window opening flips this without
 * anybody publishing anything.
 */
function ManifestPanel({ manifest }: { manifest: ContentManifest | null }): React.ReactElement {
  return (
    <Panel
      title="What a phone gets"
      subtitle="GET /v1/content/manifest, public and cacheable. `active` is the service's clock, never yours."
    >
      {manifest === null ? (
        <Empty>Have not been able to read the manifest.</Empty>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 12, fontSize: 12.5 }}>
            <Stat label="Release" value={String(manifest.releaseVersion)} testId="manifest-release-version" />
            <Stat label="Evaluated at" value={new Date(manifest.evaluatedAt).toLocaleString()} />
            <Stat label="ETag" value={manifest.etag} />
            <Stat label="Documents" value={String(manifest.documents.length)} />
            <Stat
              label="Open windows"
              value={manifest.activeEventSlugs.length === 0 ? 'none' : manifest.activeEventSlugs.join(', ')}
            />
          </div>
          {manifest.documents.length === 0 ? (
            <Empty>Nothing published. Every client is running on its compiled-in catalogue, which is fine.</Empty>
          ) : (
            <table data-testid="manifest">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Slug</th>
                  <th>v</th>
                  <th>Live now</th>
                  <th>Window</th>
                </tr>
              </thead>
              <tbody>
                {manifest.documents.map((document) => (
                  <tr key={`${document.kind}/${document.slug}`} data-testid={`manifest-${document.slug}`}>
                    <td style={{ color: C.textSoft }}>{document.kind}</td>
                    <td>
                      <code>{document.slug}</code>
                    </td>
                    <td style={{ color: C.textSoft }}>{document.version}</td>
                    <td>
                      <span
                        data-testid={`manifest-active-${document.slug}`}
                        style={{ color: document.active ? C.live : C.textFaint, fontWeight: 600 }}
                      >
                        {document.active ? 'ACTIVE' : 'waiting'}
                      </span>
                      {/*
                        A local recomputation, shown only when it disagrees.
                        The server's answer is authoritative; a disagreement
                        means this machine's clock is wrong, and knowing that at
                        2am is worth a line of code.
                      */}
                      {document.activation !== null &&
                        isWindowOpen(document.activation, new Date().toISOString()) !== document.active && (
                          <div style={{ color: C.accent, fontSize: 11 }}>your clock disagrees</div>
                        )}
                    </td>
                    <td style={{ color: C.textSoft, fontSize: 12 }}>{describeWindow(document.activation)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Releases                                                                    */
/* -------------------------------------------------------------------------- */

function ReleasesTab({
  client,
  releases,
  manifest,
  canPublish,
  run,
  onChanged,
  setBanner,
}: TabProps & {
  releases: ContentRelease[];
  manifest: ContentManifest | null;
  canPublish: boolean;
}): React.ReactElement {
  const [note, setNote] = useState('');
  const liveVersion = manifest?.releaseVersion ?? 0;

  return (
    <Panel
      title="Releases"
      subtitle="Append-only. A rollback does not rewind — it publishes an old release's bodies as a new one, so the trail never loses a step."
    >
      <Field label="Why (goes in the release note)">
        <input
          data-testid="rollback-note"
          value={note}
          placeholder="e.g. the Perseids event pointed at the wrong environment"
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>

      {releases.length === 0 ? (
        <Empty>No releases yet. The first publish mints release 1.</Empty>
      ) : (
        <table data-testid="releases" style={{ marginTop: 14 }}>
          <thead>
            <tr>
              <th>#</th>
              <th>Reason</th>
              <th>Documents</th>
              <th>When</th>
              <th>By</th>
              <th>Note</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {releases.map((release) => (
              <tr key={release.id} data-testid={`release-${release.version}`}>
                <td style={{ fontWeight: 600 }}>
                  {release.version}
                  {release.version === liveVersion && (
                    <span style={{ color: C.live, fontSize: 11, marginLeft: 6 }}>LIVE</span>
                  )}
                </td>
                <td style={{ color: C.textSoft }}>
                  {release.reason}
                  {release.rolledBackFromVersion !== null && (
                    <span style={{ color: C.textFaint }}> (reproduces {release.rolledBackFromVersion})</span>
                  )}
                </td>
                <td style={{ color: C.textSoft }}>{release.entries.length}</td>
                <td style={{ color: C.textFaint, fontSize: 12 }}>{new Date(release.createdAt).toLocaleString()}</td>
                <td style={{ color: C.textFaint, fontSize: 12 }}>
                  <code>{release.createdBy}</code>
                </td>
                <td style={{ color: C.textSoft, fontSize: 12 }}>{release.note || '—'}</td>
                <td>
                  <Button
                    data-testid={`rollback-${release.version}`}
                    tone="danger"
                    disabled={!canPublish || release.version === liveVersion}
                    onClick={async () => {
                      setBanner(null);
                      const created = await run(() => client.rollback(release.version, note));
                      if (created !== null) {
                        setBanner({
                          tone: 'ok',
                          text: `Release ${created.version} now reproduces release ${release.version}.`,
                        });
                        onChanged();
                      }
                    }}
                  >
                    Roll back to this
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Codes                                                                       */
/* -------------------------------------------------------------------------- */

function CodesTab({
  client,
  batches,
  signing,
  canMintCodes,
  run,
  onChanged,
  setBanner,
}: TabProps & {
  batches: CodeBatch[];
  signing: null | { ready: true; keyIds: string[]; canMint: boolean } | { ready: false; reason: string };
  canMintCodes: boolean;
}): React.ReactElement {
  const [label, setLabel] = useState('Spring 26 wrapper, print order 4471');
  const [size, setSize] = useState('1000');
  const [rewardCode, setRewardCode] = useState('wrapper_patch');
  const [ttlDays, setTtlDays] = useState('730');
  const [mintCount, setMintCount] = useState('10');
  const [minted, setMinted] = useState<MintCodesResult | null>(null);

  const canMint = canMintCodes && signing?.ready === true && signing.canMint;

  return (
    <>
      <Panel
        title="Open a print run"
        subtitle="What it entitles you to lives here, not in the code — so a run can be repointed or switched off after the boxes are in a warehouse."
      >
        {signing !== null && !signing.ready && (
          <p style={{ color: C.accent, fontSize: 12.5, margin: '0 0 12px' }}>{signing.reason}</p>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 12 }}>
          <Field label="Label">
            <input data-testid="batch-label" value={label} onChange={(event) => setLabel(event.target.value)} />
          </Field>
          <Field label="Planned size">
            <input data-testid="batch-size" value={size} onChange={(event) => setSize(event.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Reward code" hint="Must already be a defined reward.">
            <input data-testid="batch-reward" value={rewardCode} onChange={(event) => setRewardCode(event.target.value)} />
          </Field>
          <Field label="Code lifetime (days)" hint="Baked into every code; blank never expires.">
            <input data-testid="batch-ttl" value={ttlDays} onChange={(event) => setTtlDays(event.target.value)} inputMode="numeric" />
          </Field>
        </div>
        <Button
          data-testid="create-batch"
          tone="primary"
          disabled={!canMint}
          onClick={async () => {
            setBanner(null);
            const created = await run(() =>
              client.createBatch({
                label,
                kind: 'pkg',
                entitlement: { type: 'reward', rewardCode },
                plannedSize: Number.parseInt(size, 10) || 1,
                perAccountLimit: 1,
                codeTtlDays: ttlDays.trim().length === 0 ? null : Number.parseInt(ttlDays, 10),
                activeFrom: null,
                activeUntil: null,
              }),
            );
            if (created !== null) {
              setBanner({ tone: 'ok', text: `Opened ${created.id} — ${created.label}.` });
              onChanged();
            }
          }}
          style={{ marginTop: 12 }}
        >
          Open the run
        </Button>
      </Panel>

      <Panel title="Print runs" subtitle="Retiring one run does not touch any other. That is the whole point of a batch id.">
        {batches.length === 0 ? (
          <Empty>No runs yet.</Empty>
        ) : (
          <table data-testid="batches">
            <thead>
              <tr>
                <th>Id</th>
                <th>Label</th>
                <th>Status</th>
                <th>Entitles</th>
                <th>Minted / planned</th>
                <th>Redeemed</th>
                <th>Mint</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => (
                <tr key={batch.id} data-testid={`batch-${batch.id}`}>
                  <td>
                    <code>{batch.id}</code>
                  </td>
                  <td>
                    {batch.label}
                    {batch.flaggedAt !== null && (
                      <div style={{ color: C.accent, fontSize: 11 }}>flagged: {batch.flagReason}</div>
                    )}
                    {batch.retiredReason !== null && (
                      <div style={{ color: C.textFaint, fontSize: 11 }}>retired: {batch.retiredReason}</div>
                    )}
                  </td>
                  <td>
                    <Pill value={batch.status} />
                  </td>
                  <td style={{ color: C.textSoft, fontSize: 12 }}>
                    {batch.entitlement.type === 'reward'
                      ? batch.entitlement.rewardCode
                      : batch.entitlement.type === 'content'
                        ? batch.entitlement.documentSlug
                        : 'campsite invite'}
                  </td>
                  <td style={{ color: C.textSoft }}>
                    {batch.mintedCount} / {batch.plannedSize}
                  </td>
                  <td style={{ color: C.textSoft }}>{batch.redeemedCount}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        data-testid={`mint-count-${batch.id}`}
                        value={mintCount}
                        onChange={(event) => setMintCount(event.target.value)}
                        inputMode="numeric"
                        style={{ width: 70 }}
                      />
                      <Button
                        data-testid={`mint-${batch.id}`}
                        disabled={!canMint || batch.status !== 'active'}
                        onClick={async () => {
                          setBanner(null);
                          const result = await run(() =>
                            client.mint(batch.id, Number.parseInt(mintCount, 10) || 1),
                          );
                          if (result !== null) {
                            setMinted(result);
                            onChanged();
                          }
                        }}
                      >
                        Mint
                      </Button>
                    </div>
                  </td>
                  <td>
                    <Button
                      data-testid={`retire-${batch.id}`}
                      tone="danger"
                      disabled={!canMintCodes || batch.status === 'retired'}
                      onClick={async () => {
                        const reason = window.prompt('Why is this run being retired?');
                        if (reason === null || reason.trim().length === 0) return;
                        setBanner(null);
                        const retired = await run(() => client.retire(batch.id, reason.trim()));
                        if (retired !== null) {
                          setBanner({ tone: 'ok', text: `${retired.id} retired. Every other run keeps working.` });
                          onChanged();
                        }
                      }}
                    >
                      Retire
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {minted !== null && (
        <Panel
          title={`${minted.minted.length} codes — the only copy that exists`}
          subtitle="The service does not store codes and cannot re-issue them. Copy these to the print vendor before you close this tab; losing them is a reprint."
        >
          {/*
            One code per line, scrolled sideways rather than wrapped: this text
            is going to a print vendor as `ref<TAB>uri`, and a wrapped line is a
            line somebody has to un-wrap by hand for a run of 100,000.
          */}
          <textarea
            data-testid="minted-codes"
            readOnly
            wrap="off"
            rows={Math.min(14, minted.minted.length + 1)}
            value={minted.minted.map((code) => `${code.ref}\t${code.uri}`).join('\n')}
            onFocus={(event) => event.currentTarget.select()}
            style={{ whiteSpace: 'pre', overflowX: 'auto' }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
            <Button
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(minted.minted.map((code) => code.uri).join('\n'))
                  .catch(() => undefined);
              }}
            >
              Copy all
            </Button>
            <Button tone="quiet" onClick={() => setMinted(null)}>
              Done — I have them
            </Button>
            <span style={{ color: C.textFaint, fontSize: 12 }}>
              Batch {minted.batchId} · {minted.mintedCount} minted in total
            </span>
          </div>
        </Panel>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Small pieces                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a body calls itself.
 *
 * `reward_definition` is a protocol contract addressed by `code`; everything
 * else is content addressed by `id`. The service enforces both; this is only
 * so an author finds out before they click publish.
 */
function bodyIdentifier(body: unknown, kind: ContentKind): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>)[kind === 'reward_definition' ? 'code' : 'id'];
  return typeof value === 'string' ? value : null;
}

function describeWindow(activation: { startsAt: string | null; endsAt: string | null } | null): string {
  if (activation === null) return 'always, once published';
  const from = activation.startsAt === null ? 'now' : new Date(activation.startsAt).toLocaleString();
  const to = activation.endsAt === null ? 'forever' : new Date(activation.endsAt).toLocaleString();
  return `${from} → ${to}`;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label style={{ display: 'block' }}>
      <span
        style={{
          display: 'block',
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: C.textFaint,
          marginBottom: 4,
        }}
      >
        {label}
      </span>
      {children}
      {hint !== undefined && (
        <span style={{ display: 'block', fontSize: 11, color: C.textFaint, marginTop: 3 }}>{hint}</span>
      )}
    </label>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section
      style={{
        background: C.panel,
        border: `1px solid ${C.panelEdge}`,
        borderRadius: 6,
        padding: 16,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title}</h2>
      {subtitle !== undefined && (
        <p style={{ margin: '4px 0 14px', fontSize: 12.5, color: C.textFaint, lineHeight: 1.5 }}>{subtitle}</p>
      )}
      {children}
    </section>
  );
}

function Button({
  tone = 'normal',
  style,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: 'normal' | 'primary' | 'danger' | 'quiet';
}): React.ReactElement {
  const palette =
    tone === 'primary'
      ? { background: C.accent, color: '#1a1206', border: C.accent }
      : tone === 'danger'
        ? { background: 'transparent', color: C.danger, border: C.danger }
        : tone === 'quiet'
          ? { background: 'transparent', color: C.textFaint, border: C.panelEdge }
          : { background: 'transparent', color: C.text, border: C.panelEdge };
  return (
    <button
      {...rest}
      style={{
        background: palette.background,
        color: palette.color,
        border: `1px solid ${palette.border}`,
        borderRadius: 4,
        padding: '7px 13px',
        fontSize: 12.5,
        whiteSpace: 'nowrap',
        ...style,
      }}
    />
  );
}

function Pill({ value }: { value: string }): React.ReactElement {
  const colour = STATUS_COLOUR[value] ?? C.textSoft;
  return (
    <span
      style={{
        color: colour,
        border: `1px solid ${colour}`,
        borderRadius: 999,
        padding: '1px 8px',
        fontSize: 11,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
      }}
    >
      {value}
    </span>
  );
}

function Stat({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId?: string;
}): React.ReactElement {
  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.textFaint }}>
        {label}
      </div>
      <div style={{ fontFamily: MONO, fontSize: 12.5 }} {...(testId === undefined ? {} : { 'data-testid': testId })}>
        {value}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p style={{ color: C.textFaint, fontSize: 13, margin: 0 }}>{children}</p>;
}
