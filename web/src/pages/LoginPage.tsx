import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Box, Button, Paper, TextField, Typography, Alert } from "@mui/material";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();

  /** Cookie 仍有效时直接进入，无需重复输入密码。 */
  useEffect(() => {
    void fetch("/api/me", { credentials: "include" }).then((r) => {
      if (r.ok) navigate("/", { replace: true });
    });
  }, [navigate]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setErr("密码错误");
        return;
      }
      navigate("/");
    } catch {
      setErr("网络错误");
    }
  }

  return (
    <Box sx={{ maxWidth: 420, mx: "auto", mt: { xs: 4, sm: 10 }, px: { xs: 2, sm: 0 } }}>
      <Paper sx={{ p: 3 }}>
        <Typography variant="h5" gutterBottom>
          登录
        </Typography>
        {err && <Alert severity="error">{err}</Alert>}
        <form onSubmit={(e) => void submit(e)}>
          <TextField
            fullWidth
            margin="normal"
            type="password"
            label="管理密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" variant="contained" fullWidth sx={{ mt: 2 }}>
            进入
          </Button>
        </form>
      </Paper>
    </Box>
  );
}
