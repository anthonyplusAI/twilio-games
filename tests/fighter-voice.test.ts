import { describe, expect, it, vi } from 'vitest';
import { FighterVoiceSession, matchVoiceChoice, type FighterVoiceSnapshot } from '../server/fighter-voice';
import { FIGHTER_LOADING_TIMEOUT_SECONDS, FIGHTER_RESULTS_PRESENTATION_TIMEOUT_MS, FIGHTER_VICTORY_SECONDS, FighterRoom } from '../server/fighter-room';
import { FIGHTER_MAPS, FIGHTER_ROSTER } from '../shared/fighter-roster';
import { FIGHTER_INTRO_SECONDS } from '../shared/fighter-protocol';
import type { FighterCommand, FighterEvent } from '../shared/fighter-world';
import type { VoiceInterpretRequest, VoiceInterpretResult } from '../server/voice-interpreter';

describe('fighter voice session', () => {
  it('asks the first caller to confirm again when the other caller changes fighter after a ready vote', () => {
    const game = voiceGame();
    game.room.configureStandaloneSeats(2);
    const ada = game.connect('CA-RECONFIRM-FIGHTER-ADA', 'VOICE', undefined, 'Ada', { index: 0, count: 2 });
    const bo = game.connect('CA-RECONFIRM-FIGHTER-BO', 'VOICE', undefined, 'Bo', { index: 1, count: 2 });
    ada.prompt('next'); bo.prompt('next');
    ada.prompt('Nyx'); bo.prompt('Wraith');
    ada.prompt('next');
    expect(game.room.phase).toBe('fighter_select');
    expect(game.room.state().advanceReadyPlayerIds).toContain(ada.playerId);

    const before = ada.spoken.length;
    bo.prompt('Remy Riot');
    expect(game.room.state().advanceReadyPlayerIds).toEqual([]);
    expect(ada.spoken.slice(before).join(' ')).toMatch(/say next when you are ready/i);
  });

  it('asks the first caller to confirm again when the display changes the other arena vote', () => {
    const game = voiceGame();
    game.room.configureStandaloneSeats(2);
    const ada = game.connect('CA-RECONFIRM-MAP-ADA', 'VOICE', undefined, 'Ada', { index: 0, count: 2 });
    const bo = game.connect('CA-RECONFIRM-MAP-BO', 'VOICE', undefined, 'Bo', { index: 1, count: 2 });
    ada.prompt('next'); bo.prompt('next');
    ada.prompt('Nyx'); bo.prompt('Wraith');
    ada.prompt('next'); bo.prompt('next');
    ada.prompt('first'); bo.prompt('second');
    ada.prompt('start');
    expect(game.room.phase).toBe('map_select');
    expect(game.room.state().advanceReadyPlayerIds).toContain(ada.playerId);

    const before = ada.spoken.length;
    expect(game.room.selectMap(bo.playerId, 'foundry')).toBe(true);
    game.stateChanged();
    expect(game.room.state().advanceReadyPlayerIds).toEqual([]);
    expect(ada.spoken.slice(before).join(' ')).toMatch(/say start when ready/i);
  });

  it('offers the back choice instead of the old next choice when another caller votes back', () => {
    const game = voiceGame();
    game.room.configureStandaloneSeats(2);
    const ada = game.connect('CA-BACK-AFTER-NEXT-ADA', 'VOICE', undefined, 'Ada', { index: 0, count: 2 });
    const bo = game.connect('CA-BACK-AFTER-NEXT-BO', 'VOICE', undefined, 'Bo', { index: 1, count: 2 });
    ada.prompt('next'); bo.prompt('next');
    ada.prompt('Nyx'); bo.prompt('Wraith');
    ada.prompt('next');

    const before = ada.spoken.length;
    bo.prompt('go back');
    expect(game.room.phase).toBe('fighter_select');
    expect(ada.spoken.slice(before).join(' ')).toMatch(/wants to go back\. Say back to agree/i);
    expect(ada.spoken.slice(before).join(' ')).not.toMatch(/say next when you are ready/i);
  });

  it('waits for a caller’s AI answer and its phone playback before honoring both menu votes', async () => {
    let answerInterpretation: ((result: VoiceInterpretResult) => void) | undefined;
    let finishAnswerAudio: ((played: boolean) => void) | undefined;
    const game = voiceGame(
      () => new Promise(resolve => { answerInterpretation = resolve; }),
      text => text.startsWith('The fighters on screen')
        ? new Promise(resolve => { finishAnswerAudio = resolve; }) : Promise.resolve(true),
      true,
    );
    game.room.configureStandaloneSeats(2);
    const ada = game.connect('CA-MENU-AI-ADA', 'VOICE', undefined, 'Ada', { index: 0, count: 2 });
    const bo = game.connect('CA-MENU-AI-BO', 'VOICE', undefined, 'Bo', { index: 1, count: 2 });
    ada.prompt('next'); bo.prompt('next');
    await vi.waitFor(() => expect(game.room.phase).toBe('fighter_select'));
    ada.prompt('Nyx'); bo.prompt('Wraith');
    ada.prompt('next');
    ada.prompt('What fighters can I choose?');
    expect(answerInterpretation).toBeTypeOf('function');
    bo.prompt('next');
    await Promise.resolve();
    expect(game.room.phase).toBe('fighter_select');

    answerInterpretation!({ kind: 'answer', factId: 'fighters' });
    await vi.waitFor(() => expect(finishAnswerAudio).toBeTypeOf('function'));
    expect(game.room.phase).toBe('fighter_select');
    finishAnswerAudio!(true);
    await vi.waitFor(() => expect(game.room.phase).toBe('map_select'));
  });

  it('holds both shared votes while a caller speaks an interim transcript and hears the reply', async () => {
    let holdNextCue = false;
    let finishPriorCue: ((played: boolean) => void) | undefined;
    let holdReply = false;
    let finishReply: ((played: boolean) => void) | undefined;
    const game = voiceGame(undefined, () => {
      if (holdNextCue) {
        holdNextCue = false;
        return new Promise<boolean>(resolve => { finishPriorCue = resolve; });
      }
      if (holdReply) return new Promise<boolean>(resolve => { finishReply = resolve; });
      return Promise.resolve(true);
    }, true);
    game.room.configureStandaloneSeats(2);
    const ada = game.connect('CA-INTERIM-ADA', 'VOICE', undefined, 'Ada', { index: 0, count: 2 });
    const bo = game.connect('CA-INTERIM-BO', 'VOICE', undefined, 'Bo', { index: 1, count: 2 });
    await vi.waitFor(() => expect(game.room.state().phonePendingPlayerIds).toEqual([]));

    holdNextCue = true;
    ada.prompt('next');
    bo.prompt('next');
    expect(finishPriorCue).toBeTypeOf('function');
    ada.prompt('I need', false);
    expect(game.room.state().phoneTurnPendingPlayerIds).toContain(ada.playerId);
    finishPriorCue!(true);
    await Promise.resolve();
    expect(game.room.phase).toBe('lobby');

    holdReply = true;
    ada.prompt('help');
    expect(finishReply).toBeTypeOf('function');
    expect(game.room.phase).toBe('lobby');
    holdReply = false;
    finishReply!(true);
    await vi.waitFor(() => expect(game.room.phase).toBe('fighter_select'));
  });

  it.each([false, 'failed', 'interrupted', 'rejected'] as const)(
    'keeps shared votes after a %s phone cue until the caller requests its replay', async outcome => {
      let failNextCue = false;
      let holdRetry = false;
      let finishRetry: ((played: boolean) => void) | undefined;
      const game = voiceGame(undefined, () => {
        if (failNextCue) {
          failNextCue = false;
          return outcome === 'rejected' ? Promise.reject(new Error('Relay audio rejected'))
            : Promise.resolve(outcome);
        }
        if (holdRetry) return new Promise<boolean>(resolve => { finishRetry = resolve; });
        return Promise.resolve(true);
      }, true);
      game.room.configureStandaloneSeats(2);
      const ada = game.connect('CA-FAILED-ADA', 'VOICE', undefined, 'Ada', { index: 0, count: 2 });
      const bo = game.connect('CA-FAILED-BO', 'VOICE', undefined, 'Bo', { index: 1, count: 2 });
      await vi.waitFor(() => expect(game.room.state().phonePendingPlayerIds).toEqual([]));

      failNextCue = true;
      ada.prompt('next');
      bo.prompt('next');
      await vi.waitFor(() => expect(game.room.state().phoneRetryPlayerIds).toHaveLength(1));
      expect(game.room.phase).toBe('lobby');

      holdRetry = true;
      const callerToRetry = game.room.state().phoneRetryPlayerIds[0] === ada.playerId ? ada : bo;
      callerToRetry.prompt('repeat');
      expect(finishRetry).toBeTypeOf('function');
      expect(game.room.phase).toBe('lobby');
      holdRetry = false;
      finishRetry!(true);
      await vi.waitFor(() => expect(game.room.phase).toBe('fighter_select'));
    },
  );

  it('does not request a phone retry when a shared-screen choice replaces a queued menu cue', async () => {
    let holdNext = false;
    let finishOld: ((outcome: 'interrupted') => void) | undefined;
    const game = voiceGame(undefined, () => {
      if (holdNext) {
        holdNext = false;
        return new Promise<'interrupted'>(resolve => { finishOld = resolve; });
      }
      return Promise.resolve(true);
    }, true);
    game.room.configureStandaloneSeats(2);
    const ada = game.connect('CA-REPLACED-ADA', 'VOICE', undefined, 'Ada', { index: 0, count: 2 });
    const bo = game.connect('CA-REPLACED-BO', 'VOICE', undefined, 'Bo', { index: 1, count: 2 });
    await vi.waitFor(() => expect(game.room.state().phonePendingPlayerIds).toEqual([]));
    game.room.advance(ada.playerId);
    game.room.advance(bo.playerId);
    game.stateChanged();
    expect(game.room.phase).toBe('fighter_select');
    await vi.waitFor(() => expect(game.room.state().phonePendingPlayerIds).toEqual([]));

    holdNext = true;
    ada.prompt('help');
    expect(finishOld).toBeTypeOf('function');
    expect(game.room.selectFighter(ada.playerId, 'nyx')).toBe(true);
    game.stateChanged();
    await Promise.resolve();
    finishOld!('interrupted');
    await vi.waitFor(() => expect(game.room.state().phonePendingPlayerIds).toEqual([]));
    expect(game.room.state().phoneRetryPlayerIds).toEqual([]);

    expect(game.room.selectFighter(bo.playerId, 'wraith')).toBe(true);
    game.stateChanged();
    await vi.waitFor(() => expect(game.room.state().phonePendingPlayerIds).toEqual([]));
    game.room.advance(ada.playerId);
    game.room.advance(bo.playerId);
    expect(game.room.phase).toBe('map_select');
  });

  it('keeps the Twilio introduction on its screen but expires it when touch advances the menu', () => {
    const game = voiceGame();
    const caller = game.connect('CA-GREETING-BARGE', 'VOICE', undefined, 'Ada');
    const intro = caller.guardedSpeech.find(line => /Conversation Relay/i.test(line.text));
    expect(intro?.isCurrent?.()).toBe(true);
    caller.interrupt();
    expect(intro?.isCurrent?.()).toBe(false);

    const next = voiceGame();
    const menuCaller = next.connect('CA-GREETING-TAP', 'VOICE', undefined, 'Ada');
    const menuIntro = menuCaller.guardedSpeech.find(line => /Conversation Relay/i.test(line.text));
    expect(menuIntro?.isCurrent?.()).toBe(true);
    next.stateChanged();
    expect(menuIntro?.isCurrent?.()).toBe(true);
    expect(next.room.advance(menuCaller.playerId)).toBe(true);
    next.stateChanged();
    expect(menuIntro?.isCurrent?.()).toBe(false);
    expect(next.room.selectFighter(menuCaller.playerId, 'nyx')).toBe(true);
    expect(next.room.advance(menuCaller.playerId)).toBe(true);
    expect(next.room.selectMap(menuCaller.playerId, 'void')).toBe(true);
    expect(menuIntro?.isCurrent?.()).toBe(false);
    expect(next.room.advance(menuCaller.playerId)).toBe(true);
    expect(next.room.phase).toBe('loading');
    expect(menuIntro?.isCurrent?.()).toBe(false);
    expect(next.room.back(menuCaller.playerId)).toBe(true);
    next.stateChanged();
    expect(menuIntro?.isCurrent?.()).toBe(false);
  });

  it('revokes queued name follow-ups once the player reaches fighter selection', () => {
    const game = voiceGame();
    const caller = game.connect('CA-NAME-QUEUE');
    caller.prompt('Ada');
    const controls = caller.guardedSpeech.find(line => /controls on the display/i.test(line.text));
    expect(controls?.isCurrent?.()).toBe(true);
    caller.prompt('next');
    expect(game.room.phase).toBe('fighter_select');
    expect(controls?.isCurrent?.()).toBe(false);
  });

  it('speaks the caller’s fighter and arena selections made by touch', () => {
    const game = voiceGame();
    const caller = game.connect('CA-TOUCH-CHOICES', 'VOICE', undefined, 'Ada');
    caller.prompt('next');
    const beforeFighter = caller.spoken.length;
    expect(game.room.selectFighter(caller.playerId, 'nyx')).toBe(true);
    game.stateChanged();
    expect(caller.spoken.slice(beforeFighter).join(' ')).toMatch(/Nyx/i);

    caller.prompt('next');
    const beforeArena = caller.spoken.length;
    expect(game.room.selectMap(caller.playerId, 'void')).toBe(true);
    game.stateChanged();
    expect(caller.spoken.slice(beforeArena).join(' ')).toMatch(/Void Circuit/i);
  });

  it.each([
    {locale:undefined,spoken:'Nyx or Wraith',expected:/which fighter/i},
    {locale:'pt-BR',spoken:'Nyx ou Wraith',expected:/qual lutador/i},
  ])('asks a short localized question about an ambiguous fighter choice: $locale',async ({locale,spoken,expected})=>{
    const game=voiceGame(async()=>({kind:'clarify',reason:'ambiguous'}));
    const caller=game.connect(`CA-CLARIFY-${locale??'en'}`,'VOICE',locale,'Ada');
    caller.prompt(locale?'próximo':'next');caller.spoken.length=0;
    caller.prompt(spoken);await Promise.resolve();
    expect(caller.spoken.join(' ')).toMatch(expected);
    expect(caller.spoken.join(' ')).not.toMatch(/reduce your rival|reduza os pontos/i);
  });

  it('does not repeat a full fighter menu for unrelated speech',async()=>{
    const game=voiceGame(async()=>({kind:'none'}));
    const caller=game.connect('CA-FIGHTER-NONE','VOICE',undefined,'Ada');
    caller.prompt('next');caller.spoken.length=0;
    caller.prompt('I had lunch');await Promise.resolve();
    expect(caller.spoken).toHaveLength(1);
    expect(caller.spoken[0]).toMatch(/tell me what you want|what would you like/i);
    caller.prompt('I had dinner');await Promise.resolve();
    expect(caller.spoken).toHaveLength(2);
    expect(caller.spoken.join(' ')).not.toMatch(/name or number|reduce your rival/i);
  });

  it('keeps a station result deliverable while the completed room retires', () => {
    const game = voiceGame();
    const caller = game.connect('CA-FINAL-VOICE', 'VOICE', undefined, 'Ada');
    caller.prompt('next'); caller.prompt('Nyx'); caller.prompt('next'); caller.prompt('second'); caller.prompt('start');
    game.room.ready(game.room.state().loadingGeneration); game.stateChanged(); advanceIntro(game); game.tick(6);
    const world = game.room.state().world!;
    world.status = 'finished'; world.winner = 'p1'; game.tick(0.1); game.tick(FIGHTER_VICTORY_SECONDS);
    expect(game.room.acknowledgePresentation('results', game.room.state().loadingGeneration)).toBe(true);
    game.stateChanged();
    const result = caller.guardedSpeech.find(line => /results.*display.*thanks for playing/i.test(line.text));
    expect(result).toBeDefined();
    caller.session.handleReplaced();
    expect(result?.isCurrent?.() ?? true).toBe(true);
  });

  it('uses an authoritative station name without asking for it again', () => {
    const game=voiceGame();const ada=game.connect('CA-known','VOICE',undefined,'Ada');
    expect(game.room.state().players[0]?.name).toBe('Ada');
    expect(ada.spoken.slice(0, 5)).toEqual([
      'Welcome to Voice Fighter, Ada.',
      'This game is powered by Twilio Conversation Relay, so your voice controls the fight in real time over this call.',
      'Before you start, check the controls on the display.',
      'Reduce your rival to zero health. During the fight, say forward, back, jump, punch, kick, or block.',
      'When everyone is ready, say next to choose your fighter.',
    ]);
    const arrival=ada.spoken.join(' ').toLowerCase();
    expect(arrival).toContain('ada');
    expect(arrival).toMatch(/forward|back|punch|kick/);
    expect(arrival).toContain('say next to choose your fighter');
    expect(arrival).not.toContain('what is your name');
  });

  it('captures a missing station profile name before fighter selection', () => {
    const game=voiceGame();
    const caller=game.connect('CA-station-no-name','VOICE',undefined,undefined,{index:0,count:1});
    expect(game.room.phase).toBe('lobby');
    const beforeName=caller.spoken.length;
    caller.prompt('Ada');
    expect(game.room.phase).toBe('lobby');
    expect(game.room.state().players[0]?.name).toBe('Ada');
    expect(caller.spoken.slice(beforeName).join(' ')).not.toMatch(/what is your name/i);
    expect(caller.spoken.at(-1)).toMatch(/say next/i);
    caller.prompt('next');
    expect(game.room.phase).toBe('fighter_select');
  });

  it('stays on fighter selection when an unnamed caller joins late', () => {
    const game = voiceGame();
    const first = game.connect('CA-FIRST-FIGHTER', 'VOICE', undefined, 'Ada');
    first.prompt('next');
    expect(game.room.phase).toBe('fighter_select');

    const late = game.connect('CA-LATE-FIGHTER');
    expect(late.spoken.join(' ')).toMatch(/choose your fighter/i);
    expect(late.spoken.join(' ')).not.toMatch(/what is your name|tell me your name/i);
    late.prompt('Nyx');
    expect(game.room.state().players.find(player => player.playerId === late.playerId)?.fighterId).toBe('nyx');
    expect(game.room.state().players.find(player => player.playerId === late.playerId)?.name).not.toBe('Nyx');
    expect(late.spoken.at(-1)).not.toMatch(/tell me your name/i);
  });

  it('uses the live confirmed name when a caller advances while an old name prompt is pending', () => {
    const game = voiceGame();
    const caller = game.connect('CA-confirmed-later');
    game.room.setName(caller.playerId, 'Ada');
    game.room.advance(caller.playerId);
    game.stateChanged();

    caller.prompt('Nyx');

    expect(game.room.state().players.find(player => player.playerId === caller.playerId)).toMatchObject({
      name: 'Ada', fighterId: 'nyx',
    });
    expect(caller.spoken.at(-1)).not.toMatch(/what is your name/i);
  });

  it('keeps repeated fighter choices on screen until an explicit next', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const game=voiceGame();const caller=game.connect('CA-duplicate-choice');
      caller.prompt('Ada');
      caller.prompt('next');
      vi.advanceTimersByTime(1_000);
      caller.session.setStationManaged(false);
      caller.prompt('second');
      expect(game.room.phase).toBe('fighter_select');
      vi.advanceTimersByTime(3_000);
      caller.session.setStationManaged(false);
      caller.prompt('second');
      expect(game.room.phase).toBe('fighter_select');
      expect(game.room.state().mapVotesByPlayerId[caller.playerId]).toBeUndefined();
      caller.prompt('next');
      expect(game.room.phase).toBe('map_select');
    } finally { vi.useRealTimers(); }
  });

  it('advances ready Fighter menus with conversational affirmatives but never questions or premature assent', () => {
    const game = voiceGame();
    const caller = game.connect('CA-MENU-AFFIRMATIVE', 'VOICE', undefined, 'Ada');
    caller.prompt('sure');
    expect(game.room.phase).toBe('fighter_select');
    caller.prompt('yes');
    expect(game.room.phase).toBe('fighter_select');
    caller.prompt('Nyx');
    caller.prompt('Sounds good');
    expect(game.room.phase).toBe('map_select');
    caller.prompt('Should we start?');
    expect(game.room.phase).toBe('map_select');
    caller.prompt('second');
    caller.prompt('not yet, please');
    expect(game.room.phase).toBe('map_select');
    caller.prompt("Let's go");
    expect(game.room.phase).toBe('loading');
  });

  it.each([
    {locale:undefined,request:'choose arena'},
    {locale:undefined,request:"Let's pick a stage now"},
    {locale:undefined,request:'Could you open the arena selection screen?'},
    {locale:'pt-BR',request:'vamos escolher a arena'},
    {locale:'pt-BR',request:'podemos abrir a seleção de arenas?'}
  ])('opens arena selection from a spoken navigation request: $request', ({locale,request}) => {
    const game=voiceGame();
    const caller=game.connect(`CA-ARENA-NAV-${request}`,'VOICE',locale,'Ada');
    caller.prompt(locale?'próximo':'next');
    caller.prompt('Nyx');
    expect(game.room.phase).toBe('fighter_select');
    caller.prompt(request);
    expect(game.room.phase).toBe('map_select');
  });

  it('keeps arena questions and premature navigation in fighter selection', () => {
    const game=voiceGame();
    const caller=game.connect('CA-ARENA-NAV-GUARD','VOICE',undefined,'Ada');
    caller.prompt('next');
    caller.prompt('choose arena');
    expect(game.room.phase).toBe('fighter_select');
    caller.prompt('Nyx');
    caller.prompt('Which arena should I choose?');
    expect(game.room.phase).toBe('fighter_select');
    caller.prompt("don't choose an arena yet");
    expect(game.room.phase).toBe('fighter_select');
  });

  it('uses Portuguese assent only after the current Fighter selection is complete', () => {
    const game = voiceGame();
    const caller = game.connect('CA-MENU-PT', 'VOICE', 'pt-BR', 'Ana');
    caller.prompt('claro');
    expect(game.room.phase).toBe('fighter_select');
    caller.prompt('sim');
    expect(game.room.phase).toBe('fighter_select');
    caller.prompt('Nyx');
    caller.prompt('tudo bem');
    expect(game.room.phase).toBe('map_select');
    caller.prompt('segundo');
    caller.prompt('vamos nessa');
    expect(game.room.phase).toBe('loading');
  });

  it('waits for next after every caller chooses a fighter', () => {
    const game=voiceGame();const ada=game.connect('CA-boundary-a'),bob=game.connect('CA-boundary-b');
    ada.prompt('Ada');bob.prompt('Bob');
    ada.prompt('next');
    expect(game.room.phase).toBe('lobby');
    bob.prompt('next');
    ada.prompt('second');
    bob.prompt('first');
    expect(game.room.phase).toBe('fighter_select');
    ada.prompt('next');
    expect(game.room.phase).toBe('fighter_select');
    bob.prompt('next');
    expect(game.room.phase).toBe('map_select');
    ada.prompt('second');
    expect(game.room.state().mapVotesByPlayerId[ada.playerId]).toBe('void');
  });

  it('drives the complete solo journey through intro, combat, victory, and rematch', () => {
    const game = voiceGame();
    const ada = game.connect('CA1', ' voice ');
    expect(ada.spoken).toEqual([
      'Welcome to Voice Fighter!',
      'This game is powered by Twilio Conversation Relay, so your voice controls the fight in real time over this call.',
      'First, what is your name?',
    ]);

    ada.prompt('Ada');
    expect(ada.spoken.slice(-4)).toEqual([
      'Welcome to Voice Fighter, Ada.',
      'Before you start, check the controls on the display.',
      'Reduce your rival to zero health. During the fight, say forward, back, jump, punch, kick, or block.',
      'When everyone is ready, say next to choose your fighter.',
    ]);
    ada.prompt('star');
    expect(ada.spoken.at(-1)).toContain('Choose your fighter. Say the name or number shown on screen.');
    ada.prompt('Nicks', false);
    expect(game.room.state().players.find(player => player.playerId === ada.playerId)?.fighterId).toBeNull();
    const afterInterimSelection = ada.spoken.length;
    ada.prompt('Nicks');
    expect(game.room.state().players.find(player => player.playerId === ada.playerId)?.fighterId).toBe('nyx');
    expect(game.room.phase).toBe('fighter_select');
    expect(ada.spoken.at(-1)).toMatch(/want to choose an arena/i);
    expect(ada.spoken.length).toBeGreaterThan(afterInterimSelection);
    ada.prompt('next');
    expect(ada.spoken.at(-1)).toBe('Choose your arena. Say the name or number shown on screen.');
    ada.prompt('second');
    expect(game.room.phase).toBe('map_select');
    expect(ada.spoken.at(-1)).toMatch(/Say start to begin the fight/i);
    ada.prompt('flight');
    expect(game.room.phase).toBe('loading');
    expect(ada.spoken.at(-1)).toMatch(/Get ready/i);

    expect(game.room.ready(game.room.state().loadingGeneration)).toBe(true);
    game.stateChanged();
    expect(game.room.phase).toBe('intro');
    advanceIntro(game);
    game.tick(3.1);
    game.tick(1);
    game.tick(1);
    game.tick(1);
    expect(game.room.phase).toBe('fight');
    expect(ada.spoken.at(-1)).toBe('Fight!');

    const beforeUnknown = ada.spoken.length;
    ada.prompt('what was that');
    expect(ada.spoken).toHaveLength(beforeUnknown+1);
    expect(ada.spoken.at(-1)).toMatch(/forward.*back.*jump.*punch.*kick.*block/i);
    ada.prompt('back', false); ada.prompt('back', false); ada.prompt('back');
    expect(game.commands.map(row => row.command)).toEqual(['back']);
    game.tick(0.7);

    const world = game.room.state().world!;
    ada.session.setStationManaged(true);
    world.p1.x = 0; world.p2.x = 1; world.p2.health = 10;
    ada.prompt('punch', false);
    ada.prompt('kick');
    expect(game.commands.map(row => row.command)).toEqual(['back', 'kick']);
    game.tick(0.6);
    expect(game.room.phase).toBe('victory');
    ada.prompt('rematch');
    expect(game.room.phase).toBe('victory');
    game.tick(FIGHTER_VICTORY_SECONDS);
    expect(game.room.phase).toBe('results');
    expect(ada.spoken.join(' ')).not.toMatch(/results.*display.*thanks for playing/i);
    expect(game.room.acknowledgePresentation('results',game.room.state().loadingGeneration)).toBe(true);
    game.stateChanged();

    expect(ada.spoken.join(' ')).toContain('Reduce your rival to zero health');
    expect(ada.spoken.join(' ')).not.toContain('1, Nyx');
    expect(ada.spoken).toContain('Player one, Ada, as Nyx.');
    expect(ada.spoken).toContain('Versus.');
    expect(ada.spoken.some(line => line.startsWith('Player two, Rival, as '))).toBe(true);
    expect(ada.spoken).toContain('Fighters ready.');
    expect(ada.spoken).toContain('3');
    expect(ada.spoken).toContain('2');
    expect(ada.spoken).toContain('1');
    expect(ada.spoken.some(line => line.startsWith('Fight!'))).toBe(true);
    expect(ada.spoken.filter(line => line === 'You are victorious!')).toHaveLength(1);
    expect(ada.spoken.join(' ')).toMatch(/results.*display.*thanks for playing.*check your messages/i);

    ada.session.setStationManaged(false);
    ada.prompt('rematch');
    expect(game.room.phase).toBe('fighter_select');
    expect(game.room.state().players.find(player => player.playerId === ada.playerId)?.fighterId).toBeNull();
  });

  it('tells a solo caller when the AI wins', () => {
    const game=voiceGame();const ada=game.connect('CA-LOSS','VOICE',undefined,'Ada');
    ada.prompt('next');ada.prompt('Nyx');ada.prompt('next');ada.prompt('second');ada.prompt('start');
    game.room.ready(game.room.state().loadingGeneration);game.stateChanged();advanceIntro(game);game.tick(6);
    ada.spoken.length=0;
    const world=game.room.state().world!;world.status='finished';world.winner='p2';game.tick(0.1);
    expect(game.room.phase).toBe('victory');
    expect(ada.spoken).toEqual(['You lost. Rival is victorious.']);
  });

  it('keeps the winner cue valid through victory and replaces an unheard cue with winner before rematch', () => {
    const game = voiceGame(); const ada = game.connect('CA-WINNER-CUE');
    ada.prompt('Ada');
    ada.prompt('next'); ada.prompt('Nyx'); ada.prompt('next'); ada.prompt('second'); ada.prompt('start');
    game.room.ready(game.room.state().loadingGeneration); game.stateChanged(); advanceIntro(game); game.tick(6);
    const world = game.room.state().world!; world.status = 'finished'; world.winner = 'p1'; game.tick(.1);
    const victory = [...ada.guardedSpeech].reverse().find(line => /victorious/i.test(line.text));
    expect(victory?.isCurrent?.()).toBe(true);
    game.tick(FIGHTER_VICTORY_SECONDS);
    expect(victory?.isCurrent?.()).toBe(false);
    expect(ada.spoken.at(-1)).toMatch(/Ada won/i);
    expect(game.room.acknowledgePresentation('results', game.room.state().loadingGeneration)).toBe(true);
    game.stateChanged();
    const replay = ada.spoken.at(-1) ?? '';
    expect(replay).toMatch(/Twilio Conversation Relay transcribes your phone commands.*speaks the play-by-play.*Voice Fighter animates each attack on screen/i);
    expect(replay).toMatch(/rematch/i);
    expect(replay).not.toMatch(/couldn't confirm/i);
  });

  it('announces the winner before replay if the victory cue was still queued at result paint', () => {
    const game = voiceGame(); const ada = game.connect('CA-QUEUED-WINNER');
    ada.prompt('Ada');
    ada.prompt('next'); ada.prompt('Nyx'); ada.prompt('next'); ada.prompt('second'); ada.prompt('start');
    game.room.ready(game.room.state().loadingGeneration); game.stateChanged(); advanceIntro(game); game.tick(6);
    const world = game.room.state().world!; world.status = 'finished'; world.winner = 'p2'; game.tick(.1);
    const victory = [...ada.guardedSpeech].reverse().find(line => /you lost/i.test(line.text));
    game.tick(FIGHTER_VICTORY_SECONDS);
    expect(game.room.acknowledgePresentation('results', game.room.state().loadingGeneration)).toBe(true);
    game.stateChanged();
    expect(victory?.isCurrent?.()).toBe(false);
    const replay = ada.spoken.at(-1) ?? '';
    expect(replay).toMatch(/Rival won.*you lost.*rematch/i);
  });

  it('repeats the winner at results even when KO playback was only estimated', async () => {
    let settleKo!: (playedOrEstimated: boolean) => void;
    const game = voiceGame(undefined, text => /victorious/i.test(text)
      ? new Promise<boolean>(resolve => { settleKo = resolve; }) : undefined);
    const ada = game.connect('CA-ESTIMATED-KO');
    ada.prompt('Ada'); ada.prompt('next'); ada.prompt('Nyx'); ada.prompt('next');
    ada.prompt('second'); ada.prompt('start');
    game.room.ready(game.room.state().loadingGeneration); game.stateChanged(); advanceIntro(game); game.tick(6);
    const world = game.room.state().world!; world.status = 'finished'; world.winner = 'p1'; game.tick(.1);
    settleKo(true); // Relay's boolean includes its estimated-playback fallback.
    await Promise.resolve();
    game.tick(FIGHTER_VICTORY_SECONDS);
    expect(game.room.acknowledgePresentation('results', game.room.state().loadingGeneration)).toBe(true);
    game.stateChanged();
    expect(ada.spoken.at(-1)).toMatch(/Ada won.*rematch/i);
  });

  it.each(['victory', 'results'] as const)('welcomes a new standalone caller into a fresh lobby after %s', finalPhase => {
    const game = voiceGame();
    const ada = game.connect('CA-OLD-RESULT');
    ada.prompt('Ada'); ada.prompt('next'); ada.prompt('Nyx'); ada.prompt('next');
    ada.prompt('second'); ada.prompt('start');
    game.room.ready(game.room.state().loadingGeneration); game.stateChanged();
    advanceIntro(game); game.tick(6);
    const world = game.room.state().world!; world.status = 'finished'; world.winner = 'p1';
    game.tick(.1); if (finalPhase === 'results') game.tick(FIGHTER_VICTORY_SECONDS);
    ada.session.handleClose();
    expect(game.room.state()).toMatchObject({ phase: finalPhase, result: { winnerName: 'Ada' } });

    const bea = game.connect(`CA-NEW-${finalPhase}`);
    expect(bea.playerId).toBeTruthy();
    expect(game.room.state()).toMatchObject({ phase: 'lobby', result: null });
    expect(bea.spoken.join(' ')).toMatch(/name/i);
    bea.prompt('Bea'); bea.prompt('next');
    expect(game.room.phase).toBe('fighter_select');
  });

  it('interprets an open-ended request to reveal the Fighter result early', async () => {
    const game=voiceGame(async request=>{
      expect(request.actions).toEqual(expect.arrayContaining([expect.objectContaining({id:'show_results'})]));
      return {kind:'action',actionId:'show_results'};
    });
    const ada=game.connect('CA-SKIP-RESULT','VOICE',undefined,'Ada');
    ada.prompt('next');ada.prompt('Nyx');ada.prompt('next');ada.prompt('second');ada.prompt('start');
    game.room.ready(game.room.state().loadingGeneration);game.stateChanged();
    advanceIntro(game);game.tick(6);
    const world=game.room.state().world!;world.status='finished';world.winner='p1';game.tick(.1);
    expect(game.room.phase).toBe('victory');
    ada.prompt('Could you put who won on the screen already?');
    await Promise.resolve();
    expect(game.room.phase).toBe('results');
    expect(game.room.resultsPresented).toBe(false);
  });

  it('announces the authoritative result and replay option after a delayed result paint',()=>{
    vi.useFakeTimers();
    try{
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const game=voiceGame();const ada=game.connect('CA-RESULT-RECOVERY');
      ada.prompt('Ada');ada.prompt('next');ada.prompt('Nyx');ada.prompt('next');ada.prompt('second');ada.prompt('start');
      game.room.ready(game.room.state().loadingGeneration);game.stateChanged();advanceIntro(game);game.tick(6);
      const world=game.room.state().world!;world.status='finished';world.winner='p1';game.tick(.1);game.tick(FIGHTER_VICTORY_SECONDS);
      expect(game.room.phase).toBe('results');expect(game.room.resultsPresented).toBe(false);
      vi.advanceTimersByTime(FIGHTER_RESULTS_PRESENTATION_TIMEOUT_MS+1);game.stateChanged();
      expect(ada.spoken.at(-1)).toMatch(/Ada won.*want another fight.*rematch/i);
      expect(ada.spoken.at(-1)).toMatch(/Ada won.*Twilio Conversation Relay transcribes your phone commands.*speaks the play-by-play.*Voice Fighter animates each attack on screen.*Want another fight/i);
      expect(ada.spoken.at(-1)).not.toMatch(/(?:result|winner) (?:is|was|appeared|shown|visible).*display|cannot confirm/i);
      ada.prompt('rematch');
      expect(game.room.phase).toBe('fighter_select');
    }finally{vi.useRealTimers();}
  });

  it('does not claim a station result was shown or offer in-room replay after timeout',()=>{
    vi.useFakeTimers();
    try{
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const game=voiceGame();const ada=game.connect('CA-STATION-RESULT','VOICE',undefined,'Ada');
      ada.prompt('next');ada.prompt('Nyx');ada.prompt('next');ada.prompt('second');ada.prompt('start');
      game.room.ready(game.room.state().loadingGeneration);game.stateChanged();advanceIntro(game);game.tick(6);
      const world=game.room.state().world!;world.status='finished';world.winner='p1';game.tick(.1);game.tick(FIGHTER_VICTORY_SECONDS);
      vi.advanceTimersByTime(FIGHTER_RESULTS_PRESENTATION_TIMEOUT_MS+1);game.stateChanged();
      expect(ada.spoken.at(-1)).toMatch(/Ada won.*check your messages/i);
      expect(ada.spoken.at(-1)).toMatch(/Ada won.*Twilio Conversation Relay transcribes your phone commands.*speaks the play-by-play.*Voice Fighter animates each attack on screen.*check your messages/i);
      expect(ada.spoken.at(-1)).not.toMatch(/cannot confirm|result.*display|rematch/i);
      ada.prompt('rematch');
      expect(game.room.phase).toBe('results');
      expect(ada.spoken.at(-1)).toMatch(/Ada won.*check your messages/i);
    }finally{vi.useRealTimers();}
  });

  it('keeps two-player identity and selections contextual through explicit gates', () => {
    const game = voiceGame();
    const ada = game.connect('CA1');
    ada.prompt('Ada');
    ada.prompt('start');

    const bob = game.connect('CA2');
    bob.prompt('my name is Bob');
    bob.prompt('next');
    bob.prompt('Wraith');
    expect(game.room.state().players.find(player => player.playerId === bob.playerId)?.name).toBe('Bob');
    expect(game.room.state().players.find(player => player.playerId === bob.playerId)?.fighterId).toBe('wraith');
    ada.prompt('Nyx');

    expect(game.room.phase).toBe('fighter_select');
    ada.prompt('next');
    expect(game.room.phase).toBe('fighter_select');
    bob.prompt('next');
    expect(game.room.phase).toBe('map_select');
    bob.prompt('first');
    expect(game.room.state().mapVotesByPlayerId[bob.playerId]).toBe('foundry');
    expect(game.room.phase).toBe('map_select');
    ada.prompt('second');
    expect(game.room.phase).toBe('map_select');
    bob.prompt('start');
    expect(game.room.phase).toBe('map_select');
    ada.prompt('start');
    expect(game.room.phase).toBe('loading');
    game.room.ready(game.room.state().loadingGeneration); game.stateChanged();
    advanceIntro(game); game.tick(6);
    ada.prompt('forward'); bob.prompt('back');
    expect(game.commands.slice(-2)).toEqual([
      { playerId: ada.playerId, command: 'forward' },
      { playerId: bob.playerId, command: 'back' },
    ]);

    expect(bob.spoken.some(line => line.includes('arena vote'))).toBe(true);
    expect(bob.spoken).toContain('Player one, Ada, as Nyx.');
    expect(bob.spoken).toContain('Versus.');
    expect(bob.spoken).toContain('Player two, Bob, as Wraith.');
  });

  it('executes queued combat commands independently for both callers', () => {
    const game=voiceGame(),ada=game.connect('CA-A'),bob=game.connect('CA-B');
    ada.prompt('Ada');bob.prompt('Bob');ada.prompt('next');bob.prompt('next');
    ada.prompt('Nyx');bob.prompt('Wraith');ada.prompt('next');bob.prompt('next');
    ada.prompt('second');bob.prompt('second');ada.prompt('start');bob.prompt('start');
    game.room.ready(game.room.state().loadingGeneration);game.stateChanged();advanceIntro(game);game.tick(6);
    ada.prompt('forward punch kick jump');
    bob.prompt('forward kick punch jump');
    for(let index=0;index<140;index++)game.tick(0.1);
    const actions=game.events.filter(event=>event.type==='action');
    expect(actions.filter(event=>event.fighter==='p1').map(event=>event.command)).toEqual(['forward','punch']);
    expect(actions.filter(event=>event.fighter==='p2').map(event=>event.command)).toEqual(['forward','kick']);
  });

  it('uses station participant order while both callers own their setup choices', () => {
    const game=voiceGame();
    const bob=game.connect('CA-B','VOICE',undefined,'Bob',{index:1,count:2});
    const ada=game.connect('CA-A','VOICE',undefined,'Ada',{index:0,count:2});
    expect(game.room.canControlSetup(ada.playerId)).toBe(true);
    expect(game.room.canControlSetup(bob.playerId)).toBe(true);
    ada.prompt('next');
    expect(game.room.phase).toBe('lobby');
    bob.prompt('next');
    ada.prompt('Nyx');
    expect(game.room.advance()).toBe(false);
    bob.prompt('Wraith');
    expect(game.room.phase).toBe('fighter_select');
    bob.prompt('next');
    expect(game.room.phase).toBe('fighter_select');
    ada.prompt('next');
    expect(game.room.phase).toBe('map_select');
    ada.prompt('second');bob.prompt('second');ada.prompt('start');bob.prompt('start');
    game.room.ready(game.room.state().loadingGeneration);game.stateChanged();advanceIntro(game);game.tick(6);
    ada.prompt('forward punch');bob.prompt('forward kick');
    for(let index=0;index<40;index++)game.tick(0.1);
    const actions=game.events.filter(event=>event.type==='action');
    expect(actions.filter(event=>event.fighter==='p1').map(event=>event.command)).toEqual(['forward','punch']);
    expect(actions.filter(event=>event.fighter==='p2').map(event=>event.command)).toEqual(['forward','kick']);
  });

  it('keeps a lone assigned player in context while waiting for Player Two', () => {
    const game=voiceGame();
    const ada=game.connect('CA-A','VOICE',undefined,'Ada',{index:0,count:2});
    ada.prompt('start');ada.prompt('Nyx');

    expect(game.room.state()).toMatchObject({ expectedPlayerCount: 2, hasExpectedPlayers: false });
    expect(game.room.phase).toBe('lobby');
    expect(ada.spoken.at(-1)).toMatch(/Waiting for Player Two/i);

    ada.prompt('next');
    expect(game.room.phase).toBe('lobby');
    expect(ada.spoken.at(-1)).toMatch(/Waiting for Player Two/i);
  });

  it('describes both fighter and arena loading when the extended deadline expires', () => {
    const game=voiceGame();const ada=game.connect('CA-LOAD','VOICE',undefined,'Ada');
    ada.prompt('start');ada.prompt('Nyx');ada.prompt('next');ada.prompt('second');ada.prompt('fight');

    game.tick(15);
    expect(game.room.phase).toBe('loading');
    game.tick(FIGHTER_LOADING_TIMEOUT_SECONDS-15);

    expect(game.room.phase).toBe('map_select');
    expect(ada.spoken.at(-1)).toBe('The fighters or arena did not finish loading. Choose an arena and try again.');
  });

  it('narrates the same hit from each caller perspective', () => {
    const game=voiceGame(),{ada,bob}=startTwoCallerFight(game);
    ada.spoken.length=0;bob.spoken.length=0;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2_000);
      const hit: FighterEvent={type:'hit',attacker:'p1',defender:'p2',damage:9,blocked:false};
      ada.session.onFighterEvent(hit);bob.session.onFighterEvent(hit);
      expect(ada.spoken).toEqual(['Hit for 9.']);
      expect(bob.spoken).toEqual(['You took 9.']);

      vi.advanceTimersByTime(1_201);
      const blocked: FighterEvent={type:'hit',attacker:'p2',defender:'p1',damage:3,blocked:true};
      ada.session.onFighterEvent(blocked);bob.session.onFighterEvent(blocked);
      expect(ada.spoken.at(-1)).toBe('Blocked.');
      expect(bob.spoken.at(-1)).toBe('They blocked.');
    } finally { vi.useRealTimers(); }
  });

  it('throttles commentary per caller and narrates misses only to the attacker', () => {
    const game=voiceGame(),{ada,bob}=startTwoCallerFight(game);
    ada.spoken.length=0;bob.spoken.length=0;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2_000);
      const hit: FighterEvent={type:'hit',attacker:'p1',defender:'p2',damage:9,blocked:false};
      ada.session.onFighterEvent(hit);bob.session.onFighterEvent(hit);
      vi.advanceTimersByTime(1_200);
      const throttled: FighterEvent={type:'hit',attacker:'p2',defender:'p1',damage:15,blocked:false};
      ada.session.onFighterEvent(throttled);bob.session.onFighterEvent(throttled);
      expect(ada.spoken).toEqual(['Hit for 9.']);
      expect(bob.spoken).toEqual(['You took 9.']);

      vi.advanceTimersByTime(1);
      const miss: FighterEvent={type:'miss',attacker:'p1'};
      ada.session.onFighterEvent(miss);bob.session.onFighterEvent(miss);
      expect(ada.spoken).toEqual(['Hit for 9.','Missed. Move closer.']);
      expect(bob.spoken).toEqual(['You took 9.']);
    } finally { vi.useRealTimers(); }
  });

  it('keeps queued damage commentary valid through a later health tick until caller barge-in', () => {
    const game=voiceGame(),{ada}=startTwoCallerFight(game);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2_000);
      ada.session.onFighterEvent({type:'hit',attacker:'p1',defender:'p2',damage:9,blocked:false});
      const cue=[...ada.guardedSpeech].reverse().find(line=>line.text==='Hit for 9.');
      expect(cue?.isCurrent?.()).toBe(true);
      game.room.state().world!.p2.health-=5;
      game.stateChanged();
      expect(cue?.isCurrent?.()).toBe(true);
      ada.interrupt();
      expect(cue?.isCurrent?.()).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('matches screen numbers, ordinals, normalized IDs, and dynamic names', () => {
    const choices = [
      { id: 'neon-foundry', name: 'Neon Foundry' },
      { id: 'rain-temple', name: 'Rain Temple' },
      { id: 'void-circuit', name: 'Void Circuit' },
    ];
    expect(matchVoiceChoice('the second one', choices)?.id).toBe('rain-temple');
    expect(matchVoiceChoice('number 3', choices)?.id).toBe('void-circuit');
    expect(matchVoiceChoice('rain temple', choices)?.id).toBe('rain-temple');
    expect(matchVoiceChoice('neon foundry', choices)?.id).toBe('neon-foundry');
    expect(matchVoiceChoice('Nicks', FIGHTER_ROSTER)?.id).toBe('nyx');
    expect(matchVoiceChoice('a segunda', choices, 'pt-BR')?.id).toBe('rain-temple');
    expect(matchVoiceChoice('número três', choices, 'pt-BR')?.id).toBe('void-circuit');
    const productionMaps=[...FIGHTER_MAPS,{id:'cyberpunk-city',name:'Cyberpunk City'},
      {id:'inakaya',name:'Inakaya Restaurant'},{id:'rain',name:'Rain'}];
    expect(matchVoiceChoice('option four',productionMaps)?.id).toBe('inakaya');
    expect(matchVoiceChoice('Ina Kaya',productionMaps)?.id).toBe('inakaya');
    expect(matchVoiceChoice('Inikaya',productionMaps)?.id).toBe('inakaya');
    expect(matchVoiceChoice('start training',productionMaps)).toBeNull();
    expect(matchVoiceChoice('brainstorm',productionMaps)).toBeNull();
    expect(matchVoiceChoice('Nyx, no, Wraith', FIGHTER_ROSTER)?.id).toBe('wraith');
    expect(matchVoiceChoice('not Nyx', FIGHTER_ROSTER)).toBeNull();
    expect(matchVoiceChoice('not that fighter, the other one', FIGHTER_ROSTER)).toBeNull();
    expect(matchVoiceChoice('Nyx or Wraith', FIGHTER_ROSTER)).toBeNull();
    expect(matchVoiceChoice('which fighter is Nyx?', FIGHTER_ROSTER)).toBeNull();
  });

  it('uses a bounded semantic choice for conversational fighter requests', async () => {
    const requests: VoiceInterpretRequest[] = [];
    const game=voiceGame(async request => { requests.push(request); return {kind:'action',actionId:'select_fighter',targetId:'nyx'}; });
    const ada=game.connect('CA-DYNAMIC','VOICE',undefined,'Ada');
    ada.prompt('next');
    ada.prompt('Could I play as the shadowy fighter, please?');
    await vi.waitFor(() => expect(game.room.lobbyPlayers()[0]?.fighterId).toBe('nyx'));
    expect(requests.at(-1)).toMatchObject({phase:'fighter_select',game:'fighter'});
    expect(requests.at(-1)?.choices).toContainEqual(expect.objectContaining({id:'nyx'}));
  });

  it('answers fighter questions without treating mentioned names as selections', async () => {
    const requests: VoiceInterpretRequest[] = [];
    const game = voiceGame(async request => {
      requests.push(request);
      return { kind: 'answer', factId: request.transcript.startsWith('Tell')
        ? 'fighter:nyx' : 'fighters' };
    });
    const ada = game.connect('CA-FIGHTER-QUESTIONS', 'VOICE', undefined, 'Ada');
    ada.prompt('next');
    expect(matchVoiceChoice('Tell me about Nyx', FIGHTER_ROSTER)).toBeNull();
    expect(matchVoiceChoice('I like Nyx, what are the options?', FIGHTER_ROSTER)).toBeNull();
    ada.prompt('Tell me about Nyx');
    await vi.waitFor(() => expect(ada.spoken.at(-1)).toMatch(/Nyx.*Nightblade/i));
    ada.prompt('I like Nyx, what are the options?');
    await vi.waitFor(() => expect(ada.spoken.at(-1)).toMatch(/fighters on screen/i));
    expect(game.room.lobbyPlayers()[0]?.fighterId).toBeNull();
    expect(requests.every(request => request.actions.length === 0)).toBe(true);

    ada.prompt('Can I choose Nyx?');
    expect(game.room.lobbyPlayers()[0]?.fighterId).toBe('nyx');
  });

  it('does not commit comparisons, tentative preferences, or two named fighters', async () => {
    const requests: VoiceInterpretRequest[] = [];
    const game = voiceGame(async request => {
      requests.push(request);
      return { kind: 'answer', factId: 'fighters' };
    });
    const ada = game.connect('CA-FIGHTER-COMPARISONS', 'VOICE', undefined, 'Ada');
    ada.prompt('next');
    for (const spoken of ['Compare Nyx with Remy Riot', 'I am thinking about Nyx', 'Nyx and Remy Riot']) {
      expect(matchVoiceChoice(spoken, FIGHTER_ROSTER)).toBeNull();
      ada.prompt(spoken);
      await vi.waitFor(() => expect(requests.at(-1)?.transcript).toBe(spoken));
      expect(game.room.lobbyPlayers()[0]?.fighterId).toBeNull();
      expect(requests.at(-1)?.actions).toEqual([]);
    }
    ada.prompt('I choose Nyx');
    expect(game.room.lobbyPlayers()[0]?.fighterId).toBe('nyx');
  });

  it('answers setup and fight questions from the current screen without advancing', async () => {
    const requests: VoiceInterpretRequest[] = [];
    const game = voiceGame(async request => {
      requests.push(request);
      return { kind: 'answer', factId: request.transcript.includes('arena') ? 'arena' : 'opponent' };
    });
    const ada = game.connect('CA-FIGHTER-FACTS', 'VOICE', undefined, 'Ada');
    ada.prompt('next'); ada.prompt('Nyx'); ada.prompt('next'); ada.prompt('second');
    expect(game.room.phase).toBe('map_select');
    ada.prompt('How do I fight');
    expect(game.room.phase).toBe('map_select');
    expect(ada.spoken.at(-1)).toMatch(/forward.*punch.*kick/i);
    ada.prompt('start');
    game.room.ready(game.room.state().loadingGeneration); game.stateChanged(); advanceIntro(game); game.tick(6);
    expect(game.room.phase).toBe('fight');
    ada.prompt('Who am I fighting?');
    const foeId = game.room.state().players.find(player => player.isAi)?.fighterId;
    const foeName = FIGHTER_ROSTER.find(fighter => fighter.id === foeId)?.name;
    await vi.waitFor(() => expect(ada.spoken.at(-1)).toBe(`You are fighting Rival as ${foeName}.`));
    ada.prompt('Which arena are we in?');
    await vi.waitFor(() => expect(ada.spoken.at(-1)).toMatch(/Void Circuit/i));
    expect(requests.at(-1)?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'opponent' }),
      expect.objectContaining({ id: 'arena' }),
    ]));
  });

  it('answers a winner question at standalone results without starting a rematch', () => {
    const game = voiceGame();
    const ada = game.connect('CA-FIGHTER-WINNER-QUESTION', 'VOICE', undefined, 'Ada');
    ada.prompt('next'); ada.prompt('Nyx'); ada.prompt('next'); ada.prompt('second'); ada.prompt('start');
    game.room.ready(game.room.state().loadingGeneration); game.stateChanged(); advanceIntro(game); game.tick(6);
    const world = game.room.state().world!; world.status = 'finished'; world.winner = 'p2'; game.tick(.1);
    game.tick(FIGHTER_VICTORY_SECONDS);
    expect(game.room.acknowledgePresentation('results', game.room.state().loadingGeneration)).toBe(true);
    game.stateChanged();
    ada.spoken.length = 0;
    ada.prompt('Who won the fight');
    expect(game.room.phase).toBe('results');
    expect(ada.spoken.at(-1)).toMatch(/Rival won.*you lost/i);
  });

  it('drops a late semantic selection if the screen phase changed before the answer', async () => {
    let finish!: (result: VoiceInterpretResult) => void;
    const game=voiceGame(() => new Promise(resolve => { finish=resolve; }));
    const ada=game.connect('CA-STALE-SEMANTIC','VOICE',undefined,'Ada');
    ada.prompt('next');
    ada.prompt('Let me play the shadowy one');
    game.room.selectFighter(ada.playerId,'wraith');
    game.room.advance(ada.playerId);game.stateChanged();
    finish({kind:'action',actionId:'select_fighter',targetId:'nyx'});
    await Promise.resolve();await Promise.resolve();
    expect(game.room.phase).toBe('map_select');
    expect(game.room.lobbyPlayers()[0]?.fighterId).toBe('wraith');
  });

  it('lets a solo caller start immediately after loading is ready', () => {
    const game=voiceGame();const ada=game.connect('CA-SKIP','VOICE',undefined,'Ada');
    ada.prompt('next');ada.prompt('Nyx');ada.prompt('next');ada.prompt('second');ada.prompt('start');
    ada.prompt('start now');
    expect(game.room.phase).toBe('loading');
    game.room.ready(game.room.state().loadingGeneration);game.stateChanged();
    ada.prompt('skip this and start fighting now');
    expect(game.room.phase).toBe('fight');
  });

  it('accepts only safe fight ASR variants after an arena is selected', () => {
    const game = voiceGame(), ada = game.connect('CA-FLIGHT');
    ada.prompt('Ada'); ada.prompt('start'); ada.prompt('Nyx'); ada.prompt('next');
    ada.prompt('my flight is delayed');
    expect(game.room.phase).toBe('map_select');
    ada.prompt('second');
    ada.prompt('he fights at night');
    expect(game.room.phase).toBe('map_select');
    ada.prompt('flight');
    expect(game.room.phase).toBe('loading');
  });

  it('uses the setup command locale for Portuguese menus, choices, commands, and speech', () => {
    const game = voiceGame();
    const ana = game.connect('CA-PT', 'VOICE', 'pt-BR');
    expect(ana.spoken).toEqual([
      'Boas-vindas à Luta por Voz!',
      'Este jogo usa o Twilio Conversation Relay, então sua voz controla a luta em tempo real por esta ligação.',
      'Diga apenas seu primeiro nome. Por exemplo: Ana.',
    ]);

    ana.prompt('quem são os lutadores');
    expect(game.room.hasConfirmedName(ana.playerId)).toBe(false);
    expect(game.room.phase).toBe('lobby');
    ana.prompt('pode me dizer quais lutadores existem');
    expect(game.room.hasConfirmedName(ana.playerId)).toBe(false);
    ana.prompt('meu nome é ana');
    expect(ana.spoken.slice(-4)).toEqual([
      'Boas-vindas à Luta por Voz, Ana.',
      'Antes de começar, veja os controles na tela.',
      'Reduza os pontos de vida do rival a zero. Durante a luta, diga avançar, recuar, pular, soco, chute ou bloquear.',
      'Quando todos estiverem prontos, diga próximo para escolher seu lutador.',
    ]);
    ana.prompt('próximo');
    expect(ana.spoken.at(-1)).toBe('Escolha seu lutador. Diga o nome ou número exibido na tela.');
    ana.prompt('primeira');
    expect(game.room.state().players.find(player => player.playerId === ana.playerId)?.fighterId).toBe('nyx');
    ana.prompt('próximo');
    expect(ana.spoken.at(-1)).toBe('Escolha sua arena. Diga o nome ou número exibido na tela.');
    ana.prompt('segunda');
    expect(game.room.state().selectedMap).toBe('void');
    expect(game.room.phase).toBe('map_select');
    expect(ana.spoken.at(-1)).toMatch(/Diga começar/i);
    ana.prompt('lutar');
    expect(game.room.phase).toBe('loading');
    expect(ana.spoken.at(-1)).toMatch(/Prepare-se/i);

    game.room.ready(game.room.state().loadingGeneration); game.stateChanged();
    advanceIntro(game); game.tick(6);
    ana.prompt('ajuda');
    expect(ana.spoken.at(-1)).toMatch(/avançar.*recuar.*pular.*soco.*chute.*bloquear/i);
    ana.prompt('frente');
    expect(game.commands.at(-1)).toEqual({ playerId: ana.playerId, command: 'forward' });
    expect(ana.spoken).toContain('Contra.');
    expect(ana.spoken).toContain('Lutadores prontos.');
  });

  it('lets a late Portuguese caller introduce themselves without interrupting fighter selection', () => {
    const game = voiceGame();
    const ana = game.connect('CA-PT-HOST', 'VOICE', 'pt-BR');
    ana.prompt('Ana'); ana.prompt('começar');
    const bia = game.connect('CA-PT-LATE', 'VOICE', 'pt-BR');

    expect(game.room.phase).toBe('fighter_select');
    expect(bia.spoken.join(' ')).not.toMatch(/qual seu nome|diga seu nome/i);
    bia.prompt('Meu nome é Bia');

    expect(game.room.state().players.find(player => player.playerId === bia.playerId)?.name).toBe('Bia');
    expect(bia.spoken.some(line => line.includes('Luta por Voz, Bia'))).toBe(true);
  });

  it('ignores combat interims and expands only finalized command bursts', () => {
    const commands: FighterCommand[] = [], spoken: string[] = [];
    const snapshot: FighterVoiceSnapshot = {
      phase: 'fight', myName: 'Ada', myFighterId: 'nyx', myFighterName: 'Nyx', foeName: 'Rival',
      foeFighterId:'wraith',foeFighterName:'Wraith',selectedMap:'void',myMapVote:'void',allMapVotes:true,mySide:'p1',myHealth:100,
      foeHealth: 100, countdown: null, intro: null, winnerName: null, winnerSide: null,
      playerOneName: 'Ada', playerOneFighterName: 'Nyx', playerTwoName: 'Rival', playerTwoFighterName: 'Wraith',
      playerCount:1,hasExpectedPlayers:true,automaticSetup:false,allFightersSelected:true,isController:true,
      fighters: FIGHTER_ROSTER.map(fighter => ({ id: fighter.id, name: fighter.name })),
      maps: FIGHTER_MAPS.map(map => ({ id: map.id, name: map.name })),
    };
    const session = new FighterVoiceSession({
      say: text => { spoken.push(text); }, join: () => ({ playerId: 'f1', resumed: true }), leave: () => {}, setName: () => {},
      selectFighter: () => false, selectMap: () => false, advance: () => false,
      command: (_code, _id, command) => { commands.push(command); return true; }, snapshot: () => snapshot,
    });
    session.handleMessage(JSON.stringify({ type: 'setup', callSid: 'CA1', customParameters: { roomCode: '4821' } }));
    const prompt = (voicePrompt: string, last: boolean) => session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt, last }));
    prompt('punch', false); prompt('punch', false); prompt('punch five times', true);
    expect(commands).toEqual(['punch', 'punch']);
    prompt('kick', false); prompt('kick', false); prompt('kick punch', true);
    expect(commands.slice(2)).toEqual(['kick', 'punch']);
    prompt('kick', false);
    session.handleMessage(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: '', durationUntilInterruptMs: 100 }));
    prompt('kick', false);
    expect(commands).toHaveLength(4);
    prompt('kick', true);
    expect(commands.at(-1)).toBe('kick');
    expect(spoken.join(' ')).not.toContain('Say forward');
  });

  it('executes a natural final combat command synchronously without waiting for semantic inference', () => {
    const interpret = vi.fn(async (): Promise<VoiceInterpretResult> => ({ kind: 'none' }));
    const game = voiceGame(interpret), caller = game.connect('CA-FAST-COMBAT');
    caller.prompt('Ada'); caller.prompt('next'); caller.prompt('Nyx'); caller.prompt('next');
    caller.prompt('second'); caller.prompt('start');
    game.room.ready(game.room.state().loadingGeneration); game.stateChanged();
    advanceIntro(game); game.tick(6);
    const before = game.commands.length;
    caller.prompt('Hit him with a kick');
    expect(game.commands.slice(before)).toEqual([{ playerId: caller.playerId, command: 'kick' }]);
    expect(interpret).not.toHaveBeenCalled();
  });

  it('maps Fighter DTMF choices and fight controls through the active phase', () => {
    const game=voiceGame(),ada=game.connect('CA-DTMF');
    ada.prompt('Ada');ada.prompt('start');
    ada.session.handleMessage(JSON.stringify({type:'dtmf',digit:'1'}));
    expect(game.room.state().players.find(player=>player.playerId===ada.playerId)?.fighterId).toBe(FIGHTER_ROSTER[0]!.id);
    ada.prompt('next');ada.session.handleMessage(JSON.stringify({type:'dtmf',digit:'2'}));ada.prompt('fight');
    game.room.ready(game.room.state().loadingGeneration);game.stateChanged();advanceIntro(game);game.tick(6);
    const before=game.commands.length;
    ada.session.handleMessage(JSON.stringify({type:'dtmf',digit:'4'}));
    expect(game.commands.slice(before).map(entry=>entry.command)).toContain('punch');
  });

  it('invalidates queued intro and countdown speech when display readiness is lost', () => {
    const game = voiceGame(), ada = game.connect('CA-GUARDED-CUES');
    ada.prompt('Ada'); ada.prompt('next'); ada.prompt('Nyx'); ada.prompt('next');ada.prompt('second');ada.prompt('start');
    game.room.ready(game.room.state().loadingGeneration); game.stateChanged();
    const introCue = ada.guardedSpeech.find(entry => /player one/i.test(entry.text));
    expect(introCue?.isCurrent?.()).toBe(true);
    game.room.invalidateDisplayReady(); game.stateChanged();
    expect(introCue?.isCurrent?.()).toBe(false);

    game.room.ready(game.room.state().loadingGeneration); game.stateChanged();
    expect(game.room.phase).toBe('intro');
    expect(introCue?.isCurrent?.()).toBe(false);
    advanceIntro(game);
    game.tick(3.1);
    const countdownCue = [...ada.guardedSpeech].reverse().find(entry => entry.text === '3');
    expect(countdownCue?.isCurrent?.()).toBe(true);
    game.room.invalidateDisplayReady(); game.stateChanged();
    expect(countdownCue?.isCurrent?.()).toBe(false);
  });

  it.each([['0',9],['*',10],['#',11]] as const)('maps Fighter DTMF %s to roster option %s', (digit,index) => {
    const game=voiceGame(),ada=game.connect(`CA-DTMF-${digit}`);ada.prompt('Ada');ada.prompt('start');
    ada.session.handleMessage(JSON.stringify({type:'dtmf',digit}));
    expect(game.room.state().players.find(player=>player.playerId===ada.playerId)?.fighterId).toBe(FIGHTER_ROSTER[index]!.id);
  });

  it('lets a corrected character selection through after barge-in', () => {
    const game = voiceGame(), ada = game.connect('CA-INTERRUPT');
    ada.prompt('Ada'); ada.prompt('start');
    ada.prompt('Nicks', false);
    expect(game.room.state().players[0]?.fighterId).toBeNull();
    ada.interrupt();
    ada.prompt('Wraith');
    expect(game.room.state().players[0]?.fighterId).toBe('wraith');
  });
});

