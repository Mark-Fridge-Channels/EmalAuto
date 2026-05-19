import { useEffect, useState } from "react";
import { Box, Paper, Table, TableBody, TableCell, TableHead, TableRow, Typography, Switch, TableContainer } from "@mui/material";
import { api } from "../api";

type Mb = {
  id: number;
  email: string;
  enabled: boolean;
  canSend: boolean;
  canReceive: boolean;
};

export default function MailboxesPage() {
  const [rows, setRows] = useState<Mb[]>([]);

  async function load() {
    setRows(await api<Mb[]>("/api/mailboxes"));
  }

  useEffect(() => {
    void load().catch(console.error);
  }, []);

  async function patch(id: number, patch: Partial<Mb>) {
    await api(`/api/mailboxes/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    await load();
  }

  return (
    <Box>
      <Typography variant="h5" gutterBottom>
        Mailboxes
      </Typography>
      <Paper sx={{ p: { xs: 1, sm: 2 } }}>
        <TableContainer sx={{ overflowX: "auto" }}>
          <Table size="small" sx={{ minWidth: 400 }}>
            <TableHead>
              <TableRow>
                <TableCell>ID</TableCell>
                <TableCell>Email</TableCell>
                <TableCell>enabled</TableCell>
                <TableCell>can_send</TableCell>
                <TableCell>can_receive</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} hover>
                  <TableCell>{r.id}</TableCell>
                  <TableCell>{r.email}</TableCell>
                  <TableCell>
                    <Switch checked={r.enabled} onChange={(e) => void patch(r.id, { enabled: e.target.checked })} />
                  </TableCell>
                  <TableCell>
                    <Switch checked={r.canSend} onChange={(e) => void patch(r.id, { canSend: e.target.checked })} />
                  </TableCell>
                  <TableCell>
                    <Switch checked={r.canReceive} onChange={(e) => void patch(r.id, { canReceive: e.target.checked })} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>
    </Box>
  );
}
