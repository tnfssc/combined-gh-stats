import assert from "node:assert/strict";
import test from "node:test";

import { fetchContributionStats, renderOverviewSvg } from "../scripts/generate-combined-svg.mjs";

function successfulPayload({ days, commits, issues, pullRequests, reviews, restricted, repositories }) {
  return {
    data: {
      user: {
        contributionsCollection: {
          restrictedContributionsCount: restricted,
          contributionCalendar: {
            weeks: [{ contributionDays: days }]
          },
          totalCommitContributions: commits,
          totalIssueContributions: issues,
          totalPullRequestContributions: pullRequests,
          totalPullRequestReviewContributions: reviews,
          commitContributionsByRepository: repositories.map((repository) => ({
            repository: {
              nameWithOwner: repository.nameWithOwner,
              url: `https://github.com/${repository.nameWithOwner}`
            },
            contributions: {
              totalCount: repository.totalCount
            }
          })),
          issueContributionsByRepository: [],
          pullRequestContributionsByRepository: [],
          pullRequestReviewContributionsByRepository: []
        }
      }
    }
  };
}

test("bounds request ranges, splits resource errors, and merges contribution stats", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;
  const originalMockFile = process.env.MOCK_DATA_FILE;
  const originalMaxQueryDays = process.env.MAX_QUERY_DAYS;
  const originalWarn = console.warn;
  const requests = [];
  const warnings = [];

  context.after(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
    if (originalMockFile === undefined) {
      delete process.env.MOCK_DATA_FILE;
    } else {
      process.env.MOCK_DATA_FILE = originalMockFile;
    }
    if (originalMaxQueryDays === undefined) {
      delete process.env.MAX_QUERY_DAYS;
    } else {
      process.env.MAX_QUERY_DAYS = originalMaxQueryDays;
    }
  });

  process.env.GITHUB_TOKEN = "test-token";
  process.env.MAX_QUERY_DAYS = "4";
  delete process.env.MOCK_DATA_FILE;
  console.warn = (message) => warnings.push(message);
  globalThis.fetch = async (_url, options) => {
    const { variables } = JSON.parse(options.body);
    requests.push([variables.from.slice(0, 10), variables.to.slice(0, 10)]);

    if (variables.from.startsWith("2026-01-01") && variables.to.startsWith("2026-01-04")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({
          errors: [{
            type: "RESOURCE_LIMITS_EXCEEDED",
            message: "Resource limits for this query exceeded."
          }]
        })
      };
    }

    const firstHalf = variables.from.startsWith("2026-01-01");
    const secondHalf = variables.from.startsWith("2026-01-03");
    const payload = firstHalf
      ? successfulPayload({
          days: [
            { date: "2026-01-01", contributionCount: 1 },
            { date: "2026-01-02", contributionCount: 2 }
          ],
          commits: 3,
          issues: 1,
          pullRequests: 0,
          reviews: 1,
          restricted: 1,
          repositories: [{ nameWithOwner: "acme/app", totalCount: 2 }]
        })
      : secondHalf
        ? successfulPayload({
          days: [
            { date: "2026-01-03", contributionCount: 3 },
            { date: "2026-01-04", contributionCount: 4 }
          ],
          commits: 7,
          issues: 0,
          pullRequests: 2,
          reviews: 1,
          restricted: 2,
          repositories: [
            { nameWithOwner: "acme/app", totalCount: 4 },
            { nameWithOwner: "acme/api", totalCount: 2 }
          ]
        })
        : successfulPayload({
          days: [
            { date: "2026-01-05", contributionCount: 5 },
            { date: "2026-01-06", contributionCount: 6 },
            { date: "2026-01-07", contributionCount: 7 },
            { date: "2026-01-08", contributionCount: 8 }
          ],
          commits: 26,
          issues: 2,
          pullRequests: 1,
          reviews: 3,
          restricted: 4,
          repositories: [{ nameWithOwner: "acme/api", totalCount: 5 }]
        });

    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify(payload)
    };
  };

  const stats = await fetchContributionStats("active-user", "2026-01-01", "2026-01-08", 100);

  assert.deepEqual(requests, [
    ["2026-01-01", "2026-01-04"],
    ["2026-01-01", "2026-01-02"],
    ["2026-01-03", "2026-01-04"],
    ["2026-01-05", "2026-01-08"]
  ]);
  assert.deepEqual(stats.days.map((day) => day.date), [
    "2026-01-01",
    "2026-01-02",
    "2026-01-03",
    "2026-01-04",
    "2026-01-05",
    "2026-01-06",
    "2026-01-07",
    "2026-01-08"
  ]);
  assert.deepEqual(stats.activityTotals, {
    commits: 36,
    issues: 3,
    pullRequests: 3,
    reviews: 5
  });
  assert.equal(stats.restrictedContributions, 7);
  assert.deepEqual(stats.repositories, [
    {
      nameWithOwner: "acme/app",
      url: "https://github.com/acme/app",
      totalCount: 6
    },
    {
      nameWithOwner: "acme/api",
      url: "https://github.com/acme/api",
      totalCount: 7
    }
  ]);
  assert.equal(warnings.length, 1);
});

