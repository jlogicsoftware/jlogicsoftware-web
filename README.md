# jLogic Software — website

Static site. No build step, no dependencies, no framework — plain HTML, CSS, and JS.

## Structure

```
index.html    single page, all sections
css/          one stylesheet per section, plus tokens.css (design tokens) and base.css (reset/typography)
js/           navbar.js (scroll/menu behavior), github-stats.js (live GitHub stats, fetched client-side)
assets/       icon sprite (SVG)
fonts/        self-hosted Geist / Geist Mono
images/       page images
```

## Run locally

```
python3 -m http.server 8080
```

Then open http://localhost:8080.

## Deploy

Static assets only — deploy the repo root as-is (e.g. Cloudflare Pages with no build command, output directory `/`).
