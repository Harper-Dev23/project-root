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
import { GameplaySettings } from '../systems/GameplaySettings.js';
import CombatScene from './CombatScene.js';

const SERVER_KEY = 'coop_server_url';
// The last lobby this browser was seated in, for reconnecting after a crash.
const LAST_CODE_KEY = 'coop_last_code';
// The hosted server, so a player never has to know it exists. The field stays
// editable for local testing against `npm start` (ws://localhost:8787).
//
// It MUST be wss:// and not ws://. The game is served over HTTPS from GitHub
// Pages, and browsers silently refuse an insecure socket from a secure page —
// which fails as "could not connect" with nothing useful anywhere, so leaving
// players to type it themselves was a trap worth removing.
const DEFAULT_SERVER = 'wss://project-root-production-dd9d.up.railway.app';
const LOCAL_SERVER = 'ws://localhost:8787';
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
    // Which hunter the next slot click will place. Null means "the next one
    // that has nowhere to stand", which is the sensible default when filling
    // an empty formation from scratch.
    this.selectedId = null;
    this.statusLine = '';
    this._unsubs = [];
    this._handingOff = false;
    this.wantPublic = false;      // private unless the host opts in
    this.browsing = false;
  }

  create() {
    // Put the town to sleep, the same way CombatScene does on entry.
    //
    // Without this the town and its UI keep running underneath: their buttons
    // stay live, so a click that misses a lobby control lands on a building or
    // a menu behind it. A full-screen scene has to say so; Phaser will happily
    // run both at once.
    this.scene.sleep('TownScene');
    this.scene.sleep('UIScene');

    const { width, height } = this.scale;
    this.add.rectangle(0, 0, width, height, COLORS.background)
      .setOrigin(0).setDepth(-1)
      // Swallows any click that lands on the background rather than a control,
      // so nothing can reach a scene behind this one.
      .setInteractive();

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

    // Escape leaves, which is what a player reaches for first. Cleared on
    // shutdown so the binding cannot fire into a dead scene.
    this._escKey = this.input.keyboard?.addKey('ESC');
    this._escKey?.on('down', () => this._leave());

    this.events.once('shutdown', () => {
      this._escKey?.removeAllListeners();
      this.input.keyboard?.removeKey('ESC');

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
    createPanel(this, 40, 96, width - 80, 120, 'silverMenu');

    // One row, everything on the same baseline. Labels sat above their fields
    // in the first pass, which read as two unrelated rows of controls.
    const rowY = 134;
    const label = (x, text) => this.add.text(x, rowY, text,
      { ...FONTS.body, fontSize: '16px', color: '#c8ccd4' }).setOrigin(0, 0.5);

    const saved = this._rememberedServer();

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
    // Pre-filled with the last lobby this browser sat in, so coming back after
    // a crash is Join rather than "what was the code again". Harmless if that
    // hunt is long gone -- the server simply says there is no lobby with it.
    try {
      const last = localStorage.getItem(LAST_CODE_KEY);
      const el = this.codeInput?.getChildByName?.('code');
      if (last && el) el.value = last;
    } catch { }

    this.joinBtn = createButton(this, 1055, rowY, 'Join', () => this._join());

    // Browsing sits beside joining by code, not instead of it. A code is still
    // the only way into a private lobby, and the only thing you can read to a
    // friend over voice.
    // Second row inside the same panel, so the connection controls read as one
    // group rather than spilling over the border.
    const rowY2 = 186;
    this.browseBtn = createButton(this, 1055, rowY2, 'Browse open hunts', () => this._browse());
    this.publicToggle = this.add.text(60, rowY2, '', { ...FONTS.body, fontSize: '15px' })
      .setOrigin(0, 0.5).setInteractive({ useHandCursor: true });
    this.publicToggle.on('pointerdown', () => this._togglePublic());

    // One-click switching between the two servers.
    //
    // Developing means bouncing between a local `npm start` and the hosted one
    // constantly, and the hosted address is far too long to retype or remember.
    // Both are offered rather than just the local one, because the field
    // remembers whatever was last used and there was no way back.
    const setServer = (url) => {
      const node = this.serverInput?.getChildByName('server');
      if (node) node.value = url;
      try { localStorage.setItem(SERVER_KEY, url); } catch { /* private mode */ }
      this._say('');
      this._refresh();
    };

    this.add.text(250, rowY2, 'use hosted', { ...FONTS.muted, fontSize: '12px', color: '#8a8f98' })
      .setOrigin(0, 0.5).setInteractive({ useHandCursor: true })
      .on('pointerdown', () => setServer(DEFAULT_SERVER));

    this.add.text(340, rowY2, 'use local', { ...FONTS.muted, fontSize: '12px', color: '#8a8f98' })
      .setOrigin(0, 0.5).setInteractive({ useHandCursor: true })
      .on('pointerdown', () => setServer(LOCAL_SERVER));

    // Which one is in the box right now, so a failed connection is never a
    // mystery about where it was even pointed.
    this.serverKind = this.add.text(440, rowY2, '', { ...FONTS.muted, fontSize: '12px' })
      .setOrigin(0, 0.5);
  }

  /**
   * The server address to start with.
   *
   * A remembered address is preferred, EXCEPT a local one on a page served over
   * HTTPS. Everyone who tried co-op before it was hosted has ws://localhost
   * saved, and a browser refuses an insecure socket from a secure page — so
   * without this they would open the lobby on the live site, see a plausible
   * address already filled in, and fail to connect with no clue why.
   */
  _rememberedServer() {
    let saved = null;
    try { saved = localStorage.getItem(SERVER_KEY); } catch { /* private mode */ }
    if (!saved) return DEFAULT_SERVER;

    const isLocal = /^wss?:\/\/(localhost|127\.0\.0\.1)/i.test(saved);
    const pageIsSecure = globalThis.location?.protocol === 'https:';
    if (isLocal && pageIsSecure) return DEFAULT_SERVER;

    return saved;
  }

  _buildRoster(width) {
    createPanel(this, 40, 230, 560, 270, 'silverMenu');
    this.add.text(60, 244, 'Bring which hunters?', { ...FONTS.body, color: '#c8ccd4' });
    this.rosterHint = this.add.text(60, 268, '', { ...FONTS.muted, color: '#8a8f98' });

    // Two separate click targets per row, because the row has two jobs and one
    // of them was unreachable: the box decides whether a hunter comes at all,
    // the name decides which hunter you are about to place. Folding both into
    // one label is what left "click a slot to place 3 more" with no way to say
    // WHICH of the three.
    this.rosterRows = (GameState.party || []).slice(0, 8).map((char, i) => {
      const y = 298 + i * 28;
      const box = this.add.text(66, y, '', { ...FONTS.body, fontSize: '16px' })
        .setInteractive({ useHandCursor: true });
      box.on('pointerdown', () => this._toggleHunter(char));

      const label = this.add.text(100, y, '', { ...FONTS.body, fontSize: '16px' })
        .setInteractive({ useHandCursor: true });
      label.on('pointerdown', () => this._selectHunter(char));
      return { char, box, label };
    });

    this._buildFormation();
  }

  /**
   * The formation picker: the combat board's own eight ally slots, drawn in
   * the same brick-offset shape and the same orientation, so what you set here
   * is recognisably where people will be standing.
   *
   * Geometry comes from CombatScene.SLOT_GRID rather than a copy of it. The
   * board's back column is col 0 and the front is col 2, allies facing right,
   * which is why the front rank is drawn on the RIGHT here too -- a mirrored
   * picker would be worse than none.
   *
   * You may only place your own hunters, so there is no selection step to get
   * wrong: clicking a free slot sends your next unplaced hunter to it, and
   * clicking one of yours picks that hunter back up. The server refuses
   * anything else, and says why.
   */
  _buildFormation() {
    const ox = 366, oy = 300, cell = 42, gap = 5;
    this.add.text(ox, 272, 'Formation', { ...FONTS.body, color: '#c8ccd4' });
    this.formationHint = this.add.text(ox, 442, '',
      { ...FONTS.muted, fontSize: '12px', color: '#7d838d', wordWrap: { width: 210 } });

    this.slotCells = Object.entries(CombatScene.SLOT_GRID).map(([id, pos]) => {
      const slotId = Number(id);
      // Column 1 holds two slots where the others hold three; nudging it down
      // half a cell reproduces the board's brick offset instead of pretending
      // the grid is square.
      const x = ox + pos.col * (cell + gap);
      const y = oy + pos.row * (cell + gap) + (pos.col === 1 ? (cell + gap) / 2 : 0);

      const box = this.add.rectangle(x, y, cell, cell, 0x000000, 0.25)
        .setOrigin(0, 0).setStrokeStyle(1, 0x4a4f58)
        .setInteractive({ useHandCursor: true });
      box.on('pointerdown', () => this._clickSlot(slotId));

      const name = this.add.text(x + cell / 2, y + cell / 2, '',
        { ...FONTS.body, fontSize: '11px' }).setOrigin(0.5);
      const num = this.add.text(x + 3, y + 2, String(slotId),
        { ...FONTS.muted, fontSize: '9px', color: '#5a5f68' });
      return { slotId, box, name, num };
    });
  }

  /** Place your next unplaced hunter here, or pick up the one standing here. */
  _clickSlot(slotId) {
    if (!this.client?.playerId) return this._say('Join or host a lobby first.');
    const lobby = this.client.lobby;
    if (lobby?.started) return this._say('The hunt has already started.');

    const me = lobby?.players?.find(p => p.id === this.client.playerId);
    if (!me) return;

    const here = me.hunters.find(h => h.slotId === slotId);
    if (here) return this.client.claimSlot(here.ref, null);

    // Someone else's hunter is standing there. Say so rather than sending a
    // claim we know the server will refuse.
    const theirs = (lobby.players || [])
      .some(p => p.id !== me.id && p.hunters.some(h => h.slotId === slotId));
    if (theirs) return this._say('Someone else is standing there.');

    // The selected hunter if there is one -- including one already standing
    // elsewhere, which is how you move somebody -- otherwise the next unplaced.
    const picked = this.selectedId && me.hunters.find(h => h.ref === this.selectedId);
    const next = picked || me.hunters.find(h => h.slotId == null);
    if (!next) return this._say('All of your hunters are placed. Click a name to move one.');
    this.client.claimSlot(next.ref, slotId);
    this.selectedId = null;
  }

  _buildLobbyPanel(width) {
    createPanel(this, 620, 230, width - 660, 270, 'silverMenu');
    this.lobbyTitle = this.add.text(640, 244, 'Not connected',
      { ...FONTS.body, color: '#c8ccd4' });
    this.partyCount = this.add.text(width - 60, 244, '', { ...FONTS.body, color: '#c8ccd4' })
      .setOrigin(1, 0);

    // An empty bordered box tells a player nothing. This says what to do.
    this.lobbyHint = this.add.text(646, 280,
      ['Host a hunt, then read the code to a friend.',
       'Or type their code and Join.'],
      { ...FONTS.body, fontSize: '15px', color: '#7d838d', lineSpacing: 6 });

    this.playerRows = [];
    for (let i = 0; i < 6; i++) {
      this.playerRows.push(this.add.text(646, 278 + i * 30, '',
        { ...FONTS.body, fontSize: '16px' }));
    }

    // The same panel shows open lobbies when browsing. One list at a time:
    // before you are seated it shows where you could go, after it shows who
    // is with you.
    this.browseRows = [];
    for (let i = 0; i < 7; i++) {
      const row = this.add.text(646, 276 + i * 30, '', { ...FONTS.body, fontSize: '15px' })
        .setInteractive({ useHandCursor: true });
      row.on('pointerdown', () => {
        const entry = this._browseList?.[i];
        if (entry) this._joinCode(entry.code);
      });
      row.setVisible(false);
      this.browseRows.push(row);
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
    createButton(this, width / 2 + 180, 634, 'Back to Town', () => this._leave());
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

  /**
   * Choose which hunter the next slot click will place.
   *
   * Selecting one that is already standing somewhere is allowed and means
   * "move them": the next slot click sends them there. Clicking the selected
   * hunter again clears the selection.
   */
  _selectHunter(char) {
    if (this.client?.status === CoopStatus.FIGHTING) return;
    const id = char.instanceId || char.id;
    if (!this.chosen.has(id)) return this._say('Tick the box to bring them first.');
    this.selectedId = this.selectedId === id ? null : id;
    this._refresh();
  }

  _toggleHunter(char) {
    if (this.client?.status === CoopStatus.FIGHTING) return;
    const id = char.instanceId || char.id;
    // Leaving a hunter selected after dropping them would point every slot
    // click at somebody who is no longer coming.
    if (this.selectedId === id) this.selectedId = null;
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
      this.client.on('joined', (msg) => {
        // Remembered so a crashed or refreshed browser can be handed its own
        // code back. Reconnecting needs the code, and nobody reads a lobby
        // code expecting to have to write it down.
        try { localStorage.setItem(LAST_CODE_KEY, this.client.code || ''); } catch { }
        this._say(msg?.resumed ? 'Rejoined your hunt.' : '');
        this._refresh();
      }),
      this.client.on('error', reason => this._say(reason)),
      this.client.on('closed', () => this._say('Disconnected from the server.')),
      this.client.on('started', () => this._enterFight()),
      this.client.on('lobbies', (list) => {
        this._browseList = list;
        this.browsing = true;
        this._say(list.length ? '' : 'No open hunts right now.');
        this._refresh();
      }),
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
      // The host's combat speed paces the recording for the whole hunt, so
      // everyone watches the same fight at the same rate.
      quickCombat: GameplaySettings.quickCombat,
      isPublic: this.wantPublic,
    });
  }

  async _join() {
    const code = this._val(this.codeInput, 'code').toUpperCase();
    if (!code) return this._say('Enter a lobby code.');
    if (!this._hunters().length) return this._say('Bring at least one hunter.');
    try { await this._connect(); } catch { return; }
    this._joinCode(code);
  }

  _togglePublic() {
    if (this.client?.playerId && !this.client.isHost) {
      return this._say('Only the host chooses that.');
    }
    this.wantPublic = !this.wantPublic;
    // If the lobby already exists, tell the server; otherwise this is just the
    // setting the lobby will be created with.
    if (this.client?.playerId && this.client.isHost) this.client.setPublic(this.wantPublic);
    this._refresh();
  }

  async _browse() {
    try { await this._connect(); } catch { return; }
    this.browsing = true;
    this._say('Looking for open hunts...');
    this.client.browse();
  }

  _joinCode(code) {
    if (!this._hunters().length) return this._say('Bring at least one hunter.');
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

  /**
   * Back to town, mirroring how CombatScene exits.
   *
   * Deliberately NOT `loadScene('TownScene')`: the town was only slept, so
   * loading it again would start a SECOND copy on top of the sleeping one.
   * Waking the existing scene is what the rest of the game does.
   */
  _leave() {
    this.client?.disconnect();
    this.client = null;
    this.scene.stop('CoopLobbyScene');
    this.scene.wake('TownScene');
    this.scene.wake('UIScene');
    this.scene.get('UIScene')?.refreshUI?.();
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

    const myHunters = lobby?.players?.find(p => p.id === this.client?.playerId)?.hunters || [];
    for (const row of this.rosterRows) {
      const id = row.char.instanceId || row.char.id;
      const on = this.chosen.has(id);
      const at = myHunters.find(h => h.ref === id)?.slotId;
      const picked = this.selectedId === id;

      row.box.setText(on ? '[x]' : '[ ]');
      row.box.setColor(on ? MENU_THEME.accentHover : '#8a8f98');
      // The marker is what tells you which hunter a slot click will move.
      row.label.setText(`${picked ? '> ' : '  '}${row.char.name}${at != null ? `  - slot ${at}` : ''}`);
      row.label.setColor(!on ? '#8a8f98' : picked ? '#f0d9a0' : MENU_THEME.accentHover);
    }

    // Formation
    const me = lobby?.players?.find(p => p.id === this.client?.playerId);
    const occupant = (slotId) => {
      for (const p of (lobby?.players || [])) {
        const h = p.hunters.find(x => x.slotId === slotId);
        if (h) return { h, mine: p.id === this.client?.playerId };
      }
      return null;
    };
    for (const cell of (this.slotCells || [])) {
      const who = occupant(cell.slotId);
      cell.name.setText(who ? who.h.name.slice(0, 6) : '');
      cell.name.setColor(who?.mine ? MENU_THEME.accentHover : '#8a8f98');
      cell.box.setFillStyle(0x000000, who ? 0.45 : 0.25);
      cell.box.setStrokeStyle(1, who?.mine ? 0x8a7a4a : 0x4a4f58);
    }
    const unplaced = me ? me.hunters.filter(h => h.slotId == null).length : 0;
    const selName = this.selectedId
      && this.rosterRows.find(r => (r.char.instanceId || r.char.id) === this.selectedId)?.char.name;
    this.formationHint.setText(!inLobby
      ? 'Join a lobby to choose where your Hunters stand.'
      : selName
        ? `Click a slot to put ${selName} there.`
        : unplaced
          ? `Click a name to choose, then a slot. ${unplaced} still unplaced. Front rank is on the right.`
          : 'Click a name to move them, or a slot of yours to pick them up.');

    // Lobby
    this.lobbyTitle.setText(inLobby
      ? `Lobby ${this.client.code}${lobby?.isPublic ? '  (public)' : ''}`
      : 'Not connected');
    this.partyCount.setText(inLobby ? `${lobby?.used ?? 0} / ${PARTY_LIMIT}` : '');

    // Which server the field is pointed at, in plain words.
    const url = this._val(this.serverInput, 'server');
    const local = /^wss?:\/\/(localhost|127\.0\.0\.1)/i.test(url);
    this.serverKind?.setText(url ? (local ? '(local)' : '(hosted)') : '');
    this.serverKind?.setColor(local ? '#c8a24a' : '#7d9a7d');

    // Public/private is the host's call, shown wherever they are in the flow.
    const canSetPublic = !inLobby || this.client.isHost;
    this.publicToggle.setVisible(canSetPublic);
    this.publicToggle.setText((this.wantPublic ? '[x]' : '[ ]') + '  List publicly');
    this.publicToggle.setColor(this.wantPublic ? MENU_THEME.accentHover : '#8a8f98');

    // One panel, two lists: open hunts before you are seated, teammates after.
    const showBrowse = !inLobby && this.browsing;
    this.browseRows.forEach((row, i) => {
      const e = this._browseList?.[i];
      row.setVisible(showBrowse && !!e);
      if (!e) return;
      row.setText(`${e.code}   ${e.host}   ${e.used}/${e.limit}   ` +
        (COMBAT_SCENARIOS[e.scenarioId]?.name || e.scenarioId));
      row.setColor('#c8ccd4');
    });
    if (showBrowse) this.lobbyTitle.setText('Open hunts  (click one to join)');

    const players = lobby?.players || [];
    this.lobbyHint.setVisible(!inLobby && !showBrowse);
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
