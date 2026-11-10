# DEVELOPMENT.md

## Prerequisites

This project is a small Node.js automation script that runs locally or in GitHub Actions.

Required tools:

- Node.js `24.x` to match CI and GitHub Actions workflows
- Yarn Classic `1.x` (`1.22.5` is installed in this workspace)
- A Notion integration token with access to the configured databases
- A Slack token that can post to the configured channel

Version notes:

- GitHub Actions uses Node.js `24` in the repository workflows.
- In this workspace, `yarn lint` and `yarn test` were verified successfully on Node.js `24.14.0`.
- GitHub-hosted runners are migrating JavaScript actions from Node 20 to Node 24. This repository now runs both workflow action dependencies and repository commands on Node.js `24` in GitHub Actions.

Repository documents:

- Project overview: [README.md](README.md)
- Contributor and agent guidance: [AGENTS.md](AGENTS.md)

There is no `CHANGELOG.md` or `DEPLOYMENT.md` in the repository at the moment.

## Getting Started

### 1. Clone and install dependencies

If you do not already have a local checkout, clone the repository using your team’s Git remote, then enter the workspace directory and install dependencies:

```bash
cd pair-programming
yarn install
```

### 2. Configure environment variables

Create a local `.env` file using [dev.env](dev.env) as the template:

```bash
cp dev.env .env
```

Required variables:

```dotenv
NOTION_API_KEY=<notion_api_key>
SLACK_TOKEN=<slack_token>
```

Notes:

- `NOTION_API_KEY` is used by the Notion client in [src/notion.ts](src/notion.ts).
- `SLACK_TOKEN` is used by the Slack Web API client in [src/slack.ts](src/slack.ts).
- Database IDs and the Slack channel ID are hard-coded in [src/config.ts](src/config.ts). If you need to point the script at a different workspace or channel, update that file deliberately.

### 3. Run the project locally

To see this week’s pairs without changing anything, use a dry run:

```bash
yarn start --dry-run
```

A dry run reads Notion, prints the pairs, who is left without a pair, and who is
on vacation, and stops. It does not write to Notion or post to Slack, and it
needs only `NOTION_API_KEY`.

If the pairs for the current week are already generated, a dry run leaves this
week’s generated sessions out of the history. It prints what the current code
would generate for this week, which you can compare with the sessions in Notion.

To run the workflow for real:

```bash
yarn start
```

What this does:

- Loads team members, vacations, and previous pair sessions from Notion
- Computes this week’s pairings and prints them to the log
- Creates planned pair-session entries in Notion
- Posts the resulting list to Slack, naming the teammate left without a pair

Important:

