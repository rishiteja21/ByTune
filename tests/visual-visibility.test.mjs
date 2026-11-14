import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Real lifecycle initialization, React/StrictMode, lyrics and marquee effects.
// Only the audio clock/settings and browser layout/animation clocks are fixtures.
const code = build({
  stdin: {
    contents: `
      import { StrictMode, act } from 'react';
      import { createRoot } from 'react-dom/client';
      import { LyricsView } from './src/components/SyncedLyrics';
      import { FitText } from './src/components/FitText';
      import { usePlayer } from './src/stores/player';
      import { initializeVisualActivity, visualActivity, visibleActivity } from './src/lib/visualActivity';
      const dispose = initializeVisualActivity();
      const root = createRoot(document.getElementById('mount'));
      Object.assign(window, { act, player: usePlayer, visualActivity, visibleActivity });
      const lyrics = { synced: Array.from({length: 10}, (_, i) => ({time: i * 3 + 0.1,
        text: 'Line ' + i, words: [{text: 'Line ' + i, start: i * 3 + 0.1, end: i * 3 + 2.9}]})) };
      window.mount = () => act(() => root.render(<StrictMode>
        <LyricsView lyrics={lyrics} loading={false} hero />
        <FitText text="Main title" mode="auto" />
        <FitText text="Miniplayer title" mode="auto" activityPolicy="visible" />
      </StrictMode>));
      window.unmount = () => act(() => { root.unmount(); dispose(); });
    `,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx',
  },
  plugins: [{ name: 'playback-fixture', setup(b) {
    b.onResolve({ filter: /(?:stores\/(player|settings)|lib\/audio)$/ }, args => ({ path: args.path.split('/').at(-1), namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'audio'
      ? 'export const getPlaybackPosition = () => window.player.getState().position;'
      : args.path === 'settings'
        ? 'export const useSettings = fn => fn({syncedLyrics:true, blurUnfocusedLyrics:true});'
        : `import { create } from 'zustand'; export const usePlayer = create(() => ({position: 1, playing: true, seek() {}}));`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'js' }));
  } }],
  bundle: true, format: 'iife', write: false, jsx: 'automatic', logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"development"' },
}).then(r => r.outputFiles[0].text);

async function page(t, windowId = 1) {
  const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window;
  w.IS_REACT_ACT_ENVIRONMENT = true;
  w.MessageChannel = class {
    port1 = {};
    port2 = { postMessage: () => setImmediate(() => this.port1.onmessage()) };
  };
  let receive, reply, revision = 0, pageVisibility = 'visible';
  w.bytune = {
    onWindowActivity(cb) { receive = cb; return () => { receive = () => {}; }; },
    getWindowActivity() { return new Promise(resolve => { reply = resolve; }); },
  };
  Object.defineProperty(w.document, 'visibilityState', { get: () => pageVisibility });
  w.matchMedia = () => ({ matches: false });
  w.ResizeObserver = class { observe() {} unobserve() {} };
  Object.defineProperty(w.HTMLElement.prototype, 'offsetWidth', { get: () => 500 });
  Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get: () => 200 });
  Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', { get: () => 400 });
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    const i = [...w.document.querySelectorAll('.lyrics-lines button')].indexOf(this);
    const scroll = w.document.querySelector('.scroll-host')?.scrollTop ?? 0;
    return { top: i < 0 ? 0 : 250 + i * 100 - scroll, height: 40 };
  };
  const frames = new Map(); let id = 0, now = 0;
  w.requestAnimationFrame = cb => { frames.set(++id, cb); return id; };
  w.cancelAnimationFrame = id => frames.delete(id);
  const animations = [];
  w.Element.prototype.animate = function () {
    const a = { target: this, playState: 'running', currentTime: 1234,
      play() { this.playState = 'running'; }, pause() { this.playState = 'paused'; }, cancel() { this.playState = 'idle'; } };
    animations.push(a); return a;
  };
  w.eval(await code);
  await w.mount();
  const frame = async () => w.act(() => { const list = [...frames.values()]; frames.clear(); now += 16; list.forEach(cb => cb(now)); });
  const native = async (state, rev = ++revision) => w.act(() => receive({ windowId, revision: rev, state,
    visible: state !== 'hidden', minimized: state === 'minimized', focused: state === 'focused' }));
  await frame();
  t.after(async () => { await w.unmount(); assert.equal(frames.size, 0); dom.window.close(); });
  return { w, frames, frame, native,
    animations: title => animations.filter(a => a.playState !== 'idle' && a.target.textContent === title),
    activeLine: () => [...w.document.querySelectorAll('.lyrics-lines button')].find(b => b.style.opacity === '1')?.textContent,
    setPosition: position => w.act(() => w.player.setState({ position })),
    setPlaying: playing => w.act(() => w.player.setState({ playing })),
    pageVisibility: value => w.act(() => { pageVisibility = value; w.document.dispatchEvent(new w.Event('visibilitychange')); }),
    reply: state => w.act(() => reply({ windowId, revision: 0, visible: true, minimized: false, focused: true, state })),
  };
}

