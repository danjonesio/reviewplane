import logoUrl from "./logo.svg";
import "./styles.css";

export type Page = "home" | "products";

/**
 * Both pages render from here so that the CSS and the image are imported once
 * and Vite serves them through its own transformed URLs — which is what makes
 * this fixture a test of a real development server's sub-resource handling
 * rather than of static files.
 */
export function App({ page }: { page: Page }) {
  return (
    <div className="shell">
      <header className="masthead">
        <img className="logo" src={logoUrl} alt="" width={40} height={40} data-testid="site-logo" />
        <a href="/" data-testid="home-link">
          ReviewPlane Vite fixture
        </a>
      </header>
      <main>{page === "home" ? <Home /> : <Products />}</main>
    </div>
  );
}

function Home() {
  return (
    <>
      <h1 id="page-title" data-testid="home-heading">
        Vite dev fixture
      </h1>
      <p>
        Served by Vite on <code>127.0.0.1:5173</code> and reached only through a
        connector route. Hot module replacement is disabled here: this fixture
        proves plain HTTP page and sub-resource loading.
      </p>
      <p className="css-probe" data-testid="css-probe">
        Stylesheet applied.
      </p>
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
