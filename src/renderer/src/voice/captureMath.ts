/**
 * Voice V1 — pure capture math (docs/research/2026-07-02-voice-to-text, SPEC §4).
 *
 * Everything the AudioWorklet processor (`captureWorklet.ts`) computes lives here as plain
 * functions/classes with NO worklet globals, because the worklet global scope does not exist
 * under vitest — this module is the unit-testable half, the worklet file is a thin shell.
 *
 * Pipeline shape: AudioContext-rate float32 quanta (128 samples) → linear-interpolation
 * downsample to 16 kHz → Int16 PCM → accumulate ~120 ms frames (1920 samples / 3840 bytes)
 * + a per-frame RMS level. The silent-zeros watchdog (electron#42714: a missing OS mic grant
 * yields a LIVE all-zeros stream, not an error) also lives here — it counts consecutive
 * exactly-zero-RMS frames on the renderer side (`useVoiceCapture`).
 */

/** The STT engine contract rate (sherpa streaming zipformer models are 16 kHz). */
export const TARGET_SAMPLE_RATE = 16000
/** Samples per emitted frame at 16 kHz — 120 ms → ~8.3 frames/s. */
export const FRAME_SAMPLES = 1920
/** Bytes per emitted Int16 frame. */
export const FRAME_BYTES = FRAME_SAMPLES * 2
/**
 * Consecutive exactly-zero-RMS frames before the watchdog flags `micSilent` (~3 s at
 * 120 ms/frame). A real mic never produces sustained EXACT digital zeros — only the
 * missing-OS-grant stream does — so the threshold just has to outlast start-up quiet.
 */
export const SILENT_FRAMES_THRESHOLD = 25

/**
 * Streaming linear-interpolation resampler (inRate → outRate, mono). Keeps a fractional
 * read position + the previous chunk's last sample so output is continuous across
 * arbitrary chunk boundaries (worklet quanta are 128 samples; any size works).
 */
export class LinearResampler {
  /** Source samples advanced per output sample (e.g. 3 for 48 k → 16 k). */
  private readonly step: number
  /** Fractional source index of the NEXT output sample, relative to the incoming chunk's [0]. */
  private nextSrc = 0
  /** Last sample of the previous chunk — source index -1 for the incoming chunk. */
  private prev = 0
  private hasPrev = false

  constructor(inRate: number, outRate: number = TARGET_SAMPLE_RATE) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error(`bad resample rates ${inRate}→${outRate}`)
    this.step = inRate / outRate
  }

  /** Consume one input chunk; returns every output sample now computable. */
  push(input: Float32Array): Float32Array {
    if (input.length === 0) return new Float32Array(0)
    const last = input.length - 1
    // k outputs exist where nextSrc + k*step <= last (each needs its ceil() neighbour in-chunk).
    const count = this.nextSrc > last ? 0 : Math.floor((last - this.nextSrc) / this.step) + 1
    const out = new Float32Array(count)
    let src = this.nextSrc
    for (let k = 0; k < count; k++) {
      const i = Math.floor(src)
      const frac = src - i
      if (i < 0) {
        // Between the previous chunk's tail (index -1) and input[0]; frac ∈ (0, 1) here.
        out[k] = this.hasPrev ? this.prev + (input[0] - this.prev) * (src + 1) : input[0]
      } else if (frac === 0) {
        out[k] = input[i]
      } else {
        out[k] = input[i] + (input[i + 1] - input[i]) * frac
      }
      src += this.step
    }
    this.nextSrc = src - input.length
    this.prev = input[last]
    this.hasPrev = true
    return out
  }
}

/** Clamp + convert normalized float32 samples to Int16 PCM (asymmetric 0x8000/0x7fff scale). */
export function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff)
  }
  return out
}

/** RMS of an Int16 frame, normalized back to 0..1 (drives the pill level bars). */
export function frameRms(frame: Int16Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i] / 0x8000
    sum += s * s
  }
  return Math.sqrt(sum / frame.length)
}

/**
 * Posted from the worklet processor to the AudioWorkletNode port once per completed frame.
 * Declared here (not in captureWorklet.ts) so consumers never import the worklet module —
 * a value import would run `registerProcessor` in window scope and throw.
 */
export interface WorkletFrameMsg {
  /** FRAME_SAMPLES Int16 samples (FRAME_BYTES bytes) at 16 kHz — transferred, not copied. */
  frame: ArrayBuffer
  /** Normalized 0..1 RMS of the frame (level bars + silent-zeros watchdog). */
  rms: number
}

export interface CaptureFrame {
  /** Exactly FRAME_SAMPLES Int16 samples — its .buffer is safe to transfer (the
   *  `<ArrayBuffer>` parameter pins it as non-shared, i.e. Transferable). */
  frame: Int16Array<ArrayBuffer>
  /** Normalized 0..1 RMS of this frame. */
  rms: number
}

export interface CapturePipeline {
  /** Feed one mono float32 chunk; returns zero or more completed 120 ms frames. */
  push(chunk: Float32Array): CaptureFrame[]
}

/**
 * The full worklet-side pipeline: resample `inRate` → 16 kHz, convert to Int16, cut into
 * FRAME_SAMPLES frames. Emits only COMPLETED frames (~every 45 quanta at 48 kHz) so the
 * worklet never posts per-quantum (sharp edge #7: IPC storm).
 */
export function createCapturePipeline(
  inRate: number,
  frameSamples: number = FRAME_SAMPLES
): CapturePipeline {
  const resampler = new LinearResampler(inRate, TARGET_SAMPLE_RATE)
  const pending = new Int16Array(frameSamples)
  let fill = 0
  return {
    push(chunk) {
      const pcm = floatTo16BitPCM(resampler.push(chunk))
      const out: CaptureFrame[] = []
      let offset = 0
      while (offset < pcm.length) {
        const take = Math.min(frameSamples - fill, pcm.length - offset)
        pending.set(pcm.subarray(offset, offset + take), fill)
        fill += take
        offset += take
        if (fill === frameSamples) {
          const frame = pending.slice() // fresh copy → transferable without corrupting `pending`
          out.push({ frame, rms: frameRms(frame) })
          fill = 0
        }
      }
      return out
    }
  }
}

export interface SilenceWatchdog {
  /** Feed one frame's RMS; returns the CURRENT silent verdict (true once tripped). */
  push(rms: number): boolean
  reset(): void
}

/**
 * Silent-zeros watchdog counter (electron#42714). Trips after `threshold` CONSECUTIVE
 * exactly-zero-RMS frames; any non-zero frame clears it immediately (real audio resumed —
 * e.g. the user granted the OS permission mid-session).
 */
export function createSilenceWatchdog(
  threshold: number = SILENT_FRAMES_THRESHOLD
): SilenceWatchdog {
  let zeros = 0
  return {
    push(rms) {
      zeros = rms === 0 ? zeros + 1 : 0
      return zeros >= threshold
    },
    reset() {
      zeros = 0
    }
  }
}
