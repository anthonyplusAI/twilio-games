# Asset Credits

All in-game models below (vehicles and obstacles) are sourced from [Sketchfab](https://sketchfab.com)
under the **Creative Commons Attribution 4.0 International (CC-BY 4.0)** license
(<https://creativecommons.org/licenses/by/4.0/>), which permits use **with attribution**.

The committed `.glb` files in `assets/` are compressed derivatives (Draco geometry + WebP
textures, resized to 1024px) of the original Sketchfab downloads. Raw originals are kept
locally in `assets/_raw/` (gitignored). Per CC-BY, derivatives are permitted; attribution to
the original authors is preserved below.

## Voice Karaoke 3D models (CC-BY 4.0)

These runtime assets are Draco/WebP optimized derivatives. Raw originals are local-only under
gitignored `assets/karaoke/_raw/`. The attribution below is preserved in each release GLB's asset
metadata and has been verified against the linked Sketchfab source page.

| Runtime file | Model | Author | Sketchfab | License |
|---|---|---|---|---|
| `karaoke/stage.glb` | Stage | [MEC CAD](https://sketchfab.com/meccad) | https://sketchfab.com/3d-models/stage-75918ce264ca4362adb3aa7d87a88f37 | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `karaoke/lead-singer.glb` | Freddie Mercury | [Gerwerni](https://sketchfab.com/gerwerni) | https://sketchfab.com/3d-models/freddie-mercury-965ebf37fb364b73abb91f6d63e49e08 | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `karaoke/backup-singer.glb` | Animated Model Singing with Microphone in Hand | [LasquetiSpice](https://sketchfab.com/LasquetiSpice) | https://sketchfab.com/3d-models/animated-model-singing-with-microphone-in-hand-dade090dddcb4d1b8614972b2133d22e | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `karaoke/drummer.glb` | Playing Drums | [kodexar](https://sketchfab.com/kodexar) | https://sketchfab.com/3d-models/playing-drums-22c1e9e36d6a4bb6b122cb95dc06d025 | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `karaoke/guitarist.glb` | Animated Musical Trem Playing Guitar Loop | [LasquetiSpice](https://sketchfab.com/LasquetiSpice) | https://sketchfab.com/3d-models/animated-musical-trem-playing-guitar-loop-7dde986b68834de6b5a9deff6819d3f1 | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) |

## Voice Karaoke licensed 45-second excerpts

| Runtime file | Recording | Artist | Rights provenance |
|---|---|---|---|
| `client/public/audio/karaoke/classic-instrumental-45s.mp3` | Never Gonna Give You Up (instrumental) | Rick Astley | User confirmed all required rights |
| `client/public/audio/karaoke/thousand-miles-45s.mp3` | A Thousand Miles | Vanessa Carlton | User confirmed all required rights |

Both runtime files are exact 45-second excerpts. This ledger preserves recording and artist
attribution plus the user's rights confirmations for this use; it does not supply a general license
or grant reuse rights for either recording, composition, or lyric.

The local vocal timing source is `assets/karaoke/_raw/audio/classic.MP3`; the local backing source is
`assets/karaoke/_raw/audio/classic-instrumental.mp4`. Chroma/DTW alignment found that the two
recordings use different masters but the same arrangement. The runtime file uses instrumental seconds
74.199 through 119.319, tempo-corrected by `1.002227`, and trimmed to exactly 45 seconds. Validation
leaves approximately 38 ms of offset and less than 0.005% residual tempo drift. The user confirmed that the required
recording, synchronization, display, public-performance, telephony, and distribution rights are
in place for this use.

The local full-length `assets/karaoke/_raw/audio/thousand-miles.mp3` source is 237.494 seconds. The
runtime excerpt uses source seconds 18.000 through 63.000, covering the first verse pickup,
pre-chorus, and complete first chorus. The user confirmed the same recording, lyric synchronization,
display, public-performance, telephony, and distribution rights for this use. Waveform alignment to
the exact-duration official vocal reference measured a fixed 424 ms instrumental delay, which is
applied to the chart. Vocal-preview forced alignment supplies individual opening and chorus word
boundaries. Its target-note contour
is provisional pending isolated-vocal calibration.

The production word boundaries for both excerpts are the calibrated sparse overrides in
`data/karaoke-timings.json` over the compiled fallback charts in `shared/karaoke-songs.ts`. That
runtime calibration is derived timing metadata and does not change the rights provenance above.
The current target-note contours remain conservative and provisional; the calibrated timing file
does not claim isolated-vocal pitch calibration.

## Voice Chess music

| Runtime file | Track | Source | Rights provenance |
|---|---|---|---|
| `client/public/audio/chess/the-marble-gambit.mp3` | The Marble Gambit | User-supplied `The_Marble_Gambit.mp3` | Distribution and reuse rights were not documented in this repository |

## Voice Chess generated preview

`client/public/video/vc-demo.mp4` is an original, silent home/station card preview captured
locally on 2026-10-06 from this repository's procedural Voice Chess board and pieces. It shows
the legal line `1. e4 d5 2. exd5 Qxd5 3. Nf3`, including both capture effects, with original
voice-command captions. The runtime file is a six-second, fast-start H.264 1280x692 24fps MP4
without an audio stream. No outside footage or music was used.

## Voice Trivia generated preview

`client/public/video/vt-demo.mp4` is the generated, silent home/station preview for Voice Trivia. The
runtime file is a 12-second H.264 1280x692 24fps MP4 with no audio stream. It was generated locally
for this repository on 2026-08-29 with FFmpeg from solid colors, geometric UI shapes, original quiz
copy, and the repository's local Twilio Sans font files. It contains no third-party footage, music, or
audio.

## Voice Monsters — battle arena (CC-BY 4.0)

| Model file | Title | Author | Sketchfab |
|---|---|---|---|
| `arena/arena.glb` | Practice / Pokemon Arena | KoraProjects | https://skfb.ly/6XSOD |

"Practice / Pokemon Arena" (https://skfb.ly/6XSOD) by KoraProjects is licensed under
Creative Commons Attribution (http://creativecommons.org/licenses/by/4.0/). The committed
`assets/arena/arena.glb` is a Draco+WebP-compressed derivative of the original download.

## Used car models (19, CC-BY 4.0)

| Model file | Title | Author | Sketchfab |
|---|---|---|---|
| `bronco_car_animation_red.glb` | Bronco Car Animation (Red) | neshallads | https://skfb.ly/oBoz9 |
| `drunk_monster_truck.glb` | drunk Monster Truck | aleksandr.yatsenco | https://skfb.ly/6RIz6 |
| `lotus_elise.glb` | LOTUS ÉLISE | Stéphane Agullo | https://skfb.ly/OEN6 |
| `jurassic_park_1930_-_park_rover.glb` | Jurassic Park 1930 - Park Rover | Nathaniel Onandia | https://skfb.ly/6AstC |
| `batmobile-the_dark_knight_tumbler.glb` | Batmobile - The Dark Knight Tumbler | Gravity Jack | https://skfb.ly/6z9GJ |
| `forklift.glb` | Forklift | Ethian74 | https://skfb.ly/6UrnJ |
| `pig_farm_car_trailer.glb` | Pig Farm car trailer | RavGFX | https://skfb.ly/6Bq8E |
| `monowheel_bot__vgdc.glb` | Monowheel Bot \| VGDC | MooKorea | https://skfb.ly/oq9GH |
| `buggy__free_3d.glb` | Buggy \| FREE 3d | Denys Cherkasov | https://skfb.ly/owGE9 |
| `climber.glb` | Climber | Linomig | https://skfb.ly/ooBtY |
| `1955_american_sedan_packard_based_free.glb` | 1955 American Sedan (Packard based) FREE | Libau Media | https://skfb.ly/pFq8S |
| `car.glb` | Car | cuadot.fbx | https://skfb.ly/owHIr |
| `18_mclaren_senna_crxw_widebody_kit_animated.glb` | 18' McLaren Senna Crxw Widebody Kit (Animated) | crxw.cgi | https://skfb.ly/oyYv9 |
| `airtsel_valor_proiettile.glb` | Airtsel Valor Proiettile | Yudha Mfr | https://skfb.ly/oJJKq |
| `rigged_car_mustang_1965_with_engine_3d_model.glb` | Rigged Car Mustang 1965 With Engine | Godspeed | https://skfb.ly/pDprw |
| `yuterra_buegett.glb` | Yuterra Buegett | Yudha Mfr | https://skfb.ly/oJ6qx |
| `beetlefusca_version_1.glb` | Beetle/Fusca (Version 1) | soujagah | https://skfb.ly/6GFDP |
| `cartoon_sports_car.glb` | Cartoon Sports Car | RCC Design | https://skfb.ly/6xHtJ |
| `cicada_-_retro_cartoon_car.glb` | Cicada - Retro Cartoon Car | RCC Design | https://skfb.ly/6vtXV |

## Obstacle + track models (CC-BY 4.0)

| Model file | Title | Author | Sketchfab | In-game role |
|---|---|---|---|---|
| `danger_barrier_proops.glb` | Danger Barrier (Proops) | ALTEREGO (v.a.c.u.u.m.) | https://skfb.ly/p9ZBq | Barrier (hazard to dodge) |
| `starting_line.glb` | Starting Line | Yanez Designs | https://skfb.ly/6RYrD | Start gantry (track z=0) |
| `finish_line.glb` | Finish Line | Kemal Çolak | https://skfb.ly/oDuZz | Finish gantry (track end) |
| `cyber_orb.glb` | Cyber Orb | Tycho Magnetic Anomaly | https://skfb.ly/o7F7A | Boost pad (hovers over the track) |

## Maps / tracks (`assets/maps/`)

Scenery worlds a race can be played on (aligned + configured per-map in `/editor`, saved to
`assets/maps/maps.json`). Shipped Draco+WebP optimized; raw originals in `assets/maps/_raw/` (gitignored).

| Map file | Title | Author | License | Sketchfab |
|---|---|---|---|---|
| `silver_lake.glb` | Silver Lake | — | CC-BY 4.0 | — |
| `drift_race_track_free.glb` | Drift Race Track Free | Nicholas-3D | **CC-BY-ND 4.0** (no derivatives — use the model as-is; do not remix the mesh) | https://skfb.ly/oXNZR |
| `shanghai_international_circuit_2018_layout.glb` | Shanghai International Circuit 2018 layout | Dave Bored | CC-BY 4.0 | https://skfb.ly/pLqvL |
| `suzuka_circuit_2001_layout.glb` | Suzuka Circuit 2001 layout | Dave Bored | CC-BY 4.0 | https://skfb.ly/pLorW |
| `map_xsbn_2cs.glb` | Map_xsbn_2cs | amogusstrikesback2 | CC-BY 4.0 | https://skfb.ly/pyOzS |
| `fixed_new_york_highway_interstate_95.glb` | New York Highway (Interstate 95) | — | see source | — |

> **CC-BY-ND note (drift track):** NoDerivatives forbids distributing a *modified* mesh. We place +
> scale the model in-scene (allowed — that's not modifying the asset itself) and never re-export an
> altered mesh, so this stays compliant. Attribution to Nicholas-3D is required (above).

## Voice Fighter provenance

The Fighter assets below are runtime dependencies, but their original source URLs and licenses have
not yet been verified. **UNKNOWN means the asset must not be assumed to be reusable or
redistributable.** Replace each UNKNOWN with a verified source URL, author, and license before a
public release; do not infer a license from a filename, format, or download site.

### Fighters

| Roster ID | Fighter | Runtime file | Source URL | License |
|---|---|---|---|---|
| `nyx` | Nyx | `nyx.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `wraith` | Wraith | `wraith.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `remy-riot` | Remy Riot | `remy-riot.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `cinder-capone` | Cinder Capone | `cinder-capone.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `rune-warden` | Rune Warden | `rune-warden.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `shroom-boom` | Shroom Boom | `shroom-boom.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `gran-slam` | Gran Slam | `gran-slam.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `bass-nova` | Bass Nova | `bass-nova.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `velvet-thunder` | Velvet Thunder | `velvet-thunder.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `iron-oni` | Iron Oni | `iron-oni.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `bulkhead` | Bulkhead | `bulkhead.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `sir-knockout` | Sir Knockout | `sir-knockout.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |

### Animation groups

Each row covers all clips currently selected from that animation group.

| Group ID | Runtime files | Source URL | License |
|---|---|---|---|
| `idle` | `fighting-idle.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `walk` | `run-forward.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `walk-back` | `run-backward.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `jump` | `jump-high.fbx`, `jump-vertical.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `block` | `block-outward.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `punch` | `punch-combo.fbx`, `punch-uppercut.fbx`, `punch-right-hook.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `kick` | `kick-mma-01.fbx`, `kick-mma-02.fbx`, `kick-mma-03.fbx`, `kick-standard.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `reaction` | `hit-reaction-01.fbx`, `hit-reaction-head.fbx`, `hit-reaction-face.fbx`, `hit-reaction-body.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `fall` | `knockout-fall.fbx`, `knockdown-shoulder.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `celebration` | `victory-01.fbx`, `victory-02.fbx`, `celebration-jazz.fbx`, `celebration-salsa.fbx`, `celebration-macarena.fbx`, `celebration-silly.fbx` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |

### Fighter maps

Procedural fallbacks still require provenance for any textures, audio, or other source material later
added to them. Preview images are project-generated derivatives of the corresponding map render and
inherit the map's unresolved status.

| Map ID | Map | Runtime file | Source URL | License |
|---|---|---|---|---|
| `foundry` | Neon Foundry | Procedural fallback | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `void` | Void Circuit | Procedural fallback | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `cyberpunk-city` | Cyberpunk City | `cyberpunk_city.glb` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `inakaya` | Inakaya Restaurant | `japanese_restaurant_inakaya.glb` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |
| `rain` | Rain | `rain.glb` | **UNKNOWN - verification required** | **UNKNOWN - verification required** |

## Excluded models (NOT used in-game)

Kept in `assets/_quarantine_noncommercial/` (gitignored), excluded for licensing reasons:

| Model file | Title | Author | License | Reason excluded |
|---|---|---|---|---|
| `jeep_1-_testmotions.glb` | Jeep 1- Test+motions | Kapi777 | CC-BY-**NC** 4.0 | NonCommercial — unsafe for a commercial/event context |
| `vehicle_blue_train_bentley.glb` | (Bentley) | — | **unknown** | No attribution/license provided — verify before any use |
| `bmw_e36_318ti.glb` | BMW E36 318ti | Nothing Software | CC-BY-**NC** 4.0 | NonCommercial — unsafe for a commercial/event context |
| `evo_rally_car.glb` | Evo Rally Car | SpatialNeglect | CC-BY-**NC** 4.0 | NonCommercial — unsafe for a commercial/event context |
| `bmw_x7_m60i.glb` | BMW X7 M60i | — | **unknown** | No attribution/license provided — verify before any use |
