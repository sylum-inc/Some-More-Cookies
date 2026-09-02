import { describe, expect, it } from 'vitest';
import {
  availableBands,
  createRadio,
  currentSegment,
  describeReception,
  drainRadioEvents,
  planBands,
  programmeSegment,
  receptionAt,
  segmentProgress,
  selectivity,
  setBand,
  setRadioPower,
  stationSignals,
  stepRadio,
  tuneTo,
  tuneToStation,
  turnDial,
  upcomingSegments,
  type RadioCode,
  type RadioConditions,
  type RadioProfileSpec,
  type RadioState,
  type RadioWeather,
} from '../src/radio.js';
import { SIM_DT } from '../src/types.js';

/**
 * A dial in the shape the content package emits — `RadioProfile` from
 * `@somemore/content` has exactly these fields, including the wide-band
 * oddities the catalogue actually uses (a weather station up at 162 MHz "on
 * FM", a beacon down at 310 "on AM", shortwave in kHz).
 */
const PROFILE: RadioProfileSpec = {
  stations: [
    { id: 'khol_887', dial: 88.7, band: 'fm', name: 'KHOL — Night Service', character: 'lofi', reception: 0.82, note: '' },
    { id: 'forest_net', dial: 91.3, band: 'fm', name: 'Forest Net Repeater', character: 'environmental', reception: 0.64, note: '' },
    { id: 'neighbour', dial: 91.55, band: 'fm', name: 'A very large transmitter', character: 'community', reception: 0.95, note: '' },
    { id: 'gap_signal', dial: 104.1, band: 'fm', name: 'Unlabelled carrier', character: 'strange', reception: 0.42, note: '' },
    { id: 'noaa', dial: 162.475, band: 'fm', name: 'Mountain Forecast', character: 'weather-service', reception: 0.8, note: '' },
    { id: 'wcrk_1490', dial: 1490, band: 'am', name: 'WCRK 1490', character: 'community', reception: 0.4, note: '' },
    { id: 'ndb_310', dial: 310, band: 'am', name: 'NDB — three letters', character: 'environmental', reception: 0.85, note: '' },
    { id: 'sw_6840', dial: 6840, band: 'shortwave', name: '6840 kHz', character: 'strange', reception: 0.28, note: '' },
  ],
  baseReception: 0.7,
  receptionNote: '',
  betweenStations: 'Soft pink hiss with a faint 60-cycle hum.',
};

const CODES: Readonly<Record<string, readonly RadioCode[]>> = {
  gap_signal: [
    { id: 'five_groups', kind: 'numbers', text: 'four seven nine one two', frequency: 0.6 },
    { id: 'callsign', kind: 'callsign', text: 'a callsign, once', frequency: 0.3 },
  ],
};

const CLEAR: RadioWeather = { precipitation: 0, windSpeed: 0.6, fog: 0.05, cloudCover: 0.1 };
const STORM: RadioWeather = { precipitation: 1, windSpeed: 7.5, fog: 0.3, cloudCover: 1 };

function radio(overrides: Parameters<typeof createRadio>[1] = { campsiteSeed: 7 }): RadioState {
  const state = createRadio(PROFILE, overrides);
  setRadioPower(state, true);
  return state;
}

function advance(state: RadioState, seconds: number, conditions: RadioConditions = {}): void {
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) stepRadio(state, SIM_DT, conditions);
}

describe('band plans', () => {
  it('widens each band to hold every station the content places on it', () => {
    const plans = planBands(PROFILE);
    expect(plans.fm.max).toBeGreaterThanOrEqual(162.475);
    expect(plans.am.min).toBeLessThanOrEqual(310);
    expect(plans.shortwave.max).toBeGreaterThanOrEqual(6840);
    expect(availableBands(PROFILE)).toEqual(['fm', 'am', 'shortwave']);
  });

  it('clamps the dial to the band and moves it by knob turns', () => {
    const state = radio();
    tuneTo(state, -500);
    expect(state.dial).toBeCloseTo(state.bands.fm.min, 6);
    tuneTo(state, 1e9);
    expect(state.dial).toBeCloseTo(state.bands.fm.max, 6);
    const before = state.dial;
    turnDial(state, -1);
    expect(state.dial).toBeLessThan(before);
  });
});

