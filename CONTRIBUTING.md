# Contributing to hotBrief

Thanks for your interest. hotBrief is a small project; the bar is "useful and
well-scoped" rather than "comprehensive."

## Ways to contribute

- **Report bugs** with reproduction steps and your `config.yml` minus secrets.
- **Suggest small features** by opening a GitHub issue first; please describe
  the user-facing problem before proposing a solution.
- **Send pull requests** for small focused changes. Larger refactors should
  start with an issue so we can align on direction.

## Development setup

```bash
git clone https://github.com/<you>/hotBrief.git
cd hotBrief
make setup
# fill in .env and config.yml (real secrets stay on your machine)
cd aggregator
npm install
node --env-file=../.env src/index.js
```

You can also iterate inside Docker:

```bash
make build
make start
make logs
```

## Code style

- **Language:** all source code, comments, log messages, and identifiers are in
  English. User-facing push card content is Chinese (business content) and
  lives in templates / prompts.
- **Modules:** ES modules, Node 18+. One responsibility per file in `aggregator/src/`.
- **Lint/format:** no linter is enforced yet; please match the surrounding
  style (2-space indent, single quotes, no semicolons-only changes).
- **License header:** every new source file gets the standard Apache 2.0
  header (see existing files for the boilerplate).

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add per-source weight to resonance clustering
fix: handle empty digest body in pushDigest
docs: clarify env vars for Anthropic Claude
chore: bump openai SDK to 4.78
```

## Pull request flow

1. Open an issue (for non-trivial changes) and align on direction.
2. Fork, branch off `main`, push your changes.
3. Open a PR with a one-paragraph summary and a "How I tested" section.
4. Be ready for review comments; small back-and-forth is normal.

## Reporting security issues

Please do not open public issues for security problems. Email the maintainer
listed in the repository metadata, or use GitHub's private security advisory
feature.
