import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Link,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
  TablePagination,
  Tooltip,
  TextField,
} from "@mui/material";
import { api } from "../api";

type Row = Record<string, unknown> & { id: number };

const NOTION_ORIGIN = "https://www.notion.so/";

/** Outbound 存的是 page id（可带连字符）；统一为无连字符的 32 位 hex 并拼成 Notion 链接。 */
function outboundNotionHref(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (!u.hostname.toLowerCase().endsWith("notion.so")) return null;
      const seg = u.pathname.replace(/^\//, "").split("/")[0] ?? "";
      const compact = seg.replace(/-/g, "");
      if (/^[0-9a-f]{32}$/i.test(compact)) return `${NOTION_ORIGIN}${compact}`;
    } catch {
      return null;
    }
    return null;
  }
  const compact = s.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(compact)) return null;
  return `${NOTION_ORIGIN}${compact}`;
}

function OutboundNotionCell({ notionPageId }: { notionPageId: unknown }) {
  const href = outboundNotionHref(notionPageId);
  if (!href) {
    const t = String(notionPageId ?? "");
    return (
      <Tooltip title={t} placement="top-start">
        <span>{t}</span>
      </Tooltip>
    );
  }
  return (
    <Tooltip title={href} placement="top-start">
      <Link href={href} target="_blank" rel="noopener noreferrer" underline="hover" color="primary">
        {href}
      </Link>
    </Tooltip>
  );
}

export default function OutboundPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [filters, setFilters] = useState({ entity: "", keyPerson: "", domain: "", from: "", to: "" });

  async function load() {
    const sp = new URLSearchParams({
      limit: String(rowsPerPage),
      offset: String(page * rowsPerPage),
    });
    Object.entries(filters).forEach(([k, v]) => {
      if (!v) return;
      if (k === "from") sp.set("sentFrom", v);
      else if (k === "to") sp.set("sentTo", v);
      else sp.set(k, v);
    });
    const res = await api<{ rows: Row[]; total: number }>(`/api/outbound?${sp.toString()}`);
    setRows(res.rows);
    setTotal(res.total);
  }

  useEffect(() => {
    void load().catch(console.error);
  }, [page, rowsPerPage]);

  return (
    <Box>
      <Typography variant="h5" gutterBottom>
        Outbound
      </Typography>
      <Paper
        sx={{
          p: 2,
          mb: 2,
          display: "grid",
          gridTemplateColumns: { xs: "1fr", sm: "repeat(auto-fit, minmax(160px, 1fr))" },
          gap: 2,
          alignItems: "center",
        }}
      >
        {(["entity", "keyPerson", "domain", "from", "to"] as const).map((k) => (
          <TextField
            key={k}
            size="small"
            label={k === "from" ? "发送从" : k === "to" ? "发送至" : k}
            value={filters[k]}
            onChange={(e) => setFilters((f) => ({ ...f, [k]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load();
            }}
            fullWidth
          />
        ))}
        <Button variant="contained" sx={{ height: 40 }} onClick={() => void load()}>
          筛选
        </Button>
      </Paper>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>ID</TableCell>
            <TableCell>Subject</TableCell>
            <TableCell>FCAccount</TableCell>
            <TableCell>Sent</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Notion</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>{r.id}</TableCell>
              <TableCell sx={{ maxWidth: 220, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                <Tooltip title={String(r.subject ?? "")} placement="top">
                  <span>{String(r.subject ?? "")}</span>
                </Tooltip>
              </TableCell>
              <TableCell sx={{ whiteSpace: "nowrap" }}>{String(r.fcAccount ?? "")}</TableCell>
              <TableCell sx={{ whiteSpace: "nowrap" }}>{String(r.sentAt ?? "")}</TableCell>
              <TableCell sx={{ whiteSpace: "nowrap" }}>{String(r.threadStatus ?? "")}</TableCell>
              <TableCell sx={{ maxWidth: 220, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                <OutboundNotionCell notionPageId={r.notionPageId} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <TablePagination
        component="div"
        count={total}
        page={page}
        onPageChange={(_, p) => setPage(p)}
        rowsPerPage={rowsPerPage}
        onRowsPerPageChange={(e) => {
          setRowsPerPage(parseInt(e.target.value, 10));
          setPage(0);
        }}
      />
    </Box>
  );
}
