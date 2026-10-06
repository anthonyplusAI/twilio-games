/**
 * Music Manager: Handles music playback for different game states.
 * Features:
 * - Auto-play next track when multiple tracks exist
 * - Continuous loop playback
 * - Dynamic switching between game contexts
 */

export type GameContext = 'lobby' | 'racer' | 'monsters' | 'fighter' | 'fighter-victory' | 'leaderboard' | 'chess';

const MUTE_STORAGE_KEY = 'twilio-games-music-muted';

interface MusicContext {
  tracks: string[];
  currentTrackIndex: number;
  loop?: boolean;
}

export class MusicManager {
  private audio: HTMLAudioElement;
  private contexts: Record<GameContext, MusicContext> = {
    lobby: {
      tracks: ['/audio/lobby/velvet-arrival.mp3'],
      currentTrackIndex: 0,
    },
    racer: {
      tracks: ['/audio/racer/midnight-apex.m4a', '/audio/racer/red-light-to-green.mp3'],
      currentTrackIndex: 0,
    },
    monsters: {
      tracks: ['/audio/monsters/hero-final-gambit.mp3', '/audio/monsters/one-last-gold-coin.mp3'],
      currentTrackIndex: 0,
    },
    fighter: {
      tracks: ['/audio/fighter/music/break-the-guard.mp3'],
      currentTrackIndex: 0,
    },
    'fighter-victory': {
      tracks: ['/audio/fighter/music/victory.mp3'],
      currentTrackIndex: 0,
      loop: false,
    },
    leaderboard: {
      tracks: ['/audio/leaderboard/final-ascent.mp3'],
      currentTrackIndex: 0,
    },
    chess: {
      tracks: ['/audio/chess/the-marble-gambit.mp3'],
      currentTrackIndex: 0,
    },
  };

  private currentContext: GameContext | null = null;
  private isPlaying = false;
  private volume = 0.7;
  private isMuted = loadMutedPreference();

  constructor() {
    this.audio = new Audio();
    this.applyAudioMuteState();
    this.audio.addEventListener('ended', () => this.onTrackEnded());
    this.audio.addEventListener('error', (e) => console.error('Audio error:', e));
  }

  /**
   * Switch to a different game context and start playing music
   */
  switchContext(context: GameContext) {
    if (this.currentContext === context && this.isPlaying) {
      return; // Already playing this context
    }

    this.currentContext = context;
    const contextData = this.contexts[context];
    contextData.currentTrackIndex = 0;

    const track = contextData.tracks[0];
    if (track) {
      this.playTrack(track);
      this.isPlaying = true;
    }
  }

  /**
   * Play a specific track
   */
  private playTrack(trackPath: string) {
    this.syncMutedPreference();
    this.audio.src = trackPath;
    this.audio.volume = this.volume;
    this.audio.muted = this.isMuted;
    if (this.isMuted) return;
    this.audio.play().catch((err: unknown) => {
      if ((err as { name?: string } | null)?.name !== 'NotAllowedError') console.error('Failed to play track:', err);
    });
  }

  /**
   * Handle track ending - auto-play next track or loop
   */
  private onTrackEnded() {
    if (!this.currentContext) return;

    const contextData = this.contexts[this.currentContext];
    if (contextData.loop === false) {
      this.isPlaying = false;
      return;
    }
    const tracks = contextData.tracks;

    // Move to next track
    contextData.currentTrackIndex = (contextData.currentTrackIndex + 1) % tracks.length;

    // Play the next track (or loop back to first if we've reached the end)
    const nextTrack = tracks[contextData.currentTrackIndex];
    if (nextTrack) {
      this.playTrack(nextTrack);
    }
  }

  /**
   * Pause music
   */
  pause() {
    this.audio.pause();
    this.isPlaying = false;
  }

  /**
   * Resume music
   */
  resume() {
    this.isPlaying = true;
    this.syncMutedPreference();
    if (this.isMuted) return;
    this.audio.play().catch((err) => console.error('Failed to resume playback:', err));
  }

  /**
   * Stop music
   */
  stop() {
    this.audio.pause();
    this.audio.currentTime = 0;
    this.isPlaying = false;
  }

  /**
   * Set volume (0 to 1)
   */
  setVolume(volume: number) {
    this.volume = Math.max(0, Math.min(1, volume));
    this.audio.volume = this.volume;
  }

  /**
   * Get current volume
   */
  getVolume(): number {
    return this.volume;
  }

  /**
   * Check if music is currently playing
   */
  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  /** Whether the current track is actually audible (browser autoplay may have blocked it). */
  getIsAudible(): boolean {
    return !this.audio.paused && !this.audio.muted;
  }

  /** Retry playback from a click or key press so browsers can unlock audio. */
  async playFromGesture(): Promise<boolean> {
    this.syncMutedPreference();
    if (this.isMuted) return false;
    this.isPlaying = true;
    try {
      await this.audio.play();
      return !this.audio.paused;
    } catch {
      return false;
    }
  }

  /**
   * Get current context
   */
  getCurrentContext(): GameContext | null {
    return this.currentContext;
  }

  /**
   * Toggle mute/unmute
   */
  toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    saveMutedPreference(this.isMuted);
    this.applyAudioMuteState();
    if (!this.isMuted && this.isPlaying) {
      this.audio.play().catch((err) => console.error('Failed to resume playback:', err));
    }
    return this.isMuted;
  }

  /**
   * Mute music
   */
  mute(): void {
    if (!this.isMuted) {
      this.isMuted = true;
      saveMutedPreference(this.isMuted);
      this.applyAudioMuteState();
    }
  }

  /**
   * Unmute music
   */
  unmute(): void {
    if (this.isMuted) {
      this.isMuted = false;
      saveMutedPreference(this.isMuted);
      this.applyAudioMuteState();
      if (this.isPlaying) {
        this.audio.play().catch((err) => console.error('Failed to resume playback:', err));
      }
    }
  }

  /**
   * Get mute state
   */
  getIsMuted(): boolean {
    this.syncMutedPreference();
    return this.isMuted;
  }

  private syncMutedPreference(): void {
    const persistedMuted = loadMutedPreference();
    if (persistedMuted === this.isMuted) return;
    this.isMuted = persistedMuted;
    this.applyAudioMuteState();
  }

  private applyAudioMuteState(): void {
    this.audio.muted = this.isMuted;
    if (this.isMuted) this.audio.pause();
  }
}

function loadMutedPreference(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(MUTE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveMutedPreference(isMuted: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(MUTE_STORAGE_KEY, String(isMuted));
  } catch {
    // Private browsing or storage policy failures should not break audio controls.
  }
}

// Singleton instance
let musicManager: MusicManager | null = null;

/**
 * Get the global music manager instance
 */
export function getMusicManager(): MusicManager {
  if (!musicManager) {
    musicManager = new MusicManager();
  }
  return musicManager;
}
