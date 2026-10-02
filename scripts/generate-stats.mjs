#!/usr/bin/env node
/**
 * generate-stats.mjs
 *
 * Fetches ALL GitHub profile stats via the GraphQL API, writes the full
 * object to stats.json, and injects a themed markdown block into README.md
 * between the <!--STATS:START--> and <!--STATS:END--> markers.
 *
 * Which fields are rendered (and how) is controlled entirely by the
 * `RENDER` config below — edit that array to change your README output.
 *
 * Env:
 *   GH_TOKEN   GitHub token with read access (public data is enough).
 *   GH_USER    GitHub username (defaults to token owner).
 */

import { readFile, writeFile } from "node:fs/promises";

const TOKEN = process.env.GH_TOKEN;
const README_PATH = "README.md";
const JSON_PATH = "stats.json";
const GRAPH_PATH = "contribution-graph.svg";
const STATS_SVG_PATH = "stats.svg";

// Raw GitHub base used to reference committed SVGs (self-hosted, no 3rd party).
const RAW_BASE = process.env.GH_USER
  ? `https://raw.githubusercontent.com/${process.env.GH_USER}/${process.env.GH_USER}/master`
  : null;

// ── Theme (matches README palette) ─────────────────────────────────
const THEME = {
  indigo: "6366f1",
  purple: "a855f7",
  label: "1a1b27",
};

// ── What to render, in order. Edit freely. ─────────────────────────
// `key` must exist on the stats object produced by buildStats().
const RENDER = [
  { key: "totalCommits", label: "Commits", color: THEME.indigo },
  { key: "totalStars", label: "Stars", color: THEME.purple },
  { key: "totalForks", label: "Forks", color: THEME.indigo },
  { key: "totalWatchers", label: "Watchers", color: THEME.purple },
  { key: "followers", label: "Followers", color: THEME.indigo },
];

// How many top languages to show as their own badge row.
const TOP_LANGUAGES_COUNT = 5;

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-stats-script",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function resolveLogin() {
  if (process.env.GH_USER) return process.env.GH_USER;
  const data = await graphql(
    `
      query {
        viewer {
          login
        }
      }
    `,
    {},
  );
  return data.viewer.login;
}

async function getTotalCommits(login) {
  // contributionsCollection only covers a 1-year window, so query each
  // year since the account was created and sum the commit contributions.
  const created = await graphql(
    `query ($login: String!) { user(login: $login) { createdAt } }`,
    { login },
  );
  const startYear = new Date(created.user.createdAt).getUTCFullYear();
  const endYear = new Date().getUTCFullYear();

  let total = 0;
  for (let year = startYear; year <= endYear; year++) {
    const from = `${year}-01-01T00:00:00Z`;
    const to = `${year}-12-31T23:59:59Z`;
    const data = await graphql(
      `query ($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            totalCommitContributions
            restrictedContributionsCount
          }
        }
      }`,
      { login, from, to },
    );
    const c = data.user.contributionsCollection;
    total += c.totalCommitContributions + c.restrictedContributionsCount;
  }
  return total;
}

async function getContributionCalendar(login) {
  const data = await graphql(
    `query ($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                contributionCount
                date
              }
            }
          }
        }
      }
    }`,
    { login },
  );
  return data.user.contributionsCollection.contributionCalendar;
}

