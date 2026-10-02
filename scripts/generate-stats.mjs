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

import { mkdir, readFile, writeFile } from "node:fs/promises";

const TOKEN = process.env.GH_TOKEN;
const README_PATH = "README.md";
const JSON_PATH = "stats.json";
// Directory where all generated SVGs are written (and committed).
const SVG_DIR = "svg";
const GRAPH_PATH = `${SVG_DIR}/contribution-graph.svg`;
const STATS_SVG_PATH = `${SVG_DIR}/stats.svg`;
const TYPING_SVG_PATH = `${SVG_DIR}/typing.svg`;
const BANNER_SVG_PATH = `${SVG_DIR}/banner.svg`;
const FOOTER_SVG_PATH = `${SVG_DIR}/footer.svg`;

// Lines shown in the self-hosted typing animation.
const TYPING_LINES = [
  "Architecting systems that scale.",
  "Training models that learn.",
  "Writing code that lasts.",
];

// Header/footer banner text.
const BANNER = {
  title: "Aniket Gautam",
  subtitle: "Software Engineer · ML Practitioner · System Architect",
  footer: "Let's build something amazing",
};

// Social link badges, rendered as self-hosted SVGs with inline brand glyphs.
// `svg` is the (24x24 viewBox) path/markup drawn in white at the pill's left.
const LINKS = [
  {
    file: "link-portfolio.svg",
    label: "Portfolio",
    href: "https://aniketgautam.vercel.app",
    // Vercel triangle
    glyph: '<path d="M12 3L22 20H2L12 3Z" fill="#ffffff"/>',
  },
  {
    file: "link-linkedin.svg",
    label: "LinkedIn",
    href: "https://www.linkedin.com/in/aniket-gautam-3b9b69205/",
    // LinkedIn mark
    glyph:
      '<path fill="#ffffff" d="M4.98 3.5a2.5 2.5 0 1 1 0 5.001 2.5 2.5 0 0 1 0-5.001zM3 9h4v12H3zM10 9h3.8v1.7h.05c.53-.95 1.82-1.95 3.75-1.95 4 0 4.4 2.5 4.4 5.8V21h-4v-5.1c0-1.2 0-2.8-1.7-2.8s-2 1.3-2 2.7V21h-4z"/>',
  },
  {
    file: "link-email.svg",
    label: "Email",
    href: "mailto:ag125aa@gmail.com",
    // Envelope: outlined body + stroked flap (no fill/stroke conflicts).
    glyph:
      '<g fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M3 6l9 7 9-7"/></g>',
  },
];

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

// Minimal gradient banner (replaces capsule-render.vercel.app). `variant`:
//   "header" — tall, title + subtitle
//   "footer" — short, single centered line
//
// Kept intentionally minimal: a themed gradient, clipped rounded corners,
// and a single slow, low-opacity sheen sweep. Animation uses SMIL (not CSS
// @keyframes), since GitHub's SVG sanitizer strips <style> animations when
// the image is served through its camo proxy.
function renderBannerSvg(variant = "header") {
  const width = 1200;
  const height = variant === "header" ? 220 : 120;
  const gradId = `g_${variant}`;
  const sheenId = `sheen_${variant}`;
  const clipId = `round_${variant}`;
  const label = svgEscape(variant === "header" ? BANNER.title : BANNER.footer);

  const sheenW = variant === "header" ? 360 : 340;

  const titleBlock =
    variant === "header"
      ? `
    <text x="600" y="98" text-anchor="middle"
      font-family="'Segoe UI', Ubuntu, Helvetica, Arial, sans-serif" font-weight="700" font-size="54" fill="#ffffff">${svgEscape(BANNER.title)}</text>
    <text x="600" y="138" text-anchor="middle"
      font-family="'Segoe UI', Ubuntu, Helvetica, Arial, sans-serif" font-weight="400" font-size="17" fill="#e2e8f0" letter-spacing="0.5">${svgEscape(BANNER.subtitle)}</text>`
      : `
    <text x="600" y="54" text-anchor="middle"
      font-family="'Segoe UI', Ubuntu, Helvetica, Arial, sans-serif" font-weight="600" font-size="26" fill="#ffffff" letter-spacing="0.5">${svgEscape(BANNER.footer)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}">
  <title>${label}</title>
  <defs>
    <linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#1a1b27"/>
      <stop offset="30%" stop-color="#6366f1"/>
      <stop offset="50%" stop-color="#a855f7"/>
      <stop offset="70%" stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#1a1b27"/>
    </linearGradient>
    <linearGradient id="${sheenId}_grad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="50%" stop-color="#ffffff" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="${clipId}">
      <rect width="${width}" height="${height}" rx="16" ry="16"/>
    </clipPath>
  </defs>
  <g clip-path="url(#${clipId})">
    <rect width="${width}" height="${height}" fill="url(#${gradId})"/>
    <rect width="${sheenW}" height="${height}" fill="url(#${sheenId}_grad)">
      <animate attributeName="x" values="-${sheenW};${width}" dur="9s" begin="0s;${sheenId}.end+5s" id="${sheenId}"/>
    </rect>${titleBlock}
  </g>
</svg>
`;
}

