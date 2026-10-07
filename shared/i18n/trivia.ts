import type { TriviaCategoryId, TriviaRoundCategoryId } from '../trivia';
import type { LocalizedCatalog } from './translate';

const EN_MESSAGES = {
  'voice.roomUnavailable': 'This Voice Trivia room is unavailable. Please wait for the next round.',
  'voice.playerPlaceholder': 'Player',
  'voice.welcome': 'Welcome to Voice Trivia, powered by Twilio Conversation Relay!',
  'voice.askName': 'First, what is your first name?',
  'voice.invalidName': 'Please say only your first name. For example, Ada.',
  'voice.welcomeName': 'Welcome to Voice Trivia, {name}.',
  'voice.returned': 'You are back.',
  'voice.returnedName': 'You are back, {name}.',
  'voice.gameplay': 'I will read each question and its choices, then give everyone the same ten seconds. You can answer early, say skip reading, or interrupt me to ask for a replay.',
  'voice.chooseCategory': 'Choose a category: {categories}, or Mixed.',
  'voice.categoryInfo': '{category} is a trivia category you can vote for on the display. The round has eight questions.',
  'voice.unknownCategory': 'I did not recognize that category. Choose one shown on the display.',
  'voice.categorySelected': '{category} selected.',
  'voice.notReady': 'The room is not ready to start yet.',
  'voice.preparing': 'Preparing the trivia round. Keep watching the display.',
  'voice.loadingTimeout': 'The display did not become ready. Check the display, then choose a category again.',
  'voice.question': 'Question {number}. {prompt}',
  'voice.questionChoices': 'The choices are {choices}.',
  'voice.getReady': 'Get ready. Watch the display for the answer timer.',
  'voice.readingInterrupted': 'I stopped reading. Say repeat, skip reading, or tell me your answer.',
  'voice.answerPrompt': 'Say your answer now.',
  'voice.earlyAnswerAccepted': 'Answer saved. The shared timer starts after everyone is ready.',
  'voice.audioProblem': 'Question audio paused. The answer timer has not started. Please ask the operator to retry.',
  'voice.audioExpired': 'This round ended because question audio could not be recovered. Please ask the operator about another game.',
  'voice.answerResume': 'Answer now. Prefer one through four. You have {seconds} seconds remaining.',
  'voice.answerAccepted': 'Answer locked.',
  'voice.answerUnknown': 'I did not recognize that choice. Say one of the answers shown on the display.',
  'voice.answerTooLate': 'Time is up.',
  'voice.correct': 'Correct! You earned {points} points.',
  'voice.incorrect': 'That answer was not correct.',
  'voice.result': '{name}, your leaderboard score is {score}. You answered {correct} of eight correctly.',
  'voice.stationRequeue': 'Your results are on the display. To play again, check your messages for game coin instructions.',
  'voice.stationResultWinner': '{winner} wins. Your score: {score}; {correct} correct. Results on screen. Check messages for coin instructions to replay.',
  'voice.stationResultTie': "It's a tie. Your score: {score}; {correct} correct. Results on screen. Check messages for coin instructions to replay.",
  'voice.playAgain': 'Your results are on the display. To play again, say Play again.',
} as const;

export type TriviaMessageKey = keyof typeof EN_MESSAGES;

