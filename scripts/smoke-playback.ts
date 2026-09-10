import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from '@playwright/test';

const baseUrl = process.env.BASE_URL || 'http://localhost:8787';
const youtubeVideo = process.env.YOUTUBE_VIDEO || 'M7lc1UVf-VE';
const twitchChannel = process.env.TWITCH_CHANNEL;
const audioLanguage = process.env.AUDIO_LANGUAGE;

type Provider = 'youtube' | 'twitch';

// The real decoder's observable surface, as seen from page.evaluate callbacks.
interface ObservedPlayer {
  getStats(): { videoFrameRenderCount?: number; audioFrameRenderCount?: number } | null;
  hasAudio(): boolean;
  currentTime: number | bigint;
  getAudioList(): Promise<{ list: { lang?: string }[]; selectedIndex: number }>;
  on(event: string, listener: () => void): unknown;
}

interface Observed {
  player: ObservedPlayer | null;
  firstVideo: boolean;
  firstAudio: boolean;
}

declare global {
  interface Window {
    __playbackSmoke: Observed;
    AVPlayer: new (...args: unknown[]) => ObservedPlayer;
  }
}

interface Metrics {
  firstVideo: boolean;
  firstAudio: boolean;
  hasAudio: boolean;
  videoFrames: number;
  audioFrames: number;
  time: number;
  state: string | undefined;
}

