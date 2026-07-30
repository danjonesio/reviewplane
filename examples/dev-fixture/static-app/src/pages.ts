/**
 * The fixture's HTML documents.
 *
 * Each page exists to make one property of the tunnel observable. The URL
 * shapes are the point: root-relative sub-resources, a relative link, a
 * root-relative link and one deliberately absolute reference. See
 * `examples/dev-fixture/README.md` for the route-by-route claim.
 */

/**
 * The shared shell. Every page names the same three sub-resources by
 * **root-relative** URL, because a root-relative URL is resolved against the
 * origin the browser was given — the internal gateway origin — and so survives
 * the route. An absolute URL naming the development machine does not, which is
 * what `/absolute-url` demonstrates.
 */
function layout(options: { readonly title: string; readonly main: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.title} — ReviewPlane dev fixture</title>
<link rel="stylesheet" href="/assets/site.css">
<script src="/assets/site.js" defer></script>
</head>
<body>
<div class="shell">
<header class="masthead">
<img class="logo" src="/assets/logo.svg" alt="" width="40" height="40" data-testid="site-logo">
<a href="/" data-testid="home-link">ReviewPlane dev fixture</a>
</header>
<main>
${options.main}
</main>
</div>
</body>
</html>
`;
}

export const HOME = layout({
  title: "Home",
  main: `<h1 id="page-title" data-testid="home-heading">Loopback dev fixture</h1>
<p>This application is bound to loopback on the development machine. A browser
reaches it only through a connector route, never over the network.</p>
<p class="css-probe" data-testid="css-probe">Stylesheet applied.</p>
<p data-testid="script-status" data-state="pending">script not run</p>
<h2>Navigation</h2>
<ul class="links">
<li><a href="products" data-testid="relative-products-link">Products (relative link)</a></li>
<li><a href="/checkout" data-testid="root-relative-checkout-link">Checkout (root-relative link)</a></li>
</ul>`,
});

export const PRODUCTS = layout({
  title: "Products",
  main: `<h1 id="page-title" data-testid="products-heading">Products</h1>
<p>Reached from the home page by the relative link <code>products</code>. If this
page rendered, the browser resolved that link against the route origin rather
than against the development machine's address.</p>
<ul class="links">
<li><a href="/" data-testid="products-home-link">Back to home</a></li>
<li><a href="/checkout" data-testid="products-checkout-link">Checkout</a></li>
</ul>`,
});

export const CHECKOUT = layout({
  title: "Checkout",
  main: `<h1 id="page-title" data-testid="checkout-heading">Checkout</h1>
<p>A third page, so that a review can be recorded against a specific page of a
multi-page application rather than against a single document.</p>
<ul class="links">
<li><a href="/" data-testid="checkout-home-link">Back to home</a></li>
</ul>`,
});

/**
 * The documented development-server failure mode.
 *
 * Built from the server's own bound address, so the emitted URL is exactly what
 * a development server that derives absolute URLs from its listen address would
 * produce.
 */
export function absoluteUrlPage(origin: string): string {
  return layout({
    title: "Absolute URL",
    main: `<!-- KNOWN FAILURE, ON PURPOSE. The stylesheet below is named by an
     absolute URL pointing at the development machine's own loopback address.
     It MUST fail to load through the tunnel: the browser runs in a central
     container where 127.0.0.1 is that container, not the development machine,
     and the gateway routes by the internal origin it issued rather than by
     whatever host a page asks for. This fixture exists so that the failure can
     be characterised and reported, not papered over by rewriting page content
     in the gateway. -->
<link rel="stylesheet" href="${origin}/assets/site.css" data-testid="absolute-stylesheet">
<h1 id="page-title" data-testid="absolute-url-heading">Absolute URL</h1>
<p>This page names <code>${origin}/assets/site.css</code> absolutely. Through a
connector route that request does not reach this server, so the page renders
unstyled and the browser records a failed request.</p>
<p class="css-probe" data-testid="css-probe">This line is green only when a
stylesheet loaded. Through the tunnel it is not.</p>
<ul class="links">
<li><a href="/" data-testid="absolute-url-home-link">Back to home</a></li>
</ul>`,
  });
}

/**
 * A page whose only sub-resource addresses a different host and port. Port 9 is
 * the discard port and nothing listens on it in the browser container either,
 * so the request fails wherever the page is opened; what the route must show is
 * that it fails as a page-initiated cross-origin request rather than being
 * silently carried to somewhere else.
 */
export const CROSS_ORIGIN = layout({
  title: "Cross origin",
  main: `<h1 id="page-title" data-testid="cross-origin-heading">Cross origin</h1>
<p>The image below addresses <code>http://127.0.0.1:9/</code>, a host and port
outside this route. A route is a capability for one destination, not a general
proxy, so the request MUST fail.</p>
<img src="http://127.0.0.1:9/blocked.png" alt="Blocked cross-origin image" width="64" height="64" data-testid="cross-origin-image">
<ul class="links">
<li><a href="http://example.invalid/" data-testid="cross-origin-link">Link to another host</a></li>
<li><a href="/" data-testid="cross-origin-home-link">Back to home</a></li>
</ul>`,
});

export function slowPage(delayMs: number): string {
  return layout({
    title: "Slow",
    main: `<h1 id="page-title" data-testid="slow-heading">Slow response</h1>
<p>This response was held for <span data-testid="slow-delay">${String(delayMs)}</span> ms
before its first byte. Used to check that a bounded timeout in the browser
worker or the gateway fires as a clear failure rather than as a hang.</p>`,
  });
}

export const NOT_FOUND = layout({
  title: "Not found",
  main: `<h1 id="page-title" data-testid="not-found-heading">Not found</h1>
<p>No such page in the fixture.</p>
<ul class="links">
<li><a href="/" data-testid="not-found-home-link">Back to home</a></li>
</ul>`,
});
