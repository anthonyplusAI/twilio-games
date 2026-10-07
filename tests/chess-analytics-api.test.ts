import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { HttpServer } from '../server/http-server';
import { GoogleAnalyticsAuth } from '../server/google-analytics-auth';

let server: HttpServer | undefined;
let directory: string | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('Voice Chess analytics API', () => {
  it('reports separate phone callers, accepted commands, and a Chess PDF without exposing call IDs', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'chess-analytics-'));
    const analyticsPath = path.join(directory, 'analytics.json');
    const auth = new GoogleAnalyticsAuth({ redirectUri: 'http://localhost/auth/google/callback',
      adminPin: 'Chess!Metrics#2026' });
    const cookie = auth.issueSession('reporter@twilio.com').split(';')[0]!;
    server = new HttpServer({
      port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
      standaloneVoiceEnabled: true, analyticsAuth: auth, analyticsPath,
      manifestPath: path.join(directory, 'manifest.json'),
      mapsPath: path.join(directory, 'maps.json'),
      arenaPath: path.join(directory, 'arena.json'),
      leaderboardPath: path.join(directory, 'leaderboard.json'),
      fighterMapsPath: path.join(directory, 'fighter-maps.json'),
      fighterPreviewDir: path.join(directory, 'fighter-previews'),
      clientDir: path.join(directory, 'client'),
    });
    const port = await server.start();
    const base = `http://127.0.0.1:${port}`;

    for (const callSid of ['CA-chess-metrics-first', 'CA-chess-metrics-second']) {
      const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
      const spoken: string[] = [];
      voice.on('message', data => {
        const message = JSON.parse(data.toString()) as { type: string; token?: string };
        if (message.type !== 'text') return;
        spoken.push(message.token ?? '');
        if (voice.readyState === WebSocket.OPEN) {
          voice.send(JSON.stringify({ type: 'info', name: 'tokensPlayed', value: message.token }));
        }
      });
      await new Promise<void>((resolve, reject) => { voice.once('open', resolve); voice.once('error', reject); });
      voice.send(JSON.stringify({ type: 'setup', callSid,
        customParameters: { game: 'chess', roomCode: '4821', locale: 'en-US' } }));
      await vi.waitFor(() => expect(spoken.join(' ')).toContain('Welcome to Voice Chess'), { timeout: 2_000 });
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'help', last: true }));
      await vi.waitFor(() => expect(spoken.join(' ')).toMatch(/Say a piece and destination.*infer a unique legal source/i), { timeout: 2_000 });
      const ended = await fetch(`${base}/voice/session-ended`, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ CallSid: callSid, SessionStatus: 'completed', CallStatus: 'completed' }) });
      expect(ended.status).toBe(200);
      const closed = new Promise<void>(resolve => voice.once('close', () => resolve()));
      voice.close();
      await closed;
    }

    const response = await fetch(`${base}/api/analytics?game=chess`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report.filter).toBe('chess');
    expect(report.summary).toMatchObject({
      participants: 2, sessions: 2, completed: 0, abandoned: 2, voiceCommands: 2,
    });
    expect(report.games.chess.sessions).toBe(2);
    expect(report.games.racer.sessions).toBe(0);

    const pdf = await fetch(`${base}/api/analytics.pdf?game=chess`, { headers: { cookie } });
    expect(pdf.status).toBe(200);
    expect(Buffer.from(await pdf.arrayBuffer()).toString()).toContain('Voice Chess');

    await server.stop(); server = undefined;
    const persisted = await readFile(analyticsPath, 'utf8');
    expect(persisted).not.toMatch(/CA-chess-metrics-first|CA-chess-metrics-second|voicePrompt|help/);
  });
});
