import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

// Real React effects under StrictMode, with controllable layout/WAAPI clocks.
// Native CSS timelines, hover and fullscreen transitions are checked packaged.
const code = build({
  stdin: {
    contents: `
      import { StrictMode } from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { FitText } from './src/components/FitText';
      import { VisualScope, homeVisualActivity } from './src/lib/visualScope';
      import { visualActivity } from './src/lib/visualActivity';
      const root = createRoot(document.getElementById('mount'));
      window.nativeActivity = visualActivity;
      window.scopeActivity = homeVisualActivity;
      window.subscriptions = { native: 0, scope: 0 };
      for (const [key, source] of [['native', visualActivity], ['scope', homeVisualActivity]]) {
        const subscribe = source.subscribe;
        source.subscribe = fn => { subscriptions[key]++; const off = subscribe(fn); return () => { subscriptions[key]--; off(); }; };
      }
      window.render = ({playing = true, text = 'Long title', button = false, mode = 'auto'} = {}) => {
        const title = <FitText text={text} full={text + ' original'} mode={mode} autoActive={playing} />;
        flushSync(() => root.render(<StrictMode>
          <VisualScope activity={homeVisualActivity}>{button ? <button>{title}</button> : title}</VisualScope>
          <FitText text="Independent title" mode="auto" />
        </StrictMode>));
      };
      window.unmount = () => flushSync(() => root.unmount());
    `,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx",
  },
  bundle: true, format: "iife", write: false, jsx: "automatic", logLevel: "silent",
  define: { "process.env.NODE_ENV": '"development"' },
}).then(r => r.outputFiles[0].text);

async function page(t, props = {}) {
  const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window;
  const frames = new Map(); let nextFrame = 0;
  w.requestAnimationFrame = cb => { frames.set(++nextFrame, cb); return nextFrame; };
  w.cancelAnimationFrame = id => frames.delete(id);
  w.ResizeObserver = class { observe() {} unobserve() {} };
  w.matchMedia = () => ({ matches: false });
  Object.defineProperty(w.HTMLElement.prototype, 'offsetWidth', { get() { return this.textContent.startsWith('Short') ? 80 : 500; } });
  Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get() { return 200; } });
  const animations = [];
  w.Element.prototype.animate = function () {
    const a = { target: this, playState: 'running', currentTime: 1234, plays: 0, pauses: 0,
      play() { this.plays++; this.playState = 'running'; },
      pause() { this.pauses++; this.playState = 'paused'; },
      cancel() { this.playState = 'idle'; },
    };
    animations.push(a); return a;
  };
  const matches = w.Element.prototype.matches;
  w.Element.prototype.matches = function (selector) {
    if (selector === ':hover, :focus-visible') return this === w.hovered || this === w.focused;
    return matches.call(this, selector);
  };
  w.eval(await code);
  const render = props => { w.render(props); const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(0)); };
  w.nativeActivity.setActive(true);
  render(props);
  t.after(() => { w.unmount(); dom.window.close(); });
  const scope = w.document.querySelector('[data-visual-scope]');
  return { w, render, scope, animations,
    owned: () => animations.filter(a => a.playState !== 'idle' && scope.contains(a.target)),
    independent: () => animations.filter(a => a.playState !== 'idle' && !scope.contains(a.target)),
  };
}

test('pause/resume retains the same marquee and mask, with one owner under StrictMode', async t => {
  const p = await page(t);
  const pair = p.owned();
  assert.equal(pair.length, 2);
  for (let i = 0; i < 10; i++) { p.render({ playing: false }); assert.ok(pair.every(a => a.playState === 'paused')); p.render({ playing: true }); }
  assert.deepEqual(p.owned(), pair);
  assert.ok(pair.every(a => a.currentTime === 1234 && a.pauses === 10 && a.plays === 10));
  assert.equal(p.w.subscriptions.native, 2);
  assert.equal(p.w.subscriptions.scope, 2); // title and scope's DOM attribute
  p.w.unmount();
  assert.equal(p.w.subscriptions.native, 0);
  assert.equal(p.w.subscriptions.scope, 0);
});

