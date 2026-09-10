import { CanvasPlayer, playbackError, prepareAudio } from './player.ts';
import type { AudioTrackInfo, AudioTracksPayload, PlaybackState } from './player.ts';
import { initAccount, fetchAccountFeed } from './account.ts';
import type { AccountState, HealthResponse, PlaybackSource, ProviderId, SearchResponse, ShortsResponse, VideoSummary } from './api.ts';

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}.`);
  return element as T;
}

/** Throwing querySelector scoped to a parent, for markup this file creates and controls itself. */
function requireQuery<T extends Element = HTMLElement>(scope: ParentNode, selector: string): T {
  const found = scope.querySelector<T>(selector);
  if (!found) throw new Error(`Expected an element matching "${selector}".`);
  return found;
}

function requireFirstElementChild<T extends Element = Element>(parent: Element): T {
  const child = parent.firstElementChild;
  if (!child) throw new Error('Expected element to have a child element.');
  return child as T;
}

function isProviderId(value: string | undefined): value is ProviderId {
  return value === 'youtube' || value === 'twitch';
}

type AccountFeedName = 'home' | 'subscriptions' | 'liked';

function isAccountFeedName(value: string | undefined): value is AccountFeedName {
  return value === 'home' || value === 'subscriptions' || value === 'liked';
}

const ui = {
  form: $<HTMLFormElement>('source-form'), input: $<HTMLInputElement>('source-input'), hint: $('source-hint'), label: $('source-label'),
  note: $('source-note'), card: $('player-card'), mount: $('player-mount'), loading: $('player-loading'),
  placeholder: $('player-placeholder'), placeholderTitle: $('placeholder-title'), placeholderCopy: $('placeholder-copy'),
  title: $('media-title'), kicker: $('player-kicker'), status: $('playback-status'), live: $('live-badge'),
  pause: $<HTMLButtonElement>('pause-button'), pauseLabel: $('pause-label'), pauseIcon: requireFirstElementChild($('pause-icon')),
  stop: $<HTMLButtonElement>('stop-button'), mute: $<HTMLButtonElement>('mute-button'), volume: $<HTMLInputElement>('volume-control'), fullscreen: $<HTMLButtonElement>('fullscreen-button'),
  seekRow: $('seek-row'), seek: $<HTMLInputElement>('seek-control'), current: $('current-time'), duration: $('duration'),
  recents: $('recent-list'), recentSection: $('recent-section'),
  searchSection: $('search-section'), searchResults: $('search-results'), searchStatus: $('search-status'),
  browseTitle: $('browse-title'), browseDescription: $('browse-description'), browseProvider: $('browse-provider'),
  filters: $('topic-filters'), empty: $('browse-empty'),
};

interface ProviderConfig {
  name: string;
  label: string;
  placeholder: string;
  hint: string;
  note: string;
}

const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  youtube: { name: 'YouTube', label: 'Search YouTube or paste a link', placeholder: 'Search YouTube or paste a link', hint: 'Search for a video or paste a YouTube link.', note: 'YouTube · Public videos' },
  twitch: { name: 'Twitch', label: 'Twitch channel or link', placeholder: 'Twitch channel or link', hint: 'Enter a public Twitch channel that is live now.', note: 'Twitch · Live channels' },
};
const RECENTS_KEY = 'passenger.recents.v1';

// YouTube sometimes refuses a request from Cloudflare's network as a bot or fails mid-load; a fresh request usually passes.
async function resolveSource(body: { provider: ProviderId; input: string }, signal: AbortSignal, fallbackMessage: string, onRetry?: () => void): Promise<PlaybackSource> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch('/api/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    let source: unknown;
    try { source = await response.json(); }
    catch { throw new Error('The video service returned an unexpected response. Try Watch again.'); }
    if (response.ok) return source as PlaybackSource;
    if (attempt < 4 && response.status >= 500) {
      onRetry?.();
      await new Promise((resolve) => window.setTimeout(resolve, 700));
      if (signal.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
      continue;
    }
    const errorPayload = source && typeof source === 'object' ? source as { error?: unknown } : {};
    throw new Error(typeof errorPayload.error === 'string' && errorPayload.error ? errorPayload.error : fallbackMessage);
  }
}

const drafts: Record<ProviderId, string> = { youtube: '', twitch: '' };
let provider: ProviderId = 'youtube';
let view: 'browse' | 'shorts' = 'browse';
let accountStatus: AccountState['status'] = 'signed_out';
let accountView: AccountFeedName | null = null;
let accountCursor: string | null = null;
let accountFeedGeneration = 0;
let accountFeedBusy = false;
let generation = 0;
let request: AbortController | undefined;
let searchRequest: AbortController | undefined;
let player: CanvasPlayer | undefined;
let cleanup: Promise<void> = Promise.resolve();
let state: PlaybackState = 'idle';
let audioBlocked = false;

interface AudioMenuState {
  tracks: AudioTrackInfo[];
  selectedId: number | null;
  busy: boolean;
  seeking: boolean;
  message: string;
}

let audioMenu: AudioMenuState = { tracks: [], selectedId: null, busy: false, seeking: false, message: '' };
let duration = 0;
let isLive = false;
let scrubbing = false;
let volumeBeforeMute = 80;

interface RecentItem {
  provider: ProviderId;
  input: string;
  title: string;
}

let recents: RecentItem[] = readRecents();

interface ShortsState {
  items: VideoSummary[];
  index: number;
  query: string;
  nextCursor: string | null;
  request: AbortController | null;
  authorized: boolean;
  phase: PlaybackState;
  scrolling: boolean;
  scrollTimer: number | undefined;
  mode: 'public' | 'personal';
  seed: string | null;
}

const shorts: ShortsState = {
  items: [], index: 0, query: 'funny animals', nextCursor: null, request: null,
  authorized: false, phase: 'idle', scrolling: false, scrollTimer: undefined, mode: 'public', seed: null,
};

function setStatus(message: string, error = false): void {
  ui.status.textContent = message;
  ui.status.dataset.error = String(error);
}

function selectProvider(next: string | undefined): void {
  if (!isProviderId(next)) return;
  leaveShorts();
  closeSearch();
  drafts[provider] = ui.input.value;
  provider = next;
  ui.input.value = drafts[provider];
  ui.input.removeAttribute('aria-invalid');
  ui.label.textContent = PROVIDERS[provider].label;
  ui.input.placeholder = PROVIDERS[provider].placeholder;
  ui.hint.textContent = PROVIDERS[provider].hint;
  ui.note.textContent = PROVIDERS[provider].note;
  ui.browseProvider.textContent = PROVIDERS[provider].name.toUpperCase();
  ui.filters.hidden = provider !== 'youtube';
  ui.empty.hidden = provider === 'youtube';
  ui.browseTitle.textContent = provider === 'youtube' ? 'Explore' : 'Twitch';
  ui.browseDescription.textContent = provider === 'youtube' ? 'Short documentaries from YouTube.' : 'Public channels, live now.';
  updateWatchLabel();
  document.querySelectorAll<HTMLElement>('[data-provider]').forEach((button) => {
    const selected = button.dataset.provider === provider;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  renderRecents();
  if (provider === 'youtube') void exploreTopic(document.querySelector<HTMLElement>('[data-topic]'));
}

function isVideoInput(value: string): boolean {
  return (/^[\w-]{11}$/.test(value) && /[\d_-]/.test(value)) || /^(?:https?:\/\/|www\.|youtu\.be\/|youtube\.com\/)/i.test(value);
}

function updateWatchLabel(): void {
  $('watch-label').textContent = view === 'shorts' || (provider === 'youtube' && !isVideoInput(ui.input.value.trim())) ? 'Search' : 'Watch';
}

function closeSearch(): void {
  searchRequest?.abort();
  searchRequest = undefined;
  ui.searchSection.hidden = true;
  accountFeedGeneration += 1;
  accountFeedBusy = false;
  accountView = null;
  accountCursor = null;
  $<HTMLButtonElement>('load-more-videos').hidden = true;
  updateLibraryNavigation();
}

function createThumbnail(source?: string | null, duration = 0, live = false): HTMLSpanElement {
  const thumbnail = document.createElement('span');
  thumbnail.className = 'thumbnail';
  if (source) {
    try {
      const url = new URL(source, window.location.origin);
      if (url.protocol === 'https:' || url.origin === window.location.origin) {
        const image = document.createElement('img');
        image.src = url.href;
        image.alt = '';
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        thumbnail.append(image);
      }
    } catch { /* Missing thumbnails do not prevent playback. */ }
  }
  if (duration > 0 || live) {
    const badge = document.createElement('span');
    badge.className = `video-duration${live ? ' is-live' : ''}`;
    badge.textContent = live ? 'Live' : formatTime(duration);
    thumbnail.append(badge);
  }
  return thumbnail;
}

function setActiveTopic(active: HTMLElement | null): void {
  document.querySelectorAll<HTMLElement>('[data-topic]').forEach((button) => {
    const selected = button === active;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

function exploreTopic(button: HTMLElement | null): Promise<void> {
  if (!button) return Promise.resolve();
  setActiveTopic(button);
  ui.input.value = '';
  drafts.youtube = '';
  updateWatchLabel();
  return searchYouTube(button.dataset.topic, button.dataset.topicTitle);
}

function showSearchSkeletons(): void {
  ui.searchResults.replaceChildren();
  for (let index = 0; index < 6; index += 1) {
    const skeleton = document.createElement('div');
    skeleton.className = 'result-skeleton';
    skeleton.setAttribute('aria-hidden', 'true');
    skeleton.append(createThumbnail());
    for (let line = 0; line < 2; line += 1) {
      const bar = document.createElement('span');
      bar.className = 'skeleton-line';
      skeleton.append(bar);
    }
    ui.searchResults.append(skeleton);
  }
}

function renderVideoCards(videos: VideoSummary[]): void {
  for (const video of videos) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-result';
    button.dataset.testid = 'search-result';
    button.dataset.videoId = video.id;
    button.setAttribute('aria-label', `Watch ${video.title}`);
    button.append(createThumbnail(video.thumbnail, video.duration ?? 0, video.live));
    const details = document.createElement('span');
    details.className = 'video-details';
    const title = document.createElement('strong');
    title.className = 'video-title';
    title.textContent = video.title;
    const meta = document.createElement('span');
    meta.className = 'video-meta';
    meta.textContent = video.channel || 'YouTube';
    details.append(title, meta);
    button.append(details);
    button.addEventListener('click', () => {
      void startPlayback(video.id, 'youtube');
      ui.card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    ui.searchResults.append(button);
  }
}

async function searchYouTube(query = ui.input.value.trim(), topic?: string): Promise<void> {
  if (!query) { ui.input.focus(); return; }
  closeSearch();
  ui.filters.hidden = false;
  ui.browseProvider.textContent = 'YOUTUBE';
  ui.note.textContent = 'YouTube · Public videos';
  if (!topic) setActiveTopic(null);
  const controller = new AbortController();
  searchRequest = controller;
  const timeout = window.setTimeout(() => controller.abort(), 25000);
  ui.searchSection.hidden = false;
  ui.browseTitle.textContent = topic || 'Search results';
  ui.browseDescription.textContent = topic ? `${query} from YouTube.` : query;
  ui.searchStatus.textContent = 'Searching YouTube…';
  $<HTMLButtonElement>('close-search').hidden = Boolean(topic);
  showSearchSkeletons();
  try {
    const response = await fetch('/api/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }), signal: controller.signal,
    });
    const data = await response.json() as SearchResponse & { error?: string };
    if (!response.ok) throw new Error(data.error || 'YouTube search is unavailable. Try again.');
    if (!Array.isArray(data.videos)) throw new Error('YouTube returned an incomplete search. Try again.');
    if (searchRequest !== controller) return;
    ui.searchResults.replaceChildren();
    ui.searchStatus.textContent = data.videos.length ? `${data.videos.length} video${data.videos.length === 1 ? '' : 's'}` : 'No videos found. Try another search.';
    renderVideoCards(data.videos);
  } catch (error) {
    if (searchRequest === controller) {
      ui.searchResults.replaceChildren();
      ui.searchStatus.textContent = controller.signal.aborted ? 'Search timed out. Try again.' : playbackError(error);
    }
  } finally {
    window.clearTimeout(timeout);
    if (searchRequest === controller) searchRequest = undefined;
  }
}


function receiveAudioTracks(info: AudioTracksPayload): void {
  const seen = new Set<number>();
  audioMenu.tracks = (Array.isArray(info?.tracks) ? info.tracks : []).filter((track) => {
    if (!Number.isInteger(track.id) || seen.has(track.id)) return false;
    seen.add(track.id);
    return true;
  });
  const rawSelectedId = info?.selectedId ?? audioMenu.tracks.find((track) => track.selected)?.id;
  audioMenu.selectedId = typeof rawSelectedId === 'number' && seen.has(rawSelectedId) ? rawSelectedId : null;
  for (const id of ['audio-track', 'shorts-audio-track']) {
    const select = $<HTMLSelectElement>(id);
    select.replaceChildren();
    if (audioMenu.selectedId === null) {
      const prompt = document.createElement('option');
      prompt.value = '';
      prompt.textContent = 'Choose language';
      prompt.disabled = true;
      select.append(prompt);
    }
    audioMenu.tracks.forEach((track, index) => {
      const option = document.createElement('option');
      option.value = String(track.id);
      option.textContent = track.label || track.language || `Audio track ${index + 1}`;
      select.append(option);
    });
  }
  updateAudioMenu();
}

function updateAudioMenu(): void {
  const visible = audioMenu.tracks.length > 1;
  const playable = (['playing', 'paused', 'ended'] as PlaybackState[]).includes(view === 'shorts' ? shorts.phase : state);
  for (const prefix of ['', 'shorts-']) {
    const active = (prefix === 'shorts-') === (view === 'shorts');
    $(prefix + 'audio-language').hidden = !visible || !active;
    const select = $<HTMLSelectElement>(prefix + 'audio-track');
    select.disabled = !visible || !active || !playable || audioMenu.busy || audioMenu.seeking;
    select.setAttribute('aria-busy', String(audioMenu.busy));
    select.value = audioMenu.selectedId === null ? '' : String(audioMenu.selectedId);
    $(prefix + 'audio-message').textContent = audioMenu.message;
  }
}

async function changeAudioTrack(event: Event): Promise<void> {
  // The change listener is attached only to the audio-language <select> elements below.
  const target = event.target as HTMLSelectElement;
  const selectedId = Number(target.value);
  const activePlayer = player;
  const current = generation;
  if (!activePlayer || audioMenu.busy || audioMenu.seeking || !audioMenu.tracks.some((track) => track.id === selectedId)) return;
  if (selectedId === audioMenu.selectedId) return;
  audioMenu.busy = true;
  audioMenu.message = 'Switching audio…';
  if (view === 'shorts') updateShortControls();
  else updateControls();
  try {
    await activePlayer.selectAudioTrack(selectedId);
    if (current !== generation) return;
    audioMenu.selectedId = selectedId;
    audioMenu.message = '';
  } catch (error) {
    if (current !== generation) return;
    audioMenu.message = `Could not switch audio. ${playbackError(error)}`;
  } finally {
    if (current === generation) {
      audioMenu.busy = false;
      if (view === 'shorts') updateShortControls();
      else updateControls();
    }
  }
}

$<HTMLSelectElement>('audio-track').addEventListener('change', (event) => void changeAudioTrack(event));
$<HTMLSelectElement>('shorts-audio-track').addEventListener('change', (event) => void changeAudioTrack(event));

function updateControls(): void {
  const playable = (['playing', 'paused', 'ended'] as PlaybackState[]).includes(state);
  const canResume = state === 'paused' || state === 'ended';
  const label = audioBlocked ? 'Enable sound' : state === 'ended' ? 'Replay' : canResume ? 'Play' : 'Pause';
  ui.pause.disabled = !playable || (isLive && !audioBlocked) || audioMenu.busy;
  ui.pauseLabel.textContent = label;
  ui.pause.setAttribute('aria-label', audioBlocked ? label : `${label} video`);
  ui.pauseIcon.setAttribute('d', canResume || audioBlocked ? 'm8 5 11 7-11 7V5Z' : 'M7 5h3v14H7zm7 0h3v14h-3z');
  ui.stop.disabled = state === 'idle' || state === 'error';
  ui.volume.disabled = !playable;
  ui.mute.disabled = !playable;
  ui.fullscreen.disabled = typeof ui.card.requestFullscreen !== 'function' || (!playable && document.fullscreenElement !== ui.card);
  ui.seek.disabled = !playable || duration <= 0 || audioMenu.busy;
  ui.card.dataset.state = state;
  updateAudioMenu();
}

function dispose(): number {
  generation += 1;
  audioMenu = { tracks: [], selectedId: null, busy: false, seeking: false, message: '' };
  updateAudioMenu();
  request?.abort();
  request = undefined;
  if (player) {
    const previous = player;
    player = undefined;
    // Destroy immediately so an in-flight load can never proceed to play after Stop.
    const closing = previous.destroy().catch((error) => console.warn('Player cleanup failed:', error));
    cleanup = Promise.all([cleanup, closing]).then(() => {});
  }
  return generation;
}

function resetProgress(): void {
  duration = 0;
  isLive = false;
  scrubbing = false;
  audioBlocked = false;
  ui.seekRow.hidden = true;
  ui.seek.value = '0';
  ui.current.textContent = '0:00';
  ui.duration.textContent = '0:00';
  ui.live.hidden = true;
}

function fail(error: unknown, expectedGeneration: number): void {
  if (expectedGeneration !== generation) return;
  dispose();
  state = 'error';
  ui.loading.hidden = true;
  ui.placeholder.hidden = false;
  ui.placeholderTitle.textContent = 'Unable to play this video';
  ui.placeholderCopy.textContent = 'Try again or choose another video.';
  ui.kicker.textContent = 'Playback unavailable';
  resetProgress();
  setStatus(playbackError(error), true);
  updateControls();
}

async function startPlayback(input = ui.input.value.trim(), chosenProvider = provider): Promise<void> {
  if (!input) {
    ui.input.setAttribute('aria-invalid', 'true');
    setStatus(`Add a ${PROVIDERS[chosenProvider].label.toLowerCase()} first.`, true);
    ui.input.focus();
    return;
  }
  prepareAudio();
  const current = dispose();
  const controller = new AbortController();
  request = controller;
  let resolutionTimedOut = false;
  const timeout = window.setTimeout(() => {
    resolutionTimedOut = true;
    controller.abort();
  }, 30000);
  state = 'loading';
  resetProgress();
  ui.input.removeAttribute('aria-invalid');
  ui.loading.hidden = false;
  ui.placeholder.hidden = false;
  ui.placeholderTitle.textContent = 'Loading video';
  ui.placeholderCopy.textContent = 'Connecting to the stream…';
  ui.kicker.textContent = PROVIDERS[chosenProvider].name;
  ui.title.textContent = 'Loading…';
  setStatus(`Connecting to ${PROVIDERS[chosenProvider].name}…`);
  updateControls();
  try {
    await cleanup;
    if (current !== generation) return;
    const source = await resolveSource({ provider: chosenProvider, input }, controller.signal,
      'The video could not be found. Try another link.', () => setStatus('YouTube is busy. Trying again…'));
    if (!source || typeof source.streamUrl !== 'string' || typeof source.id !== 'string' || !PROVIDERS[source.provider]) {
      throw new Error('The video service returned an incomplete response. Try Watch again.');
    }
    if (current !== generation) return;
    window.clearTimeout(timeout);
    request = undefined;
    ui.title.textContent = typeof source.title === 'string' && source.title ? source.title : input;
    setStatus('Loading…');
    let saved = false;
    const whenCurrent = <F extends (...args: never[]) => void>(callback: F): F => (
      ((...args: Parameters<F>) => {
        if (current === generation) callback(...args);
      }) as F
    );
    player = new CanvasPlayer(ui.mount, {
      audioTracks: whenCurrent(receiveAudioTracks),
      seeking: whenCurrent((seeking: boolean) => { audioMenu.seeking = seeking; updateAudioMenu(); }),
      ready: whenCurrent((info) => {
        isLive = info.isLive;
        duration = info.isLive ? 0 : info.duration;
        ui.seekRow.hidden = duration <= 0;
        ui.seek.max = String(duration);
        ui.duration.textContent = formatTime(duration);
        ui.live.hidden = !info.isLive;
      }),
      state: whenCurrent((nextState: PlaybackState) => {
        state = nextState;
        if (nextState === 'ended') ui.loading.hidden = true;
        setStatus(nextState === 'paused' ? 'Paused' : nextState === 'ended' ? 'Video ended' : audioBlocked ? 'Tap Enable sound to turn on audio.' : '');
        updateControls();
      }),
      firstFrame: whenCurrent(() => {
        ui.placeholder.hidden = true;
        ui.loading.hidden = true;
        if (!saved) {
          saved = true;
          saveRecent({ provider: source.provider, input: source.id, title: ui.title.textContent || '' });
        }
      }),
      buffering: whenCurrent((buffering: boolean) => {
        ui.loading.hidden = !buffering;
        setStatus(buffering ? 'Seeking…' : state === 'paused' ? 'Paused' : '');
      }),
      time: whenCurrent((seconds: number) => {
        if (scrubbing) return;
        ui.current.textContent = formatTime(seconds);
        if (duration > 0) ui.seek.value = String(Math.min(duration, seconds));
      }),
      audioBlocked: whenCurrent(() => {
        audioBlocked = true;
        setStatus('Tap Enable sound to turn on audio.');
        updateControls();
      }),
      audioReady: whenCurrent(() => {
        if (!audioBlocked) return;
        audioBlocked = false;
        setStatus(state === 'paused' ? 'Paused' : '');
        updateControls();
      }),
      error: (error) => fail(error, current),
    });
    await player.open(source, Number(ui.volume.value) / 100);
  } catch (error) {
    if (current !== generation) return;
    fail(resolutionTimedOut ? new Error('The video service took too long to respond. Try Watch again.') : error, current);
  } finally {
    window.clearTimeout(timeout);
  }
}

function stopPlayback(): void {
  dispose();
  state = 'idle';
  resetProgress();
  ui.loading.hidden = true;
  ui.placeholder.hidden = false;
  ui.placeholderTitle.textContent = 'Playback stopped';
  ui.placeholderCopy.textContent = '';
  ui.kicker.textContent = 'Stopped';
  ui.title.textContent = 'Select a video';
  setStatus('Playback stopped.');
  updateControls();
}

function formatTime(value: number): string {
  const seconds = Math.floor(Number.isFinite(value) ? Math.max(0, value) : 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const remainder = String(seconds % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
}

function readRecents(): RecentItem[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
    if (!Array.isArray(stored)) return [];
    return (stored as unknown[]).filter((item): item is RecentItem => (
      Boolean(item) && typeof item === 'object'
      && isProviderId((item as { provider?: string }).provider)
      && typeof (item as { input?: unknown }).input === 'string' && (item as { input: string }).input.length > 0 && (item as { input: string }).input.length <= 2048
      && typeof (item as { title?: unknown }).title === 'string'
    )).slice(0, 8).map((item) => ({
      provider: item.provider, input: item.input, title: item.title.slice(0, 200),
    }));
  } catch {
    return [];
  }
}

function storeRecents(): void {
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(recents)); } catch { /* Private browsing may disable persistent storage. */ }
}

function saveRecent(item: RecentItem): void {
  recents = [item, ...recents.filter((recent) => recent.provider !== item.provider || recent.input !== item.input)].slice(0, 8);
  storeRecents();
  renderRecents();
}

function renderRecents(): void {
  ui.recents.replaceChildren();
  const items = recents.filter((item) => item.provider === provider);
  ui.recentSection.hidden = items.length === 0;
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-item';
    button.title = item.title;
    button.setAttribute('aria-label', `Watch ${item.title} on ${PROVIDERS[item.provider].name}`);
    const thumbnail = item.provider === 'youtube' && /^[\w-]{11}$/.test(item.input)
      ? `https://i.ytimg.com/vi/${item.input}/hqdefault.jpg` : '';
    button.append(createThumbnail(thumbnail));
    const title = document.createElement('span');
    title.className = 'recent-title video-title';
    title.textContent = item.title;
    const badge = document.createElement('span');
    badge.className = 'recent-provider';
    badge.textContent = PROVIDERS[item.provider].name;
    button.append(title, badge);
    button.addEventListener('click', () => {
      void startPlayback(item.input, item.provider);
      ui.card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    ui.recents.append(button);
  }
}

