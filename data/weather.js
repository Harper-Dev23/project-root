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

export function rollWeather() {
  const totalWeight = WEATHER_TYPES.reduce((sum, w) => sum + w.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const weather of WEATHER_TYPES) {
    roll -= weather.weight;
    if (roll <= 0) return weather;
  }
  return WEATHER_TYPES[0];
}
