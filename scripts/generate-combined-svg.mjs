import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
const DAY_MS = 24 * 60 * 60 * 1000;
const COLOR_LEVELS = [0, 1, 2, 3, 4];
const EMPTY_ACTIVITY_TOTALS = Object.freeze({
  commits: 0,
  issues: 0,
  pullRequests: 0,
  reviews: 0
});
const ACTIVITY_SECTIONS = [
  { key: "commits", label: "Commits" },
  { key: "pullRequests", label: "Pull requests" },
  { key: "issues", label: "Issues" },
  { key: "reviews", label: "Code review" }
];
const CONTRIBUTIONS_QUERY = `
  query CombinedContributionStats($login: String!, $from: DateTime!, $to: DateTime!, $maxRepositories: Int!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        restrictedContributionsCount
        contributionCalendar {
          weeks {
            contributionDays {
              contributionCount
              date
            }
          }
        }
        totalCommitContributions
        totalIssueContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
        commitContributionsByRepository(maxRepositories: $maxRepositories) {
          repository {
            nameWithOwner
            url
          }
          contributions {
            totalCount
          }
        }
        issueContributionsByRepository(maxRepositories: $maxRepositories) {
          repository {
            nameWithOwner
            url
          }
          contributions {
            totalCount
          }
        }
        pullRequestContributionsByRepository(maxRepositories: $maxRepositories) {
          repository {
            nameWithOwner
            url
          }
          contributions {
            totalCount
          }
        }
        pullRequestReviewContributionsByRepository(maxRepositories: $maxRepositories) {
          repository {
            nameWithOwner
            url
          }
          contributions {
            totalCount
          }
        }
      }
    }
  }
`;

function readRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseUsers(value) {
  const users = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (users.length === 0) {
    throw new Error("USERS must include at least one GitHub username");
  }
  return users;
}

