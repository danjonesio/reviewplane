/**
 * The live-frame scheduler: pure decisions, no browser and no transport.
 *
 * `docs/API.md` section 18.2 leaves the worker scheduler authoritative over
 * quality, and `docs/ARCHITECTURE.md` section 6.3 fixes the two bands it may
 * move within — 10 to 20 frames per second for an open session room, 2 to 5
 * for the low-rate thumbnail mode — and requires quality and dimensions to
 * adapt to bandwidth. Those are arithmetic rules, so they live here as
 * functions over a plain state value rather than inside the CDP plumbing,
 * which is the only way the band can be asserted without a browser.
 *
 * The rule the tests pin down is that no input moves the scheduler outside its
 * band. A viewer may lower its own ceiling; it cannot raise the band's, and it
 * cannot select a rate the mode does not permit.
 */

import type { LiveMode, QualityReason, QualityState } from "@reviewplane/protocol/live-view";

/** Inclusive bounds of one mode, from `docs/ARCHITECTURE.md` section 6.3. */
export interface ModeBand {
  readonly minFps: number;
  readonly maxFps: number;
  readonly startFps: number;
  readonly minQuality: number;
  readonly maxQuality: number;
  readonly startQuality: number;
  /** Largest payload edge, as a fraction of the capture size. */
  readonly minScale: number;
  readonly maxScale: number;
  readonly startScale: number;
}

export const MODE_BANDS: Readonly<Record<LiveMode, ModeBand>> = {
  session_room: {
    minFps: 10,
    maxFps: 20,
    startFps: 15,
    minQuality: 35,
    maxQuality: 80,
    startQuality: 65,
    minScale: 0.5,
    maxScale: 1,
    startScale: 1,
  },
  thumbnail: {
    minFps: 2,
    maxFps: 5,
    startFps: 3,
    minQuality: 25,
    maxQuality: 60,
    startQuality: 45,
    minScale: 0.2,
    maxScale: 0.5,
    startScale: 0.33,
  },
};

export interface CaptureBounds {
  readonly width: number;
  readonly height: number;
}

export interface SchedulerDecision {
  readonly mode: LiveMode;
  readonly targetFps: number;
  readonly quality: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly reason: QualityReason;
}

/** What the last adaptation window observed. */
export interface WindowObservation {
  readonly delivered: number;
  readonly dropped: number;
  /** Frames waiting in the bounded buffer at the end of the window. */
  readonly bufferDepth: number;
}

/** A viewer's advisory request. Every field is optional and none is binding. */
export interface ViewerPreference {
  readonly mode?: LiveMode;
  readonly maxFps?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Drop rate above which the scheduler steps down. Ten per cent is chosen so a
 * single late write does not provoke an adaptation, while a viewer that is
 * genuinely behind is answered within one window.
 */
export const STEP_DOWN_DROP_RATE = 0.1;

export class LiveScheduler {
  #mode: LiveMode;
  #fps: number;
  #quality: number;
  #scale: number;
  #reason: QualityReason = "initial";
  #capture: CaptureBounds;
  #preference: ViewerPreference = {};

  constructor(mode: LiveMode, capture: CaptureBounds) {
    const band = MODE_BANDS[mode];
    this.#mode = mode;
    this.#fps = band.startFps;
    this.#quality = band.startQuality;
    this.#scale = band.startScale;
    this.#capture = capture;
  }

  get mode(): LiveMode {
    return this.#mode;
  }

  get targetFps(): number {
    return this.#fps;
  }

