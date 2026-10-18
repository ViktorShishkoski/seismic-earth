/** Small on-screen stats panel and the "WebGPU unavailable" screen. */

export class FrameStats {
  private frames = 0;
  private elapsed = 0;
  private cpuMs = 0;

  constructor(
    private readonly fpsEl: HTMLElement | null,
    private readonly msEl: HTMLElement | null,
    private readonly intervalSec = 0.5,
  ) {}

  /** `dt` = seconds since the last frame; `cpuMs` = time spent building this frame. */
  tick(dt: number, cpuMs: number): void {
    this.frames++;
    this.elapsed += dt;
    this.cpuMs += cpuMs;
    if (this.elapsed >= this.intervalSec) {
      const fps = this.frames / this.elapsed;
      if (this.fpsEl) this.fpsEl.textContent = fps.toFixed(0);
      if (this.msEl) this.msEl.textContent = `${(1000 / fps).toFixed(1)} ms (cpu ${(this.cpuMs / this.frames).toFixed(2)})`;
      this.frames = 0;
      this.elapsed = 0;
      this.cpuMs = 0;
    }
  }
}

export function describeAdapter(info: GPUAdapterInfo): string {
  const parts = [info.vendor, info.architecture].filter((p) => p && p.length > 0);
  return parts.length > 0 ? parts.join(' · ') : 'WebGPU';
}

export function showFallback(reason: string): void {
  const overlay = document.getElementById('fallback');
  const reasonEl = document.getElementById('fallback-reason');
  if (reasonEl) reasonEl.textContent = reason;
  if (overlay) overlay.hidden = false;
}
