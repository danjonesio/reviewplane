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
<li><a href="/websocket" data-testid="websocket-nav-link">WebSocket</a></li>
<li><a href="/sse" data-testid="sse-nav-link">Server-sent events</a></li>
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

/**
 * Opens `/ws-echo`, drives a fixed three-message exchange and closes
 * client-initiated. The literal result string is asserted verbatim by a
 * browser test, so its shape here and the counting logic in the inline
 * script are both load-bearing. The result is an `<h2>` rather than a
 * paragraph because the end-to-end scenario's `snapshot` evidence only sees
 * accessibility roles — headings among them — and a `<p>` has none
 * (`apps/browser-worker/src/session/snapshot.ts`).
 */
export const WEBSOCKET = layout({
  title: "WebSocket",
  main: `<h1 id="page-title" data-testid="websocket-heading">WebSocket echo</h1>
<p>Opens a WebSocket to <code>/ws-echo</code>, exchanges three echoed messages
and then closes cleanly. Proves a route preserves the HTTP upgrade,
bidirectional frames and closure semantics in both directions
(<code>docs/CONNECTOR_PROTOCOL.md</code> §13.3).</p>
<p data-testid="ws-state" data-state="connecting">connecting</p>
<h2 data-testid="ws-result">ws: pending</h2>
<ul class="links">
<li><a href="/" data-testid="websocket-home-link">Back to home</a></li>
</ul>
<script>
(function () {
  "use strict";
  var stateEl = document.querySelector('[data-testid="ws-state"]');
  var resultEl = document.querySelector('[data-testid="ws-result"]');
  var messages = ["hello-1", "hello-2", "hello-3"];
  var sent = 0;
  var echoed = 0;

  function setState(state) {
    if (stateEl) {
      stateEl.textContent = state;
      stateEl.dataset.state = state;
    }
  }

  setState("connecting");

  var protocol = location.protocol === "https:" ? "wss://" : "ws://";
  var socket = new WebSocket(protocol + location.host + "/ws-echo");

  socket.addEventListener("open", function () {
    setState("open");
    sent = 1;
    socket.send(messages[0]);
  });

  socket.addEventListener("message", function (event) {
    var expected = "echo:" + messages[sent - 1];
    if (event.data === expected) {
      echoed += 1;
    }
    if (sent < messages.length) {
      var next = messages[sent];
      sent += 1;
      socket.send(next);
    } else {
      socket.close(1000, "bye");
    }
  });

  socket.addEventListener("close", function (event) {
    setState("closed");
    if (resultEl) {
      resultEl.textContent =
        "ws: echoed=" + echoed + " code=" + event.code + " clean=" + event.wasClean;
    }
  });

  socket.addEventListener("error", function () {
    setState("failed");
    if (resultEl) {
      resultEl.textContent = "ws: failed";
    }
  });
})();
</script>`,
});

/**
 * Opens `/events`, times each `tick` arrival against the previous one and
 * reports whether the minimum gap looks like a streamed delivery or a
 * buffering hop that released every event at once when the stream closed.
 *
 * The result and the gap trace are both headings (`<h2>`/`<h3>`), not a
 * paragraph or a `<pre>`, for the same reason as `/websocket`: the end-to-end
 * scenario's `snapshot` evidence only sees accessibility roles, and headings
 * are the ones this fixture has available
 * (`apps/browser-worker/src/session/snapshot.ts`). The `<pre>` stays
 * alongside the `<h3>` so a human looking at a screenshot still gets the
 * timings laid out one per line.
 */