test('native visibility and focus select independent work, including page/native disagreement and stale initialization', async t => {
  const p = await page(t);
  assert.equal(p.w.visibleActivity.getSnapshot(), false, 'wait for native state');
  await p.native('unfocused');
  await p.reply('focused');
  assert.equal(p.w.visibleActivity.getSnapshot(), true);
  assert.equal(p.w.visualActivity.getSnapshot(), false, 'late snapshot cannot restore decoration');
  await p.pageVisibility('hidden');
  assert.equal(p.w.visibleActivity.getSnapshot(), true, 'native visibility survives document occlusion');
  await p.native('hidden');
  await p.pageVisibility('visible');
  assert.equal(p.w.visibleActivity.getSnapshot(), false, 'document cannot override native hide');
  await p.native('minimized');
  assert.equal(p.w.visibleActivity.getSnapshot(), false, 'minimized vetoes even visible native flag');
  await p.native('focused');
  assert.equal(p.w.visibleActivity.getSnapshot(), true);
  assert.equal(p.w.visualActivity.getSnapshot(), true);
});

test('visible unfocused lyrics advance line and word sweep; hidden/minimized lyrics restore the current line without a catch-up glide', async t => {
  const p = await page(t);
  await p.native('focused'); await p.frame();
  await p.native('unfocused');
  await p.setPosition(4); await p.frame();
  assert.equal(p.activeLine(), 'Line 1');
  const sweep = () => p.w.document.querySelector('.lyrics-lines button[style*="opacity: 1;"] span span').style.backgroundImage;
  const first = sweep();
  await p.setPosition(5); await p.frame();
  assert.notEqual(sweep(), first);
  for (const state of ['hidden', 'minimized']) {
    await p.native(state);
    assert.equal(p.frames.size, 0, 'all lyric frame owners suspend');
    const held = p.activeLine();
    await p.setPosition(state === 'hidden' ? 10 : 19);
    assert.equal(p.activeLine(), held, 'source continues but hidden presentation holds');
    await p.native('unfocused'); await p.frame();
    const index = state === 'hidden' ? 3 : 6;
    assert.equal(p.activeLine(), 'Line ' + index);
    assert.equal(p.w.document.querySelector('.scroll-host').scrollTop, 70 + index * 100);
    assert.equal(p.frames.size, 1, 'only current word sweep remains, no catch-up glide');
  }
  await p.setPlaying(false); await p.frame();
  assert.equal(p.frames.size, 0, 'paused playback still suspends word sweep');
  await p.setPosition(22); await p.frame();
  assert.equal(p.activeLine(), 'Line 7', 'paused seeking remains functional');
});

test('rapid transitions preserve marquee identity/phase, no duplicate loops, and independent miniplayer visibility', async t => {
  const main = await page(t, 1), pip = await page(t, 2);
  await main.native('focused'); await pip.native('unfocused');
  const title = pip.animations('Miniplayer title');
  assert.equal(title.length, 2);
  assert.ok(title.every(a => a.playState === 'running'));
  assert.ok(pip.animations('Main title').every(a => a.playState === 'paused'));
  for (let i = 0; i < 12; i++) {
    await main.native(i % 2 ? 'hidden' : 'minimized');
    assert.ok(title.every(a => a.playState === 'running'), 'other window has no veto');
    await pip.native('focused'); await pip.native('unfocused');
    await pip.native(i % 2 ? 'hidden' : 'minimized');
    assert.ok(title.every(a => a.playState === 'paused'));
    assert.equal(pip.frames.size, 0);
    await pip.native('unfocused'); await pip.frame();
    assert.ok(title.every(a => a.playState === 'running' && a.currentTime === 1234));
    assert.deepEqual(pip.animations('Miniplayer title'), title);
    assert.equal(pip.frames.size, 1, 'one word sweep after restoration');
  }
});

test('artwork registration follows visibility and playback intent, including delayed play after hiding', async t => {
  const p = await page(t);
  const video = new p.w.EventTarget();
  let playing = true;
  Object.assign(video, { paused: true, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; } });
  const off = p.w.visibleActivity.registerVideo(video, () => playing);
  await p.native('focused'); assert.equal(video.paused, false);
  await p.native('unfocused'); assert.equal(video.paused, false);
  await p.native('hidden'); assert.equal(video.paused, true);
  video.paused = false; video.dispatchEvent(new p.w.Event('play'));
  assert.equal(video.paused, true);
  playing = false;
  await p.native('unfocused'); assert.equal(video.paused, true);
  playing = true;
  await p.native('minimized'); await p.native('unfocused'); assert.equal(video.paused, false);
  off(); assert.equal(video.paused, true);
});
