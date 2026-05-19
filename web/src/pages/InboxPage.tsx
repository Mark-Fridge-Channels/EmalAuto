import { useCallback, useEffect, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  type SelectChangeEvent,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
  TablePagination,
  Link,
  Tooltip,
} from "@mui/material";
import { api } from "../api";
import ReplyComposerDialog, { type GraphMsgForReply } from "../components/ReplyComposerDialog";

export type InboxMatchStatusFilter = "matched" | "unmatched" | "ignored" | "bounce" | "auto_reply" | "all";

type InboxRow = Record<string, unknown> & { id: number; fcAccount?: string; matchStatus?: string };

type TimelineItem = {
  kind: string;
  id: number;
  at: string;
  subject: string;
  preview: string;
  /** 发信人 */
  fromEmail: string;
  /** 收信人（To，逗号分隔） */
  toEmails: string;
};

const matchStatusLabel: Record<InboxMatchStatusFilter, string> = {
  matched: "人工回复",
  unmatched: "未匹配",
  ignored: "已忽略",
  bounce: "退信匹配",
  auto_reply: "自动回复",
  all: "全部状态",
};

/** CRM 列里存的是完整 Notion URL 时才用于新标签页打开。 */
function externalNotionHref(raw: unknown): string | null {
  const u = String(raw ?? "").trim();
  return /^https?:\/\//i.test(u) ? u : null;
}

/** API 可能返回 camelCase 或 snake_case，统一读取。 */
function crmField(row: Record<string, unknown>, camel: string, snake: string): string {
  return String(row[camel] ?? row[snake] ?? "").trim();
}

/** 点击打开邮件时间线（Notion 外链改在时间线弹窗右上角展示）。 */
function CrmTimelineCell(props: { label: string; onOpenTimeline: () => void }) {
  const { label, onOpenTimeline } = props;
  if (!label.trim()) return <>—</>;
  return (
    <Link
      component="button"
      type="button"
      variant="body2"
      onClick={(e) => {
        e.preventDefault();
        onOpenTimeline();
      }}
      sx={{ cursor: "pointer", textAlign: "left", wordBreak: "break-word", display: "block", maxWidth: "100%" }}
    >
      {label}
    </Link>
  );
}

