/**
 * Installation and update, as a tiny observable.
 *
 * Same shape as `state/store.ts` — subscribe, snapshot, no dependencies —
 * because `useSyncExternalStore` is what the rest of the interface already
 * reads from and a second reactivity system would be a second thing to
 * reason about.
 *
 * Two things live here that both have to happen before React is anywhere near
 * ready: `beforeinstallprompt` fires once, early, and is gone if nobody calls
 * `preventDefault` on it; and registering the worker should not compete with
 * the first frame of a 3D scene. So the listeners are attached when this
 * module is imported and the registration waits for `load`.
 */

/** The event Chromium fires when it would have shown its own install UI. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface PwaState {
  /** Whether this browser does service workers at all. */
  supported: boolean;
  /** A worker is registered and controlling, so a cold offline boot will work. */
  ready: boolean;
  /** A newer build has installed and is waiting for permission to take over. */
  updateReady: boolean;
  /** The browser offered an install, and the offer is being held. */
  installAvailable: boolean;
  /** Already running from a home screen or an installed window. */
  installed: boolean;
  /** The build the active worker is serving. Null until it answers. */
  version: string | null;
}

const DISMISSED_KEY = 'some-more/install-invite/v1';
/**
 * How long a "not now" lasts.
 *
 * Long enough that dismissing it means something (spec §11: nothing here sells
 * to somebody mid-ritual), short enough that a person who changes their mind
 * six weeks later is not stuck with a bookmark.
 */
const DISMISSAL_MS = 30 * 24 * 60 * 60 * 1000;

/** How often a running tab bothers to ask whether there is a newer build. */
const UPDATE_CHECK_MS = 15 * 60 * 1000;

function readDismissedAt(): number {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return 0;
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  } catch {
    // A device that will not persist the dismissal simply asks again.
    return 0;
  }
}

function detectInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  // `navigator.standalone` is iOS's own, and predates `display-mode`.
  const ios = (navigator as unknown as { standalone?: boolean }).standalone === true;
  if (ios) return true;
  if (!window.matchMedia) return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches
  );
}

class PwaController {
  private listeners = new Set<() => void>();
  private deferred: BeforeInstallPromptEvent | null = null;
  private registration: ServiceWorkerRegistration | null = null;
  private dismissedAt = 0;
  private reloading = false;
  private lastCheck = 0;

  state: PwaState = {
    supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    ready: false,
    updateReady: false,
    installAvailable: false,
    installed: false,
    version: null,
  };

  constructor() {
    if (typeof window === 'undefined') return;
    this.dismissedAt = readDismissedAt();
    this.state = { ...this.state, installed: detectInstalled() };

    window.addEventListener('beforeinstallprompt', (event) => {
      // Holding the event is what makes the offer ours to place quietly rather
      // than the browser's to place across the top of the fire.
      event.preventDefault();
      this.deferred = event as BeforeInstallPromptEvent;
      this.set({ installAvailable: true });
    });

    window.addEventListener('appinstalled', () => {
      this.deferred = null;
      this.set({ installAvailable: false, installed: true });
    });
  }

