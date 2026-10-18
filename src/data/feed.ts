import type { StoreDiff } from './QuakeStore.ts';
import type { FeedId } from './usgs.ts';

/**
 * The app can get its earthquakes two ways, and does not care which:
 *
 *  - **Relay** — the Node service in `server/`, which merges EMSC's push
 *    stream with USGS and sends changes the moment they happen.
 *  - **Direct** — the browser polling USGS itself, which needs no server and
 *    is what the deployed demo uses.
 *
 * Both implement this interface, so `main.ts` picks one at start-up and
 * nothing downstream changes.
 */

export type FeedMode = 'loading' | 'live' | 'sample' | 'replay';
export type FeedTransport = 'relay' | 'usgs';

/** What the relay says about itself, mirrored for the status line. */
export interface RelayInfo {
  connected: boolean;
  /** Per-network health, newest first in the order the relay lists them. */
  sources: Array<{ name: string; mode: 'stream' | 'poll'; connected: boolean; received: number; lastError: string | null }>;
  /** Events confirmed by more than one network. */
  merged: number;
  /** Total events the relay is holding. */
  events: number;
}

export interface FeedStatus {
  feed: FeedId;
  mode: FeedMode;
  transport: FeedTransport;
  /** When the source generated the data on screen (ms since epoch). */
  generated: number | null;
  /** When we last heard from the source (ms since epoch, local clock). */
  fetchedAt: number | null;
  /** When the next poll is due (ms since epoch); null for a pushed stream. */
  nextRefreshAt: number | null;
  lastError: string | null;
  relay?: RelayInfo;
}

export interface FeedSnapshotEvent {
  diff: StoreDiff;
  /** True for the first load after start or a window change (nothing is "new" yet). */
  initial: boolean;
}

export interface QuakeFeed {
  readonly status: FeedStatus;
  onSnapshot(listener: (event: FeedSnapshotEvent) => void): () => void;
  onStatus(listener: (status: FeedStatus) => void): () => void;
  start(feed?: FeedId): Promise<void>;
  refresh(): Promise<void>;
  stop(): void;
  dispose(): void;
}

/** Where the relay is, if anywhere. */
export function relayUrl(search = location.search, origin = location.hostname): string | null {
  const fromQuery = new URLSearchParams(search).get('relay');
  if (fromQuery !== null) return fromQuery === '' || fromQuery === 'off' ? null : fromQuery;
  const configured = import.meta.env?.VITE_RELAY_URL;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  // Only look for a relay while developing. The deployed demo is a static site
  // with no server behind it, and every visitor firing a doomed request at
  // their own machine would be noise.
  const local = origin === 'localhost' || origin === '127.0.0.1' || origin === '[::1]';
  return local ? 'http://localhost:8787' : null;
}

/** Is a relay actually running there? Fails fast so start-up is never held up. */
export async function relayAvailable(url: string, timeoutMs = 1_500): Promise<boolean> {
  try {
    const response = await fetch(new URL('/health', url), {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

/** `http://host:8787` → `ws://host:8787/live` */
export function liveSocketUrl(url: string): string {
  const parsed = new URL('/live', url);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return parsed.toString();
}
