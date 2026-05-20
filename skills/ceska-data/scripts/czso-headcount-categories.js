#!/usr/bin/env node
'use strict';

/**
 * Czech Statistical Office (CZSO) KATPOECD headcount categories.
 * Source: https://apl2.czso.cz/iSMS/cisdet.jsp?kodcis=579&razeni=nd&delka_strany=30
 *
 * Excludes:
 *   000 = Neuvedeno (not specified)
 *   110 = Bez zaměstnanců (no employees)
 */
const CATEGORIES = [
  { code: 120, min: 1, max: 5, label: '1 - 5 zaměstnanců' },
  { code: 130, min: 6, max: 9, label: '6 - 9 zaměstnanců' },
  { code: 210, min: 10, max: 19, label: '10 - 19 zaměstnanců' },
  { code: 220, min: 20, max: 24, label: '20 - 24 zaměstnanci' },
  { code: 230, min: 25, max: 49, label: '25 - 49 zaměstnanců' },
  { code: 240, min: 50, max: 99, label: '50 - 99 zaměstnanců' },
  { code: 310, min: 100, max: 199, label: '100 - 199 zaměstnanců' },
  { code: 320, min: 200, max: 249, label: '200 - 249 zaměstnanců' },
  { code: 330, min: 250, max: 499, label: '250 - 499 zaměstnanců' },
  { code: 340, min: 500, max: 999, label: '500 - 999 zaměstnanců' },
  { code: 410, min: 1000, max: 1499, label: '1000 - 1499 zaměstnanců' },
  { code: 420, min: 1500, max: 1999, label: '1500 - 1999 zaměstnanců' },
  { code: 430, min: 2000, max: 2499, label: '2000 - 2499 zaměstnanců' },
  { code: 440, min: 2500, max: 2999, label: '2500 - 2999 zaměstnanců' },
  { code: 450, min: 3000, max: 3999, label: '3000 - 3999 zaměstnanců' },
  { code: 460, min: 4000, max: 4999, label: '4000 - 4999 zaměstnanců' },
  { code: 470, min: 5000, max: 9999, label: '5000 - 9999 zaměstnanců' },
  { code: 510, min: 10000, max: Infinity, label: '10 000 a více zaměstnanců' },
];

function parseInterval(input) {
  if (Array.isArray(input)) return normalizeInterval(input[0], input[1]);
  if (typeof input === 'object' && input !== null) return normalizeInterval(input.min, input.max);

  const match = String(input).trim().match(/^(\d*)\s*-\s*(\d+|inf(?:inity)?|∞)?$/i);
  if (!match || (match[1] === '' && match[2] == null)) {
    throw new Error(`Invalid interval "${input}". Use e.g. "10-25", "-25", or "10-".`);
  }

  const min = match[1] === '' ? undefined : Number(match[1]);
  const max = match[2] == null ? undefined : (/^inf(?:inity)?|∞$/i.test(match[2]) ? Infinity : Number(match[2]));
  return normalizeInterval(min, max);
}

function normalizeInterval(min, max) {
  min = min == null || min === '' ? 0 : Number(min);
  max = max == null || max === '' ? Infinity : (max === Infinity ? Infinity : Number(max));

  if (!Number.isInteger(min) || min < 0) throw new Error('Minimum must be a non-negative integer.');
  if (max !== Infinity && (!Number.isInteger(max) || max < 0)) {
    throw new Error('Maximum must be a non-negative integer or Infinity.');
  }
  if (min > max) throw new Error('Minimum must be <= maximum.');

  return { min, max };
}

function finiteLength(min, max) {
  return max === Infinity ? Infinity : Math.max(0, max - min + 1);
}

function intersectionLength(aMin, aMax, bMin, bMax) {
  const min = Math.max(aMin, bMin);
  const max = Math.min(aMax, bMax);
  if (min > max) return 0;
  return finiteLength(min, max);
}

function betterCandidate(a, b) {
  if (b === null) return true;
  // Main objective: minimize symmetric difference between desired interval and chosen category union.
  if (a.diff !== b.diff) return a.diff < b.diff;
  // Tie-breakers: maximize overlap, then use fewer categories, then smaller size difference.
  if (a.overlap !== b.overlap) return a.overlap > b.overlap;
  if (a.codes.length !== b.codes.length) return a.codes.length < b.codes.length;
  return a.sizeDiff < b.sizeDiff;
}

function getCzsoHeadcountCategoryCodes(intervalLike) {
  const requested = parseInterval(intervalLike);

  // 000 and 110 are intentionally ignored, so requested 0 employees has no category here.
  const desiredMin = Math.max(1, requested.min);
  const desiredMax = requested.max;
  if (desiredMin > desiredMax) return [];

  const desiredSize = finiteLength(desiredMin, desiredMax);
  let best = null;

  // Categories are ordered, non-overlapping ranges. For one requested interval, the useful result is
  // one contiguous block of categories; non-contiguous blocks would add irrelevant holes.
  for (let start = 0; start < CATEGORIES.length; start++) {
    for (let end = start; end < CATEGORIES.length; end++) {
      const cats = CATEGORIES.slice(start, end + 1);
      const actualMin = cats[0].min;
      const actualMax = cats[cats.length - 1].max;
      const actualSize = finiteLength(actualMin, actualMax);
      const overlap = intersectionLength(desiredMin, desiredMax, actualMin, actualMax);

      // Require at least some overlap with the requested positive headcount interval.
      if (overlap === 0) continue;

      const diff = desiredSize === Infinity || actualSize === Infinity
        ? (desiredMax === Infinity && actualMax === Infinity ? Math.abs(desiredMin - actualMin) : Infinity)
        : desiredSize + actualSize - 2 * overlap; // symmetric difference size

      const candidate = {
        codes: cats.map(c => c.code),
        diff,
        overlap,
        sizeDiff: Math.abs(desiredSize - actualSize),
      };

      if (betterCandidate(candidate, best)) best = candidate;
    }
  }

  return best ? best.codes : [];
}

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg || arg === '-h' || arg === '--help') {
    console.log('Usage: node scripts/czso-headcount-categories.js <min-max| min- | -max>');
    console.log('Examples:');
    console.log('  node scripts/czso-headcount-categories.js 0-9   # -> [120,130]');
    console.log('  node scripts/czso-headcount-categories.js -25   # -> [120,130,210,220]');
    console.log('  node scripts/czso-headcount-categories.js 1000- # -> [410,420,430,440,450,460,470,510]');
    process.exit(arg ? 0 : 1);
  }

  console.log(JSON.stringify(getCzsoHeadcountCategoryCodes(arg)));
}

module.exports = {
  CATEGORIES,
  getCzsoHeadcountCategoryCodes,
};