function redact(value: unknown): string {
  return String(value).replace(/https?:\/\/[^\s<>"')]+/g, '[URL]').replace(/token=[^\s&]+/g, 'token=[redacted]');
}

async function exercisePlayback(browser: Browser, provider: Provider, input: string): Promise<void> {
  const page: Page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const failures: (string | Promise<string>)[] = [];
  let refusedResolves = 0;
  page.on('pageerror', error => failures.push(`Browser error: ${redact(error.message)}`));
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    // The app retries upstream failures from /api/resolve itself; a final failure surfaces in the player status.
    if (path === '/api/resolve' && response.status() >= 500) { refusedResolves++; return; }
    if (response.status() >= 400 && (path.startsWith('/api/') || path.startsWith('/vendor/'))) {
      failures.push(response.json().catch(() => null).then((body: { code?: unknown; error?: unknown } | null) =>
        `HTTP ${response.status()} from ${path}${body?.code ? ` (${redact(body.code)})` : ''}${body?.error ? `: ${redact(body.error)}` : ''}`));
    }
  });
  page.on('requestfailed', request => {
    const reason = request.failure()?.errorText || 'Network request failed';
    // Seeking and stopping intentionally abort requests that are no longer needed.
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(reason)) failures.push(redact(reason));
  });

  async function healthy(): Promise<void> {
    if (failures.length) throw new Error(await failures[0]);
    const error = await page.locator('#playback-status').evaluate(element => element.dataset.error === 'true' ? element.textContent : '');
    if (error) throw new Error(redact(error));
  }

  async function waitFor(label: string, predicate: () => Promise<boolean>, timeout = 45_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await healthy();
      if (await predicate()) return;
      await page.waitForTimeout(250);
    }
    const status = await page.locator('#playback-status').textContent();
    throw new Error(`${label} timed out. Player status: ${redact(status)}`);
  }

  async function metrics(): Promise<Metrics> {
    return page.evaluate(() => {
      const observed = window.__playbackSmoke;
      const player = observed.player;
      const stats = player?.getStats() || {};
      return {
        firstVideo: observed.firstVideo,
        firstAudio: observed.firstAudio,
        hasAudio: Boolean(player?.hasAudio()),
        videoFrames: Number(stats.videoFrameRenderCount || 0),
        audioFrames: Number(stats.audioFrameRenderCount || 0),
        time: Number(player?.currentTime || 0) / 1000,
        state: document.getElementById('player-card')?.dataset.state,
      };
    });
  }

  async function advancing(label: string): Promise<void> {
    const before = await metrics();
    await waitFor(label, async () => {
      const after = await metrics();
      return after.time > before.time + 1 && after.videoFrames > before.videoFrames + 2 &&
        (!after.hasAudio || after.firstAudio && after.audioFrames > before.audioFrames);
    });
  }

  try {
    const response = await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    assert.ok(response?.ok(), 'The player page must load successfully.');
    await page.waitForFunction(() => typeof window.AVPlayer === 'function', null, { timeout: 60_000 })
      .catch(() => { throw new Error('The player library did not load within 60 seconds.'); });
    await page.waitForFunction(() => document.documentElement.dataset.passenger === 'ready', null, { timeout: 60_000 })
      .catch(() => { throw new Error('The app did not start within 60 seconds. Is sign-in required on this deployment?'); });
    await page.evaluate(() => {
      // Observe the real decoder's events and counters; no routes, responses, or playback are mocked.
      const observed: Observed = { player: null, firstVideo: false, firstAudio: false };
      window.__playbackSmoke = observed;
      window.AVPlayer = new Proxy(window.AVPlayer, {
        construct(target, args, newTarget) {
          const player = Reflect.construct(target, args, newTarget) as ObservedPlayer;
          observed.player = player;
          player.on('firstVideoRendered', () => { observed.firstVideo = true; });
          player.on('firstAudioRendered', () => { observed.firstAudio = true; });
          return player;
        },
      });
    });
    await page.getByTestId(`provider-${provider}`).click();
    await page.getByTestId('source-input').fill(input);
    await page.getByTestId('watch-button').click();
    await waitFor('First decoded canvas frame', async () => {
      const sample = await metrics();
      return sample.firstVideo && sample.videoFrames > 0 && await page.locator('#player-mount canvas').count() > 0 &&
        await page.locator('#player-placeholder').isHidden();
    }, 75_000);
    assert.equal(await page.locator('video').count(), 0, 'Canvas playback must not create a video element.');
    const canvas = page.locator('#player-mount canvas').first();
    assert.ok(await canvas.isVisible(), 'The decoded canvas must be visible.');
    const image = await canvas.screenshot();
    assert.ok(image.byteLength > 0, 'The rendered canvas must be capturable.');
    if (await page.getByTestId('pause-button').getAttribute('aria-label') === 'Enable sound') {
      await page.getByTestId('pause-button').click();
    }
    await advancing('Initial audio/video progression');
    const initial = await metrics();

    if (provider === 'youtube' && audioLanguage) {
      const selector = page.getByTestId('audio-language');
      await selector.waitFor({ state: 'visible' });
      const tracks = await selector.locator('option').evaluateAll(options => (options as HTMLOptionElement[]).map(option => ({
        id: option.value, label: option.textContent || '', selected: option.selected,
      })));
      const original = tracks.find(track => track.selected);
      assert.match(original?.label || '', /original/i, 'A marked original track must be selected initially.');
      assert.ok(original, 'A selected audio track is required.');
      const audio = await page.evaluate(() => window.__playbackSmoke.player!.getAudioList());
      const wanted = audioLanguage.toLowerCase();
      const alternative = tracks.find(track => {
        const language = (audio.list[Number(track.id)]?.lang || '').toLowerCase();
        return track.id !== original.id && (language === wanted || language.split('-')[0] === wanted ||
          wanted.length > 2 && track.label.toLowerCase().includes(wanted));
      });
      assert.ok(alternative, `A different ${audioLanguage} dub must be available.`);
      const position = (await metrics()).time;
      await selector.selectOption(alternative.id);
      await waitFor('Audio language change', async () => page.evaluate(async id => {
        const audio = await window.__playbackSmoke.player!.getAudioList();
        return audio.selectedIndex === Number(id) && !(document.querySelector('[data-testid="audio-language"]') as HTMLSelectElement).disabled;
      }, alternative.id));
      await advancing('Audio/video progression in the selected dub');
      assert.ok((await metrics()).time >= position - 1, 'Changing language must preserve the playback position.');
      await page.getByTestId('pause-button').click();
      await waitFor('Pause before language change', async () => (await metrics()).state === 'paused');
      await selector.selectOption(original.id);
      await waitFor('Original audio restored while paused', async () => page.evaluate(async id => {
        const audio = await window.__playbackSmoke.player!.getAudioList();
        return audio.selectedIndex === Number(id) && !(document.querySelector('[data-testid="audio-language"]') as HTMLSelectElement).disabled;
      }, original.id));
      assert.equal((await metrics()).state, 'paused', 'Changing language while paused must keep playback paused.');
      await page.getByTestId('pause-button').click();
      await waitFor('Resume after audio switch', async () => (await metrics()).state === 'playing');
      await advancing('Audio/video progression with original audio restored');
      console.log(`PASS audio: original default, ${alternative.label}, position preserved, original restored while paused.`);
    }

    let transportDescription = 'ongoing live playback';
    if (provider === 'youtube') {
      await page.getByTestId('pause-button').click();
      await waitFor('Pause', async () => (await metrics()).state === 'paused');
      await page.waitForTimeout(500);
      const paused = await metrics();
      await page.waitForTimeout(1_000);
      await healthy();
      const stillPaused = await metrics();
      assert.ok(Math.abs(stillPaused.time - paused.time) <= 0.25, 'Playback time must stop while paused.');
      assert.ok(stillPaused.videoFrames <= paused.videoFrames + 1, 'Video rendering must stop while paused.');

      await page.getByTestId('pause-button').click();
      await waitFor('Resume', async () => (await metrics()).state === 'playing');
      await advancing('Resumed audio/video progression');

      const duration = Number(await page.locator('#seek-control').getAttribute('max'));
      assert.ok(duration > 100, 'YOUTUBE_VIDEO must be a public video longer than 100 seconds for the seek check.');
      await page.locator('#seek-control').evaluate(element => {
        const input = element as HTMLInputElement;
        input.value = '90';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await waitFor('Seek beyond the first minute', async () => {
        const sample = await metrics();
        return sample.time >= 89 && sample.time < 105 && await page.locator('#player-loading').isHidden();
      });
      await advancing('Audio/video progression after the 90-second seek');
      transportDescription = 'pause/resume, 90-second seek';
    } else {
      await advancing('Ongoing live audio/video progression');
    }

    await page.getByTestId('stop-button').click();
    await waitFor('Stop cleanup', () => page.evaluate(() => (
      document.getElementById('player-card')?.dataset.state === 'idle' &&
      document.getElementById('player-mount')?.childElementCount === 0
    )));
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#player-mount canvas, video').count(), 0, 'Stop must remove the renderer and leave no video element.');
    assert.equal(await page.getByTestId('player-card').getAttribute('data-state'), 'idle', 'Playback must remain stopped.');
    console.log(`PASS ${provider}: real canvas frames, ${initial.hasAudio ? 'audio/video' : 'video'} progression, ${transportDescription}, stop cleanup.` +
      (refusedResolves ? ` (upstream refused ${refusedResolves} resolve attempt${refusedResolves === 1 ? '' : 's'} before playback started)` : ''));
  } finally {
    await page.close();
  }
}

let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  console.log(`Live playback smoke against ${new URL(baseUrl).origin}`);
  await exercisePlayback(browser, 'youtube', youtubeVideo);
  if (twitchChannel) await exercisePlayback(browser, 'twitch', twitchChannel);
} catch (error) {
  console.error(`FAIL live playback smoke: ${redact(error instanceof Error ? error.message : error)}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