describe('analogue tuning', () => {
  it('falls off with distance from the centre frequency', () => {
    const centre = selectivity(0, 0.16);
    const edge = selectivity(0.16, 0.16);
    const far = selectivity(0.8, 0.16);
    expect(centre).toBeGreaterThan(edge);
    expect(edge).toBeGreaterThan(far);
    expect(centre).toBeCloseTo(1, 1);
    expect(far).toBeLessThan(0.1);
  });

  it('is selective: half a channel off already costs you the station', () => {
    const state = radio();
    tuneToStation(state, 'khol_887');
    stepRadio(state, SIM_DT);
    const onStation = receptionAt(state);
    expect(onStation.stationId).toBe('khol_887');
    expect(onStation.clarity).toBeGreaterThan(0.4);
    expect(onStation.hiss).toBeLessThan(0.5);

    tuneTo(state, 88.7 + 0.5);
    const offStation = receptionAt(state);
    expect(offStation.clarity).toBeLessThan(onStation.clarity * 0.35);
    expect(offStation.hiss).toBeGreaterThan(onStation.hiss);
    expect(offStation.betweenStations).toBe(true);
  });

  it('is nothing but hiss in an empty stretch of dial', () => {
    const state = radio();
    tuneTo(state, 98.4);
    stepRadio(state, SIM_DT);
    expect(state.reception.stationId).toBeNull();
    expect(state.reception.hiss).toBeGreaterThan(0.6);
    expect(describeReception(state)).toBe(PROFILE.betweenStations);
  });

  it('lets a strong neighbour bleed into a weaker station', () => {
    const state = radio();
    tuneToStation(state, 'forest_net');
    stepRadio(state, SIM_DT);
    const crowded = receptionAt(state);
    expect(crowded.bleed).toBeGreaterThan(0.05);
    expect(crowded.bleedFromId).toBe('neighbour');

    // The same station quality, alone on the dial, comes through cleaner.
    const isolated = createRadio(
      { ...PROFILE, stations: PROFILE.stations.filter((s) => s.id !== 'neighbour') },
      { campsiteSeed: 7 },
    );
    setRadioPower(isolated, true);
    tuneToStation(isolated, 'forest_net');
    stepRadio(isolated, SIM_DT);
    const alone = receptionAt(isolated);
    expect(alone.bleed).toBeLessThan(crowded.bleed);
    expect(alone.clarity).toBeGreaterThan(crowded.clarity);
  });

  it('reports detune so the dial can whistle', () => {
    const state = radio();
    tuneTo(state, 88.6);
    const low = receptionAt(state);
    tuneTo(state, 88.8);
    const high = receptionAt(state);
    expect(Math.sign(low.detune)).toBe(-Math.sign(high.detune));
  });

  it('carries no signal at all when it is switched off', () => {
    const state = radio();
    tuneToStation(state, 'khol_887');
    stepRadio(state, SIM_DT);
    expect(state.reception.stationId).toBe('khol_887');
    setRadioPower(state, false);
    stepRadio(state, SIM_DT);
    expect(state.reception.stationId).toBeNull();
    expect(describeReception(state)).toBe('');
  });

  it('keeps bands separate', () => {
    const state = radio();
    setBand(state, 'am');
    tuneTo(state, 1490);
    stepRadio(state, SIM_DT);
    expect(state.reception.stationId).toBe('wcrk_1490');
    expect(stationSignals(state).every((signal) => signal.station.band === 'am')).toBe(true);
  });
});

