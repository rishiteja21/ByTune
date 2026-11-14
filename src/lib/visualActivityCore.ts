/** Explicitly owned visual work only. No audio clocks or global animation scan. */
export function createVisualActivity(initiallyActive = false) {
  let active = initiallyActive;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const getSnapshot = (): boolean => active;
  const setActive = (next: boolean): void => {
    if (active === next) return;
    active = next;
    for (const listener of [...listeners]) listener();
  };

  /** Resume only a pause we own; preserve the Animation and its currentTime. */
  const registerAnimation = (animation: Animation): (() => void) => {
    let pausedHere = false;
    const update = (): void => {
      if (!active && animation.playState === "running") {
        animation.pause();
        pausedHere = true;
      } else if (active && pausedHere) {
        pausedHere = false;
        if (animation.playState === "paused") animation.play();
      }
    };
    const off = subscribe(update);
    update();
    return off;
  };

  /** One outstanding frame, with zero elapsed background time on resume. */
  const runFrames = (
    tick: (now: number, elapsed: number) => void | false,
    frames = { request: (cb: FrameRequestCallback) => requestAnimationFrame(cb), cancel: (id: number) => cancelAnimationFrame(id) },
  ): (() => void) => {
    let disposed = false;
    let frame: number | null = null;
    let last: number | null = null;
    const stop = (): void => {
      if (frame !== null) frames.cancel(frame);
      frame = null;
      last = null;
    };
    const step = (now: number): void => {
      frame = null;
      if (disposed || !active) return;
      const elapsed = last === null ? 0 : now - last;
      last = now;
      if (tick(now, elapsed) === false) { dispose(); return; }
      if (!disposed && active && frame === null) frame = frames.request(step);
    };
    const update = (): void => {
      if (!active) stop();
      else if (!disposed && frame === null) frame = frames.request(step);
    };
    const off = subscribe(update);
    const dispose = (): void => { disposed = true; stop(); off(); };
    update();
    return dispose;
  };

  /** Muted artwork video, never a playback element. Guard asynchronous play too. */
  const registerVideo = (video: HTMLVideoElement, wantsPlay: () => boolean): (() => void) => {
    const update = (): void => {
      if (active && wantsPlay()) {
        if (video.paused) void video.play().catch(() => undefined);
      } else video.pause();
    };
    const off = subscribe(update);
    video.addEventListener("play", update);
    update();
    return () => { off(); video.removeEventListener("play", update); video.pause(); };
  };

  return { getSnapshot, subscribe, setActive, registerAnimation, runFrames, registerVideo };
}