  private set(partial: Partial<PwaState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PwaState => this.state;

  /**
   * Whether the quiet install card may be offered at all.
   *
   * Being *able* to install is not a reason to say so. The caller adds the
   * rule about when in the ritual it is decent to ask; this is only about
   * whether there is anything to ask for and whether it has been refused.
   */
  get inviteAllowed(): boolean {
    if (!this.state.installAvailable || this.state.installed) return false;
    return Date.now() - this.dismissedAt > DISMISSAL_MS;
  }

  /** Registers the worker once the first frames are out of the way. */
  /**
   * `import.meta.env.BASE_URL` rather than a literal, and the scope with it.
   *
   * Vite fills this in from the build's `base`, so it is `/` for every
   * ordinary build and `/Some-More-Cookies/` for a project page — one value,
   * decided once, that the client never has to be told separately. A
   * hard-coded `/sw.js` under a project page asks the account's *other* site
   * for a worker; a hard-coded scope of `/` is refused outright by the browser
   * for a script served from a subdirectory, which would leave the app
   * permanently uninstallable with a console warning as the only clue.
   */
  register(scriptUrl = `${import.meta.env.BASE_URL}sw.js`): void {
    if (!this.state.supported) return;
    if (this.registration) return;

    const start = (): void => {
      void navigator.serviceWorker
        .register(scriptUrl, {
          scope: import.meta.env.BASE_URL,
          // Never take the worker script itself from the HTTP cache. This is
          // the single setting that decides whether a stale build can become
          // permanent, because everything else keys off noticing new bytes.
          updateViaCache: 'none',
        })
        .then((registration) => {
          this.registration = registration;
          this.set({ ready: true });
          this.watch(registration);
          void this.askVersion();
        })
        .catch((error: unknown) => {
          // Not fatal, and never allowed to be. A campsite with no worker is
          // a campsite that needs a connection, not a broken one.
          console.warn('[pwa] service worker registration failed', error);
        });
    };

    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!this.reloading) return;
      this.reloading = false;
      location.reload();
    });

    // A tab left open on a phone for a week is the normal case, not the
    // exception, so coming back to the foreground is when to look.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      this.checkForUpdate();
    });
  }

  private watch(registration: ServiceWorkerRegistration): void {
    const consider = (worker: ServiceWorker | null): void => {
      if (!worker) return;
      const evaluate = (): void => {
        // `controller` distinguishes the first install (nothing to update
        // from) from a genuine replacement.
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          this.set({ updateReady: true });
        }
      };
      evaluate();
      worker.addEventListener('statechange', evaluate);
    };

    consider(registration.waiting);
    registration.addEventListener('updatefound', () => consider(registration.installing));
  }

  /** Asks the active worker which build it is serving. */
  private async askVersion(): Promise<void> {
    const worker = navigator.serviceWorker.controller;
    if (!worker) return;
    const version = await new Promise<string | null>((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 2000);
      channel.port1.onmessage = (event: MessageEvent) => {
        clearTimeout(timer);
        const data = event.data as { version?: unknown } | null;
        resolve(typeof data?.version === 'string' ? data.version : null);
      };
      worker.postMessage({ type: 'sm-version' }, [channel.port2]);
    });
    if (version) this.set({ version });
  }

  /** Throttled `registration.update()`. Cheap, and the only self-healing path. */
  checkForUpdate(): void {
    const now = Date.now();
    if (now - this.lastCheck < UPDATE_CHECK_MS) return;
    this.lastCheck = now;
    void this.registration?.update().catch(() => undefined);
  }

  /**
   * Takes the waiting build.
   *
   * Reloads, because a half-swapped page — old JavaScript talking to a new
   * cache — is exactly the failure this whole design is arranged to avoid.
   */
  applyUpdate(): void {
    const waiting = this.registration?.waiting;
    if (!waiting) {
      location.reload();
      return;
    }
    this.reloading = true;
    waiting.postMessage({ type: 'sm-skip-waiting' });
  }

  /** Shows the browser's own install sheet, because we were asked to. */
  async promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    const deferred = this.deferred;
    if (!deferred) return 'unavailable';
    this.deferred = null;
    this.set({ installAvailable: false });
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === 'dismissed') this.dismissInstall();
    return choice.outcome;
  }

  /** "Not now", remembered. */
  dismissInstall(): void {
    this.dismissedAt = Date.now();
    try {
      localStorage.setItem(DISMISSED_KEY, String(this.dismissedAt));
    } catch {
      /* ignore */
    }
    this.set({ installAvailable: this.state.installAvailable });
  }
}

/**
 * The one controller.
 *
 * Created on import so the `beforeinstallprompt` listener is attached before
 * the browser has a chance to fire it. Registration is still explicit.
 */
export const pwa = new PwaController();

declare global {
  interface Window {
    /** Exposed for the end-to-end suite, alongside `__someMore`. */
    __someMorePwa?: PwaController;
  }
}

if (typeof window !== 'undefined') window.__someMorePwa = pwa;
