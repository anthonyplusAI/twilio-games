import { applyDocumentLocale, locale } from '../i18n';
import { wireThemeToggle } from '../theme';

const messages = {
  'en-US': {
    pageTitle: 'How to play | Twilio Games', homeAria: 'Back to Twilio Games',
    heroEyebrow: 'Voice-controlled experience', heroTitle: 'Use your voice to play.',
    heroBody: 'Choose a game on the screen, call from your phone, and follow the spoken prompts.',
    touchTitle: 'The screen responds to touch.', touchBody: 'Tap a game to begin.',
    stepsEyebrow: 'Step by step', stepsTitle: 'Get started',
    step1Title: 'Start a game', step1Body: 'Tap a game on the main screen to begin.',
    step2Title: 'Follow the screen', step2Body: 'The game shows a QR code when it is ready.',
    step3Title: 'Scan the QR code', step3Body: 'Use your phone camera to open the call link.',
    step4Title: 'Make the call', step4Body: 'Tap Call and stay on the line while you play.',
    step5Title: 'Listen to the voice guide', step5Body: 'It may ask for your first name and explain what to do next.',
    step6Title: 'Say your moves aloud', step6Body: 'Use voice commands for the game you chose.',
    footerNote: 'Watch the shared screen for your turn.', powered: 'Powered by Twilio Conversation Relay',
    lightTheme: 'Light theme', darkTheme: 'Dark theme',
  },
  'pt-BR': {
    pageTitle: 'Como jogar | Twilio Games', homeAria: 'Voltar para Twilio Games',
    heroEyebrow: 'Experiência controlada por voz', heroTitle: 'Use sua voz para jogar.',
    heroBody: 'Escolha um jogo na tela, ligue pelo celular e siga as orientações por voz.',
    touchTitle: 'A tela é sensível ao toque.', touchBody: 'Toque em um jogo para começar.',
    stepsEyebrow: 'Passo a passo', stepsTitle: 'Como começar',
    step1Title: 'Inicie o jogo', step1Body: 'Toque em um jogo na tela principal para começar.',
    step2Title: 'Siga as instruções na tela', step2Body: 'O jogo mostrará um código QR quando estiver pronto.',
    step3Title: 'Escaneie o código QR', step3Body: 'Use a câmera do seu celular para abrir o link da ligação.',
    step4Title: 'Faça a ligação', step4Body: 'Toque em ligar e permaneça na chamada durante toda a partida.',
    step5Title: 'Ouça as orientações por voz', step5Body: 'O guia pode pedir seu primeiro nome e explicar o próximo passo.',
    step6Title: 'Fale os comandos em voz alta', step6Body: 'Use os comandos por voz do jogo que você escolheu.',
    footerNote: 'Acompanhe sua vez na tela compartilhada.', powered: 'Com tecnologia Twilio Conversation Relay',
    lightTheme: 'Tema claro', darkTheme: 'Tema escuro',
  },
} as const;

const copy = messages[locale];
applyDocumentLocale();
document.title = copy.pageTitle;
for (const element of document.querySelectorAll<HTMLElement>('[data-copy]')) {
  const key = element.dataset.copy as keyof typeof copy;
  if (key in copy) element.textContent = copy[key];
}
document.querySelector<HTMLAnchorElement>('.instructions-brand')?.setAttribute('aria-label', copy.homeAria);
wireThemeToggle(document.getElementById('themeToggle')!, {
  light: copy.lightTheme,
  dark: copy.darkTheme,
});
