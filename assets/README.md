# Asset Guide

This directory contains the repository-root 3D assets and their runtime configuration. Browser-public sprites, audio, fonts, demo videos, brand files, and Draco decoders live under `client/public/`. See the [project README](../README.md) for application setup and [asset credits](CREDITS.md) for the provenance ledger.

## Installation

These files are part of the main application, not a standalone package. Follow the [root installation instructions](../README.md#installation). Install Git LFS before checkout, then materialize the Fighter binaries:

```bash
git lfs install
git lfs pull
npm install
```

An FBX or GLB containing `version https://git-lfs.github.com/spec/v1` is an unresolved LFS pointer, not a usable model.

## Layout

The counts below are verified against the committed runtime layout and exclude ignored raw and quarantined files.

| Path | Current contents | Purpose |
|---|---:|---|
| `racer/cars/` | 19 GLBs | Selectable Voice Racer vehicles referenced by `manifest.json` |
| `racer/track/` | 4 GLBs | Barrier, boost orb, and start/finish gantries |
| `maps/` | 6 GLBs plus `maps.json` | Racer map candidates; the committed catalog currently configures 2 maps |
| `arena/` | 1 GLB plus `arena.json` | Voice Monsters arena and default transform/camera configuration |
| `fighters/source/` | 41 FBXs | 12 fighter models, animation sources, and 4 currently unreferenced clips |
| `fighters/maps/` | 3 GLBs plus `maps.json` | Fighter map models and the 5-entry map catalog; 2 entries are procedural |
| `fighters/previews/` | 17 PNG/SVG files | 12 fighter portraits and 5 map previews |
| `karaoke/` | 5 GLBs plus `venue.json` | Voice Karaoke stage, performers, immutable venue seed, and production asset guide |
| `fixtures/` | 2 generated GLBs | Test-only models produced by `npm run make-fixtures` |
| `manifest.json` | 19 cars, 1 barrier, 1 boost, 0 props | Racer model roles and per-model display transforms |

Do not place runtime GLBs directly in `assets/`. Racer vehicle and track tooling scans the nested `assets/racer/cars/` and `assets/racer/track/` directories.

The browser also consumes these asset trees outside this directory:

| Path | Current contents | Public URL root |
|---|---:|---|
| `client/public/assets/monsters/` | 16 GIFs | `/assets/monsters/` |
| `client/public/audio/` | 28 MP3/M4A files | `/audio/` |
| `client/public/fonts/` | 5 OTF files | `/fonts/` |
| `client/public/video/` | 6 MP4 files | `/video/` |
| `client/public/brand/` | 2 SVG logos and 3 PNG QR images | `/brand/` |
| `client/public/draco/` | JavaScript and WASM decoders | `/draco/` |

The font inventory is `TwilioSansDisplay-Regular.otf`, `TwilioSansDisplay-Extrabold.otf`, `TwilioSansText-Regular.otf`, `TwilioSansText-Bold.otf`, and `TwilioSansMono-Regular.otf`. CSS loads them directly with `@font-face`; the production server maps `.otf` to `font/otf`.

The home-page previews use `vr-demo.mp4`, `vm-demo.mp4`, `vf-demo.mp4`, `vk-demo.mp4`, `vt-demo.mp4`, and `vc-demo.mp4` for Voice Racer, Voice Monsters, Voice Fighter, Voice Karaoke, Voice Trivia, and Voice Chess. The generated Trivia preview is a silent H.264 1280x692 24fps 12-second MP4 with no audio stream. The Karaoke preview is a silent H.264 1280x692 24fps runtime derivative; its raw source stays in ignored `client/public/video/_raw/`. The Chess preview is a silent, fast-start H.264 1280x692 24fps six-second MP4 captured from the rendered 3D board. Voice Karaoke serves exactly two licensed 45-second English excerpts from `client/public/audio/karaoke/`: `classic-instrumental-45s.mp3` (*Never Gonna Give You Up* by Rick Astley) and `thousand-miles-45s.mp3` (*A Thousand Miles* by Vanessa Carlton). Their confirmed rights and detailed provenance are in [CREDITS.md](CREDITS.md). The brand inventory is `twilio_logo_1color_white.svg`, `Twilio_Logo_Bug_White.svg`, the standalone fallback `join-qr.png`, and the locale-specific station QR images `arcade-en.png` and `arcade-pt.png`.

Vite serves the public tree directly. In development it proxies other `/assets/*` requests to the Node server; in production the Node server resolves built client assets first and then repository-root `assets/` files.

## Usage

### Racer Manifest

`assets/manifest.json` is the Racer model catalog. Each asset reference requires `file` and may include `name`, `scale`, `rotation`, `offset`, or `animate`. Paths are relative to `assets/`, for example `racer/cars/lotus_elise.glb` and `racer/track/cyber_orb.glb`.

The parser is tolerant: malformed JSON becomes an empty manifest, invalid references are dropped, and missing roles stay empty. The client starts GLB loads after parsing instead of blocking on all 19 cars. Missing or failed car, barrier, and boost models remain primitive shapes; successfully loaded cars replace their primitive fallbacks. Baked car animation is off unless `animate` is `true`.

Run the inspector from the repository root to scan both Racer role directories and replace `assets/manifest.json` with a heuristic starter manifest:

```bash
npm run inspect-assets
```

This command is destructive to hand-tuned role assignments, names, and transforms. Review the generated manifest before saving further edits.

Use `/garage` to inspect and tune Racer model roles and transforms. Use `/editor` for Racer maps, the Voice Monsters arena, Fighter maps, Voice Karaoke venue authoring, and the protected Voice Trivia question bank; open `/editor?game=karaoke&tool=timing` for Karaoke word timing and `/editor?game=trivia` for Trivia prompts, choices, private aliases, sources, and review metadata. Editor writes use the API; local writes are open when `EDITOR_TOKEN` is unset, while production startup requires it. Deployed editor data uses persistent runtime files rather than modifying image-owned seed files.

### Racer Optimization

`npm run optimize-assets` processes GLBs in `assets/racer/cars/` and `assets/racer/track/` in place with Draco geometry, WebP textures, and a 1024-pixel texture limit. Before processing a model, it moves the original to the role-local ignored directory:

```text
assets/racer/cars/_raw/
assets/racer/track/_raw/
```

The optimizer skips files that already have a raw backup and restores the original if optimization fails. It does not process Racer maps, Fighter assets, or the Monsters arena. Runtime GLB loaders use the vendored decoder at `/draco/`; no CDN decoder is required.

### Fighter Assets

The Fighter runtime currently references 12 roster FBXs and 25 animation FBXs from `assets/fighters/source/`. All 41 files in that directory are Git LFS objects, including the 4 clips not currently selected by the runtime. Fighter model URLs carry a cache-busting version query.

`assets/fighters/maps/maps.json` is the five-map catalog. `cyberpunk-city`, `inakaya`, and `rain` load GLBs from `assets/fighters/maps/`; `foundry` and `void` intentionally use procedural scenes. If a configured Fighter GLB fails or times out, the client switches that map to its procedural fallback. The 12 character previews are under `fighters/previews/characters/`; map previews are directly under `fighters/previews/`.

The three GLB stages also receive runtime atmosphere layers. Cyberpunk City adds a moonlit neon skyline and haze, Inakaya adds a sunset mountain horizon and warm motes, and Rain adds a storm sky, live rain, and a wet-stone fighting platform. Static sky, terrain, and map geometry are flattened into one backdrop frame; only the fighters and small effect buffers remain animated.

The Fighter map editor can save map configuration and PNG previews. Runtime-generated previews are served from `/fighter-previews/`; committed catalog previews use `/assets/fighters/previews/`.

### Other Runtime Assets

Voice Monsters tries `<id>_<view>.gif`, then `<id>_<view>.png`, and uses its hand-authored canvas sprite only if both fail. Details are in the [monster sprite guide](../client/public/assets/monsters/README.md).

Music and effects are not stored under `assets/`. They are served from `client/public/audio/`:
contextual music is grouped under `lobby/`, `racer/`, `monsters/`, `fighter/music/`, `leaderboard/`,
and `chess/`; Karaoke backing excerpts are under `karaoke/`. Shared effects use `sfx/`, with Fighter effects in `fighter/sfx/`. A missing general
music or effect file logs a browser error and produces silence; it does not substitute another file.
A missing Voice Karaoke backing instead fails audio preflight and keeps the performance in sound
check for retry or timeout.

Voice Trivia has no dedicated audio files and reuses the `lobby` music context. Voice Chess uses the
user-supplied `chess/the-marble-gambit.mp3` and builds its 3D pieces procedurally in the browser,
so it does not need a separate model bundle.

The Monsters arena loads `assets/arena/arena.glb` using `arena.json`. If that GLB fails, the battle keeps its rendered green-void backdrop.

### Voice Karaoke Production Assets

Voice Karaoke's [production asset guide](karaoke/README.md) contains the detailed GLB attribution,
audio provenance, calibration procedure, and acceptance checks. The venue editor writes the strict
live `data/karaoke-venue.json`; `assets/karaoke/venue.json` seeds it only when the live copy is missing
or invalid. The timing editor writes calibrated, ETag-protected sparse overrides to
`data/karaoke-timings.json`. Omitted word boundaries come from `shared/karaoke-songs.ts`, and a
missing or invalid live timing file uses the compiled charts.

On the production `DATA_MOUNT`, the venue, timings, and `data/karaoke-leaderboard.json` survive
container restarts and redeploys. Karaoke GLBs and browser audio remain image-owned. The display's
sound check must decode the selected backing, warm the stage, and obtain a running unmuted Web Audio
context before it reports ready; station countdown also waits for an authenticated inbound Media
Stream.

Phone scoring combines voice-gated timing, normalized lyric evidence, and pitch at 50/30/20 weights.
Production lyric verification connects directly to Deepgram and sends only the caller's inbound 8 kHz
mu-law track, with bounded chart-derived keyterms. Raw audio and transcript text are not persisted or
logged by the application. Deepgram remains a third-party processor with its own configured retention
and data-processing terms. Use the guide's separate workflows for sparse word timing, browser-local
A/V alignment, and measured handset/carrier `KARAOKE_CALIBRATION_OFFSET_MS` validation.

## Governance

Git LFS tracks `assets/fighters/source/*.fbx` and `assets/fighters/maps/*.glb`. Other GLBs are regular Git files. The asset governance tests require Fighter references and previews to exist, require provenance rows for every current fighter, animation group, and map, validate either materialized files or LFS pointer metadata, warn above 32 MiB per Fighter asset, and fail above 128 MiB. Deployment separately requires materialized bytes from the private Azure Blob mirror and verifies their exact size and SHA-256 before ACR build.

CI runs `npm run verify:fighter-asset-pointers`, which enumerates every tracked FBX and Fighter map GLB independently of Git LFS and rejects malformed pointers. `npm run sync:fighter-assets` snapshots exactly those files into a no-overwrite, content-addressed private Blob prefix and rejects extra files when it verifies the downloaded mirror.

Raw originals and excluded models are local-only. `.gitignore` and `.dockerignore` exclude `assets/_raw/`, `assets/_quarantine_noncommercial/`, `assets/maps/_raw/`, both Racer role-local `_raw/` directories, `assets/fighters/maps/_raw/`, and `assets/karaoke/_raw/`. `tools/.smoke/` is also ignored and excluded from the container because it contains generated render evidence, not runtime assets.

Run the relevant checks after changing the catalog or binaries:

```bash
npm test -- tests/asset-manifest.test.ts tests/asset-fit.test.ts tests/inspect-assets.test.ts
npm test -- tests/fighter-assets.test.ts tests/fighter-asset-governance.test.ts
npm test -- tests/karaoke-assets.test.ts tests/karaoke-song-audio.test.ts tests/karaoke-timings.test.ts
npm run smoke:karaoke-editor
npm run verify:fighter-assets
npm run sync:fighter-assets
npm run typecheck
npm run build
```

## License

The repository has no root `LICENSE` file and must not be treated as granting general reuse rights. Asset licenses are file-specific. Consult [CREDITS.md](CREDITS.md), preserve required attribution, and verify that a source license permits the intended distribution and modification before adding or publishing an asset.

The Racer, arena, and map ledger includes CC BY material, one CC BY-ND Racer map, incomplete source fields, and excluded noncommercial or unknown-license models. Fighter source URLs and licenses remain explicitly unverified. Apart from the two user-confirmed Voice Karaoke excerpts, the current ledger does not document source or rights provenance for the audio files, fonts, demo videos, monster GIFs, QR images, or Twilio brand files. The technical Trivia preview inventory is not a credit or license grant. The Karaoke rights confirmations are not a general license grant. Do not infer permission from a filename, a download site, or inclusion in this repository.
