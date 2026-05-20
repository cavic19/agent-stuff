---
name: ceska-data
description: Find information about Czech companies, especially bulk company searches by municipality, employee/headcount range, and business activity/CZ-NACE. Use when the user asks to find/list/export Czech firms/companies, e.g. "Najdi mi všechny firmy v Praze do 200 zaměstnanců které provozují sklady".
---

# Česká data — bulk Czech company search

Use this skill whenever the user wants to find Czech companies, usually in bulk, by location, headcount, and activity. The search backend is `scripts/ceskadata-search.js` and the mandatory preparation helpers are:

- `scripts/czso-headcount-categories.js` — maps requested employee-count intervals to KATPO headcount category codes.
- `scripts/cities.json` — supported municipality names. It is large: use `jq`, `rg`, or small scripts to narrow matches; do **not** read the whole file into context.
- `scripts/cznace-children.js` — progressively discloses the CZ-NACE tree to pick appropriate activity codes.
- `scripts/ceskadata-search.js` — executes the final search. Only `--nace` can accept multiple values. `--katpo` and `--obec` accept one value only.

## Required workflow

### 1. Parse the user's intent

Identify:

- **Headcount constraint**: e.g. `do 200 zaměstnanců` → interval `-200`; `10 až 50` → `10-50`; `nad 1000` → `1000-`.
- **Location(s)**: cities/municipalities, e.g. `Praha`, `Brno`, `Frýdek-Místek`.
- **Activity / business description**: natural-language phrase that must be mapped to one or more CZ-NACE codes, e.g. `provozují sklady`, `e-shopy`, `výroba nábytku`.

If a required dimension is ambiguous and cannot be reasonably inferred, ask a concise clarification question before running a large search.

### 2. Resolve headcount categories with CZSO helper

Always use the helper instead of guessing KATPO codes:

```bash
node scripts/czso-headcount-categories.js -200
node scripts/czso-headcount-categories.js 10-50
node scripts/czso-headcount-categories.js 1000-
```

The output is a JSON array of KATPO codes. Example: `-200` returns all positive employee categories up to the category that best fits 200 employees.

### 3. Resolve supported city names without loading all cities

`cities.json` is large. Narrow it with `jq`/`rg`/Node. Examples:

```bash
# case-insensitive substring match
jq -r '.[] | select(test("praha"; "i"))' scripts/cities.json | head -50

# exact match check
jq -r '.[] | select(. == "Praha")' scripts/cities.json

# normalize candidate list for a partial user spelling
jq -r '.[] | select(test("frydek|frýdek|mistek|místek"; "i"))' scripts/cities.json | head -50
```

Use the exact supported municipality string returned by `cities.json` as `--obec`.

If the user gives multiple municipalities, keep them as separate `--obec` searches; the API does not accept an array for `obec`.

### 4. Resolve CZ-NACE codes progressively

Use `cznace-children.js` to walk the hierarchy. Start at root, inspect likely branches, then drill down only where needed:

```bash
node scripts/cznace-children.js
node scripts/cznace-children.js H
node scripts/cznace-children.js 52
node scripts/cznace-children.js 521
```

Pick the best combination of CZ-NACE codes for the requested activity. Prefer codes that are specific enough to match the user's phrase while not excluding obvious relevant companies.

Guidance examples:

- Warehousing / operating warehouses (`provozují sklady`) is usually under transport/storage: inspect `H`, then `52`, especially warehousing/storage codes such as `521` if confirmed by the tree.
- Retail/e-shop requests may require inspecting wholesale/retail sections and possibly multiple codes.
- Manufacturing requests should be mapped to the relevant manufacturing branch and child code(s).

`--nace` may be passed as comma-separated values or repeated flags, so combine multiple selected CZ-NACE codes in one search command.

### 5. Execute searches

Use `scripts/ceskadata-search.js`:

```bash
node scripts/ceskadata-search.js --katpo 310 --obec "Praha" --nace 521 --limit 100
node scripts/ceskadata-search.js --katpo 310 --obec "Praha" --nace 521,522 --all
```

Output shape is fixed:

```json
{ "total": 0, "page": 1, "limit": 100, "pages": 0, "results": [] }
```

Each result contains: `ico`, `firma`, `obec_text`, `ulice_text`, `cdom`, `cor`, `psc`, `nace`, `nace_text`, `forma`, `forma_text`, `katpo`, `katpo_text`, `okreslau`, `okres_text`.

## Multiple headcount categories or cities

Because only `--nace` can be an array, run one search per `katpo × obec` combination. Parallelize independent requests with shell background jobs or `xargs -P`, save outputs to files, then merge and de-duplicate by `ico`.

Example:

```bash
mkdir -p tmp/ceskadata
for katpo in 120 130 210 220 230 240 310; do
  node scripts/ceskadata-search.js --all --katpo "$katpo" --obec "Praha" --nace 521 \
    > "tmp/ceskadata/praha_${katpo}.json" &
done
wait
jq -s '{total: (map(.results) | add | unique_by(.ico) | length), results: (map(.results) | add | unique_by(.ico))}' tmp/ceskadata/*.json \
  > tmp/ceskadata/merged.json
```

For multiple cities, include the city name in the output filename and run all city/category combinations similarly.

## Avoid polluting context with large data

Never paste large result sets into the conversation. Prefer this pattern:

1. Run a small first-page query or count check (`--limit 1`) for each combination to estimate totals.
2. Tell the user the selected filters and approximate total.
3. If the user wants the data or the output is large, write JSON/CSV files and summarize only counts plus the output path.

CSV export example:

```bash
jq -r '
  (["ico","firma","obec_text","ulice_text","cdom","cor","psc","nace","nace_text","forma","forma_text","katpo","katpo_text","okreslau","okres_text"]),
  (.results[] | [.ico,.firma,.obec_text,.ulice_text,.cdom,.cor,.psc,.nace,.nace_text,.forma,.forma_text,.katpo,.katpo_text,.okreslau,.okres_text])
  | @csv
' tmp/ceskadata/merged.json > tmp/ceskadata/companies.csv
```

When reporting back, include:

- interpreted headcount interval and selected KATPO codes,
- supported municipality name(s),
- chosen CZ-NACE code(s) and labels/reasoning,
- total unique companies found,
- file path(s) if saved, or a small sample if the user requested an inline preview.

## End-to-end example

User: `Najdi mi všechny firmy v Praze do 200 zaměstnanců které provozují sklady.`

1. Headcount: run `node scripts/czso-headcount-categories.js -200`.
2. City: verify `Praha` via `jq -r '.[] | select(. == "Praha")' scripts/cities.json`.
3. CZ-NACE: inspect root → `H` → `52` and choose the warehousing/storage code(s), commonly `521` if confirmed.
4. Run one request per KATPO code for `Praha`, with `--nace 521`, merge by `ico`, and export to CSV if large.