function updateVolume(value: number): void {
  const volume = Math.max(0, Math.min(100, value));
  ui.volume.value = String(volume);
  ui.mute.setAttribute('aria-pressed', String(volume === 0));
  ui.mute.setAttribute('aria-label', volume === 0 ? 'Unmute audio' : 'Mute audio');
  player?.setVolume(volume / 100);
}

async function control(action: (activePlayer: CanvasPlayer) => Promise<void>): Promise<void> {
  const current = generation;
  const activePlayer = player;
  if (!activePlayer) return;
  ui.pause.disabled = true;
  try { await action(activePlayer); } catch (error) { fail(error, current); }
  if (current === generation) updateControls();
}

ui.form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (view === 'shorts') {
    shorts.mode = 'public';
    shorts.seed = null;
    updateShortModes();
    void loadShorts(ui.input.value.trim() || shorts.query);
  }
  else if (provider === 'youtube' && !isVideoInput(ui.input.value.trim())) void searchYouTube();
  else { closeSearch(); void startPlayback(); }
});
document.querySelectorAll<HTMLElement>('[data-provider]').forEach((button) => button.addEventListener('click', () => selectProvider(button.dataset.provider)));
ui.input.addEventListener('input', () => { ui.input.removeAttribute('aria-invalid'); updateWatchLabel(); });
$('close-search').addEventListener('click', () => void exploreTopic(document.querySelector<HTMLElement>('[data-topic]')));
document.querySelectorAll<HTMLElement>('[data-topic]').forEach((button) => button.addEventListener('click', () => void exploreTopic(button)));
ui.stop.addEventListener('click', stopPlayback);
ui.pause.addEventListener('click', () => void control((activePlayer) => audioBlocked ? activePlayer.resumeAudio() : state === 'playing' ? activePlayer.pause() : activePlayer.play()));
ui.volume.addEventListener('input', () => updateVolume(Number(ui.volume.value)));
ui.mute.addEventListener('click', () => {
  const volume = Number(ui.volume.value);
  if (volume > 0) { volumeBeforeMute = volume; updateVolume(0); }
  else updateVolume(volumeBeforeMute || 80);
});
ui.seek.addEventListener('input', () => { scrubbing = true; ui.current.textContent = formatTime(Number(ui.seek.value)); });
ui.seek.addEventListener('change', () => {
  scrubbing = false;
  void control((activePlayer) => activePlayer.seek(Number(ui.seek.value)));
});
ui.seek.addEventListener('blur', () => { scrubbing = false; });
ui.fullscreen.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await ui.card.requestFullscreen();
  } catch { setStatus('Fullscreen is unavailable in this browser.'); }
});
document.addEventListener('fullscreenchange', () => {
  ui.fullscreen.setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Enter fullscreen');
  updateControls();
});
$('clear-recents').addEventListener('click', () => { recents = []; storeRecents(); renderRecents(); });
window.addEventListener('pagehide', () => {
  closeSearch();
  shorts.request?.abort();
  window.clearTimeout(shorts.scrollTimer);
  dispose();
});
renderRecents();
updateWatchLabel();
void exploreTopic(document.querySelector<HTMLElement>('[data-topic]'));

