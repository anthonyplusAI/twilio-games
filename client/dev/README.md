# Local Wizard Chess cinematic preview

From the repository root, run `npm run dev:server` and `npm run dev:client` in separate terminals, then open [http://localhost:5173/dev/wizard-cinematic-preview.html](http://localhost:5173/dev/wizard-cinematic-preview.html). The browser page uses the same board, model loader, scene controller, and audio endpoint as the game. Its buttons emulate the server story, caller-move, and resolved snapshots so a Twilio call is not needed to review the sequence.

The GitHub Actions secret is not available to a local process. To hear the ElevenLabs character voices, provide `ELEVENLABS_API_KEY` to the local Node server from your local secret manager or shell. Alternatively, put it in the ignored root `.env.local` file and start the backend with `PORT=8080 PUBLIC_BASE_URL=http://localhost:5173 node --env-file-if-exists=.env.local --import tsx server/index.ts`. Restart the backend after adding the key. Without it, captions and camera/action visuals remain playable. The local server also serves the GLB models and caches generated scene clips under `data/wizard-chess-audio/`.

This page is a Vite development route only; it is not an input to the production build.
