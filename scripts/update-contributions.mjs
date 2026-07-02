import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const USERNAME = process.env.GH_LOGIN || process.env.GITHUB_REPOSITORY_OWNER || "runzhliu";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const README = path.resolve(process.cwd(), "README.md");
const BLOG_START = "<!-- BLOG_POSTS:START -->";
const BLOG_END = "<!-- BLOG_POSTS:END -->";
const CONTRIBUTIONS_START = "<!-- CONTRIBUTED_PROJECTS:START -->";
const CONTRIBUTIONS_END = "<!-- CONTRIBUTED_PROJECTS:END -->";
const BLOG_URL = process.env.BLOG_URL || "https://runzhliu.cn/";
const BLOG_FEED_URL = process.env.BLOG_FEED_URL || "https://runzhliu.cn/index.xml";
const BLOG_POST_LIMIT = Number.parseInt(process.env.BLOG_POST_LIMIT || "3", 10);
const DAYS = Number.parseInt(process.env.CONTRIBUTION_DAYS || "365", 10);
const FEATURED_LIMIT = Number.parseInt(process.env.FEATURED_REPO_LIMIT || "8", 10);
const EXTERNAL_LIMIT = Number.parseInt(process.env.EXTERNAL_REPO_LIMIT || "12", 10);
const SEARCH_MAX_PAGES = Number.parseInt(process.env.SEARCH_MAX_PAGES || "10", 10);

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

