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
  'voice.gameplay': 'I will ask each question, then start a shared countdown before reading the choices. Answer as soon as you know, or interrupt me to repeat or skip the reading.',
  'voice.chooseCategory': 'Choose a category: {categories}, or Mixed.',
  'voice.categoryInfo': '{category} is a trivia category you can vote for on the display. The round has eight questions.',
  'voice.unknownCategory': 'I did not recognize that category. Choose one shown on the display.',
  'voice.categorySelected': '{category} selected.',
  'voice.notReady': 'The room is not ready to start yet.',
  'voice.waitingDisplay': 'Please wait for the game screen to connect before we start.',
  'voice.preparing': 'Preparing the trivia round. Keep watching the display.',
  'voice.loadingTimeout': 'The display did not become ready. Check the display, then choose a category again.',
  'voice.question': 'Question {number}. {prompt}',
  'voice.questionChoices': 'The choices are {choices}.',
  'voice.getReady': 'The clock is running. Answer when you are ready.',
  'voice.readingInterrupted': 'I stopped reading. Say repeat, skip reading, or tell me your answer.',
  'voice.answerPrompt': 'Say your answer now.',
  'voice.earlyAnswerAccepted': 'Answer saved. The shared clock starts when everyone has heard the question.',
  'voice.audioProblem': 'Question audio needs attention. The round is paused; ask the operator to replay this question.',
  'voice.audioProblemStandalone': 'The question audio stopped, so the round is paused. Ask me to retry this question when you are ready.',
  'voice.audioRetryLimit': 'The question audio still is not working. Hang up and call back to start a fresh round.',
  'voice.audioExpired': 'This round ended because question audio could not be recovered. Please ask the operator about another game.',
  'voice.audioExpiredStandalone': 'This round ended because question audio could not be recovered. Hang up and call back to start a new game.',
  'voice.answerResume': 'You have {seconds} seconds left. Say the answer in your own words or by number.',
  'voice.answerAccepted': 'Answer locked.',
  'voice.answerUnknown': 'I did not recognize that choice. Say one of the answers shown on the display.',
  'voice.answerTooLate': 'Time is up.',
  'voice.correct': 'Correct! You earned {points} points.',
  'voice.incorrect': 'That answer was not correct.',
  'voice.result': '{name}, your leaderboard score is {score}. You answered {correct} of eight correctly.',
  'voice.howItWorks': 'Twilio Conversation Relay transcribed phone answers; Voice Trivia scored them on screen and spoke results.',
  'voice.stationRequeue': 'Check messages for coins to replay.',
  'voice.stationResultWinner': '{winner} wins. Your leaderboard score: {score}; {correct} correct.',
  'voice.stationResultTie': "It's a tie. Your leaderboard score: {score}; {correct} correct.",
  'voice.playAgain': 'Your results are on the display. To play again, say Play again.',
  'voice.replayWaiting': 'Ready for another round. Waiting for the other players.',
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
  'voice.gameplay': 'Vou fazer cada pergunta e iniciar uma contagem regressiva compartilhada antes de ler as opções. Responda assim que souber ou me interrompa para repetir ou pular a leitura.',
  'voice.chooseCategory': 'Escolha uma categoria: {categories}, ou Misturado.',
  'voice.categoryInfo': '{category} é uma categoria do quiz na qual você pode votar na tela. A rodada tem oito perguntas.',
  'voice.unknownCategory': 'Não reconheci essa categoria. Escolha uma das opções exibidas na tela.',
  'voice.categorySelected': 'Categoria {category} selecionada.',
  'voice.notReady': 'A sala ainda não está pronta para começar.',
  'voice.waitingDisplay': 'Aguarde a tela do jogo se conectar antes de começarmos.',
  'voice.preparing': 'Preparando a rodada de quiz. Continue olhando para a tela.',
  'voice.loadingTimeout': 'A tela não ficou pronta. Verifique a tela e escolha uma categoria novamente.',
  'voice.question': 'Pergunta {number}. {prompt}',
  'voice.questionChoices': 'As opções são {choices}.',
  'voice.getReady': 'O cronômetro começou. Responda quando quiser.',
  'voice.readingInterrupted': 'Parei a leitura. Diga repetir, pular leitura ou sua resposta.',
  'voice.answerPrompt': 'Diga sua resposta agora.',
  'voice.earlyAnswerAccepted': 'Resposta guardada. O cronômetro começa quando todos ouvirem a pergunta.',
  'voice.audioProblem': 'O áudio da pergunta precisa de atenção. A rodada está pausada; peça ao operador para repetir esta pergunta.',
  'voice.audioProblemStandalone': 'O áudio da pergunta parou, então a rodada está pausada. Peça para eu repetir esta pergunta quando quiser.',
  'voice.audioRetryLimit': 'O áudio da pergunta ainda não funciona. Desligue e ligue novamente para começar outra rodada.',
  'voice.audioExpired': 'Esta rodada terminou porque não foi possível recuperar o áudio da pergunta. Fale com o operador sobre outro jogo.',
  'voice.audioExpiredStandalone': 'Esta rodada terminou porque não foi possível recuperar o áudio da pergunta. Desligue e ligue novamente para começar um novo jogo.',
  'voice.answerResume': 'Você tem {seconds} segundos. Diga a resposta do seu jeito ou pelo número.',
  'voice.answerAccepted': 'Resposta registrada.',
  'voice.answerUnknown': 'Não reconheci essa opção. Diga uma das respostas exibidas na tela.',
  'voice.answerTooLate': 'O tempo acabou.',
  'voice.correct': 'Correto! Você ganhou {points} pontos.',
  'voice.incorrect': 'Essa resposta não está correta.',
  'voice.result': '{name}, sua pontuação no ranking é {score}. Você acertou {correct} de oito perguntas.',
  'voice.howItWorks': 'Twilio Conversation Relay transcreve, pontua na tela e narra.',
  'voice.stationRequeue': 'Moedas no SMS. Jogue de novo.',
  'voice.stationResultWinner': '{winner} venceu. Sua pontuação no ranking: {score}; {correct} acertos.',
  'voice.stationResultTie': 'Empate. Sua pontuação no ranking: {score}; {correct} acertos.',
  'voice.playAgain': 'Seus resultados estão na tela. Para jogar novamente, diga Jogar novamente.',
  'voice.replayWaiting': 'Pronto para outra rodada. Aguardando os outros jogadores.',
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
