# Focus

A minimalist pomodoro timer for everyday use: customizable work/break intervals, synthesized ambient sounds, and a daily task checklist. Plain HTML/CSS/JS with no dependencies or build step.

## Run it

```sh
cd ~/focus-timer
python3 -m http.server 5173
```

Then open http://localhost:5173. Opening `index.html` directly also works, but serving it over HTTP enables offline support, "Install app", and notifications.

## Features

- **Timer**: Focus / short break / long break, with a long break every N sessions. Auto-start options. Stays accurate in background tabs and resumes after a page reload.
- **Ambient sounds**: Rain, waves, brown, pink, and white noise, generated with the Web Audio API (no audio files). Can play only during focus sessions.
- **Daily tasks**: A fresh list each day. Tap a task to make it your current focus, and each completed session adds a dot to it. Unfinished tasks from the previous day can be carried over with one click.
- **Stats**: Sessions and focused minutes for today.
- **Shortcuts**: `Space` start/pause · `R` reset · `S` skip · `1` `2` `3` switch mode.

All data stays in your browser's `localStorage`. The last 90 days are kept.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup and settings dialog |
| `styles.css` | Styling, light and dark themes |
| `app.js` | Timer, audio engine, tasks, persistence |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | Installable PWA and offline support |
