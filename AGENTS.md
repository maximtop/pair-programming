# AGENTS.md

## Project Overview

This repository automates weekly pair-programming assignments for a team. It reads team members, vacations, and previous pair sessions from Notion, computes the least-repeated pairings for the current week, creates new planned pair-session records in Notion, and posts the resulting pairs to Slack.

The codebase is a small TypeScript CLI-style automation project intended to run locally or from GitHub Actions on a schedule.

## Technical Context

- Language/Version: TypeScript `~6.0.3`; CI runs on Node.js `24`; local execution uses `ts-node` with SWC.
- Primary Dependencies: `@notionhq/client`, `@slack/web-api`, `date-fns`, `dotenv`.
- Tooling: Jest `^30`, `@swc/jest`, ESLint `^10` flat config with `typescript-eslint` and `@stylistic`, `tsc --noEmit`.
- Storage: Notion databases accessed through the Notion API. There is no local database or persisted application state in the repo.
- External Services: Slack Web API for publishing the weekly announcement.
- Target Platform: Node.js automation run locally and in GitHub Actions workflows.
- Project Type: Single-package internal automation script.
- Performance Goals: N/A; no explicit performance targets are documented.
- Constraints: A real run requires `NOTION_API_KEY` and `SLACK_TOKEN`, a dry run only `NOTION_API_KEY`; Notion database IDs and the Slack channel ID are hard-coded in `src/config.ts`; a member on vacation for three or more of the five working days of the week gets no pair (`getAvailableTeamMembers` in `src/notion.ts`); a past session counts half as much with every 4 weeks of age (`getSessionWeight` in `src/notion.ts`), so the repeat score favors the pairs that have not met for longest; when the available team size is odd, exactly one member sits out: among pairings with the lowest repeat score, the algorithm leaves out the member with the largest total weight of past sessions (ties broken by the smaller id).
- Scale/Scope: Small internal team workflow, not a general-purpose public service.

## Project Structure

```text
.
├── .github/                         # GitHub Actions configuration
│   └── workflows/                  # CI and scheduled automation workflows
├── __test__/                       # Jest unit tests for pairing logic, run orchestration, and Slack message formatting
├── src/                            # Application source code
│   ├── config.ts                   # Hard-coded Notion database IDs and Slack channel ID
│   ├── index.ts                    # Top-level orchestration for fetching, storing, and publishing pairs
│   ├── notion.ts                   # Notion access plus pair-generation logic
│   ├── slack.ts                    # Slack message building and posting
│   └── types.ts                    # Shared TypeScript types for team members and pairs
├── dev.env                         # Example environment variable template
├── eslint.config.mjs               # ESLint flat config
├── index.ts                        # CLI entrypoint with top-level error handling
├── jest.config.ts                  # Jest transform configuration via SWC
├── package.json                    # Scripts, dependencies, and package metadata
├── README.md                       # Short project description
└── tsconfig.json                   # TypeScript compiler options for sources and tests
```

## Build And Test Commands

```bash
yarn install

# Print this week's pairs without writing to Notion or posting to Slack;
# requires a .env file with NOTION_API_KEY
yarn start --dry-run

# Run the workflow for real: writes to Notion and posts to Slack;
# requires a .env file with NOTION_API_KEY and SLACK_TOKEN
yarn start

# Lint and type-check
yarn lint

# Run the unit test suite
yarn test

# Run a single Jest file while iterating
yarn test __test__/notion.test.ts
```

Notes:

- There is no dedicated production build script. The project executes directly with `ts-node -r @swc/register`.
- CI runs `yarn lint` and `yarn test` on pull requests and on pushes to `master` with Yarn and Node.js 24; see `.github/workflows/`.
- The workflows install with `yarn install --frozen-lockfile`: commit `yarn.lock` together with any change to `package.json`.

## Contribution Instructions

- Run `yarn lint` after every code change and do not finish a task with ESLint or TypeScript errors outstanding.
- Run `yarn test` after changing logic in `src/` or adding/updating tests in `__test__/`, and keep the suite passing before handing work off.
- Update or add unit tests whenever behavior changes, especially for pairing selection logic and Slack message formatting.
- Verify that any new or changed code still follows the Code Guidelines section in this file before considering the task complete.
- Keep command names and workflow behavior aligned with `.github/workflows/` when editing scripts, CI, or entrypoints.
- Preserve the required environment-variable interface: use `NOTION_API_KEY` and `SLACK_TOKEN`, and never hard-code secret values in source files or documentation.
- You MUST check a change against live data with `yarn start --dry-run`. You MUST NOT run
  `yarn start` without `--dry-run` unless the user asks for a real run: it creates Notion
  records and posts to the team Slack channel.
- Keep the rerun guard in `src/index.ts`: a real run MUST do nothing when the integration
  has already created pair sessions this week.
- If you change the vacation rule, you MUST keep it based on the whole week, Monday to Friday, not on the day of the run: a member who leaves later in the week must not get a pair.
- If you change pairing behavior, you MUST verify both even-member and odd-member cases: the repeat score must stay minimal, and with an odd count the member with the largest total weight of past sessions must sit out.

## Code Guidelines

### Architecture

- Keep `index.ts` limited to process startup and fatal-error handling.
- Keep `src/index.ts` as the orchestration layer that wires together data retrieval, pair creation, and Slack publication.
- Keep pure transformation logic isolated where practical. Pair-generation helpers and message-formatting helpers should stay deterministic and testable without calling external APIs.
- Keep Notion-specific access patterns centralized in `src/notion.ts` and Slack-specific publishing in `src/slack.ts` unless there is a strong reason to split modules further.

### Code Quality

- Follow the existing TypeScript strictness settings and provide explicit function return types; the ESLint configuration requires them.
- Preserve the current formatting style: 4-space indentation, max line length 120, and named exports over default exports.
- Prefer small helper functions with clear data flow over broad mutable state.
- When working with Notion API response objects, add narrow type guards or explicit checks around dynamic properties instead of expanding `any` usage.
- Keep runtime configuration in environment variables or `src/config.ts`; avoid scattering IDs, channel names, or secrets across modules.

### Testing

- Write Jest tests under `__test__/`.
- Prefer unit tests around pure helpers such as pair generation and message rendering; avoid live Notion or Slack network calls in tests.
- Keep fixtures concise and intention-revealing. For pairing logic, assert the resulting pair combinations or invariants directly.
- If algorithm behavior changes, add coverage for edge cases such as repeated historical pairs, vacations, and odd numbers of available members.

### Other

- Treat `dev.env` as the example configuration source; do not document or commit real credentials.
- Preserve Node 24 compatibility because the GitHub Actions workflows pin that runtime.
- Keep this repository optimized for maintainability as a small automation project; avoid introducing unnecessary framework or build complexity.