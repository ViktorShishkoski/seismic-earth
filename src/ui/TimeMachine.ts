import type { ReplayPreset } from '../data/replay.ts';
import { byId } from './Panel.ts';
import { escapeHtml, formatDataClock } from './format.ts';

export const REPLAY_SPEEDS = [1, 15, 45, 120] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export interface TimeMachineCallbacks {
  onReplay(preset: ReplayPreset): void;
  onPlayPause(): void;
  onSeek(progress: number): void;
  onSpeed(speed: number): void;
  onLive(): void;
}

/**
 * The time machine: a list of events to revisit in the panel, and a transport
 * bar along the bottom that appears only while a replay is running.
 *
 * The clock reads in UTC and at full precision, because the whole display
 * hangs off it — the wavefronts in particular are drawn from the gap between
 * this clock and each quake's origin time.
 */
export class TimeMachine {
  private readonly bar = byId('replay-bar');
  private readonly playButton = byId<HTMLButtonElement>('replay-play');
  private readonly seek = byId<HTMLInputElement>('replay-seek');
  private readonly clock = byId('replay-clock');
  private readonly title = byId('replay-title');
  private readonly blurb = byId('replay-blurb');
  private scrubbing = false;

  constructor(presets: readonly ReplayPreset[], callbacks: TimeMachineCallbacks) {
    const grid = byId('replay-buttons');
    grid.innerHTML = presets
      .map(
        (p) => `<button type="button" data-replay="${escapeHtml(p.id)}" title="${escapeHtml(p.blurb)}">
          <strong>${escapeHtml(p.name)}</strong><span>${escapeHtml(p.when)}</span></button>`,
      )
      .join('');
    grid.addEventListener('click', (event) => {
      const id = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-replay]')?.dataset.replay;
      const preset = presets.find((p) => p.id === id);
      if (preset) callbacks.onReplay(preset);
    });

    const speeds = byId('replay-speeds');
    speeds.innerHTML = REPLAY_SPEEDS.map(
      (s) => `<button type="button" role="radio" data-speed="${s}" title="${s} seconds of history per second">×${s}</button>`,
    ).join('');
    speeds.addEventListener('click', (event) => {
      const value = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-speed]')?.dataset.speed;
      if (value) callbacks.onSpeed(Number(value));
    });

    this.playButton.addEventListener('click', () => callbacks.onPlayPause());
    byId('replay-live').addEventListener('click', () => callbacks.onLive());

    // While the thumb is held the clock follows the pointer, not the replay.
    this.seek.addEventListener('pointerdown', () => (this.scrubbing = true));
    this.seek.addEventListener('pointerup', () => (this.scrubbing = false));
    this.seek.addEventListener('input', () => callbacks.onSeek(Number(this.seek.value) / 1000));
    this.seek.addEventListener('change', () => (this.scrubbing = false));
  }

  /** Opens the bar for a preset and marks its button active. */
  show(preset: ReplayPreset): void {
    this.bar.hidden = false;
    this.title.textContent = `${preset.name} · ${preset.when}`;
    this.blurb.textContent = preset.blurb;
    this.setSpeed(preset.speed);
    mark('replay-buttons', 'replay', preset.id);
  }

  hide(): void {
    this.bar.hidden = true;
    mark('replay-buttons', 'replay', '');
  }

  setPlaying(playing: boolean, finished = false): void {
    this.playButton.textContent = finished ? '↻' : playing ? '❙❙' : '▶';
    this.playButton.setAttribute(
      'aria-label',
      finished ? 'Replay again' : playing ? 'Pause the replay' : 'Resume the replay',
    );
  }

  setSpeed(speed: number): void {
    mark('replay-speeds', 'speed', String(speed));
  }

  /** Called every frame while replaying. */
  update(nowMs: number, progress: number): void {
    this.clock.textContent = `${formatDataClock(nowMs)} UTC`;
    if (!this.scrubbing) this.seek.value = String(Math.round(progress * 1000));
  }
}

function mark(groupId: string, key: string, value: string): void {
  for (const button of byId(groupId).querySelectorAll<HTMLButtonElement>(`button[data-${key}]`)) {
    const active = button.dataset[key] === value;
    button.setAttribute('aria-checked', String(active));
    button.classList.toggle('active', active);
  }
}
