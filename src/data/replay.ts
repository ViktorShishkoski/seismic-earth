/**
 * The time machine's destinations.
 *
 * Each preset points at a bundled slice of the real USGS catalogue and says
 * where to stand, when to start the clock and how fast to run it. The speeds
 * are chosen so the physics stays watchable: waves travel on the data's clock,
 * so at 45× a front crosses a quarter of the planet in about seventeen
 * seconds instead of thirteen minutes.
 *
 * Nothing here is reconstructed or dramatised. The magnitudes, times and
 * positions are the catalogue's own, down to the foreshock two days before
 * Tōhoku that nobody could read as a warning at the time.
 */

export interface ReplayPreset {
  id: string;
  /** Short name for the button. */
  name: string;
  /** The date, as a person would say it. */
  when: string;
  /** One line of what happened and what to watch for. */
  blurb: string;
  /** Bundled catalogue slice to replay from. */
  url: string;
  /** Where the clock starts and stops (ms since epoch, UTC). */
  startMs: number;
  endMs: number;
  /** Data seconds per real second. */
  speed: number;
  /** How much of the past stays on screen as the clock runs. */
  trailingMs: number;
  /** Smallest magnitude the slice is worth showing at. */
  minMag: number;
  /** Where to put the camera. */
  camera: { lat: number; lon: number; distance: number };
}

const HOUR = 3600_000;
const utc = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);

export function replayPresets(base: string): ReplayPreset[] {
  const tohoku = `${base}data/usgs-sample-2011-tohoku.geojson`;
  const y2015 = `${base}data/usgs-sample-2015-m45.geojson`;
  const w2018 = `${base}data/usgs-sample-2018-02.geojson`;

  return [
    {
      id: 'tohoku',
      name: 'Tōhoku',
      when: '11 March 2011',
      blurb:
        'M9.0 off Honshu — the fourth largest quake ever recorded. Watch the first front reach the far side of the planet, then the aftershocks arrive in their hundreds.',
      url: tohoku,
      startMs: utc(2011, 3, 11, 5, 40),
      endMs: utc(2011, 3, 11, 10, 0),
      speed: 45,
      trailingMs: 8 * HOUR,
      minMag: 4,
      camera: { lat: 38.3, lon: 142.4, distance: 2.5 },
    },
    {
      id: 'illapel',
      name: 'Illapel',
      when: '16 September 2015',
      blurb:
        'M8.3 on the Chilean coast, where the Nazca plate dives under South America. The aftershocks trace the length of the rupture.',
      url: y2015,
      startMs: utc(2015, 9, 16, 22, 45),
      endMs: utc(2015, 9, 17, 4, 0),
      speed: 45,
      trailingMs: 12 * HOUR,
      minMag: 4.5,
      camera: { lat: -31.6, lon: -71.7, distance: 2.5 },
    },
    {
      id: 'nepal',
      name: 'Gorkha',
      when: '25 April 2015',
      blurb:
        'M7.8 under Nepal: a continental collision rather than a subduction, so the whole sequence stays shallow and the shaking reached far.',
      url: y2015,
      startMs: utc(2015, 4, 25, 6, 0),
      endMs: utc(2015, 4, 25, 12, 0),
      speed: 45,
      trailingMs: 12 * HOUR,
      minMag: 4.5,
      camera: { lat: 28.2, lon: 84.7, distance: 2.4 },
    },
    {
      id: 'hualien',
      name: 'Hualien',
      when: '6 February 2018',
      blurb:
        'M6.4 beneath eastern Taiwan, two days after an M6.1 on the same fault. Small enough that the fronts die out well before the far side.',
      url: w2018,
      startMs: utc(2018, 2, 6, 15, 40),
      endMs: utc(2018, 2, 6, 20, 0),
      speed: 30,
      trailingMs: 24 * HOUR,
      minMag: 2.5,
      camera: { lat: 24.1, lon: 121.7, distance: 2.3 },
    },
  ];
}