function voiceGame(interpret?: (request: VoiceInterpretRequest) => Promise<VoiceInterpretResult>,
  speechDelivery?: (text: string) => void | Promise<boolean | 'played' | 'estimated' | 'interrupted' | 'failed'>,
  menuSpeechBarrier = false) {
  const room = new FighterRoom('VOICE', 1234);
  const sessions: FighterVoiceSession[] = [];
  const commands: { playerId: string; command: FighterCommand }[] = [];
  const events: FighterEvent[] = [];

  const stateChanged = () => sessions.forEach(session => session.onStateChanged());
  const publishEvents = (events: FighterEvent[]) => {
    if (!events.length) return;
    for (const event of events) { for (const session of sessions) session.onFighterEvent(event); }
  };
  const snapshot = (playerId: string): FighterVoiceSnapshot | null => {
    const state = room.state();
    const me = state.players.find(player => player.playerId === playerId); if (!me?.side) return null;
    const foeSide = me.side === 'p1' ? 'p2' : 'p1';
    const foe = state.players.find(player => player.side === foeSide);
    const playerOne = state.players.find(player => player.side === 'p1'), playerTwo = state.players.find(player => player.side === 'p2');
    const fighterName = (id: string | null | undefined) => FIGHTER_ROSTER.find(fighter => fighter.id === id)?.name ?? null;
    const humans = state.players.filter(player => !player.isAi);
    return {
      phase: state.phase,
      myName: me.name,
      nameConfirmed: room.hasConfirmedName(playerId),
      myFighterId: me.fighterId,
      myFighterName: fighterName(me.fighterId),
      foeName: foe?.name ?? null,
      foeFighterId: foe?.fighterId ?? null,
      foeFighterName: fighterName(foe?.fighterId),
      selectedMap: state.selectedMap,
      mapVoteTied: state.mapVoteTied,
      loadingGeneration: state.loadingGeneration,
      myMapVote:state.mapVotesByPlayerId[playerId]??null,
      allMapVotes:humans.every(player=>Boolean(state.mapVotesByPlayerId[player.playerId])),
      mySide: me.side,
      myHealth: state.world?.[me.side].health ?? null,
      foeHealth: state.world?.[foeSide].health ?? null,
      countdown: state.countdown,
      intro: state.intro,
      winnerName: state.result?.winnerName ?? null,
      winnerSide: state.result?.winner ?? null,
      hudPresented:room.hudPresented,
      resultsPresented:room.resultsPresented,
      resultsPresentationTimedOut:room.resultsPresentationTimedOut,
      playerOneName: playerOne?.name ?? null,
      playerOneFighterName: fighterName(playerOne?.fighterId),
      playerTwoName: playerTwo?.name ?? null,
      playerTwoFighterName: fighterName(playerTwo?.fighterId),
      playerCount: humans.length,
      expectedPlayerCount: state.expectedPlayerCount,
      phoneRetryPlayerIds: state.phoneRetryPlayerIds,
      myAdvanceReady: state.advanceReadyPlayerIds.includes(playerId),
      myBackReady: state.backReadyPlayerIds.includes(playerId),
      foeAdvanceReady: foe ? state.advanceReadyPlayerIds.includes(foe.playerId) : false,
      foeBackReady: foe ? state.backReadyPlayerIds.includes(foe.playerId) : false,
      hasExpectedPlayers: state.hasExpectedPlayers,
      automaticSetup:state.automaticSetup,
      allFightersSelected: humans.length > 0 && humans.every(player => player.fighterId),
      isController: room.canControlSetup(playerId),
      fighters: FIGHTER_ROSTER.map(fighter => ({ id: fighter.id, name: fighter.name })),
      maps: FIGHTER_MAPS.map(map => ({ id: map.id, name: map.name })),
    };
  };

  const connect = (callSid: string, roomCode = 'VOICE', commandLocale?: string, authoritativeName?: string,
    stationAssignment?:{index:number;count:number}) => {
    const spoken: string[] = [];
    const guardedSpeech: { text: string; isCurrent?: () => boolean }[] = [];
    let playerId = '';
    const session = new FighterVoiceSession({
      say: (text, isCurrent) => {
        spoken.push(text); guardedSpeech.push({ text, ...(isCurrent ? { isCurrent } : {}) });
        return speechDelivery?.(text);
      },
      join: (_code,name,_callSid,side,expectedPlayers,nameConfirmed) => {
        if(expectedPlayers!==undefined)room.expectHumanPlayers(expectedPlayers,side!==undefined);
        else if(room.playerCount>=1)room.expectHumanPlayers(2,false);
        const joined = room.addPlayer(name,side,nameConfirmed);
        if ('error' in joined) return null;
        if (menuSpeechBarrier) room.registerVoicePlayer(joined.playerId);
        playerId = joined.playerId; stateChanged(); return { playerId, resumed: false };
      },
      leave: (_code, id) => { room.removePlayer(id); stateChanged(); },
      setName:(_code,id,name)=>{room.setName(id,name);room.expectHumanPlayers(Math.max(1,room.playerCount),false);stateChanged();},
      selectFighter: (_code, id, fighterId) => { const ok = room.selectFighter(id, fighterId); stateChanged(); return ok; },
      selectMap: (_code,id,mapId)=>{const ok=room.selectMap(id,mapId);stateChanged();return ok;},
      advance: (_code, id) => { const ok = room.advance(id); stateChanged(); return ok; },
      back: (_code,id)=>{const ok=room.back(id);stateChanged();return ok;},
      skipIntro: (_code,id)=>{const ok=room.skipIntro(id);stateChanged();return ok;},
      startNow: (_code,id)=>{const ok=room.startNow(id);stateChanged();return ok;},
      showResults:(_code,id)=>{const ok=room.revealResults(id);stateChanged();return ok;},
      command: (_code, id, command, requestId) => {
        const outcome=room.voiceCommand(id, command,requestId??'test-command');
        if(outcome.status!=='rejected')commands.push({ playerId: id, command });
        const emitted=room.drainEvents();events.push(...emitted);publishEvents(emitted);stateChanged();return outcome;
      },
      commandSequence: (_code,id,pair,requestIds)=>{
        const outcomes=room.voiceSequence(id,pair,requestIds);
        for(const outcome of outcomes)if(outcome.status!=='rejected')commands.push({playerId:id,command:outcome.command});
        const emitted=room.drainEvents();events.push(...emitted);publishEvents(emitted);stateChanged();return outcomes;
      },
      snapshot: (_code, id) => snapshot(id),
      ...(menuSpeechBarrier ? { beginMenuAudio: (_code: string, id: string,
        phase: FighterVoiceSnapshot['phase'], recovery?: boolean) => {
        const release = room.beginMenuAudio(id, phase, recovery);
        return (played?: boolean) => { release(played); queueMicrotask(() => {
          if (room.completeSharedDecisionIfReady()) stateChanged();
        }); };
      }, beginMenuTurn: (_code: string, id: string,
        phase: FighterVoiceSnapshot['phase']) => {
        const release = room.beginMenuTurn(id, phase);
        return () => { release(); queueMicrotask(() => {
          if (room.completeSharedDecisionIfReady()) stateChanged();
        }); };
      } } : {}),
      ...(interpret?{interpret}:{}),
    });
    session.setAuthoritativeName(authoritativeName??null);
    session.setStationManaged(authoritativeName!==undefined||stationAssignment!==undefined);
    if(stationAssignment)session.setStationAssignment(stationAssignment.index,stationAssignment.count);
    sessions.push(session);
    session.handleMessage(JSON.stringify({ type: 'setup', callSid, customParameters: { roomCode, ...(commandLocale ? { commandLocale } : {}) } }));
    return {
      session,
      spoken,
      guardedSpeech,
      get playerId() { return playerId; },
      prompt(text: string, last = true) { session.handleMessage(JSON.stringify({ type: 'prompt', voicePrompt: text, last })); },
      interrupt() { session.handleMessage(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: '', durationUntilInterruptMs: 100 })); },
    };
  };

  const tick = (seconds: number) => { room.tick(seconds);const emitted=room.drainEvents();events.push(...emitted);publishEvents(emitted);
    const outcomes=room.drainVoiceCommandOutcomes();for(const session of sessions)session.onVoiceCommandOutcomes(outcomes);stateChanged(); };
  return { room, commands, events, connect, tick, stateChanged };
}

function startTwoCallerFight(game: ReturnType<typeof voiceGame>) {
  const ada=game.connect('CA-COMMENTARY-A','VOICE',undefined,'Ada',{index:0,count:2});
  const bob=game.connect('CA-COMMENTARY-B','VOICE',undefined,'Bob',{index:1,count:2});
  ada.prompt('next');bob.prompt('next');
  ada.prompt('Nyx');bob.prompt('Wraith');ada.prompt('next');bob.prompt('next');
  ada.prompt('second');bob.prompt('second');ada.prompt('start');bob.prompt('start');
  game.room.ready(game.room.state().loadingGeneration);game.stateChanged();advanceIntro(game);game.tick(6);
  return {ada,bob};
}

function advanceIntro(game: ReturnType<typeof voiceGame>): void {
  expect(game.room.state().intro).toBe(FIGHTER_INTRO_SECONDS);
  game.tick(4.1); // Player one -> versus
  game.tick(2);   // Versus -> player two
  game.tick(4);   // Player two -> faceoff
  game.tick(4);   // Faceoff -> countdown
}
