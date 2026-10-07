import { defineConfig, loadEnv } from 'vite';
import { createReadStream, existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'path';

// In dev the client is served by Vite while APIs, GLBs, and WebSockets come from the node game server.
// GAME_SERVER_URL selects that backend (default 8080); browser code remains same-origin in dev/prod.
//
// Multi-page build, served by clean paths:
//   /            → index.html        (branded home/lobby)
//   /how-it-works.html → how-it-works.html (voice architecture explainer)
//   /play.html   → play.html         (the racer)
//   /editor      → editor/index.html (the unified Level Editor)
//   /garage      → garage/index.html (the model viewer + configurator)
// Dev server only: Vite resolves folder-index pages at the TRAILING-SLASH path
// (`/editor/` → editor/index.html) but lets bare `/editor` fall through to the root page. This
// middleware redirects the bare paths to their slashed form so `/editor` and `/garage`
// work as typed. (Production static hosts serve folder index.html for the bare path natively.)
const cleanIndexRoutes = () => ({
  name: 'clean-index-routes',
  configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: { writeHead: (c: number, h: Record<string, string>) => void; end: () => void }, next: () => void) => void) => void } }) {
    server.middlewares.use((req, res, next) => {
      const requestUrl = req.url ?? '';
      const url = requestUrl.split('?')[0];
      if (url === '/operator' || url === '/operator/' || url === '/player' || url === '/player/') {
        req.url = `/arcade/${requestUrl.slice(url.length)}`;
        next(); return;
      }
      if (url === '/arcade' || url === '/arcade/' || url === '/arcade/index.html') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });res.end();return;
      }
      if (url === '/editor' || url === '/garage' || url === '/analytics' || url === '/join' || url === '/instructions') {
        res.writeHead(301, { Location: `${url}/${requestUrl.slice(url.length)}` }); res.end(); return;
      }
      next();
    });
  },
});

