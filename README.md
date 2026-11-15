# ha-panel-app

A tablet-friendly panel app for Home Assistant, inspired by smart displays: music, calendar, timers, weather, photos and a voice-assistant overlay in one smooth, touch-first interface.

It runs as a Home Assistant **custom panel**, so it uses Home Assistant's own login and is served by your Home Assistant instance. Nothing about your home is stored in this repository: rooms, speakers, calendars and other details are set in your own Home Assistant configuration.

> Status: early development.

## Install

1. In Home Assistant, open **Settings > Marketplace**, add this repository as a custom repository of type **Dashboard**, and download it.
2. Register the panel in `configuration.yaml` and restart Home Assistant:

```yaml
panel_custom:
  - name: ha-panel-app
    url_path: panel
    sidebar_title: Panel
    sidebar_icon: mdi:tablet-dashboard
    module_url: /local/community/ha-panel-app/ha-panel-app.js
    config:
      rooms:
        - name: Room A
          player: media_player.example_speaker_a
          device: media_player.example_cast_a
        - name: Room B
          player: media_player.example_speaker_b
```

3. Open `/panel` on your tablet.

All household details live in the `config:` block in your own Home Assistant, never in this repository.

## Privacy

This is a public repository. A privacy scan (`scripts/privacy-scan.mjs`) runs before every commit and push and in CI, blocking personal data such as names, addresses, IP addresses, hostnames, email addresses and tokens. See `CLAUDE.md` for the rules.

To enable the hooks after cloning:

```sh
git config core.hooksPath .githooks
```

Optionally create a git-ignored `.private-terms` file (one word per line) listing names and places that must never appear in the code.
