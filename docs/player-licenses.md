# Browser player assets and sources

The browser player is **@libmedia/avplayer 1.3.1**, copyright Gaoxing Zhao and
the contributing authors, distributed under **LGPL-3.0-or-later**. Its published
npm release identifies source commit
`152f629d3021fd8013efa464fcb7b55f9fbe7753`. JavaScript and decoder WebAssembly are
separate, replaceable resources. This application applies two documented JavaScript
compatibility fixes; decoder WebAssembly files are unmodified.

## Reproduce the hosted assets

```sh
npm ci
node scripts/vendor-player.ts
```

The script prepares the package's UMD bundle and all 31 dynamic chunks in
`public/vendor/avplayer/`. It fetches matching baseline WASM from that exact
source commit, checks every downloaded file against a recorded SHA-256 hash,
and writes `manifest.json` containing the source URL, digest, and size of every
file. The committed npm lockfile records the package archive's integrity.
Previously verified downloaded files are reused, so a second run needs no
network access. The generated directory is replaced only after all inputs have
been read and verified. Include this directory in the site's static assets.

The generated `SOURCES.md` and `licenses/` directory must remain available with
the player. All runtime JavaScript and WASM are served by this site; the browser
does not download executable player assets from a third-party CDN.

## Components and licenses

| Component | Use | License and available source |
| --- | --- | --- |
| libmedia | Player, demuxers, renderers, codec wrappers | [LGPL-3.0-or-later; exact source and build scripts](https://github.com/zhaohappy/libmedia/tree/152f629d3021fd8013efa464fcb7b55f9fbe7753) |
| common | Bundled JavaScript utilities | [MIT; pinned libmedia submodule](https://github.com/zhaohappy/common/tree/00c9c3c481cf7c53ed252cec6ca2dc6e9732ea28) |
| cheap | JavaScript/WASM interoperability | [MIT; pinned libmedia submodule](https://github.com/zhaohappy/cheap/tree/85cc79e032cbd417e3bb4a218bdf26da537b970b) |
| FFmpeg | H.264, AAC, Opus decoding; resampling | [LGPL-2.1-or-later; upstream's customized source branch](https://github.com/zhaohappy/FFmpeg/tree/libmedia7.0) |
| libvpx | VP9 decoding | [BSD-3-Clause and patent grant; upstream source](https://github.com/webmproject/libvpx) |
| SoundTouch | Audio time stretching | [LGPL-2.1; source included in pinned libmedia](https://github.com/zhaohappy/libmedia/tree/152f629d3021fd8013efa464fcb7b55f9fbe7753/packages/audiostretchpitch/src/clib/soundtouch) |
| ASS.js and ass-compiler | Bundled subtitle support | [ASS.js MIT](https://github.com/weizhenye/ASS), [ass-compiler MIT](https://github.com/weizhenye/ass-compiler) |

The generated notices contain LGPL v3, its referenced GPL v3 text, LGPL v2.1,
and the MIT/BSD copyright and patent notices. The GPL text accompanies LGPL v3;
this build does not include the x264 or x265 encoders. The FFmpeg and libvpx
release tags used for license-text downloads identify those notices, not an
assertion about the version used to compile libmedia's published binaries.

## Source availability and replacing the library

The [libmedia source archive](https://github.com/zhaohappy/libmedia/archive/152f629d3021fd8013efa464fcb7b55f9fbe7753.tar.gz)
includes the player, codec wrappers, SoundTouch sources, and build scripts. The
common and cheap submodules are separate repositories linked above; fetch their
pinned commits as well. The [upstream WASM build instructions](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/site/docs/guide/compile-wasm.en-US.md)
describe building FFmpeg and the wrapper modules with Emscripten.

Upstream does not record the exact external FFmpeg/libvpx revisions or complete
compiler provenance for these prebuilt WASM files. This script reproduces the
published bytes; it does not claim to independently reproduce their compilation
or verify the complete correspondence of those external source revisions.

You may replace the separate JavaScript and WASM assets with compatible modified
versions and run them with the application. For a persistent replacement, update
the npm package/revision and checksum entries in `scripts/vendor-player.ts`,
rebuild the static assets, and retain the applicable notices and source access.
The checksums protect build downloads; they do not restrict browser execution or
reverse engineering for debugging a modified library.

## Local player modification

`scripts/patch-player.ts` fixes libmedia 1.3.1's format probe for YouTube HLS:
an ID3 tag can precede AAC audio, while the upstream probe assumes it means MP3.
The patch checks for an ADTS header after a bounded ID3 tag and selects the
existing AAC demuxer. That demuxer already reads the transport timestamp used to
synchronize audio and video. Other ID3 content retains the original MP3 behavior.

The patch is applied to exactly one expected source pattern and fails the build
if that pattern changes. Its complete source is shipped as
`/vendor/avplayer/patch-player.ts`; `manifest.json` records the modification and
hashes the resulting bundle. The library's LGPL-3.0-or-later terms apply to this
modification. Regression tests cover AAC/MP3 detection and malformed tags; real
browser playback verifies both audio and video after seeking.

The same patch file also makes the IPC reply method ignore late responses after
its port has closed. Stopping a video while its network request is pending already
rejects that request; a later completion must not use the destroyed message port.
This second patch also requires exactly one pinned source match. A delayed-load
browser check verifies that Stop followed by another video leaves only the new
player active and produces no uncaught callback errors.

## Runtime configuration

Load `/vendor/avplayer/avplayer.js` as a classic script; it exposes the
`AVPlayer` constructor. Keep its numbered chunks in the same directory. Use a
`div` container, `enableWebCodecs: false`, `checkUseMSE: () => false`, and an
explicit `getWasm` callback. The callback must map to the baseline assets:

| Request | Path under `/vendor/avplayer/wasm/` |
| --- | --- |
| H.264 decoder | `decode/h264.wasm` |
| AAC decoder | `decode/aac.wasm` |
| VP9 decoder | `decode/vp9.wasm` |
| Opus decoder | `decode/opus.wasm` |
| `resampler` | `resample/resample.wasm` |
| `stretchpitcher` | `stretchpitch/stretchpitch.wasm` |

The baseline set does not require SIMD, pthreads, SharedArrayBuffer, or native
WebCodecs. `wasmBaseUrl` alone is unsuitable for this set because the library
automatically chooses SIMD/atomic filenames on supporting browsers. This player
version does not request a separate video-scaler WASM module during playback.
VP8, AV1, and Vorbis are not included; source selection must choose one of the
shipped video/audio codecs. On a constrained browser, begin with
`enableWorker: false` and `enableWebGPU: false`; device testing is still necessary
to establish decoding performance.

Await asynchronous `load`, `play`, `pause`, `stop`, `seek`, and `destroy` calls
in order. `seek()` takes a BigInt millisecond timestamp, `getDuration()` returns
BigInt milliseconds, and the `time` event supplies BigInt milliseconds.