const PT_MESSAGES: Record<TriviaMessageKey, string> = {
  'voice.roomUnavailable': 'Esta sala do Quiz por Voz não está disponível. Aguarde a próxima rodada.',
  'voice.playerPlaceholder': 'Jogador',
  'voice.welcome': 'Boas-vindas ao Quiz por Voz da Twilio Conversation Relay!',
  'voice.askName': 'Primeiro, qual é o seu primeiro nome?',
  'voice.invalidName': 'Diga apenas seu primeiro nome. Por exemplo, Ana.',
  'voice.welcomeName': 'Boas-vindas ao Quiz por Voz, {name}.',
  'voice.returned': 'Você voltou.',
  'voice.returnedName': 'Você voltou, {name}.',
  'voice.gameplay': 'Vou ler cada pergunta e as opções, depois todos terão os mesmos dez segundos. Você pode responder antes, dizer pular leitura ou me interromper para pedir repetição.',
  'voice.chooseCategory': 'Escolha uma categoria: {categories}, ou Misturado.',
  'voice.categoryInfo': '{category} é uma categoria do quiz na qual você pode votar na tela. A rodada tem oito perguntas.',
  'voice.unknownCategory': 'Não reconheci essa categoria. Escolha uma das opções exibidas na tela.',
  'voice.categorySelected': 'Categoria {category} selecionada.',
  'voice.notReady': 'A sala ainda não está pronta para começar.',
  'voice.preparing': 'Preparando a rodada de quiz. Continue olhando para a tela.',
  'voice.loadingTimeout': 'A tela não ficou pronta. Verifique a tela e escolha uma categoria novamente.',
  'voice.question': 'Pergunta {number}. {prompt}',
  'voice.questionChoices': 'As opções são {choices}.',
  'voice.getReady': 'Prepare-se. Olhe para o cronômetro na tela.',
  'voice.readingInterrupted': 'Parei a leitura. Diga repetir, pular leitura ou sua resposta.',
  'voice.answerPrompt': 'Diga sua resposta agora.',
  'voice.earlyAnswerAccepted': 'Resposta guardada. O cronômetro começa quando todos estiverem prontos.',
  'voice.audioProblem': 'O áudio da pergunta está pausado. O cronômetro não começou. Peça ao operador para tentar novamente.',
  'voice.audioExpired': 'Esta rodada terminou porque não foi possível recuperar o áudio da pergunta. Fale com o operador sobre outro jogo.',
  'voice.answerResume': 'Responda agora. Prefira um a quatro. Você tem {seconds} segundos restantes.',
  'voice.answerAccepted': 'Resposta registrada.',
  'voice.answerUnknown': 'Não reconheci essa opção. Diga uma das respostas exibidas na tela.',
  'voice.answerTooLate': 'O tempo acabou.',
  'voice.correct': 'Correto! Você ganhou {points} pontos.',
  'voice.incorrect': 'Essa resposta não está correta.',
  'voice.result': '{name}, sua pontuação no ranking é {score}. Você acertou {correct} de oito perguntas.',
  'voice.stationRequeue': 'Seus resultados estão na tela. Para jogar novamente, veja nas suas mensagens as instruções de moedas do jogo.',
  'voice.stationResultWinner': '{winner} venceu. Pontuação {score}; {correct} acertos. Resultados na tela. Veja as mensagens para obter moedas e jogar novamente.',
  'voice.stationResultTie': 'Empate. Pontuação {score}; {correct} acertos. Resultados na tela. Veja as mensagens para obter moedas e jogar novamente.',
  'voice.playAgain': 'Seus resultados estão na tela. Para jogar novamente, diga Jogar novamente.',
};

export const TRIVIA_MESSAGES: LocalizedCatalog<TriviaMessageKey> = {
  'en-US': EN_MESSAGES,
  'pt-BR': PT_MESSAGES,
};

export const TRIVIA_CATEGORY_LABELS: Record<'en-US' | 'pt-BR', Record<TriviaRoundCategoryId, string>> = {
  'en-US': {
    general: 'General Knowledge', science: 'Science', geography: 'Geography', history: 'History',
    entertainment: 'Entertainment', sports: 'Sports', technology: 'Technology', twilio: 'Twilio', mixed: 'Mixed',
  },
  'pt-BR': {
    general: 'Conhecimentos Gerais', science: 'Ciências', geography: 'Geografia', history: 'História',
    entertainment: 'Entretenimento', sports: 'Esportes', technology: 'Tecnologia', twilio: 'Twilio', mixed: 'Misturado',
  },
};

export const TRIVIA_CATEGORY_ALIASES: Record<'en-US' | 'pt-BR', Record<TriviaRoundCategoryId, readonly string[]>> = {
  'en-US': {
    general: ['general', 'general knowledge'], science: ['science'], geography: ['geography'], history: ['history'],
    entertainment: ['entertainment', 'movies and music'], sports: ['sports'], technology: ['technology', 'tech'],
    twilio: ['twilio'], mixed: ['mixed', 'mix'],
  },
  'pt-BR': {
    general: ['geral', 'conhecimentos gerais'], science: ['ciência', 'ciências'], geography: ['geografia'],
    history: ['história'], entertainment: ['entretenimento', 'filmes e música'], sports: ['esporte', 'esportes'],
    technology: ['tecnologia', 'tecnologia da informação'], twilio: ['twilio'], mixed: ['misturado', 'misto'],
  },
};

// Compile-time guard that keeps the eight content categories represented in labels.
const _categoryLabels: Record<TriviaCategoryId, string> = TRIVIA_CATEGORY_LABELS['en-US'];
void _categoryLabels;