describe('weather', () => {
  it('degrades reception and raises the noise floor', () => {
    const clear = radio();
    tuneToStation(clear, 'khol_887');
    advance(clear, 5, { weather: CLEAR });
    const stormy = radio();
    tuneToStation(stormy, 'khol_887');
    advance(stormy, 5, { weather: STORM });

    expect(stormy.reception.clarity).toBeLessThan(clear.reception.clarity);
    expect(stormy.reception.hiss).toBeGreaterThan(clear.reception.hiss);
  });

  it('hurts line-of-sight FM more than ground-wave AM', () => {
    const fm = radio();
    tuneToStation(fm, 'khol_887');
    advance(fm, 3, { weather: CLEAR });
    const fmClear = fm.reception.strength;
    advance(fm, 3, { weather: STORM });
    const fmStorm = fm.reception.strength;

    const am = radio();
    setBand(am, 'am');
    tuneToStation(am, 'ndb_310');
    advance(am, 3, { weather: CLEAR });
    const amClear = am.reception.strength;
    advance(am, 3, { weather: STORM });
    const amStorm = am.reception.strength;

    expect(fmStorm / fmClear).toBeLessThan(amStorm / amClear);
  });

  it('lets machinery hum ride on the signal without killing it', () => {
    const state = radio();
    tuneToStation(state, 'khol_887');
    advance(state, 2, { machineNoise: 0.9 });
    expect(state.reception.hum).toBeGreaterThan(0.5);
    expect(state.reception.stationId).toBe('khol_887');
  });
});

describe('procedural programming', () => {
  it('generates the same schedule for the same seed and a different one otherwise', () => {
    const a = createRadio(PROFILE, { campsiteSeed: 'pine_hollow' });
    const b = createRadio(PROFILE, { campsiteSeed: 'pine_hollow' });
    const c = createRadio(PROFILE, { campsiteSeed: 'lantern_mesa' });
    setRadioPower(a, true);
    setRadioPower(b, true);
    setRadioPower(c, true);
    advance(a, 600);
    advance(b, 600);
    advance(c, 600);
    expect(currentSegment(a, 'khol_887')).toEqual(currentSegment(b, 'khol_887'));
    expect(segmentProgress(a, 'khol_887')).toBeCloseTo(segmentProgress(b, 'khol_887'), 9);
    expect(currentSegment(a, 'khol_887')).not.toEqual(currentSegment(c, 'khol_887'));
  });

  it('keeps broadcasting while you are tuned elsewhere — it has moved on, not restarted', () => {
    const listener = radio();
    const control = radio();
    tuneToStation(listener, 'khol_887');
    tuneToStation(control, 'khol_887');

    advance(listener, 60);
    advance(control, 60);
    const early = currentSegment(listener, 'khol_887');
    expect(early).not.toBeNull();

    // Wander off down the dial for five minutes.
    tuneTo(listener, 98.4);
    advance(listener, 300);
    advance(control, 300);
    tuneToStation(listener, 'khol_887');
    stepRadio(listener, SIM_DT);
    stepRadio(control, SIM_DT);

    const late = currentSegment(listener, 'khol_887');
    expect(late).not.toBeNull();
    // Same place in the broadcast as if you had never left...
    expect(late).toEqual(currentSegment(control, 'khol_887'));
    expect(segmentProgress(listener, 'khol_887')).toBeCloseTo(segmentProgress(control, 'khol_887'), 9);
    // ...and definitely not back at the start.
    expect((late as { index: number }).index).toBeGreaterThan((early as { index: number }).index);
  });

  it('starts stations mid-programme when the player switches on', () => {
    const fresh = createRadio(PROFILE, { campsiteSeed: 7 });
    const late = createRadio(PROFILE, { campsiteSeed: 7, startOffsetSeconds: 5400 });
    const a = currentSegment(fresh, 'khol_887');
    const b = currentSegment(late, 'khol_887');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect((b as { index: number }).index).toBeGreaterThan((a as { index: number }).index);
  });

  it('gives each character its own kind of night', () => {
    const kinds = (stationId: string): Record<string, number> => {
      const station = PROFILE.stations.find((s) => s.id === stationId);
      expect(station).toBeDefined();
      const counts: Record<string, number> = {};
      for (let i = 0; i < 200; i++) {
        const segment = programmeSegment(station as (typeof PROFILE.stations)[number], 1234, i);
        counts[segment.kind] = (counts[segment.kind] ?? 0) + 1;
      }
      return counts;
    };
    const lofi = kinds('khol_887');
    const service = kinds('noaa');
    const strange = kinds('gap_signal');
    // Music station is mostly music; the weather service never plays any.
    expect(lofi['music-bed'] ?? 0).toBeGreaterThan(100);
    expect(service['music-bed'] ?? 0).toBe(0);
    expect(service['spoken'] ?? 0).toBeGreaterThan(100);
    // The strange one is mostly dead air and carrier.
    expect((strange['carrier'] ?? 0) + (strange['silence'] ?? 0)).toBeGreaterThan(60);
    expect(lofi['ident'] ?? 0).toBeGreaterThan(0);
  });

  it('announces segments to the audio engine, and can look ahead for it', () => {
    const state = radio();
    tuneToStation(state, 'khol_887');
    let segments = 0;
    let locked = 0;
    for (let i = 0; i < Math.round(1800 / SIM_DT); i++) {
      stepRadio(state, SIM_DT);
      for (const event of drainRadioEvents(state)) {
        if (event.kind === 'segment') segments++;
        if (event.kind === 'locked') locked++;
      }
    }
    expect(locked).toBe(1);
    expect(segments).toBeGreaterThan(3);
    const upcoming = upcomingSegments(state, 'khol_887', 3);
    expect(upcoming).toHaveLength(3);
    const current = currentSegment(state, 'khol_887');
    expect(upcoming[0]?.index).toBe((current as { index: number }).index + 1);
  });

  it('fires locked and lost as the player tunes across a station', () => {
    const state = radio();
    tuneToStation(state, 'khol_887');
    advance(state, 2);
    let events = drainRadioEvents(state);
    expect(events.some((event) => event.kind === 'locked')).toBe(true);
    tuneTo(state, 96);
    advance(state, 1);
    events = drainRadioEvents(state);
    expect(events.some((event) => event.kind === 'lost')).toBe(true);
  });
});

