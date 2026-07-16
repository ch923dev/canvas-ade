# Vendored: seek-bzip

- Upstream: https://github.com/cscott/seek-bzip (npm `seek-bzip@2.0.0`)
- License: MIT (see ./LICENSE — the upstream file, verbatim)
- Vendored: 2026-07-17 (Jarvis J5 wake word — the KWS model archive installer)

`bunzip.ts` is a strict-TypeScript port of upstream `lib/bitreader.js` +
`lib/crc32.js` + `lib/index.js`, TRIMMED to whole-buffer decode only
(`bunzip2(input): Buffer`): the seek/table/decodeBlock APIs, the stream
adapters and the CLI are dropped; the CRC table is generated instead of
inlined. Decode semantics are unchanged and verified against the upstream
package's output in `bunzip.test.ts` (real bzip2 fixtures, byte-identical).
