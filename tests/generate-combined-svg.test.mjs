import assert from "node:assert/strict";
import test from "node:test";

import { fetchContributionStats } from "../scripts/generate-combined-svg.mjs";

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
        statusText: "OK",
        json: async () => ({
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
      statusText: "OK",
      json: async () => payload
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
