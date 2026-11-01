# BestPlay

Stremio addon that merges streams from configured debrid addons, keeps the best result, and offers subtitle filtering by language.

## Features
- exposes Stremio `manifest.json`
- fetches streams from multiple configured addons
- ranks streams by quality, codec, cache status, and language safety
- prefers original audio, filters obvious dubbed streams
- returns subtitles in the user's preferred language
- includes a simple browser configure page

## Requirements
- Node.js 18+
- TMDB API key optional

## Install
```bash
npm install
```

## Run
```bash
PORT=7000 TMDB_KEY=your_tmdb_key npm start
```

Then open:
```text
http://localhost:7000/configure
```

## Stremio setup
1. Add your debrid addon URLs (one per line) without `/manifest.json`.
2. Choose subtitle language.
3. Enable 4K/HDR if your device supports it.
4. Click “Εγκατάσταση στο Stremio”.

This generates a Stremio deep link to install the addon.

## Notes
- `TMDB_KEY` is optional, but helps improve original-language detection.
- The addon uses a configurable list of upstream addons via the generated config URL.

## License
MIT
