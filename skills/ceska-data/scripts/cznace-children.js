#!/usr/bin/env node

const API_BASE = "http://www.nace.cz/api/v1/cznace/get_children";
const OUTPUT_FIELDS = [
  "chodnota",
  "parent_chodnota",
  "text",
  "total_direct_children",
];

function usage() {
  return `Usage:
  node scripts/cznace-children.js [CZ_NACE_CODE]

Examples:
  node scripts/cznace-children.js
  node scripts/cznace-children.js 47
`;
}

function toOutputItem(item) {
  return Object.fromEntries(
    OUTPUT_FIELDS.map((field) => [field, item[field] ?? null]),
  );
}

async function getChildren(code) {
  const url = code ? `${API_BASE}/${encodeURIComponent(code)}` : API_BASE;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    const message =
      response.status === 404 && code
        ? `CZ-NACE code '${code}' does not exist.`
        : `CZ-NACE API request failed with HTTP ${response.status}.`;

    const error = new Error(message);
    error.status = response.status;
    error.code = code ?? null;
    throw error;
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    throw new Error("Unexpected CZ-NACE API response: expected a JSON array.");
  }

  return data.map(toOutputItem);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage());
    return;
  }

  if (args.length > 1) {
    process.stderr.write(
      JSON.stringify(
        { error: "Expected at most one CZ-NACE code argument." },
        null,
        2,
      ) + "\n",
    );
    process.exitCode = 2;
    return;
  }

  try {
    const children = await getChildren(args[0]);
    process.stdout.write(JSON.stringify(children, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(
      JSON.stringify(
        {
          error: error.message,
          status: error.status ?? null,
          code: error.code ?? args[0] ?? null,
        },
        null,
        2,
      ) + "\n",
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { getChildren };