async function checkConnection(): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('/api/health', { signal: controller.signal });
    const health = await response.json() as HealthResponse;
    if (!response.ok || health.ok !== true) throw new Error('Unavailable');
    $('connection-status').dataset.connected = 'true';
    $('connection-label').textContent = 'Connected';
  } catch {
    $('connection-status').dataset.connected = 'false';
    $('connection-label').textContent = 'Connection unavailable';
  } finally { window.clearTimeout(timeout); }
}
void checkConnection();

function currentShortSlide(): HTMLElement | null {
  return ($('shorts-feed').children[shorts.index] as HTMLElement | undefined) ?? null;
}

function updateShortControls(): void {
  $('shorts-section').dataset.state = shorts.phase;
  $('shorts-section').dataset.index = String(shorts.index);
  $('shorts-actions').hidden = shorts.items.length === 0;
  $<HTMLButtonElement>('shorts-previous').disabled = shorts.index === 0;
  $<HTMLButtonElement>('shorts-next').disabled = shorts.index >= shorts.items.length - 1 && (Boolean(shorts.request) || !shorts.nextCursor);
  const paused = shorts.phase === 'paused';
  $<HTMLButtonElement>('shorts-pause').disabled = !(['playing', 'paused'] as PlaybackState[]).includes(shorts.phase) || audioMenu.busy;
  $('shorts-pause').setAttribute('aria-label', paused ? 'Play Short' : 'Pause Short');
  requireFirstElementChild($('shorts-pause-icon')).setAttribute('d', paused ? 'm8 5 11 7-11 7V5Z' : 'M7 5h3v14H7zm7 0h3v14h-3z');
  const muted = Number(ui.volume.value) === 0;
  $('shorts-mute').setAttribute('aria-pressed', String(muted));
  $('shorts-mute').setAttribute('aria-label', muted ? 'Unmute Short' : 'Mute Short');
  if (shorts.items.length) $('shorts-status').textContent = `${shorts.index + 1} / ${shorts.items.length}`;
  updateAudioMenu();
}

