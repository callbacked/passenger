import type AVPlayer from '@libmedia/avplayer';
import type { PlaybackSource } from './api.ts';

const WASM_ROOT = '/vendor/avplayer/wasm';
const DECODERS = new Map<number, string>([
  [27, 'h264'],
  [86018, 'aac'],
  [167, 'vp9'],
  [86076, 'opus'],
]);
const EXTENSIONS: Record<PlaybackSource['type'], string> = { mp4: 'mp4', hls: 'm3u8' };
let audioPrepared = false;

function getWasm(type: 'decoder' | 'resampler' | 'stretchpitcher', codecId?: number): string {
  if (type === 'resampler') return `${WASM_ROOT}/resample/resample.wasm`;
  if (type === 'stretchpitcher') return `${WASM_ROOT}/stretchpitch/stretchpitch.wasm`;
  const decoder = codecId === undefined ? undefined : DECODERS.get(codecId);
  if (type !== 'decoder' || !decoder) {
    throw new Error('This video uses a codec that this player does not support yet. Try another video.');
  }
  return `${WASM_ROOT}/decode/${decoder}.wasm`;
}

export function prepareAudio(): void {
  // Creating the shared audio context inside the Watch gesture preserves autoplay permission.
  if (!audioPrepared && typeof window.AVPlayer?.startAudioContext === 'function') {
    audioPrepared = true;
    window.AVPlayer.startAudioContext().catch(() => { audioPrepared = false; });
  }
}

export function playbackError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/webassembly|wasm|compileerror|memory|webgl/i.test(message)) {
    return 'This browser could not start the video decoder. Open Browser check for compatibility details.';
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return 'The video connection was interrupted. Check your connection and try Watch again.';
  }
  return message || 'The video could not be played. Try another video or open Browser check.';
}

export interface AudioTrackInfo {
  id: number;
  label: string;
  language: string;
  selected: boolean;
}

export interface AudioTracksPayload {
  tracks: AudioTrackInfo[];
  selectedId: number | null;
}

export interface PlayerReadyInfo {
  duration: number;
  isLive: boolean;
}

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface PlayerCallbacks {
  audioTracks?: (info: AudioTracksPayload) => void;
  seeking?: (seeking: boolean) => void;
  ready: (info: PlayerReadyInfo) => void;
  state: (state: PlaybackState) => void;
  firstFrame: () => void;
  buffering: (buffering: boolean) => void;
  time: (seconds: number) => void;
  audioBlocked: () => void;
  audioReady: () => void;
  error: (error: unknown) => void;
}

export class CanvasPlayer {
  private active: boolean;
  private audioTracks: AudioTrackInfo[];
  private selectedAudioTrack: number | null;
  private callbacks: PlayerCallbacks;
  private mount: HTMLDivElement;
  private player: AVPlayer;
  private seeking = false;
  private switchingAudio = false;
  private resize: () => void;
  private observer?: ResizeObserver;
  private loadTimeout?: number;
  private frameTimeout?: number;
  private destroying?: Promise<void>;

