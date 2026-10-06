import type { LocalizedCatalog } from './translate';

const EN_MESSAGES = {
  'page.title': 'Twilio Games',
  'hero.eyebrow': 'Voice-controlled party games · powered by Twilio',
  'hero.title': 'Play with your <span class="accent">voice.</span>',
  'hero.description': 'Multiplayer party games controlled entirely by voice.<br>Players call in from any phone and shout commands to play.',
  'games.heading': 'Choose a game',
  'games.playable': 'Playable',
  'games.soon': 'Coming soon',
  'games.select': 'Select {game}',
  'games.play': 'Play {game}',
  'games.selectPrompt': 'Select a game to play',
  'games.racer.blurb': 'Lane-dodging multiplayer race. Shout your moves; dodge barriers, grab boosts.',
  'games.monsters.blurb': 'Command your creature out loud in turn-based duels. Call your attacks and out-strategize your rival.',
  'games.fighter.blurb': 'Call your attacks out loud in a cinematic side-view brawler.',
  'games.trivia.blurb': 'Answer shared-screen trivia over a phone call. Every correct caller scores independently.',
  'games.chess.blurb': 'Command enchanted chess pieces by voice and duel a computer wizard.',
  'games.karaoke.blurb': 'Karaoke meets Guitar Hero - sing into the call and nail the timing of each word for points.',
  'theme.light': 'Light theme',
  'theme.dark': 'Dark theme',
  'theme.toggle': 'Toggle theme',
  'footer': 'Built as a Twilio showcase - Voice, Conversation Relay, and more. Models CC-BY (see credits).',
} as const;

export type HomeMessageKey = keyof typeof EN_MESSAGES;

const PT_MESSAGES: Record<HomeMessageKey, string> = {
  'page.title': 'Jogos da Twilio',
  'hero.eyebrow': 'Jogos para festas controlados por voz · com tecnologia Twilio',
  'hero.title': 'Jogue com sua <span class="accent">voz.</span>',
  'hero.description': 'Jogos para vários jogadores controlados inteiramente por voz.<br>Os jogadores ligam de qualquer telefone e dizem os comandos para jogar.',
  'games.heading': 'Escolha um jogo',
  'games.playable': 'Disponível',
  'games.soon': 'Em breve',
  'games.select': 'Selecionar {game}',
  'games.play': 'Jogar {game}',
  'games.selectPrompt': 'Selecione um jogo',
  'games.racer.blurb': 'Corrida para vários jogadores com troca de faixas. Grite seus comandos, desvie das barreiras e colete esferas de nitro.',
  'games.monsters.blurb': 'Comande sua criatura em duelos por turnos. Diga seus ataques e supere a estratégia do rival.',
  'games.fighter.blurb': 'Diga seus ataques em uma luta cinematográfica vista de lado.',
  'games.trivia.blurb': 'Responda por telefone às perguntas exibidas na tela. Cada jogador que acerta marca pontos de forma independente.',
  'games.chess.blurb': 'Comande peças de xadrez encantadas por voz e desafie um mago virtual.',
  'games.karaoke.blurb': 'Karaokê com Guitar Hero: cante pela ligação e acerte a entrada de cada palavra para marcar pontos.',
  'theme.light': 'Tema claro',
  'theme.dark': 'Tema escuro',
  'theme.toggle': 'Alternar tema',
  'footer': 'Criado como uma demonstração da Twilio: Voice, Conversation Relay e muito mais. Modelos 3D sob licença CC BY (consulte os créditos).',
};

export const HOME_MESSAGES: LocalizedCatalog<HomeMessageKey> = {
  'en-US': EN_MESSAGES,
  'pt-BR': PT_MESSAGES,
};
