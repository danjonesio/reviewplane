/**
 * The three sub-resources the home page pulls in.
 *
 * They are inline strings rather than files on disk so that the fixture has no
 * build step and no read path a test has to arrange, and so that the bytes a
 * browser receives through the tunnel are fixed by this file alone.
 */

export interface Asset {
  readonly contentType: string;
  readonly body: string;
}

/**
 * Deliberately small and self-contained: no web font, no CDN, no image beyond
 * the inline SVG. `AGENTS.md` "Browser-facing work" requires the pages to be
 * legible at 390x844 and 1440x900, and a fixture that depended on an external
 * origin would fail through the tunnel for reasons that had nothing to do with
 * the tunnel.
 */
export const SITE_CSS: Asset = {
  contentType: "text/css; charset=utf-8",
  body: `:root {
  color-scheme: light;
  --ink: #12181f;
  --muted: #4a5866;
  --line: #d5dde5;
  --accent: #1f5f8b;
  --surface: #ffffff;
  --page: #f4f7fa;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--page);
  color: var(--ink);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}

.shell {
  max-width: 62rem;
  margin: 0 auto;
  padding: 1.5rem 1.25rem 3rem;
}

.masthead {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--line);
}

.masthead a { color: inherit; font-weight: 600; text-decoration: none; }

.logo { display: block; width: 40px; height: 40px; }

h1 {
  font-size: clamp(1.5rem, 1.1rem + 1.6vw, 2.25rem);
  line-height: 1.2;
  margin: 1.5rem 0 0.5rem;
}

h2 { font-size: 1.125rem; margin: 2rem 0 0.5rem; }

p { margin: 0 0 1rem; max-width: 60ch; color: var(--muted); }

.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 1rem 1.125rem;
  margin: 1rem 0;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding: 0;
  margin: 1rem 0 0;
  list-style: none;
}

.links a {
  display: inline-block;
  padding: 0.6rem 1rem;
  border: 1px solid var(--accent);
  border-radius: 8px;
  color: var(--accent);
  text-decoration: none;
  font-weight: 600;
}

.links a:hover { background: var(--accent); color: #ffffff; }

a:focus-visible, .links a:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
}

/* A browser test asserts on this computed colour to prove the stylesheet
   itself travelled through the route, not merely the HTML that named it. */
.css-probe {
  color: #0b6b3a;
  font-weight: 600;
}

dl { margin: 0; }
dt { font-weight: 600; }
dd { margin: 0 0 0.75rem; color: var(--muted); }

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em;
  background: #eef2f6;
  border-radius: 4px;
  padding: 0.1em 0.35em;
}

@media (max-width: 480px) {
  .shell { padding: 1rem 0.875rem 2.5rem; }
  .links { flex-direction: column; align-items: stretch; }
  .links a { text-align: center; }
}
`,
};

/**
 * Proves script execution rather than script delivery: a 200 on the request
 * only shows the bytes arrived, whereas the mutation below shows the browser
 * parsed and ran them.
 */
export const SITE_JS: Asset = {
  contentType: "text/javascript; charset=utf-8",
  body: `document.documentElement.dataset.fixtureJs = "ready";
const status = document.querySelector('[data-testid="script-status"]');
if (status) {
  status.textContent = "script ran";
  status.dataset.state = "ran";
}
`,
};

export const SITE_LOGO: Asset = {
  contentType: "image/svg+xml",
  body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" role="img" aria-label="Dev fixture">
  <rect width="48" height="48" rx="10" fill="#1f5f8b"/>
  <path d="M12 30l8-14 8 14z" fill="#ffffff"/>
  <circle cx="33" cy="18" r="5" fill="#8fd0f0"/>
</svg>
`,
};