function resetShortSlide(slide: HTMLElement | null): void {
  if (!slide) return;
  slide.querySelector('.shorts-poster')?.removeAttribute('hidden');
  requireQuery(slide, '.shorts-center').hidden = false;
  requireQuery<HTMLElement>(slide, '.shorts-start').hidden = false;
  requireQuery(slide, '.shorts-start').textContent = 'Play Shorts';
  requireQuery(slide, '.shorts-loading').hidden = true;
  requireQuery(slide, '.shorts-message').textContent = '';
  requireQuery(slide, '.shorts-skip').hidden = true;
}

function stopShort(): void {
  dispose();
  shorts.phase = 'idle';
  resetShortSlide(currentShortSlide());
  updateShortControls();
}

function enterShorts(): void {
  if (view === 'shorts') return;
  closeSearch();
  dispose();
  state = 'idle';
  updateControls();
  drafts[provider] = ui.input.value;
  view = 'shorts';
  shorts.authorized = false;
  shorts.phase = 'idle';
  document.body.dataset.view = 'shorts';
  $('browse-view').hidden = true;
  $('shorts-section').hidden = false;
  $('shorts-button').classList.add('is-active');
  $('shorts-button').setAttribute('aria-pressed', 'true');
  document.querySelectorAll<HTMLElement>('[data-provider]').forEach((button) => {
    button.classList.remove('is-active');
    button.setAttribute('aria-pressed', 'false');
  });
  ui.input.value = '';
  ui.input.placeholder = 'Search Shorts';
  ui.label.textContent = 'Search YouTube Shorts';
  ui.hint.textContent = 'Search public YouTube Shorts by topic.';
  ui.note.textContent = 'YouTube Shorts';
  updateWatchLabel();
  if (!shorts.items.length) {
    shorts.mode = accountStatus === 'connected' ? 'personal' : 'public';
    void loadShorts(shorts.query);
  }
  else {
    resetShortSlide(currentShortSlide());
    updateShortControls();
  }
  updateShortModes();
  window.requestAnimationFrame(sizeShortsFeed);
}

