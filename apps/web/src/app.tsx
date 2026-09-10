import type React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth.js";
import { Layout } from "./components/layout.js";
import { Book } from "./pages/book.js";
import { Dashboard } from "./pages/dashboard.js";
import { Jobs } from "./pages/jobs.js";
import { Login } from "./pages/login.js";
import { NewJob } from "./pages/new-job.js";
import { Notifications } from "./pages/notifications.js";
import { Track } from "./pages/track.js";
import { Zones } from "./pages/zones.js";
import { Spinner } from "./components/spinner.js";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

function Protected({ children }: { children: React.ReactNode }): React.ReactNode {
  const { user, loading } = useAuth();
  if (loading) return <Spinner label="Loading session…" />;
  if (!user) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
}

export default function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/book" element={<Book />} />
            <Route path="/track/:token" element={<Track />} />
            <Route
              path="/"
              element={
                <Protected>
                  <Dashboard />
                </Protected>
              }
            />
            <Route
              path="/jobs"
              element={
                <Protected>
                  <Jobs />
                </Protected>
              }
            />
            <Route
              path="/jobs/new"
              element={
                <Protected>
                  <NewJob />
                </Protected>
              }
            />
            <Route
              path="/zones"
              element={
                <Protected>
                  <Zones />
                </Protected>
              }
            />
            <Route
              path="/notifications"
              element={
                <Protected>
                  <Notifications />
                </Protected>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
