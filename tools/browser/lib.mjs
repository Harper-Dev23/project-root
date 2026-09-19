// tools/browser/lib.mjs
//
// Shared plumbing for the real-browser checks in tools/browser/: headless
// Microsoft Edge driven over the DevTools protocol with Node's own WebSocket,
// a static server for the repo on a free port, trusted mouse and key events
// at GAME coordinates, and screenshots. Not part of `npm run verify` (it needs
// Edge). Written in chunk 8b, shared from 8c.
//
// Lessons baked in (each cost a debugging round in chunk 8b):
//   - Boot like a player: leave the main menu through ITS OWN SceneManager
//     (it wraps the menu's ScenePlugin, so the menu stops). window.sceneManager
//     leaves MainMenuScene running and clickable under the town, and a click
//     that falls through reaches "Start New Game" (GameState.reset()).
//   - Wait a frame before each click: Phaser drops destroyed hit zones on its
//     next update, so a click in the same frame as a redraw can hit a ghost.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.md': 'text/markdown', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Serve the repo, start headless Edge on the game, and return the driver.
 * mode: 'webgl' | 'canvas' ('canvas' disables WebGL: the LibreWolf case).
 */
export async function startBrowser({ mode = 'webgl', port = 9333, outDir = path.join(os.tmpdir(), 'browser-shots'), prefix = mode } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(REPO, p);
    if (!f.startsWith(REPO)) { res.writeHead(403); return res.end(); }
    fs.readFile(f, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const gameUrl = `http://127.0.0.1:${server.address().port}/`;

  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-'));
  const flags = mode === 'canvas'
    ? ['--disable-gpu', '--disable-webgl', '--disable-webgl2', '--disable-3d-apis']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
    '--window-size=1280,720', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required', ...flags, 'about:blank'],
    { stdio: 'ignore' });

  let targets;
  for (let i = 0; i < 50; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.find(t => t.type === 'page')) break; } catch {}
    await sleep(200);
  }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let nextId = 1;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, `${prefix}-${name}.png`), Buffer.from(r.data, 'base64'));
  };
  /** A trusted click at GAME coordinates (1280 x 720). */
  const click = async (gx, gy) => {
    await sleep(80); // let a frame pass: Phaser drops destroyed hit zones on its next update
    const { sx, sy, left, top } = await evaluate(`const c = document.querySelector('canvas').getBoundingClientRect(); return { sx: c.width / 1280, sy: c.height / 720, left: c.left, top: c.top };`);
    const x = left + gx * sx, y = top + gy * sy;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(120);
  };
  const hover = async (gx, gy) => {
    const { sx, sy, left, top } = await evaluate(`const c = document.querySelector('canvas').getBoundingClientRect(); return { sx: c.width / 1280, sy: c.height / 720, left: c.left, top: c.top };`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: left + gx * sx, y: top + gy * sy });
  };
  const key = async (k, code = k, vk = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  };

  /** Load (or reload) the game page and install the page-side helpers. */
  const loadGame = async () => {
    await send('Page.navigate', { url: gameUrl });
    for (let i = 0; i < 100; i++) {
      await sleep(200);
      try { if (await evaluate('return !!window.sceneManager?.game;')) break; } catch {}
    }
    await evaluate(`
      window.__T = {
        g: () => window.sceneManager.game,
        s: () => window.__T.g().scene.getScene('HuntFieldOverlay'),
        active: () => window.__T.g().scene.getScenes(true).map(x => x.sys.settings.key),
        // Every visible Text in a scene with its world bounds (buttons are containers).
        textsOf(key) {
          const out = [];
          const walk = (o) => { if (!o) return; if (o.type === 'Text' && o.visible !== false && o.alpha !== 0) { const b = o.getBounds(); out.push({ text: o.text, x: b.centerX, y: b.centerY }); } if (o.list) o.list.forEach(walk); };
          window.__T.g().scene.getScene(key)?.children.list.forEach(walk);
          return out;
        },
        texts() { return window.__T.textsOf('HuntFieldOverlay'); },
        uiTexts() { return window.__T.textsOf('UIScene'); },
      };
      return true;
    `);
  };

  /** Wait for the main menu, then leave it the way a player does. `setup` runs
   *  in the page first (e.g. build a party, or load a save). */
  const bootToTown = async (setup = '') => {
    await evaluate(`
      const G = window.__T.g();
      const settled = () => !G.scene.isActive('LoadingScene') && G.scene.getScene('LoadingScene').sys.settings.status !== 5;
      for (let i = 0; i < 150 && !(G.scene.isActive('MainMenuScene') && settled()); i++) await new Promise(r => setTimeout(r, 200));
      ${setup}
      G.scene.getScene('MainMenuScene').sceneManager.enterTown();
      for (let i = 0; i < 150; i++) { if (G.scene.isActive('TownScene') && G.scene.isActive('UIScene') && settled()) break; await new Promise(r => setTimeout(r, 200)); }
      await new Promise(r => setTimeout(r, 1200));
      return true;
    `);
  };

  const findText = async (re, sceneKey = 'HuntFieldOverlay') => {
    const all = await evaluate(`return window.__T.textsOf(${JSON.stringify(sceneKey)});`);
    return all.find(t => new RegExp(re).test(t.text)) || null;
  };
  const clickText = async (re, sceneKey = 'HuntFieldOverlay') => {
    const t = await findText(re, sceneKey);
    if (!t) throw new Error(`no text matching ${re} in ${sceneKey}`);
    await click(t.x, t.y);
    await sleep(150);
    return t;
  };

  const checks = [];
  const check = (label, ok, detail = '') => { checks.push({ label, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`); };

  const close = async () => {
    await send('Browser.close').catch(() => {});
    edge.kill();
    server.close();
  };

  return { mode, outDir, send, evaluate, shot, click, hover, key, loadGame, bootToTown, findText, clickText, check, checks, errors, close, sleep };
}
