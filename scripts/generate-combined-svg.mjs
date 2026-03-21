import fs from "node:fs/promises";
import path from "node:path";

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

  return { days, activityTotals, repositories };
}

async function fetchContributionStats(login, from, to, maxRepositories) {
  const mockFile = process.env.MOCK_DATA_FILE;
  if (mockFile) {
    const mockData = await loadMockData(mockFile);
    return normalizeMockContributionStats(mockData[login], login, from, to);
  }

  const token = tokenForUser(login);
  if (!token) {
    throw new Error(`Missing GITHUB_TOKEN or ${envKeyForUser(login)} for ${login}`);
  }

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
  if (!response.ok || payload.errors?.length) {
    const message = payload.errors?.[0]?.message || response.statusText;
    throw new Error(`GitHub API request failed for ${login}: ${message}`);
  }

  const user = payload.data?.user;
  if (!user) {
    throw new Error(`GitHub user not found: ${login}`);
  }

  const collection = user.contributionsCollection;
  return {
    days: collection.contributionCalendar.weeks.flatMap((week) => week.contributionDays),
    activityTotals: createActivityTotals({
      commits: collection.totalCommitContributions,
      issues: collection.totalIssueContributions,
      pullRequests: collection.totalPullRequestContributions,
      reviews: collection.totalPullRequestReviewContributions
    }),
    repositories: repositoriesFromContributionGroups([
      collection.commitContributionsByRepository,
      collection.issueContributionsByRepository,
      collection.pullRequestContributionsByRepository,
      collection.pullRequestReviewContributionsByRepository
    ])
  };
}

function renderContributionHeatmapSvg({ days, weeks, users, totalContributions, title }) {
  const nonZeroCounts = days.map((day) => day.count).filter((count) => count > 0).sort((a, b) => a - b);
  const thresholds = [
    pickThreshold(nonZeroCounts, 0.25),
    pickThreshold(nonZeroCounts, 0.5),
    pickThreshold(nonZeroCounts, 0.75)
  ];

  const cellSize = 11;
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

function buildActivityPercentages(activityTotals) {
  const counts = ACTIVITY_SECTIONS.map((section) => activityTotals[section.key]);
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    return ACTIVITY_SECTIONS.reduce((result, section) => ({ ...result, [section.key]: 0 }), {});
  }

  const exact = counts.map((count) => (count / total) * 100);
  const roundedDown = exact.map((value) => Math.floor(value));
  let remaining = 100 - roundedDown.reduce((sum, value) => sum + value, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - roundedDown[index] }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);

  for (let index = 0; index < remaining; index += 1) {
    roundedDown[order[index].index] += 1;
  }

  return ACTIVITY_SECTIONS.reduce((result, section, index) => {
    result[section.key] = roundedDown[index];
    return result;
  }, {});
}

function formatActivitySummary(activityTotals) {
  const percentages = buildActivityPercentages(activityTotals);
  const total = sumActivityTotals(activityTotals);

  return ACTIVITY_SECTIONS.map((section) => ({
    key: section.key,
    label: section.label,
    count: activityTotals[section.key],
    percentage: percentages[section.key],
    total
  }));
}

function renderUserChips(users, startX, startY, maxWidth) {
  const chipHeight = 32;
  const gapX = 10;
  const gapY = 10;
  let x = startX;
  let y = startY;

  const chips = users.map((login) => {
    const label = `@${login}`;
    const chipWidth = Math.max(80, Math.ceil(estimateTextWidth(label, 14) + 36));
    if (x !== startX && x + chipWidth > maxWidth) {
      x = startX;
      y += chipHeight + gapY;
    }

    const svg = [
      `<g transform="translate(${x} ${y})">`,
      `  <rect class="chip" width="${chipWidth}" height="${chipHeight}" rx="10" ry="10" />`,
      "  <circle class=\"chip-dot\" cx=\"15\" cy=\"16\" r=\"5\" />",
      `  <text class="fg" x="28" y="21" font-size="14" font-weight="600">${escapeXml(label)}</text>`,
      "</g>"
    ].join("\n");

    x += chipWidth + gapX;
    return svg;
  }).join("\n");

  return {
    svg: chips,
    height: y - startY + chipHeight
  };
}

