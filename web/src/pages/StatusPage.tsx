import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Container,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { api } from "../api";

type SystemStatus = {
  checkedAt: string;
  api: { running: boolean; uptimeSeconds: number; nodeEnv: string; notionPoller: boolean };
  worker: { running: boolean; detail: string };
  dependencies: { ok: boolean; postgres: boolean; redis: boolean; notion: boolean; graph: boolean };
  graphApps: Record<string, boolean>;
  queues: {
    name: string;
    label: string;
    expected: boolean;
    workers: number;
    jobs: { waiting: number; active: number; delayed: number; failed: number };
  }[];
  config: { v2Enabled: boolean; inboxPollingScheduler: boolean; webhookIngestWorker: boolean };
  tokensCached: number;
};

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Chip
      size="small"
      label={label}
      color={ok ? "success" : "error"}
      variant={ok ? "filled" : "outlined"}
      sx={{ fontWeight: 600 }}
    />
  );
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m} 分 ${s} 秒`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h} 时 ${rm} 分`;
}

export default function StatusPage() {
  const [data, setData] = useState<SystemStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const res = await api<SystemStatus>("/api/system/status");
      setData(res);
    } catch (e: unknown) {
      setData(null);
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <Container maxWidth="lg" disableGutters sx={{ px: { xs: 0, sm: 0 } }}>
      <Stack spacing={2}>
        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1, justifyContent: "space-between" }}>
          <Box>
            <Typography variant="h5" component="h1" sx={{ fontSize: { xs: "1.25rem", sm: "1.5rem" } }} gutterBottom>
              系统状态
            </Typography>
            <Typography variant="body2" color="text.secondary">
              只读展示 API / Worker 与依赖连通性；每 15 秒自动刷新。
            </Typography>
          </Box>
          <Button variant="outlined" size="small" onClick={() => void load()}>
            立即刷新
          </Button>
        </Box>

        {err ? (
          <Alert severity="error">{err}</Alert>
        ) : !data ? (
          <Typography color="text.secondary">加载中…</Typography>
        ) : (
          <>
            <Typography variant="caption" color="text.secondary">
              上次检查：{new Date(data.checkedAt).toLocaleString()}
            </Typography>

            <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
              <Typography variant="subtitle2" gutterBottom>
                进程
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: "wrap" }}>
                <StatusChip ok={data.api.running} label="API 服务" />
                <StatusChip ok={data.worker.running} label="Worker 进程" />
                <StatusChip ok={data.api.notionPoller} label="Notion Poller" />
              </Stack>
              <Typography variant="body2" color="text.secondary">
                API 运行时长 {formatUptime(data.api.uptimeSeconds)}（NODE_ENV={data.api.nodeEnv}）。
                Worker 通过 Redis 中 BullMQ worker 注册判断，非本机终端进程列表。
              </Typography>
              <Typography variant="body2" sx={{ mt: 1 }}>
                {data.worker.detail}
              </Typography>
            </Paper>

            <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
              <Typography variant="subtitle2" gutterBottom>
                依赖
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: "wrap" }}>
                <StatusChip ok={data.dependencies.postgres} label="Postgres" />
                <StatusChip ok={data.dependencies.redis} label="Redis" />
                <StatusChip ok={data.dependencies.notion} label="Notion DB" />
                <StatusChip ok={data.dependencies.graph} label="Graph（全部 App）" />
              </Stack>
              {Object.keys(data.graphApps).length > 0 && (
                <Stack direction="row" spacing={0.75} sx={{ flexWrap: "wrap" }}>
                  {Object.entries(data.graphApps).map(([domain, ok]) => (
                    <Chip key={domain} size="small" label={domain} color={ok ? "success" : "error"} variant="outlined" />
                  ))}
                </Stack>
              )}
              <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
                MSAL token 缓存条目：{data.tokensCached}
              </Typography>
            </Paper>

            <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
              <Typography variant="subtitle2" gutterBottom>
                配置摘要
              </Typography>
              <Typography variant="body2" color="text.secondary">
                V2 {data.config.v2Enabled ? "已启用" : "未启用"}；
                收件轮询调度 {data.config.inboxPollingScheduler ? "开启" : "关闭（V2 webhook 或 disable_polling）"}；
                Webhook ingest worker {data.config.webhookIngestWorker ? "预期运行" : "未启用"}。
              </Typography>
            </Paper>

            <TableContainer component={Paper} variant="outlined" sx={{ overflowX: "auto" }}>
              <Table size="small" stickyHeader sx={{ minWidth: 560 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>队列</TableCell>
                    <TableCell align="center">预期</TableCell>
                    <TableCell align="right">Workers</TableCell>
                    <TableCell align="right">等待</TableCell>
                    <TableCell align="right">执行中</TableCell>
                    <TableCell align="right">延迟</TableCell>
                    <TableCell align="right">失败</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.queues.map((q) => (
                    <TableRow key={q.name} hover>
                      <TableCell>
                        <Typography variant="body2">{q.label}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {q.name}
                        </Typography>
                      </TableCell>
                      <TableCell align="center">{q.expected ? "是" : "—"}</TableCell>
                      <TableCell
                        align="right"
                        sx={{
                          fontVariantNumeric: "tabular-nums",
                          fontWeight: q.expected && q.workers === 0 ? 700 : 400,
                          color: q.expected && q.workers === 0 ? "error.main" : "inherit",
                        }}
                      >
                        {q.workers}
                      </TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                        {q.jobs.waiting}
                      </TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                        {q.jobs.active}
                      </TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                        {q.jobs.delayed}
                      </TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                        {q.jobs.failed}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>

            <Alert severity="info" sx={{ py: 0.75 }}>
              本地开发需同时运行 <code>npm run dev</code> 与 <code>npm run dev:worker</code>；Vite 前端（
              <code>npm run dev --prefix web</code>）仅负责页面，不在此检测。Docker 部署对应 <code>api</code> 与{" "}
              <code>worker</code> 两个服务。
            </Alert>
          </>
        )}
      </Stack>
    </Container>
  );
}
