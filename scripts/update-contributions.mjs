import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const USERNAME = process.env.GH_LOGIN || process.env.GITHUB_REPOSITORY_OWNER || "runzhliu";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const README = path.resolve(process.cwd(), "README.md");
const START = "<!-- CONTRIBUTED_PROJECTS:START -->";
const END = "<!-- CONTRIBUTED_PROJECTS:END -->";
const DAYS = Number.parseInt(process.env.CONTRIBUTION_DAYS || "365", 10);
const FEATURED_LIMIT = Number.parseInt(process.env.FEATURED_REPO_LIMIT || "8", 10);
const EXTERNAL_LIMIT = Number.parseInt(process.env.EXTERNAL_REPO_LIMIT || "8", 10);

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
  forkCount
  isFork
  isArchived
  isPrivate
  updatedAt
  pushedAt
  primaryLanguage {
    name
    color
  }
`;

const query = `
query ProfileRepos(
  $login: String!
  $from: DateTime!
  $to: DateTime!
  $ownedAfter: String
  $contributedAfter: String
) {
  user(login: $login) {
    repositories(
      first: 100
      after: $ownedAfter
      ownerAffiliations: OWNER
      privacy: PUBLIC
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ${repositoryFields}
      }
    }
    repositoriesContributedTo(
      first: 100
      after: $contributedAfter
      includeUserRepositories: true
      contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, PULL_REQUEST_REVIEW]
    ) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
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

function blankActivity() {
  return {
    commits: 0,
    issues: 0,
    pullRequests: 0,
    reviews: 0,
  };
}

function normalizeRepo(repo) {
  return {
    nameWithOwner: repo.nameWithOwner,
    url: repo.url,
    description: repo.description || "",
    stars: repo.stargazerCount || 0,
    forks: repo.forkCount || 0,
    isFork: Boolean(repo.isFork),
    isArchived: Boolean(repo.isArchived),
    isPrivate: Boolean(repo.isPrivate),
    language: repo.primaryLanguage?.name || "",
    updatedAt: repo.updatedAt || "",
    pushedAt: repo.pushedAt || "",
    owned: false,
    contributed: false,
    activity: blankActivity(),
  };
}

function upsertRepo(target, repo, patch = {}) {
  if (!repo || repo.isPrivate) return null;

  const existing = target.get(repo.nameWithOwner) || normalizeRepo(repo);
  Object.assign(existing, patch);

  existing.description ||= repo.description || "";
  existing.stars = Math.max(existing.stars, repo.stargazerCount || 0);
  existing.forks = Math.max(existing.forks, repo.forkCount || 0);
  existing.language ||= repo.primaryLanguage?.name || "";
  existing.updatedAt = maxIso(existing.updatedAt, repo.updatedAt || "");
  existing.pushedAt = maxIso(existing.pushedAt, repo.pushedAt || "");

  target.set(existing.nameWithOwner, existing);
  return existing;
}

function addActivity(target, repo, kind, count = 0) {
  const existing = upsertRepo(target, repo, { contributed: true });
  if (!existing) return;

  existing.activity[kind] += count;
}

