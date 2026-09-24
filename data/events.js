// data/events.js
//
// Event templates for hunts on the map (Exploration System v2, chunk 11; design
// in the vault's EVENTS note). The rules are src/systems/EventEffects.js; the
// hunt engine opens a site when the party steps onto it. Every template is
// checked by tools/headless/events.mjs in `npm run verify`: known shapes and
// verbs, fillable roles, real items, quest flags and journal unlocks.
//
// These replace the Advance loop's zone event tables (owner, 2026-09-24: the
// old events are retired, not salvaged). The eight below are the old events
// rewritten in the new form as starter content; chunk 11d adds the rest.
//
// ── A template ───────────────────────────────────────────────────────────────
//   name      a short title for the event panel
//   shape     'choice' | 'check' | 'puzzle' | 'offer' | 'trade'
//   text      what the party finds (roles in braces, see EventEffects.js)
//   appears   where and when it may appear (below)
//   ...and by shape:
//   choice    options: [{ label, effects }]
//   check     check: { stat, dc }, success, failure. stat is a core stat
//             (STR DEX CON INT WIS CHA: the best living hunter's) or a party
//             stat (perception foraging cooking). dc may be an expression.
//   puzzle    prompt, answers: [..], correct: index, success, failure
//   offer     offer (the accept label), price, reward, refuse (optional).
//             Accepting pays the price then takes the reward.
//   trade     give: [{ id, qty }] from the pack, receive, refuse (optional)
// Every outcome (effects, success, failure, price, reward, refuse, receive)
// is a list of effects, one verb each: EventEffects.VERBS.
//
// ── appears ──────────────────────────────────────────────────────────────────
// Known at departure (checked when the map is made):
//   zones      region ids it may appear in (default: any)
//   houses     'any' (the region has a house) | 'none' | [house ids]
//   followed   true: only where your tribe follows the region's house;
//              false: only where it does not
//   danger     [min, max]
//   grounds    ground ids the site's tile must have
//   setPiece   true: never drawn at random; a zone's setPieces names it
//   weight     how often it is drawn (default 1); maxPerMap (default 1)
// Checked on arrival (a site whose moment is not right stays quiet, unspent):
//   night      true: only at night; false: only by day
//   hunger     [stages] the party must be in
//   questFlag / notQuestFlag   a quest flag that must be set / unset
//   needs      nullable roles it uses: 'house' 'prophet' 'rival' 'beast' 'falsegod'
//   pact       true: only during a false god's pact; false: only outside one