export const SSE = layout({
  title: "Server-sent events",
  main: `<h1 id="page-title" data-testid="sse-heading">Server-sent events</h1>
<p>Opens an <code>EventSource</code> against <code>/events</code> and measures
the gap between arrivals. A hop that buffers the whole response delivers
every event at once when the stream closes; a hop that preserves streaming
delivers them incrementally.</p>
<h2 data-testid="sse-result">sse: pending</h2>
<h3 data-testid="sse-gaps">sse gaps ms: pending</h3>
<pre data-testid="sse-timings"></pre>
<ul class="links">
<li><a href="/" data-testid="sse-home-link">Back to home</a></li>
</ul>
<script>
(function () {
  "use strict";
  var resultEl = document.querySelector('[data-testid="sse-result"]');
  var gapsEl = document.querySelector('[data-testid="sse-gaps"]');
  var timingsEl = document.querySelector('[data-testid="sse-timings"]');
  var arrivals = [];
  var done = false;

  var source = new EventSource("/events?count=6&interval_ms=400");

  source.addEventListener("tick", function () {
    arrivals.push(performance.now());
  });

  source.addEventListener("done", function () {
    done = true;
    var gaps = [];
    for (var i = 1; i < arrivals.length; i += 1) {
      gaps.push(Math.round(arrivals[i] - arrivals[i - 1]));
    }
    var minGap = gaps.length > 0 ? Math.min.apply(null, gaps) : 0;
    var label = minGap >= 200 ? "incremental" : "buffered";
    if (resultEl) {
      resultEl.textContent =
        "sse: " + label + " events=" + arrivals.length + " min-gap=" + minGap + "ms";
    }
    if (gapsEl) {
      gapsEl.textContent = "sse gaps ms: " + gaps.join(", ");
    }
    if (timingsEl) {
      timingsEl.textContent = gaps.join("\\n");
    }
    source.close();
  });

  source.addEventListener("error", function () {
    if (!done) {
      if (resultEl) {
        resultEl.textContent = "sse: failed";
      }
      if (gapsEl) {
        gapsEl.textContent = "sse gaps ms: failed";
      }
    }
  });
})();
</script>`,
});

/**
 * Fetches `/bulk` three times and reports the best (highest-throughput) run,
 * so a single scheduling hiccup in this process does not become the
 * published RVP-14 baseline (`docs/TESTING.md` §12). The result is written
 * into an `<h2>` rather than a paragraph because the end-to-end scenario
 * reads it from the browser worker's accessibility snapshot
 * (`apps/browser-worker/src/session/snapshot.ts`), which carries heading and
 * other landmark/interactive roles but not plain text — a `<p>` would be
 * invisible to it.
 */
export const THROUGHPUT = layout({
  title: "Throughput",
  main: `<h1 id="page-title" data-testid="throughput-heading">Bulk throughput</h1>
<p>Fetches <code>/bulk</code> three times in a row and reports the best of
the three runs as bytes transferred, elapsed time and megabits per second.</p>
<p data-testid="throughput-state">fetching</p>
<h2 data-testid="throughput-result">bulk: pending</h2>
<ul class="links">
<li><a href="/" data-testid="throughput-home-link">Back to home</a></li>
</ul>
<script>
(function () {
  "use strict";
  var stateEl = document.querySelector('[data-testid="throughput-state"]');
  var resultEl = document.querySelector('[data-testid="throughput-result"]');
  var params = new URLSearchParams(location.search);
  var bytes = Number(params.get("bytes"));
  if (!Number.isFinite(bytes) || bytes <= 0) {
    bytes = 4194304;
  }

  function setState(state) {
    if (stateEl) {
      stateEl.textContent = state;
    }
  }

  async function runOnce() {
    var startedAt = performance.now();
    var response = await fetch("/bulk?bytes=" + bytes);
    var body = await response.arrayBuffer();
    var elapsedMs = performance.now() - startedAt;
    var mbps = (body.byteLength * 8) / (elapsedMs * 1000);
    return { byteLength: body.byteLength, elapsedMs: elapsedMs, mbps: mbps };
  }

  (async function () {
    setState("fetching");
    try {
      // Three consecutive fetches; only the best (highest-throughput) run is
      // reported, so one scheduling hiccup does not skew the baseline.
      var best = null;
      for (var i = 0; i < 3; i += 1) {
        var run = await runOnce();
        if (best === null || run.mbps > best.mbps) {
          best = run;
        }
      }
      setState("done");
      if (resultEl && best) {
        resultEl.textContent =
          "bulk: done bytes=" + best.byteLength +
          " ms=" + Math.round(best.elapsedMs) +
          " mbps=" + best.mbps.toFixed(1);
      }
    } catch (error) {
      setState("failed");
      if (resultEl) {
        resultEl.textContent =
          "bulk: failed " + (error && error.message ? error.message : String(error));
      }
    }
  })();
})();
</script>`,
});

export const NOT_FOUND = layout({
  title: "Not found",
  main: `<h1 id="page-title" data-testid="not-found-heading">Not found</h1>
<p>No such page in the fixture.</p>
<ul class="links">
<li><a href="/" data-testid="not-found-home-link">Back to home</a></li>
</ul>`,
});