function renderRepositoryList(repositories, x, y, maxCount) {
  if (repositories.length === 0) {
    return {
      svg: `<text class="fg-muted" x="${x}" y="${y}" font-size="14">No repository activity found in the selected window.</text>`,
      height: 24
    };
  }

  const lines = repositories.slice(0, maxCount).map((repository, index) => {
    const lineY = y + index * 24;
    const label = `${truncateText(repository.nameWithOwner, 34)} (${repository.totalCount})`;
    return [
      `<circle class="repo-dot" cx="${x + 5}" cy="${lineY - 5}" r="4" />`,
      `<text class="accent" x="${x + 18}" y="${lineY}" font-size="15" font-weight="600">${escapeXml(label)}</text>`
    ].join("");
  }).join("");

  const remainingCount = repositories.length - Math.min(repositories.length, maxCount);
  const overflow = remainingCount > 0
    ? `<text class="fg-muted" x="${x}" y="${y + Math.min(repositories.length, maxCount) * 24 + 12}" font-size="13">and ${remainingCount} other repositor${remainingCount === 1 ? "y" : "ies"}</text>`
    : "";

  return {
    svg: `${lines}${overflow}`,
    height: Math.min(repositories.length, maxCount) * 24 + (remainingCount > 0 ? 24 : 0)
  };
}

function renderActivityBreakdown(rows, x, y, rowHeight) {
  return rows.map((row, index) => {
    const rowY = y + index * rowHeight;
    const trackY = rowY + 10;
    const trackWidth = 164;
    const fillWidth = Math.max(row.percentage === 0 ? 0 : 6, Math.round(trackWidth * (row.percentage / 100)));

    return [
      `<text class="fg" x="${x}" y="${rowY}" font-size="14" font-weight="600">${escapeXml(row.label)}</text>`,
      `<text class="fg-muted" x="${x + 222}" y="${rowY}" font-size="13" text-anchor="end">${row.percentage}%</text>`,
      `<text class="fg-muted" x="${x + 232}" y="${rowY}" font-size="13">${row.count}</text>`,
      `<rect class="breakdown-track" x="${x}" y="${trackY}" width="${trackWidth}" height="8" rx="999" ry="999" />`,
      `<rect class="breakdown-fill" x="${x}" y="${trackY}" width="${fillWidth}" height="8" rx="999" ry="999" />`
    ].join("");
  }).join("");
}