function leaveShorts(): void {
  if (view !== 'shorts') return;
  shorts.request?.abort();
  shorts.request = null;
  window.clearTimeout(shorts.scrollTimer);
  shorts.scrolling = false;
  shorts.authorized = false;
  stopShort();
  view = 'browse';
  document.body.dataset.view = 'browse';
  $('shorts-section').hidden = true;
  $('browse-view').hidden = false;
  $('shorts-button').classList.remove('is-active');
  $('shorts-button').setAttribute('aria-pressed', 'false');
  state = 'idle';
  updateControls();
}

async function loadShorts(query = shorts.query, append = false): Promise<void> {
  if (view !== 'shorts' || (append && (shorts.request || !shorts.nextCursor))) return;
  shorts.request?.abort();
  const controller = new AbortController();
  shorts.request = controller;
  const cursor = append ? shorts.nextCursor : null;
  if (!append) {
    stopShort();
    shorts.items = [];
    shorts.index = 0;
    shorts.query = query;
    shorts.nextCursor = null;
    $('shorts-feed').replaceChildren();
    $('shorts-query').textContent = shorts.mode === 'personal' ? 'From your YouTube account' : query;
    $('shorts-actions').hidden = true;
  }
  $('shorts-status').textContent = append ? 'Loading more…' : 'Finding Shorts…';
  $<HTMLButtonElement>('shorts-next').disabled = shorts.index >= shorts.items.length - 1;
  const timeout = window.setTimeout(() => controller.abort(), 25000);
  try {
    let data: ShortsResponse;
    if (shorts.mode === 'personal') {
      const feed = await fetchAccountFeed({ feed: 'shorts', cursor, seed: shorts.seed });
      data = { provider: feed.provider, query, videos: feed.videos, nextCursor: feed.nextCursor };
    } else {
      const response = await fetch('/api/shorts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, ...(cursor ? { cursor } : {}) }), signal: controller.signal,
      });
      const payload = await response.json() as ShortsResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Shorts are unavailable. Try another search.');
      data = payload;
    }
    if (!Array.isArray(data.videos)) throw new Error('Shorts could not be loaded. Try again.');
    if (shorts.request !== controller || view !== 'shorts') return;
    const existing = new Set(shorts.items.map((video) => video.id));
    const additions = data.videos.filter((video) => {
      if (typeof video.id !== 'string' || existing.has(video.id)) return false;
      existing.add(video.id);
      return true;
    });
    for (const video of additions) {
      const index = shorts.items.length;
      shorts.items.push(video);
      $('shorts-feed').append(createShortSlide(video, index));
    }
    shorts.nextCursor = typeof data.nextCursor === 'string' ? data.nextCursor : null;
    if (!shorts.items.length) $('shorts-status').textContent = shorts.mode === 'personal' ? 'No Shorts in this feed. Choose a video in Topics to start.' : 'No Shorts found. Search another topic.';
    else {
      updateShortControls();
      if (!append && shorts.authorized) void playShort(shorts.index);
    }
  } catch (error) {
    if (shorts.request === controller && view === 'shorts') {
      $('shorts-status').textContent = controller.signal.aborted ? 'Search timed out. Try again.' : playbackError(error);
    }
  } finally {
    window.clearTimeout(timeout);
    if (shorts.request === controller) {
      shorts.request = null;
      $<HTMLButtonElement>('shorts-next').disabled = shorts.index >= shorts.items.length - 1 && !shorts.nextCursor;
    }
    window.requestAnimationFrame(sizeShortsFeed);
  }
}