function parsePositiveInteger(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer but received: ${value}`);
  }

  return parsed;
}

function parseIntegerInRange(value, fallback, min, max) {
  const parsed = parsePositiveInteger(value, fallback);
  if (parsed < min || parsed > max) {
    throw new Error(`Expected a value between ${min} and ${max} but received: ${parsed}`);
  }
  return parsed;
}

function normalizeDate(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date, count) {
  return new Date(date.getTime() + count * DAY_MS);
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function estimateTextWidth(text, fontSize = 14) {
  return text.length * fontSize * 0.58;
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatNumber(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function envKeyForUser(login) {
  return `GITHUB_TOKEN_${login.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function tokenForUser(login) {
  return process.env[envKeyForUser(login)] || process.env.GITHUB_TOKEN || "";
}

function pickThreshold(sortedValues, ratio) {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.max(0, Math.ceil(sortedValues.length * ratio) - 1);
  return sortedValues[index];
}

function colorForCount(count, thresholds) {
  if (count <= 0) {
    return 0;
  }
  if (count <= thresholds[0]) {
    return 1;
  }
  if (count <= thresholds[1]) {
    return 2;
  }
  if (count <= thresholds[2]) {
    return 3;
  }
  return 4;
}

function buildLegend(x, y) {
  const swatchX = x + 28;
  const swatches = COLOR_LEVELS.map((level, index) => {
    const swatchOffset = swatchX + index * 14;
    return `<rect class="level-${level}" x="${swatchOffset}" y="${y - 8}" width="10" height="10" rx="2" ry="2" />`;
  }).join("");

  return [
    `<text class="fg-muted" x="${x}" y="${y}" font-size="10">Less</text>`,
    swatches,
    `<text class="fg-muted" x="${swatchX + COLOR_LEVELS.length * 14 + 4}" y="${y}" font-size="10">More</text>`
  ].join("");
}

function createActivityTotals(activity = {}) {
  return {
    commits: Number(activity.commits) || 0,
    issues: Number(activity.issues) || 0,
    pullRequests: Number(activity.pullRequests ?? activity.prs) || 0,
    reviews: Number(activity.reviews ?? activity.codeReviews) || 0
  };
}

function sumActivityTotals(totals) {
  return totals.commits + totals.issues + totals.pullRequests + totals.reviews;
}

function mergeActivityTotals(target, source) {
  for (const key of Object.keys(EMPTY_ACTIVITY_TOTALS)) {
    target[key] += source[key] || 0;
  }
}

function normalizeRepositoryEntries(entries) {
  if (!entries) {
    return [];
  }

  const values = Array.isArray(entries)
    ? entries
    : Object.entries(entries).map(([nameWithOwner, value]) => {
      if (typeof value === "number") {
        return { nameWithOwner, totalCount: value };
      }
      return { nameWithOwner, ...value };
    });

  return values
    .map((entry) => ({
      nameWithOwner: String(entry.nameWithOwner || "").trim(),
      url: String(entry.url || `https://github.com/${entry.nameWithOwner || ""}`).trim(),
      totalCount: Number(entry.totalCount ?? entry.count) || 0
    }))
    .filter((entry) => entry.nameWithOwner && entry.totalCount > 0)
    .sort((left, right) => right.totalCount - left.totalCount || left.nameWithOwner.localeCompare(right.nameWithOwner));
}

function mergeRepositoryTotals(target, repositories) {
  for (const repository of repositories) {
    const existing = target.get(repository.nameWithOwner) || {
      nameWithOwner: repository.nameWithOwner,
      url: repository.url,
      totalCount: 0
    };
    existing.totalCount += repository.totalCount;
    if (!existing.url && repository.url) {
      existing.url = repository.url;
    }
    target.set(repository.nameWithOwner, existing);
  }
}

function repositoriesFromContributionGroups(groups) {
  const repositories = new Map();

  for (const group of groups) {
    for (const entry of group || []) {
      const nameWithOwner = entry.repository?.nameWithOwner;
      const totalCount = Number(entry.contributions?.totalCount) || 0;
      if (!nameWithOwner || totalCount <= 0) {
        continue;
      }

      const existing = repositories.get(nameWithOwner) || {
        nameWithOwner,
        url: entry.repository?.url || `https://github.com/${nameWithOwner}`,
        totalCount: 0
      };

      existing.totalCount += totalCount;
      repositories.set(nameWithOwner, existing);
    }
  }

  return Array.from(repositories.values())
    .sort((left, right) => right.totalCount - left.totalCount || left.nameWithOwner.localeCompare(right.nameWithOwner));
}

let mockDataCache;

async function loadMockData(filePath) {
  if (!mockDataCache) {
    const raw = await fs.readFile(filePath, "utf8");
    mockDataCache = JSON.parse(raw);
  }
  return mockDataCache;
}

function normalizeMockDays(entry, login) {
  if (!entry) {
    throw new Error(`Mock data is missing an entry for ${login}`);
  }

  if (Array.isArray(entry)) {
    return entry.map((item) => ({
      date: String(item.date),
      contributionCount: Number(item.contributionCount) || 0
    }));
  }

  if (typeof entry === "object") {
    return Object.entries(entry).map(([date, count]) => ({
      date,
      contributionCount: Number(count) || 0
    }));
  }

  throw new Error(`Unsupported mock data format for ${login}`);
}

function normalizeMockContributionStats(entry, login, from, to) {
  if (!entry) {
    throw new Error(`Mock data is missing an entry for ${login}`);
  }

  const hasExtendedShape = typeof entry === "object"
    && !Array.isArray(entry)
    && (Object.hasOwn(entry, "calendar") || Object.hasOwn(entry, "days") || Object.hasOwn(entry, "activity") || Object.hasOwn(entry, "repositories"));

  const days = normalizeMockDays(hasExtendedShape ? (entry.calendar ?? entry.days ?? {}) : entry, login)
    .filter((day) => day.date >= from && day.date <= to);

  const fallbackTotals = { commits: days.reduce((sum, day) => sum + day.contributionCount, 0) };
  const activityTotals = createActivityTotals(hasExtendedShape ? (entry.activity || fallbackTotals) : fallbackTotals);
  const repositories = normalizeRepositoryEntries(hasExtendedShape ? entry.repositories : []);
  const restrictedContributions = Number(hasExtendedShape ? (entry.restrictedContributions ?? entry.privateContributions) : 0) || 0;

  return { days, activityTotals, repositories, restrictedContributions };
}

async function fetchContributionStatsRange(login, token, from, to, maxRepositories, ranges) {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "combine-gh-stats"
    },
    body: JSON.stringify({
      query: CONTRIBUTIONS_QUERY,
      variables: {
        login,
        from: `${from}T00:00:00.000Z`,
        to: `${to}T23:59:59.999Z`,
        maxRepositories
      }
    })
  });

  const payload = await response.json();
  const resourceLimitExceeded = payload.errors?.length
    && payload.errors.every((error) => error.type === "RESOURCE_LIMITS_EXCEEDED");

  if (resourceLimitExceeded && from < to) {
    const startDate = new Date(`${from}T00:00:00.000Z`);
    const endDate = new Date(`${to}T00:00:00.000Z`);
    const midpoint = addDays(startDate, Math.floor((endDate - startDate) / DAY_MS / 2));
    const leftEnd = formatDate(midpoint);
    const rightStart = formatDate(addDays(midpoint, 1));

    console.warn(`GitHub API resource limit reached for ${login}; retrying ${from} to ${to} as smaller ranges`);
    await fetchContributionStatsRange(login, token, from, leftEnd, maxRepositories, ranges);
    await fetchContributionStatsRange(login, token, rightStart, to, maxRepositories, ranges);
    return;
  }

  if (!response.ok || payload.errors?.length) {
    const message = payload.errors?.[0]?.message || response.statusText;
    throw new Error(`GitHub API request failed for ${login}: ${message}`);
  }

  const user = payload.data?.user;
  if (!user) {
    throw new Error(`GitHub user not found: ${login}`);
  }

  const collection = user.contributionsCollection;
  ranges.push({
    days: collection.contributionCalendar.weeks.flatMap((week) => week.contributionDays),
    activityTotals: createActivityTotals({
      commits: collection.totalCommitContributions,
      issues: collection.totalIssueContributions,
      pullRequests: collection.totalPullRequestContributions,
      reviews: collection.totalPullRequestReviewContributions
    }),
    restrictedContributions: Number(collection.restrictedContributionsCount) || 0,
    repositories: repositoriesFromContributionGroups([
      collection.commitContributionsByRepository,
      collection.issueContributionsByRepository,
      collection.pullRequestContributionsByRepository,
      collection.pullRequestReviewContributionsByRepository
    ])
  });
}