describe('codes and clues', () => {
  it('are optional: a station with no codes never carries one', () => {
    const state = radio();
    tuneToStation(state, 'gap_signal');
    let codes = 0;
    for (let i = 0; i < Math.round(7200 / SIM_DT); i++) {
      stepRadio(state, SIM_DT);
      codes += drainRadioEvents(state).filter((event) => event.kind === 'code').length;
    }
    expect(codes).toBe(0);
    // And the station behaved perfectly normally without them.
    expect(currentSegment(state, 'gap_signal')).not.toBeNull();
  });

  it('ride on a broadcast when the campsite has them', () => {
    const state = createRadio(PROFILE, { campsiteSeed: 7, codes: CODES });
    setRadioPower(state, true);
    tuneToStation(state, 'gap_signal');
    const heard: string[] = [];
    for (let i = 0; i < Math.round(7200 / SIM_DT); i++) {
      stepRadio(state, SIM_DT);
      for (const event of drainRadioEvents(state)) {
        if (event.kind === 'code' && event.code) heard.push(event.code.id);
      }
    }
    expect(heard.length).toBeGreaterThan(0);
    for (const id of heard) expect(['five_groups', 'callsign']).toContain(id);
  });

  it('is not heard when the station is not actually coming through', () => {
    const state = createRadio(PROFILE, { campsiteSeed: 7, codes: CODES });
    setRadioPower(state, true);
    tuneTo(state, 104.1 + 1.2);
    let codes = 0;
    for (let i = 0; i < Math.round(3600 / SIM_DT); i++) {
      stepRadio(state, SIM_DT);
      codes += drainRadioEvents(state).filter((event) => event.kind === 'code').length;
    }
    expect(codes).toBe(0);
  });
});
