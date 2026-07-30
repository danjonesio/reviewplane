import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const container = document.getElementById("root");
if (!container) {
  throw new Error("missing #root");
}

createRoot(container).render(
  <StrictMode>
    <App page="products" />
  </StrictMode>,
);
