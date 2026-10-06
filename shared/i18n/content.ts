import type { SupportedLocale } from './locales';
import type { ArcadeGame } from '../arcade-config';

export type GameId = ArcadeGame;

const GAME_TITLES: Record<GameId, Record<SupportedLocale, string>> = {
  racer: { 'en-US': 'Voice Racer', 'pt-BR': 'Corrida por Voz' },
  monsters: { 'en-US': 'Voice Monsters', 'pt-BR': 'Monstros por Voz' },
  fighter: { 'en-US': 'Voice Fighter', 'pt-BR': 'Luta por Voz' },
  trivia: { 'en-US': 'Voice Trivia', 'pt-BR': 'Quiz por Voz' },
  karaoke: { 'en-US': 'Voice Karaoke', 'pt-BR': 'Karaokê por Voz' },
  chess: { 'en-US': 'Voice Chess', 'pt-BR': 'Xadrez por Voz' },
};

const CAR_NAMES: Record<string, string> = {
  Batmobile: 'Batmóvel',
  Buggy: 'Bugue',
  'Jurassic Park Rover': 'Veículo de Jurassic Park',
  'Monster Truck': 'Caminhão Monstro',
  Monowheel: 'Monorroda',
  Climber: 'Escalador',
  Forklift: 'Empilhadeira',
  'Mini Bot': 'Mini-Robô',
  Trailer: 'Reboque',
  'Beetle / Fusca': 'Fusca',
  'Cartoon Sports Car': 'Carro Esportivo de Desenho Animado',
  'Cicada (Retro Cartoon Car)': 'Cigarra, Carro Retrô de Desenho Animado',
};

const TRACK_NAMES: Record<string, string> = {
  'Silver Lake': 'Lago Prateado',
  Drift: 'Derrapagem',
};

const MONSTER_NAMES: Record<string, string> = {
  sparkmouse: 'Rato-Faísca',
  embertail: 'Cauda-Brasa',
  shellback: 'Casco-Duro',
  thornling: 'Espinhoto',
  galecoil: 'Serpente-Tempestade',
  voltcrest: 'Crista-Volt',
  dazeduck: 'Patonto',
  psyclone: 'Psiciclone',
};

const MONSTER_ID_BY_ENGLISH_NAME: Record<string, string> = {
  Sparkmouse: 'sparkmouse', Embertail: 'embertail', Shellback: 'shellback', Thornling: 'thornling',
  Galecoil: 'galecoil', Voltcrest: 'voltcrest', Dazeduck: 'dazeduck', Psyclone: 'psyclone',
};
const ENGLISH_MONSTER_NAME_BY_ID = Object.fromEntries(
  Object.entries(MONSTER_ID_BY_ENGLISH_NAME).map(([name, id]) => [id, name]),
) as Record<string, string>;

const MOVE_NAMES: Record<string, string> = {
  'sparkmouse.jolt': 'Choque Trovejante',
  'sparkmouse.zap': 'Descarga Estática',
  'sparkmouse.quickbite': 'Mordida Rápida',
  'sparkmouse.tackle': 'Investida',
  'embertail.ember': 'Brasa',
  'embertail.flamewhip': 'Chicote de Chamas',
  'embertail.scratch': 'Arranhão',
  'embertail.rockthrow': 'Arremesso de Pedra',
  'shellback.bubble': 'Explosão de Bolhas',
  'shellback.aquapulse': 'Pulso d’Água',
  'shellback.shellslam': 'Pancada de Casco',
  'shellback.tidalcrash': 'Impacto da Maré',
  'thornling.vinelash': 'Chicote de Cipó',
  'thornling.leafstorm': 'Tempestade de Folhas',
  'thornling.tackle': 'Investida',
  'thornling.sap': 'Mordida de Seiva',
  'galecoil.aquatail': 'Cauda d’Água',
  'galecoil.hydroblast': 'Explosão Hídrica',
  'galecoil.thrash': 'Fúria',
  'galecoil.bite': 'Mordida Brutal',
  'voltcrest.thunderbolt': 'Raio',
  'voltcrest.sparkarc': 'Arco de Faíscas',
  'voltcrest.drillpeck': 'Bicada Broca',
  'voltcrest.gust': 'Rajada',
  'dazeduck.watergun': 'Jato d’Água',
  'dazeduck.scald': 'Escaldar',
  'dazeduck.confusion': 'Confusão',
  'dazeduck.headache': 'Cabeçada',
  'psyclone.psystrike': 'Golpe Psíquico',
  'psyclone.psybeam': 'Raio Psíquico',
  'psyclone.mindblast': 'Explosão Mental',
  'psyclone.recover': 'Foco',
};

