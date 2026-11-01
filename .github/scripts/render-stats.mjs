// Renders the GitHub stats card and the contribution calendar and writes both
// to disk as SVG.
//
// Expects a checkout of anuraghazra/github-readme-stats (with its dependencies
// installed) at GRS_DIR and a token in GITHUB_TOKEN.
//
// The data is fetched here rather than through the upstream fetcher because the
// workflow's built-in token is only installed on this repository: GraphQL refuses
// `stargazers` on every other repository ("Resource not accessible by
// integration"). Star counts therefore come from the public REST endpoint.
// The rank and the stats card are computed and rendered by upstream code; the
// contribution calendar is drawn here in the same style.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const username = process.env.STATS_USERNAME;
const grsDir = process.env.GRS_DIR;
const token = process.env.GITHUB_TOKEN;
const outDir = process.env.OUT_DIR ?? "stats";

const missing = [
  !username && "STATS_USERNAME",
  !grsDir && "GRS_DIR",
  !token && "GITHUB_TOKEN",
].filter(Boolean);
if (missing.length > 0) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const load = (relativePath) =>
  import(pathToFileURL(path.resolve(grsDir, relativePath)).href);

const { calculateRank } = await load("src/calculateRank.js");
const { renderStatsCard } = await load("src/cards/stats.js");

const headers = {
  Authorization: `bearer ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "render-stats",
};

const graphql = async (query, variables) => {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`GraphQL request failed: HTTP ${response.status}`);
  }
  const { data, errors } = await response.json();
  if (errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(errors, null, 2)}`);
  }
  return data;
};

// Same fields the upstream stats fetcher reads for the default card, minus
// per-repository stargazers (see the header comment), plus the contribution
// calendar for the last year.
const query = `
  query userInfo($login: String!) {
    user(login: $login) {
      name
      login
      commits: contributionsCollection {
        totalCommitContributions
      }
      reviews: contributionsCollection {
        totalPullRequestReviewContributions
      }
      calendar: contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              weekday
              contributionCount
              contributionLevel
            }
          }
        }
      }
      repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) {
        totalCount
      }
      pullRequests(first: 1) {
        totalCount
      }
      openIssues: issues(states: OPEN) {
        totalCount
      }
      closedIssues: issues(states: CLOSED) {
        totalCount
      }
      followers {
        totalCount
      }
      repositories(first: 1, ownerAffiliations: OWNER) {
        totalCount
      }
    }
  }
`;

const { user } = await graphql(query, { login: username });

