/**
 * Voice V1 — AudioWorklet processor (thin shell; all math in `captureMath.ts`).
 *
 * Runs on the audio rendering thread. Receives AudioContext-rate float32 quanta
 * (128 samples), mixes to mono, and feeds the pure capture pipeline (48 k → 16 k Int16,
 * ~120 ms frames + RMS). Posts to the AudioWorkletNode port ONLY when a full frame is
 * ready (~8/s — never per quantum, sharp edge #7), transferring the frame's buffer.
 *
 * Loaded via `?worker&url` (the CSP-safe bundled-module shape — same-origin emitted chunk,
 * never a blob: URL; the osrBlitWorker discipline). Outputs silence — the node is connected
 * to the destination only to keep the graph pulled.
 */
import { createCapturePipeline, type CapturePipeline, type WorkletFrameMsg } from './captureMath'

// AudioWorkletGlobalScope globals — absent from TS's dom lib (which only types the
// node/window side), so declared minimally here. `sampleRate` is the context rate.
declare const sampleRate: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor & {
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
  }
): void

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  private readonly pipeline: CapturePipeline = createCapturePipeline(sampleRate)
  /** Scratch mono mix buffer, reused across quanta (steady-state: zero allocation). */
  private mono = new Float32Array(128)

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0]
    if (!channels || channels.length === 0 || channels[0].length === 0) return true
    let chunk = channels[0]
    if (channels.length > 1) {
      // Mix all channels down to mono (getUserMedia audio is usually mono already).
      if (this.mono.length !== chunk.length) this.mono = new Float32Array(chunk.length)
      const mix = this.mono
      for (let i = 0; i < chunk.length; i++) {
        let sum = 0
        for (let c = 0; c < channels.length; c++) sum += channels[c][i]
        mix[i] = sum / channels.length
      }
      chunk = mix
    }
    for (const { frame, rms } of this.pipeline.push(chunk)) {
      const msg: WorkletFrameMsg = { frame: frame.buffer, rms }
      this.port.postMessage(msg, [frame.buffer])
    }
    return true
  }
}

registerProcessor('voice-capture', VoiceCaptureProcessor)
