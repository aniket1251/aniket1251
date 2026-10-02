#!/usr/bin/env node
/**
 * generate-views.mjs
 *
 * Self-hosted profile view counter — no third-party services.
 *
 * GitHub's Traffic API (/repos/{owner}/{repo}/traffic/views) reports the
 * daily unique + total views for a repo, but only retains the last 14 days.
 * To build a reliable all-time total we persist every day we've ever seen in
 * views.json and merge new daily buckets on each run (keyed by date, so
 * re-runs within the 14-day window overwrite rather than double-count).
 *
 * The "profile" repo is the special <user>/<user> repo that backs the GitHub
 * profile README, so its traffic is effectively profile traffic.
 *
 * Output:
 *   views.json   persisted per-day history + computed totals
 *   views.svg    themed badge/card served from raw.githubusercontent.com
 *
 * Env:
 *   GH_TOKEN   token with access to the repo's traffic data. Traffic requires
 *              push access, so for a personal profile use a PAT/token that owns
 *              the repo (the default GITHUB_TOKEN works inside the repo too).
 *   GH_USER    GitHub username (defaults to token owner / repo owner).
 */

import { readFile, writeFile } from "node:fs/promises";

const TOKEN = process.env.GH_TOKEN;
const JSON_PATH = "views.json";
const VIEWS_SVG_PATH = "views.svg";

// ── Theme (matches the rest of the profile) ────────────────────────
const THEME = {
  indigo: "6366f1",
  purple: "a855f7",
  bg: "1a1b27",
};

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "profile-views-script",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub HTTP ${res.status} for ${path}: ${await res.text()}`);
  }
  return res.json();
}

async function resolveLogin() {
  if (process.env.GH_USER) return process.env.GH_USER;
  const me = await gh("/user");
  return me.login;
}

// Load the persisted history, tolerating a missing/empty file (first run).
async function loadHistory() {
  try {
    const raw = await readFile(JSON_PATH, "utf8");
    const data = JSON.parse(raw);
    return {
      days: data.days && typeof data.days === "object" ? data.days : {},
    };
  } catch {
    return { days: {} };
  }
}

function fmt(n) {
  if (typeof n !== "number") return String(n);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function svgEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Flat two-segment badge pill (shields.io / komarev style): a dark label
// segment on the left ("Profile Views") and a colored count segment on the
// right. Uses the profile's indigo→purple palette instead of the usual green.
function renderViewsSvg({ totalViews }) {
  const label = "Profile Views";
  const value = fmt(totalViews);

  const height = 28;
  const radius = 6;
  const fontSize = 14;
  const padX = 12; // horizontal padding inside each segment

  // Approximate text widths (Segoe UI advance ≈ 0.6em, +some for bold value).
  const labelTextW = Math.ceil(label.length * fontSize * 0.58);
  const valueTextW = Math.ceil(value.length * fontSize * 0.66);

  const labelW = padX + labelTextW + padX;
  const valueW = padX + valueTextW + padX;
  const width = labelW + valueW;

  const labelCx = labelW / 2;
  const valueCx = labelW + valueW / 2;
  const textY = height / 2 + fontSize / 3;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${svgEscape(label)}: ${svgEscape(value)}">
  <defs>
    <linearGradient id="vcount" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#${THEME.purple}"/>
      <stop offset="100%" stop-color="#${THEME.indigo}"/>
    </linearGradient>
    <clipPath id="vround">
      <rect width="${width}" height="${height}" rx="${radius}"/>
    </clipPath>
  </defs>
  <style>
    .vlabel { font: 600 ${fontSize}px 'Segoe UI', Ubuntu, sans-serif; fill: #e2e8f0; }
    .vvalue { font: 700 ${fontSize}px 'Segoe UI', Ubuntu, sans-serif; fill: #ffffff; }
  </style>
  <g clip-path="url(#vround)">
    <rect width="${labelW}" height="${height}" fill="#${THEME.bg}"/>
    <rect x="${labelW}" width="${valueW}" height="${height}" fill="url(#vcount)"/>
  </g>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="${radius}" fill="none" stroke="#${THEME.indigo}" stroke-width="1" opacity="0.5"/>
  <text x="${labelCx}" y="${textY}" text-anchor="middle" class="vlabel">${svgEscape(label)}</text>
  <text x="${valueCx}" y="${textY}" text-anchor="middle" class="vvalue">${svgEscape(value)}</text>
</svg>
`;
}

async function main() {
  if (!TOKEN) {
    console.error("Missing GH_TOKEN environment variable.");
    process.exit(1);
  }

  const login = await resolveLogin();
  const repo = login; // the <user>/<user> profile repo

  // Fetch the last 14 days of traffic for the profile repo. The Traffic API
  // requires "Administration: read" on the repo — a read-only/public token
  // returns 403/404 here, which would otherwise silently keep the total at 0.
  const traffic = await gh(`/repos/${login}/${repo}/traffic/views`);

  const newDays = traffic.views ?? [];
  if (newDays.length === 0) {
    console.warn(
      `Traffic API returned no daily buckets for ${login}/${repo}. ` +
        `This is normal only if the repo truly had zero views in the last 14 days. ` +
        `If you expected views, check that the token has Administration:read access.`,
    );
  }

  // Merge the daily buckets into persisted history, keyed by ISO date so
  // overlapping runs overwrite the same day (no double counting).
  const { days } = await loadHistory();
  for (const d of newDays) {
    const date = d.timestamp.slice(0, 10); // YYYY-MM-DD
    days[date] = { count: d.count, uniques: d.uniques };
  }

  // Compute all-time totals from the full persisted history.
  const dates = Object.keys(days).sort();
  const totalViews = dates.reduce((s, k) => s + (days[k].count || 0), 0);
  const uniqueViews = dates.reduce((s, k) => s + (days[k].uniques || 0), 0);

  const output = {
    login,
    repo: `${login}/${repo}`,
    totalViews,
    uniqueViews,
    days,
    generatedAt: new Date().toISOString(),
  };

  await writeFile(JSON_PATH, JSON.stringify(output, null, 2) + "\n");
  await writeFile(VIEWS_SVG_PATH, renderViewsSvg({ totalViews, uniqueViews }));

  console.log(
    `Wrote ${JSON_PATH} and ${VIEWS_SVG_PATH} — total ${totalViews}, unique ${uniqueViews} across ${dates.length} day(s).`,
  );
}

export { renderViewsSvg };

// Only run when invoked directly (not when imported for tests).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