function createShortSlide(video: VideoSummary, index: number): HTMLElement {
  const slide = document.createElement('article');
  slide.className = 'shorts-slide';
  slide.dataset.testid = 'shorts-slide';
  slide.dataset.videoId = video.id;
  slide.setAttribute('aria-label', video.title || 'YouTube Short');
  const frame = document.createElement('div');
  frame.className = 'shorts-frame';
  const poster = createThumbnail(video.thumbnail).firstElementChild;
  if (poster) {
    poster.className = 'shorts-poster';
    frame.append(poster);
  }
  const mount = document.createElement('div');
  mount.className = 'shorts-mount';
  const shade = document.createElement('div');
  shade.className = 'shorts-shade';
  const center = document.createElement('div');
  center.className = 'shorts-center';
  const start = document.createElement('button');
  start.type = 'button';
  start.className = 'shorts-start';
  start.dataset.testid = 'shorts-play';
  start.textContent = 'Play Shorts';
  start.addEventListener('click', () => {
    prepareAudio();
    shorts.authorized = true;
    if (player && index === shorts.index && shorts.phase === 'playing') {
      const current = generation;
      void player.resumeAudio().catch((error) => shortFailed(error, current));
      start.hidden = true;
    } else void playShort(index);
  });
  const spinner = document.createElement('span');
  spinner.className = 'shorts-loading spinner';
  spinner.hidden = true;
  spinner.setAttribute('aria-hidden', 'true');
  const message = document.createElement('p');
  message.className = 'shorts-message';
  message.setAttribute('role', 'status');
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'shorts-skip';
  skip.textContent = 'Next video';
  skip.hidden = true;
  skip.addEventListener('click', () => void moveShort(1));
  center.append(start, spinner, message, skip);
  const caption = document.createElement('div');
  caption.className = 'shorts-caption';
  if (video.channel) {
    const channel = document.createElement('p');
    channel.textContent = video.channel;
    caption.append(channel);
  }
  const title = document.createElement('h2');
  title.textContent = video.title || 'YouTube Short';
  caption.append(title);
  const progress = document.createElement('div');
  progress.className = 'shorts-progress';
  progress.setAttribute('aria-hidden', 'true');
  progress.append(document.createElement('span'));
  frame.append(mount, shade, center, caption, progress);
  slide.append(frame);
  return slide;
}