- `yarn start` performs live writes to Notion and Slack.
- Only run it with valid credentials and against the workspace you intend to update.
- A real run does nothing if the integration has already created pair sessions
  since Monday of the current week. See
  [The run says pairs are already generated](#the-run-says-pairs-are-already-generated).
- A real run writes and posts nothing when fewer than two teammates are
  available.

## Development Workflow

### Available commands

These are the scripts currently defined in [package.json](package.json):

```bash
yarn install
yarn start
yarn start --dry-run
yarn lint
yarn test
```

What each command does:

- `yarn install`: installs project dependencies from `yarn.lock`
- `yarn start`: runs `npx ts-node -r @swc/register index.ts`
- `yarn start --dry-run`: the same run without writes to Notion or Slack
- `yarn lint`: runs `eslint . && tsc --noEmit`
- `yarn test`: runs the Jest unit test suite

Useful test iteration command:

```bash
yarn test __test__/notion.test.ts
```

### Typical change flow

1. Install dependencies with `yarn install`.
2. Create `.env` from [dev.env](dev.env) if you need to exercise live integrations.
3. Make code changes in [src/](src/) and update tests in [__test__/](__test__).
4. Run `yarn lint`.
5. Run `yarn test`.
6. Run `yarn start --dry-run` to check the result against live Notion data.
7. Only run `yarn start` if you intentionally want to create Notion records and send a Slack message.

### Contribution and review workflow

The repository does not currently document a branch naming convention or pull request template.

What is verifiable from the repo today:

- CI runs `yarn lint` and `yarn test` in GitHub Actions.
- The lint and test workflows are configured on pushes to `master` and via manual dispatch.
- Before opening or updating a pull request, you should have local `yarn lint` and `yarn test` results that match CI expectations.

### GitHub Actions Node 24 configuration

The repository workflows are configured to use Node.js `24` directly in GitHub Actions.

Current workflow action versions:

- The repository uses `actions/checkout@v5` and `actions/setup-node@v5` in its workflow files.
- Those majors were selected as stable Node 24-compatible action releases.

Temporary fallback guidance:

- If GitHub has already switched JavaScript actions to Node 24 by default and a workflow is unexpectedly blocked, you may temporarily use `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true` as an emergency fallback.
- Treat that fallback as short-lived operational mitigation only while finishing the permanent migration or investigating an external compatibility issue.
- Do not leave that fallback enabled by default in repository workflows.
- Once GitHub removes Node 20 from runners, the fallback is no longer available.

Operational caution:

- A manual run of [generate-pairs.yml](.github/workflows/generate-pairs.yml) performs live writes to Notion and Slack unless you tick its `dry_run` input.
- With `dry_run` ticked, the workflow runs `yarn start --dry-run` and only prints the pairs to the job log.
- Run that workflow without `dry_run` only when you are prepared for those external side effects.
- The workflow runs `yarn start` with `TZ=Europe/Nicosia`, so the week starts on Monday in the team’s time zone and dates match a local run. Keep it in step with the `timezone` of the schedule.
- The workflow’s `concurrency` group makes runs wait for each other. Keep it: the rerun guard reads Notion before writing, so two overlapping runs would both pass it.

### Code style and tooling

- TypeScript is compiled in strict mode via [tsconfig.json](tsconfig.json).
- Local execution uses `ts-node` with SWC.
- Jest uses `@swc/jest` through [jest.config.ts](jest.config.ts).
- ESLint uses `@typescript-eslint` with Airbnb base rules through [.eslintrc.js](.eslintrc.js).
- The current lint rules require explicit function return types and 4-space indentation.

### Build behavior

There is no production build step or output directory in this repository.

- This project runs directly from TypeScript sources.
- Validation is done through `yarn lint` and `yarn test`.
- Scheduled execution is handled by [generate-pairs.yml](.github/workflows/generate-pairs.yml).

## Common Tasks

### Update the pairing algorithm

- Main pairing logic lives in [src/notion.ts](src/notion.ts).
- Unit coverage for pairing behavior lives in [__test__/notion.test.ts](__test__/notion.test.ts).
- If you change pair selection rules, verify both even-member and odd-member scenarios. With an odd count, one teammate sits out; the tests check that the repeat score stays minimal and that the teammate with the most past sessions sits out.

### Change the Slack message format

- Slack message construction lives in [src/slack.ts](src/slack.ts).
- The string-format test is in [__test__/slack.test.ts](__test__/slack.test.ts).

### Point the automation at different data sources

- Notion database IDs and the Slack channel ID are defined in [src/config.ts](src/config.ts).
- Changing those IDs changes the external systems affected by `yarn start`, so treat that as an operational change rather than a refactor.

### Run tests while iterating

```bash
yarn test
yarn test __test__/slack.test.ts
yarn test __test__/notion.test.ts
```

## Troubleshooting

### `yarn start` fails with Notion or Slack auth errors

Check that:

- `.env` exists in the repository root
- `NOTION_API_KEY` is valid and has access to the configured Notion databases
- `SLACK_TOKEN` can post to the Slack channel configured in [src/config.ts](src/config.ts)

### `yarn start` writes to the wrong workspace or channel

This project does not read database IDs or the Slack channel from the environment. Review [src/config.ts](src/config.ts) before running the script.

### `yarn lint` shows a TypeScript support warning from ESLint

The current dependency set uses TypeScript `5.3.2`, while `@typescript-eslint/typescript-estree` warns that its officially supported range is older. In this workspace the lint command still completes successfully, so treat this as a dependency compatibility warning unless linting actually fails.

### No pairs are created for one teammate

This is expected when the number of available teammates is odd: exactly one person sits out. The algorithm first minimizes repeated pairs, then, among equally good pairings, leaves out the teammate with the most past sessions (ties broken by the smaller Notion page id). This evens out past session counts. Counts cover all history, so after a roster change the same person can sit out several weeks in a row until the counts level.

### The run says pairs are already generated

A real run counts the pair sessions that the integration itself created since
Monday of the current week. If there are any, it logs that the pairs are already
generated and exits without writing to Notion or posting to Slack. This keeps a
second run in the same week from creating duplicate sessions and a second Slack
message. Sessions added by hand do not count.

The same happens after a run that failed half-way, for example when Notion
sessions were created and the Slack post failed: the next run finds the sessions
and exits successfully without posting.

To regenerate the pairs for the week, or to recover from a half-finished run,
first move this week’s generated sessions to the trash in the Pair sessions
database, then run the workflow again.

### Tests pass but the live run is still risky

The unit tests cover pure helpers and the run orchestration with Notion and Slack mocked: pairing, vacation availability, Notion retries and query filters, the dry run and the rerun guard, and Slack message formatting. They do not exercise live Notion or Slack API calls. Use `yarn start --dry-run` to check a change against live data, and treat `yarn start` as an integration action with side effects.

## Additional Resources

- Project overview: [README.md](README.md)
- Contributor and code guidance: [AGENTS.md](AGENTS.md)
- CI workflows: [.github/workflows/lint.yml](.github/workflows/lint.yml), [.github/workflows/test.yml](.github/workflows/test.yml), and [.github/workflows/generate-pairs.yml](.github/workflows/generate-pairs.yml)