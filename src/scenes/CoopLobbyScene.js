// src/scenes/CoopLobbyScene.js
//
// The co-op lobby: connect to a server, host or join by code, choose which of
// your hunters to bring, and start the fight.
//
// Scoped to TRAINING scenarios on purpose. The exploration/hunt gate will want
// its own entry point later, but nothing here assumes exploration exists, and
// the shared party of six is the game's own existing party cap rather than a
// multiplayer invention.
//
// The scene holds no rules. Whether an action is legal, whose turn it is and
// what the board looks like are all the server's to decide; this collects a
// few choices and renders what comes back.

import GameState from '../systems/GameState.js';
import { COMBAT_SCENARIOS } from '../../data/combatScenarios.js';
import { COLORS, FONTS, MENU_THEME } from '../ui/styles.js';
import { createPanel } from '../ui/GamePanel.js';
import { createButton } from '../ui/Button.js';
import { createCoopClient, CoopStatus } from '../systems/CoopClient.js';
import { toWireCharacter } from '../systems/CoopWire.js';

const SERVER_KEY = 'coop_server_url';
const DEFAULT_SERVER = 'ws://localhost:8787';
const PARTY_LIMIT = 6;

export default class CoopLobbyScene extends Phaser.Scene {
  constructor() {
    super({ key: 'CoopLobbyScene' });
  }

  init(data = {}) {
    // Scenarios the player has actually unlocked, passed in by whoever opened
    // the lobby, so this scene never has to know the progression rules.
    this.scenarioIds = data.scenarioIds?.length ? data.scenarioIds : ['training_encounter_1'];
    this.scenarioIndex = Math.max(0, this.scenarioIds.indexOf(data.scenarioId));
    if (this.scenarioIndex < 0) this.scenarioIndex = 0;

    this.client = null;
    this.chosen = new Set();      // instanceIds of hunters we are bringing
    this.statusLine = '';
    this._unsubs = [];
    this._handingOff = false;
  }

  create() {
    const { width, height } = this.scale;
    this.add.rectangle(0, 0, width, height, COLORS.background)
      .setOrigin(0).setDepth(-1);

    this.add.text(width / 2, 44, 'CO-OP TRAINING', {
      ...FONTS.heading, color: MENU_THEME.titleColor,
    }).setOrigin(0.5);

    this.add.text(width / 2, 76,
      'Six hunters between everyone, split any way you like.',
      { ...FONTS.body, color: '#9aa0aa' }).setOrigin(0.5);

    this._buildConnectRow(width);
    this._buildRoster(width);
    this._buildLobbyPanel(width);
    this._buildFooter(width, height);

    // Default the party to whoever is already in the player's party, trimmed
    // to the cap. A player who wants to bring fewer un-picks them.
    for (const c of (GameState.party || []).slice(0, PARTY_LIMIT)) {
      this.chosen.add(c.instanceId || c.id);
    }
    this._refresh();

    this.events.once('shutdown', () => {
      // Always drop the listeners; this scene is about to stop existing.
      for (const off of this._unsubs) { try { off(); } catch { } }
      this._unsubs = [];

      // But do NOT close the socket when we are handing the fight over.
      // scene.start('CombatScene') shuts this scene down, so disconnecting
      // here killed the very connection the fight was about to use — the
      // players reached combat and immediately "lost connection to the
      // server". Only a real exit closes it.
      if (!this._handingOff) this.client?.disconnect();

      this.serverInput?.destroy();
      this.codeInput?.destroy();
      this.nameInput?.destroy();
    });
  }

  // ---- layout -------------------------------------------------------------

  _buildConnectRow(width) {
    createPanel(this, 40, 100, width - 80, 86, 'silverMenu');

    // One row, everything on the same baseline. Labels sat above their fields
    // in the first pass, which read as two unrelated rows of controls.
    const rowY = 143;
    const label = (x, text) => this.add.text(x, rowY, text,
      { ...FONTS.body, fontSize: '16px', color: '#c8ccd4' }).setOrigin(0, 0.5);

    const saved = (() => {
      try { return localStorage.getItem(SERVER_KEY); } catch { return null; }
    })() || DEFAULT_SERVER;

    label(60, 'Server');
    this.serverInput = this.add.dom(320, rowY).createFromHTML(`
      <input type="text" name="server" value="${saved}" spellcheck="false"
        style="font-size:15px;padding:6px;width:340px;
               background-color:#22242a;color:#e8eaf0;border:1px solid #555;">
    `);

    label(520, 'You');
    this.nameInput = this.add.dom(645, rowY).createFromHTML(`
      <input type="text" name="playerName" maxlength="18" placeholder="Your name"
        spellcheck="false"
        style="font-size:15px;padding:6px;width:150px;
               background-color:#22242a;color:#e8eaf0;border:1px solid #555;">
    `);

    this.hostBtn = createButton(this, 810, rowY, 'Host', () => this._host());
    this.codeInput = this.add.dom(930, rowY).createFromHTML(`
      <input type="text" name="code" maxlength="6" placeholder="CODE" spellcheck="false"
        style="font-size:15px;padding:6px;width:90px;text-transform:uppercase;
               text-align:center;letter-spacing:2px;
               background-color:#22242a;color:#e8eaf0;border:1px solid #555;">
    `);
    this.joinBtn = createButton(this, 1055, rowY, 'Join', () => this._join());
  }

