# ha-panel-app

A tablet-friendly panel app for Home Assistant, delivered as a Home Assistant custom panel (TypeScript + Lit, built to a single JS module).

## Privacy rules (public repository)

This repository is public. It must never contain personal data about the household it runs in.

- No real names (people, pets, rooms named after people), addresses, towns, hostnames, domains, IP addresses, email addresses, calendar names or Home Assistant entity IDs from a real install.
- Anything install-specific (rooms, speakers, calendars, bin sensors, people) comes from the panel's runtime config in the user's Home Assistant (`panel_custom` -> `config:`), never from code.
- Examples, docs, tests and fixtures use made-up values only: "Room A", "Speaker 1", `media_player.example_speaker`, `calendar.family`, `example.com`.
- Commit messages and PR text follow the same rules.
- `scripts/privacy-scan.mjs` runs in the pre-commit, commit-msg and pre-push hooks (`git config core.hooksPath .githooks`) and in CI. Never bypass it (no `--no-verify`). If it flags something, remove the data; do not weaken the scan.
- The private words list lives in `.private-terms` (git-ignored, local) and the `PRIVATE_TERMS` Actions secret. Never commit it or print its contents.