function renderOverviewSvg({ users, dayCount, repositories, activityTotals, totalContributions, title, maxOverviewRepos }) {
  const width = 860;
  const padX = 28;

  const chipLayout = renderUserChips(users, padX, 24, width - padX * 2);
  const chipBottom = 24 + chipLayout.height;

  const activityRows = formatActivitySummary(activityTotals);
  const activityContributionCount = activityRows[0]?.total || 0;
  const repositoryCount = repositories.length;

  // Vertical layout: chips → title row → separator → stats → separator → breakdown label → bars → repos
  const titleY = chipBottom + 24;
  const sep1Y = titleY + 18;
  const statsNumY = sep1Y + 36;
  const statsLabelY = statsNumY + 18;
  const sep2Y = statsLabelY + 22;
  const breakdownLabelY = sep2Y + 22;
  const barsStart = breakdownLabelY + 18;
  const barRowHeight = 44;
  const reposBaselineY = barsStart + activityRows.length * barRowHeight + 22;
  const height = reposBaselineY + 28;

  const repositorySummary = repositoryCount === 0
    ? `No repositories contributed to in the last ${dayCount} days`
    : `Contributed to ${repositoryCount} repositor${repositoryCount === 1 ? "y" : "ies"} in the last ${dayCount} days`;
  const description = `${repositorySummary}. ${activityContributionCount} typed contributions and ${totalContributions} calendar contributions across ${users.join(", ")}.`;

  // Four key stats displayed as large numbers
  const statCellWidth = (width - padX * 2) / 4;
  const statItems = [
    { value: formatNumber(totalContributions), label: "calendar contributions" },
    { value: formatNumber(activityContributionCount), label: "typed contributions" },
    { value: formatNumber(repositoryCount), label: "repositories" },
    { value: formatNumber(dayCount), label: "days tracked" }
  ];
  const statsSvg = statItems.map((item, i) => {
    const x = padX + i * statCellWidth;
    return [
      `<text class="fg" x="${x}" y="${statsNumY}" font-size="24" font-weight="700">${escapeXml(item.value)}</text>`,
      `<text class="fg-muted" x="${x}" y="${statsLabelY}" font-size="12">${escapeXml(item.label)}</text>`
    ].join("\n");
  }).join("\n");

  // Full-width activity bars
  const barLabelWidth = 120;
  const barTrackWidth = width - padX * 2 - barLabelWidth - 110;
  const barX = padX + barLabelWidth;
  const barCountX = width - padX;
  const barPctX = barCountX - 52;
  const barsSvg = activityRows.map((row, i) => {
    const y = barsStart + i * barRowHeight;
    const fillWidth = Math.max(row.percentage === 0 ? 0 : 4, Math.round(barTrackWidth * (row.percentage / 100)));
    return [
      `<text class="fg" x="${padX}" y="${y + 14}" font-size="14" font-weight="600">${escapeXml(row.label)}</text>`,
      `<rect class="breakdown-track" x="${barX}" y="${y + 4}" width="${barTrackWidth}" height="10" rx="999" ry="999" />`,
      `<rect class="breakdown-fill" x="${barX}" y="${y + 4}" width="${fillWidth}" height="10" rx="999" ry="999" />`,
      `<text class="fg-muted" x="${barPctX}" y="${y + 14}" font-size="13" text-anchor="end">${row.percentage}%</text>`,
      `<text class="fg-muted" x="${barCountX}" y="${y + 14}" font-size="13" text-anchor="end">${escapeXml(formatNumber(row.count))}</text>`
    ].join("\n");
  }).join("\n");

  // Top repos as an inline text line at the bottom
  const topRepos = repositories.slice(0, maxOverviewRepos);
  const remainingCount = repositories.length - topRepos.length;
  let reposSvgStr;
  if (repositories.length === 0) {
    reposSvgStr = `<text class="fg-muted" x="${padX}" y="${reposBaselineY}" font-size="13">No repository activity in the last ${dayCount} days</text>`;
  } else {
    const repoNames = topRepos.map((r) => truncateText(r.nameWithOwner, 35)).join("  ·  ");
    const overflow = remainingCount > 0 ? `  ·  and ${remainingCount} more` : "";
    reposSvgStr = `<text class="fg-muted" x="${padX}" y="${reposBaselineY}" font-size="13">${escapeXml(repoNames + overflow)}</text>`;
  }

  const periodText = `${formatNumber(dayCount)}-day window`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`,
    "  <style>",
    "    svg {",
    "      --bg: #ffffff;",
    "      --card-stroke: #d0d7de;",
    "      --fg: #1f2328;",
    "      --fg-muted: #656d76;",
    "      --chip-bg: #f6f8fa;",
    "      --chip-stroke: #d8dee4;",
    "      --chip-dot: #1f883d;",
    "      --breakdown-track: #eaeef2;",
    "      --breakdown-fill: #1f883d;",
    "    }",
    "    @media (prefers-color-scheme: dark) {",
    "      svg {",
    "        --bg: #0d1117;",
    "        --card-stroke: #30363d;",
    "        --fg: #f0f6fc;",
    "        --fg-muted: #8b949e;",
    "        --chip-bg: #161b22;",
    "        --chip-stroke: #30363d;",
    "        --chip-dot: #39d353;",
    "        --breakdown-track: #21262d;",
    "        --breakdown-fill: #39d353;",
    "      }",
    "    }",
    "    text { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }",
    "    .card { fill: var(--bg); stroke: var(--card-stroke); }",
    "    .fg { fill: var(--fg); }",
    "    .fg-muted { fill: var(--fg-muted); }",
    "    .chip { fill: var(--chip-bg); stroke: var(--chip-stroke); }",
    "    .chip-dot { fill: var(--chip-dot); }",
    "    .divider { stroke: var(--card-stroke); stroke-width: 1; fill: none; }",
    "    .breakdown-track { fill: var(--breakdown-track); }",
    "    .breakdown-fill { fill: var(--breakdown-fill); }",
    "  </style>",
    `  <title>${escapeXml(title)}</title>`,
    `  <desc>${escapeXml(description)}</desc>`,
    `  <rect class="card" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="18" ry="18" />`,
    `  ${chipLayout.svg}`,
    `  <text class="fg" x="${padX}" y="${titleY}" font-size="17" font-weight="700">${escapeXml(title)}</text>`,
    `  <text class="fg-muted" x="${width - padX}" y="${titleY}" font-size="12" text-anchor="end">${escapeXml(periodText)}</text>`,
    `  <line class="divider" x1="${padX}" y1="${sep1Y}" x2="${width - padX}" y2="${sep1Y}" />`,
    `  ${statsSvg}`,
    `  <line class="divider" x1="${padX}" y1="${sep2Y}" x2="${width - padX}" y2="${sep2Y}" />`,
    `  <text class="fg-muted" x="${padX}" y="${breakdownLabelY}" font-size="11" font-weight="600" letter-spacing="0.08em">ACTIVITY BREAKDOWN</text>`,
    `  ${barsSvg}`,
    `  ${reposSvgStr}`,
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

  for (const login of users) {
    const stats = await fetchContributionStats(login, start, end, maxRepositories);

    for (const day of stats.days) {
      totalsByDate.set(day.date, (totalsByDate.get(day.date) || 0) + day.contributionCount);
    }

    mergeActivityTotals(activityTotals, stats.activityTotals);
    mergeRepositoryTotals(repositories, stats.repositories);
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
    repositories: sortedRepositories,
    activityTotals,
    totalContributions,
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

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
