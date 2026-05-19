import { useEffect, useState } from "react";
import { Box, Button, Paper, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from "@mui/material";
import { api } from "../api";

type AppRow = {
  id: number;
  domain: string;
  tenantId: string;
  clientId: string;
  enabled: boolean;
};

export default function DomainsPage() {
  const [rows, setRows] = useState<AppRow[]>([]);
  const [form, setForm] = useState({ domain: "", tenantId: "", clientId: "", clientSecret: "" });

  async function load() {
    setRows(await api<AppRow[]>("/api/graph-apps"));
  }

  useEffect(() => {
    void load().catch(console.error);
  }, []);

  async function add() {
    await api("/api/graph-apps", {
      method: "POST",
      body: JSON.stringify({ ...form, enabled: true }),
    });
    setForm({ domain: "", tenantId: "", clientId: "", clientSecret: "" });
    await load();
  }

  return (
    <Box>
      <Typography variant="h5" gutterBottom>
        Domain / Graph Apps
      </Typography>
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" gutterBottom>新增（保存后会热更新 MSAL）</Typography>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", sm: "repeat(auto-fit, minmax(180px, 1fr))" },
            gap: 2,
            alignItems: "center",
          }}
        >
          <TextField
            label="domain"
            size="small"
            value={form.domain}
            onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            fullWidth
          />
          <TextField
            label="tenantId"
            size="small"
            value={form.tenantId}
            onChange={(e) => setForm((f) => ({ ...f, tenantId: e.target.value }))}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            fullWidth
          />
          <TextField
            label="clientId"
            size="small"
            value={form.clientId}
            onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            fullWidth
          />
          <TextField
            label="clientSecret"
            size="small"
            type="password"
            value={form.clientSecret}
            onChange={(e) => setForm((f) => ({ ...f, clientSecret: e.target.value }))}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            fullWidth
          />
          <Button variant="contained" sx={{ height: 40 }} onClick={() => void add()}>
            添加
          </Button>
        </Box>
      </Paper>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>ID</TableCell>
            <TableCell>Domain</TableCell>
            <TableCell>Tenant</TableCell>
            <TableCell>Client</TableCell>
            <TableCell>Enabled</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>{r.id}</TableCell>
              <TableCell>{r.domain}</TableCell>
              <TableCell>{r.tenantId}</TableCell>
              <TableCell>{r.clientId}</TableCell>
              <TableCell>{r.enabled ? "yes" : "no"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}
