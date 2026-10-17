import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_QUERY_DAYS = 90;
const COLOR_LEVELS = [0, 1, 2, 3, 4];
const EMPTY_ACTIVITY_TOTALS = Object.freeze({
  commits: 0,
  issues: 0,
  pullRequests: 0,
  reviews: 0
});
// SVGs are drawn on a ~790px canvas but declared larger so GitHub (which only shrinks images, never grows them)
// scales them down to fill the full README column.
const DISPLAY_SCALE = 1.2;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
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

function formatNumber(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const MAX_RATE_LIMIT_ATTEMPTS = 5;
const RATE_LIMIT_BASE_BACKOFF_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseHeaderSeconds(value) {
  if (value == null || value === "") {
    return null;
  }
  const seconds = Number.parseFloat(value);
  return Number.isFinite(seconds) ? seconds : null;
}

function computeRateLimitSleepMs(response, attempt) {
  const headers = response.headers || {};
  const getHeader = typeof headers.get === "function" ? headers.get.bind(headers) : (name) => headers[name];

  const retryAfter = parseHeaderSeconds(getHeader("Retry-After"));
  if (retryAfter != null) {
    return Math.max(0, retryAfter * 1000);
  }

  const reset = parseHeaderSeconds(getHeader("X-RateLimit-Reset"));
  if (reset != null) {
    const nowSeconds = Date.now() / 1000;
    const remaining = reset - nowSeconds;
    if (remaining > 0) {
      return remaining * 1000;
    }
    return 0;
  }

  return RATE_LIMIT_BASE_BACKOFF_MS * 2 ** attempt;
}

// Log-spaced thresholds so a few very large days/weeks don't wash out everything else.
function logThresholds(maxValue) {
  const logMax = Math.log1p(Math.max(maxValue, 0));
  return [1, 2, 3].map((step) => Math.expm1(logMax * step / 4));
}

// Percentile of the non-zero values, used to cap the scale so one huge outlier doesn't compress everything else.
function nonZeroPercentile(values, ratio) {
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return 0;
  }
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
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

function createActivityTotals(activity = {}) {
  return {
    commits: Number(activity.commits) || 0,
    issues: Number(activity.issues) || 0,
    pullRequests: Number(activity.pullRequests ?? activity.prs) || 0,
    reviews: Number(activity.reviews ?? activity.codeReviews) || 0
  };
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
  let response;
  let payload;

  for (let attempt = 0; attempt < MAX_RATE_LIMIT_ATTEMPTS; attempt++) {
    response = await fetch(GRAPHQL_ENDPOINT, {
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

    if (response.status === 403 || response.status === 429) {
      const sleepMs = computeRateLimitSleepMs(response, attempt);
      console.warn(
        `GitHub API rate limit hit for ${login} (${response.status}); sleeping ${Math.round(sleepMs)} ms before retry (attempt ${attempt + 1}/${MAX_RATE_LIMIT_ATTEMPTS})`
      );
      await sleep(sleepMs);
      continue;
    }

    break;
  }

  if (response.status === 403 || response.status === 429) {
    throw new Error(
      `GitHub API rate limit exceeded for ${login} after ${MAX_RATE_LIMIT_ATTEMPTS} attempts; aborting ${from} to ${to}`
    );
  }

  const responseText = await response.text();
  payload = {};
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = {};
    }
  }
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
    const snippet = responseText.slice(0, 200);
    throw new Error(`GitHub API request failed for ${login}: ${message} (HTTP ${response.status}${snippet ? `: ${snippet}` : ""})`);
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

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("Missing GITHUB_TOKEN environment variable");
  }

  const requestedQueryDays = parsePositiveInteger(process.env.MAX_QUERY_DAYS, DEFAULT_QUERY_DAYS);
  const maxQueryDays = Math.min(requestedQueryDays, 365);
  if (requestedQueryDays > 365) {
    console.warn(`MAX_QUERY_DAYS=${requestedQueryDays} exceeds GitHub's 1-year window; clamping to 365.`);
  }
  const startDate = new Date(`${from}T00:00:00.000Z`);
  const endDate = new Date(`${to}T00:00:00.000Z`);
  const ranges = [];

  for (let rangeStart = startDate; rangeStart <= endDate;) {
    const rangeEnd = new Date(Math.min(
      addDays(rangeStart, maxQueryDays - 1).getTime(),
      endDate.getTime()
    ));

    await fetchContributionStatsRange(
      login,
      token,
      formatDate(rangeStart),
      formatDate(rangeEnd),
      maxRepositories,
      ranges
    );
    rangeStart = addDays(rangeEnd, 1);
  }

  const days = [];
  const seenDates = new Set();
  const activityTotals = { ...EMPTY_ACTIVITY_TOTALS };
  const repositories = new Map();
  let restrictedContributions = 0;

  for (const range of ranges) {
    for (const day of range.days) {
      if (seenDates.has(day.date)) {
        continue;
      }
      seenDates.add(day.date);
      days.push(day);
    }
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

// Shared palette and type for both SVGs. GitHub's own contribution greens, a single warm accent for "hot" states.
function themeStyle(rules) {
  return [
    "  <style>",
    "    svg {",
    "      --ink: #1f2328;",
    "      --muted: #6e7781;",
    "      --hairline: #d8dee4;",
    "      --hot: #f0541e;",
    "      --level-0: #ebedf0;",
    "      --level-1: #9be9a8;",
    "      --level-2: #40c463;",
    "      --level-3: #30a14e;",
    "      --level-4: #216e39;",
    "    }",
    "    @media (prefers-color-scheme: dark) {",
    "      svg {",
    "        --ink: #f0f6fc;",
    "        --muted: #7d8590;",
    "        --hairline: #262c34;",
    "        --hot: #ff7b45;",
    "        --level-0: #161b22;",
    "        --level-1: #0e4429;",
    "        --level-2: #006d32;",
    "        --level-3: #26a641;",
    "        --level-4: #39d353;",
    "      }",
    "    }",
    "    text { font-family: Inter, 'SF Pro Display', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; }",
    "    .ink { fill: var(--ink); }",
    "    .muted { fill: var(--muted); }",
    "    .hot { fill: var(--hot); }",
    "    .level-0 { fill: var(--level-0); }",
    "    .level-1 { fill: var(--level-1); }",
    "    .level-2 { fill: var(--level-2); }",
    "    .level-3 { fill: var(--level-3); }",
    "    .level-4 { fill: var(--level-4); }",
    "    .overloaded { fill: var(--hot); }",
    "    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }",
    ...rules.map((rule) => `    ${rule}`),
    "  </style>"
  ];
}

// Legend shows the actual per-day range behind each shade, derived from the same thresholds colorForCount uses.
function buildLegend(rightX, y, thresholds, cap) {
  const bounds = thresholds.map(Math.floor);
  const ranges = [
    { level: 0, lo: 0, hi: 0 },
    { level: 1, lo: 1, hi: bounds[0] },
    { level: 2, lo: bounds[0] + 1, hi: bounds[1] },
    { level: 3, lo: bounds[1] + 1, hi: bounds[2] },
    { level: 4, lo: bounds[2] + 1, hi: Math.floor(cap) },
    { level: "hot", lo: Math.floor(cap) + 1, hi: Infinity }
  ].filter(({ lo, hi }) => lo <= hi);

  const fontSize = 9;
  const swatchSize = 8;
  const items = ranges.map(({ level, lo, hi }) => {
    const label = hi === Infinity ? `${formatNumber(lo)}+` : lo === hi ? formatNumber(lo) : `${formatNumber(lo)}–${formatNumber(hi)}`;
    return { level, label, width: swatchSize + 4 + estimateTextWidth(label, fontSize) };
  });
  const itemGap = 12;
  const caption = "per day";
  const totalW = estimateTextWidth(caption, fontSize) + itemGap + items.reduce((sum, item) => sum + item.width, 0) + itemGap * (items.length - 1);

  let x = rightX - totalW;
  const parts = [`<text class="muted" x="${x}" y="${y}" font-size="${fontSize}">${caption}</text>`];
  x += estimateTextWidth(caption, fontSize) + itemGap;
  for (const item of items) {
    parts.push(`<rect class="${item.level === "hot" ? "overloaded" : `level-${item.level}`}" x="${x}" y="${y - 7}" width="${swatchSize}" height="${swatchSize}" rx="2" ry="2" />`);
    parts.push(`<text class="muted" x="${x + swatchSize + 4}" y="${y}" font-size="${fontSize}">${item.label}</text>`);
    x += item.width + itemGap;
  }
  return parts.join("");
}

export function renderContributionHeatmapSvg({ days, weeks, users, totalContributions, title }) {
  // Days above the 95th percentile are "overloaded" and drawn in the hot accent, like overloaded weeks.
  const dailyCap = nonZeroPercentile(days.map((day) => day.count), 0.95);
  const thresholds = logThresholds(dailyCap);

  const cellSize = 11;
  const gap = 4;
  const step = cellSize + gap;
  // Header row: total on the left, per-day legend on the right; month labels sit between it and the grid.
  const headerY = 30;
  const monthY = headerY + 22;
  const top = monthY + 8;
  const gridW = weeks.length * step - gap;
  const gridH = 7 * step - gap;
  const width = gridW;
  const height = top + gridH + 2;

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
    return `<text class="muted" x="${weekIndex * step}" y="${monthY}" font-size="9">${MONTH_NAMES[monthIndex]}</text>`;
  }).join("");

  const cells = weeks.flatMap((week, weekIndex) => {
    return week.map((day, dayIndex) => {
      const overloaded = day.count > dailyCap;
      const fillClass = overloaded ? "overloaded" : `level-${colorForCount(day.count, thresholds)}`;
      const titleText = `${day.date}: ${day.count} contribution${day.count === 1 ? "" : "s"}${overloaded ? " (overloaded)" : ""}`;
      const delay = (weekIndex + dayIndex) * 12;
      return `<rect class="cell ${fillClass}" style="animation-delay:${delay}ms" x="${weekIndex * step}" y="${top + dayIndex * step}" width="${cellSize}" height="${cellSize}" rx="2.5" ry="2.5"><title>${escapeXml(titleText)}</title></rect>`;
    });
  }).join("");

  const totalText = formatNumber(totalContributions);
  const subtitle = `${formatNumber(totalContributions)} contributions across ${users.length} account${users.length === 1 ? "" : "s"}`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width * DISPLAY_SCALE)}" height="${Math.round(height * DISPLAY_SCALE)}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`,
    ...themeStyle([
      ".cell { transform-box: fill-box; transform-origin: center; animation: cell-in 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) both; }",
      "@keyframes cell-in { from { opacity: 0; transform: scale(0.4); } to { opacity: 1; transform: none; } }",
      ".total { animation: rise 0.8s cubic-bezier(0.2, 0.8, 0.2, 1) both; }",
      ".legend { animation: rise 0.8s cubic-bezier(0.2, 0.8, 0.2, 1) 0.15s both; }",
      "@media (prefers-reduced-motion: reduce) { .cell, .total, .legend { animation: none; } }"
    ]),
    `  <title>${escapeXml(title)}</title>`,
    `  <desc>${escapeXml(`${subtitle} for ${users.join(", ")}`)}</desc>`,
    `  ${monthLabels}`,
    `  <g>${cells}</g>`,
    `  <text class="total" x="0" y="${headerY}"><tspan class="ink" font-size="34" font-weight="300" letter-spacing="-1">${escapeXml(totalText)}</tspan><tspan class="muted" font-size="10" dx="10">contributions in the last year</tspan></text>`,
    `  <g class="legend">${buildLegend(width, headerY, thresholds, dailyCap)}</g>`,
    "</svg>"
  ].join("\n");
}

export function renderOverviewSvg({ users, dayCount, days, weeks, activityTotals, totalContributions, restrictedContributions, title }) {
  const weeklyTotals = weeks.map((week) => week.reduce((sum, d) => sum + d.count, 0));
  const weeklyCap = Math.max(nonZeroPercentile(weeklyTotals, 0.95), 1);
  const weekThresholds = logThresholds(weeklyCap);

  // Momentum: last 7 days against the weekly average of the 8 weeks before them.
  const lastWeekTotal = days.slice(-7).reduce((sum, day) => sum + day.count, 0);
  const baselineDays = days.slice(-63, -7);
  const baselineWeekly = baselineDays.length >= 7 ? baselineDays.reduce((sum, day) => sum + day.count, 0) / (baselineDays.length / 7) : 0;
  const momentum = baselineWeekly > 0 ? lastWeekTotal / baselineWeekly : 0;
  const status = momentum >= 2.5 ? "Unstoppable" : momentum >= 1.5 ? "On fire" : momentum > 1 ? "Heating up" : null;

  // Bars share the heatmap's 15px column so the two images line up when stacked.
  const barWidth = 11;
  const barGap = 4;
  const barStep = barWidth + barGap;
  const maxBarH = 64;
  const numWeeks = weeks.length;
  const width = numWeeks * barStep - barGap;

  const headerY = 10;
  const barsTopY = 46;
  const barsBottomY = barsTopY + maxBarH;
  const monthLabelY = barsBottomY + 15;
  const height = monthLabelY + 4;

  const statusText = status ? `${status} · ${momentum.toFixed(1)}× usual pace` : "";
  const statusLine = status
    ? `<g class="status"><title>${escapeXml(`${formatNumber(lastWeekTotal)} contributions in the last 7 days vs ${formatNumber(Math.round(baselineWeekly))}/week over the previous 8 weeks`)}</title>` +
      `<text class="hot" x="${width - 18}" y="${headerY}" font-size="10" font-weight="500" text-anchor="end">${escapeXml(statusText)}</text>` +
      `<circle class="ping" cx="${width - 8}" cy="${headerY - 3.5}" r="2.5" /><circle class="dot" cx="${width - 8}" cy="${headerY - 3.5}" r="2.5" /></g>`
    : "";

  const barsDelayMs = 250;

  const scaleHeight = (value) => maxBarH * Math.sqrt(value / weeklyCap);

  // Gridlines at round values (1/2/5 × 10^n) nearest to ¼, ½ and ¾ of the chart height, labelled so the
  // square-root scale can still be read: the uneven spacing of the labels shows the axis isn't linear.
  const roundToNice = (value) => {
    const magnitude = 10 ** Math.floor(Math.log10(value));
    return [1, 2, 5, 10]
      .map((m) => m * magnitude)
      .reduce((best, candidate) => (Math.abs(Math.log(candidate / value)) < Math.abs(Math.log(best / value)) ? candidate : best));
  };
  const tickValues = [...new Set([0.25, 0.5, 0.75].map((fraction) => roundToNice(weeklyCap * fraction ** 2)))]
    .filter((value) => value >= 1 && value < weeklyCap);
  const topTick = Math.max(...tickValues);
  const gridlines = tickValues.map((value) => {
    const y = barsBottomY - Math.round(scaleHeight(value)) + 0.5;
    return `<line class="grid" x1="0" y1="${y}" x2="${width}" y2="${y}" />` +
      `<text class="muted" x="0" y="${y - 3}" font-size="8">${formatNumber(value)}${value === topTick ? " / week" : ""}</text>`;
  });
  const overloaded = weeklyTotals.map((total) => total > weeklyCap);

  // Each run of consecutive overloaded weeks gets one bracket + label above it.
  const overloadMarks = [];
  for (let wi = 0; wi < numWeeks; wi++) {
    if (!overloaded[wi] || overloaded[wi - 1]) {
      continue;
    }
    let runEnd = wi;
    while (overloaded[runEnd + 1]) {
      runEnd++;
    }
    const x1 = wi * barStep;
    const x2 = (runEnd + 1) * barStep - barGap;
    const bracketY = barsTopY - 9;
    const runPeak = Math.max(...weeklyTotals.slice(wi, runEnd + 1));
    const labelText = `OVERLOADED · ${formatNumber(runPeak)}`;
    // Letter-spaced caps run ~0.68em + 2px per glyph; keep the label inside the canvas.
    const labelW = labelText.length * (8 * 0.68 + 2);
    const labelX = Math.min(Math.max((x1 + x2) / 2, labelW / 2), width - labelW / 2);
    overloadMarks.push(
      `<g class="overload-mark"><path class="bracket" d="M${x1 + 0.5} ${bracketY + 4}V${bracketY + 0.5}H${x2 - 0.5}V${bracketY + 4}" />` +
      `<text class="hot" x="${labelX}" y="${bracketY - 5}" font-size="8" font-weight="600" letter-spacing="2" text-anchor="middle">${labelText}</text></g>`
    );
  }

  let lastMonth = -1;
  const barsAndLabels = weeks.map((week, wi) => {
    const total = weeklyTotals[wi];
    const level = colorForCount(total, weekThresholds);
    // Square-root scale capped at the 95th percentile; weeks above the cap are drawn full height as "overloaded".
    const barH = total === 0 ? 2 : Math.max(3, Math.round(scaleHeight(Math.min(total, weeklyCap))));
    const x = wi * barStep;
    const y = barsBottomY - barH;
    const delay = barsDelayMs + wi * 14;
    const titleText = `Week of ${week[0]?.date ?? "unknown"}: ${total} contribution${total === 1 ? "" : "s"}${overloaded[wi] ? " (overloaded)" : ""}`;
    const bar = overloaded[wi]
      ? `<rect class="glow" x="${x}" y="${y}" width="${barWidth}" height="${barH}" rx="2.5" ry="2.5" filter="url(#hot-blur)" />` +
        `<rect class="bar overloaded" style="animation-delay:${delay}ms" x="${x}" y="${y}" width="${barWidth}" height="${barH}" rx="2.5" ry="2.5"><title>${escapeXml(titleText)}</title></rect>`
      : `<rect class="bar level-${level}" style="animation-delay:${delay}ms" x="${x}" y="${y}" width="${barWidth}" height="${barH}" rx="2.5" ry="2.5"><title>${escapeXml(titleText)}</title></rect>`;

    const firstOfMonth = week.find((d) => d.date.slice(8) === "01");
    let monthLabel = "";
    if (firstOfMonth) {
      const monthIndex = Number.parseInt(firstOfMonth.date.slice(5, 7), 10) - 1;
      if (monthIndex !== lastMonth) {
        lastMonth = monthIndex;
        monthLabel = `<text class="muted" x="${x}" y="${monthLabelY}" font-size="9">${MONTH_NAMES[monthIndex]}</text>`;
      }
    }

    return bar + monthLabel;
  }).join("");

  const usersText = users.map((u) => `@${u}`).join("  ·  ");
  const restrictedNote = restrictedContributions > 0
    ? ` GitHub reports ${formatNumber(restrictedContributions)} private contribution${restrictedContributions === 1 ? "" : "s"} in this window, so commits, PRs, issues, and reviews may not add up to the total.`
    : "";
  const description = `Weekly activity rhythm for ${users.join(", ")} over ${dayCount} days. ${formatNumber(activityTotals.commits)} commits, ${formatNumber(activityTotals.pullRequests)} PRs, ${formatNumber(activityTotals.issues)} issues, ${formatNumber(activityTotals.reviews)} reviews. ${formatNumber(totalContributions)} total contributions.${restrictedNote}`;

  // Overload glow and marks appear once the bars have finished growing.
  const overloadDelayMs = barsDelayMs + numWeeks * 14 + 400;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width * DISPLAY_SCALE)}" height="${Math.round(height * DISPLAY_SCALE)}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`,
    ...themeStyle([
      ".grid { stroke: var(--hairline); stroke-width: 1; stroke-dasharray: 2 3; }",
      ".baseline { stroke: var(--hairline); stroke-width: 1; stroke-dasharray: 1; stroke-dashoffset: 1; animation: draw 0.9s cubic-bezier(0.6, 0, 0.2, 1) 0.2s forwards; }",
      ".bar { transform-box: fill-box; transform-origin: 50% 100%; animation: grow 0.7s cubic-bezier(0.2, 0.8, 0.2, 1) both; }",
      `.glow { fill: var(--hot); opacity: 0; animation: glow-in 0.6s ease-out ${overloadDelayMs}ms forwards, breathe 2.4s ease-in-out ${overloadDelayMs + 600}ms infinite; }`,
      ".bracket { fill: none; stroke: var(--hot); stroke-width: 1; opacity: 0.7; }",
      `.overload-mark { animation: rise 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) ${overloadDelayMs}ms both; }`,
      ".dot, .ping { fill: var(--hot); }",
      ".ping { transform-box: fill-box; transform-origin: center; animation: ping 1.8s cubic-bezier(0, 0, 0.2, 1) infinite; }",
      ".status { animation: rise 0.6s ease-out 0.1s both; }",
      "@keyframes grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }",
      "@keyframes draw { to { stroke-dashoffset: 0; } }",
      "@keyframes glow-in { to { opacity: 0.55; } }",
      "@keyframes breathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 0.2; } }",
      "@keyframes ping { from { transform: scale(1); opacity: 0.7; } to { transform: scale(3.2); opacity: 0; } }",
      "@media (prefers-reduced-motion: reduce) { .baseline, .bar, .glow, .overload-mark, .ping, .status { animation: none; } .baseline { stroke-dashoffset: 0; } .glow { opacity: 0.4; } }"
    ]),
    "  <defs>",
    `    <filter id="hot-blur" x="-150%" y="-30%" width="400%" height="160%"><feGaussianBlur stdDeviation="4" /></filter>`,
    "  </defs>",
    `  <title>${escapeXml(title)}</title>`,
    `  <desc>${escapeXml(description)}</desc>`,
    `  <text class="muted" x="0" y="${headerY}" font-size="10">${escapeXml(usersText)}</text>`,
    statusLine ? `  ${statusLine}` : "",
    `  ${gridlines.join("")}`,
    `  ${barsAndLabels}`,
    `  <line class="baseline" x1="0" y1="${barsBottomY + 0.5}" x2="${width}" y2="${barsBottomY + 0.5}" pathLength="1" />`,
    ...overloadMarks.map((mark) => `  ${mark}`),
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
    activityTotals,
    totalContributions,
    restrictedContributions,
    title: overviewTitle
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
