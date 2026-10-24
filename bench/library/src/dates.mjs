// Dates are "YYYY-MM-DD" strings, always UTC.
const DAY = 86400000;
const parse = (iso) => Date.parse(iso + "T00:00:00Z");

export function addDays(iso, days) {
  return new Date(parse(iso) + days * DAY).toISOString().slice(0, 10);
}

// Whole days from a to b (positive when b is later).
export function daysBetween(a, b) {
  return Math.round((parse(b) - parse(a)) / DAY);
}