  /** Minimum milliseconds between two delivered frames at the current rate. */
  get frameIntervalMs(): number {
    return Math.floor(1000 / this.#fps);
  }

  /** The capture the session currently renders at, in device pixels. */
  setCaptureBounds(capture: CaptureBounds): void {
    this.#capture = capture;
  }

  decision(): SchedulerDecision {
    const band = MODE_BANDS[this.#mode];
    const scale = clamp(this.#scale, band.minScale, band.maxScale);
    let width = Math.max(1, Math.round(this.#capture.width * scale));
    let height = Math.max(1, Math.round(this.#capture.height * scale));
    // A viewer may ask for something smaller than the scheduler chose: sending
    // more pixels than a viewer can display is waste, and honouring a smaller
    // request cannot be used to demand more work from the worker.
    if (this.#preference.maxWidth !== undefined && this.#preference.maxWidth < width) {
      const ratio = this.#preference.maxWidth / width;
      width = Math.max(1, this.#preference.maxWidth);
      height = Math.max(1, Math.round(height * ratio));
    }
    if (this.#preference.maxHeight !== undefined && this.#preference.maxHeight < height) {
      const ratio = this.#preference.maxHeight / height;
      height = Math.max(1, this.#preference.maxHeight);
      width = Math.max(1, Math.round(width * ratio));
    }
    let fps = clamp(this.#fps, band.minFps, band.maxFps);
    if (this.#preference.maxFps !== undefined) {
      // Lowering below the band's floor is permitted, because a viewer that
      // cannot consume the floor is better served slowly than not at all.
      fps = Math.min(fps, Math.max(1, this.#preference.maxFps));
    }
    return {
      mode: this.#mode,
      targetFps: fps,
      quality: clamp(this.#quality, band.minQuality, band.maxQuality),
      maxWidth: width,
      maxHeight: height,
      reason: this.#reason,
    };
  }

  /** Records a viewer request. Advisory: it never leaves the mode's band. */
  request(preference: ViewerPreference): boolean {
    const previous = JSON.stringify(this.decision());
    if (preference.mode !== undefined && preference.mode !== this.#mode) {
      const band = MODE_BANDS[preference.mode];
      this.#mode = preference.mode;
      this.#fps = band.startFps;
      this.#quality = band.startQuality;
      this.#scale = band.startScale;
      this.#reason = "mode_changed";
    } else {
      this.#reason = "viewer_requested";
    }
    this.#preference = {
      ...(preference.maxFps === undefined ? {} : { maxFps: preference.maxFps }),
      ...(preference.maxWidth === undefined ? {} : { maxWidth: preference.maxWidth }),
      ...(preference.maxHeight === undefined ? {} : { maxHeight: preference.maxHeight }),
    };
    return JSON.stringify(this.decision()) !== previous;
  }

  /**
   * Applies one adaptation window. Returns true when the decision changed, so
   * the caller only republishes a quality message when there is news.
   */
  adapt(observation: WindowObservation): boolean {
    const band = MODE_BANDS[this.#mode];
    const total = observation.delivered + observation.dropped;
    const dropRate = total === 0 ? 0 : observation.dropped / total;
    const previous = JSON.stringify(this.decision());

    if (dropRate > STEP_DOWN_DROP_RATE || observation.bufferDepth > 1) {
      // Fewer, newer frames: the rate falls first, then quality, then size.
      this.#fps = clamp(this.#fps - 2, band.minFps, band.maxFps);
      this.#quality = clamp(this.#quality - 10, band.minQuality, band.maxQuality);
      if (this.#fps === band.minFps && this.#quality === band.minQuality) {
        this.#scale = clamp(this.#scale - 0.15, band.minScale, band.maxScale);
      }
      this.#reason = "viewer_falling_behind";
    } else if (dropRate === 0 && observation.bufferDepth === 0 && total > 0) {
      this.#scale = clamp(this.#scale + 0.1, band.minScale, band.maxScale);
      this.#quality = clamp(this.#quality + 5, band.minQuality, band.maxQuality);
      this.#fps = clamp(this.#fps + 1, band.minFps, band.maxFps);
      this.#reason = "viewer_keeping_up";
    } else {
      return false;
    }
    return JSON.stringify(this.decision()) !== previous;
  }

  /** The decision rendered as the protocol's quality message payload. */
  state(now: Date): QualityState {
    const decision = this.decision();
    return {
      mode: decision.mode,
      target_fps: decision.targetFps,
      quality: decision.quality,
      max_width: decision.maxWidth,
      max_height: decision.maxHeight,
      reason: decision.reason,
      decided_at: now.toISOString(),
    };
  }
}

/** Whether a rate is inside the band `docs/ARCHITECTURE.md` section 6.3 fixes. */
export function withinBand(mode: LiveMode, fps: number): boolean {
  const band = MODE_BANDS[mode];
  return fps >= band.minFps && fps <= band.maxFps;
}