export default function InboxPage() {
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [filters, setFilters] = useState({
    entity: "",
    keyPerson: "",
    email: "",
    domain: "",
    from: "",
    to: "",
    matchStatus: "matched" as InboxMatchStatusFilter,
  });
  const [dlg, setDlg] = useState<InboxRow | null>(null);
  const [graphMsg, setGraphMsg] = useState<GraphMsgForReply | null>(null);

  const [tlOpen, setTlOpen] = useState(false);
  const [tlTitle, setTlTitle] = useState("");
  const [tlItems, setTlItems] = useState<TimelineItem[]>([]);
  const [tlLoading, setTlLoading] = useState(false);
  const [tlError, setTlError] = useState<string | null>(null);
  const [tlNotionHref, setTlNotionHref] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sp = new URLSearchParams({
      limit: String(rowsPerPage),
      offset: String(page * rowsPerPage),
      matchStatus: filters.matchStatus,
    });
    if (filters.entity) sp.set("entity", filters.entity);
    if (filters.keyPerson) sp.set("keyPerson", filters.keyPerson);
    if (filters.email) sp.set("email", filters.email);
    if (filters.domain) sp.set("domain", filters.domain);
    if (filters.from) sp.set("receivedFrom", filters.from);
    if (filters.to) sp.set("receivedTo", filters.to);
    const res = await api<{ rows: InboxRow[]; total: number }>(`/api/inbox?${sp.toString()}`);
    setRows(res.rows);
    setTotal(res.total);
  }, [page, rowsPerPage, filters]);

  useEffect(() => {
    void load().catch(console.error);
  }, [load]);

  useEffect(() => {
    setPage(0);
  }, [filters.matchStatus]);

  async function openReply(row: InboxRow) {
    setDlg(row);
    setGraphMsg(null);
    try {
      const m = await api<GraphMsgForReply>(`/api/inbox/${row.id}/graph-message`);
      setGraphMsg(m);
    } catch {
      setGraphMsg({ error: "无法加载 Graph 邮件" });
    }
  }

  /** 用该行 inbox 主键 + scope 拉 CRM，Entity / KeyPerson 各看各的邮件线。 */
  async function openTimelineFromInboxRow(
    row: InboxRow,
    titleLabel: string,
    scope: "entity" | "keyperson",
  ) {
    setTlTitle(`时间线 · ${titleLabel}`);
    setTlNotionHref(
      scope === "entity"
        ? externalNotionHref(row.entityNotionUrl ?? row.entity_notion_url)
        : externalNotionHref(row.keyPersonNotionUrl ?? row.key_person_notion_url),
    );
    setTlOpen(true);
    setTlLoading(true);
    setTlItems([]);
    setTlError(null);
    try {
      const q = new URLSearchParams({ inboxId: String(row.id), scope, limit: "100" });
      const res = await api<{ items: TimelineItem[]; hint?: string }>(`/api/timeline?${q.toString()}`);
      setTlItems(res.items ?? []);
      if ((res.items ?? []).length === 0) {
        setTlError(res.hint ?? "未查到关联的收信/发信记录（CRM 字段可能仅展示在 outbound 或未写入本行）");
      }
    } catch (e) {
      console.error("timeline load failed", e);
      setTlItems([]);
      setTlError(e instanceof Error ? e.message : "加载时间线失败");
    } finally {
      setTlLoading(false);
    }
  }

  return (
    <Box sx={{ width: "100%", maxWidth: "100%", minWidth: 0 }}>
      <Typography variant="h5" gutterBottom sx={{ fontSize: { xs: "1.25rem", sm: "1.5rem" } }}>
        Inbox
      </Typography>
      <Paper
        sx={{
          p: { xs: 1.5, sm: 2 },
          mb: 2,
          display: "flex",
          flexDirection: "column",
          gap: 1.5,
        }}
      >
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", sm: "repeat(auto-fit, minmax(160px, 1fr))" },
            gap: 2,
            alignItems: "center",
          }}
        >
          {(["entity", "keyPerson", "email", "domain", "from", "to"] as const).map((k) => (
            <TextField
              key={k}
              size="small"
              label={
                k === "from"
                  ? "收到从(ISO)"
                  : k === "to"
                    ? "收到至(ISO)"
                    : k === "keyPerson"
                      ? "KeyPerson"
                      : k
              }
              value={filters[k === "from" ? "from" : k === "to" ? "to" : k]}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  [k === "from" ? "from" : k === "to" ? "to" : k]: e.target.value,
                }))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") void load();
              }}
              fullWidth
            />
          ))}
          <FormControl size="small" fullWidth>
            <InputLabel id="inbox-match-status-label">匹配状态</InputLabel>
            <Select<InboxMatchStatusFilter>
              labelId="inbox-match-status-label"
              label="匹配状态"
              value={filters.matchStatus}
              onChange={(e: SelectChangeEvent<InboxMatchStatusFilter>) =>
                setFilters((f) => ({ ...f, matchStatus: e.target.value as InboxMatchStatusFilter }))
              }
            >
              {(Object.keys(matchStatusLabel) as InboxMatchStatusFilter[]).map((v) => (
                <MenuItem key={v} value={v}>
                  {matchStatusLabel[v]}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button variant="contained" onClick={() => void load()} sx={{ height: 40 }}>
            筛选
          </Button>
        </Box>
        <Typography variant="caption" color="text.secondary">
          默认仅列出 <strong>match_status = matched</strong>；改为「全部状态」可查看未匹配、忽略、退信等行。表格过宽时可<strong>左右滑动</strong>查看。
        </Typography>
      </Paper>

      <TableContainer
        component={Paper}
        variant="outlined"
        sx={{
          maxWidth: "100%",
          overflowX: "auto",
          WebkitOverflowScrolling: "touch",
          mb: 1,
        }}
      >
        <Table size="small" stickyHeader sx={{ minWidth: 1040 }}>
          <TableHead>
            <TableRow>
              <TableCell>ID</TableCell>
              {/* <TableCell>匹配</TableCell> */}
              <TableCell>From</TableCell>
              <TableCell>Subject</TableCell>
              {/* <TableCell sx={{ minWidth: 200 }}>Preview</TableCell> */}
              <TableCell>FCAccount</TableCell>
              <TableCell>Received</TableCell>
              <TableCell>Entity</TableCell>
              <TableCell>KeyPerson</TableCell>
              <TableCell align="right" />
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r) => {
              const entityName = crmField(r, "entityName", "entity_name");
              const entityHref = externalNotionHref(r.entityNotionUrl ?? r.entity_notion_url);
              const keyPersonId = crmField(r, "keyPersonId", "key_person_id");
              const keyPersonName = crmField(r, "keyPersonName", "key_person_name");
              const keyPersonLabel = [keyPersonId, keyPersonName].filter(Boolean).join(" · ");
              const keyPersonHref = externalNotionHref(r.keyPersonNotionUrl ?? r.key_person_notion_url);
              return (
                <TableRow key={r.id} hover>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>{r.id}</TableCell>
                  {/* <TableCell sx={{ whiteSpace: "nowrap", fontSize: "0.8rem" }}>
                    {String(r.matchStatus ?? "—")}
                  </TableCell> */}
                  <TableCell sx={{ maxWidth: 200, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    <Tooltip title={String(r.fromEmail ?? "")} placement="top">
                      <span>{String(r.fromEmail ?? "")}</span>
                    </Tooltip>
                  </TableCell>
                  <TableCell sx={{ maxWidth: 200, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    <Tooltip title={String(r.subject ?? "")} placement="top">
                      <span>{String(r.subject ?? "")}</span>
                    </Tooltip>
                  </TableCell>
                  {/* <TableCell sx={{ maxWidth: 240, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    <Tooltip title={String(r.bodyPreview ?? "")} placement="top-start">
                      <span>{String(r.bodyPreview ?? "")}</span>
                    </Tooltip>
                  </TableCell> */}
                  <TableCell sx={{ maxWidth: 140, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    <Tooltip title={String(r.fcAccount ?? "")} placement="top">
                      <span>{String(r.fcAccount ?? "")}</span>
                    </Tooltip>
                  </TableCell>
                  <TableCell sx={{ whiteSpace: "nowrap", fontSize: "0.75rem" }}>{String(r.receivedAt ?? "")}</TableCell>
                  <TableCell sx={{ maxWidth: 160 }}>
                    {entityName || entityHref ? (
                      <CrmTimelineCell
                        label={entityName || "Entity"}
                        onOpenTimeline={() =>
                          void openTimelineFromInboxRow(
                            r,
                            entityName ? `Entity: ${entityName}` : "Entity",
                            "entity",
                          )
                        }
                      />
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell sx={{ maxWidth: 180 }}>
                    {keyPersonId || keyPersonName || keyPersonHref ? (
                      <CrmTimelineCell
                        label={keyPersonLabel || keyPersonName || keyPersonId || "KeyPerson"}
                        onOpenTimeline={() =>
                          void openTimelineFromInboxRow(
                            r,
                            `KeyPerson: ${keyPersonLabel || keyPersonName || keyPersonId || "—"}`,
                            "keyperson",
                          )
                        }
                      />
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                    <Button size="small" onClick={() => void openReply(r)}>
                      Reply
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

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
        sx={{
          flexWrap: "wrap",
          ".MuiTablePagination-toolbar": { flexWrap: "wrap", gap: 1 },
        }}
      />

      <ReplyComposerDialog
        open={!!dlg}
        row={dlg}
        graphMsg={graphMsg}
        onClose={() => {
          setDlg(null);
          setGraphMsg(null);
        }}
        onSent={load}
      />

      <Dialog
        open={tlOpen}
        onClose={() => {
          setTlOpen(false);
          setTlNotionHref(null);
        }}
        fullWidth
        maxWidth="md"
        scroll="paper"
      >
        <DialogTitle
          sx={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 2,
            pr: 2,
          }}
        >
          <Typography component="span" variant="h6" sx={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>
            {tlTitle}
          </Typography>
          {tlNotionHref ? (
            <Link
              href={tlNotionHref}
              target="_blank"
              rel="noopener noreferrer"
              variant="body2"
              sx={{ flexShrink: 0, whiteSpace: "nowrap", mt: 0.25 }}
            >
              在 Notion 中打开 ↗
            </Link>
          ) : null}
        </DialogTitle>
        <DialogContent dividers>
          {tlLoading ? (
            <Typography>加载中…</Typography>
          ) : tlItems.length === 0 ? (
            <Typography color="text.secondary">{tlError ?? "无记录"}</Typography>
          ) : (
            <TableContainer sx={{ overflowX: "auto", maxWidth: "100%" }}>
              <Table size="small" sx={{ minWidth: 720 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>类型</TableCell>
                    <TableCell>时间</TableCell>
                    <TableCell>主题</TableCell>
                    <TableCell>发信人</TableCell>
                    <TableCell>收信人</TableCell>
                    <TableCell>摘要</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {tlItems.map((it, idx) => (
                    <TableRow key={`${it.kind}-${it.id}-${idx}`}>
                      <TableCell>{it.kind === "outbound" ? "发信" : it.kind === "inbox" ? "收信" : it.kind}</TableCell>
                      <TableCell sx={{ whiteSpace: "nowrap", fontSize: "0.75rem" }}>
                        {String(it.at ?? "")}
                      </TableCell>
                      <TableCell sx={{ maxWidth: 160, wordBreak: "break-word" }}>{it.subject || "—"}</TableCell>
                      <TableCell sx={{ maxWidth: 180, wordBreak: "break-word", fontSize: "0.8rem" }}>
                        <Tooltip title={it.fromEmail || ""} placement="top">
                          <span>{it.fromEmail || "—"}</span>
                        </Tooltip>
                      </TableCell>
                      <TableCell sx={{ maxWidth: 200, wordBreak: "break-word", fontSize: "0.8rem" }}>
                        <Tooltip title={it.toEmails || ""} placement="top">
                          <span>{it.toEmails || "—"}</span>
                        </Tooltip>
                      </TableCell>
                      <TableCell sx={{ maxWidth: 200, wordBreak: "break-word", fontSize: "0.8rem" }}>
                        <Tooltip title={it.preview || ""} placement="top-start">
                          <span>{it.preview || "—"}</span>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setTlOpen(false);
              setTlNotionHref(null);
            }}
          >
            关闭
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
