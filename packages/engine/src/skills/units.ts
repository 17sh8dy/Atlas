/**
 * A small fixed conversion table for `math.convert`.
 *
 * Each family converts through one base unit (metres, kilograms, litres) so
 * adding a unit means adding one factor, not one factor per pair. Temperature
 * is the exception — it isn't linear through a shared base, so it gets its
 * own small function.
 */

type UnitFamily = Record<string, number>;

const LENGTH: UnitFamily = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  meter: 1,
  meters: 1,
  metre: 1,
  metres: 1,
  km: 1000,
  in: 0.0254,
  inch: 0.0254,
  inches: 0.0254,
  ft: 0.3048,
  foot: 0.3048,
  feet: 0.3048,
  yd: 0.9144,
  yard: 0.9144,
  yards: 0.9144,
  mi: 1609.344,
  mile: 1609.344,
  miles: 1609.344,
};

const WEIGHT: UnitFamily = {
  mg: 0.000001,
  g: 0.001,
  gram: 0.001,
  grams: 0.001,
  kg: 1,
  kilogram: 1,
  kilograms: 1,
  oz: 0.0283495,
  ounce: 0.0283495,
  ounces: 0.0283495,
  lb: 0.453592,
  lbs: 0.453592,
  pound: 0.453592,
  pounds: 0.453592,
};

const VOLUME: UnitFamily = {
  ml: 0.001,
  l: 1,
  liter: 1,
  liters: 1,
  litre: 1,
  litres: 1,
  gal: 3.78541,
  gallon: 3.78541,
  gallons: 3.78541,
  cup: 0.24,
  cups: 0.24,
};

const FAMILIES = [LENGTH, WEIGHT, VOLUME];

function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/\.$/, '');
}

function convertLinear(value: number, from: string, to: string): number | null {
  for (const family of FAMILIES) {
    const fromFactor = family[from];
    const toFactor = family[to];
    if (fromFactor !== undefined && toFactor !== undefined) {
      return (value * fromFactor) / toFactor;
    }
  }
  return null;
}

const TEMPERATURE_ALIASES: Record<string, 'c' | 'f' | 'k'> = {
  c: 'c',
  celsius: 'c',
  '°c': 'c',
  f: 'f',
  fahrenheit: 'f',
  '°f': 'f',
  k: 'k',
  kelvin: 'k',
};

function toCelsius(value: number, unit: 'c' | 'f' | 'k'): number {
  if (unit === 'c') return value;
  if (unit === 'f') return ((value - 32) * 5) / 9;
  return value - 273.15;
}

function fromCelsius(value: number, unit: 'c' | 'f' | 'k'): number {
  if (unit === 'c') return value;
  if (unit === 'f') return (value * 9) / 5 + 32;
  return value + 273.15;
}

function convertTemperature(value: number, from: string, to: string): number | null {
  const fromUnit = TEMPERATURE_ALIASES[from];
  const toUnit = TEMPERATURE_ALIASES[to];
  if (!fromUnit || !toUnit) return null;
  return fromCelsius(toCelsius(value, fromUnit), toUnit);
}

/** Converts `value` from one unit to another. Returns null if either unit is unknown or they aren't compatible. */
export function convertUnit(value: number, from: string, to: string): number | null {
  const f = normalizeUnit(from);
  const t = normalizeUnit(to);
  const temp = convertTemperature(value, f, t);
  if (temp !== null) return temp;
  return convertLinear(value, f, t);
}
