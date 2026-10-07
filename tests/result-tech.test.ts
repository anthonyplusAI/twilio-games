import { describe, expect, it } from 'vitest';
import { resultTechHtml, type ResultTechGame } from '../client/result-tech';

const games: ResultTechGame[] = ['racer', 'monsters', 'fighter', 'karaoke', 'trivia', 'chess'];

describe('end-of-game technology story', () => {
  it.each(games)('keeps %s station results short and on the shared display', game => {
    const html = resultTechHtml(game, 'en-US', { stationManaged: true });
    expect(html).toContain('How your voice moved this game');
    expect(html.match(/class="result-tech__node(?: result-tech__node--voice-paths)?"/g)).toHaveLength(4);
    expect(html).toContain(game === 'karaoke' ? 'Conversation Relay: menus + consent' : 'Twilio Conversation Relay');
    expect(html).toContain('Shared screen');
    expect(html).not.toContain('result-tech__more');
    expect(html).not.toContain('href=');
  });

  it('explains Karaoke’s separate, consented singing path', () => {
    const html = resultTechHtml('karaoke', 'en-US');
    expect(html).toContain('Conversation Relay: menus + consent');
    expect(html).toContain('Media Stream: singing');
    expect(html).toContain('Rules + scoring');
    expect(html).toContain('After consent, an authenticated Twilio Media Stream carries singing');
    expect(html).toContain('inbound-only Twilio Media Stream');
    expect(html).toContain('Deepgram recognizes lyrics when available');
  });

  it('adds the full guide below a standalone result and localizes Portuguese', () => {
    const html = resultTechHtml('chess', 'pt-BR');
    expect(html).toContain('Como sua voz moveu este jogo');
    expect(html).toContain('Seu telefone');
    expect(html).toContain('pedido de roque');
    expect(html).toContain('class="result-tech__more"');
    expect(html).toContain('href="/how-it-works.html?locale=pt-BR"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  });

  it('uses neutral architecture copy when a station game is unknown', () => {
    const html = resultTechHtml('arcade', 'en-US', { stationManaged: true });
    expect(html).toContain('How a voice turn reaches the screen');
    expect(html).toContain('The game server checks the current state');
    expect(html).not.toContain('won');
    expect(html).not.toContain('score');
  });
});
