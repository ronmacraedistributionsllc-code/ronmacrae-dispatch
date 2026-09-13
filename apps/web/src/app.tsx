import React, { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth.js";
import { RealtimeProvider } from "./lib/realtime.js";
import { Layout } from "./components/layout.js";
import { Book } from "./pages/book.js";
import { CodReconciliation } from "./pages/cod.js";
import { Dashboard } from "./pages/dashboard.js";
import { Jobs } from "./pages/jobs.js";
import { Login } from "./pages/login.js";
import { MyPackages } from "./pages/my-packages.js";
import { NewJob } from "./pages/new-job.js";
import { PublicOrder } from "./pages/order.js";
import { JoinRider } from "./pages/join-rider.js";
import { MerchantPortal } from "./pages/merchant-portal.js";
import { AcceptInvite } from "./pages/accept-invite.js";
import { Merchants } from "./pages/merchants.js";
import { Team } from "./pages/team.js";
import { Settings } from "./pages/settings.js";
import { Settlements } from "./pages/settlements.js";
import { Notifications } from "./pages/notifications.js";
import { OpsBoard } from "./pages/ops-board.js";
import { Reports } from "./pages/reports.js";
import { Trash } from "./pages/trash.js";
import { Track } from "./pages/track.js";
import { Zones } from "./pages/zones.js";
import { Spinner } from "./components/spinner.js";

// Code-split: maplibre-gl is large (~1MB) and only staff visiting /map ever need it.
const DispatchMap = React.lazy(() => import("./pages/map.js").then((m) => ({ default: m.DispatchMap })));

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
        <RealtimeProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/book" element={<Book />} />
              <Route path="/order" element={<PublicOrder />} />
              <Route path="/order/:merchantSlug" element={<PublicOrder />} />
              <Route path="/join/rider" element={<JoinRider />} />
              <Route path="/merchant" element={<MerchantPortal />} />
              <Route path="/accept-invite" element={<AcceptInvite />} />
              <Route path="/track/:token" element={<Track />} />
              <Route path="/my-packages" element={<MyPackages />} />
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
                path="/map"
                element={
                  <Protected>
                    <Suspense fallback={<Spinner label="Loading map…" />}>
                      <DispatchMap />
                    </Suspense>
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
              <Route
                path="/cod"
                element={
                  <Protected>
                    <CodReconciliation />
                  </Protected>
                }
              />
              <Route
                path="/ops"
                element={
                  <Protected>
                    <OpsBoard />
                  </Protected>
                }
              />
              <Route
                path="/reports"
                element={
                  <Protected>
                    <Reports />
                  </Protected>
                }
              />
              <Route
                path="/trash"
                element={
                  <Protected>
                    <Trash />
                  </Protected>
                }
              />
              <Route
                path="/merchants"
                element={
                  <Protected>
                    <Merchants />
                  </Protected>
                }
              />
              <Route
                path="/team"
                element={
                  <Protected>
                    <Team />
                  </Protected>
                }
              />
              <Route
                path="/settings"
                element={
                  <Protected>
                    <Settings />
                  </Protected>
                }
              />
              <Route
                path="/settlements"
                element={
                  <Protected>
                    <Settlements />
                  </Protected>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </RealtimeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
