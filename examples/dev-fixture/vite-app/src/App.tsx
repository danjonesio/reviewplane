import { useState } from "react";
import logoUrl from "./logo.svg";
import { Marker } from "./Marker.tsx";
import "./styles.css";

export type Page = "home" | "products";

/**
 * Both pages render from here so that the CSS and the image are imported once
 * and Vite serves them through its own transformed URLs — which is what makes
 * this fixture a test of a real development server's sub-resource handling
 * rather than of static files.
 *
 * The click counter lives here, in `App`, rather than inside `Marker` or
 * `Home`. RVP-14's end-to-end scenario edits `Marker.tsx` alone while this
 * file is unchanged, so React Fast Refresh remounts only `Marker` and leaves
 * `App`'s state intact. A counter that survived the edit is therefore
 * evidence the browser received a hot update, not a full page reload.
 */
export function App({ page }: { page: Page }) {
  const [clicks, setClicks] = useState(0);
  return (
    <div className="shell">
      <header className="masthead">
        <img className="logo" src={logoUrl} alt="" width={40} height={40} data-testid="site-logo" />
        <a href="/" data-testid="home-link">
          ReviewPlane Vite fixture
        </a>
      </header>
      <main>
        {page === "home" ? (
          <Home clicks={clicks} onIncrement={() => setClicks((count) => count + 1)} />
        ) : (
          <Products />
        )}
      </main>
    </div>
  );
}

function Home({ clicks, onIncrement }: { clicks: number; onIncrement: () => void }) {
  return (
    <>
      <h1 id="page-title" data-testid="home-heading">
        Vite dev fixture
      </h1>
      <p>
        Served by Vite on <code>127.0.0.1:5173</code> and reached only through a
        connector route. Hot module replacement runs over that same route: see
        <code> vite.config.ts</code> for how the client finds the socket.
      </p>
      <p className="css-probe" data-testid="css-probe">
        Stylesheet applied.
      </p>
      <div className="hmr-demo">
        <Marker />
        {/*
          A heading, like the marker, so that both halves of the hot-reload
          proof survive into the accessibility snapshot the end-to-end scenario
          keeps as evidence. The counter is the half that proves the page was
          not fully reloaded, so a snapshot showing only the marker would show
          the weaker of the two facts.
        */}
        <h2 data-testid="hmr-clicks">clicks: {clicks}</h2>
        <button type="button" data-testid="hmr-click" onClick={onIncrement}>
          count
        </button>
      </div>
      <ul className="links">
        <li>
          <a href="products.html" data-testid="relative-products-link">
            Products (relative link)
          </a>
        </li>
      </ul>
    </>
  );
}

function Products() {
  return (
    <>
      <h1 id="page-title" data-testid="products-heading">
        Products
      </h1>
      <p>
        A second document, reached from the home page by the relative link
        <code> products.html</code>. It rendered, so the browser resolved that
        link against the route origin.
      </p>
      <ul className="links">
        <li>
          <a href="/" data-testid="products-home-link">
            Back to home
          </a>
        </li>
      </ul>
    </>
  );
}
