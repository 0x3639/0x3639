// Renders the GitHub stats card with github-readme-stats and writes it to disk.
//
// Expects a checkout of anuraghazra/github-readme-stats (with its dependencies
// installed) at GRS_DIR and a token in GITHUB_TOKEN.
//
// The data is fetched here rather than through the upstream fetcher because the
// workflow's built-in token is only installed on this repository: GraphQL refuses
// `stargazers` on every other repository ("Resource not accessible by
// integration"). Star counts therefore come from the public REST endpoint.
// The rank and the card itself are computed and rendered by upstream code.
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

// Same fields the upstream stats fetcher reads for the default card, minus
// per-repository stargazers (see the header comment).
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

const graphqlResponse = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({ query, variables: { login: username } }),
});
if (!graphqlResponse.ok) {
  throw new Error(`GraphQL request failed: HTTP ${graphqlResponse.status}`);
}
const { data, errors } = await graphqlResponse.json();
if (errors?.length) {
  throw new Error(`GraphQL errors: ${JSON.stringify(errors, null, 2)}`);
}
const user = data.user;

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
const svg = renderStatsCard(stats, { show_icons: true, theme: "radical" });

await mkdir(outDir, { recursive: true });
const outFile = path.join(outDir, "github-stats.svg");
await writeFile(outFile, svg);
console.log(
  `Wrote ${outFile} for ${username}: rank ${stats.rank.level}, ` +
    `${stats.totalStars} stars, ${stats.totalCommits} commits, ` +
    `${stats.totalPRs} PRs, ${stats.totalIssues} issues, ` +
    `contributed to ${stats.contributedTo} repos`,
);
