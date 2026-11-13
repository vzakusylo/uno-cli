#!/usr/bin/env node
/**
 * uno.js — a CLI that loads https://www.uno-special-edition.com in a real
 * browser (Playwright/Chromium) and lets you drive it from a prompt:
 * log in, create or join a table, read the board, play cards, chat.
 *
 *   node uno.js --user alice
 *   node uno.js --user bob --exec "rooms; join alice; seat"
 *   node uno.js --user alice --headless --exec "create; chat ready!" --keep
 *
 * The browser profile lives in .profiles/<user>, so your session persists.
 * Type `help` at the prompt for commands.
 */

import { chromium } from 'playwright';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://www.uno-special-edition.com';

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) out[k] = true;
      else { out[k] = n; i++; }
    } else out._.push(a);
  }
  return out;
}
const argv = parseArgs(process.argv.slice(2));

if (argv.help || argv.h) {
  console.log(`
uno.js — drive uno-special-edition.com from the command line

  --user <name>       username to log in with            (required)
  --pass <password>   password, if the account has one
  --headless          no visible browser window
  --slow <ms>         slow-motion between actions        (default 40)
  --exec "a; b; c"    run commands then exit
  --keep              with --exec or --bot, drop into the prompt afterwards

  --bot               unattended: take a table and play the match out
    --join <host>       join that player's table (otherwise host one)
    --minutes <n>       give up after n minutes          (default 15)
    --idle <sec>        give up after n seconds with no turn (default 150)
    --color <name>      colour to pick for wilds         (default red)
    --mode/--format/--players   table settings when hosting

Type 'help' at the prompt for the command list.
`);
  process.exit(0);
}
if (!argv.user) { console.error('error: --user <name> is required (see --help)'); process.exit(1); }

const USER = String(argv.user);
const PASS = argv.pass ? String(argv.pass) : '';
const PROFILE = path.join(ROOT, '.profiles', USER.replace(/[^a-z0-9_-]/gi, '_'));

/* --------------------------------------------------------------- output */

const c = {
  d: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};
