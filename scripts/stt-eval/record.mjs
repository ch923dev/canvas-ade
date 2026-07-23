#!/usr/bin/env node
// Corpus recorder for the STT eval harness.
//
//   pnpm stt:record        # opens http://127.0.0.1:8099 — hold SPACE, read the prompt, release
//
// Serves recorder.html, accepts raw 16 kHz mono Int16 PCM per utterance, writes it as a
// WAV, and maintains corpus/manifest.json. Re-recording an id overwrites it, so a fluffed
// take costs one keypress.
//
// WHY A BROWSER PAGE AND NOT A NODE RECORDER: capturing a microphone from bare Node needs
// a native addon; Chromium already has getUserMedia plus a real resampler. Constructing
// the AudioContext at 16 kHz makes the browser do a proper band-limited downsample to the
// rate every ASR model actually wants — better than hand-rolling interpolation, and it
// avoids the aliasing failure mode a naive decimation would introduce (STT-ACCURACY.md §3.4).
//
// Binds 127.0.0.1 only. It writes files under scripts/stt-eval/corpus/ and does nothing else.

import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeWav } from './wav.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS_DIR = join(HERE, 'corpus')
const MANIFEST = join(CORPUS_DIR, 'manifest.json')
const PROMPTS = join(CORPUS_DIR, 'prompts.json')
const SAMPLE_RATE = 16000
const PORT = Number(process.env.STT_EVAL_PORT || 8099)
/** Guard against a runaway recording filling memory — 2 minutes at 16 kHz mono s16le. */
const MAX_PCM_BYTES = SAMPLE_RATE * 2 * 120

function loadManifest() {
  if (!existsSync(MANIFEST)) return { sampleRate: SAMPLE_RATE, utterances: [] }
  try {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8'))
    return { sampleRate: m.sampleRate ?? SAMPLE_RATE, utterances: m.utterances ?? [] }
  } catch {
    // A corrupt manifest must not silently wipe prior takes — refuse loudly instead.
    throw new Error(`corpus/manifest.json is corrupt; move it aside and re-record`)
  }
}

/** Upsert one utterance, preserving recording order for everything else. */
function saveUtterance({ id, reference, keyterms }) {
  const manifest = loadManifest()
  const entry = { id, file: `${id}.wav`, reference, keyterms }
  const at = manifest.utterances.findIndex((u) => u.id === id)
  if (at >= 0) manifest.utterances[at] = entry
  else manifest.utterances.push(entry)
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), 'utf8')
  return manifest.utterances.length
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total > limit) {
        reject(new Error('recording too long'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, readFileSync(join(HERE, 'recorder.html')), 'text/html; charset=utf-8')
    }

    if (req.method === 'GET' && url.pathname === '/prompts') {
      const prompts = JSON.parse(readFileSync(PROMPTS, 'utf8')).prompts
      const done = new Set(loadManifest().utterances.map((u) => u.id))
      return send(res, 200, { sampleRate: SAMPLE_RATE, prompts, done: [...done] })
    }

    if (req.method === 'POST' && url.pathname === '/save') {
      const id = url.searchParams.get('id')
      const prompts = JSON.parse(readFileSync(PROMPTS, 'utf8')).prompts
      const prompt = prompts.find((p) => p.id === id)
      // Only ids from the prompt file are accepted — the id becomes a filename.
      if (!prompt) return send(res, 400, { error: `unknown prompt id: ${id}` })
      const pcm = await readBody(req, MAX_PCM_BYTES)
      if (pcm.length < SAMPLE_RATE / 2) {
        return send(res, 400, {
          error: 'recording shorter than 0.25s — hold the key while speaking'
        })
      }
      mkdirSync(CORPUS_DIR, { recursive: true })
      writeFileSync(join(CORPUS_DIR, `${id}.wav`), encodeWav(pcm, SAMPLE_RATE))
      const count = saveUtterance({ id, reference: prompt.text, keyterms: prompt.keyterms ?? [] })
      const seconds = pcm.length / 2 / SAMPLE_RATE
      console.log(`  saved ${id} (${seconds.toFixed(1)}s) — ${count} recorded`)
      return send(res, 200, { ok: true, id, seconds, recorded: count })
    }

    send(res, 404, { error: 'not found' })
  } catch (err) {
    console.error(err)
    send(res, 500, { error: err.message })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nSTT eval recorder → http://127.0.0.1:${PORT}\n`)
  console.log('  Hold SPACE, read the prompt aloud, release. N/P to move, R to re-record.')
  console.log('  Recordings land in scripts/stt-eval/corpus/. Ctrl-C when done.\n')
})
