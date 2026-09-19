# Gif-Guardian

<p align="center">
	<img src="docs/assets/banner.svg" alt="Gif-Guardian" />
</p>

<p align="center">
	<a href="package.json"><img src="https://img.shields.io/badge/version-0.0.0-58a6ff.svg" alt="Version 0.0.0" /></a>
	<a href="LICENSE"><img src="https://img.shields.io/badge/license-BSD--3--Clause-238636.svg" alt="BSD-3-Clause license" /></a>
	<a href=".github/workflows/ci.yaml"><img src="https://img.shields.io/badge/CI-GitHub%20Actions-2088ff.svg" alt="GitHub Actions CI" /></a>
	<img src="https://img.shields.io/badge/Node-%3E%3D24-8957e5.svg" alt="Node.js 24 or newer" />
	<img src="https://img.shields.io/badge/coverage-not%20configured-6e7681.svg" alt="Test coverage not configured" />
</p>

Gif-Guardian helps subreddit moderators restrict bad GIPHY GIFs once and keep future matching comments out with AutoModerator spam rules.

## What even is this?

Gif-Guardian is a private [Devvit](https://developers.reddit.com/) app for moderator workflows on Reddit. A moderator can select a comment containing a supported GIPHY embed, record its GIF ID, update the subreddit AutoModerator configuration, and spam-remove the current comment from one form.

The dashboard gives moderators a small control panel for active and disabled GIF records, audit entries, and AutoModerator synchronization.

## Why does this exist?

GIF moderation is repetitive when the same unwanted GIF keeps reappearing. Gif-Guardian turns the first moderation action into a reusable rule: the GIF is stored in Redis, the managed AutoModerator block is updated, and future matching comments can be handled automatically.

## Features

- Moderator-only comment and subreddit menu actions.
- GIPHY embed ID extraction with duplicate removal.
- Redis-backed restricted GIF registry and audit history.
- Active and disabled GIF states.
- Managed AutoModerator rule generation using `action: spam`.
- Dashboard controls for refresh, initialization, disable, and restore.
- Redis desired-state tracking when AutoModerator synchronization fails.

## Architecture

<p align="center">
	<img src="docs/assets/architecture.svg" alt="Gif-Guardian architecture" />
</p>

The public dashboard is served as `public/dashboard.html`. The TypeScript server receives Devvit requests, checks moderator access, reads Reddit comment context, and coordinates Redis and Reddit wiki operations.

## How it works

<p align="center">
	<img src="docs/assets/flow.svg" alt="Gif-Guardian restriction flow" />
</p>

1. A moderator chooses **Gif-Guardian: Restrict GIF** on a comment.
2. The app extracts one or more GIPHY IDs and shows a reason form.
3. The records are saved as active in Redis.
4. AutoModerator's managed block is synchronized with the active IDs.
5. The current comment is removed as spam. If synchronization fails, the Redis desired state is retained and marked as an error for later repair.

## Tech stack

| Technology | Role | Why we picked it |
| --- | --- | --- |
| TypeScript 7 | Server and shared types | Keeps the moderator workflow and data records typed. |
| Devvit Web 0.14 | Reddit app runtime and APIs | Provides subreddit context, moderator checks, menus, forms, Reddit actions, and custom posts. |
| Node.js 24 | Runtime and test execution | Matches the repository engine requirement and CI version. |
| Redis through Devvit | GIF registry and audit storage | Provides the app's persistent hash and sorted-set storage. |
| esbuild | Server bundling | Produces the deployable server bundle quickly. |
| Biome | Formatting and linting | Runs the repository's single lint and formatting check. |
| Node test runner | Unit test command | Uses the built-in test runner without another test framework. |

## Getting started

### Prerequisites

- Node.js `24.18.0` or newer. The repository also includes `.nvmrc`.
- A Reddit account and access to the Devvit developer workflow.
- A test subreddit where you have moderator permissions.
- Redis and Reddit permissions enabled by `devvit.json`.

### Installation

```bash
npm install --no-fund
```

### Configuration

There are currently no application environment variables. Devvit supplies subreddit context and the configured Redis and Reddit permissions at runtime.

| Variable | Required | Description |
| --- | --- | --- |
| None | No | Configure the target subreddit and permissions in `devvit.json` instead. |

The development subreddit currently configured in `devvit.json` is `TestEnvironmentAlpha`. Change it before using the app in another test environment.

### Running locally

Run the full validation suite:

```bash
npm test
```

Run a Devvit playtest:

```bash
npm run playtest
```

Build the server bundle without publishing:

```bash
npm run build
```

## Usage

### Restrict a GIF from a comment

1. Open a Reddit comment containing a GIPHY embed such as `![gif](giphy|ID)`.
2. Open the moderator menu and choose **Gif-Guardian: Restrict GIF**.
3. Enter a reason, or keep the default `pookie_cm`.
4. Submit **Restrict + Spam Remove**.

The app records the GIF, updates AutoModerator, and spam-removes the current comment.

### Open the dashboard

Choose **Gif-Guardian: Dashboard** from the subreddit moderator menu. Devvit opens a custom post containing the dashboard.

### Initialize AutoModerator

From the dashboard, choose **Initialize / Sync AutoModerator**. This creates or replaces the managed block in `config/automoderator`. The block is marked with `COCONAAD GIF GUARD START` and `COCONAAD GIF GUARD END`.

### Disable or restore a GIF

Use **Disable** for an active record or **Restore** for a disabled record. Each action updates Redis, synchronizes the active AutoModerator IDs, and adds an audit record.

## Use cases

- Keep recurring unwanted GIPHY GIFs out of a subreddit.
- Give moderators one consistent action for the current comment and future matches.
- Temporarily disable a restriction without deleting its record or audit context.
- Inspect the current registry and AutoModerator status from one dashboard.

## Project structure

```text
.
├── devvit.json                 # Devvit app name, menus, form, post, and permissions
├── package.json                # Scripts, dependencies, and Node.js requirement
├── public/
│   └── dashboard.html          # Moderator dashboard UI
├── docs/assets/
│   ├── banner.svg              # README banner
│   ├── architecture.svg        # System topology diagram
│   └── flow.svg                # Restriction lifecycle diagram
├── src/server/
│   ├── index.ts                # Devvit HTTP server entry point
│   ├── server.ts               # Routes, moderator checks, and workflow handlers
│   ├── automod.ts              # Managed AutoModerator block synchronization
│   ├── audit.ts                # Redis-backed audit records
│   ├── gif-parser.ts            # GIPHY embed ID extraction
│   ├── gif-store.ts             # Restricted GIF Redis storage
│   ├── gif.ts                   # GIF status and record types
│   ├── state.ts                 # Desired revision, locks, and action claims
│   └── validation.ts            # Runtime Redis record validation
├── src/shared/
│   └── index.ts                 # Shared project entrypoint
├── src/test/                   # Test TypeScript project configuration
├── .github/workflows/ci.yaml   # GitHub Actions typecheck, lint, test, and build jobs
├── LICENSE                     # BSD-3-Clause license
└── readme.md                   # Project guide
```

## API reference

All application routes require a `POST` or `GET` request as shown. Moderator-facing routes call the same moderator check before doing work.

### Devvit menu and form routes

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/internal/menu/restrict-gif` | Reads the current comment and opens the restriction form. |
| `POST` | `/internal/menu/open-dashboard` | Creates a dashboard custom post and navigates to it. |
| `POST` | `/internal/form/restrict-gif-submit` | Stores GIFs, syncs AutoModerator, spam-removes the comment, and writes an audit record. |

### Dashboard API routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/state` | Returns GIF records, recent audit records, and AutoModerator status. |
| `POST` | `/api/disable` | Marks a GIF record disabled and synchronizes AutoModerator. |
| `POST` | `/api/restore` | Marks a GIF record active and synchronizes AutoModerator. |
| `POST` | `/api/initialize-automod` | Initializes or replaces the managed AutoModerator block. |

### Exported server modules

- `src/server/server.ts`: `onReq` is the Devvit request handler.
- `src/server/gif-parser.ts`: `extractGiphyIds(body)` returns unique supported GIPHY IDs.
- `src/server/gif-store.ts`: `getRestrictedGif`, `mutateRestrictions`, `setGifStatus`, and `listRestrictedGifs` manage the validated registry.
- `src/server/automod.ts`: `getAutoModStatus`, `initializeAutoMod`, and `syncAutoMod` manage the wiki block.
- `src/server/audit.ts`: `appendAudit` and `listAudit` manage audit history.

## Development

### Running tests

The full check runs typechecking, Biome, the Node test command, and the production build:

```bash
npm test
```

Individual checks are also available:

```bash
npm run test:types
npm run lint
npm run test:unit
npm run build
```

The unit suite covers GIPHY parsing, Redis record validation, managed AutoModerator blocks, and rule-size packing.

### Contributing

1. Install dependencies with `npm install --no-fund`.
2. Make a focused change.
3. Run `npm test` before opening a pull request.
4. Keep managed AutoModerator changes inside the marked block so existing subreddit configuration is preserved.

## Roadmap

- [x] Add focused unit tests for GIPHY parsing and AutoModerator block replacement.
- [x] Add tests for desired-state retention when AutoModerator synchronization fails.
- [ ] Add test coverage reporting to CI.
- [ ] Document a complete Devvit playtest and moderator setup walkthrough.

## License

Gif-Guardian is licensed under the [BSD-3-Clause License](LICENSE). See the license file for the complete terms.

---

Built for practical Reddit moderation by [Reddit Inc.](https://www.reddit.com/).
