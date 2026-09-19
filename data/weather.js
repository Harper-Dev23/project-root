// data/weather.js
// Rolled once per hunt in HuntManager.start() and revealed only on the
// hunting screen itself — not visible during loadout planning.

export const WEATHER_TYPES = [
  {
    id: 'clear',
    name: 'Clear Skies',
    flavor: 'Calm weather. Nothing to report.',
    weight: 5,
    modifiers: {},
  },
  {
    id: 'storm',
    name: 'Storm',
    flavor: 'Driving rain churns the ground — beasts grow bolder, and travel slows.',
    weight: 2,
    modifiers: { encounterChancePercent: 8, supplyEfficiencyPercent: -10 },
  },
  {
    id: 'fog',
    name: 'Heavy Fog',
    flavor: 'A thick fog rolls in. Easy to stumble into something with teeth.',
    weight: 2,
    modifiers: { beastChanceWeight: 2, supplyEfficiencyPercent: -5 },
  },
  {
    id: 'drought',
    name: 'Drought',
    flavor: 'Dry, brittle ground. Harder going, but desperate beasts leave better trophies.',
    weight: 2,
    modifiers: { supplyEfficiencyPercent: -8, huntPointsPercent: 10 },
  },
];

// `rng` is the hunt's seeded stream; see EncounterRoller.roll for why.
// `foulWeatherPercent` is the Foul Weather plan prefix (data/planAffixes.js):
// it takes that share of Clear Skies' weight, so the harsh kinds split what is
// left in their usual proportions. Still one rng() call, so a plan with it does
// not shift anything the hunt rolls afterwards.
export function rollWeather(rng = Math.random, foulWeatherPercent = 0) {
  const harsh = Math.max(0, Math.min(100, Number(foulWeatherPercent) || 0));
  const weightOf = (w) => (w.id === 'clear' ? w.weight * (1 - harsh / 100) : w.weight);
  const totalWeight = WEATHER_TYPES.reduce((sum, w) => sum + weightOf(w), 0);
  let roll = rng() * totalWeight;
  for (const weather of WEATHER_TYPES) {
    if (weightOf(weather) <= 0) continue;   // a roll of exactly 0 must not land on it
    roll -= weightOf(weather);
    if (roll <= 0) return weather;
  }
  return WEATHER_TYPES[0];
}
