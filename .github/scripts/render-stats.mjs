// Renders the GitHub stats card with github-readme-stats and writes it to disk.
//
// Expects a checkout of anuraghazra/github-readme-stats (with its dependencies
// installed) at GRS_DIR, and a GitHub token in PAT_1, which is the environment
// variable github-readme-stats reads its tokens from.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const username = process.env.STATS_USERNAME;
const grsDir = process.env.GRS_DIR;
const outDir = process.env.OUT_DIR ?? "stats";

const missing = [
  !username && "STATS_USERNAME",
  !grsDir && "GRS_DIR",
  !Object.keys(process.env).some((key) => /^PAT_\d+$/.test(key)) && "PAT_1",
].filter(Boolean);
if (missing.length > 0) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const load = (relativePath) =>
  import(pathToFileURL(path.resolve(grsDir, relativePath)).href);

const { fetchStats } = await load("src/fetchers/stats.js");
const { renderStatsCard } = await load("src/cards/stats.js");

// Same options as the old README image URL:
// https://github-readme-stats.vercel.app/api?username=...&show_icons=true&theme=radical
const stats = await fetchStats(username);
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
