# combine-gh-stats

Generate a single GitHub-style contribution heatmap SVG from multiple accounts and keep it up to date with GitHub Actions.

## What this repo includes

- `scripts/generate-combined-svg.mjs` queries GitHub's GraphQL API, merges daily contribution counts, and renders `combined-contributions.svg`
- `.github/workflows/update-combined-graph.yml` regenerates the SVG every day and commits changes back to the repo
- `fixtures/mock-contributions.json` gives you a local mock dataset so you can verify the renderer without a live token

## Quick start

1. Create a repository and add these files.
2. Add a repository variable named `USERS` with a comma-separated list such as `account1,account2`.
3. The workflow uses GitHub Actions' built-in `GITHUB_TOKEN`, so you do not need to create a separate `GRAPH_TOKEN` secret for public contribution data.
4. Run the workflow once with `Actions -> Update Combined Graph -> Run workflow`.
5. Embed the generated SVG in your profile README:

```md
![Combined Contributions](https://raw.githubusercontent.com/USER/REPO/main/combined-contributions.svg)
```

If you are using this in the same repository where the SVG is generated, you can also use:

```md
![Combined Contributions](./combined-contributions.svg)
```

## Local usage

Create a local `.env` file:

```env
USERS=account1,account2
GITHUB_TOKEN=ghp_xxx
```

Then generate the SVG:

```bash
npm run generate
```

`npm run generate` now loads `.env` automatically when the file exists.

Generate with mock data:

```bash
npm run verify:mock
```

The mock command writes a sample SVG to `tmp/combined-contributions.svg`.

## Private contributions

For public contributions, the workflow uses the built-in Actions `GITHUB_TOKEN` and local runs can use `GITHUB_TOKEN` from `.env`.

If you want private contributions from multiple accounts, export a token per account using the login-based pattern below:

```bash
USERS=account1,account2
GITHUB_TOKEN_ACCOUNT1=...
GITHUB_TOKEN_ACCOUNT2=...
```

You can put those values in `.env` too, then run `npm run generate`.

For GitHub Actions, add matching repository secrets such as `GITHUB_TOKEN_ACCOUNT1` and `GITHUB_TOKEN_ACCOUNT2`, then expose them in `.github/workflows/update-combined-graph.yml` under `env:`.

Usernames are normalized to uppercase with non-alphanumeric characters replaced by underscores when building the environment variable name.

When GitHub reports private contributions in the selected window, the activity overview adds a note explaining that GitHub does not break those contributions down into commits, PRs, issues, and reviews.

## Customization

- `OUTPUT_FILE` changes the destination SVG path
- `TITLE` changes the heading shown inside the SVG
- `DAYS` changes how many trailing days to include; default is `365`

The generated SVG also adapts to light and dark mode automatically with `prefers-color-scheme`.

## Notes

- GitHub's native contribution graph cannot be merged across accounts; this generates a separate SVG for display.
- The README image will appear after the first successful workflow run creates `combined-contributions.svg`.
