import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Container,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { api } from "../api";

type DashboardPayload = {
  filters: { domain: string | null; email: string | null };
  yesterday: {
    outboundRecordsTotal: number;
    threadFailed: number;
    threadSuccessRate: number | null;
    caption: string;
  };
  today: { pendingSendQueueJobs: number };
  last30d: { replyRate: number | null; bounceRate: number | null; openRate: number | null; positiveReplyRate: number | null };
  v1_metric_gaps: string[];
};

function pct(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

export default function DashboardPage() {
  const [domain, setDomain] = useState("");
  const [email, setEmail] = useState("");
  const [appliedDomain, setAppliedDomain] = useState("");
  const [appliedEmail, setAppliedEmail] = useState("");
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    const sp = new URLSearchParams();
    if (appliedDomain.trim()) sp.set("domain", appliedDomain.trim());
    if (appliedEmail.trim()) sp.set("email", appliedEmail.trim());
    const q = sp.toString();
    const path = q ? `/api/dashboard?${q}` : "/api/dashboard";
    try {
      const res = await api<DashboardPayload>(path);
      setData(res);
    } catch (e: unknown) {
      setData(null);
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [appliedDomain, appliedEmail]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = data
    ? [
        {
          section: "昨日（UTC 日历日）",
          metric: "outbound 行数",
          value: String(data.yesterday.outboundRecordsTotal),
          note: "成功发信并落库后的行",
        },
        {
          section: "昨日（UTC 日历日）",
          metric: "thread_failed",
          value: String(data.yesterday.threadFailed),
          note: "子集于 outbound 行",
        },
        {
          section: "昨日（UTC 日历日）",
          metric: "线程成功率 (1−failed/total)",
          value: pct(data.yesterday.threadSuccessRate),
          note: data.yesterday.caption,
        },
        {
          section: "今日",
          metric: "待发送（BullMQ 队列）",
          value: String(data.today.pendingSendQueueJobs),
          note: "全局，未按 domain/email 筛选",
        },
        {
          section: "近 30 天",
          metric: "回复率（reply_received / 发送）",
          value: pct(data.last30d.replyRate),
          note: "近似",
        },
        {
          section: "近 30 天",
          metric: "退信率（bounce / 发送）",
          value: pct(data.last30d.bounceRate),
          note: "",
        },
        {
          section: "近 30 天",
          metric: "打开率",
          value: pct(data.last30d.openRate),
          note: "未采集",
        },
        {
          section: "近 30 天",
          metric: "正向回复率",
          value: pct(data.last30d.positiveReplyRate),
          note: "未采集",
        },
      ]
    : [];

  return (
    <Container maxWidth="lg" disableGutters sx={{ px: { xs: 0, sm: 0 } }}>
      <Stack spacing={2}>
        <Box>
          <Typography variant="h5" component="h1" sx={{ fontSize: { xs: "1.25rem", sm: "1.5rem" } }} gutterBottom>
            Dashboard
          </Typography>
          <Typography variant="body2" color="text.secondary">
            报表视图；筛选条件作用于「昨日」与「近 30 天」中与发件邮箱（mailboxes.email）关联的 outbound 统计。
          </Typography>
        </Box>

        <Paper
          variant="outlined"
          sx={{
            p: { xs: 1.5, sm: 2 },
            display: "grid",
            gridTemplateColumns: { xs: "1fr", sm: "repeat(auto-fit, minmax(200px, 1fr))" },
            gap: 2,
            alignItems: "center",
          }}
        >
          <TextField
            label="Domain"
            size="small"
            placeholder="例：fridgeteam.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setAppliedDomain(domain);
                setAppliedEmail(email);
              }
            }}
            fullWidth
          />
          <TextField
            label="Email（模糊）"
            size="small"
            placeholder="例：sales@ 或完整邮箱"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setAppliedDomain(domain);
                setAppliedEmail(email);
              }
            }}
            fullWidth
          />
          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              fullWidth
              sx={{ height: 40 }}
              onClick={() => {
                setAppliedDomain(domain);
                setAppliedEmail(email);
              }}
            >
              应用筛选
            </Button>
            <Button
              variant="outlined"
              fullWidth
              sx={{ height: 40 }}
              onClick={() => {
                setDomain("");
                setEmail("");
                setAppliedDomain("");
                setAppliedEmail("");
              }}
            >
              清除
            </Button>
          </Stack>
        </Paper>

        {err ? (
          <Alert severity="error">{err}</Alert>
        ) : !data ? (
          <Typography color="text.secondary">加载中…</Typography>
        ) : (
          <>
            {(data.filters.domain || data.filters.email) && (
              <Alert severity="info" sx={{ py: 0.5 }}>
                当前筛选：
                {data.filters.domain ? ` domain=@${data.filters.domain}` : ""}
                {data.filters.email ? ` email 含「${data.filters.email}」` : ""}
              </Alert>
            )}

            <TableContainer
              component={Paper}
              variant="outlined"
              sx={{
                maxWidth: "100%",
                overflowX: "auto",
                WebkitOverflowScrolling: "touch",
              }}
            >
              <Table size="small" stickyHeader sx={{ minWidth: 520 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>区间</TableCell>
                    <TableCell>指标</TableCell>
                    <TableCell align="right">数值</TableCell>
                    <TableCell sx={{ display: { xs: "none", md: "table-cell" } }}>说明</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={`${r.section}-${r.metric}`} hover>
                      <TableCell sx={{ whiteSpace: "nowrap", fontWeight: 500 }}>{r.section}</TableCell>
                      <TableCell>{r.metric}</TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                        {r.value}
                      </TableCell>
                      <TableCell sx={{ color: "text.secondary", fontSize: "0.8rem", display: { xs: "none", md: "table-cell" } }}>
                        {r.note}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>

            <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 }, bgcolor: "grey.50" }}>
              <Typography variant="subtitle2" gutterBottom>
                口径说明（昨日）
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {data.yesterday.caption}
              </Typography>
            </Paper>

            <Box>
              <Typography variant="subtitle2" gutterBottom>
                v1 指标边界
              </Typography>
              <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2.5 }}>
                {data.v1_metric_gaps.map((g) => (
                  <Typography key={g} component="li" variant="body2" color="text.secondary">
                    {g}
                  </Typography>
                ))}
              </Stack>
            </Box>
          </>
        )}
      </Stack>
    </Container>
  );
}
