/** Native lifecycle integration test against the real production build.
 * npm run build && npx electron scripts/visual-lifecycle-e2e.cjs
 * A disposable profile, synthetic audio/video and stubbed catalogue responses
 * isolate the test from saved user data and network services. No test bridge
 * or instrumentation is shipped in the app. --baseline observes an older build
 * supplied through BYTUNE_GUI_MAIN without expecting lifecycle suspension.
 */
const { app, BrowserWindow, ipcMain, contentTracing } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const backgroundOnly = process.argv.includes('--background-only');
const measureOnly = process.argv.includes('--measure-only');
const onboarding = process.argv.includes('--onboarding');
const quick = process.argv.includes('--quick');
const windowActivityOnly = process.argv.includes('--window-activity-only');
const baseline = process.argv.includes('--baseline');
const output = process.env.BYTUNE_VISUAL_RESULTS || fs.mkdtempSync(path.join(os.tmpdir(), 'bytune-visual-results-'));
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bytune-visual-profile-'));
process.env.BYTUNE_GUI_PROFILE = profile;
process.env.BYTUNE_ALLOW_MULTI = '1';
const data = path.join(profile, 'userdata', 'data');
fs.mkdirSync(data, { recursive: true });
const save = (name, value) => fs.writeFileSync(path.join(data, name + '.json'), JSON.stringify(value));
fs.writeFileSync(path.join(profile, '.bytune-install'), 'visual lifecycle test');
if (!onboarding) save('profile', { deviceId: 'dev_visual_test', createdAt: Date.now(), mode: 'guest' });
const cover = color => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/></svg>`).toString('base64');
const tracks = ['A', 'B'].map((letter, index) => ({ id: `visualtest${index}0`, title: `${letter} — A deliberately long song title that needs to scroll across the player and miniplayer`, artist: 'Visual lifecycle test artist', album: 'Lifecycle', duration: 90, thumb: cover(index ? '#7755dd' : '#dd7755') }));
save('player', { state: { queue: tracks, index: 0, position: 0, volume: 0, muted: true, shuffle: false, repeat: 'all' }, version: 0 });
save('settings', { state: { animatedCanvas: true, crossfadeSeconds: 0, smartFade: false, skipSilence: false, reduceAnimation: false }, version: 0 });
const pcm = Buffer.alloc(44 + 8000 * 90 * 2);
pcm.write('RIFF'); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(8000, 24); pcm.writeUInt32LE(16000, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(pcm.length - 44, 40);
for (let i = 0; i < 8000 * 90; i++) pcm.writeInt16LE(Math.round(1000 * Math.sin(i * Math.PI * 440 / 4000)), 44 + i * 2);
let clip = Buffer.alloc(0), baseUrl;
const server = http.createServer((req, res) => {
  const body = req.url.startsWith('/video') ? clip : pcm;
  const type = req.url.startsWith('/video') ? 'video/webm' : 'audio/wav';
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] ? Math.min(body.length - 1, Number(range[2])) : body.length - 1;
  if (start >= body.length) { res.writeHead(416); res.end(); return; }
  res.writeHead(range ? 206 : 200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}) });
  res.end(body.subarray(start, end + 1));
});
const nativeHandle = ipcMain.handle.bind(ipcMain);
const providers = {
  'music:home': () => [], 'music:charts': () => [], 'music:moods': () => [],
  'music:search': () => [], 'music:searchPage': () => ({ rows: [] }),
  'music:artist': () => ({}), 'music:enrich': () => ({}),
  'music:stream': (_event, id) => `${baseUrl}/audio/${id}`,
  'canvas:get': (_event, q) => ({ url: `${baseUrl}/video/${q.title.startsWith('B') ? 'B' : 'A'}`, source: 'test' }),
  'music:lyrics': (_event, track) => ({ plain: 'Fixture lyrics', source: 'fixture', synced: Array.from({ length: 30 }, (_, i) => ({ time: i * 3 + 0.1, text: `${track.title[0]} line ${i}`, words: [{ text: `${track.title[0]} line ${i}`, start: i * 3 + 0.1, end: i * 3 + 2.8 }] })) }),
};
ipcMain.handle = (name, handler) => nativeHandle(name, providers[name] || handler);
let main, other, pip;
const media = { position: 0, duration: 0, playing: false, title: '', metadataUpdates: 0, positionUpdates: 0 };
ipcMain.on('media:position', (e, position, duration) => { if (e.sender === main?.webContents) Object.assign(media, { position, duration, positionUpdates: media.positionUpdates + 1 }); });
ipcMain.on('media:metadata', (e, track) => { if (e.sender === main?.webContents) Object.assign(media, { title: track?.title, metadataUpdates: media.metadataUpdates + 1 }); });
ipcMain.on('menu:push-state', (e, state) => { if (e.sender === main?.webContents) media.playing = state.playing; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await sleep(50); }
  throw new Error('Timed out: ' + label);
}
const evaluate = (win, fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
const command = name => main.webContents.send('menu:command', name);
async function fullscreen(on) {
  const event = on ? 'enter-full-screen' : 'leave-full-screen';
  const settled = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { main.removeListener(event, done); reject(new Error('Native fullscreen transition timeout')); }, 20000);
    const done = () => { clearTimeout(timer); resolve(); };
    main.once(event, done);
  });
  command('now-playing');
  await settled;
  await sleep(400);
}

const results = { baseline, profile, checks: [], measurements: [], events: [] };
app.on('browser-window-created', (_e, win) => {
  for (const event of ['focus','blur','show','hide','minimize','restore','ready-to-show']) win.on(event, () => results.events.push({at: Date.now(), id: win.id, event, visible: win.isVisible(), focused: win.isFocused(), minimized: win.isMinimized()}));
});
function check(name, condition, detail) {
  results.checks.push({ name, passed: !!condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`);
  assert.ok(condition, name);
}
async function state(win) {
  return { native: { focused: win.isFocused(), visible: win.isVisible(), minimized: win.isMinimized() }, renderer: await evaluate(win, () => ({ activity: document.documentElement.dataset.windowActivity, active: document.documentElement.dataset.visualActive, visibility: document.visibilityState, focused: document.hasFocus(), size: [innerWidth, innerHeight, devicePixelRatio], animations: document.getAnimations().filter(a => a.playState === 'running').map(a => ({ name: a.animationName || 'WAAPI', target: a.effect?.target?.getAttribute?.('class') })), video: [...document.querySelectorAll('video')].map(v => ({ time: v.currentTime, paused: v.paused, frames: v.getVideoPlaybackQuality().totalVideoFrames, src: v.currentSrc, ready: v.readyState, error: v.error?.message })), title: document.querySelector('.fit-text[data-mode="auto"]')?.textContent, lyrics: [...document.querySelectorAll('.lyrics-lines button')].filter(b => b.style.opacity === '1').map(b => b.textContent) })), media: { ...media } };
}
async function expectState(win, name) {
  await until(async () => {
    if (name === 'focused' && !win.isFocused()) { app.focus({ steal: true }); win.focus(); }
    const s = await state(win);
    const native = s.native.minimized ? 'minimized' : !s.native.visible ? 'hidden' : s.native.focused ? 'focused' : 'unfocused';
    return native === name && (baseline || (s.renderer.activity === name && s.renderer.active === String(name === 'focused' && s.renderer.visibility !== 'hidden')));
  }, 'window state ' + name);
}
async function verifyWindowActivity() {
  if (process.platform !== 'darwin') throw new Error('--window-activity-only checks macOS close-to-hide');
  // DOM readiness can precede the app's ready-to-show handler. Wait for that
  // handler so its initial show cannot race a test's first blur/close.
  await until(() => results.events.some(e => e.id === main.id && e.event === 'ready-to-show'), 'native ready-to-show');
  // Read renderer attributes, not getWindowActivity(): requesting a snapshot
  // would repair a missed event and hide the regression this test detects.
  const expect = async (win, expected) => {
    await until(async () => {
      const s = await state(win);
      const native = s.native.minimized ? 'minimized' : !s.native.visible ? 'hidden' : s.native.focused ? 'focused' : 'unfocused';
      return native === expected && s.renderer.activity === expected && s.renderer.active === String(expected === 'focused');
    }, 'passive state ' + expected);
  };
  const show = async () => {
    main.show(); app.focus({ steal: true }); main.focus();
    await expect(main, 'focused');
  };
  const events = ['focus', 'blur', 'show', 'hide', 'minimize', 'restore'];
  const listeners = () => events.map(event => main.listenerCount(event));
  const beforeListeners = listeners();
  await evaluate(main, () => {
    window.__activityRevisions = [];
    window.__activityOff = window.bytune.onWindowActivity(s => window.__activityRevisions.push(s));
  });

  for (let i = 0; i < 4; i++) {
    await show();
    const eventIndex = results.events.length;
    main.blur();
    // Cocoa's blur orders out/back; wait for its occlusion hide notification
    // and for the renderer to report the still-visible, unfocused window.
    await until(() => results.events.slice(eventIndex).some(e => e.id === main.id && e.event === 'hide'), 'occlusion notification');
    await expect(main, 'unfocused');
    main.close(); // REAL application close-to-hide path, including native-call completion.
    await expect(main, 'hidden');
  }
  check('close-to-hide after occlusion reports hidden without a snapshot (4 cycles)', true);

  for (let i = 0; i < 10; i++) {
    main.close(); main.show(); main.focus();
    await expect(main, 'focused');
    main.close(); main.show(); main.close();
    await expect(main, 'hidden');
  }
  check('rapid hide/show preserves the latest state (20 bursts)', true);

  for (let i = 0; i < 3; i++) {
    await show(); main.minimize(); await expect(main, 'minimized');
    main.restore(); await show();
    main.blur(); await expect(main, 'unfocused');
    await show();
  }
  check('minimize/restore and focus/blur remain correct (3 cycles)', true);

  command('miniplayer');
  await until(() => BrowserWindow.getAllWindows().some(w => /window=pip/.test(w.webContents.getURL())), 'PiP window');
  pip = BrowserWindow.getAllWindows().find(w => /window=pip/.test(w.webContents.getURL()));
  await until(() => evaluate(pip, () => !!document.querySelector('.pip-root')), 'PiP ready');
  pip.show(); pip.focus(); await expect(pip, 'focused');
  main.close(); await expect(main, 'hidden'); await expect(pip, 'focused');
  check('hidden main does not change focused miniplayer activity', true);
  pip.minimize(); await expect(pip, 'minimized');
  pip.restore(); pip.show(); pip.focus(); await expect(pip, 'focused');
  check('miniplayer minimize/restore remains independent', true);
  pip.close();
  await show();
  check('native listener counts unchanged after repeated transitions', JSON.stringify(beforeListeners) === JSON.stringify(listeners()));
  check('renderer receives increasing revisions for only its own window', await evaluate(main, () => {
    const states = window.__activityRevisions;
    return states.length > 0 && states.every((s, i) => s.windowId === states[0].windowId && (i === 0 || s.revision > states[i - 1].revision));
  }));
  await evaluate(main, () => { window.__activityOff(); delete window.__activityOff; delete window.__activityRevisions; });
}
async function measure(name, seconds = 4, attempt = 0) {
  if (quick && name.startsWith('home-')) return;
  const expected = name.includes('hidden') ? 'hidden' : name.includes('minimized') ? 'minimized' : name.includes('unfocused') ? 'unfocused' : 'focused';
  if (attempt) {
    if (expected === 'focused') { main.show(); main.focus(); }
    if (expected === 'unfocused') { other.show(); other.focus(); }
  }
  await sleep(name.startsWith('playing-') ? 5500 : 2500);
  await expectState(main, expected);
  const before = await state(main);
  const metricsBefore = (await main.webContents.debugger.sendCommand('Performance.getMetrics')).metrics;
  const cpuBefore = app.getAppMetrics();
  const eventIndex = results.events.length;
  const started = performance.now();
  await sleep(seconds * 1000);
  const elapsed = (performance.now() - started) / 1000;
  const cpuAfter = app.getAppMetrics();
  const metricsAfter = (await main.webContents.debugger.sendCommand('Performance.getMetrics')).metrics;
  const counts = Object.fromEntries(['LayoutCount', 'RecalcStyleCount'].map(key => [key, metricsAfter.find(v => v.name === key).value - metricsBefore.find(v => v.name === key).value]));
  const cpu = cpuAfter.map(p => ({ pid: p.pid, type: p.type, percent: 100 * (p.cpu.cumulativeCPUUsage - (cpuBefore.find(b => b.pid === p.pid)?.cpu.cumulativeCPUUsage ?? p.cpu.cumulativeCPUUsage)) / elapsed }));
  const after = await state(main);
  const nativeState = s => s.minimized ? 'minimized' : !s.visible ? 'hidden' : s.focused ? 'focused' : 'unfocused';
  const events = results.events.slice(eventIndex).filter(e => e.id === main.id);
  const valid = nativeState(before.native) === expected && nativeState(after.native) === expected && events.every(e => nativeState(e) === expected && !(['focus', 'blur', 'minimize', 'restore'].includes(e.event))) && (baseline || (before.renderer.activity === expected && after.renderer.activity === expected));
  const result = { name, elapsed, valid, events, before, after, cpu, ...counts };
  results.measurements.push(result);
  console.log('MEASURE ' + JSON.stringify({ name, elapsed, valid, cpu, ...counts, activity: after.renderer.activity, running: after.renderer.animations.length }));
  if (!valid && attempt < 2) { console.log('Discarding transition sample: ' + name); return measure(name, seconds, attempt + 1); }
  if (!valid) console.warn('No stable performance interval for ' + name + '; retained as invalid, excluded from comparison.');
  return result;
}
async function run() {
  await until(() => BrowserWindow.getAllWindows().some(w => /index\.html/.test(w.webContents.getURL())), 'main created');
  main = BrowserWindow.getAllWindows().find(w => /index\.html/.test(w.webContents.getURL()));
  await until(() => evaluate(main, selector => !!document.querySelector(selector), onboarding ? '.ob-drum' : 'button[aria-label="Play"]'), 'view ready', 30000);
  if (!backgroundOnly) { app.focus({ steal: true }); main.show(); main.focus(); await expectState(main, 'focused'); }
  main.webContents.debugger.attach('1.3');
  await main.webContents.debugger.sendCommand('Performance.enable');
  if (windowActivityOnly) return verifyWindowActivity();
  if (onboarding) {
    const angles = () => evaluate(main, () => [...document.querySelectorAll('.ob-drum-ring')].map(el => el.style.getPropertyValue('--a')));
    await sleep(2000);
    const a = await angles(); await sleep(400); const b = await angles();
    check('onboarding drum moves while active', JSON.stringify(a) !== JSON.stringify(b));
    main.blur(); await expectState(main, 'unfocused'); await sleep(500);
    const c = await angles(); await sleep(600); const d = await angles();
    check('onboarding drum freezes while inactive', baseline || JSON.stringify(c) === JSON.stringify(d));
    main.focus(); await expectState(main, 'focused'); await sleep(400);
    check('onboarding drum resumes from retained pose', JSON.stringify(d) !== JSON.stringify(await angles()));
    return;
  }
  // Generate a tiny deterministic artwork clip, outside the app's rendering tree.
  clip = Buffer.from(await evaluate(main, async () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d');
    const stream = canvas.captureStream(15);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    recorder.ondataavailable = e => chunks.push(e.data);
    const finished = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();
    for (let i = 0; i < 15; i++) { context.fillStyle = i % 2 ? '#dd7755' : '#7755dd'; context.fillRect(0, 0, 64, 64); await new Promise(r => setTimeout(r, 67)); }
    recorder.stop(); await finished; stream.getTracks().forEach(t => t.stop());
    return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  }));
  other = new BrowserWindow({ width: 240, height: 120, x: 0, y: 0, show: false, title: 'Lifecycle focus target', webPreferences: { sandbox: true } });
  await other.loadURL('data:text/html,<title>Lifecycle focus target</title>Focus target');
  if (!backgroundOnly) {
    app.focus({ steal: true }); main.focus(); await sleep(400); main.focus(); await expectState(main, 'focused');
    await measure('home-focused');
  }
  other.show(); other.focus(); await sleep(400); other.focus(); await expectState(main, 'unfocused');
  await measure('home-unfocused', 10);
  if (measureOnly) {
    if (process.platform === 'darwin') main.close(); else main.hide();
    await expectState(main, 'hidden'); await measure('home-hidden');
    main.show(); main.minimize(); await expectState(main, 'minimized');
    await measure('home-minimized');
    return;
  }

  main.minimize(); await expectState(main, 'minimized'); await measure('home-minimized');
  main.restore(); main.show(); main.focus(); await expectState(main, 'focused');
  if (process.platform === 'darwin') main.close(); else main.hide();
  await expectState(main, 'hidden'); await measure('home-hidden');
  for (let i = 0; i < 3; i++) {
    app.focus({ steal: true }); main.show(); main.focus(); await expectState(main, 'focused');
    other.focus(); await expectState(main, 'unfocused');
    main.minimize(); await expectState(main, 'minimized'); await sleep(400);
    main.restore(); main.show(); main.focus(); await expectState(main, 'focused'); await sleep(400);
  }
  check('repeated focus/minimize/restore', true);
  await sleep(1200);
  command('play-pause'); await until(() => media.playing && media.position > 0, 'audio starts');
  await fullscreen(true);
  await until(() => evaluate(main, () => document.querySelector('video')?.readyState >= 2 && !!document.querySelector('.lyrics-lines')), 'lyrics and artwork ready');
  await expectState(main, 'focused'); await measure('playing-focused');
  // Save identities for marquees; registration must pause, not replace them.
  await evaluate(main, () => { window.__visualTestAnimations = document.getAnimations().filter(a => !a.animationName && a.effect?.target?.closest('.fit-text')); });
  main.blur(); other.show(); other.focus(); await sleep(400); other.focus(); await expectState(main, 'unfocused');
  const background = await measure('playing-unfocused');
  check('audio clock continues while unfocused', background.after.media.position > background.before.media.position + 2);
  if (!baseline) {
    check('decorative animations stopped while unfocused', background.after.renderer.animations.length === 0, background.after.renderer.animations);
    check('artwork decoder stopped', background.after.renderer.video.every((v, i) => v.paused && v.frames === background.before.renderer.video[i].frames));
  }
  if (!baseline) {
    await evaluate(main, () => { window.__visualTestTimes = window.__visualTestAnimations.map(a => a.currentTime); });
    await sleep(250);
    check('marquee timelines remain frozen', await evaluate(main, () => window.__visualTestAnimations.length > 0 && window.__visualTestAnimations.every((a, i) => a.playState === 'paused' && a.currentTime === window.__visualTestTimes[i])));
    main.focus(); await expectState(main, 'focused'); await sleep(300);
    check('marquee resume preserves animation objects and progress', await evaluate(main, () => {
      const current = document.getAnimations();
      return window.__visualTestAnimations.every((a, i) => current.includes(a) && a.currentTime >= window.__visualTestTimes[i]);
    }));
    other.focus(); await expectState(main, 'unfocused');
  }
  main.webContents.send('media:action', { action: 'nexttrack' });
  await until(() => media.title?.startsWith('B'), 'background media-key track advance');
  await sleep(1500);
  if (!baseline) check('new background artwork stays paused', (await state(main)).renderer.video.every(v => v.paused));
  main.focus(); await expectState(main, 'focused');
  await until(() => evaluate(main, () => document.querySelector('video')?.paused === false), 'video resumes');
  await until(() => evaluate(main, () => [...document.querySelectorAll('.lyrics-lines button')].some(b => b.style.opacity === '1' && b.textContent.startsWith('B'))), 'current resumed lyrics');
  const resumed = await state(main);
  check('new lyrics and artwork resume on current track', resumed.renderer.lyrics.some(s => s.startsWith('B')) && resumed.renderer.video[0].src.endsWith('/B'));
  await fullscreen(false);
  await fullscreen(true);
  await until(() => evaluate(main, () => document.querySelector('video')?.paused === false), 'video remount starts');
  await fullscreen(false);
  await sleep(500);
  check('repeated fullscreen lifecycle', true);
  command('miniplayer');
  await until(() => BrowserWindow.getAllWindows().some(w => /window=pip/.test(w.webContents.getURL())), 'miniplayer opens');
  pip = BrowserWindow.getAllWindows().find(w => /window=pip/.test(w.webContents.getURL()));
  await until(() => evaluate(pip, () => !!document.querySelector('.pip-root')), 'miniplayer ready');
  main.hide(); pip.show(); pip.focus(); await expectState(main, 'hidden'); await expectState(pip, 'focused');
  await sleep(2500);
  check('focused PiP independent of hidden main', baseline || (await state(pip)).renderer.active === 'true');
  const hiddenPlaying = await measure('main-hidden-pip-focused');
  check('playback continues with hidden main', hiddenPlaying.after.media.position > hiddenPlaying.before.media.position + 2);
  // Actual ended-event advancement, seeking through the same media action as Now Playing.
  main.webContents.send('media:action', { action: 'seekto', seekTime: 88 });
  await until(() => media.title?.startsWith('A'), 'automatic next track while hidden', 12000);
  await until(() => evaluate(pip, () => [...document.querySelectorAll('.fit-text')].some(el => el.textContent.startsWith('A'))), 'PiP current title');
  check('hidden track end advances and PiP receives current metadata', true);
  main.webContents.send('media:action', { action: 'pause' }); await until(() => !media.playing, 'media pause while hidden');
  const paused = media.position; await sleep(1500);
  check('background media pause remains effective', Math.abs(media.position - paused) < 1.2);
  pip.minimize(); await expectState(pip, 'minimized');
  pip.restore(); pip.show(); pip.focus(); await expectState(pip, 'focused');
  check('PiP minimize/restore', true);
  pip.close();
  app.focus({ steal: true }); main.show(); main.focus(); await expectState(main, 'focused');
  await evaluate(main, () => { delete window.__visualTestAnimations; delete window.__visualTestTimes; });
  await contentTracing.startRecording({ included_categories: ['cc', 'gpu', 'viz', 'media', 'devtools.timeline'] });
  other.focus(); await expectState(main, 'unfocused'); await sleep(1500);
  const traceFile = await contentTracing.stopRecording(path.join(output, 'trace.json'));
  results.traceFile = traceFile;
  check('native metadata and position integration remained live', media.metadataUpdates >= 3 && media.positionUpdates > 5, media);
}
server.listen(0, '127.0.0.1', () => {
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  console.log('Launching production build:', process.env.BYTUNE_GUI_MAIN || 'dist-electron/main.js');
  require('./gui-launcher.cjs');
  console.log('Production module loaded; Electron ready:', app.isReady());
  app.whenReady().then(run).then(() => { results.passed = true; }).catch(async error => { results.error = error.stack; console.error(error.stack); if (main && !main.isDestroyed()) { results.failureState = await state(main); results.failureBridge = await evaluate(main, () => window.bytune.getWindowActivity?.()); results.failureText = await evaluate(main, () => document.body.innerText.slice(-5000)); } }).finally(() => {
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log('RESULTS ' + output);
    server.close();
    app.exit(results.passed ? 0 : 1);
  });
});
setTimeout(() => { console.error('Lifecycle test watchdog'); app.exit(2); }, 300000).unref();
