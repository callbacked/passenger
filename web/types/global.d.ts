import type AVPlayer from '@libmedia/avplayer';

declare global {
  interface Window {
    AVPlayer: typeof AVPlayer;
  }
}
export {};