export async function fetchContributionStats(login, from, to, maxRepositories) {
  const mockFile = process.env.MOCK_DATA_FILE;
  if (mockFile) {
    const mockData = await loadMockData(mockFile);
    return normalizeMockContributionStats(mockData[login], login, from, to);
  }

  const token = tokenForUser(login);
  if (!token) {
    throw new Error(`Missing GITHUB_TOKEN or ${envKeyForUser(login)} for ${login}`);
  }

  const ranges = [];
  await fetchContributionStatsRange(login, token, from, to, maxRepositories, ranges);

  const days = [];
  const activityTotals = { ...EMPTY_ACTIVITY_TOTALS };
  const repositories = new Map();
  let restrictedContributions = 0;

  for (const range of ranges) {
    days.push(...range.days);
    mergeActivityTotals(activityTotals, range.activityTotals);
    mergeRepositoryTotals(repositories, range.repositories);
    restrictedContributions += range.restrictedContributions;
  }

  return {
    days,
    activityTotals,
    repositories: Array.from(repositories.values()),
    restrictedContributions
  };
}

function renderContributionHeatmapSvg({ days, weeks, users, totalContributions, title }) {
  const nonZeroCounts = days.map((day) => day.count).filter((count) => count > 0).sort((a, b) => a - b);
  const thresholds = [
    pickThreshold(nonZeroCounts, 0.25),
    pickThreshold(nonZeroCounts, 0.5),
    pickThreshold(nonZeroCounts, 0.75)
  ];

  const cellSize = 13;
  const gap = 3;
  const left = 32;
  const top = 30;
  const footerHeight = 28;
  const width = left + weeks.length * (cellSize + gap) + 8;
  const height = top + 7 * (cellSize + gap) + footerHeight;

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let lastRenderedMonth = -1;
  const monthLabels = weeks.map((week, weekIndex) => {
    const firstOfMonth = week.find((day) => day.date.slice(8) === "01");
    if (!firstOfMonth) {
      return "";
    }

    const monthIndex = Number.parseInt(firstOfMonth.date.slice(5, 7), 10) - 1;
    if (monthIndex === lastRenderedMonth) {
      return "";
    }

    lastRenderedMonth = monthIndex;
    const x = left + weekIndex * (cellSize + gap);
    return `<text class="fg-muted" x="${x}" y="16" font-size="10">${monthNames[monthIndex]}</text>`;
  }).join("");

  const weekdayLabels = [
    { label: "Mon", row: 1 },
    { label: "Wed", row: 3 },
    { label: "Fri", row: 5 }
  ].map(({ label, row }) => {
    const y = top + row * (cellSize + gap) + 8;
    return `<text class="fg-muted" x="0" y="${y}" font-size="10">${label}</text>`;
  }).join("");

  const cells = weeks.flatMap((week, weekIndex) => {
    return week.map((day, dayIndex) => {
      const x = left + weekIndex * (cellSize + gap);
      const y = top + dayIndex * (cellSize + gap);
      const level = colorForCount(day.count, thresholds);
      const titleText = `${day.date}: ${day.count} contribution${day.count === 1 ? "" : "s"}`;
      return `<rect class="level-${level}" x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" ry="2"><title>${escapeXml(titleText)}</title></rect>`;
    });
  }).join("");

  const subtitle = `${totalContributions} total contributions across ${users.length} account${users.length === 1 ? "" : "s"}`;
  const legend = buildLegend(width - 120, height - 8);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`,
    "  <style>",
    "    svg {",
    "      --fg-muted: #57606a;",
    "      --level-0: #ebedf0;",
    "      --level-1: #9be9a8;",
    "      --level-2: #40c463;",
    "      --level-3: #30a14e;",
    "      --level-4: #216e39;",
    "    }",
    "    @media (prefers-color-scheme: dark) {",
    "      svg {",
    "        --fg-muted: #8b949e;",
    "        --level-0: #161b22;",
    "        --level-1: #0e4429;",
    "        --level-2: #006d32;",
    "        --level-3: #26a641;",
    "        --level-4: #39d353;",
    "      }",
    "    }",
    "    text { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }",
    "    .fg-muted { fill: var(--fg-muted); }",
    "    .level-0 { fill: var(--level-0); }",
    "    .level-1 { fill: var(--level-1); }",
    "    .level-2 { fill: var(--level-2); }",
    "    .level-3 { fill: var(--level-3); }",
    "    .level-4 { fill: var(--level-4); }",
    "  </style>",
    `  <title>${escapeXml(title)}</title>`,
    `  <desc>${escapeXml(`${subtitle} for ${users.join(", ")}`)}</desc>`,
    `  <text class="fg-muted" x="0" y="${height - 8}" font-size="10">${escapeXml(subtitle)}</text>`,
    `  ${monthLabels}`,
    `  ${weekdayLabels}`,
    `  ${cells}`,
    `  ${legend}`,
    "</svg>"
  ].join("\n");
}

function computeCurrentStreak(days) {
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].count > 0) {
      streak++;
    } else if (streak > 0) {
      break;
    }
  }
  return streak;
}

function renderOverviewSvg({ users, dayCount, days, weeks, activityTotals, totalContributions, restrictedContributions, title }) {
  const weeklyTotals = weeks.map((week) => week.reduce((sum, d) => sum + d.count, 0));
  const nonZeroWeekly = weeklyTotals.filter((t) => t > 0).sort((a, b) => a - b);
  const weekThresholds = [
    pickThreshold(nonZeroWeekly, 0.25),
    pickThreshold(nonZeroWeekly, 0.5),
    pickThreshold(nonZeroWeekly, 0.75)
  ];
  const maxWeekly = Math.max(...weeklyTotals, 1);
  const currentStreak = computeCurrentStreak(days);

  const barWidth = 13;
  const barGap = 3;
  const barStep = barWidth + barGap;
  const maxBarH = 60;
  const padX = 20;
  const numWeeks = weeks.length;

  const width = padX + numWeeks * barStep - barGap + padX;

  const headerY = 14;
  const barsBottomY = headerY + 14 + maxBarH;
  const monthLabelY = barsBottomY + 14;
  const dividerY = monthLabelY + 10;
  const footerY = dividerY + 16;
  const restrictedNote = restrictedContributions > 0
    ? `GitHub reports ${formatNumber(restrictedContributions)} private contribution${restrictedContributions === 1 ? "" : "s"} in this window, so commits, PRs, issues, and reviews may not add up to the total.`
    : "";
  const restrictedNoteY = footerY + 11;
  const height = restrictedNote ? restrictedNoteY + 8 : footerY + 14;

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let lastMonth = -1;
  const barsAndLabels = weeks.map((week, wi) => {
    const total = weeklyTotals[wi];
    const level = colorForCount(total, weekThresholds);
    const barH = total === 0 ? 2 : Math.max(3, Math.round(maxBarH * total / maxWeekly));
    const x = padX + wi * barStep;
    const y = barsBottomY - barH;
    const titleText = `Week of ${week[0]?.date ?? "unknown"}: ${total} contribution${total === 1 ? "" : "s"}`;
    const bar = `<rect class="level-${level}" x="${x}" y="${y}" width="${barWidth}" height="${barH}" rx="1" ry="1"><title>${escapeXml(titleText)}</title></rect>`;

    const firstOfMonth = week.find((d) => d.date.slice(8) === "01");
    let monthLabel = "";
    if (firstOfMonth) {
      const monthIndex = Number.parseInt(firstOfMonth.date.slice(5, 7), 10) - 1;
      if (monthIndex !== lastMonth) {
        lastMonth = monthIndex;
        monthLabel = `<text class="fg-muted" x="${x}" y="${monthLabelY}" font-size="10">${monthNames[monthIndex]}</text>`;
      }
    }

    return bar + monthLabel;
  }).join("");

  const usersText = users.map((u) => `@${u}`).join(" · ");
  const periodText = `${formatNumber(dayCount)}-day window`;
  const streakSuffix = currentStreak > 1 ? `  ·  ${formatNumber(currentStreak)}-day streak` : "";

  const footerTspans = [
    `<tspan class="fg" font-weight="600">${escapeXml(formatNumber(activityTotals.commits))}</tspan><tspan class="fg-muted"> commits</tspan>`,
    `<tspan class="fg-muted">  ·  </tspan><tspan class="fg" font-weight="600">${escapeXml(formatNumber(activityTotals.pullRequests))}</tspan><tspan class="fg-muted"> PRs</tspan>`,
    `<tspan class="fg-muted">  ·  </tspan><tspan class="fg" font-weight="600">${escapeXml(formatNumber(activityTotals.issues))}</tspan><tspan class="fg-muted"> issues</tspan>`,
    `<tspan class="fg-muted">  ·  </tspan><tspan class="fg" font-weight="600">${escapeXml(formatNumber(activityTotals.reviews))}</tspan><tspan class="fg-muted"> reviews</tspan>`,
    `<tspan class="fg-muted">  ·  </tspan><tspan class="fg" font-weight="600">${escapeXml(formatNumber(totalContributions))}</tspan><tspan class="fg-muted"> total${escapeXml(streakSuffix)}</tspan>`
  ].join("");

  const description = `Weekly activity rhythm for ${users.join(", ")} over ${dayCount} days. ${formatNumber(activityTotals.commits)} commits, ${formatNumber(activityTotals.pullRequests)} PRs, ${formatNumber(activityTotals.issues)} issues, ${formatNumber(activityTotals.reviews)} reviews. ${formatNumber(totalContributions)} total contributions.${restrictedNote ? ` ${restrictedNote}` : ""}`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`,
    "  <style>",
    "    svg {",
    "      --fg: #24292f;",
    "      --fg-muted: #57606a;",
    "      --divider: #d0d7de;",
    "      --level-0: #ebedf0;",
    "      --level-1: #9be9a8;",
    "      --level-2: #40c463;",
    "      --level-3: #30a14e;",
    "      --level-4: #216e39;",
    "    }",
    "    @media (prefers-color-scheme: dark) {",
    "      svg {",
    "        --fg: #f0f6fc;",
    "        --fg-muted: #8b949e;",
    "        --divider: #30363d;",
    "        --level-0: #161b22;",
    "        --level-1: #0e4429;",
    "        --level-2: #006d32;",
    "        --level-3: #26a641;",
    "        --level-4: #39d353;",
    "      }",
    "    }",
    "    text { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }",
    "    .fg { fill: var(--fg); }",
    "    .fg-muted { fill: var(--fg-muted); }",
    "    .divider { stroke: var(--divider); fill: none; }",
    "    .level-0 { fill: var(--level-0); }",
    "    .level-1 { fill: var(--level-1); }",
    "    .level-2 { fill: var(--level-2); }",
    "    .level-3 { fill: var(--level-3); }",
    "    .level-4 { fill: var(--level-4); }",
    "  </style>",
    `  <title>${escapeXml(title)}</title>`,
    `  <desc>${escapeXml(description)}</desc>`,
    `  <text class="fg-muted" x="${padX}" y="${headerY}" font-size="10">${escapeXml(usersText)}</text>`,
    `  <text class="fg-muted" x="${width - padX}" y="${headerY}" font-size="10" text-anchor="end">${escapeXml(periodText)}</text>`,
    `  ${barsAndLabels}`,
    `  <line class="divider" x1="${padX}" y1="${dividerY}" x2="${width - padX}" y2="${dividerY}" stroke-width="1" />`,
    `  <text x="${padX}" y="${footerY}" font-size="11">${footerTspans}</text>`,
    restrictedNote ? `  <text class="fg-muted" x="${padX}" y="${restrictedNoteY}" font-size="9">${escapeXml(restrictedNote)}</text>` : "",
    "</svg>"
  ].join("\n");
}

