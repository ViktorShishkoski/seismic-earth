import { DEFAULT_FEED, USGS_FEEDS, type FeedId } from '../data/usgs.ts';
import { DEPTH_SCALES, type DepthScale, type SunMode, type ViewMode } from './Panel.ts';

/** Everything about a view that can be shared as a link. */
export interface ViewSettings {
  feed: FeedId;
  minMag: number;
  view: ViewMode;
  depthScale: DepthScale;
  sun: SunMode;
  plates: boolean;
  waves: boolean;
  /** A replay preset to open with, if the link names one. */
  replay: string | null;
}

export const DEFAULT_SETTINGS: ViewSettings = {
  feed: DEFAULT_FEED,
  minMag: -Infinity,
  view: 'surface',
  depthScale: 1,
  sun: 'real',
  plates: true,
  waves: true,
  replay: null,
};

/** Reads `?feed=year&min=4.5&view=cutaway&dx=2&sun=studio&plates=0&waves=0&replay=tohoku`, ignoring anything invalid. */
export function parseSettings(search: string): ViewSettings {
  const p = new URLSearchParams(search);
  const s: ViewSettings = { ...DEFAULT_SETTINGS };

  const feed = p.get('feed');
  if (feed && Object.hasOwn(USGS_FEEDS, feed)) s.feed = feed as FeedId;

  const min = Number(p.get('min'));
  if (p.has('min') && p.get('min') !== '' && Number.isFinite(min)) s.minMag = min;

  if (p.get('view') === 'cutaway') s.view = 'cutaway';

  const dx = Number(p.get('dx'));
  if ((DEPTH_SCALES as readonly number[]).includes(dx)) s.depthScale = dx as DepthScale;

  if (p.get('sun') === 'studio') s.sun = 'studio';
  if (p.get('plates') === '0') s.plates = false;
  if (p.get('waves') === '0') s.waves = false;

  const replay = p.get('replay');
  if (replay) s.replay = replay;
  return s;
}

/** Writes only what differs from the defaults, so links stay short. */
export function serializeSettings(s: ViewSettings): string {
  const p = new URLSearchParams();
  p.set('feed', s.feed);
  if (Number.isFinite(s.minMag)) p.set('min', String(s.minMag));
  if (s.view !== DEFAULT_SETTINGS.view) p.set('view', s.view);
  if (s.depthScale !== DEFAULT_SETTINGS.depthScale) p.set('dx', String(s.depthScale));
  if (s.sun !== DEFAULT_SETTINGS.sun) p.set('sun', s.sun);
  if (!s.plates) p.set('plates', '0');
  if (!s.waves) p.set('waves', '0');
  if (s.replay) p.set('replay', s.replay);
  return `?${p}`;
}
