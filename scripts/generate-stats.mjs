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

if (!TOKEN) {
  console.error("Missing GH_TOKEN environment variable.");
  process.exit(1);
}

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

function badge(label, value, color) {
  const l = encodeURIComponent(label);
  const v = encodeURIComponent(fmt(value));
  return `![${label}](https://img.shields.io/badge/${l}-${v}-${color}?style=for-the-badge&labelColor=${THEME.label})`;
}

function renderMarkdown(stats) {
  const statBadges = RENDER.filter((f) => stats[f.key] !== undefined)
    .map((f) => badge(f.label, stats[f.key], f.color))
    .join("\n");

  // Language badges use each language's real GitHub color (falls back to theme).
  const langs = (stats.topLanguages ?? []).slice(0, TOP_LANGUAGES_COUNT);
  const langBadges = langs
    .map((lang, i) => {
      const color = (lang.color || `#${i % 2 ? THEME.purple : THEME.indigo}`)
        .replace(/^#/, "");
      // shields.io renders text over the color; keep label empty-ish for a clean pill.
      return `![${lang.name}](https://img.shields.io/badge/${encodeURIComponent(
        lang.name
      )}-${color}?style=for-the-badge&labelColor=${THEME.label})`;
    })
    .join("\n");

  const parts = [`<div align="center">`, ``, statBadges];
  if (langBadges) {
    parts.push(``, `<br>`, ``, `**Top Languages**`, ``, langBadges);
  }
  parts.push(``, `</div>`);
  return parts.join("\n");
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
  const login = await resolveLogin();
  const stats = await buildStats(login);

  // Contribution graph disabled for now (kept for later re-enable):
  // await writeFile(GRAPH_PATH, renderContributionGraph(stats._calendar));

  // Keep stats.json clean: drop the raw calendar used only for rendering.
  const { _calendar, ...publicStats } = stats;
  await writeFile(JSON_PATH, JSON.stringify(publicStats, null, 2) + "\n");

  const readme = await readFile(README_PATH, "utf8");
  const updated = injectIntoReadme(readme, renderMarkdown(publicStats));
  await writeFile(README_PATH, updated);

  console.log(
    "Wrote stats.json, contribution-graph.svg, and updated README.md",
  );
  console.log(JSON.stringify(publicStats, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