const log = (...a) => console.log(...a);
const info = (...a) => console.log(c.c('·'), ...a);
const ok = (...a) => console.log(c.g('✓'), ...a);
const warn = (...a) => console.log(c.y('!'), ...a);
const fail = (...a) => console.log(c.r('✗'), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------- in-page scrapers (run in DOM) */

/** Everything worth knowing about whatever screen we are on. */
const SCRAPE = () => {
  // innerText keeps word boundaries between block elements; textContent does not.
  const t = (el) => {
    if (!el) return null;
    const s = (el.innerText || '').replace(/\s+/g, ' ').trim();
    return s || el.textContent.replace(/\s+/g, ' ').trim();
  };
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));

  const screen =
    q('.game-table, .game-board-panel') ? 'game'
    : q('.room-players-panel') ? 'waiting-room'
    : q('.home-room-list, .home-page-shell') ? 'lobby'
    : location.pathname.includes('/login') ? 'login'
    : 'other';

  const modalEl = q('ngb-modal-window, .modal.show');
  const modal = modalEl && {
    title: t(modalEl.querySelector('.modal-title')),
    text: modalEl.innerText.replace(/\s+/g, ' ').trim().slice(0, 300),
    buttons: Array.from(modalEl.querySelectorAll('button'))
      .map((b) => (b.getAttribute('aria-label') || b.textContent).replace(/\s+/g, ' ').trim())
      .filter(Boolean),
  };

  return {
    screen,
    url: location.pathname,
    heading: t(q('main h1')),
    modal,

    // --- lobby
    rooms: qa('[class*="home-room-entry"]').map((e, i) => ({
      i,
      host: t(e.querySelector('[class*="home-room-name"]')) || t(e).split(' ')[0],
      status: t(e.querySelector('[class*="home-room-status"]')),
      seats: t(e.querySelector('[class*="home-room-capacity"]')),
    })),
    online: qa('.online-user-card').map((e) =>
      (t(e.querySelector('.online-user-trigger')) || t(e) || '').replace(/\s*(Online|AFK|Offline)$/i, '')),

    // --- waiting room
    room: screen === 'waiting-room' ? {
      host: t(q('.room-subtitle strong')),
      note: t(q('.room-readiness-copy')),
      seated: qa('.room-player-card').map((e) => t(e.querySelector('.room-player-name'))),
      spectators: qa('.spectator-roster-card').map((e) => t(e)),
      startable: !!q('.room-readiness-startable, .room-start-button'),
    } : null,

    // --- game
    turn: t(q('.game-turn-chip')),
    yourTurn: !!q('.game-hand-panel-your-turn'),
    direction: t(q('.game-direction-chip')),
    topCard: (() => {
      const b = q('.last-card-button'); if (!b) return null;
      const img = b.querySelector('img');
      if (!img) return null;
      // The alt text names the card ("Last played: red change color").
      const alt = (img.alt || '').replace(/^last played:\s*/i, '').trim();
      if (alt) return alt;
      const m = (img.getAttribute('src') || '').match(/cards\/\w+\/(\d+)\/(\d+)\.png/);
      const COLORS = { 1: 'blue', 2: 'green', 3: 'red', 4: 'yellow' };
      return m ? `${COLORS[m[1]] || 'color' + m[1]} ${m[2]}` : null;
    })(),
    seats: qa('.player-seat').map((s) => ({
      name: t(s.querySelector('.player-seat-name-text')) || t(s.querySelector('.player-seat-name')),
      cards: (t(s.querySelector('.player-seat-card-count')) || '').replace(/cards?/, '').trim(),
      active: s.className.includes('player-seat-active'),
      self: s.className.includes('player-seat-self'),
    })),
    hand: qa('.game-card-button').map((b, i) => ({
      i,
      name: (b.getAttribute('aria-label') || '').replace(/^Play\s+/i, '').split('.')[0].trim(),
      why: (b.getAttribute('aria-label') || '').split('.').slice(1).join('.').trim() || null,
      playable: b.className.includes('game-card-playable'),
    })),
    feedback: t(q('.game-round-feedback')),
    activity: qa('.game-activity-entry').map(t).filter(Boolean).slice(-8),
    uno: !!qa('button').find((b) => /call uno/i.test(b.getAttribute('aria-label') || '')),

    chat: qa('.chat-message').slice(-8).map((e) => t(e).slice(0, 160)),
  };
};

/* ---------------------------------------------------------------- client */

class Uno {
  constructor(page) { this.page = page; }

  state() { return this.page.evaluate(SCRAPE); }

  async settle(ms = 700) {
    await this.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await sleep(ms);
  }

  async goto(p = '/') {
    await this.page.goto(BASE + p, { waitUntil: 'domcontentloaded' });
    await this.settle(1200);
  }

