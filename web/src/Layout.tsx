import { useState } from "react";
import { Outlet, useNavigate, useLocation } from "react-router-dom";
import {
  Box,
  Drawer,
  List,
  ListItemButton,
  ListItemText,
  Toolbar,
  AppBar,
  Typography,
  Button,
  IconButton,
  useMediaQuery,
  useTheme,
} from "@mui/material";

const drawerWidth = 220;

const nav = [
  { path: "/", label: "Dashboard" },
  { path: "/status", label: "系统状态" },
  { path: "/inbox", label: "Inbox" },
  { path: "/outbound", label: "Outbound" },
  { path: "/domains", label: "Domain Config" },
  { path: "/mailboxes", label: "Email Config" },
];

export default function Layout() {
  const theme = useTheme();
  const isMdUp = useMediaQuery(theme.breakpoints.up("md"));
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const navigate = useNavigate();
  const loc = useLocation();

  async function logout() {
    await fetch("/api/logout", { method: "POST", credentials: "include" });
    navigate("/login");
  }

  const drawer = (
    <>
      <Toolbar />
      <List dense sx={{ px: 0.5 }}>
        {nav.map((item) => (
          <ListItemButton
            key={item.path}
            selected={loc.pathname === item.path}
            onClick={() => {
              navigate(item.path);
              setMobileNavOpen(false);
            }}
            sx={{ borderRadius: 1, mb: 0.25 }}
          >
            <ListItemText primary={item.label} />
          </ListItemButton>
        ))}
      </List>
    </>
  );

  return (
    <Box sx={{ display: "flex", minHeight: "100vh", bgcolor: "background.default" }}>
      <AppBar
        position="fixed"
        elevation={1}
        sx={{
          zIndex: (t) => t.zIndex.drawer + 1,
          width: { xs: "100%", md: `calc(100% - ${drawerWidth}px)` },
          ml: { xs: 0, md: `${drawerWidth}px` },
        }}
      >
        <Toolbar sx={{ gap: 1, minHeight: { xs: 56, sm: 64 } }}>
          {!isMdUp && (
            <IconButton
              color="inherit"
              edge="start"
              aria-label="打开导航"
              onClick={() => setMobileNavOpen(true)}
              sx={{ mr: 0.5 }}
            >
              <Typography component="span" sx={{ fontSize: "1.35rem", lineHeight: 1 }}>
                ☰
              </Typography>
            </IconButton>
          )}
          <Typography variant="h6" component="div" sx={{ flexGrow: 1, fontSize: { xs: "1rem", sm: "1.25rem" } }}>
            EmalAuto 控制台
          </Typography>
          <Button color="inherit" size="small" onClick={() => void logout()}>
            退出
          </Button>
        </Toolbar>
      </AppBar>

      <Box component="nav" sx={{ width: { md: drawerWidth }, flexShrink: { md: 0 } }}>
        <Drawer
          variant="temporary"
          open={mobileNavOpen}
          onClose={() => setMobileNavOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{
            display: { xs: "block", md: "none" },
            [`& .MuiDrawer-paper`]: { width: drawerWidth, boxSizing: "border-box" },
          }}
        >
          {drawer}
        </Drawer>
        <Drawer
          variant="permanent"
          sx={{
            display: { xs: "none", md: "block" },
            [`& .MuiDrawer-paper`]: { width: drawerWidth, boxSizing: "border-box", borderRight: 1, borderColor: "divider" },
          }}
          open
        >
          {drawer}
        </Drawer>
      </Box>

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          width: { xs: "100%", md: `calc(100% - ${drawerWidth}px)` },
          maxWidth: "100%",
          minWidth: 0,
          p: { xs: 1.5, sm: 2, md: 3 },
          pt: { xs: 9, sm: 10 },
          overflowX: "auto",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <Outlet />
      </Box>
    </Box>
  );
}