test('native inactivity and Home coverage veto playback independently in either order', async t => {
  const p = await page(t);
  p.w.scopeActivity.setActive(false);
  assert.equal(p.scope.dataset.visualCovered, 'true');
  assert.ok(p.owned().every(a => a.playState === 'paused'));
  assert.ok(p.independent().every(a => a.playState === 'running'));
  p.w.nativeActivity.setActive(false);
  p.w.scopeActivity.setActive(true);
  p.render({ playing: false });
  p.w.nativeActivity.setActive(true);
  assert.ok(p.owned().every(a => a.playState === 'paused'));
  p.w.scopeActivity.setActive(false);
  p.render({ playing: true });
  assert.ok(p.owned().every(a => a.playState === 'paused'));
  p.w.scopeActivity.setActive(true);
  assert.ok(p.owned().every(a => a.playState === 'running'));
  assert.equal(p.scope.dataset.visualCovered, 'false');
});

test('paused hover and keyboard reading work, but cannot override a covered or inactive window', async t => {
  const p = await page(t, { playing: false });
  const el = p.scope.querySelector('.fit-text');
  assert.equal(el.tabIndex, 0);
  assert.equal(el.title, 'Long title original');
  assert.equal(el.getAttribute('aria-label'), el.title);
  for (const [key, enter, leave] of [['hovered', 'mouseenter', 'mouseleave'], ['focused', 'focusin', 'focusout']]) {
    p.w[key] = el; el.dispatchEvent(new p.w.Event(enter));
    assert.ok(p.owned().every(a => a.playState === 'running'));
    p.w.nativeActivity.setActive(false);
    assert.ok(p.owned().every(a => a.playState === 'paused'));
    p.w.nativeActivity.setActive(true);
    p.w.scopeActivity.setActive(false);
    assert.ok(p.owned().every(a => a.playState === 'paused'));
    p.w.scopeActivity.setActive(true);
    p.w[key] = null; el.dispatchEvent(new p.w.Event(leave));
    assert.ok(p.owned().every(a => a.playState === 'paused'));
  }
});

test('titles inside controls reuse their keyboard target without adding a nested tab stop', async t => {
  const p = await page(t, { playing: false, button: true });
  const button = p.scope.querySelector('button');
  assert.equal(button.querySelector('.fit-text').hasAttribute('tabindex'), false);
  p.w.focused = button; button.dispatchEvent(new p.w.Event('focusin'));
  assert.ok(p.owned().every(a => a.playState === 'running'));
  p.w.focused = null; button.dispatchEvent(new p.w.Event('focusout'));
  assert.ok(p.owned().every(a => a.playState === 'paused'));
});

test('track replacement while covered disposes old effects and resumes only the current title', async t => {
  const p = await page(t);
  const old = p.owned();
  p.w.scopeActivity.setActive(false);
  p.render({ text: 'Replacement title' });
  const current = p.owned();
  assert.equal(current.length, 2);
  assert.ok(old.every(a => a.playState === 'idle'));
  assert.ok(current.every(a => a.playState === 'paused'));
  p.w.scopeActivity.setActive(true);
  assert.ok(current.every(a => a.playState === 'running'));
  assert.ok(old.every(a => a.playState === 'idle'));
  assert.equal(p.w.subscriptions.native, 2);
});

test('short titles, hover mode and reduced motion never create automatic effects', async t => {
  const p = await page(t, { text: 'Short' });
  assert.equal(p.owned().length, 0);
  p.render({ mode: 'hover' });
  assert.equal(p.owned().length, 0);
  assert.equal(p.scope.querySelector('.fit-text').hasAttribute('tabindex'), false);
  p.w.document.documentElement.classList.add('reduce-motion');
  p.render({ text: 'Reduced motion long title' });
  assert.equal(p.owned().length, 0);
});