  async login() {
    await this.goto('/game');
    if (!this.page.url().includes('/login')) { ok(`signed in as ${c.b(USER)}`); return; }
    info(`signing in as ${USER}…`);
    const name = this.page.getByPlaceholder('Your username');
    await name.waitFor({ timeout: 15000 });
    await name.fill(USER);
    if (PASS) await this.page.locator('input[type="password"]').first().fill(PASS);
    await this.page.getByRole('button', { name: /continue/i }).click();
    try {
      await this.page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 });
    } catch {
      const msg = await this.page
        .locator('.invalid-feedback, .alert, [class*="error"]')
        .first().innerText().catch(() => '');
      throw new Error(
        `login as "${USER}" did not go through${msg ? ': ' + msg.replace(/\s+/g, ' ').trim() : ''}` +
        '\n  (the same username may already be connected elsewhere, or the password is wrong)'
      );
    }
    await this.settle(1200);
    ok(`signed in as ${c.b(USER)}`);
  }

  /* -- lobby ------------------------------------------------------------ */

  /** The lobby list is only reliably fresh after a load, so reload by default. */
  async rooms(reload = true) {
    if (reload || (await this.state()).screen !== 'lobby') await this.goto('/');
    return (await this.state()).rooms;
  }

  async create({ mode = 'Classic', format = '1v1', players = '2', password = '' } = {}) {
    if ((await this.state()).screen !== 'lobby') await this.goto('/');
    await this.page.getByRole('button', { name: 'Create New' }).click();
    await this.page.getByRole('button', { name: /^Game$/ }).click();
    const d = this.page.getByRole('dialog');
    await d.waitFor({ timeout: 10000 });
    const sel = d.locator('select');
    const n = await sel.count();
    if (n > 0) await sel.nth(0).selectOption({ label: mode }).catch(() => warn(`mode "${mode}"?`));
    if (n > 1) await sel.nth(1).selectOption({ label: format }).catch(() => {});
    if (n > 2) await sel.nth(2).selectOption({ label: String(players) }).catch(() => {});
    if (password) await d.locator('input[type="password"]').first().fill(password);
    await d.getByRole('button', { name: /create game/i }).click();
    await this.page.waitForURL(/waiting-room|\/game/, { timeout: 20000 });
    await this.settle(1200);
    ok(`table created (${mode}, ${format}) — you are the host`);
  }

  /** Open a table. You land as a spectator; `seat` takes a seat. */
  async join(target) {
    if (String(target).startsWith('http')) {
      await this.page.goto(target, { waitUntil: 'domcontentloaded' });
    } else {
      const list = this.page.locator('[class*="home-room-entry"]');
      const find = () => (/^\d+$/.test(target)
        ? list.nth(Number(target))
        : list.filter({ hasText: new RegExp(target, 'i') }).first());
      // The table may have been created seconds ago — reload a few times.
      let entry = null;
      for (let tries = 0; tries < 4; tries++) {
        await this.goto('/');
        const e = find();
        if (await e.count()) { entry = e; break; }
        if (tries < 3) { info(`no table "${target}" yet, retrying…`); await sleep(3000); }
      }
      if (!entry) return fail(`no open table matching "${target}" (try 'rooms')`);
      await entry.click();
    }
    await this.settle(1800);
    const s = await this.state();
    ok(`at ${s.room?.host ? `${s.room.host}'s table` : this.page.url()} — ${
      s.room?.seated?.length ?? '?'} seated. Use 'seat' to take a seat.`);
  }

  async seat() {
    const b = this.page.getByRole('button', { name: /join room/i }).first();
    if (!(await b.count())) return warn('no "Join Room" button — already seated, or the table is full');
    await b.click();
    await this.settle(1500);
    ok('seated at the table');
  }

  async start() {
    const b = this.page.getByRole('button', { name: /^start game$/i }).first();
    if (!(await b.count())) return warn('no Start game button (host only, and 2+ players must be seated)');
    await b.click();
    await sleep(1500);
    await this.ready();
    await this.page.waitForURL(/\/game/, { timeout: 30000 }).catch(() => {});
    await this.settle(2500);
    ok('game started');
  }

  async ready() {
    const b = this.page.getByRole('button', { name: /i'?m ready/i }).first();
    if (!(await b.count())) return;
    await b.click();
    await sleep(1200);
    ok("marked ready");
  }

  async leave() {
    const b = this.page.getByRole('button', { name: /^exit$/i }).first();
    if (await b.count()) { await b.click().catch(() => {}); await sleep(1200); }
    const y = this.page.getByRole('button', { name: /^(yes|confirm|leave|exit)$/i }).first();
    if (await y.count()) await y.click().catch(() => {});
    await this.settle(1200);
    ok('left the table');
  }

  /* -- playing ---------------------------------------------------------- */

  /** Play by hand index, or by name fragment ("red seven", "wild", "skip"). */
  async play(which, color) {
    const s = await this.state();
    if (!s.hand.length) return fail('no cards on screen — are you in a running game?');
    let card;
    if (/^\d+$/.test(which)) card = s.hand[Number(which)];
    else {
      const q = String(which || '').toLowerCase().replace(/[-_]/g, ' ');
      const hits = s.hand.filter((h) => h.name.toLowerCase().includes(q));
      card = hits.find((h) => h.playable) || hits[0];
    }
    if (!card) return fail(`no card matching "${which}" — run 'hand'`);
    if (!card.playable) warn(`${card.name} is not playable${card.why ? ' — ' + card.why : ''}; clicking anyway`);

    await this.page.locator('.game-card-button').nth(card.i).click({ timeout: 8000 });
    await sleep(1200);
    ok(`played ${c.b(card.name)}`);
    if (await this.pickColor(color)) return;
    await this.maybeUno();
  }

  async draw() {
    const b = this.page.locator('.game-draw-button').first();
    if (!(await b.count())) return fail('no draw pile on screen');
    await b.click({ timeout: 8000 });
    await sleep(1400);
    ok('drew a card');
    const s = await this.state();
    if (s.modal) log(c.y('  ') + s.modal.text + c.d('   → use `playnow` or `keep`'));
  }

  /** Answer the "Auto-play this card?" modal. */
  async modalChoice(which, color) {
    const label = which === 'keep' ? /keep in hand/i : /play card/i;
    const b = this.page.locator('ngb-modal-window, .modal.show').getByRole('button', { name: label }).first();
    if (!(await b.count())) return fail('no auto-play prompt on screen');
    await b.click();
    await sleep(1200);
    ok(which === 'keep' ? 'kept the card' : 'played the drawn card');
    if (which !== 'keep') { if (await this.pickColor(color)) return; await this.maybeUno(); }
  }

  /** Choose a colour if a wild prompt is showing. Returns true if it handled one. */
  async pickColor(color) {
    const re = /^(red|blue|green|yellow)\b/i;
    const btns = this.page.locator('button').filter({ hasText: re });
    const byLabel = this.page.locator(
      'button[aria-label^="Red" i], button[aria-label^="Blue" i], button[aria-label^="Green" i], button[aria-label^="Yellow" i]'
    );
    const pool = (await byLabel.count()) ? byLabel : btns;
    if (!(await pool.count())) return false;
    if (!color) {
      const names = await pool.evaluateAll((els) =>
        els.map((e) => (e.getAttribute('aria-label') || e.textContent).replace(/\s+/g, ' ').trim()));
      warn(`a colour must be chosen: ${names.join(', ')}  → run 'color <name>'`);
      return true;
    }
    const pick = pool.filter({ hasText: new RegExp(color, 'i') }).first();
    const target = (await pick.count()) ? pick
      : this.page.locator(`button[aria-label^="${color}" i]`).first();
    if (!(await target.count())) { warn(`no "${color}" button on screen`); return true; }
    await target.click();
    await sleep(1000);
    ok(`chose ${color}`);
    await this.maybeUno();
    return true;
  }

  async uno() {
    const b = this.page.locator('button[aria-label*="UNO" i]').first();
    if (!(await b.count())) return fail('no UNO button showing');
    await b.click();
    ok('called UNO!');
  }

  async maybeUno() {
    const b = this.page.locator('button[aria-label*="Call UNO" i]').first();
    if (await b.count()) { await b.click().catch(() => {}); ok('called UNO!'); }
  }

  /** Simple bot: take `turns` turns, playing the first playable card. */
  async auto(turns = 10, { color = 'red', delay = 1200, maxWait = 120000 } = {}) {
    let idleSince = Date.now();
    for (let n = 0; n < turns; n++) {
      if (Date.now() - idleSince > maxWait) { warn('auto: nothing to do for a while, stopping'); return; }
      const s = await this.state();
      if (s.screen === 'waiting-room') {
        // Sit tight until the host starts; answer the readiness prompt.
        await this.ready().catch(() => {});
        await sleep(delay); n--; continue;
      }
      if (s.screen !== 'game') { warn('not in a game'); return; }
      if (s.modal) {
        const playable = /play it now/i.test(s.modal.text);
        await this.modalChoice(playable ? 'playnow' : 'keep', color).catch(() => {});
        continue;
      }
      if (!s.yourTurn) { await sleep(delay); n--; continue; }
      idleSince = Date.now();
      const card = s.hand.find((h) => h.playable);
      log(c.d(`[auto ${n + 1}/${turns}] top ${s.topCard} — ` +
        (card ? `playing ${card.name}` : 'drawing')));
      if (card) await this.play(String(card.i), color).catch((e) => fail(e.message));
      else await this.draw().catch((e) => fail(e.message));
      await sleep(delay);
    }
    ok('auto run finished');
  }

  /**
   * Unattended bot: sits at a table and plays until the match is decided
   * (or `maxMs` runs out). Handles readiness, turns, wilds, UNO, the
   * auto-play prompt and whatever end-of-round screens come up.
   */
  async playout({ maxMs = 15 * 60 * 1000, color = 'red', delay = 900, host = false,
                  idleMs = 150000 } = {}) {
    const t0 = Date.now();
    let idleSince = Date.now();
    let lastSeen = '';
    const seenLog = new Set();

    const note = (s) => {
      for (const line of s.activity || []) {
        if (!seenLog.has(line)) { seenLog.add(line); log(c.d('  ' + line)); }
      }
    };

    info(`bot running (up to ${Math.round(maxMs / 60000)} min) — Ctrl-C to stop`);

    while (Date.now() - t0 < maxMs) {
      let s;
      try { s = await this.state(); }
      catch { await sleep(delay); continue; }

      // A dialog always takes priority.
      if (s.modal) {
        if (await this.handleModal(s.modal, color)) { idleSince = Date.now(); continue; }
      }

      if (s.screen === 'waiting-room') {
        await this.ready().catch(() => {});
        if (host && s.room?.startable) {
          info('two players seated — starting');
          await this.start().catch((e) => fail(e.message.split('\n')[0]));
          idleSince = Date.now();
        }
        await sleep(delay);
        if (Date.now() - idleSince > 180000) { warn('bot: nobody joined, stopping'); return; }
        continue;
      }

      if (s.screen !== 'game') {
        // Back in the lobby (or elsewhere) — the table is over for us.
        info('bot: no longer at a table, stopping');
        return;
      }

      note(s);

      // Match or round decided?
      const done = this.matchResult(s);
      if (done) { ok(`bot: ${done}`); return; }

      if (!s.yourTurn) {
        if (Date.now() - idleSince > idleMs) {
          warn(`bot: no turn for ${Math.round(idleMs / 1000)}s, stopping (raise it with --idle)`);
          return;
        }
        await sleep(delay);
        continue;
      }
      idleSince = Date.now();

      const card = s.hand.find((h) => h.playable);
      const sig = `${s.topCard}|${s.hand.length}`;
      if (sig !== lastSeen) { log(c.d(`  top ${s.topCard} · ${s.hand.length} cards in hand`)); lastSeen = sig; }

      try {
        if (card) await this.play(String(card.i), color);
        else await this.draw();
      } catch (e) { fail(e.message.split('\n')[0]); await sleep(delay); }
      await sleep(delay);
    }
    warn('bot: time limit reached');
  }

  /** Read win/lose text off the board, if the round or match is over. */
  matchResult(s) {
    const hay = [s.feedback, s.heading, ...(s.activity || []).slice(-3)].filter(Boolean).join(' ');
    const m = hay.match(/[^.!]*\b(wins the game|won the game|wins the match|final standings|game over)\b[^.!]*/i);
    return m ? m[0].trim() : null;
  }

  /**
   * Click the sensible button in whatever modal is up.
   * Returns true if something was clicked.
   */
  async handleModal(modal, color = 'red') {
    const box = this.page.locator('ngb-modal-window, .modal.show').first();
    const click = async (re, what) => {
      const b = box.getByRole('button', { name: re }).first();
      if (!(await b.count())) return false;
      await b.click().catch(() => {});
      await sleep(1000);
      ok(what);
      return true;
    };

    // "Auto-play this card?" — play it, then answer any colour prompt.
    if (/auto-play this card/i.test(modal.text)) {
      if (await click(/play card/i, 'played the drawn card')) {
        await this.pickColor(color);
        await this.maybeUno();
        return true;
      }
      return click(/keep in hand/i, 'kept the card');
    }
    // Wild colour choice.
    if (/choose the next colou?r/i.test(modal.text)) {
      await this.pickColor(color);
      return true;
    }
    // "Stack a +2/+4?" — pass the penalty on if we can, else take the cards.
    if (/stack a \+\d/i.test(modal.text) || /confirm stack/i.test(modal.buttons.join(' '))) {
      if (process.env.UNO_DEBUG) {
        const html = await box.evaluate((e) =>
          e.innerHTML.replace(/_ngcontent-[^=]*=""/g, '').replace(/\s+/g, ' ')).catch(() => '');
        log(c.d('  stack-modal html: ' + html.slice(0, 2500)));
      }
      // Pick one of the offered matching cards (the hand preview is not clickable).
      const pick = box.locator('button.game-stacking-option').first();
      if (await pick.count()) {
        await pick.click({ timeout: 3000 }).catch(() => {});
        await sleep(400);
      }
      const confirm = box.getByRole('button', { name: /confirm stack/i }).first();
      if ((await confirm.count()) && (await confirm.isEnabled().catch(() => false))) {
        await confirm.click().catch(() => {});
        await sleep(1000);
        ok('stacked the penalty');
        await this.pickColor(color);
        await this.maybeUno();
        return true;
      }
      if (await click(/decline and draw/i, 'took the penalty cards')) return true;
      return click(/decline stacking/i, 'declined stacking');
    }
    // Round / match summaries and the readiness prompt.
    for (const [re, what] of [
      [/next round|continue|play again/i, 'moved on'],
      [/i'?m ready/i, 'marked ready'],
      [/^(ok|got it|close)$/i, 'dismissed the dialog'],
    ]) if (await click(re, what)) return true;

    // A dialog with nothing to click is just a countdown — wait it out.
    if (!modal.buttons.length) return false;

    if (modal.text !== this._lastUnhandled) {
      this._lastUnhandled = modal.text;
      log(c.y('  unhandled dialog: ') + modal.text.slice(0, 160) +
        c.d('  buttons: ' + modal.buttons.join(' / ')));
      if (process.env.UNO_DEBUG) {
        const html = await box.evaluate((e) =>
          e.innerHTML.replace(/_ngcontent-[^=]*=""/g, '').replace(/\s+/g, ' ')).catch(() => '');
        log(c.d('  html: ' + html.slice(0, 2500)));
      }
    }
    return false;
  }

  /* -- misc ------------------------------------------------------------- */

  async chat(msg) {
    const box = this.page.getByPlaceholder('Write a message...').first();
    if (!(await box.count())) return fail('no chat box on this screen');
    await box.fill(msg);
    await box.press('Enter');
    ok(`said: ${msg}`);
  }

  /** Print new activity-log lines until `ms` elapses. */
  async watch(ms = 60000) {
    info(`watching for ${Math.round(ms / 1000)}s (Ctrl-C to stop)…`);
    const seen = new Set();
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const s = await this.state().catch(() => null);
      if (s) {
        for (const line of [...s.activity, ...s.chat]) {
          if (!seen.has(line)) { seen.add(line); log(c.d('  ' + line)); }
        }
        if (s.yourTurn) { ok('your turn!'); return; }
      }
      await sleep(1500);
    }
    info('watch ended');
  }

  async shot(file) {
    const f = path.resolve(ROOT, file || `shot-${Date.now()}.png`);
    await this.page.screenshot({ path: f });
    ok('screenshot → ' + f);
  }

  probe() {
    return this.page.evaluate(() => {
      const main = document.querySelector('main') || document.body;
      const names = new Set();
      main.querySelectorAll('*').forEach((e) => {
        const cl = (e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className) || '';
        String(cl).split(/\s+/).forEach((n) => { if (n && !n.startsWith('ng-')) names.add(n); });
      });
      return [...names].sort();
    });
  }
}

/* -------------------------------------------------------------- printing */

function render(s) {
  const L = [];
  L.push(`${c.b(s.screen)} ${c.d(s.url)}${s.heading ? '  ' + s.heading : ''}`);

  if (s.screen === 'lobby') {
    L.push(c.b('open tables'));
    if (!s.rooms.length) L.push(c.d('  none'));
    s.rooms.forEach((r) => L.push(`  [${r.i}] ${r.host}  ${c.d(`${r.status || ''} ${r.seats || ''}`)}`));
    if (s.online.length) L.push(c.b('online') + '  ' + s.online.join(', '));
  }

  if (s.screen === 'waiting-room' && s.room) {
    L.push(`${c.b('host')} ${s.room.host}   ${c.d(s.room.note || '')}`);
    L.push(`${c.b('seated')} ${s.room.seated.join(', ') || '—'}`);
    if (s.room.spectators.length) L.push(`${c.b('watching')} ${s.room.spectators.join(', ')}`);
    if (s.room.startable) L.push(c.g('  ready to start — run `start`'));
  }

  if (s.screen === 'game') {
    L.push(`${c.b('turn')} ${s.turn || '?'}${s.yourTurn ? c.g('  ← YOU') : ''}   ${c.d(s.direction || '')}`);
    L.push(`${c.b('pile')} ${s.topCard || '?'}`);
    L.push(`${c.b('seats')} ` + s.seats.map((p) =>
      `${p.active ? c.g(p.name) : p.name}${p.self ? '(you)' : ''}:${p.cards}`).join('  '));
    if (s.hand.length) {
      L.push(c.b('hand'));
      s.hand.forEach((h) => L.push(
        `  [${h.i}] ${h.playable ? c.g('●') : c.d('○')} ${h.name}${h.why ? c.d('  ' + h.why) : ''}`));
    }
    if (s.uno) L.push(c.y('  UNO can be called — run `uno`'));
    if (s.activity.length) { L.push(c.b('log')); s.activity.slice(-5).forEach((a) => L.push(c.d('  ' + a))); }
  }

  if (s.modal) L.push(c.y(`modal: ${s.modal.title || ''} — ${s.modal.buttons.join(' / ')}`));
  if (s.chat.length && s.screen !== 'game') {
    L.push(c.b('chat')); s.chat.slice(-5).forEach((m) => L.push(c.d('  ' + m)));
  }
  return L.join('\n');
}

const HELP = `
  ${c.b('lobby')}
    rooms                       list open tables
    create [mode] [fmt] [n]     host a table      (Classic 1v1 2)
    join <host|index|url>       open a table (you arrive as a spectator)
    seat                        take a seat at the table
    start                       start the game (host)
    ready                       confirm you are ready
    leave                       exit the table

  ${c.b('game')}
    state  (s)                  show the board
    hand                        list your cards
    play <i|name> [color]       play a card; color is for wilds
    draw                        draw from the deck
    playnow [color] / keep      answer the "auto-play this card?" prompt
    color <red|blue|green|yellow>   pick a colour after a wild
    uno                         call UNO!
    auto [turns] [color]        let the bot take some turns
    playout [min] [color] [host]  bot plays the whole match to the end
    watch [seconds]             stream the log until it is your turn

  ${c.b('other')}
    chat <message>              send a chat message
    shot [file.png] · probe · eval <js> · url · help · exit
`;

/* ------------------------------------------------------------- dispatcher */

async function run(uno, line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(' ');
  switch ((cmd || '').toLowerCase()) {
    case '': return;
    case 'help': case '?': return log(HELP);

    case 'lobby': return uno.goto('/');
    case 'rooms': {
      const r = await uno.rooms();
      if (!r.length) return info('no open tables');
      return r.forEach((x) => log(`[${x.i}] ${x.host}  ${c.d(`${x.status || ''} ${x.seats || ''}`)}`));
    }
    case 'create': return uno.create({
      mode: rest[0] ? rest[0][0].toUpperCase() + rest[0].slice(1) : 'Classic',
      format: rest[1] || '1v1',
      players: rest[2] || '2',
    });
    case 'join': return uno.join(arg);
    case 'seat': return uno.seat();
    case 'start': return uno.start();
    case 'ready': return uno.ready();
    case 'leave': return uno.leave();

    case 'state': case 's': return log(render(await uno.state()));
    case 'hand': {
      const h = (await uno.state()).hand;
      if (!h.length) return warn('no cards on screen');
      return h.forEach((x) => log(`[${x.i}] ${x.playable ? c.g('●') : c.d('○')} ${x.name}${x.why ? c.d('  ' + x.why) : ''}`));
    }
    case 'play': return uno.play(rest[0], rest[1]);
    case 'draw': return uno.draw();
    case 'playnow': return uno.modalChoice('playnow', rest[0]);
    case 'keep': return uno.modalChoice('keep');
    case 'color': case 'colour': return uno.pickColor(rest[0]);
    case 'uno': return uno.uno();
    case 'auto': return uno.auto(Number(rest[0]) || 10, { color: rest[1] || 'red' });
    case 'playout': case 'bot': return uno.playout({
      maxMs: (Number(rest[0]) || 15) * 60000,
      color: rest[1] || 'red',
      host: /host/i.test(arg),
    });
    case 'watch': return uno.watch((Number(rest[0]) || 60) * 1000);

    case 'chat': case 'say': return uno.chat(arg);
    case 'shot': return uno.shot(rest[0]);
    case 'probe': return log((await uno.probe()).join(' '));
    case 'eval': return log(await uno.page.evaluate(`(()=>(${arg}))()`));
    case 'url': return log(uno.page.url());
    case 'exit': case 'quit': return 'EXIT';
    default: return fail(`unknown command: ${cmd}  (try 'help')`);
  }
}

/* ------------------------------------------------------------------ main */

async function main() {
  fs.mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: !!argv.headless,
    slowMo: Number(argv.slow ?? 40),
    viewport: { width: 1280, height: 900 },
    args: ['--window-size=1300,980'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const uno = new Uno(page);
  if (process.env.UNO_DEBUG)
    page.on('console', (m) => m.type() === 'error' && log(c.d('[page] ' + m.text())));

  await uno.login();

  // Unattended: host or join a table and play the match out, then exit.
  if (argv.bot) {
    const color = argv.color ? String(argv.color) : 'red';
    const minutes = Number(argv.minutes) || 15;
    // Humans think slowly; give a real opponent plenty of rope.
    const idleMs = (Number(argv.idle) || 150) * 1000;
    if (argv.join && argv.join !== true) {
      await uno.join(String(argv.join));
      await uno.seat();
      await uno.playout({ maxMs: minutes * 60000, color, host: false, idleMs });
    } else {
      await uno.create({
        mode: argv.mode ? String(argv.mode) : 'Classic',
        format: argv.format ? String(argv.format) : '1v1',
        players: argv.players ? String(argv.players) : '2',
      });
      await uno.playout({ maxMs: minutes * 60000, color, host: true, idleMs });
    }
    if (!argv.keep) { await ctx.close(); return; }
  }

  if (argv.exec) {
    for (const cmd of String(argv.exec).split(';')) {
      if (!cmd.trim()) continue;
      log(c.d('> ' + cmd.trim()));
      try { if ((await run(uno, cmd)) === 'EXIT') break; } catch (e) { fail(e.message.split('\n')[0]); }
    }
    if (!argv.keep) { await ctx.close(); return; }
  }

  log(HELP);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${USER}> ` });
  rl.prompt();
  rl.on('line', async (line) => {
    try { if ((await run(uno, line)) === 'EXIT') return rl.close(); }
    catch (e) { fail(e.message.split('\n')[0]); }
    rl.prompt();
  });
  await new Promise((r) => rl.on('close', r));
  await ctx.close();
}

main().catch((e) => { fail(e.stack || e.message); process.exit(1); });
