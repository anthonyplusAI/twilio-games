# Music And Sound Setup

Twilio Games serves 28 audio files from `client/public/audio/`: 9 contextual music tracks, 2 Karaoke backing excerpts, and 17 sound effects. `client/music-manager.ts` owns contextual music, `client/sound-effects.ts` owns effects, and Karaoke plays its backing excerpts through its performance audio path. Vite exposes the directory at `/audio/`.

## Music Inventory

| Context | File | Playback |
|---|---|---|
| `lobby` | `lobby/velvet-arrival.mp3` | Loops |
| `racer` | `racer/midnight-apex.m4a` | First track in a looping playlist |
| `racer` | `racer/red-light-to-green.mp3` | Second track in a looping playlist |
| `monsters` | `monsters/hero-final-gambit.mp3` | First track in a looping playlist |
| `monsters` | `monsters/one-last-gold-coin.mp3` | Second track in a looping playlist |
| `fighter` | `fighter/music/break-the-guard.mp3` | Loops through the intro, countdown, and fight |
| `fighter-victory` | `fighter/music/victory.mp3` | Plays once and stops when the track ends |
| `leaderboard` | `leaderboard/final-ascent.mp3` | Loops |
| `chess` | `chess/the-marble-gambit.mp3` | Loops during Voice Chess |

Karaoke also serves `karaoke/classic-instrumental-45s.mp3` and `karaoke/thousand-miles-45s.mp3` as performance backing excerpts. They are not `MusicManager` contexts.

`MusicManager` uses one `HTMLAudioElement` and one global instance per page. `switchContext()` resets the selected context to its first track and starts it. Repeating the current context while it is marked as playing does nothing. An `ended` event advances to the next track and wraps to the start unless the context sets `loop: false`; only `fighter-victory` currently does that.

## Context Transitions

| Display | Transition | Context |
|---|---|---|
| Home | First document click | `lobby` |
| Voice Racer | Lobby state | `lobby` |
| Voice Racer | First `racing` snapshot | `racer` |
| Voice Racer | Results | `leaderboard` |
| Voice Monsters | Enter lobby | `lobby` |
| Voice Monsters | Enter battle | `monsters` |
| Voice Monsters | `battle_over` event | `leaderboard` |
| Voice Fighter | Lobby, fighter selection, map selection, or loading | `lobby` |
| Voice Fighter | Intro begins | `fighter` |
| Voice Fighter | Knockout event | `fighter-victory` |
| Voice Trivia | First permitted playback through results | `lobby` |
| Voice Chess | Display opens through the end of the match | `chess` |

The Fighter track starts at the intro and remains active through countdown and combat. The victory track is a separate, non-looping context. A later lobby or rematch transition replaces it with lobby music.

Voice Trivia reuses the global `lobby` track throughout its display lifecycle. It attempts playback
when the page opens and retries on the first pointer or keyboard interaction when browser autoplay
policy blocks the initial attempt. Its English `3, 2, 1` display starts the shared countdown effect
once when the authoritative server clock first reaches `3`, matching Racer, Fighter, and Karaoke.

Voice Chess plays the supplied *The Marble Gambit* track as soon as its display opens. If autoplay is blocked, the display retries on the first user gesture or when **Play music** is selected. The music button also respects the global mute preference.

The home page waits for its first click before starting lobby music. Game state transitions call `audio.play()` immediately. A browser autoplay rejection logs `Failed to play track` and leaves playback silent; the manager does not install a global gesture retry. A later context switch, explicit `resume()`, or mute-then-unmute action attempts playback again.

The music toggle persists `twilio-games-music-muted` in `localStorage`. A muted context still selects its track but does not call `play()`. Unmuting resumes the selected track when the manager considers it active. The same mute state suppresses all sound effects.

## Music API

