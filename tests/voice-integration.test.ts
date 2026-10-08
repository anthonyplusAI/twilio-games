import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import twilio from 'twilio';
import { HttpServer } from '../server/http-server';
import type { GameServer } from '../server/game-server';

let srv: HttpServer;
afterEach(async () => { vi.restoreAllMocks(); await srv?.stop(); });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const closeWs = (ws: WebSocket) => { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(); };
const acknowledgeText = (ws: WebSocket, message: Record<string, unknown>): void => {
  if (message.type === 'text') ws.send(JSON.stringify({ type: 'info', name: 'tokensPlayed', value: message.token }));
};
const DISPLAY_TOKEN = 'test-standalone-display-token';

describe('voice integration (fake Conversation Relay client)', () => {
  it('rejects speech frames before Relay setup without assigning them to a game', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start();
    const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
    await new Promise<void>((resolve, reject) => {
      voice.once('open', resolve);
      voice.once('error', reject);
    });
    const closed = new Promise<number>(resolve => voice.once('close', resolve));
    voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'start the game', last: true }));
    expect(await closed).toBe(1008);
  });

  it('validates the Conversation Relay WebSocket handshake signature', async () => {
    const authToken='voice-websocket-auth-token';
    srv=new HttpServer({port:0,publicBaseUrl:'http://localhost',validateSignatures:true,authToken});
    const port=await srv.start();
    const signature=twilio.getExpectedTwilioSignature(authToken,'ws://localhost/voice',{});
    const valid=new WebSocket(`ws://127.0.0.1:${port}/voice`,{headers:{'X-Twilio-Signature':signature}});
    await new Promise<void>((resolve,reject)=>{valid.once('open',resolve);valid.once('error',reject);});
    closeWs(valid);

    const invalid=new WebSocket(`ws://127.0.0.1:${port}/voice`,{headers:{'X-Twilio-Signature':'invalid'}});
    const status=await new Promise<number>((resolve,reject)=>{
      invalid.once('unexpected-response',(_request,response)=>resolve(response.statusCode??0));
      invalid.once('error',reject);
    });
    expect(status).toBe(403);
  });

  it('waits for playback completion before sending the next spoken line', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start();
    const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
    const messages: Record<string, unknown>[] = [];
    voice.on('message', data => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === 'text') messages.push(message);
    });
    await new Promise<void>(resolve => voice.on('open', resolve));
    voice.send(JSON.stringify({ type: 'setup', callSid: 'CA-paced', customParameters: { roomCode: 'PACED' } }));

    await wait(100);
    expect(messages).toHaveLength(1);
    await wait(800);
    expect(messages).toHaveLength(1);
    acknowledgeText(voice, messages[0]!);
    await wait(50);
    expect(messages).toHaveLength(2);
    acknowledgeText(voice, messages[1]!);
    closeWs(voice);
  });

  it.each(['64107', '64111'])('releases a failed speech token after Relay error %s', async errorCode => {
    vi.spyOn(console,'error').mockImplementation(()=>undefined);
    srv = new HttpServer({ port:0,publicBaseUrl:'http://localhost',validateSignatures:false });
    const port=await srv.start();const voice=new WebSocket(`ws://127.0.0.1:${port}/voice`);
    const messages:Record<string,unknown>[]=[];
    voice.on('message',data=>{const message=JSON.parse(data.toString()) as Record<string,unknown>;if(message.type==='text')messages.push(message);});
    await new Promise<void>(resolve=>voice.on('open',resolve));
    voice.send(JSON.stringify({type:'setup',callSid:`CA-tts-error-${errorCode}`,customParameters:{roomCode:'TTSERR'}}));
    try {
      await wait(50);expect(messages).toHaveLength(1);
      voice.send(JSON.stringify({type:'error',description:`${errorCode} Relay speech failure`}));
      await wait(750);expect(messages).toHaveLength(2);
    } finally { closeWs(voice); }
  });

  it('retires a station voice session after queued speech plays without a WebSocket failure', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start();
    const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
    let closeCode: number | null = null;
    let lastPlayedAt = 0;
    let endedAt = 0;
    voice.on('close', code => { closeCode = code; });
    const receivedTypes:string[]=[];
    const ended = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Relay end message was not received')), 8_000);
      voice.on('message', data => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        receivedTypes.push(String(message.type));
        if (message.type === 'text') {
          lastPlayedAt = Date.now();
          voice.send(JSON.stringify({ type: 'info', name: 'tokensPlayed', value: message.token }));
        } else if (message.type === 'end') {
          endedAt = Date.now();
          clearTimeout(timeout);
          resolve(message);
        }
      });
    });
    await new Promise<void>(resolve => voice.on('open', resolve));
    voice.send(JSON.stringify({ type: 'setup', callSid: 'CA-retire', customParameters: { roomCode: 'RETIRE' } }));
    await wait(50);

    (srv as unknown as { retireStationEngine(game:'racer',roomCode:string):void })
      .retireStationEngine('racer', 'RETIRE');
    voice.send(JSON.stringify({type:'prompt',voicePrompt:'help',last:true}));
    const message = await ended;

    expect(JSON.parse(String(message.handoffData))).toEqual({ reasonCode: 'match-complete' });
    expect(receivedTypes.at(-1)).toBe('end');
    expect(closeCode).toBeNull();
    expect(endedAt - lastPlayedAt).toBeGreaterThanOrEqual(650);
    const internal=srv as unknown as {game:GameServer;racerVoiceCallBindings:Map<string,unknown>;stationVoiceReconnectRoutes:Map<string,unknown>};
    expect(internal.game.findRoom('RETIRE')).toBeUndefined();
    expect(internal.racerVoiceCallBindings.size).toBe(0);
    expect(internal.stationVoiceReconnectRoutes.size).toBe(0);
    voice.send(JSON.stringify({type:'prompt',voicePrompt:'say something else',last:true}));
    await wait(100);
    expect(receivedTypes.at(-1)).toBe('end');
    closeWs(voice);
  });

  it('ends graceful retirement promptly when the caller interrupts queued speech', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start();
    const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
    const ended = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Relay end waited for the fallback timeout')), 2_000);
      voice.on('message', data => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === 'end') { clearTimeout(timeout); resolve(); }
      });
    });
    await new Promise<void>(resolve => voice.on('open', resolve));
    voice.send(JSON.stringify({ type: 'setup', callSid: 'CA-interrupt', customParameters: { roomCode: 'INTERRUPT' } }));
    await wait(50);

    (srv as unknown as { retireStationEngine(game:'racer',roomCode:string):void })
      .retireStationEngine('racer', 'INTERRUPT');
    voice.send(JSON.stringify({ type:'interrupt', utteranceUntilInterrupt:'Welcome', durationUntilInterruptMs:100 }));
    await ended;
    closeWs(voice);
  });

  it.each([
    ['DTMF', {type:'dtmf',digit:'1'}],
    ['TTS error', {type:'error',description:'64111 TTS provider failure'}],
  ])('ends retirement promptly after a %s stops active speech', async (_label,frame) => {
    vi.spyOn(console,'error').mockImplementation(()=>undefined);
    srv=new HttpServer({port:0,publicBaseUrl:'http://localhost',validateSignatures:false});
    const port=await srv.start();const voice=new WebSocket(`ws://127.0.0.1:${port}/voice`);
    const ended=new Promise<void>((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Relay end was not received promptly')),2_000);
      voice.on('message',data=>{if(JSON.parse(data.toString()).type==='end'){clearTimeout(timeout);resolve();}});
    });
    await new Promise<void>(resolve=>voice.on('open',resolve));
    voice.send(JSON.stringify({type:'setup',callSid:`CA-retire-${_label}`,customParameters:{roomCode:`RETIRE-${_label}`}}));
    await wait(50);(srv as unknown as {retireStationEngine(game:'racer',roomCode:string):void}).retireStationEngine('racer',`RETIRE-${_label}`);
    voice.send(JSON.stringify(frame));await ended;closeWs(voice);
  });

  it('keeps the Racer scoreboard and recap when a final go transcript arrives after the finish', async () => {
    srv = new HttpServer({ port:0,publicBaseUrl:'http://localhost',validateSignatures:false,standaloneVoiceEnabled:true });
    const port = await srv.start();
    const game = (srv as unknown as { game: GameServer }).game;
    game.setRoomConfigProvider(() => ({ carCount:1,carNames:['Roadster'],maps:['Silver Lake'] }));

    const displayMessages:Record<string,unknown>[]=[];
    const display=new WebSocket(`ws://127.0.0.1:${port}/game?display=1`);
    display.on('message',data=>displayMessages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve,reject)=>{display.once('open',resolve);display.once('error',reject);});
    display.send(JSON.stringify({type:'spectate',roomCode:'LATEGO'}));

    const spoken:string[]=[];
    const voice=new WebSocket(`ws://127.0.0.1:${port}/voice`);
    voice.on('message',data=>{
      const message=JSON.parse(data.toString()) as Record<string,unknown>;
      if(message.type==='text'){
        spoken.push(String(message.token));
        acknowledgeText(voice, message);
      }
    });
    await new Promise<void>((resolve,reject)=>{voice.once('open',resolve);voice.once('error',reject);});
    try {
      voice.send(JSON.stringify({type:'setup',callSid:'CA-late-go',customParameters:{roomCode:'LATEGO'}}));
      await wait(50);

      const room=game.findRoom('LATEGO')!;
      const player=room.lobbyPlayers()[0]!;
      room.setPlayerInfo(player.playerId,{name:'Ada'});
      room.advance();room.selectCar(player.playerId,0);room.advance();room.selectMap('Silver Lake');room.advance();
      // This integration drives the room directly, bypassing the usual items broadcast. The
      // standalone screen must still acknowledge scene readiness before the countdown runs.
      const pausedCountdown = room.snapshot()!.countdown;
      game.stepRoomForTest(room, .1);
      expect(room.snapshot()!.countdown).toBe(pausedCountdown);
      display.send(JSON.stringify({type:'ready'}));
      await wait(20);
      for(let i=0;i<100&&room.phase!=='racing';i++)game.stepRoomForTest(room,0.1);
      expect(room.phase).toBe('racing');
      voice.send(JSON.stringify({type:'interrupt',utteranceUntilInterrupt:'',durationUntilInterruptMs:0}));
      await wait(20);spoken.length=0;displayMessages.length=0;
      for(let i=0;i<2000&&room.phase!=='results';i++)game.stepRoomForTest(room,0.1);
      expect(room.phase).toBe('results');

      // The finish itself must speak the factual placement and leaderboard; an extra caller
      // prompt must never be required to coax the result out of the agent.
      await vi.waitFor(() => {
        expect(spoken.join(' ')).toMatch(/won first place.*seconds/i);
        expect(spoken.join(' ')).toMatch(/rank .* on the leaderboard/i);
        expect(spoken.join(' ')).toMatch(/Conversation Relay transcribed your phone commands/i);
        expect(spoken.join(' ')).toMatch(/<phoneme alphabet="ipa" ph="ˈtwɪlioʊ">Twilio<\/phoneme>/i);
        expect(spoken.join(' ')).toMatch(/game server steered the car on this screen/i);
      }, { timeout: 2_000 });
      const resultSpeech = spoken.join(' ');

      voice.send(JSON.stringify({type:'prompt',voicePrompt:'go now',last:false}));
      voice.send(JSON.stringify({type:'prompt',voicePrompt:'go now please',last:true}));
      await wait(200);

      expect(room.phase).toBe('results');
      const resultsIndex=displayMessages.findIndex(message=>message.type==='results');
      expect(resultsIndex).toBeGreaterThanOrEqual(0);
      expect(displayMessages.slice(resultsIndex+1)).not.toContainEqual(expect.objectContaining({type:'select_state',phase:'car_select'}));
      expect(spoken.join(' ')).toMatch(/won first place.*seconds/i);
      expect(spoken.join(' ')).toMatch(/rank .* on the leaderboard/i);
      expect(spoken.join(' ')).not.toMatch(/choose a car/i);
      expect(spoken.join(' ')).toBe(resultSpeech);

      voice.send(JSON.stringify({type:'prompt',voicePrompt:'go again',last:true}));
      await wait(100);
      expect(room.phase).toBe('car_select');
    } finally {
      closeWs(voice);closeWs(display);
    }
  },20_000);

  it('routes standalone calls from the explicit shared display, not a later attendee socket', async () => {
    srv = new HttpServer({
      port:0,publicBaseUrl:'http://localhost',validateSignatures:false,standaloneVoiceEnabled:true,
      fighterDisplayToken:DISPLAY_TOKEN,
    });
    const port=await srv.start();
    const display=new WebSocket(`ws://127.0.0.1:${port}/battle?display=1`);
    await new Promise<void>(resolve=>display.on('open',resolve));
    display.send(JSON.stringify({type:'spectate',roomCode:'4821'}));
    await wait(30);
    const attendee=new WebSocket(`ws://127.0.0.1:${port}/game`);
    await new Promise<void>(resolve=>attendee.on('open',resolve));

    const response=await fetch(`http://127.0.0.1:${port}/voice/incoming`,{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'CallSid=CA-standalone&From=%2B14155550199',
    });
    const xml=await response.text();
    expect(xml).toContain('<Parameter name="game" value="monsters"');
    closeWs(attendee);closeWs(display);
  });

  it('does not treat Fighter display authentication as presence until the screen spectates', async () => {
    srv = new HttpServer({
      port:0,publicBaseUrl:'http://localhost',validateSignatures:false,standaloneVoiceEnabled:true,
      fighterDisplayToken:DISPLAY_TOKEN,
    });
    const port=await srv.start();
    const fighter=new WebSocket(`ws://127.0.0.1:${port}/fighter?display=1`);
    const fighterMessages:Record<string,unknown>[]=[];
    fighter.on('message',data=>fighterMessages.push(JSON.parse(data.toString()) as Record<string,unknown>));
    await new Promise<void>((resolve,reject)=>{fighter.once('open',resolve);fighter.once('error',reject);});
    fighter.send(JSON.stringify({type:'display_auth',roomCode:'4821',token:DISPLAY_TOKEN}));
    await wait(30);

    const before=await fetch(`http://127.0.0.1:${port}/voice/incoming`,{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'CallSid=CA-fighter-auth&From=%2B14155550199',
    });
    expect(await before.text()).not.toContain('<ConversationRelay');

    fighter.send(JSON.stringify({type:'spectate',roomCode:'4821'}));
    await vi.waitFor(()=>expect(fighterMessages).toContainEqual(expect.objectContaining({
      type:'host_identity',roomCode:'4821',isHost:true,
    })));
    const after=await fetch(`http://127.0.0.1:${port}/voice/incoming`,{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'CallSid=CA-fighter-display&From=%2B14155550199',
    });
    expect(await after.text()).toContain('<Parameter name="game" value="fighter"');
    closeWs(fighter);
  });

  it('returns explicit hangup TwiML after Conversation Relay ends', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start();
    const response = await fetch(`http://127.0.0.1:${port}/voice/session-ended`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'CallSid=CA-ended&SessionStatus=failed&ErrorCode=64106&ErrorMessage=Invalid+voice+configuration',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/xml');
    expect(await response.text()).toContain('<Hangup />');
    expect(log).toHaveBeenCalledWith('[CR] session ended call=CA-ended status=failed error=64106 message=Invalid voice configuration');
  });

  it('returns reconnect TwiML after a recoverable Relay transport failure', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start();
    const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
    await new Promise<void>(resolve => voice.on('open', resolve));
    voice.send(JSON.stringify({ type:'setup', callSid:'CA-reconnect-action', customParameters:{ roomCode:'RECONNECT' } }));
    await wait(40); voice.close(); await new Promise<void>(resolve => voice.once('close', resolve));

    const response = await fetch(`http://127.0.0.1:${port}/voice/session-ended`, {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:'CallSid=CA-reconnect-action&CallStatus=in-progress&SessionStatus=failed&ErrorCode=39001',
    });
    const xml = await response.text();
    expect(xml).toContain('<ConversationRelay');
    expect(xml).toContain('<Parameter name="roomCode" value="RECONNECT"');
    expect(xml).not.toContain('<Hangup />');
  });

  it('does not retry a permanent Relay configuration failure even with a resumable caller', async () => {
    srv=new HttpServer({port:0,publicBaseUrl:'http://localhost',validateSignatures:false});const port=await srv.start();
    const voice=new WebSocket(`ws://127.0.0.1:${port}/voice`);await new Promise<void>(resolve=>voice.on('open',resolve));
    voice.send(JSON.stringify({type:'setup',callSid:'CA-permanent',customParameters:{roomCode:'PERMANENT'}}));
    await wait(40);voice.close();await new Promise<void>(resolve=>voice.once('close',resolve));
    const response=await fetch(`http://127.0.0.1:${port}/voice/session-ended`,{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:'CallSid=CA-permanent&CallStatus=in-progress&SessionStatus=failed&ErrorCode=64106',
    });
    const xml=await response.text();expect(xml).toContain('<Hangup />');expect(xml).not.toContain('<ConversationRelay');
  });

  it('inherits Twilio STT and TTS locale from the active display room', async () => {
    srv = new HttpServer({
      port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
      fighterDisplayToken: DISPLAY_TOKEN,
    });
    const port = await srv.start();
    const display = new WebSocket(`ws://127.0.0.1:${port}/game?display=1`);
    await new Promise<void>(resolve => display.on('open', resolve));
    display.send(JSON.stringify({
      type: 'spectate', roomCode: '8552', locale: 'pt-BR', displayToken: DISPLAY_TOKEN,
    }));
    await wait(30);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/voice/join`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'Digits=8552',
      });
      const xml = await response.text();
      expect(xml).toContain('transcriptionLanguage="pt-BR"');
      expect(xml).toContain('ttsLanguage="pt-BR"');
      expect(xml).toContain('<Parameter name="commandLocale" value="pt-BR"');
      expect(xml).toContain('hints="esquerda, direita, acelerar');
    } finally {
      closeWs(display);
    }
  });

  it('a CR socket joins a room by code and a spoken command moves the car', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start();

    // a browser spectator watches the same room over /game
    const spec = new WebSocket(`ws://127.0.0.1:${port}/game`);
    const inbox: any[] = [];
    spec.on('message', d => inbox.push(JSON.parse(d.toString())));
    await new Promise<void>(r => spec.on('open', () => r()));
    spec.send(JSON.stringify({ type: 'spectate', roomCode: '4821' }));

    // the "phone" connects over /voice as Conversation Relay would
    const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
    await new Promise<void>(r => voice.on('open', () => r()));
    voice.send(JSON.stringify({
      type: 'setup', callSid: 'CA1', from: '+15551239999',
      customParameters: { roomCode: '4821' },
    }));
    await wait(50);
    voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Ada', last: true }));
    await wait(50);

    // The voice player is now in room 4821. The spectator/operator console starts
    // the race: restart() calls room.start() with no playerId required on the conn.
    spec.send(JSON.stringify({ type: 'restart' }));
    await wait(100);

    // a spoken command should move the single phone player's car
    voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'right', last: true }));
    await wait(300);

    const snap = [...inbox].reverse().find(m => m.type === 'snapshot') as any;
    expect(snap).toBeDefined();
    expect(snap.snapshot.cars.length).toBe(1);   // exactly the phone player
    expect(snap.snapshot.cars[0].targetLane).toBe(1);
    voice.close();
    spec.close();
  });

  it('binds two Racer calls to independent cars and never cross-applies commands', async () => {
    srv=new HttpServer({port:0,publicBaseUrl:'http://localhost',validateSignatures:false});const port=await srv.start();
    const game=(srv as unknown as {game:GameServer}).game;
    game.setRoomConfigProvider(()=>({carCount:2,carNames:['Roadster','Coupe'],maps:['Silver Lake','Drift']}));
    game.getOrCreateRoom('TWO-RACERS').expectHumanPlayers(2);
    const connect=async(callSid:string,from:string)=>{
      const ws=new WebSocket(`ws://127.0.0.1:${port}/voice`);
      ws.on('message',data=>{const message=JSON.parse(data.toString()) as Record<string,unknown>;acknowledgeText(ws,message);});
      await new Promise<void>(resolve=>ws.on('open',resolve));
      ws.send(JSON.stringify({type:'setup',callSid,from,customParameters:{roomCode:'TWO-RACERS'}}));
      return ws;
    };
    const a=await connect('CA-racer-a','+15550000001');const b=await connect('CA-racer-b','+15550000002');
    try{
      await wait(80);const room=game.findRoom('TWO-RACERS')!;const [playerA,playerB]=room.lobbyPlayers();
      expect(playerA?.playerId).not.toBe(playerB?.playerId);
      expect(room.phase).toBe('lobby');
      a.send(JSON.stringify({type:'prompt',voicePrompt:'Ada',last:true}));
      b.send(JSON.stringify({type:'prompt',voicePrompt:'Bo',last:true}));
      await wait(80);
      a.send(JSON.stringify({type:'prompt',voicePrompt:'start',last:true}));await wait(1_600);expect(room.phase).toBe('car_select');
      a.send(JSON.stringify({type:'prompt',voicePrompt:'one',last:true}));await wait(60);
      expect(room.lobbyPlayers()).toEqual(expect.arrayContaining([
        expect.objectContaining({playerId:playerA!.playerId,carIndex:0}),
        expect.objectContaining({playerId:playerB!.playerId,carIndex:null}),
      ]));
      b.send(JSON.stringify({type:'prompt',voicePrompt:'two',last:true}));await wait(60);
      expect(room.lobbyPlayers()).toEqual(expect.arrayContaining([
        expect.objectContaining({playerId:playerA!.playerId,carIndex:0}),
        expect.objectContaining({playerId:playerB!.playerId,carIndex:1}),
      ]));
      expect(room.phase).toBe('car_select');
      b.send(JSON.stringify({type:'prompt',voicePrompt:'next',last:true}));await wait(1_600);expect(room.phase).toBe('map_select');
      a.send(JSON.stringify({type:'prompt',voicePrompt:'one',last:true}));await wait(60);expect(room.mapVotes().counts).toEqual({'Silver Lake':1});
      b.send(JSON.stringify({type:'prompt',voicePrompt:'one',last:true}));await wait(60);expect(room.mapVotes().counts).toEqual({'Silver Lake':1});
      b.send(JSON.stringify({type:'prompt',voicePrompt:'two',last:true}));await wait(60);expect(room.mapVotes().counts).toEqual({'Silver Lake':1,Drift:1});
      a.send(JSON.stringify({type:'prompt',voicePrompt:'start',last:true}));await wait(60);expect(room.phase).toBe('countdown');
      const countdownBefore=room.snapshot()!;
      a.send(JSON.stringify({type:'prompt',voicePrompt:'right',last:true}));await wait(40);
      expect(room.snapshot()!.cars.find(car=>car.id===playerA!.playerId)?.targetLane)
        .toBe((countdownBefore.cars.find(car=>car.id===playerA!.playerId)?.targetLane??0)+1);
      for(let i=0;i<100&&room.phase!=='racing';i++)game.stepRoomForTest(room,0.1);
      const before=room.snapshot()!;
      a.send(JSON.stringify({type:'prompt',voicePrompt:'left',last:true}));await wait(40);
      const afterA=room.snapshot()!;
      expect(afterA.cars.find(car=>car.id===playerA!.playerId)?.targetLane).toBe((before.cars.find(car=>car.id===playerA!.playerId)?.targetLane??0)-1);
      expect(afterA.cars.find(car=>car.id===playerB!.playerId)?.targetLane).toBe(before.cars.find(car=>car.id===playerB!.playerId)?.targetLane);
      b.send(JSON.stringify({type:'prompt',voicePrompt:'left',last:true}));await wait(40);
      const afterB=room.snapshot()!;
      expect(afterB.cars.find(car=>car.id===playerA!.playerId)?.targetLane).toBe(afterA.cars.find(car=>car.id===playerA!.playerId)?.targetLane);
      expect(afterB.cars.find(car=>car.id===playerB!.playerId)?.targetLane).toBe((afterA.cars.find(car=>car.id===playerB!.playerId)?.targetLane??0)-1);
    }finally{closeWs(a);closeWs(b);}
  });

  it('voice setup flows name → explicit car/map advances → race without asking for the name again', async () => {
    srv = new HttpServer({
      port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
      mapsPath: 'assets/maps/maps.json',
    });
    const port = await srv.start();

    const spec = new WebSocket(`ws://127.0.0.1:${port}/game`);
    const inbox: any[] = [];
    spec.on('message', d => inbox.push(JSON.parse(d.toString())));
    await new Promise<void>(r => spec.on('open', () => r()));
    spec.send(JSON.stringify({ type: 'spectate', roomCode: '7331' }));

    const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
    const spoken: string[] = [];
    const spokenMessages: Record<string, unknown>[] = [];
    voice.on('message', d => {
      const msg = JSON.parse(d.toString()) as Record<string, unknown>;
      if (msg.type === 'text') { spoken.push(String(msg.token)); spokenMessages.push(msg); acknowledgeText(voice, msg); }
    });
    await new Promise<void>(r => voice.on('open', () => r()));
    voice.send(JSON.stringify({
      type: 'setup', callSid: 'CA2', from: '+15551230001',
      customParameters: { roomCode: '7331' },
    }));
    try {
      await wait(50);

      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Ada', last: true }));
      await wait(900);
      expect(spoken.join(' ').toLowerCase()).toMatch(/controls on the screen|say left|nitro/);
      expect(spokenMessages.length).toBeGreaterThan(0);
      expect(spokenMessages.every(message => message.interruptible === true && message.preemptible === true)).toBe(true);
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'start', last: true }));
      await wait(1_600);
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'one', last: true }));
      await wait(50);
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'next', last: true }));
      await wait(1_600);
      spoken.length = 0;
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'one', last: true }));
      await wait(50);
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'start', last: true }));
      await wait(300);

      expect(spoken.join(' ').toLowerCase()).toContain("vote's in");
      expect(spoken.join(' ').toLowerCase()).not.toMatch(/what'?s your name|first up.*name/);
      expect(inbox.some(m => m.type === 'items')).toBe(true);
      expect(spoken.join(' ').toLowerCase()).not.toMatch(/what'?s your name|first up.*name/);
      expect(inbox.some(m => m.type === 'items')).toBe(true);
    } finally {
      closeWs(voice);
      closeWs(spec);
    }
  });

  it('runs the deterministic Racer setup flow in Brazilian Portuguese', async () => {
    srv = new HttpServer({
      port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false,
      mapsPath: 'assets/maps/maps.json',
    });
    const port = await srv.start();
    const roomCode = '7441';
    const spec = new WebSocket(`ws://127.0.0.1:${port}/game`);
    const inbox: any[] = [];
    spec.on('message', data => inbox.push(JSON.parse(data.toString())));
    await new Promise<void>(resolve => spec.on('open', resolve));
    spec.send(JSON.stringify({ type: 'spectate', roomCode, locale: 'pt-BR' }));

    const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
    const spoken: { token: string; lang?: string }[] = [];
    voice.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'text') { spoken.push(message); acknowledgeText(voice, message); }
    });
    await new Promise<void>(resolve => voice.on('open', resolve));
    voice.send(JSON.stringify({
      type: 'setup', callSid: 'CA-PT-RACER', from: '+5511999999999',
      customParameters: { roomCode, game: 'racer', locale: 'pt-BR', commandLocale: 'pt-BR' },
    }));

    try {
      await wait(50);
      voice.send(JSON.stringify({type:'prompt',voicePrompt:'Meu nome é Ana',last:true}));await wait(80);
      voice.send(JSON.stringify({type:'prompt',voicePrompt:'começar',last:true}));await wait(1_600);
      voice.send(JSON.stringify({type:'prompt',voicePrompt:'um',last:true}));await wait(80);
      voice.send(JSON.stringify({type:'prompt',voicePrompt:'próximo',last:true}));await wait(1_600);
      expect(spoken.map(message => message.token).join(' ')).toContain('Batmóvel');
      spoken.length = 0;
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'um', last: true }));
      await wait(300);
      expect(spoken.map(message => message.token).join(' ').toLowerCase()).toContain('seu voto');
      expect(spoken.map(message => message.token).join(' ')).toContain('Lago Prateado');
      expect(spoken.every(message => message.lang === 'pt-BR')).toBe(true);

      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'começar', last: true }));
      await wait(300);
      expect(inbox.some(message => message.type === 'items')).toBe(true);
    } finally {
      closeWs(voice);
      closeWs(spec);
    }
  });

  it('runs Portuguese Voice Monsters with localized names and deterministic name capture', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start();
    const roomCode = '8663';
    const display = new WebSocket(`ws://127.0.0.1:${port}/battle`);
    const states: any[] = [], events: any[] = [];
    display.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'battle_state') states.push(message);
      if (message.type === 'battle_events') events.push(...message.events);
    });
    await new Promise<void>(resolve => display.on('open', resolve));
    display.send(JSON.stringify({ type: 'spectate', roomCode, locale: 'pt-BR' }));

    const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
    const spoken: { token: string; lang?: string;interruptible?:boolean;preemptible?:boolean }[] = [];
    voice.on('message', data => { const message = JSON.parse(data.toString()) as Record<string, unknown>; if (message.type === 'text') { spoken.push({ token: String(message.token), lang: typeof message.lang === 'string' ? message.lang : undefined,interruptible:message.interruptible===true,preemptible:message.preemptible===true }); acknowledgeText(voice, message); } });
    await new Promise<void>(resolve => voice.on('open', resolve));
    voice.send(JSON.stringify({
      type: 'setup', callSid: 'CA-PT-MONSTERS', from: '+5511888888888',
      customParameters: { roomCode, game: 'monsters', locale: 'pt-BR', commandLocale: 'pt-BR' },
    }));

    try {
      await wait(80);
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Meu nome é Ana', last: true }));
      await wait(80);
      expect(states.at(-1)?.players.some((player: any) => player.name === 'Ana')).toBe(true);
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'começar', last: true }));
      await wait(80);
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Rato-Faísca', last: true }));
      await wait(80);
      expect(states.at(-1)?.players.some((player: any) => player.monsterId === 'sparkmouse')).toBe(true);
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'batalhar', last: true }));
      await wait(100);
      expect(states.at(-1)?.phase).toBe('battle');
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'lutar', last: true }));
      await wait(80);
      expect(states.at(-1)?.activeMenu).toBe('fight');
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'dois', last: true }));
      await wait(250);
      expect(events.some(event => event.kind === 'move_used' && event.moveId === 'sparkmouse.zap')).toBe(true);
      expect(spoken.some(message => message.token.includes('Monstros por Voz'))).toBe(true);
      expect(spoken.every(message => message.lang === 'pt-BR')).toBe(true);
      expect(spoken.every(message=>message.interruptible&&message.preemptible)).toBe(true);
    } finally {
      closeWs(voice);
      closeWs(display);
    }
  });

  it('Voice Monsters resumes the same caller mid-battle without asking for name or monster again', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start();
    const roomCode = '6442';
    const callSid = 'CA-MONSTERS-RECONNECT';

    const spec = new WebSocket(`ws://127.0.0.1:${port}/battle`);
    const states: any[] = [];
    spec.on('message', d => {
      const msg = JSON.parse(d.toString());
      if (msg.type === 'battle_state') states.push(msg);
    });
    await new Promise<void>(r => spec.on('open', () => r()));
    spec.send(JSON.stringify({ type: 'spectate', roomCode }));

    const connectVoice = async (spoken: string[]) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/voice`);
      ws.on('message', d => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'text') { spoken.push(String(msg.token)); acknowledgeText(ws, msg); }
      });
      await new Promise<void>(r => ws.on('open', () => r()));
      ws.send(JSON.stringify({
        type: 'setup', callSid, from: '+15551234567',
        customParameters: { roomCode, game: 'monsters' },
      }));
      return ws;
    };

    const firstSpeech: string[] = [];
    const first = await connectVoice(firstSpeech);
    try {
      await wait(40);
      for (const text of ['Ada', 'start', 'Sparkmouse', 'battle']) {
        first.send(JSON.stringify({ type: 'prompt', voicePrompt: text, last: true }));
        await wait(40);
      }
      const before = states.at(-1);
      expect(before?.phase).toBe('battle');
      expect(before?.players?.[0]?.name).toBe('Ada');
      expect(before?.players?.[0]?.monsterId).toBe('sparkmouse');

      first.close();
      await new Promise<void>(r => first.once('close', () => r()));
      await wait(40);

      const resumedSpeech: string[] = [];
      const resumed = await connectVoice(resumedSpeech);
      try {
        await wait(900);
        const after = states.at(-1);
        expect(after?.phase).toBe('battle');
        expect(after?.players?.[0]?.name).toBe('Ada');
        expect(after?.players?.[0]?.monsterId).toBe('sparkmouse');
        expect(after?.players).toHaveLength(1);
        expect(resumedSpeech.join(' ')).toMatch(/back in the battle/i);
        expect(resumedSpeech.join(' ')).not.toMatch(/what'?s your name|pick a monster/i);
      } finally {
        closeWs(resumed);
      }
    } finally {
      closeWs(first);
      closeWs(spec);
    }
  });

  it('runs Portuguese Voice Fighter setup with localized fighters and arenas', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start();
    const roomCode = '8774';
    const display = new WebSocket(`ws://127.0.0.1:${port}/fighter`);
    const states: any[] = [];
    display.on('message', data => { const message = JSON.parse(data.toString()); if (message.type === 'fighter_state') states.push(message); });
    await new Promise<void>(resolve => display.on('open', resolve));
    display.send(JSON.stringify({ type: 'spectate', roomCode, locale: 'pt-BR' }));

    const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
    const spoken: { token: string; lang?: string }[] = [];
    voice.on('message', data => { const message = JSON.parse(data.toString()) as Record<string, unknown>; if (message.type === 'text') { spoken.push({ token: String(message.token), lang: typeof message.lang === 'string' ? message.lang : undefined }); acknowledgeText(voice, message); } });
    await new Promise<void>(resolve => voice.on('open', resolve));
    voice.send(JSON.stringify({
      type: 'setup', callSid: 'CA-PT-FIGHTER', from: '+5511777777777',
      customParameters: { roomCode, game: 'fighter', locale: 'pt-BR', commandLocale: 'pt-BR' },
    }));

    try {
      await wait(60);
      for (const command of ['Ana', 'começar', 'Nix']) {
        voice.send(JSON.stringify({ type: 'prompt', voicePrompt: command, last: true }));
        await wait(command === 'Nix' ? 500 : 90);
      }
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'próximo', last: true })); await wait(90);
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Circuito do Vazio', last: true })); await wait(500);
      voice.send(JSON.stringify({ type: 'prompt', voicePrompt: 'lutar', last: true })); await wait(90);
      const latest = states.at(-1);
      expect(latest?.players.some((player: any) => player.name === 'Ana' && player.fighterId === 'nyx')).toBe(true);
      expect(latest?.selectedMap).toBe('void');
      expect(latest?.phase).toBe('loading');
      const output = spoken.map(message => message.token).join(' ');
      expect(output).toContain('Luta por Voz');
      expect(output).toContain('Nix');
      expect(output).toContain('Circuito do Vazio');
      expect(output).not.toContain('Voice Fighter');
      expect(spoken.every(message => message.lang === 'pt-BR')).toBe(true);
    } finally {
      closeWs(voice);
      closeWs(display);
    }
  });

  it('Voice Fighter resumes the same CallSid without duplicating the player', async () => {
    srv = new HttpServer({ port: 0, publicBaseUrl: 'http://localhost', validateSignatures: false });
    const port = await srv.start(), roomCode = 'VF42', callSid = 'CA-FIGHTER-RECONNECT';
    const display = new WebSocket(`ws://127.0.0.1:${port}/fighter`), states: any[] = [];
    display.on('message', data => { const message = JSON.parse(data.toString()); if (message.type === 'fighter_state') states.push(message); });
    await new Promise<void>(resolve => display.on('open', resolve)); display.send(JSON.stringify({ type: 'spectate', roomCode }));
    const connect = async (spoken: string[]) => {
      const voice = new WebSocket(`ws://127.0.0.1:${port}/voice`);
      voice.on('message', data => { const message = JSON.parse(data.toString()) as Record<string, unknown>; if (message.type === 'text') { spoken.push(String(message.token)); acknowledgeText(voice, message); } });
      await new Promise<void>(resolve => voice.on('open', resolve));
      voice.send(JSON.stringify({ type: 'setup', callSid, from: '+15550001111', customParameters: { roomCode: ` ${roomCode.toLowerCase()} `, game: 'fighter' } }));
      return voice;
    };
    const firstSpeech: string[] = [], first = await connect(firstSpeech);
    try {
      await wait(50); first.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Ada', last: true })); await wait(40);
      first.send(JSON.stringify({ type: 'prompt', voicePrompt: 'start', last: true })); await wait(40);
      first.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Iron Oni', last: false })); await wait(80);
      expect(states.at(-1)?.players?.[0]).toMatchObject({ name: 'Ada', fighterId: null });
      first.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Iron Oni', last: true })); await wait(40);
      expect(states.at(-1)?.players?.[0]).toMatchObject({ name: 'Ada', fighterId: 'iron-oni' });
      first.send(JSON.stringify({ type: 'prompt', voicePrompt: 'next', last: true })); await wait(40);
      expect(states.at(-1)?.phase).toBe('map_select');
      first.send(JSON.stringify({ type: 'prompt', voicePrompt: 'first', last: true })); await wait(40);
      expect(states.at(-1)?.selectedMap).toBeTruthy();
      first.send(JSON.stringify({ type: 'prompt', voicePrompt: 'fight', last: true })); await wait(80);
      expect(states.at(-1)?.phase).toBe('loading');
      display.send(JSON.stringify({ type: 'ready', loadingGeneration: states.at(-1)?.loadingGeneration })); await wait(80);
      expect(states.at(-1)?.phase).toBe('intro');
      first.close(); await new Promise<void>(resolve => first.once('close', resolve)); await wait(40);
      const resumedSpeech: string[] = [], resumed = await connect(resumedSpeech);
      try {
        await wait(900);
        expect(states.at(-1)?.players?.filter((player: any) => !player.isAi)).toHaveLength(1);
        expect(states.at(-1)?.players?.find((player: any) => !player.isAi)).toMatchObject({ name: 'Ada', fighterId: 'iron-oni' });
        expect(states.at(-1)?.players?.find((player: any) => player.isAi)).toBeTruthy();
        expect(resumedSpeech.join(' ')).toMatch(/back/i);
        expect(resumedSpeech.join(' ')).toMatch(/player one, Ada, as Iron Oni/i);
        expect(resumedSpeech.join(' ')).not.toMatch(/what is your name/i);
      } finally { closeWs(resumed); }
    } finally { closeWs(first); closeWs(display); }
  });
});