// Social link badge pill (replaces shields.io). White brand glyph on the
// left, label on the right, themed indigo background. Fully self-contained.
function renderLinkSvg(link) {
  const h = 40;
  const padX = 14;
  const glyphBox = 20;
  const gap = 8;
  const fontSize = 15;
  const textW = Math.ceil(link.label.length * fontSize * 0.6);
  const w = padX + glyphBox + gap + textW + padX;
  const glyphX = padX;
  const glyphY = (h - glyphBox) / 2;
  const textX = padX + glyphBox + gap;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${svgEscape(link.label)}">
  <style>
    .lbl { font: 700 ${fontSize}px 'Segoe UI', Ubuntu, sans-serif; fill: #ffffff; letter-spacing: 0.3px; }
  </style>
  <rect width="${w}" height="${h}" rx="8" fill="#6366f1"/>
  <g transform="translate(${glyphX}, ${glyphY}) scale(${glyphBox / 24})">
    ${link.glyph}
  </g>
  <text x="${textX}" y="${h / 2 + fontSize / 3}" class="lbl">${svgEscape(link.label.toUpperCase())}</text>
</svg>
`;
}

// Self-hosted typing animation (replaces readme-typing-svg.demolab.com).
// Uses SMIL <animate> with discrete, character-aligned keyframes so the text
// reveal and the caret move in perfect lock-step. GitHub runs SMIL inside
// <img>-loaded SVGs (via the camo proxy), so no JavaScript is needed.
//
// Per line the timeline is: type (one char per tick) → hold → erase → idle.
// The caret rides the exact reveal edge, blinks during the hold, and is
// hidden while other lines are active.
function renderTypingSvg(lines = TYPING_LINES) {
  const height = 44;
  const fontSize = 22;
  const charW = fontSize * 0.6; // Fira Code advance ≈ 0.6em per glyph
  const padL = 10;
  const caretW = 2;
  const baselineY = 29;
  const caretY = 10;
  const caretH = 24;

  // Per-phase timing (seconds).
  const typePerChar = 0.11;
  const erasePerChar = 0.045;
  const holdSecs = 1.4;
  const gapSecs = 0.35; // brief empty beat between lines

  const longest = Math.max(...lines.map((l) => l.length));
  const width = Math.ceil(padL * 2 + longest * charW + caretW + 8);

  // Build the global timeline so every line animates over one shared period T,
  // each active only within its own [start, end] window.
  const segs = [];
  let t = 0;
  for (const text of lines) {
    const chars = text.length;
    const type = chars * typePerChar;
    const erase = chars * erasePerChar;
    const start = t;
    segs.push({ text, chars, start, type, hold: holdSecs, erase });
    t += type + holdSecs + erase + gapSecs;
  }
  const T = t; // full loop duration

  // Helper: format a number compactly.
  const n = (x) => Number(x.toFixed(4));

  const content = segs
    .map((seg, i) => {
      const clipId = `tclip${i}`;
      const fullW = seg.chars * charW + caretW;
      const edgeAt = (ch) => padL + ch * charW; // caret x after `ch` chars

      // Discrete per-character keyTimes/values for the TYPE phase.
      const kt = []; // keyTimes (0..1 across T)
      const widthVals = []; // clip width
      const caretVals = []; // caret x
      const push = (time, w, cx) => {
        kt.push(n(Math.min(1, Math.max(0, time / T))));
        widthVals.push(n(w));
        caretVals.push(n(cx));
      };

      // Before this line's window: collapsed + caret parked at left.
      if (seg.start > 0) push(0, 0, padL);
      push(seg.start, 0, padL);

      // Typing: reveal one character per tick (discrete).
      for (let c = 1; c <= seg.chars; c++) {
        const time = seg.start + c * typePerChar;
        push(time, c * charW + caretW, edgeAt(c));
      }

      // Hold: everything stays put.
      const holdEnd = seg.start + seg.type + seg.hold;
      push(holdEnd, fullW, edgeAt(seg.chars));

      // Erasing: retreat one character per tick (discrete).
      for (let c = seg.chars - 1; c >= 0; c--) {
        const done = seg.chars - c; // chars erased so far
        const time = holdEnd + done * erasePerChar;
        push(time, c * charW + (c > 0 ? caretW : 0), edgeAt(c));
      }

      // Idle until the loop ends.
      push(T, 0, padL);

      const keyTimes = kt.join(";");
      const widthStr = widthVals.join(";");
      const caretStr = caretVals.join(";");

      // Caret visible only during this line's active window (incl. hold).
      // Build a strictly non-decreasing keyTimes list (dedup equal stamps).
      const visStart = seg.start / T;
      const visEnd = (holdEnd + seg.erase) / T;
      const visStops = [];
      const addStop = (time, val) => {
        const tt = n(Math.min(1, Math.max(0, time)));
        const last = visStops[visStops.length - 1];
        if (last && last.t === tt) {
          last.v = val; // same timestamp → keep latest value
        } else {
          visStops.push({ t: tt, v: val });
        }
      };
      addStop(0, "0");
      addStop(visStart, "1");
      addStop(visEnd, "0");
      if (visStops[visStops.length - 1].t < 1) addStop(1, "0");
      const visKeyTimes = visStops.map((s) => s.t).join(";");
      const visValues = visStops.map((s) => s.v).join(";");

      return `
    <clipPath id="${clipId}">
      <rect x="${padL}" y="0" width="0" height="${height}">
        <animate attributeName="width" dur="${n(T)}s" repeatCount="indefinite"
                 calcMode="discrete" keyTimes="${keyTimes}" values="${widthStr}"/>
      </rect>
    </clipPath>
    <text x="${padL}" y="${baselineY}" class="type" clip-path="url(#${clipId})">${svgEscape(seg.text)}</text>
    <g opacity="0">
      <animate attributeName="opacity" dur="${n(T)}s" repeatCount="indefinite"
               calcMode="discrete" keyTimes="${visKeyTimes}" values="${visValues}"/>
      <rect class="caret" x="0" y="${caretY}" width="${caretW}" height="${caretH}">
        <animate attributeName="x" dur="${n(T)}s" repeatCount="indefinite"
                 calcMode="discrete" keyTimes="${keyTimes}" values="${caretStr}"/>
        <animate attributeName="opacity" dur="1s" repeatCount="indefinite"
                 calcMode="discrete" keyTimes="0;0.5;1" values="1;0;1"/>
      </rect>
    </g>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${svgEscape(lines.join(" "))}">
  <style>
    .type { font: 500 ${fontSize}px 'Fira Code', 'JetBrains Mono', 'Courier New', monospace; fill: #a855f7; }
    .caret { fill: #a855f7; }
  </style>
  <rect width="${width}" height="${height}" fill="none"/>
  ${content}
</svg>
`;
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

  // Ensure the output directory exists before writing any SVGs.
  await mkdir(SVG_DIR, { recursive: true });

  // Render the self-hosted SVGs (served from raw.githubusercontent.com).
  await writeFile(STATS_SVG_PATH, renderStatsSvg(publicStats));
  await writeFile(TYPING_SVG_PATH, renderTypingSvg());
  await writeFile(BANNER_SVG_PATH, renderBannerSvg("header"));
  await writeFile(FOOTER_SVG_PATH, renderBannerSvg("footer"));
  for (const link of LINKS) {
    await writeFile(`${SVG_DIR}/${link.file}`, renderLinkSvg(link));
  }

  const readme = await readFile(README_PATH, "utf8");
  const updated = injectIntoReadme(readme, renderMarkdown(publicStats));
  await writeFile(README_PATH, updated);

  console.log(
    "Wrote stats.json, svg/stats.svg, svg/typing.svg, svg/banner.svg, svg/footer.svg, svg/link-*.svg, and updated README.md",
  );
  console.log(JSON.stringify(publicStats, null, 2));
}

export {
  renderStatsSvg,
  renderMarkdown,
  renderTypingSvg,
  renderBannerSvg,
  renderLinkSvg,
  LINKS,
};

// Only run when invoked directly (not when imported for tests).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