function renderContributionGraph(calendar) {
  const weeks = calendar.weeks;
  const cell = 11; // size of each day square
  const gap = 3;
  const left = 8;
  const top = 8;
  const cols = weeks.length;
  const width = left * 2 + cols * (cell + gap);
  const height = top * 2 + 7 * (cell + gap);

  // Color scale from theme (dark -> indigo -> purple).
  const max = Math.max(
    1,
    ...weeks.flatMap((w) => w.contributionDays.map((d) => d.contributionCount)),
  );
  const scale = (n) => {
    if (n === 0) return "#232640";
    const t = n / max;
    if (t < 0.25) return "#3b3f6b";
    if (t < 0.5) return "#6366f1";
    if (t < 0.75) return "#8b5cf6";
    return "#a855f7";
  };

  let rects = "";
  weeks.forEach((w, x) => {
    w.contributionDays.forEach((d) => {
      const day = new Date(d.date).getUTCDay();
      const cx = left + x * (cell + gap);
      const cy = top + day * (cell + gap);
      rects += `<rect x="${cx}" y="${cy}" width="${cell}" height="${cell}" rx="2" fill="${scale(
        d.contributionCount,
      )}"><title>${d.date}: ${d.contributionCount}</title></rect>`;
    });
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Contribution graph">
  <rect width="${width}" height="${height}" fill="#1a1b27"/>
  ${rects}
</svg>
`;
}

async function buildStats(login) {
  const totalCommits = await getTotalCommits(login);
  // Contribution graph disabled for now (kept for later re-enable):
  // const calendar = await getContributionCalendar(login);

  // Aggregate profile + repo data. Repos are paginated.
  const repos = [];
  let cursor = null;
  let hasNext = true;
  let profile = null;

  while (hasNext) {
    const data = await graphql(
      `
        query ($login: String!, $cursor: String) {
          user(login: $login) {
            login
            name
            followers {
              totalCount
            }
            following {
              totalCount
            }
            repositories(
              first: 100
              after: $cursor
              ownerAffiliations: OWNER
              orderBy: { field: STARGAZERS, direction: DESC }
            ) {
              totalCount
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                name
                isFork
                stargazerCount
                forkCount
                watchers {
                  totalCount
                }
                primaryLanguage {
                  name
                  color
                }
                languages(
                  first: 10
                  orderBy: { field: SIZE, direction: DESC }
                ) {
                  edges {
                    size
                    node {
                      name
                      color
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { login, cursor },
    );

    const user = data.user;
    if (!profile) {
      profile = {
        login: user.login,
        name: user.name,
        followers: user.followers.totalCount,
        following: user.following.totalCount,
        totalCommits,
      };
      profile.totalRepos = user.repositories.totalCount;
    }
    repos.push(...user.repositories.nodes);
    hasNext = user.repositories.pageInfo.hasNextPage;
    cursor = user.repositories.pageInfo.endCursor;
  }

  // Aggregate repo-level numbers (exclude forks from stars/forks totals).
  const owned = repos.filter((r) => !r.isFork);
  const totalStars = owned.reduce((s, r) => s + r.stargazerCount, 0);
  const totalForks = owned.reduce((s, r) => s + r.forkCount, 0);
  const totalWatchers = owned.reduce((s, r) => s + r.watchers.totalCount, 0);

  // Top languages by total bytes across owned repos.
  const langBytes = {};
  for (const r of owned) {
    for (const edge of r.languages?.edges ?? []) {
      const name = edge.node.name;
      langBytes[name] = (langBytes[name] || 0) + edge.size;
    }
  }
  const topLanguages = Object.entries(langBytes)
    .sort((a, b) => b[1] - a[1])
    .map(([name, bytes]) => ({ name, bytes }));

  return {
    ...profile,
    totalStars,
    totalForks,
    totalWatchers,
    // totalContributions: calendar.totalContributions,
    topLanguages,
    // _calendar: calendar,
    generatedAt: new Date().toISOString(),
  };
}

function fmt(n) {
  if (typeof n !== "number") return String(n);
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

// Render the whole stats block as a single self-hosted SVG.
// No third-party services — committed and served from raw.githubusercontent.com.
function renderStatsSvg(stats) {
  const statItems = RENDER.filter((f) => stats[f.key] !== undefined).map(
    (f) => ({ label: f.label, value: fmt(stats[f.key]), color: `#${f.color}` }),
  );

  const langs = (stats.topLanguages ?? []).slice(0, TOP_LANGUAGES_COUNT);

  const width = 500;
  const padX = 24;
  const titleY = 40;

  // Stat rows: label left, value right.
  const statStartY = 78;
  const statGap = 34;
  const statRows = statItems
    .map((s, i) => {
      const y = statStartY + i * statGap;
      return `
    <text x="${padX}" y="${y}" class="label">${svgEscape(s.label)}</text>
    <text x="${width - padX}" y="${y}" class="value" fill="${s.color}" text-anchor="end">${svgEscape(s.value)}</text>
    <line x1="${padX}" y1="${y + 10}" x2="${width - padX}" y2="${y + 10}" class="divider"/>`;
    })
    .join("");

  // Language pills wrapped across lines.
  const langTitleY = statStartY + statItems.length * statGap + 18;
  const pillH = 26;
  const pillGap = 10;
  const lineGap = 12;
  let px = padX;
  let py = langTitleY + 18;
  const pills = langs
    .map((lang, i) => {
      const text = lang.name;
      const w = Math.max(60, 16 + text.length * 8);
      if (px + w > width - padX) {
        px = padX;
        py += pillH + lineGap;
      }
      const color = (lang.color || `#${i % 2 ? THEME.purple : THEME.indigo}`);
      const rect = `
    <g>
      <rect x="${px}" y="${py}" width="${w}" height="${pillH}" rx="13" fill="${THEME.label ? "#" + THEME.label : "#1a1b27"}" stroke="${color}" stroke-width="1.5"/>
      <circle cx="${px + 15}" cy="${py + pillH / 2}" r="5" fill="${color}"/>
      <text x="${px + 27}" y="${py + pillH / 2 + 4}" class="pill">${svgEscape(text)}</text>
    </g>`;
      px += w + pillGap;
      return rect;
    })
    .join("");

  const height = py + pillH + 24;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="GitHub statistics">
  <style>
    .title { font: 700 20px 'Segoe UI', Ubuntu, sans-serif; fill: #a855f7; }
    .label { font: 600 15px 'Segoe UI', Ubuntu, sans-serif; fill: #e2e8f0; }
    .value { font: 700 16px 'Segoe UI', Ubuntu, sans-serif; }
    .section { font: 700 15px 'Segoe UI', Ubuntu, sans-serif; fill: #a855f7; }
    .pill { font: 600 13px 'Segoe UI', Ubuntu, sans-serif; fill: #e2e8f0; }
    .divider { stroke: #232640; stroke-width: 1; }
  </style>
  <rect width="${width}" height="${height}" rx="12" fill="#1a1b27"/>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="none" stroke="#6366f1" stroke-width="1" opacity="0.5"/>
  <text x="${padX}" y="${titleY}" class="title">GitHub Analytics</text>
  ${statRows}
  <text x="${padX}" y="${langTitleY}" class="section">Top Languages</text>
  ${pills}
</svg>
`;
}

function renderMarkdown(stats) {
  // Self-hosted: reference the committed SVG from raw.githubusercontent.com
  // (same reliable path as the snake). Cache-bust with the generated time.
  const v = encodeURIComponent(stats.generatedAt || Date.now());
  const src = RAW_BASE
    ? `${RAW_BASE}/${STATS_SVG_PATH}?v=${v}`
    : `${STATS_SVG_PATH}?v=${v}`;
  return [
    `<div align="center">`,
    ``,
    `<img src="${src}" alt="GitHub statistics" width="500" />`,
    ``,
    `</div>`,
  ].join("\n");
}

function injectIntoReadme(readme, block) {
  const START = "<!--STATS:START-->";
  const END = "<!--STATS:END-->";
  const startIdx = readme.indexOf(START);
  const endIdx = readme.indexOf(END);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `README markers not found. Add ${START} and ${END} where stats should go.`,
    );
  }
  const before = readme.slice(0, startIdx + START.length);
  const after = readme.slice(endIdx);
  return `${before}\n${block}\n${after}`;
}

async function main() {
  if (!TOKEN) {
    console.error("Missing GH_TOKEN environment variable.");
    process.exit(1);
  }
  const login = await resolveLogin();
  const stats = await buildStats(login);

  // Contribution graph disabled for now (kept for later re-enable):
  // await writeFile(GRAPH_PATH, renderContributionGraph(stats._calendar));

  // Keep stats.json clean: drop the raw calendar used only for rendering.
  const { _calendar, ...publicStats } = stats;
  await writeFile(JSON_PATH, JSON.stringify(publicStats, null, 2) + "\n");

  // Render the self-hosted stats SVG (served from raw.githubusercontent.com).
  await writeFile(STATS_SVG_PATH, renderStatsSvg(publicStats));

  const readme = await readFile(README_PATH, "utf8");
  const updated = injectIntoReadme(readme, renderMarkdown(publicStats));
  await writeFile(README_PATH, updated);

  console.log("Wrote stats.json, stats.svg, and updated README.md");
  console.log(JSON.stringify(publicStats, null, 2));
}

export { renderStatsSvg, renderMarkdown };

// Only run when invoked directly (not when imported for tests).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