function shortFailed(error: unknown, current: number): void {
  if (current !== generation || view !== 'shorts') return;
  dispose();
  shorts.phase = 'error';
  // A failure is only reported for a Short currently occupying a rendered slide.
  const slide = currentShortSlide()!;
  resetShortSlide(slide);
  requireQuery(slide, '.shorts-start').textContent = 'Try again';
  requireQuery(slide, '.shorts-message').textContent = playbackError(error);
  requireQuery<HTMLElement>(slide, '.shorts-skip').hidden = shorts.index >= shorts.items.length - 1 && !shorts.nextCursor;
  updateShortControls();
}

async function playShort(index: number): Promise<void> {
  if (view !== 'shorts' || !shorts.authorized || !shorts.items[index]) return;
  stopShort();
  shorts.index = index;
  const current = generation;
  // loadShorts appends one slide per pushed item, so a valid items[index] always has a slide.
  const slide = currentShortSlide()!;
  const video = shorts.items[index];
  let clipDuration = 0;
  const controller = new AbortController();
  request = controller;
  shorts.phase = 'loading';
  resetShortSlide(slide);
  requireQuery<HTMLElement>(slide, '.shorts-start').hidden = true;
  requireQuery<HTMLElement>(slide, '.shorts-loading').hidden = false;
  requireQuery(slide, '.shorts-message').textContent = 'Loading…';
  updateShortControls();
  const whenCurrent = <F extends (...args: never[]) => void>(callback: F): F => (
    ((...args: Parameters<F>) => {
      if (current === generation && view === 'shorts') callback(...args);
    }) as F
  );
  const timeout = window.setTimeout(() => controller.abort(), 30000);
  try {
    await cleanup;
    if (current !== generation || view !== 'shorts') return;
    const source = await resolveSource({ provider: 'youtube', input: video.id }, controller.signal,
      'This Short is unavailable. Try the next video.',
      () => { requireQuery(slide, '.shorts-message').textContent = 'YouTube is busy. Trying again…'; });
    if (current !== generation || view !== 'shorts') return;
    window.clearTimeout(timeout);
    request = undefined;
    if (source.title) requireQuery(slide, '.shorts-caption h2').textContent = source.title;
    if (source.channel) {
      let channel = slide.querySelector('.shorts-caption p');
      if (!channel) {
        channel = document.createElement('p');
        requireQuery(slide, '.shorts-caption').prepend(channel);
      }
      channel.textContent = source.channel;
    }
    player = new CanvasPlayer(requireQuery(slide, '.shorts-mount'), {
      audioTracks: whenCurrent(receiveAudioTracks),
      seeking: whenCurrent((seeking: boolean) => { audioMenu.seeking = seeking; updateAudioMenu(); }),
      ready: (info) => { clipDuration = info.duration; },
      state: whenCurrent((next: PlaybackState) => {
        shorts.phase = next;
        updateShortControls();
        if (next === 'ended') void player?.play().catch((error) => shortFailed(error, current));
      }),
      firstFrame: whenCurrent(() => {
        slide.querySelector('.shorts-poster')?.setAttribute('hidden', '');
        requireQuery(slide, '.shorts-center').hidden = true;
      }),
      buffering: whenCurrent((buffering: boolean) => { requireQuery<HTMLElement>(slide, '.shorts-loading').hidden = !buffering; }),
      time: whenCurrent((seconds: number) => {
        if (clipDuration > 0) requireQuery<HTMLElement>(slide, '.shorts-progress span').style.transform = `scaleX(${Math.min(1, Math.max(0, seconds / clipDuration))})`;
      }),
      audioBlocked: whenCurrent(() => {
        requireQuery(slide, '.shorts-center').hidden = false;
        requireQuery(slide, '.shorts-loading').hidden = true;
        requireQuery(slide, '.shorts-message').textContent = '';
        requireQuery(slide, '.shorts-start').textContent = 'Enable sound';
        requireQuery<HTMLElement>(slide, '.shorts-start').hidden = false;
      }),
      audioReady: whenCurrent(() => { requireQuery(slide, '.shorts-center').hidden = true; }),
      error: (error) => shortFailed(error, current),
    });
    await player.open(source, Number(ui.volume.value) / 100);
    if (index >= shorts.items.length - 3) void loadShorts(shorts.query, true);
  } catch (error) {
    if (current === generation) shortFailed(controller.signal.aborted ? new Error('This Short took too long to load. Try the next video.') : error, current);
  } finally { window.clearTimeout(timeout); }
}

async function moveShort(direction: number): Promise<void> {
  let next = shorts.index + direction;
  if (next < 0 || (next >= shorts.items.length && !shorts.nextCursor)) return;
  stopShort();
  if (next >= shorts.items.length && shorts.nextCursor) await loadShorts(shorts.query, true);
  next = Math.max(0, Math.min(shorts.items.length - 1, next));
  if (next === shorts.index || next < 0) return;
  $('shorts-feed').scrollTo({ top: next * $('shorts-feed').clientHeight, behavior: 'smooth' });
}

$('shorts-button').addEventListener('click', enterShorts);
$('shorts-next').addEventListener('click', () => void moveShort(1));
$('shorts-previous').addEventListener('click', () => void moveShort(-1));
$('shorts-pause').addEventListener('click', async () => {
  if (!player) return;
  const current = generation;
  try {
    if (shorts.phase === 'paused') await player.play();
    else await player.pause();
  } catch (error) { shortFailed(error, current); }
});
$('shorts-mute').addEventListener('click', () => {
  const volume = Number(ui.volume.value);
  if (volume > 0) { volumeBeforeMute = volume; updateVolume(0); }
  else updateVolume(volumeBeforeMute || 80);
  updateShortControls();
});
$('shorts-feed').addEventListener('scroll', () => {
  if (view !== 'shorts' || !shorts.items.length) return;
  if (!shorts.scrolling) {
    shorts.scrolling = true;
    stopShort();
  }
  window.clearTimeout(shorts.scrollTimer);
  shorts.scrollTimer = window.setTimeout(() => {
    shorts.scrolling = false;
    if (view !== 'shorts') return;
    shorts.index = Math.max(0, Math.min(shorts.items.length - 1, Math.round($('shorts-feed').scrollTop / $('shorts-feed').clientHeight)));
    updateShortControls();
    if (shorts.authorized) void playShort(shorts.index);
    else if (shorts.index >= shorts.items.length - 3) void loadShorts(shorts.query, true);
  }, 160);
}, { passive: true });
$('shorts-feed').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    void moveShort(event.key === 'ArrowDown' ? 1 : -1);
  }
});


