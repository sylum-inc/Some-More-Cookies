/**
 * Tests for the procedural audio engine.
 *
 * Everything pure (noise generation, impulse responses, envelope maths, the
 * Poisson scheduler, every simulation-state mapping, the mixer state machine)
 * is asserted directly. The stateful half is driven through the headless
 * `FakeAudioContext` from `src/audio/testing.ts`, which records every parameter
 * automation event so scheduling can be checked precisely.
 */
export {};
//# sourceMappingURL=audio.test.d.ts.map