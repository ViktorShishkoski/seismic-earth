import { describe, expect, it } from 'vitest';
import {
  MAX_DISTANCE_DEG,
  MAX_TRAVEL_SEC,
  P_TRAVEL_SEC,
  S_TRAVEL_SEC,
  TRAVEL_TIME_STEP_DEG,
  packTravelTable,
  pArrivalSec,
  pSpeedKmS,
  sArrivalSec,
  waveFrontDeg,
} from '../src/geo/travelTime.ts';

describe('seismic travel times', () => {
  it('matches the textbook figures a seismologist would recognise', () => {
    // P crosses a quarter of the planet in about 13 minutes.
    expect(pArrivalSec(90) / 60).toBeCloseTo(12.9, 1);
    // S takes nearly twice as long over the same distance.
    expect(sArrivalSec(90) / 60).toBeCloseTo(23.8, 1);
    // At 100° the classic S/P ratio is about 1.8.
    expect(sArrivalSec(100) / pArrivalSec(100)).toBeCloseTo(1.84, 2);
  });

  it('has S always slower than P, and both always later with distance', () => {
    for (let d = 0; d <= MAX_DISTANCE_DEG; d += 1) {
      expect(sArrivalSec(d)).toBeGreaterThan(pArrivalSec(d));
      if (d > 0) {
        expect(pArrivalSec(d)).toBeGreaterThan(pArrivalSec(d - 1));
        expect(sArrivalSec(d)).toBeGreaterThan(sArrivalSec(d - 1));
      }
    }
  });

  it('speeds up with distance, because deeper rock carries waves faster', () => {
    // A ray to 20° stays in the upper mantle; one to 100° dives through the
    // lower mantle, where it travels much faster.
    expect(pSpeedKmS(20)).toBeGreaterThan(7);
    expect(pSpeedKmS(20)).toBeLessThan(10);
    expect(pSpeedKmS(100)).toBeGreaterThan(pSpeedKmS(20) * 1.3);
  });

  it('interpolates between samples and clamps outside the table', () => {
    expect(pArrivalSec(0)).toBe(P_TRAVEL_SEC[0]);
    expect(pArrivalSec(5)).toBe(P_TRAVEL_SEC[1]);
    // Halfway between the 5° and 10° samples.
    expect(pArrivalSec(7.5)).toBeCloseTo((P_TRAVEL_SEC[1]! + P_TRAVEL_SEC[2]!) / 2, 9);
    expect(pArrivalSec(-3)).toBe(P_TRAVEL_SEC[0]);
    expect(pArrivalSec(400)).toBe(P_TRAVEL_SEC.at(-1));
    expect(MAX_TRAVEL_SEC).toBe(S_TRAVEL_SEC.at(-1));
  });

  it('inverts the table: the front sits where the arrival time says it should', () => {
    for (const distance of [0, 12, 33.3, 57, 90, 104]) {
      expect(waveFrontDeg(P_TRAVEL_SEC, pArrivalSec(distance))).toBeCloseTo(distance, 6);
      expect(waveFrontDeg(S_TRAVEL_SEC, sArrivalSec(distance))).toBeCloseTo(distance, 6);
    }
  });

  it('has the P front always ahead of the S front', () => {
    for (let t = 20; t < MAX_TRAVEL_SEC; t += 20) {
      expect(waveFrontDeg(P_TRAVEL_SEC, t)).toBeGreaterThanOrEqual(waveFrontDeg(S_TRAVEL_SEC, t));
    }
  });

  it('stops at the edge of the table, where the core casts P into shadow', () => {
    expect(MAX_DISTANCE_DEG).toBe(105);
    expect(waveFrontDeg(P_TRAVEL_SEC, 1e6)).toBe(MAX_DISTANCE_DEG);
    expect(waveFrontDeg(P_TRAVEL_SEC, 0)).toBe(0);
  });

  it('packs the same numbers for the GPU as the CPU reads', () => {
    const packed = packTravelTable();
    expect(packed.length).toBe(P_TRAVEL_SEC.length * 4);
    for (let i = 0; i < P_TRAVEL_SEC.length; i++) {
      // Float32 on the way to the GPU, so compare to within its precision.
      expect(packed[i * 4]).toBeCloseTo(P_TRAVEL_SEC[i]!, 3);
      expect(packed[i * 4 + 1]).toBeCloseTo(S_TRAVEL_SEC[i]!, 3);
    }
    expect(TRAVEL_TIME_STEP_DEG * (P_TRAVEL_SEC.length - 1)).toBe(MAX_DISTANCE_DEG);
  });

  it('tells you how long to watch a quake for', () => {
    // 26 minutes: after that even the S wave has left the table behind.
    expect(MAX_TRAVEL_SEC / 60).toBeCloseTo(25.9, 1);
  });
});
