# MotionStage

The shipped skill is `skill/`: Node 22+, ES modules, no build step and no npm dependencies. `tools/` and `.github/` hold release and CI tooling.

## Commands

- Tests: `npm --prefix skill test` (node:test). Run them before every commit.
- After any change under `skill/`, run `python3 tools/package-skill.py` and commit the regenerated `skill/bundle-manifest.json` and `release.json`. CI's packaged tests check the release against them, so a skipped regeneration fails every job.

## Conventions

- User-facing text (viewer UI, CLI output, error messages) is Simplified Chinese. Code, comments and commit messages are English.
- Commit messages use Conventional Commits (`feat:`, `fix:`, `chore:`).
- Follow the existing compact code style and don't add dependencies.
- CI runs on Windows, macOS and Linux with Node 22.0.0, 24 and 26, so keep paths, shell calls and timing portable.
