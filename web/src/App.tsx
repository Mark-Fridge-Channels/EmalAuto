import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Layout from "./Layout";
import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import InboxPage from "./pages/InboxPage";
import OutboundPage from "./pages/OutboundPage";
import DomainsPage from "./pages/DomainsPage";
import MailboxesPage from "./pages/MailboxesPage";
import StatusPage from "./pages/StatusPage";

const theme = createTheme();

async function authed(): Promise<boolean> {
  try {
    const r = await fetch("/api/me", { credentials: "include" });
    return r.ok;
  } catch {
    return false;
  }
}

function Private({ children }: { children: React.ReactNode }) {
  const [ok, setOk] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    void authed().then(setOk);
  }, []);
  if (ok === null) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "40vh" }}>
        <CircularProgress aria-label="正在校验登录状态" />
      </Box>
    );
  }
  if (!ok) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <Private>
                <Layout />
              </Private>
            }
          >
            <Route path="/" element={<DashboardPage />} />
            <Route path="/status" element={<StatusPage />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/outbound" element={<OutboundPage />} />
            <Route path="/domains" element={<DomainsPage />} />
            <Route path="/mailboxes" element={<MailboxesPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}