  _buildRoster(width) {
    createPanel(this, 40, 200, 560, 300, 'silverMenu');
    this.add.text(60, 214, 'Bring which hunters?', { ...FONTS.body, color: '#c8ccd4' });
    this.rosterHint = this.add.text(60, 240, '', { ...FONTS.muted, color: '#8a8f98' });

    this.rosterRows = (GameState.party || []).slice(0, 8).map((char, i) => {
      const y = 272 + i * 28;
      const label = this.add.text(66, y, '', { ...FONTS.body, fontSize: '16px' })
        .setInteractive({ useHandCursor: true });
      label.on('pointerdown', () => this._toggleHunter(char));
      return { char, label };
    });
  }

  _buildLobbyPanel(width) {
    createPanel(this, 620, 200, width - 660, 300, 'silverMenu');
    this.lobbyTitle = this.add.text(640, 214, 'Not connected',
      { ...FONTS.body, color: '#c8ccd4' });
    this.partyCount = this.add.text(width - 60, 214, '', { ...FONTS.body, color: '#c8ccd4' })
      .setOrigin(1, 0);

    // An empty bordered box tells a player nothing. This says what to do.
    this.lobbyHint = this.add.text(646, 252,
      ['Host a hunt, then read the code to a friend.',
       'Or type their code and Join.'],
      { ...FONTS.body, fontSize: '15px', color: '#7d838d', lineSpacing: 6 });

    this.playerRows = [];
    for (let i = 0; i < 6; i++) {
      this.playerRows.push(this.add.text(646, 250 + i * 30, '',
        { ...FONTS.body, fontSize: '16px' }));
    }
  }

  _buildFooter(width, height) {
    this.add.text(width / 2, 528, 'FIGHT',
      { ...FONTS.muted, fontSize: '12px', color: '#7d838d' }).setOrigin(0.5);
    this.scenarioText = this.add.text(width / 2, 552,
      '', { ...FONTS.body, fontSize: '20px', color: MENU_THEME.titleColor }).setOrigin(0.5);
    this.prevScenario = createButton(this, width / 2 - 180, 548, '<',
      () => this._cycleScenario(-1));
    this.nextScenario = createButton(this, width / 2 + 180, 548, '>',
      () => this._cycleScenario(1));

    this.status = this.add.text(width / 2, 588, '', { ...FONTS.body, color: '#d08c8c' })
      .setOrigin(0.5);

    // Labelled statically on purpose. createButton returns a Container with no
    // setText, and it auto-sizes its background from the label at creation, so
    // a toggling label would either be a silent no-op or overflow its box. The
    // player list already shows who is ready with a tick.
    this.readyBtn = createButton(this, width / 2 - 150, 634, 'Toggle Ready', () => this._toggleReady());
    this.startBtn = createButton(this, width / 2, 634, 'Start Hunt', () => this._start());
    createButton(this, width / 2 + 170, 634, 'Leave', () => this._leave());
  }

  // ---- helpers ------------------------------------------------------------

  get scenarioId() { return this.scenarioIds[this.scenarioIndex]; }

  _val(domEl, name) {
    return (domEl?.getChildByName(name)?.value || '').trim();
  }

  /** A display name for the lobby list. GameState has no player name field. */
  _playerName(fallback) {
    return this._val(this.nameInput, 'playerName')
      || GameState.party?.[0]?.name
      || fallback;
  }

  _say(msg) {
    this.statusLine = msg || '';
    // `.scene` goes null once Phaser destroys a GameObject. Unsubscribing on
    // shutdown is the real fix; this is the guard for anything that still
    // reaches here during teardown.
    if (this.status?.scene) this.status.setText(this.statusLine);
  }

  /** The hunters we are bringing, packed for the wire. */
  _hunters() {
    return (GameState.party || [])
      .filter(c => this.chosen.has(c.instanceId || c.id))
      .map(toWireCharacter);
  }

  _toggleHunter(char) {
    if (this.client?.status === CoopStatus.FIGHTING) return;
    const id = char.instanceId || char.id;
    if (this.chosen.has(id)) this.chosen.delete(id);
    else this.chosen.add(id);

    // The cap is shared across everyone, so the server is the authority. If we
    // are already in a lobby, tell it and let it refuse; otherwise just track.
    if (this.client?.playerId) this.client.setHunters(this._hunters());
    this._refresh();
  }

  _cycleScenario(dir) {
    if (this.client && !this.client.isHost) return this._say('Only the host chooses the fight.');
    this.scenarioIndex = (this.scenarioIndex + dir + this.scenarioIds.length) % this.scenarioIds.length;
    this._refresh();
  }

  // ---- connection ---------------------------------------------------------

