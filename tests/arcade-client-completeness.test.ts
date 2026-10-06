import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const arcade = readFileSync(new URL('../client/arcade/arcade.ts', import.meta.url), 'utf8');
const arcadeHtml = readFileSync(new URL('../client/arcade/index.html', import.meta.url), 'utf8');
const arcadeCss = readFileSync(new URL('../client/arcade/arcade.css', import.meta.url), 'utf8');
const join = readFileSync(new URL('../client/join/join.ts', import.meta.url), 'utf8');
const joinGuidance = readFileSync(new URL('../client/join/guidance.ts', import.meta.url), 'utf8');
const stationClient = readFileSync(new URL('../client/station-client.ts', import.meta.url), 'utf8');

describe('Arcade client completeness', () => {
  it('keeps every static client DOM lookup backed by rendered markup', () => {
    const ids = new Set([...arcadeHtml.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
    const lookups = [...arcade.matchAll(/\bel(?:<[^>]+>)?\('([^']+)'\)/g)].map(match => match[1]!);
    expect([...new Set(lookups)].filter(id => !ids.has(id))).toEqual([]);
  });

  it('routes no-lead coin-only players back to join and limits browser registration to lead capture', () => {
    expect(arcade).toContain("currentConfig.arcade.mode==='coin_only'&&redirectNoLeadPlayer()");
    expect(arcade).toContain('effectivePublicVisitorBaseUrl(state.deployment?.publicBaseUrl)');
    expect(arcade).toContain('location.replace(`${target.pathname}${target.search}`)');
    expect(join).toMatch(/if \(mode === 'lead_capture'\) \{[\s\S]*?'Continue in browser'/);
    expect(join).toContain("portuguese ? 'Continuar no navegador' : 'Continue in browser'");
  });

  it('keeps lead-capture player state live over station/config SSE with polling fallback', () => {
    expect(arcade).toContain('startPlayerUpdates()');
    expect(arcade).toContain("events.addEventListener('arcade_station_updated'");
    expect(arcade).toContain("events.addEventListener('arcade_config_updated'");
    expect(arcade).toContain('startPlayerPolling()');
    expect(arcade).toContain('refreshPlayerConfiguration().catch(showError),5000');
    expect(arcade).toContain("maybe<StationView>('/api/arcade/station/me')");
    const playerRefresh = /async function refreshPlayerConfiguration\(\)[\s\S]*?\n}/.exec(arcade)?.[0] ?? '';
    expect(playerRefresh).not.toContain('.reset()');
  });

  it('only presents a localized call action for an admitted player with a call number', () => {
    expect(stationClient).toContain('termsAcknowledgementRequired: boolean');
    expect(arcade).toContain('callNumber:string|null');
    expect(arcade).toContain("station?.ready?.status==='ADMITTED'?station.callNumber?.trim():''");
    expect(arcade).toContain('callNow.href=`tel:${callNumber}`');
    expect(arcade).toContain('Call now · ${callNumber}');
    expect(arcade).toContain('Ligue agora · ${callNumber}');
    expect(arcadeHtml).toContain('id="call-now"');
    expect(arcadeCss).toContain('.call-now{');
  });

  it('follows public terms and starting-balance settings without promising a zero grant', () => {
    expect(arcadeHtml).toContain('id="terms-field"');
    expect(arcade).toContain("show('terms-field',termsRequired);termsInput.required=termsRequired");
    expect(arcade).toContain('const startingBalance=freePlay?0:state.config?.coins.startingBalance??0');
    expect(arcade).toContain("playerText('Continue','Continuar')");
    expect(arcade).not.toContain('Registration complete. Earn a coin to join the ready pool.');
    expect(arcadeHtml).not.toContain('Register and receive coin');
  });

  it('shows and validates effective operator channel capabilities', () => {
    expect(arcadeHtml).toContain('id="admin-voice"');
    expect(arcade).toContain("state.deployment=await api<DeploymentConfig>('/api/config')");
    expect(arcade).toContain("(settings.channels as AdminConfig['channels']).voice=el<HTMLInputElement>('admin-voice').checked");
    expect(arcade).toContain('deploymentChannelNumber');
    expect(arcade).toContain('effectiveVoiceNumbers');
    expect(arcade).toContain("selectedMode==='coin_only'&&!smsReady&&!whatsappReady");
    expect(arcade).toContain("selectedMode!=='off'&&!(settings.channels as AdminConfig['channels']).voice");
    expect(arcade).toContain("selectedMode!=='off'&&!voiceReady");
    expect(arcade).toContain("return number?'Ready':'Add a phone number'");
  });

  it('derives operator overview cards from existing config, station, and messaging state', () => {
    for (const id of [
      'operator-overview', 'overview-event', 'overview-game', 'overview-players', 'overview-messaging', 'overview-display',
      'operator-tab-overview', 'operator-tab-live-event', 'operator-tab-messages', 'operator-tab-setup',
      'live-event', 'messages', 'setup', 'settings-savebar', 'settings-open-blocker', 'voice-number-fields',
      'player-recovery-panel', 'player-recovery-list',
    ]) expect(arcadeHtml).toContain(`id="${id}"`);
    const overview = /function renderOperatorOverview\(\):void\{[\s\S]*?\n}/.exec(arcade)?.[0] ?? '';
    expect(overview).toContain('state.adminConfig');
    expect(overview).toContain('state.operatorStation');
    expect(overview).toContain('state.adminStatus?.messaging');
    expect(overview).not.toMatch(/\b(?:api|request|fetch|post)\s*[<(]/);
    expect(arcade).toContain("addEventListener('input',()=>setModeFormDirty(true))");
    expect(arcade).toContain("addEventListener('change',()=>setModeFormDirty(true))");
    expect(arcade).toContain("el('settings-savebar').hidden=!dirty");
    expect(arcade).toContain("el('voice-number-fields').hidden=!voice");
  });

  it('uses the short localized join command and explains the guided replies', () => {
    expect(join).toContain('buildJoinGuidance');
    expect(joinGuidance).toContain("portuguese ? 'ENTRAR' : 'JOIN'");
    expect(joinGuidance).not.toContain('JOIN ${station}');
    expect(joinGuidance).toContain('Send ${command} by ${englishChannel}.');
    expect(joinGuidance).not.toContain('including YES for terms');
    expect(joinGuidance).toContain('just tap Send');
    expect(joinGuidance).toContain('basta tocar em Enviar');
    expect(join).not.toContain('messageCommandPanel');
    expect(join).toContain('sms:${smsNumber}?body=${encodeURIComponent(command)}');
    expect(join).toContain('https://wa.me/${digits}?text=${encodeURIComponent(command)}');
    expect(join).toContain('const smsNumber = availableNumber(bootstrap.smsNumber)');
    expect(join).toContain('const whatsappNumber = availableNumber(bootstrap.whatsappNumber)');
    expect(join).toContain(".catch(() => ({}))");
    expect(join).toContain('const sms = !portuguese && arcade.channels.sms && Boolean(smsNumber)');
    expect(join).toContain('const whatsapp = arcade.channels.whatsapp && Boolean(whatsappNumber)');
    expect(join).toContain("mode === 'lead_capture'");
    expect(join).toContain('fallbackLabel()');
    expect(join).not.toContain("' primary'");
    expect(join).toContain("'sms'");
    expect(join).toContain("'whatsapp'");
  });

  it('lets a current ready browser player cast and change a localized game vote', () => {
    expect(arcadeHtml).toContain('id="game-choice-panel"');
    expect(arcade).toContain("station?.phase==='GAME_SELECTION'&&station.ready?.status==='READY'");
    expect(arcade).toContain("post<GameChoiceResponse>('/api/arcade/station/game-choice',{game})");
    expect(arcade).toContain('ready:{...state.station.ready,gameChoice:result.gameChoice}');
    const choiceRequest = /async function chooseGame\(game:PlayableGame\)[\s\S]*?\n}/.exec(arcade)?.[0] ?? '';
    expect(choiceRequest.indexOf('gameChoice:result.gameChoice')).toBeLessThan(choiceRequest.indexOf('await refreshPlayer()'));
    expect(choiceRequest).toContain('Keep the saved choice');
    expect(arcade).toContain('gameChoice:PlayableGame|null');
    expect(arcade).toContain('Você pode mudar seu voto');
    expect(arcadeCss).toContain('.player-game-choices button.selected');
  });

  it('never offers disabled games and preserves all six global game numbers', () => {
    expect(arcade).toContain('games:Record<PlayableGame,{enabled:boolean}>;comingSoon:Record<HomeConcept,{enabled:false}>');
    expect(arcade).toContain('const enabled=state.config?.station.games[game]?.enabled===true');
    expect(arcade).toContain('button.hidden=!enabled');
    expect(arcade).toContain('button.disabled=gameChoiceSaving||!enabled');
    expect(arcade).toContain("state.config?.station.games[game]?.enabled!==true)return");
    expect(arcadeHtml).toMatch(/data-game-choice="racer"><span>1<\/span>/);
    expect(arcadeHtml).toMatch(/data-game-choice="monsters"><span>2<\/span>/);
    expect(arcadeHtml).toMatch(/data-game-choice="fighter"><span>3<\/span>/);
    expect(arcadeHtml).toMatch(/data-game-choice="karaoke"><span>4<\/span>/);
    expect(arcadeHtml).toMatch(/data-game-choice="trivia"><span>5<\/span>/);
    expect(arcadeHtml).toMatch(/data-game-choice="chess"><span>6<\/span>/);
    expect(arcadeHtml).toContain('id="admin-game-trivia"');
    expect(arcadeHtml).toContain('id="admin-game-chess"');
    expect(arcadeHtml).not.toContain('id="admin-coming-soon-trivia"');
    expect(arcade).toContain('station.comingSoon.trivia.enabled=false');
    expect(arcadeHtml).not.toContain('admin-coming-soon-karaoke');
  });
});
