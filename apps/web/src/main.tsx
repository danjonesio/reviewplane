/**
 * Entry point. Composition only.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { router } from "./router.tsx";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A control plane that restarts must not leave the page showing state
      // from before it went away (docs/TESTING.md section 11).
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      staleTime: 2000,
      retry: 1,
    },
  },
});

const container = document.getElementById("root");
if (container === null) throw new Error("the application root element is missing");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
