import { Track, PlaybackState } from "../types";

export type PlaybackUpdateListener = (state: PlaybackState) => void;

class MusicControlCenterClass {
  private state: PlaybackState = {
    isPlaying: false,
    currentTrack: null,
    progress: 0,
    volume: 80,
    isMuted: false,
    isShuffle: false,
    isRepeat: false,
    playlist: [],
    currentIndex: -1,
    provider: "youtube"
  };

  private listeners: Set<PlaybackUpdateListener> = new Set();

  // Adapters registered by the actual active player component (e.g. YouTube Iframe player)
  private onPlayHandler: ((track: Track) => void) | null = null;
  private onPauseHandler: (() => void) | null = null;
  private onResumeHandler: (() => void) | null = null;
  private onSeekHandler: ((seconds: number) => void) | null = null;
  private onVolumeHandler: ((level: number) => void) | null = null;

  registerPlayer(adapters: {
    play: (track: Track) => void;
    pause: () => void;
    resume: () => void;
    seek: (seconds: number) => void;
    setVolume: (level: number) => void;
  }) {
    this.onPlayHandler = adapters.play;
    this.onPauseHandler = adapters.pause;
    this.onResumeHandler = adapters.resume;
    this.onSeekHandler = adapters.seek;
    this.onVolumeHandler = adapters.setVolume;
  }

  getState(): PlaybackState {
    return this.state;
  }

  subscribe(listener: PlaybackUpdateListener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  updateState(newState: Partial<PlaybackState>) {
    this.state = { ...this.state, ...newState };
    this.listeners.forEach((listener) => listener(this.state));
  }

  // Actions called by Gemini tool calls or user clicks
  play(track: Track, list: Track[] = []) {
    if (list.length > 0) {
      const idx = list.findIndex(t => t.id === track.id);
      this.updateState({
        playlist: list,
        currentIndex: idx >= 0 ? idx : 0,
        currentTrack: track,
        isPlaying: true,
        progress: 0,
        provider: track.spotifyUri ? "spotify" : "youtube"
      });
    } else {
      const existingIdx = this.state.playlist.findIndex(t => t.id === track.id);
      let newPlaylist = [...this.state.playlist];
      let newIdx = existingIdx;
      if (existingIdx === -1) {
        newPlaylist.push(track);
        newIdx = newPlaylist.length - 1;
      }
      this.updateState({
        playlist: newPlaylist,
        currentIndex: newIdx,
        currentTrack: track,
        isPlaying: true,
        progress: 0,
        provider: track.spotifyUri ? "spotify" : "youtube"
      });
    }

    if (this.onPlayHandler) {
      try {
        this.onPlayHandler(track);
      } catch (err) {
        console.error("Player failed to start track:", err);
      }
    }
  }

  pause() {
    this.updateState({ isPlaying: false });
    if (this.onPauseHandler) {
      this.onPauseHandler();
    }
  }

  resume() {
    if (!this.state.currentTrack && this.state.playlist.length > 0) {
      this.play(this.state.playlist[0]);
      return;
    }
    if (this.state.currentTrack) {
      this.updateState({ isPlaying: true });
      if (this.onResumeHandler) {
        this.onResumeHandler();
      }
    }
  }

  next() {
    if (this.state.playlist.length === 0) return;
    let nextIdx = this.state.currentIndex + 1;
    if (this.state.isShuffle) {
      nextIdx = Math.floor(Math.random() * this.state.playlist.length);
    } else if (nextIdx >= this.state.playlist.length) {
      nextIdx = this.state.isRepeat ? 0 : this.state.playlist.length - 1;
    }
    
    if (nextIdx < this.state.playlist.length) {
      this.play(this.state.playlist[nextIdx]);
    }
  }

  previous() {
    if (this.state.playlist.length === 0) return;
    let prevIdx = this.state.currentIndex - 1;
    if (prevIdx < 0) {
      prevIdx = this.state.isRepeat ? this.state.playlist.length - 1 : 0;
    }
    this.play(this.state.playlist[prevIdx]);
  }

  setVolume(level: number) {
    const vol = Math.max(0, Math.min(100, level));
    this.updateState({ volume: vol, isMuted: vol === 0 });
    if (this.onVolumeHandler) {
      this.onVolumeHandler(vol);
    }
  }

  toggleMute() {
    const muted = !this.state.isMuted;
    this.updateState({ isMuted: muted });
    if (this.onVolumeHandler) {
      this.onVolumeHandler(muted ? 0 : this.state.volume);
    }
  }

  toggleShuffle() {
    this.updateState({ isShuffle: !this.state.isShuffle });
  }

  toggleRepeat() {
    this.updateState({ isRepeat: !this.state.isRepeat });
  }

  seek(seconds: number) {
    if (this.onSeekHandler) {
      this.onSeekHandler(seconds);
    }
  }
}

export const MusicControlCenter = new MusicControlCenterClass();
