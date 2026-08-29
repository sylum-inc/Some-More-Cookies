/**
 * Entry point.
 *
 * Boots straight into the world (spec §6.2) — no title menu, no account wall,
 * no consent dialog before anything has been seen. A person arrives on a
 * trail in the dark with a fire ahead of them.
 */
import { Store } from './state/store.js';
/**
 * Exposed for the end-to-end tests and for the browser console.
 *
 * These are the *same* functions the interface calls — the tests drive the
 * real ritual through the real simulation, they do not stub it. Anything a
 * test can do here, a player can do by touching the world.
 */
declare global {
    interface Window {
        __someMore?: {
            store: Store;
            actions: Record<string, (...args: never[]) => unknown>;
            /** Populated once the canvas exists; used by the screenshot harness. */
            three?: {
                gl: unknown;
                scene: unknown;
                camera: unknown;
            };
            environments: readonly {
                id: string;
                name: string;
            }[];
        };
    }
}
//# sourceMappingURL=main.d.ts.map