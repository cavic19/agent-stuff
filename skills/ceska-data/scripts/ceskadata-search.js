#!/usr/bin/env node
'use strict';

const API_URL = 'https://ceskadata.cz/api/search';

const RESULT_FIELDS = [
  'ico',
  'firma',
  'obec_text',
  'ulice_text',
  'cdom',
  'cor',
  'psc',
  'nace',
  'nace_text',
  'forma',
  'forma_text',
  'katpo',
  'katpo_text',
  'okreslau',
  'okres_text',
];

const RESULT_PROPERTIES = Object.fromEntries(
  RESULT_FIELDS.map((field) => [field, { type: ['string', 'null'] }]),
);

const OUTPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'CeskadataSearchResponse',
  type: 'object',
  required: ['total', 'page', 'limit', 'pages', 'results'],
  additionalProperties: false,
  properties: {
    total: { type: 'integer' },
    page: { type: 'integer' },
    limit: { type: 'integer' },
    pages: { type: 'integer' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: RESULT_FIELDS,
        additionalProperties: false,
        properties: RESULT_PROPERTIES,
      },
    },
  },
};

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
}

function normalizeOptions(options = {}) {
  const normalized = {
    page: options.page == null ? 1 : Number(options.page),
    limit: options.limit == null ? 100 : Number(options.limit),
    katpo: options.katpo == null ? undefined : Number(options.katpo),
    obec: options.obec,
    nace: options.nace,
  };

  assertPositiveInteger(normalized.page, 'page');
  assertPositiveInteger(normalized.limit, 'limit');

  if (normalized.katpo !== undefined && !Number.isInteger(normalized.katpo)) {
    throw new TypeError('katpo must be an integer.');
  }

  if (normalized.obec !== undefined && typeof normalized.obec !== 'string') {
    throw new TypeError('obec must be a string. Arrays are not supported by the API.');
  }

  if (normalized.nace !== undefined) {
    if (Array.isArray(normalized.nace)) {
      if (!normalized.nace.every((code) => typeof code === 'string')) {
        throw new TypeError('nace must be a string or an array of strings.');
      }
      normalized.nace = normalized.nace.join(',');
    } else if (typeof normalized.nace !== 'string') {
      throw new TypeError('nace must be a string or an array of strings.');
    }
  }

  return normalized;
}

function pickResultFields(result) {
  return Object.fromEntries(RESULT_FIELDS.map((field) => [field, result[field] ?? null]));
}

function simplifySearchResponse(data) {
  return {
    total: data.total,
    page: data.page,
    limit: data.limit,
    pages: data.pages,
    results: data.results.map(pickResultFields),
  };
}

function buildSearchUrl(options = {}) {
  const normalized = normalizeOptions(options);
  const url = new URL(API_URL);

  url.searchParams.set('page', String(normalized.page));
  url.searchParams.set('limit', String(normalized.limit));

  if (normalized.katpo !== undefined) url.searchParams.set('katpo', String(normalized.katpo));
  if (normalized.obec !== undefined && normalized.obec !== '') url.searchParams.set('obec', normalized.obec);
  if (normalized.nace !== undefined && normalized.nace !== '') url.searchParams.set('nace', normalized.nace);

  return url;
}

async function searchCeskadata(options = {}) {
  const url = buildSearchUrl(options);
  const response = await fetch(url, { headers: { Accept: 'application/json' } });

  if (!response.ok) {
    const error = new Error(`Ceskadata API request failed with HTTP ${response.status}.`);
    error.status = response.status;
    error.url = url.toString();
    throw error;
  }

  const data = await response.json();
  if (!data || typeof data !== 'object' || !Array.isArray(data.results)) {
    throw new Error('Unexpected Ceskadata API response: expected an object with results array.');
  }

  return simplifySearchResponse(data);
}

async function searchAllCeskadata(options = {}) {
  const firstPage = await searchCeskadata({ ...options, page: 1 });
  const allResults = [...firstPage.results];

  for (let page = 2; page <= firstPage.pages; page += 1) {
    const data = await searchCeskadata({ ...options, page });
    allResults.push(...data.results);
  }

  return {
    ...firstPage,
    page: 1,
    pages: firstPage.pages,
    results: allResults,
  };
}

function usage() {
  return `Usage:
  node scripts/ceskadata-search.js --katpo 210 --obec "Frýdek-Místek" --nace 47,521 [--page 1] [--limit 100] [--all]
  node scripts/ceskadata-search.js --schema

Options:
  --katpo <int>       Company headcount category code, e.g. 210
  --obec <string>     City/municipality; one string only, arrays are not supported
  --nace <codes>      CZ-NACE code(s), comma-separated; also accepts repeated --nace
  --page <int>        Page number (default: 1)
  --limit <int>       Results per page (default: 100)
  --all               Fetch all pages and merge results into one response
  --schema            Print the JSON Schema for stdout output and exit

Output:
  Prints JSON to stdout. The response has this top-level shape:
  { "total": integer, "page": integer, "limit": integer, "pages": integer, "results": array }

  Each result contains only these fields:
  ico, firma, obec_text, ulice_text, cdom, cor, psc, nace, nace_text, forma,
  forma_text, katpo, katpo_text, okreslau, okres_text

  Use --schema to print the full documented output format.
`;
}

function parseArgs(argv) {
  const options = { nace: [] };
  let all = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--schema') return { schema: true };
    if (arg === '--all') {
      all = true;
      continue;
    }

    const readValue = (name) => {
      const value = argv[++i];
      if (value == null) throw new Error(`Missing value for ${name}.`);
      return value;
    };

    switch (arg) {
      case '--page':
        options.page = readValue(arg);
        break;
      case '--limit':
        options.limit = readValue(arg);
        break;
      case '--katpo':
        options.katpo = readValue(arg);
        break;
      case '--obec':
        options.obec = readValue(arg);
        break;
      case '--nace':
        options.nace.push(...readValue(arg).split(',').map((code) => code.trim()).filter(Boolean));
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.nace.length === 0) delete options.nace;
  return { options, all };
}

async function main() {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(usage());
      return;
    }

    if (parsed.schema) {
      process.stdout.write(JSON.stringify(OUTPUT_SCHEMA, null, 2) + '\n');
      return;
    }

    const data = parsed.all
      ? await searchAllCeskadata(parsed.options)
      : await searchCeskadata(parsed.options);

    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.message, status: error.status ?? null }, null, 2) + '\n');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  OUTPUT_SCHEMA,
  RESULT_FIELDS,
  buildSearchUrl,
  searchCeskadata,
  searchAllCeskadata,
};
