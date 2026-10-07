# Join QR Assets

This directory contains three browser-public QR PNGs. Runtime-generated QR codes handle normal joins; the PNGs provide a standalone fallback and deployment-specific station artwork. See the [project README](../../../README.md) for application setup and the [asset credits](../../../assets/CREDITS.md) for the repository provenance ledger.

## Inventory

| File | Dimensions | Runtime role |
|---|---:|---|
| `join-qr.png` | 600 by 600 | Fallback for Voice Racer, Voice Monsters, and Voice Fighter when they cannot generate a QR for the locale-specific voice number |
| `arcade-en.png` | 600 by 600 | English station join QR for the production `ARCADE-01` deployment |
| `arcade-pt.png` | 1200 by 1200 | Brazilian Portuguese station join QR for the production `ARCADE-01` deployment |

## Installation

These assets ship with the main application and require no separate installation. Follow the [root installation guide](../../../README.md#installation). Vite copies the files into the build and serves them from `/brand/`.

## Usage

### Standalone Joins

In standalone mode, all six games watch the configured number for the display locale. Racer, Monsters, and Fighter generate a 520-pixel QR data URL for `tel:<number>` with medium error correction. Karaoke, Trivia, and Chess also generate `tel:` QRs for their standalone waiting screens. Each browser updates its number and generated QR when the runtime configuration changes. Trivia and Chess show a tappable number with the QR; callers answer or move through `/voice`, while the Chess display lets viewers adjust its camera.

`/brand/join-qr.png?v=2` is only the Racer, Monsters, and Fighter fallback. Those standalone lobbies use it when their locale has no configured number or when `QRCode.toDataURL()` fails. Karaoke, Trivia, and Chess omit the QR when the number is unavailable or generation fails; they do not show a potentially stale fallback. Replacing the PNG changes only the fallback in the first three lobbies, not a normal generated QR or the written phone number.

The default configuration exposes six enabled voice games. The standalone launcher follows the persisted display order and shows three games per page, so the default second page contains Voice Karaoke fourth, Voice Trivia fifth, and Voice Chess sixth. Global game numbers do not change when games are disabled or reordered: Karaoke remains station and Messaging option `4`, Trivia option `5`, and Chess option `6`.

The dialed locale-specific number determines the call locale when it maps uniquely to `en-US` or `pt-BR`. With the event paused and standalone voice enabled, a normal incoming call routes to room `4821` only when exactly one enabled game has a still-open `display=1` connection actually joined to that room. A socket that has not joined the room, or a non-display socket, cannot claim the call. With no eligible game display or multiple different game displays open, the call is unavailable; close unused game tabs before dialing. Standalone displays do not pair or validate the station display token.

Station-managed booth displays are different: an operator pairs the intended tab through `/operator`, which stores display access in that tab's `sessionStorage`. Station launch URLs and visitor QRs carry no display credential. Trivia and Chess suppress their standalone call QRs on station launches; the shared station rail supplies the visitor `/join` QR. While an event is active, the caller's persisted station assignment chooses the game and dynamically generated room; standalone display recency is not consulted.

### Station Joins

Generated station QR codes encode an HTTP join URL, not a `tel:` URL:

```text
/join?station=<station-id>&locale=<locale>
```

The home and player views generate this QR at 520 pixels. The in-game station rail generates the same station-and-locale URL at 420 pixels. All views use the configured public visitor origin when available, and station-client tests cover asset selection plus generated-URL fallback.

For station `ARCADE-01` on the configured production origin, `stationQrAsset()` selects `arcade-en.png` or `arcade-pt.png` before generating a QR. Those committed PNGs encode `https://twil.io/arcade-en?qr=1` and `https://twil.io/arcade-pt?qr=1`; the short links redirect to the locale-specific `/join` URLs. `resolveStationQrImage()` probes the selected image and generates the direct station join URL if the image cannot load. Other station IDs and origins always use a generated QR. There is no general image-element error-handler contract beyond this explicit resolution step.

Scanning a station QR starts the `/join` registration, wallet, and queue flow. English exposes each enabled channel with a valid configured number, SMS, WhatsApp, or both, and prefills `JOIN`. Portuguese suppresses SMS, exposes configured WhatsApp with `ENTRAR`, and reports entry unavailable in coin-only mode when WhatsApp is absent. Lead-capture mode also exposes a browser fallback for either locale, including browser-only entry when no compatible messaging channel is available. When the caller reaches an active match, the server routes the call from its persisted station assignment to the selected game and that match's dynamically generated engine room. The launched display receives the same assigned room. Replacing a PNG cannot override those assignments or bind callers to a fixed room.

### Updating The Files

Keep every replacement square and test it from the deployed public origin on a physical phone. Update `join-qr.png` only as a safe fallback for the current standalone voice entry point. Update `arcade-en.png` and `arcade-pt.png` together with their `twil.io` redirect destinations and the final production `/join` URLs and locale parameters.

The standalone fallback references include `?v=2`. Increment that query in `client/screens.ts`, `client/battle/monsters.ts`, and `client/fighter/fighter.ts` only when an intermediary continues to serve an obsolete fallback image.

## License

The repository has no root `LICENSE` file. A generated QR may encode operational phone or routing information and should be reviewed before distribution. The current [asset credits](../../../assets/CREDITS.md) do not record provenance for these images. Twilio names and logos in the same directory remain subject to Twilio brand permissions; repository inclusion does not grant trademark or reuse rights.