  constructor(container: HTMLElement, callbacks: PlayerCallbacks) {
    if (typeof window.AVPlayer !== 'function') {
      throw new Error('The video player did not load. Refresh the page and try again.');
    }
    if (typeof WebAssembly !== 'object' || typeof BigInt !== 'function') {
      throw new Error('This browser cannot run the video player. Open Browser check for compatibility details.');
    }
    this.active = true;
    this.audioTracks = [];
    this.selectedAudioTrack = null;
    this.callbacks = callbacks;
    this.mount = document.createElement('div');
    container.append(this.mount);
    try {
      this.player = new window.AVPlayer({
        container: this.mount,
        getWasm,
        enableWebCodecs: false,
        enableWebGPU: false,
        enableWorker: false,
        checkUseMSE: () => false,
      });
    } catch (error) {
      this.mount.remove();
      throw error;
    }
    // Wraps a player event listener so it never fires after this wrapper is destroyed.
    const whenActive = <F extends (...args: never[]) => void>(callback: F): F => (
      ((...args: Parameters<F>) => {
        if (this.active) callback(...args);
      }) as F
    );
    this.player.on('playing', whenActive(() => callbacks.buffering(true)));
    this.player.on('played', whenActive(() => {
      callbacks.buffering(false);
      callbacks.state('playing');
    }));
    this.player.on('paused', whenActive(() => callbacks.state('paused')));
    this.player.on('ended', whenActive(() => callbacks.state('ended')));
    this.player.on('seeking', whenActive(() => {
      this.seeking = true;
      callbacks.seeking?.(true);
      callbacks.buffering(true);
    }));
    this.player.on('seeked', whenActive(() => {
      this.seeking = false;
      callbacks.seeking?.(false);
      callbacks.buffering(false);
    }));
    this.player.on('firstVideoRendered', whenActive(() => {
      window.clearTimeout(this.frameTimeout);
      callbacks.firstFrame();
    }));
    this.player.on('time', whenActive((milliseconds: bigint) => callbacks.time(Math.max(0, Number(milliseconds) / 1000))));
    this.player.on('error', whenActive((error: Error) => callbacks.error(new Error(playbackError(error)))));
    this.player.on('timeout', whenActive(() => callbacks.error(new Error('The stream stopped responding. Try Watch again.'))));
    this.player.on('audioContextRunning', whenActive(() => callbacks.audioReady()));
    this.player.on('resume', whenActive(() => callbacks.audioBlocked()));
    this.resize = () => {
      if (!this.active) return;
      const { width, height } = this.mount.getBoundingClientRect();
      if (width && height) this.player.resize(width, height);
    };
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(this.resize);
      this.observer.observe(this.mount);
    } else {
      window.addEventListener('resize', this.resize);
    }
  }

  async open(source: PlaybackSource, volume: number): Promise<void> {
    const extension = EXTENSIONS[source.type];
    if (!extension) throw new Error('This video format is not supported yet.');
    const stream = new URL(source.streamUrl, window.location.origin);
    if (stream.origin !== window.location.origin || !['http:', 'https:'].includes(stream.protocol)) {
      throw new Error('The video service returned an invalid stream link.');
    }
    const timeout = new Promise<never>((_, reject) => {
      this.loadTimeout = window.setTimeout(() => reject(new Error('This video is taking too long to load. Try Watch again.')), 45000);
    });
    try {
      await Promise.race([
        this.player.load(stream.href, {
          ext: extension,
          isLive: source.live === true || source.provider === 'twitch',
          http: { credentials: 'same-origin' },
          ioLoaderOptions: {
            preferVideoCodec: 'avc1',
            preferAudioCodec: 'mp4a.40.2',
            preferResolution: '854*480',
          },
        }),
        timeout,
      ]);
      if (!this.active) return;
      await this.updateAudioTracks();
      if (!this.active) return;
      const duration = Number(this.player.getDuration()) / 1000;
      this.callbacks.ready({
        duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
        isLive: this.player.isLive(),
      });
      this.player.setVolume(volume);
      this.resize();
      this.frameTimeout = window.setTimeout(() => {
        if (this.active) this.callbacks.error(new Error('The video did not begin playing. Try Watch again or open Browser check.'));
      }, 30000);
      await this.player.play();
      if (this.active && this.player.isSuspended()) this.callbacks.audioBlocked();
    } finally {
      window.clearTimeout(this.loadTimeout);
    }
  }

  async play(): Promise<void> {
    if (!this.active) return;
    await this.player.resume();
    if (!this.active) return;
    await this.player.play();
    if (!this.active) return;
    if (this.player.isSuspended()) this.callbacks.audioBlocked();
    else this.callbacks.audioReady();
  }

  async resumeAudio(): Promise<void> {
    if (!this.active) return;
    await this.player.resume();
    if (!this.active) return;
    if (this.player.isSuspended()) this.callbacks.audioBlocked();
    else this.callbacks.audioReady();
  }

  async pause(): Promise<void> {
    if (this.active) await this.player.pause();
  }

  async seek(seconds: number): Promise<void> {
    if (this.active && Number.isFinite(seconds) && seconds >= 0) {
      await this.player.seek(BigInt(Math.round(seconds * 1000)));
    }
  }

  async updateAudioTracks(): Promise<void> {
    const audio = await this.player.getAudioList();
    if (!this.active) return;
    this.selectedAudioTrack = audio?.list?.length ? audio.selectedIndex : null;
    this.audioTracks = (audio?.list || []).map((track, id) => {
      const language = typeof track.lang === 'string' ? track.lang : '';
      // HLS exposes the rendition's human-readable NAME in libmedia's codec field.
      let label = typeof track.codec === 'string' ? track.codec.trim() : '';
      if (!label && language) {
        try { label = new Intl.DisplayNames(['en'], { type: 'language' }).of(language) || ''; }
        catch { label = language; }
      }
      return { id, label: label || `Audio ${id + 1}`, language, selected: id === this.selectedAudioTrack };
    });
    this.callbacks.audioTracks?.({ tracks: this.audioTracks, selectedId: this.selectedAudioTrack });
  }

  async selectAudioTrack(id: number): Promise<void> {
    if (!this.active || id === this.selectedAudioTrack) return;
    if (this.seeking) throw new Error('Wait for seeking to finish before changing the audio language.');
    if (!Number.isInteger(id) || !this.audioTracks.some(track => track.id === id)) {
      throw new Error('That audio language is no longer available.');
    }
    if (this.switchingAudio) return;
    this.switchingAudio = true;
    this.callbacks.buffering(true);
    try {
      // VOD switches immediately at the current position; live switches at a segment boundary.
      await this.player.selectAudio(id, this.player.isLive());
      if (!this.active) return;
      await this.updateAudioTracks();
      if (this.selectedAudioTrack !== id) throw new Error('The audio language could not be changed. Try again.');
    } finally {
      this.switchingAudio = false;
      if (this.active) this.callbacks.buffering(false);
    }
  }

  setVolume(volume: number): void {
    if (this.active) this.player.setVolume(Math.max(0, Math.min(1, volume)));
  }

  destroy(): Promise<void> {
    if (this.destroying) return this.destroying;
    this.active = false;
    window.clearTimeout(this.loadTimeout);
    window.clearTimeout(this.frameTimeout);
    this.observer?.disconnect();
    window.removeEventListener('resize', this.resize);
    this.player.setVolume(0, true);
    this.mount.remove();
    this.destroying = this.player.destroy();
    return this.destroying;
  }
}
