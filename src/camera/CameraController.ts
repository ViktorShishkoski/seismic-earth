import type { OrbitCamera } from './OrbitCamera.ts';

/**
 * Turns mouse, touch, pen and keyboard input into OrbitCamera calls.
 * Kept separate from the camera so the camera maths stays DOM-free and testable.
 *
 *  - One pointer drag  → rotate
 *  - Two-finger pinch  → zoom
 *  - Mouse wheel       → zoom
 *  - R                 → reset view
 *  - Space             → toggle auto-spin
 */
export class CameraController {
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private lastMoveTime = 0;
  private pinchDistance = 0;
  private readonly disposers: Array<() => void> = [];

  constructor(
    private readonly element: HTMLElement,
    private readonly camera: OrbitCamera,
  ) {
    element.style.touchAction = 'none'; // we handle pinch and pan ourselves

    this.listen(element, 'pointerdown', this.onPointerDown);
    this.listen(element, 'pointermove', this.onPointerMove);
    this.listen(element, 'pointerup', this.onPointerUp);
    this.listen(element, 'pointercancel', this.onPointerUp);
    this.listen(element, 'wheel', this.onWheel, { passive: false });
    this.listen(window, 'keydown', this.onKeyDown);
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
  }

  private listen<E extends Event>(
    target: EventTarget,
    type: string,
    handler: (event: E) => void,
    options?: AddEventListenerOptions,
  ): void {
    const bound = handler.bind(this) as EventListener;
    target.addEventListener(type, bound, options);
    this.disposers.push(() => target.removeEventListener(type, bound, options));
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    this.element.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.lastMoveTime = event.timeStamp;

    if (this.pointers.size === 1) {
      this.camera.beginDrag();
      this.element.classList.add('dragging');
    } else if (this.pointers.size === 2) {
      this.pinchDistance = this.currentPinchDistance();
    }
  }

  private onPointerMove(event: PointerEvent): void {
    const previous = this.pointers.get(event.pointerId);
    if (!previous) return;
    const current = { x: event.clientX, y: event.clientY };
    this.pointers.set(event.pointerId, current);

    if (this.pointers.size === 1) {
      const dt = Math.max((event.timeStamp - this.lastMoveTime) / 1000, 1 / 240);
      this.lastMoveTime = event.timeStamp;
      this.camera.drag(current.x - previous.x, current.y - previous.y, this.element.clientHeight, dt);
    } else if (this.pointers.size === 2) {
      const distance = this.currentPinchDistance();
      if (this.pinchDistance > 0 && distance > 0) {
        this.camera.zoomBy(this.pinchDistance / distance);
      }
      this.pinchDistance = distance;
    }
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.pointers.delete(event.pointerId)) return;
    if (this.element.hasPointerCapture(event.pointerId)) {
      this.element.releasePointerCapture(event.pointerId);
    }

    if (this.pointers.size === 0) {
      // If the pointer rested for a moment before release, don't fling.
      const stale = event.timeStamp - this.lastMoveTime > 80;
      this.camera.endDrag(stale);
      this.element.classList.remove('dragging');
    } else if (this.pointers.size === 1) {
      // Pinch ended with one finger still down: continue as a drag without a jump.
      this.lastMoveTime = event.timeStamp;
      this.camera.beginDrag();
    }
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    // Normalise line/page scrolling to pixels, then zoom exponentially.
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    const delta = Math.max(-200, Math.min(200, event.deltaY * scale));
    this.camera.zoomBy(Math.exp(delta * 0.0015));
  }

  private onKeyDown(event: KeyboardEvent): void {
    const t = event.target;
    const typing = t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(t.type));
    if (typing) return;
    if (event.key === 'r' || event.key === 'R') {
      this.camera.reset();
    } else if (event.key === ' ') {
      // Space on a focused button or checkbox activates it; only toggle the spin otherwise.
      if (t instanceof HTMLButtonElement || t instanceof HTMLInputElement) return;
      event.preventDefault();
      this.camera.autoSpin = !this.camera.autoSpin;
    }
  }

  private currentPinchDistance(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
}