function updateLibraryNavigation(): void {
  document.querySelectorAll<HTMLElement>('[data-account-feed]').forEach((button) => {
    const selected = view !== 'shorts' && button.dataset.accountFeed === accountView;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

async function loadAccountVideos(feed: AccountFeedName, append = false): Promise<void> {
  if (accountStatus !== 'connected' || (append && (accountFeedBusy || !accountCursor))) return;
  if (!append) {
    leaveShorts();
    closeSearch();
    drafts[provider] = ui.input.value;
    provider = 'youtube';
    ui.input.value = '';
    ui.input.placeholder = PROVIDERS.youtube.placeholder;
    ui.label.textContent = PROVIDERS.youtube.label;
    ui.hint.textContent = PROVIDERS.youtube.hint;
    ui.note.textContent = 'Your YouTube account';
    ui.browseProvider.textContent = 'YOUR LIBRARY';
    ui.filters.hidden = true;
    ui.empty.hidden = true;
    ui.recentSection.hidden = true;
    accountView = feed;
    document.querySelectorAll<HTMLElement>('[data-provider]').forEach((button) => {
      button.classList.remove('is-active');
      button.setAttribute('aria-pressed', 'false');
    });
    updateLibraryNavigation();
    updateWatchLabel();
    ui.browseTitle.textContent = { home: 'Home', subscriptions: 'Subscriptions', liked: 'Liked videos' }[feed];
    ui.browseDescription.textContent = 'From your YouTube account.';
    ui.searchSection.hidden = false;
    $<HTMLButtonElement>('close-search').hidden = true;
    showSearchSkeletons();
  }
  accountFeedBusy = true;
  const current = accountFeedGeneration;
  const cursor = append ? accountCursor : null;
  $<HTMLButtonElement>('load-more-videos').disabled = true;
  ui.searchStatus.textContent = append ? 'Loading more…' : 'Loading videos…';
  try {
    const data = await fetchAccountFeed({ feed, cursor });
    if (current !== accountFeedGeneration || accountStatus !== 'connected' || accountView !== feed) return;
    if (!Array.isArray(data.videos)) throw new Error('This feed could not be loaded. Try again.');
    if (!append) ui.searchResults.replaceChildren();
    const existing = new Set(Array.from(ui.searchResults.children).map((card) => (card as HTMLElement).dataset.videoId));
    const additions = data.videos.filter((video) => {
      if (typeof video.id !== 'string' || existing.has(video.id)) return false;
      existing.add(video.id);
      return true;
    });
    renderVideoCards(additions);
    accountCursor = typeof data.nextCursor === 'string' ? data.nextCursor : null;
    $<HTMLButtonElement>('load-more-videos').hidden = !accountCursor;
    const count = ui.searchResults.children.length;
    ui.searchStatus.textContent = count ? `${count} video${count === 1 ? '' : 's'}` : 'No videos in this feed yet.';
  } catch (error) {
    if (current !== accountFeedGeneration) return;
    if (!append) ui.searchResults.replaceChildren();
    ui.searchStatus.textContent = playbackError(error);
  } finally {
    if (current === accountFeedGeneration) {
      accountFeedBusy = false;
      $<HTMLButtonElement>('load-more-videos').disabled = false;
    }
  }
}

function updateShortModes(): void {
  $('shorts-modes').hidden = accountStatus !== 'connected';
  $('shorts-personal').setAttribute('aria-pressed', String(shorts.mode === 'personal'));
  $('shorts-public').setAttribute('aria-pressed', String(shorts.mode === 'public'));
  if (view === 'shorts') ui.note.textContent = shorts.mode === 'personal' ? 'Your YouTube account' : 'YouTube · Public Shorts';
}

function switchShortMode(mode: 'public' | 'personal'): void {
  if (mode === 'personal' && accountStatus !== 'connected') return;
  if (mode === shorts.mode && shorts.items.length) return;
  shorts.seed = mode === 'personal' ? shorts.items[shorts.index]?.id || null : null;
  shorts.mode = mode;
  updateShortModes();
  void loadShorts(shorts.query);
}

function sizeShortsFeed(): void {
  if (view !== 'shorts') return;
  const available = Math.max(250, window.innerHeight - $('shorts-feed').getBoundingClientRect().top - 16);
  $('shorts-section').style.setProperty('--shorts-height', `${available}px`);
}

document.querySelectorAll<HTMLElement>('[data-account-feed]').forEach((button) => {
  button.addEventListener('click', () => {
    if (isAccountFeedName(button.dataset.accountFeed)) void loadAccountVideos(button.dataset.accountFeed);
  });
});
$('load-more-videos').addEventListener('click', () => { if (accountView) void loadAccountVideos(accountView, true); });
$('shorts-personal').addEventListener('click', () => switchShortMode('personal'));
$('shorts-public').addEventListener('click', () => switchShortMode('public'));
window.addEventListener('resize', sizeShortsFeed);
initAccount({ onState(next) {
  const previous = accountStatus;
  accountStatus = next.status;
  $('account-navigation').hidden = accountStatus !== 'connected';
  updateShortModes();
  if (previous === 'connected' && accountStatus !== 'connected') {
    if (accountView) selectProvider('youtube');
    if (shorts.mode === 'personal') {
      shorts.request?.abort();
      shorts.request = null;
      if (view === 'shorts') stopShort();
      shorts.items = [];
      shorts.index = 0;
      shorts.nextCursor = null;
      shorts.mode = 'public';
      shorts.seed = null;
      $('shorts-feed').replaceChildren();
      if (view === 'shorts') {
        $('shorts-query').textContent = 'Public Shorts';
        $('shorts-status').textContent = 'Account disconnected. Search a topic to continue.';
        updateShortControls();
      }
    }
  }
  window.requestAnimationFrame(sizeShortsFeed);
} });
