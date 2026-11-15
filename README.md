# ha-panel-app

A tablet-friendly panel app for Home Assistant, inspired by smart displays: music, calendar, timers, weather, photos and a voice-assistant overlay in one smooth, touch-first interface.

It runs as a Home Assistant **custom panel**, so it uses Home Assistant's own login and is served by your Home Assistant instance. Nothing about your home is stored in this repository: rooms, speakers, calendars and other details are set in your own Home Assistant configuration.

> Status: early development.

## Privacy

This is a public repository. A privacy scan (`scripts/privacy-scan.mjs`) runs before every commit and push and in CI, blocking personal data such as names, addresses, IP addresses, hostnames, email addresses and tokens. See `CLAUDE.md` for the rules.

To enable the hooks after cloning:

```sh
git config core.hooksPath .githooks
```

Optionally create a git-ignored `.private-terms` file (one word per line) listing names and places that must never appear in the code.