test("clamps MAX_QUERY_DAYS above 365 to 365", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;
  const originalMockFile = process.env.MOCK_DATA_FILE;
  const originalMaxQueryDays = process.env.MAX_QUERY_DAYS;
  const originalWarn = console.warn;
  const requests = [];
  const warnings = [];

  context.after(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
    if (originalMockFile === undefined) {
      delete process.env.MOCK_DATA_FILE;
    } else {
      process.env.MOCK_DATA_FILE = originalMockFile;
    }
    if (originalMaxQueryDays === undefined) {
      delete process.env.MAX_QUERY_DAYS;
    } else {
      process.env.MAX_QUERY_DAYS = originalMaxQueryDays;
    }
  });

  process.env.GITHUB_TOKEN = "test-token";
  process.env.MAX_QUERY_DAYS = "400";
  delete process.env.MOCK_DATA_FILE;
  console.warn = (message) => warnings.push(message);
  globalThis.fetch = async (_url, options) => {
    const { variables } = JSON.parse(options.body);
    requests.push([variables.from.slice(0, 10), variables.to.slice(0, 10)]);

    const fromMs = new Date(variables.from).getTime();
    const toMs = new Date(variables.to).getTime();
    assert.ok(
      toMs - fromMs < 365 * 24 * 60 * 60 * 1000,
      `range ${variables.from}..${variables.to} exceeds 365-day window`
    );

    const payload = successfulPayload({
      days: [{ date: variables.to.slice(0, 10), contributionCount: 1 }],
      commits: 1,
      issues: 0,
      pullRequests: 0,
      reviews: 0,
      restricted: 0,
      repositories: []
    });
    return {
      ok: true,
      statusText: "OK",
      text: async () => JSON.stringify(payload),
      json: async () => payload
    };
  };

  const stats = await fetchContributionStats("active-user", "2026-01-01", "2026-12-31", 100);

  assert.equal(requests.length, 1, "single request expected for a within-year window");
  assert.deepEqual(requests[0], ["2026-01-01", "2026-12-31"]);
  assert.equal(stats.activityTotals.commits, 1);
  assert.ok(
    warnings.some((m) => /clamping to 365/.test(m)),
    `expected a clamp warning, got: ${JSON.stringify(warnings)}`
  );
});