const MOVE_ID_BY_ENGLISH_NAME: Record<string, string> = {
  'Thunder Jolt': 'sparkmouse.jolt', 'Static Zap': 'sparkmouse.zap', 'Quick Bite': 'sparkmouse.quickbite',
  Ember: 'embertail.ember', 'Flame Whip': 'embertail.flamewhip', Scratch: 'embertail.scratch',
  'Rock Throw': 'embertail.rockthrow', 'Bubble Blast': 'shellback.bubble', 'Aqua Pulse': 'shellback.aquapulse',
  'Shell Slam': 'shellback.shellslam', 'Tidal Crash': 'shellback.tidalcrash', 'Vine Lash': 'thornling.vinelash',
  'Leaf Storm': 'thornling.leafstorm', 'Sap Bite': 'thornling.sap', 'Aqua Tail': 'galecoil.aquatail',
  'Hydro Blast': 'galecoil.hydroblast', Thrash: 'galecoil.thrash', Crunch: 'galecoil.bite',
  Thunderbolt: 'voltcrest.thunderbolt', 'Spark Arc': 'voltcrest.sparkarc', 'Drill Peck': 'voltcrest.drillpeck',
  Gust: 'voltcrest.gust', 'Water Gun': 'dazeduck.watergun', Scald: 'dazeduck.scald',
  Confusion: 'dazeduck.confusion', Headbutt: 'dazeduck.headache', Psystrike: 'psyclone.psystrike',
  Psybeam: 'psyclone.psybeam', 'Mind Blast': 'psyclone.mindblast', Focus: 'psyclone.recover',
  Tackle: 'sparkmouse.tackle',
};
const ENGLISH_MOVE_NAME_BY_ID = Object.fromEntries(
  Object.entries(MOVE_ID_BY_ENGLISH_NAME).map(([name, id]) => [id, name]),
) as Record<string, string>;
ENGLISH_MOVE_NAME_BY_ID['sparkmouse.tackle'] = 'Tackle';
ENGLISH_MOVE_NAME_BY_ID['thornling.tackle'] = 'Tackle';

const FIGHTER_NAMES: Record<string, string> = {
  nyx: 'Nix',
  wraith: 'Espectro',
  'remy-riot': 'Remy Revolta',
  'cinder-capone': 'Brasa Capone',
  'rune-warden': 'Guardião Rúnico',
  'shroom-boom': 'Cogumelo Bomba',
  'gran-slam': 'Vó Pancada',
  'bass-nova': 'Grave Nova',
  'velvet-thunder': 'Trovão de Veludo',
  'iron-oni': 'Oni de Ferro',
  bulkhead: 'Blindado',
  'sir-knockout': 'Sir Nocaute',
};

const FIGHTER_MAP_NAMES: Record<string, string> = {
  foundry: 'Fundição Neon',
  void: 'Circuito do Vazio',
  'cyberpunk-city': 'Cidade Cyberpunk',
  inakaya: 'Restaurante Inakaya',
  rain: 'Chuva',
};

export const gameTitle = (locale: SupportedLocale, id: GameId): string => GAME_TITLES[id][locale];
export const carName = (locale: SupportedLocale, canonicalName: string): string =>
  locale === 'pt-BR'
    ? CAR_NAMES[canonicalName] ?? canonicalName.replace(/^Car (\d+)$/i, 'Carro $1')
    : canonicalName;
export const trackName = (locale: SupportedLocale, canonicalName: string): string =>
  locale === 'pt-BR' ? TRACK_NAMES[canonicalName] ?? canonicalName : canonicalName;
export const monsterName = (locale: SupportedLocale, idOrName: string): string => {
  if (locale !== 'pt-BR') return ENGLISH_MONSTER_NAME_BY_ID[idOrName] ?? idOrName;
  const id = MONSTER_NAMES[idOrName] ? idOrName : MONSTER_ID_BY_ENGLISH_NAME[idOrName];
  return (id && MONSTER_NAMES[id]) || idOrName;
};
export const moveName = (locale: SupportedLocale, idOrName: string): string => {
  if (locale !== 'pt-BR') return ENGLISH_MOVE_NAME_BY_ID[idOrName] ?? idOrName;
  const id = MOVE_NAMES[idOrName] ? idOrName : MOVE_ID_BY_ENGLISH_NAME[idOrName];
  return (id && MOVE_NAMES[id]) || idOrName;
};
export const fighterName = (locale: SupportedLocale, id: string, canonicalName?: string): string =>
  locale === 'pt-BR' ? FIGHTER_NAMES[id] ?? canonicalName ?? id : canonicalName ?? id;
export const fighterMapName = (locale: SupportedLocale, id: string, canonicalName: string): string =>
  locale === 'pt-BR' ? FIGHTER_MAP_NAMES[id] ?? canonicalName : canonicalName;
export const playerName = (locale: SupportedLocale, name: string): string =>
  locale === 'pt-BR' && name === 'You' ? 'Você' : name;

export const localizedCarAliases = (canonicalName: string): string[] =>
  CAR_NAMES[canonicalName] ? [canonicalName, CAR_NAMES[canonicalName]!] : [canonicalName];
export const localizedTrackAliases = (canonicalName: string): string[] =>
  TRACK_NAMES[canonicalName] ? [canonicalName, TRACK_NAMES[canonicalName]!] : [canonicalName];
export const localizedMonsterAliases = (id: string, canonicalName: string): string[] =>
  MONSTER_NAMES[id] ? [ENGLISH_MONSTER_NAME_BY_ID[id] ?? canonicalName, MONSTER_NAMES[id]!] : [canonicalName];
export const localizedMoveAliases = (id: string, canonicalName: string): string[] =>
  MOVE_NAMES[id] ? [ENGLISH_MOVE_NAME_BY_ID[id] ?? canonicalName, MOVE_NAMES[id]!] : [canonicalName];
export const localizedFighterAliases = (id: string, canonicalName: string): string[] =>
  FIGHTER_NAMES[id] ? [canonicalName, FIGHTER_NAMES[id]!] : [canonicalName];