function blankSignals() {
  return {
    authoredPRs: 0,
    authoredIssues: 0,
    reviewedPRs: 0,
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
    signals: blankSignals(),
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

function addSignal(target, repo, kind, count = 0) {
  const existing = upsertRepo(target, repo, { contributed: true });
  if (!existing) return;

  existing.signals[kind] += count;
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

function decodeHtml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&#43;/g, "+")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, "...")
    .trim();
}

function pickXmlTag(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return decodeHtml(match?.[1] || "");
}

function absoluteUrl(url) {
  return new URL(url, BLOG_URL).toString();
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

function formatSignals(repo) {
  const signals = repo.signals;
  return [
    signals.authoredPRs ? plural(signals.authoredPRs, "authored PR", "authored PRs") : "",
    signals.authoredIssues ? plural(signals.authoredIssues, "authored issue") : "",
    signals.reviewedPRs ? plural(signals.reviewedPRs, "reviewed PR", "reviewed PRs") : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function repoLine(repo, options = {}) {
  const meta = [
    repo.language,
    `⭐ ${plural(repo.stars, "star")}`,
    repo.forks ? `🍴 ${plural(repo.forks, "fork")}` : "",
    options.showSignals ? formatSignals(repo) : "",
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

async function githubRest(endpoint, params = {}) {
  const url = new URL(endpoint, "https://api.github.com");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": `${USERNAME}-profile-readme`,
    },
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(payload, null, 2));
  }

  return payload;
}

async function fetchBlogPosts() {
  try {
    const response = await fetch(BLOG_FEED_URL, {
      headers: {
        "User-Agent": `${USERNAME}-profile-readme`,
      },
    });

    if (!response.ok) {
      throw new Error(`Blog feed returned HTTP ${response.status}`);
    }

    const xml = await response.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
      .map((match) => {
        const item = match[1];
        return {
          title: pickXmlTag(item, "title"),
          url: absoluteUrl(pickXmlTag(item, "link")),
          date: new Date(pickXmlTag(item, "pubDate")).toISOString().slice(0, 10),
        };
      })
      .filter((post) => post.title && post.url)
      .slice(0, BLOG_POST_LIMIT);
  } catch (error) {
    console.warn(`Unable to update blog posts: ${error.message}`);
    return [];
  }
}

function buildBlogMarkdown(posts) {
  if (!posts.length) {
    return `- [Visit my podcast and blog](${BLOG_URL})`;
  }

  return posts.map((post) => `- 📝 [${post.title}](${post.url}) - ${post.date}`).join("\n");
}

function restRepoToGraphqlShape(repo) {
  return {
    nameWithOwner: repo.full_name,
    url: repo.html_url,
    description: repo.description || "",
    stargazerCount: repo.stargazers_count || 0,
    forkCount: repo.forks_count || 0,
    isFork: Boolean(repo.fork),
    isArchived: Boolean(repo.archived),
    isPrivate: Boolean(repo.private),
    updatedAt: repo.updated_at || "",
    pushedAt: repo.pushed_at || "",
    primaryLanguage: repo.language ? { name: repo.language, color: "" } : null,
  };
}

async function searchIssueRepos(queryText) {
  const repos = new Map();
  let page = 1;
  let totalCount = 0;

  do {
    const payload = await githubRest("/search/issues", {
      q: queryText,
      per_page: 100,
      page,
    });
    totalCount = Math.min(payload.total_count || 0, 1000);

    for (const item of payload.items || []) {
      const fullName = item.repository_url.split("/repos/")[1];
      if (!fullName) continue;
      repos.set(fullName, (repos.get(fullName) || 0) + 1);
    }

    if (!payload.items || payload.items.length < 100) break;
    page += 1;
  } while ((page - 1) * 100 < totalCount && page <= SEARCH_MAX_PAGES);

  return repos;
}

async function fetchRepo(fullName) {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return null;

  try {
    const payload = await githubRest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    return restRepoToGraphqlShape(payload);
  } catch {
    return null;
  }
}

async function addSearchContributions(repos) {
  const searches = [
    {
      kind: "authoredPRs",
      query: `author:${USERNAME} type:pr is:public -user:${USERNAME}`,
    },
    {
      kind: "authoredIssues",
      query: `author:${USERNAME} type:issue is:public -user:${USERNAME}`,
    },
    {
      kind: "reviewedPRs",
      query: `reviewed-by:${USERNAME} type:pr is:public -user:${USERNAME}`,
    },
  ];
  const repoCache = new Map();

  for (const search of searches) {
    const results = await searchIssueRepos(search.query);

    for (const [fullName, count] of results.entries()) {
      if (!repoCache.has(fullName)) {
        repoCache.set(fullName, await fetchRepo(fullName));
      }

      const repo = repoCache.get(fullName);
      if (!repo) continue;

      addSignal(repos, repo, search.kind, count);
    }
  }
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

  await addSearchContributions(repos);

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

function signalTotal(repo) {
  return repo.signals.authoredPRs + repo.signals.authoredIssues + repo.signals.reviewedPRs;
}

function sortFeatured(left, right) {
  return (
    right.stars - left.stars ||
    activityTotal(right) - activityTotal(left) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.nameWithOwner.localeCompare(right.nameWithOwner)
  );
}

function sortExternal(left, right) {
  return (
    signalTotal(right) - signalTotal(left) ||
    activityTotal(right) - activityTotal(left) ||
    right.stars - left.stars ||
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
  const sortedExternalRepos = externalRepos.sort(sortExternal);
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
    ...buildSection("🤝 External Contributions", sortedExternalRepos.slice(0, EXTERNAL_LIMIT), {
      showSignals: true,
      showActivity: true,
    }),
    "<details>",
    `<summary>🌐 All recognized external projects (${externalRepos.length})</summary>`,
    "",
    ...sortedExternalRepos.map((repo) => repoLine(repo, { showSignals: true, showActivity: true })),
    "",
    "</details>",
    "",
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
const posts = await fetchBlogPosts();
const readme = await readFile(README, "utf8");

function replaceSection(content, startMarker, endMarker, generated) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);

  if (start === -1 || end === -1 || start > end) {
    throw new Error(`README.md must contain ${startMarker} and ${endMarker} markers.`);
  }

  return `${content.slice(0, start + startMarker.length)}\n${generated}\n${content.slice(end)}`;
}

const nextReadme = replaceSection(
  replaceSection(readme, BLOG_START, BLOG_END, buildBlogMarkdown(posts)),
  CONTRIBUTIONS_START,
  CONTRIBUTIONS_END,
  buildMarkdown(data),
);

await writeFile(README, nextReadme);
