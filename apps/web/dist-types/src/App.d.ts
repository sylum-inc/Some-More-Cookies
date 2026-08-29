/**
 * Application shell.
 *
 * Boot goes toward the world, never toward a menu (spec §6.2). The player
 * lands on a trail in the dark with a fire ahead of them.
 */
import { vec3 } from '@somemore/sim';
import { Store } from './state/store.js';
export interface AppProps {
    store: Store;
}
export declare function App({ store }: AppProps): React.ReactElement;
export { vec3 };
//# sourceMappingURL=App.d.ts.map