// Stars across all repositories the user owns, via the public REST endpoint.
let totalStars = 0;
for (let page = 1; ; page++) {
  const url = `https://api.github.com/users/${encodeURIComponent(username)}/repos?type=owner&per_page=100&page=${page}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`REST request failed: HTTP ${response.status} for ${url}`);
  }
  const repos = await response.json();
  totalStars += repos.reduce((sum, repo) => sum + repo.stargazers_count, 0);
  if (repos.length < 100) {
    break;
  }
}

const stats = {
  name: user.name || user.login,
  totalStars,
  totalCommits: user.commits.totalCommitContributions,
  totalIssues: user.openIssues.totalCount + user.closedIssues.totalCount,
  totalPRs: user.pullRequests.totalCount,
  totalPRsMerged: 0,
  mergedPRsPercentage: 0,
  totalReviews: user.reviews.totalPullRequestReviewContributions,
  totalDiscussionsStarted: 0,
  totalDiscussionsAnswered: 0,
  contributedTo: user.repositoriesContributedTo.totalCount,
};
stats.rank = calculateRank({
  all_commits: false,
  commits: stats.totalCommits,
  prs: stats.totalPRs,
  reviews: stats.totalReviews,
  issues: stats.totalIssues,
  repos: user.repositories.totalCount,
  stars: stats.totalStars,
  followers: user.followers.totalCount,
});

// Same options as the old README image URL:
// https://github-readme-stats.vercel.app/api?username=...&show_icons=true&theme=radical
const statsSvg = renderStatsCard(stats, { show_icons: true, theme: "radical" });

// Colors of the "radical" theme, so the calendar matches the stats card.
const theme = {
  bg: "#141321",
  border: "#e4e2e2",
  title: "#fe428e",
  text: "#a9fef7",
};

// GitHub's dark-mode contribution greens, from no activity to the most.
const levelColors = {
  NONE: "#1f1e33",
  FIRST_QUARTILE: "#0e4429",
  SECOND_QUARTILE: "#006d32",
  THIRD_QUARTILE: "#26a641",
  FOURTH_QUARTILE: "#39d353",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Draws the contribution calendar: one column per week, one row per weekday,
 * each square shaded by that day's contribution level.
 */
const renderContributionCalendar = ({ totalContributions, weeks }) => {
  const cell = 11;
  const step = 14; // cell plus gap
  const padding = 25;
  const gutter = 30; // room for weekday labels
  const gridX = padding + gutter;
  const gridY = 70;
  const gridWidth = weeks.length * step - (step - cell);
  const gridHeight = 7 * step - (step - cell);
  const width = gridX + gridWidth + padding;
  const legendY = gridY + gridHeight + 25;
  const height = legendY + 15;

  // A month label above the first week whose first day falls in a new month.
  // The first column only gets one when the next label is not right beside it.
  const monthLabels = [];
  let previousMonth = null;
  weeks.forEach((week, column) => {
    const month = new Date(`${week.contributionDays[0].date}T00:00:00Z`).getUTCMonth();
    if (month !== previousMonth) {
      monthLabels.push({ column, month });
      previousMonth = month;
    }
  });
  if (monthLabels.length > 1 && monthLabels[1].column - monthLabels[0].column < 3) {
    monthLabels.shift();
  }

  const months = monthLabels
    .map(
      ({ column, month }) =>
        `<text class="label" x="${gridX + column * step}" y="${gridY - 8}">${MONTHS[month]}</text>`,
    )
    .join("\n      ");

  const weekdays = [
    [1, "Mon"],
    [3, "Wed"],
    [5, "Fri"],
  ]
    .map(
      ([row, label]) =>
        `<text class="label" x="${padding}" y="${gridY + row * step + cell - 2}">${label}</text>`,
    )
    .join("\n      ");

  const squares = weeks
    .flatMap((week, column) =>
      week.contributionDays.map((day) => {
        const x = gridX + column * step;
        const y = gridY + day.weekday * step;
        const color = levelColors[day.contributionLevel] ?? levelColors.NONE;
        return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${color}"><title>${day.contributionCount} on ${day.date}</title></rect>`;
      }),
    )
    .join("\n      ");

  const legendSquares = Object.values(levelColors)
    .map(
      (color, index) =>
        `<rect x="${width - padding - 40 - (5 - index) * step}" y="${legendY - cell + 2}" width="${cell}" height="${cell}" rx="2" fill="${color}" />`,
    )
    .join("\n      ");
  const legend = `
      <text class="label" x="${width - padding - 40 - 5 * step - 6}" y="${legendY}" text-anchor="end">Less</text>
      ${legendSquares}
      <text class="label" x="${width - padding - 40 + cell + 6}" y="${legendY}">More</text>`;

  const title = `${totalContributions.toLocaleString("en-US")} contributions in the last year`;

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="titleId descId">
  <title id="titleId">${username}'s contribution calendar</title>
  <desc id="descId">${title}</desc>
  <style>
    .title { font: 600 18px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${theme.title}; }
    .label { font: 400 11px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${theme.text}; }
  </style>
  <rect x="0.5" y="0.5" rx="4.5" width="${width - 1}" height="${height - 1}" stroke="${theme.border}" fill="${theme.bg}" stroke-opacity="1" />
  <text class="title" x="${padding}" y="35">${title}</text>
  <g>
      ${months}
      ${weekdays}
      ${squares}
      ${legend}
  </g>
</svg>
`;
};

const calendarSvg = renderContributionCalendar(user.calendar.contributionCalendar);

await mkdir(outDir, { recursive: true });
const statsFile = path.join(outDir, "github-stats.svg");
const calendarFile = path.join(outDir, "contributions.svg");
await writeFile(statsFile, statsSvg);
await writeFile(calendarFile, calendarSvg);
console.log(
  `Wrote ${statsFile} for ${username}: rank ${stats.rank.level}, ` +
    `${stats.totalStars} stars, ${stats.totalCommits} commits, ` +
    `${stats.totalPRs} PRs, ${stats.totalIssues} issues, ` +
    `contributed to ${stats.contributedTo} repos`,
);
console.log(
  `Wrote ${calendarFile}: ${user.calendar.contributionCalendar.totalContributions} ` +
    `contributions over ${user.calendar.contributionCalendar.weeks.length} weeks`,
);
