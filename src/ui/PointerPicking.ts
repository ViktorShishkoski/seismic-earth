/**
 * Turns pointer movement into hover picks and short taps into click picks,
 * without interfering with the camera drag (a drag is not a click).
 */
export interface PickingCallbacks {
  /** Index of the marker under (x, y) in CSS pixels relative to the canvas, or −1. */
  pick(x: number, y: number): number;
  onHover(index: number, clientX: number, clientY: number): void;
  onClick(index: number): void;
}

const CLICK_SLOP_PX = 5;
const CLICK_MAX_MS = 600;

export class PointerPicking {
  private down: { x: number; y: number; t: number; id: number } | null = null;
  private pending: { x: number; y: number } | null = null;
  private frame = 0;
  private buttonsDown = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: PickingCallbacks,
  ) {
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('pointercancel', this.onLeave);
  }

  private readonly onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return; // no hover on touch screens
    this.buttonsDown = e.buttons !== 0;
    this.pending = { x: e.clientX, y: e.clientY };
    if (!this.frame) this.frame = requestAnimationFrame(this.flushHover); // at most one pick per frame
  };

  private readonly flushHover = () => {
    this.frame = 0;
    const p = this.pending;
    if (!p) return;
    if (this.buttonsDown) {
      this.callbacks.onHover(-1, p.x, p.y); // hide hover while dragging
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    this.callbacks.onHover(this.callbacks.pick(p.x - rect.left, p.y - rect.top), p.x, p.y);
  };

  private readonly onDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId };
  };

  private readonly onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || d.id !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (moved > CLICK_SLOP_PX || e.timeStamp - d.t > CLICK_MAX_MS) return;
    const rect = this.canvas.getBoundingClientRect();
    this.callbacks.onClick(this.callbacks.pick(e.clientX - rect.left, e.clientY - rect.top));
  };

  private readonly onLeave = () => {
    this.pending = null;
    this.callbacks.onHover(-1, 0, 0);
  };
}
