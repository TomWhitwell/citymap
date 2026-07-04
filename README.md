# SE24 Field Cards

A static mobile-first prototype for a location-checked field game around SE24 0AQ.

The app uses public map/data sources to turn nearby real-world objects into collectible cards. It is designed to be hosted as a static site on GitHub Pages or any CDN.

## What is included

- `index.html` - the app shell
- `styles.css` - responsive layout and mobile map styles
- `app.js` - game logic, map logic, GPS geofence, and collection state
- `data/se24-objects.json` - current local dataset
- `tools/fetch_se24_data.py` - source data fetch/regeneration script
- `.github/workflows/pages.yml` - GitHub Pages deployment workflow

## Running locally

From this folder:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://127.0.0.1:8000/
```

For phone testing on the same Wi-Fi, use your Mac's LAN address, for example:

```text
http://192.168.x.x:8000/
```

Note: iPhone geolocation generally requires HTTPS. The local HTTP address can show the map and cards, but GPS-verified collection usually needs GitHub Pages, CloudFront, Netlify, or another HTTPS host.

## Hosting on GitHub Pages

Push this repo to GitHub. The included workflow deploys the static site from the repository root whenever `main` is pushed.

After the first push, check the repository's **Settings -> Pages** screen. If GitHub asks for a source, choose **GitHub Actions**.

Once deployed, the app will be available at:

```text
https://<github-user>.github.io/<repo-name>/
```

Because GitHub Pages is HTTPS, the mobile geolocation gate can run there.