function maxIso(left, right) {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

function compactDescription(description, max = 150) {
  const normalized = String(description || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3).trim()}...`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en", { notation: "compact" }).format(value);
}

function plural(value, singular, pluralValue = `${singular}s`) {
  return `${formatNumber(value)} ${value === 1 ? singular : pluralValue}`;
}

function formatDate(value) {
  if (!value) return "";
  return value.slice(0, 10);
}

function formatActivity(repo) {
  const activity = repo.activity;
  return [
    activity.commits ? plural(activity.commits, "commit") : "",
    activity.pullRequests ? plural(activity.pullRequests, "PR") : "",
    activity.reviews ? plural(activity.reviews, "review") : "",
    activity.issues ? plural(activity.issues, "issue") : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function repoLine(repo, options = {}) {
  const meta = [
    repo.language,
    `⭐ ${plural(repo.stars, "star")}`,
    repo.forks ? `🍴 ${plural(repo.forks, "fork")}` : "",
    options.showActivity ? formatActivity(repo) : "",
    options.showUpdated ? `🕒 updated ${formatDate(repo.updatedAt)}` : "",
    repo.isFork ? "fork" : "",
    repo.isArchived ? "archived" : "",
  ].filter(Boolean);

  const description = compactDescription(repo.description);
  const suffix = meta.length ? ` - ${meta.join(" · ")}` : "";
  const body = description ? `  \n  ${description}` : "";

  return `- **[${repo.nameWithOwner}](${repo.url})**${suffix}${body}`;
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

async function fetchProfileData() {
  const repos = new Map();
  let ownedAfter = null;
  let contributedAfter = null;
  let collection = null;
  let ownedTotal = 0;
  let contributedTotal = 0;

  do {
    const data = await githubGraphql({
      login: USERNAME,
      from: from.toISOString(),
      to: to.toISOString(),
      ownedAfter,
      contributedAfter,
    });
    const user = data.user;

    collection ||= user.contributionsCollection;
    ownedTotal = user.repositories.totalCount;
    contributedTotal = user.repositoriesContributedTo.totalCount;

    for (const repo of user.repositories.nodes || []) {
      upsertRepo(repos, repo, { owned: true });
    }
    for (const repo of user.repositoriesContributedTo.nodes || []) {
      upsertRepo(repos, repo, { contributed: true });
    }

    ownedAfter = user.repositories.pageInfo.hasNextPage ? user.repositories.pageInfo.endCursor : null;
    contributedAfter = user.repositoriesContributedTo.pageInfo.hasNextPage
      ? user.repositoriesContributedTo.pageInfo.endCursor
      : null;
  } while (ownedAfter || contributedAfter);

  for (const item of collection.commitContributionsByRepository || []) {
    addActivity(repos, item.repository, "commits", item.contributions.totalCount);
  }
  for (const item of collection.issueContributionsByRepository || []) {
    addActivity(repos, item.repository, "issues", item.contributions.totalCount);
  }
  for (const item of collection.pullRequestContributionsByRepository || []) {
    addActivity(repos, item.repository, "pullRequests", item.contributions.totalCount);
  }
  for (const item of collection.pullRequestReviewContributionsByRepository || []) {
    addActivity(repos, item.repository, "reviews", item.contributions.totalCount);
  }

  return {
    repos: [...repos.values()].filter((repo) => !repo.isPrivate),
    collection,
    ownedTotal,
    contributedTotal,
  };
}

function activityTotal(repo) {
  return repo.activity.commits + repo.activity.issues + repo.activity.pullRequests + repo.activity.reviews;
}

function sortFeatured(left, right) {
  return (
    right.stars - left.stars ||
    activityTotal(right) - activityTotal(left) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.nameWithOwner.localeCompare(right.nameWithOwner)
  );
}

function sortUpdated(left, right) {
  return right.updatedAt.localeCompare(left.updatedAt) || left.nameWithOwner.localeCompare(right.nameWithOwner);
}

function buildSection(title, repos, options = {}) {
  if (!repos.length) return [];

  const lines = [`### ${title}`, ""];
  for (const repo of repos) {
    lines.push(repoLine(repo, options));
  }
  lines.push("");
  return lines;
}

function buildMarkdown(data) {
  const ownedRepos = data.repos.filter((repo) => repo.owned);
  const originalRepos = ownedRepos.filter((repo) => !repo.isFork);
  const forkRepos = ownedRepos.filter((repo) => repo.isFork);
  const externalRepos = data.repos.filter((repo) => repo.contributed && !repo.nameWithOwner.startsWith(`${USERNAME}/`));
  const activeRepos = data.repos.filter((repo) => activityTotal(repo) > 0);
  const recentTotal = activeRepos.reduce((total, repo) => total + activityTotal(repo), 0);
  const featuredRepos = originalRepos
    .filter((repo) => !repo.isArchived && repo.nameWithOwner !== `${USERNAME}/${USERNAME}`)
    .sort(sortFeatured)
    .slice(0, FEATURED_LIMIT);

  const lines = [
    `📦 Tracking **${data.ownedTotal}** public repositories under \`${USERNAME}\` and **${externalRepos.length}** external public projects with recognized GitHub contributions.`,
    `📈 Recent activity covers the last **${DAYS}** days: **${recentTotal}** commits, PRs, reviews and issues across **${activeRepos.length}** repositories.`,
    "",
    ...buildSection("✨ Featured Projects", featuredRepos, { showActivity: true }),
    ...buildSection("🤝 External Contributions", externalRepos.sort(sortFeatured).slice(0, EXTERNAL_LIMIT), {
      showActivity: true,
    }),
    "<details>",
    `<summary>📚 All public repositories (${ownedRepos.length})</summary>`,
    "",
    "#### 🧱 Original repositories",
    "",
    ...originalRepos.sort(sortUpdated).map((repo) => repoLine(repo, { showUpdated: true })),
    "",
    "#### 🍴 Forks and mirrors",
    "",
    ...forkRepos.sort(sortUpdated).map((repo) => repoLine(repo, { showUpdated: true })),
    "",
    "</details>",
    "",
    `_🕒 Last updated: ${to.toISOString().slice(0, 10)} UTC_`,
  ];

  return lines.join("\n");
}

const data = await fetchProfileData();
const readme = await readFile(README, "utf8");
const start = readme.indexOf(START);
const end = readme.indexOf(END);

if (start === -1 || end === -1 || start > end) {
  throw new Error(`README.md must contain ${START} and ${END} markers.`);
}

const generated = buildMarkdown(data);
const nextReadme = `${readme.slice(0, start + START.length)}\n${generated}\n${readme.slice(end)}`;

await writeFile(README, nextReadme);