const karaokeAuthoringAudio = () => ({
  name: 'karaoke-authoring-audio',
  configureServer(server: { middlewares: { use: (fn: (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) => void) => void } }) {
    server.middlewares.use((req, res, next) => {
      if ((req.url ?? '').split('?')[0] !== '/audio/karaoke/classic-45s.mp3') { next(); return; }
      const file = resolve(__dirname, '../assets/karaoke/_raw/audio/classic-45s.mp3');
      if (!existsSync(file)) { next(); return; }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
      createReadStream(file).pipe(res);
    });
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const gameServer = env.GAME_SERVER_URL || 'http://localhost:8080';
  const expectedGameServerOrigin = configuredGameServerOrigin(gameServer, env.GAME_SERVER_EXPECTED_ORIGIN);
  return {
    root: __dirname,
    plugins: [cleanIndexRoutes(), karaokeAuthoringAudio()],
    server: {
      proxy: {
        '/api': {
          target: gameServer,
          changeOrigin: true,
          configure(proxy) {
            proxy.on('proxyReq', (proxyRequest, request) => {
              const origin = request.headers.origin;
              const forwardedOrigin = forwardedGameServerOrigin(origin, request.headers.host, expectedGameServerOrigin);
              if (forwardedOrigin !== undefined && forwardedOrigin !== origin) {
                proxyRequest.setHeader('origin', forwardedOrigin);
              }
            });
          },
        },
        '/auth': { target: gameServer, changeOrigin: true },
        '/game': { target: gameServer, ws: true, bypass: bypassNonWebSocket },
        '/battle': { target: gameServer, ws: true, bypass: bypassNonWebSocket },
        '/fighter': { target: gameServer, ws: true, bypass: bypassNonWebSocket },
        '/chess': {
          target: gameServer,
          ws: true,
          bypass: bypassNonWebSocket,
          configure(proxy) {
            proxy.on('proxyReqWs', (proxyRequest, request) => {
              const origin = request.headers.origin;
              const forwardedOrigin = forwardedGameServerOrigin(
                origin,
                request.headers.host,
                expectedGameServerOrigin,
              );
              if (forwardedOrigin !== undefined && forwardedOrigin !== origin) {
                proxyRequest.setHeader('origin', forwardedOrigin);
              }
            });
          },
        },
        '/karaoke': { target: gameServer, ws: true, bypass: bypassNonWebSocket },
        '/trivia': {
          target: gameServer,
          ws: true,
          bypass: bypassNonWebSocket,
          configure(proxy) {
            proxy.on('proxyReqWs', (proxyRequest, request) => {
              const origin = request.headers.origin;
              const forwardedOrigin = forwardedGameServerOrigin(
                origin,
                request.headers.host,
                expectedGameServerOrigin,
              );
              if (forwardedOrigin !== undefined && forwardedOrigin !== origin) {
                proxyRequest.setHeader('origin', forwardedOrigin);
              }
            });
          },
        },
        '/voice': { target: gameServer, ws: true, bypass: bypassNonWebSocket },
        // GLB models live in the repo-root assets/ served by the node server, so /assets is proxied.
        // EXCEPT monster sprites, which live in client/public/assets/monsters/ and are served by Vite.
        '/assets': {
          target: gameServer, changeOrigin: true,
          bypass: (req) => {
            const url = (req.url ?? '').split('?')[0] ?? '';
            return url.startsWith('/assets/monsters/') ? url : undefined;
          },
        },
      },
    },
    build: {
      rollupOptions: {
        input: {
          home: resolve(__dirname, 'index.html'),                  // branded landing/lobby
          howItWorks: resolve(__dirname, 'how-it-works.html'),       // public voice architecture explainer
          play: resolve(__dirname, 'play.html'),                    // the racer
          monsters: resolve(__dirname, 'monsters.html'),           // Voice Monsters (the battler)
          fighter: resolve(__dirname, 'fighter.html'),              // Voice Fighter gameplay prototype
          karaoke: resolve(__dirname, 'karaoke.html'),              // Voice Karaoke
          trivia: resolve(__dirname, 'trivia.html'),                // Voice Trivia display
          chess: resolve(__dirname, 'chess.html'),                  // Voice Chess display
          editor: resolve(__dirname, 'editor/index.html'),          // unified Level Editor (/editor)
          garage: resolve(__dirname, 'garage/index.html'),          // model viewer + configurator (/garage)
          analytics: resolve(__dirname, 'analytics/index.html'),    // private activation analytics (/analytics)
          arcade: resolve(__dirname, 'arcade/index.html'),          // Twilio Games player and operator pages
          join: resolve(__dirname, 'join/index.html'),              // localized SMS / WhatsApp chooser
          instructions: resolve(__dirname, 'instructions/index.html'), // Portuguese event instructions
          challenge: resolve(__dirname, 'challenge/index.html'),    // scanner-safe messaging reward claim
        },
      },
    },
  };
});

function bypassNonWebSocket(req: { url?: string; headers: { upgrade?: string } }): string | undefined {
  return req.headers.upgrade?.toLowerCase() === 'websocket' ? undefined : req.url;
}

export function configuredGameServerOrigin(_gameServer: string, configuredOrigin?: string): string {
  return new URL(configuredOrigin || 'http://localhost:5173').origin;
}

export function forwardedGameServerOrigin(
  requestOrigin: string | undefined,
  requestHost: string | undefined,
  expectedOrigin: string,
): string | undefined {
  if (!requestOrigin || !requestHost) return requestOrigin;
  try {
    const origin = new URL(requestOrigin);
    const host = new URL(`${origin.protocol}//${requestHost}`);
    const validHttpOrigin = (origin.protocol === 'http:' || origin.protocol === 'https:')
      && requestOrigin === origin.origin;
    const sameHost = origin.host === host.host;
    const sameLoopback = loopbackHostname(origin.hostname) && loopbackHostname(host.hostname)
      && origin.port === host.port;
    return validHttpOrigin && (sameHost || sameLoopback) ? expectedOrigin : requestOrigin;
  } catch {
    return requestOrigin;
  }
}

function loopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}