```typescript
import { getMusicManager } from './music-manager';

const music = getMusicManager();
music.switchContext('fighter');
music.pause();
music.resume();
music.stop();
music.setVolume(0.5);

const context = music.getCurrentContext();
const playing = music.getIsPlaying();
const muted = music.getIsMuted();
```

`setVolume()` clamps values to the range from `0` to `1`. `pause()` preserves the current position, while `stop()` pauses and seeks to the beginning.

## Sound Effect Inventory

The effects manager preloads every file and debounces repeated playback of the same key for 100 milliseconds.

| File | Public method | Use |
|---|---|---|
| `sfx/crash.mp3` | `playCrash()` | Racer barrier hit |
| `sfx/powerup.mp3` | `playPowerUp()` | Racer boost pickup |
| `sfx/turbo.mp3` | `playTurbo()` | Racer power activation |
| `sfx/countdown.mp3` | `playCountdown()` | English Racer, Fighter, Karaoke, and Trivia countdown cue |
| `sfx/select.mp3` | `playSelect()` | Joins, selections, station admissions, and menu feedback |
| `sfx/attack-electric.mp3` | `playAttack('electric')` | Electric Monsters move and fallback for types without a dedicated file |
| `sfx/attack-fire.mp3` | `playAttack('fire')` | Fire Monsters move |
| `sfx/attack-water.mp3` | `playAttack('water')` | Water Monsters move |
| `sfx/attack-grass.mp3` | `playAttack('grass')` | Grass Monsters move |
| `sfx/attack-psychic.mp3` | `playAttack('psychic')` | Psychic Monsters move |
| `sfx/item-potion.mp3` | `playItem()` | Monsters potion |
| `sfx/taunt.mp3` | `playTaunt()` | Monsters taunt |
| `sfx/guard.mp3` | `playGuard()` | Monsters guard or block |
| `fighter/sfx/punch-light.mp3` | `playFighterPunch()` | First punch in the rotating punch sequence |
| `fighter/sfx/punch-impact.mp3` | `playFighterPunch()` | Second punch in the rotating punch sequence |
| `fighter/sfx/punch-heavy.mp3` | `playFighterPunch()` | Third punch in the rotating punch sequence |
| `fighter/sfx/kick-medium.mp3` | `playFighterKick()` | Fighter kick |

`playFighterPunch()` rotates through light, impact, and heavy files on successive calls. `playFighterKick()` always uses `kick-medium.mp3`. Fighter intro attacks and authoritative combat action events call these same methods.

## Sound Effect API

```typescript
import { getSoundEffectsManager } from './sound-effects';

const sfx = getSoundEffectsManager();
sfx.playCrash();
sfx.playPowerUp();
sfx.playTurbo();
sfx.playCountdown();
sfx.playSelect();
sfx.playAttack('fire');
sfx.playGuard();
sfx.playItem();
sfx.playTaunt();
sfx.playFighterPunch();
sfx.playFighterKick();
sfx.setVolume(0.8);
```

`playAttack()` uses the electric effect when the requested type has no dedicated key. The effects manager resets an effect to time zero before playback and logs load or playback failures without substituting another file, except for that explicit attack-type fallback.

## Adding Audio

1. Add an `.mp3`, `.m4a`, or other browser-supported audio file under `client/public/audio/`.
2. Add music to the `contexts` record in `client/music-manager.ts`, including `loop: false` when it must stop after one pass.
3. Add effects through `loadSound()` and a public play method in `client/sound-effects.ts`.
4. Trigger the context or method from an authoritative state transition or event.
5. Test with the global mute preference enabled and disabled, and test under browser autoplay restrictions.

## Troubleshooting

| Symptom | Check |
|---|---|
| No music | Browser autoplay console errors, the persisted mute setting, the context transition, and the `/audio/` URL |
| Playlist does not advance | The `ended` event, context track order, and the context's `loop` value |
| No effects | The music mute state, the loaded effect key, and the 100-millisecond same-key debounce |
| Brief gap between tracks | Native `HTMLAudioElement` playlist changes are not gapless |
