## Agent skills

### Issue tracker

Issues live in GitHub Issues (cypherkunp/dark-matter), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Before committing

Run `pnpm format`, then `pnpm lint`, and commit the formatted result. Biome checks every file type CI sees, Markdown included, so docs-only changes go through it too.

## Commit format

Always use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages: `<type>(<optional scope>): <description>`, with types such as `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`, and `style`. Mark breaking changes with `!` after the type/scope or a `BREAKING CHANGE:` footer.