function defaultOverviewOutputFile(outputFile) {
  const directory = path.dirname(outputFile);
  return directory === "."
    ? "combined-activity-overview.svg"
    : path.join(directory, "combined-activity-overview.svg");
}

async function main() {
  const users = parseUsers(readRequiredEnv("USERS"));
  const outputFile = process.env.OUTPUT_FILE?.trim() || "combined-contributions.svg";
  const overviewOutputFile = process.env.OVERVIEW_OUTPUT_FILE?.trim() || defaultOverviewOutputFile(outputFile);
  const title = process.env.TITLE?.trim() || "Combined GitHub Contributions";
  const overviewTitle = process.env.OVERVIEW_TITLE?.trim() || "Combined GitHub Activity Overview";
  const dayCount = parsePositiveInteger(process.env.DAYS, 365);
  const maxRepositories = parseIntegerInRange(process.env.MAX_REPOSITORIES, 100, 1, 100);
  const maxOverviewRepos = parseIntegerInRange(process.env.OVERVIEW_REPOS_TO_SHOW, 3, 1, 10);
  const endDate = normalizeDate(new Date());
  const startDate = addDays(endDate, -(dayCount - 1));
  const start = formatDate(startDate);
  const end = formatDate(endDate);

  const totalsByDate = new Map();
  const activityTotals = { ...EMPTY_ACTIVITY_TOTALS };
  const repositories = new Map();
  let restrictedContributions = 0;

  for (const login of users) {
    const stats = await fetchContributionStats(login, start, end, maxRepositories);

    for (const day of stats.days) {
      totalsByDate.set(day.date, (totalsByDate.get(day.date) || 0) + day.contributionCount);
    }

    mergeActivityTotals(activityTotals, stats.activityTotals);
    mergeRepositoryTotals(repositories, stats.repositories);
    restrictedContributions += stats.restrictedContributions || 0;
  }

  const gridStart = addDays(startDate, -startDate.getUTCDay());
  const gridEnd = addDays(endDate, 6 - endDate.getUTCDay());
  const renderedDays = [];

  for (let cursor = gridStart; cursor <= gridEnd; cursor = addDays(cursor, 1)) {
    const date = formatDate(cursor);
    renderedDays.push({ date, count: totalsByDate.get(date) || 0 });
  }

  const weeks = [];
  for (let index = 0; index < renderedDays.length; index += 7) {
    weeks.push(renderedDays.slice(index, index + 7));
  }

  const totalContributions = Array.from(totalsByDate.values()).reduce((sum, count) => sum + count, 0);
  const sortedRepositories = Array.from(repositories.values())
    .sort((left, right) => right.totalCount - left.totalCount || left.nameWithOwner.localeCompare(right.nameWithOwner));

  const contributionSvg = renderContributionHeatmapSvg({
    days: renderedDays,
    weeks,
    users,
    totalContributions,
    title
  });
  const overviewSvg = renderOverviewSvg({
    users,
    dayCount,
    days: renderedDays,
    weeks,
    repositories: sortedRepositories,
    activityTotals,
    totalContributions,
    restrictedContributions,
    title: overviewTitle,
    maxOverviewRepos
  });

  await Promise.all([
    fs.mkdir(path.dirname(outputFile), { recursive: true }),
    fs.mkdir(path.dirname(overviewOutputFile), { recursive: true })
  ]);
  await Promise.all([
    fs.writeFile(outputFile, `${contributionSvg}\n`, "utf8"),
    fs.writeFile(overviewOutputFile, `${overviewSvg}\n`, "utf8")
  ]);

  process.stdout.write(`Wrote ${outputFile} and ${overviewOutputFile} for ${users.join(", ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
