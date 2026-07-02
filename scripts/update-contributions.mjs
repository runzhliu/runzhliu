import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const USERNAME = process.env.GH_LOGIN || process.env.GITHUB_REPOSITORY_OWNER || "runzhliu";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const README = path.resolve(process.cwd(), "README.md");
const START = "<!-- CONTRIBUTED_PROJECTS:START -->";
const END = "<!-- CONTRIBUTED_PROJECTS:END -->";
const DAYS = Number.parseInt(process.env.CONTRIBUTION_DAYS || "365", 10);
const MAX_REPOS = Number.parseInt(process.env.CONTRIBUTION_MAX_REPOS || "25", 10);

if (!TOKEN) {
  throw new Error("Set GITHUB_TOKEN or GH_TOKEN before running this script.");
}

const to = new Date();
const from = new Date(to);
from.setUTCDate(from.getUTCDate() - DAYS);

const repositoryFields = `
  nameWithOwner
  url
  description
  stargazerCount
  isFork
  isArchived
  primaryLanguage {
    name
    color
  }
`;

const query = `
query Contributions($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    repositoriesContributedTo(
      first: 100
      includeUserRepositories: true
      contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, PULL_REQUEST_REVIEW]
    ) {
      totalCount
      nodes {
        ${repositoryFields}
      }
    }
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      commitContributionsByRepository(maxRepositories: 100) {
        repository {
          ${repositoryFields}
        }
        contributions {
          totalCount
        }
      }
      issueContributionsByRepository(maxRepositories: 100) {
        repository {
          ${repositoryFields}
        }
        contributions {
          totalCount
        }
      }
      pullRequestContributionsByRepository(maxRepositories: 100) {
        repository {
          ${repositoryFields}
        }
        contributions {
          totalCount
        }
      }
      pullRequestReviewContributionsByRepository(maxRepositories: 100) {
        repository {
          ${repositoryFields}
        }
        contributions {
          totalCount
        }
      }
    }
  }
}
`;

function mergeRepo(target, repo, kind, count = 0) {
  if (!repo || repo.isArchived) return;

  const existing = target.get(repo.nameWithOwner) || {
    nameWithOwner: repo.nameWithOwner,
    url: repo.url,
    description: repo.description || "",
    stars: repo.stargazerCount || 0,
    language: repo.primaryLanguage?.name || "",
    languageColor: repo.primaryLanguage?.color || "",
    commits: 0,
    issues: 0,
    pullRequests: 0,
    reviews: 0,
  };

  existing[kind] += count;
  target.set(repo.nameWithOwner, existing);
}

function compactDescription(description) {
  if (!description) return "";
  return description.replace(/\s+/g, " ").trim().slice(0, 120);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en", { notation: "compact" }).format(value);
}

function escapeCell(value) {
  return String(value || "").replaceAll("|", "\\|").replace(/\n/g, " ");
}

async function githubGraphql(variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": `${USERNAME}-profile-readme`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();
  if (!response.ok || payload.errors) {
    throw new Error(JSON.stringify(payload.errors || payload, null, 2));
  }

  return payload.data;
}

function buildMarkdown(data) {
  const user = data.user;
  const collection = user.contributionsCollection;
  const repos = new Map();

  for (const repo of user.repositoriesContributedTo.nodes || []) {
    mergeRepo(repos, repo, "commits", 0);
  }

  for (const item of collection.commitContributionsByRepository || []) {
    mergeRepo(repos, item.repository, "commits", item.contributions.totalCount);
  }
  for (const item of collection.issueContributionsByRepository || []) {
    mergeRepo(repos, item.repository, "issues", item.contributions.totalCount);
  }
  for (const item of collection.pullRequestContributionsByRepository || []) {
    mergeRepo(repos, item.repository, "pullRequests", item.contributions.totalCount);
  }
  for (const item of collection.pullRequestReviewContributionsByRepository || []) {
    mergeRepo(repos, item.repository, "reviews", item.contributions.totalCount);
  }

  const sortedRepos = [...repos.values()]
    .sort((a, b) => {
      const aTotal = a.commits + a.issues + a.pullRequests + a.reviews;
      const bTotal = b.commits + b.issues + b.pullRequests + b.reviews;
      return bTotal - aTotal || b.stars - a.stars || a.nameWithOwner.localeCompare(b.nameWithOwner);
    })
    .slice(0, MAX_REPOS);

  const recentTotal =
    collection.totalCommitContributions +
    collection.totalIssueContributions +
    collection.totalPullRequestContributions +
    collection.totalPullRequestReviewContributions;

  const lines = [
    `Tracking **${user.repositoriesContributedTo.totalCount}** public repositories I have contributed to. Recent activity covers the last **${DAYS}** days: **${recentTotal}** contributions.`,
    "",
    "| Project | Description | Stars | Language | Recent activity |",
    "| --- | --- | ---: | --- | ---: |",
  ];

  for (const repo of sortedRepos) {
    const recent = repo.commits + repo.issues + repo.pullRequests + repo.reviews;
    const activity = [
      repo.commits ? `${repo.commits} commits` : "",
      repo.pullRequests ? `${repo.pullRequests} PRs` : "",
      repo.reviews ? `${repo.reviews} reviews` : "",
      repo.issues ? `${repo.issues} issues` : "",
    ]
      .filter(Boolean)
      .join(", ");

    lines.push(
      `| [${escapeCell(repo.nameWithOwner)}](${repo.url}) | ${escapeCell(compactDescription(repo.description))} | ${formatNumber(repo.stars)} | ${escapeCell(repo.language)} | ${escapeCell(activity || (recent ? String(recent) : "-"))} |`,
    );
  }

  lines.push("", `_Last updated: ${to.toISOString().slice(0, 10)} UTC_`);
  return lines.join("\n");
}

const data = await githubGraphql({
  login: USERNAME,
  from: from.toISOString(),
  to: to.toISOString(),
});

const readme = await readFile(README, "utf8");
const start = readme.indexOf(START);
const end = readme.indexOf(END);

if (start === -1 || end === -1 || start > end) {
  throw new Error(`README.md must contain ${START} and ${END} markers.`);
}

const generated = buildMarkdown(data);
const nextReadme = `${readme.slice(0, start + START.length)}\n${generated}\n${readme.slice(end)}`;

await writeFile(README, nextReadme);