  async _connect() {
    const url = this._val(this.serverInput, 'server') || DEFAULT_SERVER;
    try { localStorage.setItem(SERVER_KEY, url); } catch { /* private mode */ }

    if (this.client) return this.client;
    this.client = createCoopClient({ url });

    // Every subscription is kept so it can be cancelled on shutdown. Leaving
    // them attached meant a socket event after this scene was gone still tried
    // to write to its Text objects, which Phaser had already destroyed:
    // "Cannot read properties of null (reading 'cut')". A listener that
    // outlives its scene is a crash waiting for the next event.
    this._unsubs.push(
      this.client.on('lobby', () => this._refresh()),
      this.client.on('joined', () => { this._say(''); this._refresh(); }),
      this.client.on('error', reason => this._say(reason)),
      this.client.on('closed', () => this._say('Disconnected from the server.')),
      this.client.on('started', () => this._enterFight()),
    );

    this._say('Connecting…');
    try {
      await this.client.connect();
      this._say('');
    } catch {
      // The browser deliberately hides WHY a socket failed, so guessing at a
      // reason would be inventing one. Say what is actionable instead.
      this.client = null;
      this._say(`Could not reach ${url}. Is the server running?`);
      throw new Error('connect failed');
    }
    return this.client;
  }

  async _host() {
    if (!this._hunters().length) return this._say('Bring at least one hunter.');
    try { await this._connect(); } catch { return; }
    this.client.createLobby({
      name: this._playerName('Host'),
      scenarioId: this.scenarioId,
      hunters: this._hunters(),
    });
  }

  async _join() {
    const code = this._val(this.codeInput, 'code').toUpperCase();
    if (!code) return this._say('Enter a lobby code.');
    if (!this._hunters().length) return this._say('Bring at least one hunter.');
    try { await this._connect(); } catch { return; }
    this.client.joinLobby({
      code,
      name: this._playerName('Hunter'),
      hunters: this._hunters(),
    });
  }

  _toggleReady() {
    if (!this.client?.playerId) return this._say('Host or join a lobby first.');
    const me = this.client.lobby?.players?.find(p => p.id === this.client.playerId);
    this.client.setReady(!me?.ready);
  }

  _start() {
    if (!this.client?.playerId) return this._say('Host or join a lobby first.');
    if (!this.client.isHost) return this._say('Only the host can start.');
    this.client.startHunt();
  }

  _leave() {
    this.client?.disconnect();
    this.client = null;
    window.sceneManager?.loadScene('TownScene', 'Returning to Watershade…');
  }

  _enterFight() {
    // Marks the shutdown below as a HANDOFF rather than an exit, so the socket
    // survives into the fight.
    this._handingOff = true;

    // Hand the live client to CombatScene, which renders what the server says
    // rather than simulating alongside it.
    this.scene.start('CombatScene', {
      mode: 'coop',
      coopClient: this.client,
      scenarioId: this.client.lobby?.scenarioId || this.scenarioId,
    });
  }

  // ---- rendering ----------------------------------------------------------

  _refresh() {
    const lobby = this.client?.lobby;
    const inLobby = !!this.client?.playerId;

    const scenario = COMBAT_SCENARIOS[lobby?.scenarioId || this.scenarioId];
    this.scenarioText.setText(scenario?.name || this.scenarioId);
    const canPick = !inLobby || this.client.isHost;
    this.prevScenario.setVisible(canPick);
    this.nextScenario.setVisible(canPick);

    // Roster
    const mine = this.chosen.size;
    this.rosterHint.setText(inLobby
      ? `You are bringing ${mine}. Lobby total ${lobby?.used ?? mine} of ${PARTY_LIMIT}.`
      : `You are bringing ${mine} of ${PARTY_LIMIT}.`);

    for (const row of this.rosterRows) {
      const id = row.char.instanceId || row.char.id;
      const on = this.chosen.has(id);
      row.label.setText(`${on ? '[x]' : '[ ]'}  ${row.char.name}`);
      row.label.setColor(on ? MENU_THEME.accentHover : '#8a8f98');
    }

    // Lobby
    this.lobbyTitle.setText(inLobby ? `Lobby ${this.client.code}` : 'Not connected');
    this.partyCount.setText(inLobby ? `${lobby?.used ?? 0} / ${PARTY_LIMIT}` : '');

    const players = lobby?.players || [];
    this.lobbyHint.setVisible(!inLobby);
    this.playerRows.forEach((row, i) => {
      const p = players[i];
      if (!p) { row.setText(''); return; }
      const you = p.id === this.client.playerId ? ' (you)' : '';
      const host = p.id === lobby.hostId ? ' ★' : '';
      const names = p.hunters.map(h => h.name).join(', ') || 'no hunters';
      row.setText(`${p.ready ? '✓' : '·'} ${p.name}${you}${host} — ${names}`);
      row.setColor(p.ready ? '#9ad39a' : '#c8ccd4');
    });

    this.startBtn.setVisible(!inLobby || this.client.isHost);
  }
}
