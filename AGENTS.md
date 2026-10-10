# Notes for AI agents

## Update the changelog in every commit

[`changelog.json`](changelog.json) is the changelog players read in the launcher: it opens by itself after an update, and from the button beside Settings. Installed launchers fetch it from `main`, so whatever you merge there is what players see.

**Every commit to this repo updates `changelog.json` in that same commit.** That covers features, fixes, settings, wording and layout tweaks, packaging and update-flow changes, one-line fixes, and follow-up commits that change what an earlier line describes (reword that line). It applies to every agent and every session, Claude Code and Codex included, however small the change. Don't leave it for a later commit or for whoever cuts the release.

The only commits without a changelog edit are ones a player cannot notice at all: tests, CI, refactors, or docs and agent notes like this file. Say so in the commit message (`No changelog: tests only`) so a reviewer can see it was a decision, not an oversight. If you are unsure whether a player could notice, add the line.

Game changes count too. When you change the game ([sms-pc-port](https://github.com/chasem-dev/sms-pc-port)), add its `beta.game` line here as well, in the launcher PR that goes with it or a small changelog PR. Merge it once the game PR is merged, since Beta builds the newest commit on the game's branch (`src/game-release.json`).

Before you commit, check that `git diff --cached --stat` lists `changelog.json`, or that your commit message says why not.

### Where your line goes

| Your change | Add it to |
| --- | --- |
| Launcher behaviour, UI, settings, fixes (`src/`, packaging, update flow) | `beta.launcher` |
| Game changes that Beta now builds (new commits on the game's branch in `src/game-release.json`), including game PRs you open alongside a launcher change | `beta.game` |
| Selecting a new game pin | Run `npm run update:game` (below) |
| Bumping the launcher version without a new game pin | Move `beta` into a new release entry yourself (below) |
| Only tests, CI, refactors, or docs, with no visible effect | Nothing, and say `No changelog: …` in the commit message |

`beta` holds what's on `main` and in Beta but not in a release yet. Only Beta builds show it, and they show it again whenever its wording changes, so keep it accurate as you go.

### Cutting a release

- **New game pin:** `npm run update:game` (or `npm run update:game -- <port-commit>`) bumps the launcher. It moves `beta.launcher` and `beta.game` into the new version's entry, fills any empty list from commit subjects, and empties `beta`. Then rewrite any commit subjects for players, check the game notes match the commit you pinned, and commit `changelog.json` along with `src/game-release.json`, `package.json` and `package-lock.json`.
- **Launcher-only bump** (`npm version patch --no-git-tag-version`): add an entry at the top of `releases` for the new version. Move the `beta.launcher` lines into it, and copy `game.version` and `game.commit` from `src/game-release.json` with `"changes": []` (the game didn't change). Then set `beta.launcher` to `[]`, keeping `beta.game` if Beta's newer game still has those changes.

The release entry format:

```json
{
  "version": "0.1.56",
  "date": "2026-10-09",
  "launcher": ["Player-facing launcher change."],
  "game": { "version": "2026.10.09.2", "commit": "<40-character commit from src/game-release.json>", "changes": ["Player-facing game change."] }
}
```

### How to write a line

- One plain sentence for players, ending with a full stop. Say what they'll notice, and where to find it if it's a setting, e.g. "Show on Discord: while you play, your Discord profile shows where you are in the game. Turn it off under Manage game."
- No commit hashes, PR or issue numbers, file names, function names or CI details. Text only: the launcher shows it as plain text, so Markdown and HTML show up literally.
- Fixes say what was wrong in the game or launcher, e.g. "Fixed Shadow Mario never taking Peach in Super Mario Eclipse's Delfino Plaza."
- Match the wording of existing entries. Fold several commits for one feature into one line.

### Rules

- Newest release first; each version once; every entry needs a date and its game pin.
- Only edit past releases to correct them. Edits reach installed launchers right away.
- `npm test` must pass. `test/changelog.test.js` fails if `changelog.json` has no entry for the `package.json` version, or that entry's game pin doesn't match `src/game-release.json`.

The README's "Versions and releases" section has the full release process.