export const EVENT_TEMPLATES = {
  // ── The Reeds of Gethsemane ────────────────────────────────────────────────
  reeds_sinking_mud: {
    name: 'Sinking Mud',
    shape: 'check',
    text: 'The ground gives way to sucking mud underfoot.',
    appears: { zones: ['reeds_of_gethsemane'] },
    check: { stat: 'DEX', dc: '{danger}+11' },
    success: [{ text: 'You catch yourself on a reed clump and pull free.' }, { huntPoints: '{danger}*2' }],
    failure: [{ text: 'You sink to the waist before hauling free, soaked and shaken.' }, { hp: '-{danger}*4' }],
  },
  reeds_sunken_shrine: {
    name: 'The Sunken Shrine',
    shape: 'choice',
    text: 'A half-sunken shrine to {prophet} pokes above the waterline.',
    appears: { zones: ['reeds_of_gethsemane'], setPiece: true, needs: ['prophet'] },
    options: [
      { label: 'Pray quietly at the shrine', effects: [{ text: 'The grief in the air eases, if only for a moment.' }, { huntPoints: '{danger}*3' }, { xp: '{danger}*5' }] },
      { label: 'Search it for anything useful', effects: [{ text: 'You find nothing but old wax and waterlogged cloth.' }, { huntPoints: '{danger}' }] },
      { label: 'Leave it undisturbed', effects: [{ text: 'Some things are better left to the dead.' }] },
    ],
  },
  reeds_distant_weeping: {
    name: 'Distant Weeping',
    shape: 'puzzle',
    text: 'A faint, distant weeping carries over the water.',
    appears: { zones: ['reeds_of_gethsemane'] },
    prompt: 'A voice rises from the mist: "I am taken without being touched, and given without being held. What am I?"',
    answers: ['Breath', 'A name', 'Time', 'Grief'],
    correct: 1,
    success: [{ text: 'The weeping pauses, as if heard. You feel strangely lighter.' }, { huntPoints: '{danger}*4' }, { xp: '{danger}*8' }],
    failure: [{ text: 'The weeping only deepens, swallowed by the reeds.' }],
  },
  reeds_stranger_at_camp: {
    name: 'A Silent Figure',
    shape: 'choice',
    text: 'A silent figure sits at the edge of the reeds in the dark, unmoving.',
    appears: { zones: ['reeds_of_gethsemane'], night: true },
    options: [
      { label: 'Speak to them', effects: [{ text: 'They offer no name, only a riddle about sorrow, and are gone by morning.' }, { huntPoints: '{danger}*3' }, { xp: '{danger}*5' }] },
      { label: 'Keep your distance', effects: [{ text: 'By dawn they are simply gone, as if they were never there.' }] },
    ],
  },

  // ── False gods' temptations (chunk 11c) ─────────────────────────────────────
  // Accepting starts the region's false god's pact at level 3, or deepens it.
  // The price (hidden standing, Bond standing, the curse) is the engine's.
  dagon_whisper: {
    name: 'A Voice in the Reeds',
    shape: 'offer',
    text: 'Something in the reeds knows your name. It offers a gift and says it asks nothing. The water has gone very still.',
    appears: { zones: ['reeds_of_gethsemane'], night: true, pact: false, needs: ['falsegod'] },
    offer: 'Accept the gift',
    price: [],
    reward: [{ text: 'The reeds lean toward you. {falsegod} is pleased.' }, { falseGod: { pact: true } }],
    refuse: [{ text: 'You turn from the water. Somewhere, a prophet notices.' }, { standing: 1 }],
  },
  dagon_hunger: {
    name: 'The River Asks Again',
    shape: 'offer',
    text: 'Bloated fish drift belly-up at your feet. The voice returns, hungrier: the river asks for your breath.',
    appears: { zones: ['reeds_of_gethsemane'], pact: true, maxPerMap: 2, needs: ['falsegod'] },
    offer: 'Give it',
    price: [],
    reward: [{ text: '{falsegod} takes, and gives more.' }, { falseGod: { pact: true } }],
    refuse: [{ text: 'You keep your breath. The water stirs, unsated.' }],
  },
  yargaleth_bubbles: {
    name: 'Bubbles in Still Water',
    shape: 'offer',
    text: 'Bubbles rise where the water should be still. A voice beneath them answers a question you never asked.',
    appears: { zones: ['bay_of_solace'], pact: false, needs: ['falsegod'] },
    offer: 'Listen',
    price: [],
    reward: [{ text: 'Truths pour into you, too many to hold. {falsegod} is pleased.' }, { falseGod: { pact: true } }],
    refuse: [{ text: 'You stop your ears. Somewhere, a prophet notices.' }, { standing: 1 }],
  },
  yargaleth_undertow: {
    name: 'The Throat That Never Closes',
    shape: 'offer',
    text: 'Salt forms runes on your skin. The voice offers the rest of the answer, if you will only keep listening.',
    appears: { zones: ['bay_of_solace'], pact: true, maxPerMap: 2, needs: ['falsegod'] },
    offer: 'Keep listening',
    price: [],
    reward: [{ text: '{falsegod} shows you more than you can bear.' }, { falseGod: { pact: true } }],
    refuse: [{ text: 'You pull back from the water, dizzy with half-truths.' }],
  },

  // ── The Bay of Solace ───────────────────────────────────────────────────────
  bay_rising_tide: {
    name: 'The Rising Tide',
    shape: 'check',
    text: 'The tide rises faster than expected, cutting off the way ahead.',
    appears: { zones: ['bay_of_solace'] },
    check: { stat: 'CON', dc: '{danger}+10' },
    success: [{ text: 'You push through the surf before it deepens further.' }, { huntPoints: '{danger}*2' }],
    failure: [{ text: 'The cold water saps your strength before you reach dry sand.' }, { hp: '-{danger}*3' }],
  },
  bay_wrecked_hull: {
    name: 'A Wrecked Hull',
    shape: 'choice',
    text: 'The ribs of a wrecked hull jut from the sand.',
    appears: { zones: ['bay_of_solace'] },
    options: [
      { label: 'Search the wreck', effects: [{ text: 'Among the rotted planks you find something salvageable.' }, { huntPoints: '{danger}*3' }, { xp: '{danger}*5' }] },
      { label: 'Pay your respects and move on', effects: [{ text: 'Whatever crew once sailed her, they are long past needing the wreck.' }, { huntPoints: '{danger}' }] },
    ],
  },
  bay_driftwood_idol: {
    name: 'The Driftwood Idol',
    shape: 'puzzle',
    text: 'Someone has stacked driftwood into a crude idol, turned toward the sea.',
    appears: { zones: ['bay_of_solace'], setPiece: true },
    prompt: 'Carved into the driftwood: "I have a bed but never sleep, a mouth but never speak. What am I?"',
    answers: ['A river', 'A shadow', 'A wave', 'A shell'],
    correct: 0,
    success: [{ text: 'The idol seems to settle, as if satisfied.' }, { huntPoints: '{danger}*4' }, { xp: '{danger}*8' }],
    failure: [{ text: 'The driftwood idol topples in the wind, unanswered.' }],
  },
  bay_lantern_glow: {
    name: 'A Lantern on the Water',
    shape: 'choice',
    text: 'A faint lantern glow bobs far out on the water, going nowhere.',
    appears: { zones: ['bay_of_solace'], night: true },
    options: [
      { label: 'Watch for a while', effects: [{ text: 'The light drifts closer, then winks out entirely.' }, { huntPoints: '{danger}*2' }, { xp: '{danger}*4' }] },
      { label: 'Look away', effects: [{ text: "You don't look back. Some things are better not seen clearly." }] },
    ],
  },
};