test("dedupes days that appear at chunk boundaries across consecutive chunks", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;
  const originalMockFile = process.env.MOCK_DATA_FILE;
  const originalMaxQueryDays = process.env.MAX_QUERY_DAYS;

  context.after(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
    if (originalMockFile === undefined) {
      delete process.env.MOCK_DATA_FILE;
    } else {
      process.env.MOCK_DATA_FILE = originalMockFile;
    }
    if (originalMaxQueryDays === undefined) {
      delete process.env.MAX_QUERY_DAYS;
    } else {
      process.env.MAX_QUERY_DAYS = originalMaxQueryDays;
    }
  });

  process.env.GITHUB_TOKEN = "test-token";
  process.env.MAX_QUERY_DAYS = "2";
  delete process.env.MOCK_DATA_FILE;

  // Two consecutive chunks (each full calendar week returned by GitHub) both
  // return the boundary date 2026-01-02. Without dedupe the merged count for
  // that date would be 2x; with dedupe it must equal the single value.
  const boundaryDate = "2026-01-02";
  const boundaryCount = 5;

  globalThis.fetch = async (_url, options) => {
    const { variables } = JSON.parse(options.body);
    const firstChunk = variables.from.startsWith("2026-01-01");
    const secondChunk = variables.from.startsWith("2026-01-03");

    const days = firstChunk
      ? [
          { date: "2026-01-01", contributionCount: 1 },
          { date: boundaryDate, contributionCount: boundaryCount }
        ]
      : secondChunk
        ? [
            { date: boundaryDate, contributionCount: boundaryCount },
            { date: "2026-01-03", contributionCount: 3 }
          ]
        : [];

    const payload = successfulPayload({
      days,
      commits: days.reduce((sum, day) => sum + day.contributionCount, 0),
      issues: 0,
      pullRequests: 0,
      reviews: 0,
      restricted: 0,
      repositories: []
    });
    return {
      ok: true,
      statusText: "OK",
      text: async () => JSON.stringify(payload),
      json: async () => payload
    };
  };

  const stats = await fetchContributionStats("boundary-user", "2026-01-01", "2026-01-03", 100);

  // The boundary date must appear exactly once.
  const boundaryDays = stats.days.filter((day) => day.date === boundaryDate);
  assert.equal(boundaryDays.length, 1, "boundary date counted more than once");
  assert.equal(boundaryDays[0].contributionCount, boundaryCount);
  assert.deepEqual(stats.days.map((day) => day.date), [
    "2026-01-01",
    "2026-01-02",
    "2026-01-03"
  ]);
});

test("throws error with status code (not SyntaxError) on non-JSON 5xx response", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;
  const originalMockFile = process.env.MOCK_DATA_FILE;
  const originalMaxQueryDays = process.env.MAX_QUERY_DAYS;

  context.after(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
    if (originalMockFile === undefined) {
      delete process.env.MOCK_DATA_FILE;
    } else {
      process.env.MOCK_DATA_FILE = originalMockFile;
    }
    if (originalMaxQueryDays === undefined) {
      delete process.env.MAX_QUERY_DAYS;
    } else {
      process.env.MAX_QUERY_DAYS = originalMaxQueryDays;
    }
  });

  process.env.GITHUB_TOKEN = "test-token";
  process.env.MAX_QUERY_DAYS = "4";
  delete process.env.MOCK_DATA_FILE;

  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    statusText: "Internal Server Error",
    text: async () => "<!DOCTYPE html><html><body>Server error</body></html>"
  });

  await assert.rejects(
    fetchContributionStats("active-user", "2026-01-01", "2026-01-08", 100),
    (error) => {
      assert.equal(error.name, "Error", "should not be a SyntaxError");
      assert.ok(!error.message.includes("SyntaxError"), "should not be a SyntaxError");
      assert.ok(error.message.includes("500"), `message should include status 500: ${error.message}`);
      return true;
    }
  );
});

