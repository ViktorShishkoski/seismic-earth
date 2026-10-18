import { describe, expect, it } from 'vitest';
import { feedUrl, parseUsgsFeed } from '../src/data/usgs.ts';
// Real USGS features (1–7 Feb 2018 "all week" feed) plus three deliberately broken ones.
import fixture from './fixtures/usgs-week-subset.json';

describe('parseUsgsFeed', () => {
  const result = parseUsgsFeed(fixture);

  it('keeps valid features and counts the broken ones', () => {
    expect(result.quakes).toHaveLength(10);
    expect(result.skipped).toBe(3);
  });

  it('reads GeoJSON coordinates as [lon, lat, depth] (not lat, lon)', () => {
    const hualien = result.quakes.find((q) => q.id === 'us1000chhc')!;
    expect(hualien.lat).toBeCloseTo(24.1737, 4); // Taiwan is ~24° N …
    expect(hualien.lon).toBeCloseTo(121.653, 3); // … ~121° E
    expect(hualien.depthKm).toBeCloseTo(10.64, 2);
    expect(hualien.mag).toBe(6.4);
    expect(hualien.place).toBe('22km NNE of Hualian, Taiwan');
    expect(hualien.url).toContain('us1000chhc');
  });

  it('keeps the edge cases real feeds contain', () => {
    expect(result.quakes.some((q) => q.depthKm < 0)).toBe(true); // above sea level
    expect(result.quakes.some((q) => q.mag < 0)).toBe(true); // tiny local magnitudes
    expect(result.quakes.filter((q) => q.type === 'explosion')).toHaveLength(2);
  });

  it('reads the feed metadata', () => {
    expect(result.generated).toBe(1517968154000);
    expect(result.title).toContain('Past Week');
  });

  it('rejects input that is not a FeatureCollection', () => {
    expect(() => parseUsgsFeed(null)).toThrow();
    expect(() => parseUsgsFeed({ type: 'Feature' })).toThrow();
    expect(() => parseUsgsFeed('<html>error page</html>')).toThrow();
  });

  it('maps tsunami flags and missing optional fields safely', () => {
    const parsed = parseUsgsFeed({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'x1',
          properties: { mag: 7.1, time: 1, tsunami: 1 },
          geometry: { type: 'Point', coordinates: [142.4, 38.3] },
        },
      ],
    });
    const q = parsed.quakes[0]!;
    expect(q.tsunami).toBe(true);
    expect(q.depthKm).toBe(0); // no depth given
    expect(q.felt).toBeNull();
    expect(q.status).toBe('automatic');
  });
});

describe('feedUrl', () => {
  it('builds the documented USGS summary URLs', () => {
    expect(feedUrl('day')).toBe('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson');
    expect(feedUrl('month')).toBe('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson');
  });
});
