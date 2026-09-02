import { SCHEMA_VERSION } from '@somemore/protocol';
import { type App } from '../src/app.js';
import { createManualClock } from '../src/clock.js';
import { type FakePaymentProvider } from '../src/payments/fake.js';
import type { Mailer, OutboundMail } from '../src/mailer.js';
export declare const TEST_START = "2026-08-29T12:00:00.000Z";
export declare const PERSISTENCE: 'memory' | 'postgres';
export interface TestMailer extends Mailer {
    readonly sent: OutboundMail[];
    lastToken(): string | null;
}
export interface ApiResponse<T = any> {
    readonly status: number;
    readonly body: T;
    readonly headers: Headers;
}
export interface RequestOptions {
    readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    readonly body?: unknown;
    readonly token?: string | null;
    readonly headers?: Record<string, string>;
    readonly rawBody?: string;
}
export interface TestHarness {
    readonly app: App;
    readonly baseUrl: string;
    /** Which storage backend this run is exercising. */
    readonly persistence: 'memory' | 'postgres';
    readonly clock: ReturnType<typeof createManualClock>;
    readonly payments: FakePaymentProvider;
    readonly mailer: TestMailer;
    request<T = any>(path: string, options?: RequestOptions): Promise<ApiResponse<T>>;
    close(): Promise<void>;
}
export interface StartTestApiOptions {
    /**
     * Truncate the database before booting. On by default so every case starts
     * from nothing, exactly as it would with a fresh set of Maps. Pass `false` to
     * model a process restart against a database that is already populated.
     */
    readonly resetDatabase?: boolean;
}
/** Boot the real HTTP server on an ephemeral port and drive it with `fetch`. */
export declare function startTestApi(env?: Record<string, string>, options?: StartTestApiOptions): Promise<TestHarness>;
export declare function key(prefix?: string): string;
export interface Player {
    readonly accountId: string;
    readonly token: string;
    readonly deviceId: string;
}
export declare function bootstrap(api: TestHarness, displayName?: string): Promise<Player>;
export declare function createCampsite(api: TestHarness, player: Player, overrides?: Record<string, unknown>): Promise<any>;
/** A well-made sandwich: golden roast, tidy assembly, clean machine run. */
export declare function sandwichPayload(campsiteId: string, machineSerial: string, overrides?: Record<string, unknown>): {
    idempotencyKey: string;
    campsiteId: string;
    name: string;
    roast: {
        durationMs: number;
        averageDistanceCm: number;
        minimumDistanceCm: number;
        rotations: number;
        evenness: number;
        peakSurfaceTempC: number;
        charFraction: number;
        meltFraction: number;
        ignited: boolean;
        flareUps: number;
        blownOut: boolean;
        dropped: boolean;
        grade: string;
        simVersion: string;
    };
    assembly: {
        alignment: number;
        chocolateCoverage: number;
        grahamIntegrity: number;
        squish: number;
        heatTransfer: number;
        layerOrderCorrect: boolean;
        assembledInSeconds: number;
        defects: never[];
        score: number;
    };
    machineRun: {
        machineSerial: string;
        program: string;
        startedAt: string;
        completedAt: string;
        chillSeconds: number;
        pressForceN: number;
        churnRpm: number;
        coreTempC: number;
        outcome: string;
        anomalies: never[];
        quirkCodesApplied: never[];
        wearDelta: {
            drum: number;
            press: number;
            chiller: number;
            dispenser: number;
            hopper: number;
            belt: number;
        };
        firmwareVersion: string;
    };
    flavorTags: string[];
    photoIds: never[];
};
export declare const US_ADDRESS: {
    name: string;
    line1: string;
    city: string;
    region: string;
    postalCode: string;
    country: string;
};
export { SCHEMA_VERSION };
//# sourceMappingURL=harness.d.ts.map