test("retries on HTTP 403 rate limit then succeeds", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;
  const originalMockFile = process.env.MOCK_DATA_FILE;
  const originalMaxQueryDays = process.env.MAX_QUERY_DAYS;
  const originalWarn = console.warn;
  const warnings = [];
  const calls = [];

  context.after(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
    if (originalMockFile === undefined) {
      delete process.env.MOCK_DATA_FILE;
    } else {
      process.env.MOCK_DATA_FILE = originalMockFile;
    }
    if (originalMaxQueryDays === undefined) {
      delete process.env.MAX_QUERY_DAYS;
    } else {
      process.env.MAX_QUERY_DAYS = originalMaxQueryDays;
    }
  });

  process.env.GITHUB_TOKEN = "test-token";
  process.env.MAX_QUERY_DAYS = "4";
  delete process.env.MOCK_DATA_FILE;
  console.warn = (message) => warnings.push(message);

  globalThis.fetch = async () => {
    calls.push(calls.length);
    if (calls.length === 1) {
      return {
        ok: false,
        status: 403,
        statusText: "Forbidden",
        headers: new Map([["Retry-After", "0"]]),
        text: async () => '{"message": "rate limit"}',
        json: async () => ({ message: "rate limit" })
      };
    }

    const payload = successfulPayload({
      days: [
        { date: "2026-01-01", contributionCount: 1 },
        { date: "2026-01-02", contributionCount: 2 }
      ],
      commits: 3,
      issues: 1,
      pullRequests: 0,
      reviews: 1,
      restricted: 0,
      repositories: [{ nameWithOwner: "acme/app", totalCount: 2 }]
    });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map(),
      text: async () => JSON.stringify(payload),
      json: async () => payload
    };
  };

  const stats = await fetchContributionStats("active-user", "2026-01-01", "2026-01-02", 100);

  assert.equal(calls.length, 2, "fetch retried after 403");
  assert.ok(warnings.some((w) => /rate limit/i.test(w)), "warned about rate limit");
  assert.deepEqual(stats.days.map((d) => d.date), ["2026-01-01", "2026-01-02"]);
  assert.equal(stats.activityTotals.commits, 3);
});


function buildOverviewInput({ repositories, maxOverviewRepos } = {}) {
  // A multi-week grid keeps the SVG width realistic so repo names are not truncated.
  const days = [];
  for (let i = 0; i < 10 * 7; i += 1) {
    const date = `2026-01-${String((i % 28) + 1).padStart(2, "0")}`;
    days.push({ date, count: i % 5 });
  }
  const weeks = [];
  for (let index = 0; index < days.length; index += 7) {
    weeks.push(days.slice(index, index + 7));
  }
  return {
    users: ["active-user"],
    dayCount: 70,
    days,
    weeks,
    repositories,
    maxOverviewRepos,
    activityTotals: { commits: 7, issues: 1, pullRequests: 2, reviews: 1 },
    totalContributions: 10,
    restrictedContributions: 0,
    title: "Overview Test"
  };
}

test("renderOverviewSvg renders top repositories with their counts", () => {
  const repositories = [
    { nameWithOwner: "acme/api", url: "https://github.com/acme/api", totalCount: 7 },
    { nameWithOwner: "acme/app", url: "https://github.com/acme/app", totalCount: 6 },
    { nameWithOwner: "acme/web", url: "https://github.com/acme/web", totalCount: 3 }
  ];
  const svg = renderOverviewSvg(buildOverviewInput({ repositories, maxOverviewRepos: 2 }));

  assert.ok(svg.includes("Top repositories"), "expected a Top repositories section");
  assert.ok(svg.includes("acme/api"), "expected top repo nameWithOwner");
  assert.ok(svg.includes("acme/app"), "expected second repo nameWithOwner");
  assert.ok(svg.includes(">7</tspan>"), "expected formatted top repo count");
  assert.ok(svg.includes(">6</tspan>"), "expected formatted second repo count");
  // maxOverviewRepos limits the list to 2 entries.
  assert.ok(!svg.includes("acme/web"), "did not expect third repo beyond maxOverviewRepos");
});

test("renderOverviewSvg handles an empty repository list without crashing", () => {
  const svg = renderOverviewSvg(buildOverviewInput({ repositories: [], maxOverviewRepos: 3 }));

  assert.ok(svg.startsWith("<svg"), "expected valid svg output");
  assert.ok(svg.endsWith("</svg>"), "expected closed svg element");
  assert.ok(!svg.includes("Top repositories"), "did not expect a Top repositories section for empty list");
});
