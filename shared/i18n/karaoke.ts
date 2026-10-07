import type { LocalizedCatalog } from './translate';

const EN_MESSAGES = {
  'voice.roomUnavailable': 'This Voice Karaoke room is unavailable. Please wait for the next song.',
  'voice.callerPlaceholder': 'Singer',
  'voice.welcome': 'Welcome to Voice Karaoke, powered by Twilio Conversation Relay!',
  'voice.askName': 'First, what is your first name?',
  'voice.invalidName': 'Please say only your first name. For example, Ada.',
  'voice.welcomeName': 'Welcome to Voice Karaoke, {name}.',
  'voice.returned': 'You are back.',
  'voice.returnedName': 'You are back, {name}.',
  'voice.gameplay': 'Choose a song by number or title, say Start, then watch the display and sing each word when it reaches the target.',
  'voice.catalog': 'Available songs: {songs}. Say a song number or title.',
  'voice.noSongs': 'There are no songs available in your language right now.',
  'voice.unknownSong': 'I did not recognize that song. Say a song number or title from the display.',
  'voice.songSelected': '{title} selected.',
  'voice.startRequired': 'Your song is {title}.',
  'voice.startConsent': 'With scoring, your live voice goes to a third-party speech recognition service. Say Start anytime to consent and sing.',
  'voice.scoringInfo': 'Scoring sends your live voice to a third-party speech recognition service. You do not have to wait for me. After choosing a song, say Start or press the pound key whenever you are ready to consent and sing.',
  'voice.songInfo': 'In this game, {title} lasts {seconds} seconds. Say its title or number when you want to choose it.',
  'voice.chooseFirst': 'Choose a song before saying start.',
  'voice.notReady': 'The room is not ready to start yet.',
  'voice.preparing': 'Preparing your backing track. Keep watching the display.',
  'voice.loadingTimeout': 'The backing track did not become ready. Please check the display audio, then say Start to try again.',
  'voice.result': '{name}, your score is {score}, with a best combo of {combo}.',
  'voice.stationResult': 'Score {score}, best combo {combo}. Results on screen. Check your messages for coin instructions to replay.',
  'voice.singAgain': 'Your results are on the display. To sing again, say Choose another song.',
} as const;

export type KaraokeMessageKey = keyof typeof EN_MESSAGES;

const PT_MESSAGES: Record<KaraokeMessageKey, string> = {
  'voice.roomUnavailable': 'Esta sala do Karaokê por Voz não está disponível. Aguarde a próxima música.',
  'voice.callerPlaceholder': 'Cantor',
  'voice.welcome': 'Boas-vindas ao Karaokê por Voz, com Twilio Conversation Relay!',
  'voice.askName': 'Primeiro, qual é o seu primeiro nome?',
  'voice.invalidName': 'Diga apenas seu primeiro nome. Por exemplo, Ana.',
  'voice.welcomeName': 'Boas-vindas ao Karaokê por Voz, {name}.',
  'voice.returned': 'Você voltou.',
  'voice.returnedName': 'Você voltou, {name}.',
  'voice.gameplay': 'Escolha uma música pelo número ou título, diga Começar, depois olhe para a tela e cante cada palavra quando ela chegar ao alvo.',
  'voice.catalog': 'Músicas disponíveis: {songs}. Diga o número ou o título de uma música.',
  'voice.noSongs': 'Não há músicas disponíveis no seu idioma agora.',
  'voice.unknownSong': 'Não reconheci essa música. Diga um número ou título exibido na tela.',
  'voice.songSelected': '{title} selecionada.',
  'voice.startRequired': 'Sua música é {title}.',
  'voice.startConsent': 'Com a pontuação, sua voz ao vivo vai para um serviço terceirizado de reconhecimento de fala. Diga Começar a qualquer momento para consentir e cantar.',
  'voice.scoringInfo': 'A pontuação envia sua voz ao vivo a um serviço terceirizado de reconhecimento de fala. Você não precisa esperar eu terminar. Depois de escolher uma música, diga Começar ou aperte a tecla cerquilha quando quiser consentir e cantar.',
  'voice.songInfo': 'Neste jogo, {title} dura {seconds} segundos. Diga o título ou o número quando quiser escolhê-la.',
  'voice.chooseFirst': 'Escolha uma música antes de dizer começar.',
  'voice.notReady': 'A sala ainda não está pronta para começar.',
  'voice.preparing': 'Preparando sua faixa de apoio. Continue olhando para a tela.',
  'voice.loadingTimeout': 'A faixa de apoio não ficou pronta. Verifique o áudio da tela e diga Começar para tentar novamente.',
  'voice.result': '{name}, sua pontuação é {score}, com melhor combo de {combo}.',
  'voice.stationResult': 'Pontuação {score}, melhor combo {combo}. Resultados na tela. Veja nas mensagens como conseguir moedas para jogar novamente.',
  'voice.singAgain': 'Seus resultados estão na tela. Para cantar novamente, diga Escolher outra música.',
};

export const KARAOKE_MESSAGES: LocalizedCatalog<KaraokeMessageKey> = {
  'en-US': EN_MESSAGES,
  'pt-BR': PT_MESSAGES,
};
