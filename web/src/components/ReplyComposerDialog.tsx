import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  Alert,
  Box,
  Button,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Link,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import LinkExt from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import "../reply-composer.css";
import { api } from "../api";

export type InboxReplyRow = {
  id: number;
  fromEmail?: string;
  subject?: string;
  receivedAt?: string;
  bodyPreview?: string;
  fcAccount?: string;
};

export type GraphMsgForReply = {
  /** Set when Graph fetch failed — no body to compose from. */
  error?: string;
  id?: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  attachments?: Array<{ id: string; name?: string; contentType?: string; size?: number }>;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const QUOTE_BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "LI",
  "TR",
  "TD",
  "TH",
  "TABLE",
  "TBODY",
  "THEAD",
  "BLOCKQUOTE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "PRE",
  "HR",
  "SECTION",
  "ARTICLE",
  "HEADER",
  "FOOTER",
  "DL",
  "DT",
  "DD",
]);

function normalizeQuotePlainText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** HTML → plain text while keeping block/line breaks (Gmail thread quotes). */
function htmlToQuoteText(html: string, maxLen: number): string {
  if (typeof document === "undefined") {
    const t = normalizeQuotePlainText(
      html
        .replace(/<\s*br\s*\/?>/gi, "\n")
        .replace(/<\/\s*(p|div|blockquote|li|tr|h[1-6])\s*>/gi, "\n")
        .replace(/<[^>]+>/g, ""),
    );
    return t.length <= maxLen ? t : `${t.slice(0, maxLen)}…`;
  }
  const root = document.createElement("div");
  root.innerHTML = html;
  const parts: string[] = [];

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? "";
      if (t) parts.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName;
    if (tag === "STYLE" || tag === "SCRIPT") return;
    if (tag === "BR") {
      parts.push("\n");
      return;
    }
    const isBlock = QUOTE_BLOCK_TAGS.has(tag);
    if (isBlock) parts.push("\n");
    for (const child of Array.from(el.childNodes)) walk(child);
    if (isBlock) parts.push("\n");
  };

  walk(root);
  const text = normalizeQuotePlainText(parts.join(""));
  if (text.length > maxLen) return `${text.slice(0, maxLen)}…`;
  return text;
}

/** Plain text (with newlines) → safe HTML paragraphs for email clients / TipTap. */
function quoteTextToHtml(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "<p>（无正文）</p>";
  return trimmed
    .split(/\n\n+/)
    .map((para) => {
      const lines = para.split("\n");
      const inner = lines
        .map((line, i) => {
          const e = escapeHtml(line);
          return i < lines.length - 1 ? `${e}<br>` : e;
        })
        .join("");
      return `<p>${inner || "<br>"}</p>`;
    })
    .join("");
}

export function replySubject(raw: string): string {
  const t = raw.trim();
  if (!t) return "Re: (no subject)";
  if (/^(re|aw|sv|wzdn|回复):\s*/i.test(t)) return t;
  return `Re: ${t}`;
}

function buildInitialReplyHtml(params: {
  quotedHeaderFrom: string;
  quotedHeaderWhen: string;
  graphBody?: { contentType?: string; content?: string };
  bodyPreviewFallback: string;
}): string {
  const { quotedHeaderFrom, quotedHeaderWhen, graphBody, bodyPreviewFallback } = params;
  const raw = graphBody?.content?.trim() ?? "";
  const ct = (graphBody?.contentType ?? "").toLowerCase();
  let quoteBody = bodyPreviewFallback.trim();
  if (raw) {
    quoteBody = ct.includes("html") ? htmlToQuoteText(raw, 12_000) : raw.slice(0, 12_000);
  }
  const safeFrom = escapeHtml(quotedHeaderFrom);
  const safeWhen = escapeHtml(quotedHeaderWhen);
  const quoteHtml = quoteTextToHtml(quoteBody);
  return `<p></p><p><br></p><hr style="border:none;border-top:1px solid #dadce0;margin:16px 0" /><blockquote style="margin:0;padding:8px 12px;border-left:3px solid #1a73e8;background:#f8f9fa;color:#202124;font-size:13px;line-height:1.5"><div style="font-weight:600;margin-bottom:8px">${safeFrom} · ${safeWhen}</div><div style="font-family:inherit">${quoteHtml}</div></blockquote>`;
}

function formatWhen(iso?: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function splitEmailList(raw: string): string[] {
  return raw
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function MailBodyPreview({ graphMsg }: { graphMsg: GraphMsgForReply }) {
  const raw = graphMsg as { error?: string };
  if (raw.error) {
    return <Typography color="error">{String(raw.error)}</Typography>;
  }
  const body = graphMsg.body;
  const content = body?.content?.trim() ?? "";
  const ct = (body?.contentType ?? "").toLowerCase();

  if (!content) {
    return <Typography color="text.secondary">（无正文）</Typography>;
  }

  if (ct.includes("html")) {
    return (
      <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, overflow: "hidden" }}>
        <Typography variant="caption" sx={{ px: 1, py: 0.5, display: "block", bgcolor: "action.hover" }}>
          HTML 预览（隔离 iframe）
        </Typography>
        <iframe
          title="inbound-html"
          sandbox=""
          srcDoc={content}
          style={{ width: "100%", height: 260, border: "none", display: "block" }}
        />
      </Box>
    );
  }

  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1.5,
        maxHeight: 260,
        overflow: "auto",
        whiteSpace: "pre-wrap",
        fontFamily: "inherit",
        fontSize: 13,
        bgcolor: "action.hover",
        borderRadius: 1,
        border: 1,
        borderColor: "divider",
      }}
    >
      {content}
    </Box>
  );
}

function ReplyToolbar({ editor }: { editor: ReturnType<typeof useEditor> }) {
  if (!editor) return null;
  const btn = (active: boolean, onClick: () => void, label: string) => (
    <Button
      size="small"
      variant={active ? "contained" : "outlined"}
      color={active ? "primary" : "inherit"}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      sx={{ minWidth: 40, px: 1, fontWeight: label === "B" ? 700 : undefined, fontStyle: label === "I" ? "italic" : undefined }}
    >
      {label}
    </Button>
  );
  return (
    <Box
      sx={{
        display: "flex",
        flexWrap: "wrap",
        gap: 0.5,
        alignItems: "center",
        py: 0.5,
        px: 0.5,
        borderBottom: 1,
        borderColor: "divider",
        bgcolor: "grey.50",
      }}
    >
      {btn(editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), "B")}
      {btn(editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), "I")}
      {btn(editor.isActive("underline"), () => editor.chain().focus().toggleUnderline().run(), "U")}
      {btn(editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run(), "•")}
      {btn(editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run(), "1.")}
      <Button
        size="small"
        variant={editor.isActive("link") ? "contained" : "outlined"}
        color={editor.isActive("link") ? "primary" : "inherit"}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const prev = editor.getAttributes("link").href as string | undefined;
          const href = window.prompt("链接 URL", prev ?? "https://");
          if (href === null) return;
          const t = href.trim();
          if (!t) {
            editor.chain().focus().extendMarkRange("link").unsetLink().run();
            return;
          }
          editor.chain().focus().extendMarkRange("link").setLink({ href: t }).run();
        }}
      >
        链接
      </Button>
    </Box>
  );
}

export default function ReplyComposerDialog({
  open,
  row,
  graphMsg,
  onClose,
  onSent,
}: {
  open: boolean;
  row: InboxReplyRow | null;
  graphMsg: GraphMsgForReply | null;
  onClose: () => void;
  onSent: () => void | Promise<void>;
}) {
  const [subject, setSubject] = useState("");
  const [ccText, setCcText] = useState("");
  const [bccText, setBccText] = useState("");
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const graphLoaded = graphMsg != null;
  const graphErr = graphMsg?.error ?? null;
  const graphOk = Boolean(graphMsg && !graphMsg.error);

  const initialHtml = useMemo(() => {
    if (!row || !graphMsg) return "<p></p>";
    if (graphMsg.error) return "<p></p>";
    return buildInitialReplyHtml({
      quotedHeaderFrom: String(row.fromEmail ?? ""),
      quotedHeaderWhen: formatWhen(row.receivedAt),
      graphBody: graphMsg.body,
      bodyPreviewFallback: String(row.bodyPreview ?? ""),
    });
  }, [row, graphMsg]);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: false, codeBlock: false }),
      Underline,
      LinkExt.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
      Placeholder.configure({ placeholder: "在此撰写回复…" }),
    ],
    content: "<p></p>",
    editorProps: {
      attributes: { class: "reply-compose-editor" },
    },
  });

  const lastSeedKey = useRef<string>("");
  useEffect(() => {
    if (!open || !editor || !row || !graphMsg) return;
    const key = graphMsg.error
      ? `err-${row.id}`
      : `${row.id}:${graphMsg.id ?? ""}:${(graphMsg.body?.content ?? "").length}`;
    if (lastSeedKey.current === key) return;
    lastSeedKey.current = key;
    editor.commands.setContent(initialHtml, false);
    editor.commands.focus("start");
  }, [open, editor, row, graphMsg, initialHtml]);

  useEffect(() => {
    if (!open) {
      lastSeedKey.current = "";
      setSendError(null);
      setSending(false);
      setShowCcBcc(false);
      setShowOriginal(false);
      setCcText("");
      setBccText("");
    }
  }, [open]);

  useEffect(() => {
    if (!open || !row) return;
    const sub =
      graphOk && graphMsg?.subject ? String(graphMsg.subject) : String(row.subject ?? "");
    setSubject(replySubject(sub));
  }, [open, row?.id, graphOk, graphMsg?.subject, row?.subject]);

  const attachmentUrl = useCallback((inboxId: number, attId: string) => {
    return `/api/inbox/${inboxId}/attachments/${encodeURIComponent(attId)}`;
  }, []);

  const handleSend = useCallback(async () => {
    if (!row || !editor) return;
    const html = editor.getHTML();
    const plain = editor.getText().trim();
    if (plain.length < 1) {
      setSendError("请先输入回复正文。");
      return;
    }
    setSendError(null);
    setSending(true);
    const cc = splitEmailList(ccText);
    const bcc = splitEmailList(bccText);
    try {
      await api(`/api/inbox/${row.id}/reply`, {
        method: "POST",
        body: JSON.stringify({
          bodyHtml: html,
          subject: subject.trim() || undefined,
          cc: cc.length ? cc : undefined,
          bcc: bcc.length ? bcc : undefined,
        }),
      });
      onClose();
      await onSent();
    } catch (e: unknown) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [row, editor, subject, ccText, bccText, onClose, onSent]);

  const onKeyDownDialog = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      onKeyDown={onKeyDownDialog}
      fullWidth
      maxWidth="lg"
      scroll="paper"
      slotProps={{
        paper: {
          sx: {
            height: "min(92vh, 880px)",
            display: "flex",
            flexDirection: "column",
            borderRadius: 2,
          },
        },
      }}
    >
      <DialogTitle sx={{ pb: 1, borderBottom: 1, borderColor: "divider" }}>
        <Stack spacing={1} sx={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Typography variant="h6" component="span" sx={{ fontWeight: 600 }}>
            回复
          </Typography>
          <Stack spacing={1} sx={{ flexDirection: "row", alignItems: "center" }}>
            <Typography variant="caption" color="text.secondary">
              ⌃/⌘ + Enter 发送
            </Typography>
            <Button variant="contained" disabled={sending || !graphLoaded} onClick={() => void handleSend()}>
              {sending ? "发送中…" : "发送"}
            </Button>
          </Stack>
        </Stack>
      </DialogTitle>

      <DialogContent
        dividers
        sx={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "auto", p: 2 }}
      >
        {!row ? null : (
          <>
            <Stack spacing={1.25} sx={{ mb: 2 }}>
              <TextField
                label="主题"
                size="small"
                fullWidth
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: "block" }} gutterBottom>
                  发件账号
                </Typography>
                <Typography variant="body2">{String(row.fcAccount ?? "—")}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: "block" }} gutterBottom>
                  收件人
                </Typography>
                <Typography variant="body2">{String(row.fromEmail ?? "—")}</Typography>
              </Box>
              <Button size="small" onClick={() => setShowCcBcc((v: boolean) => !v)} sx={{ alignSelf: "flex-start" }}>
                {showCcBcc ? "隐藏抄送 / 密送" : "添加抄送、密送"}
              </Button>
              <Collapse in={showCcBcc}>
                <Stack spacing={1.5} sx={{ pt: 0.5 }}>
                  <TextField
                    label="抄送 (Cc)"
                    size="small"
                    fullWidth
                    value={ccText}
                    onChange={(e) => setCcText(e.target.value)}
                    placeholder="多个地址用英文逗号或分号分隔"
                    helperText="与 Outlook / Gmail 一致，留空则不抄送"
                  />
                  <TextField
                    label="密送 (Bcc)"
                    size="small"
                    fullWidth
                    value={bccText}
                    onChange={(e) => setBccText(e.target.value)}
                    placeholder="多个地址用英文逗号或分号分隔"
                  />
                </Stack>
              </Collapse>
            </Stack>

            <Divider sx={{ my: 1 }} />

            {!graphMsg ? (
              <Typography color="text.secondary">正在加载邮件…</Typography>
            ) : (
              <>
                {graphErr ? (
                  <Alert severity="warning" sx={{ mb: 2 }}>
                    {graphErr}（仍可撰写正文并发送。）
                  </Alert>
                ) : null}

                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  撰写
                </Typography>
                <Box
                  sx={{
                    border: 1,
                    borderColor: "divider",
                    borderRadius: 1,
                    overflow: "hidden",
                    mb: 2,
                    flexShrink: 0,
                  }}
                >
                  <ReplyToolbar editor={editor} />
                  <Box className="reply-compose-editor">
                    {editor ? <EditorContent editor={editor} /> : null}
                  </Box>
                </Box>

                {graphOk ? (
                  <>
                    <Button size="small" onClick={() => setShowOriginal((v: boolean) => !v)} sx={{ mb: 1 }}>
                      {showOriginal ? "隐藏原信" : "显示原信（HTML 预览与附件）"}
                    </Button>
                    <Collapse in={showOriginal}>
                      <Box sx={{ mb: 2, p: 1.5, bgcolor: "grey.50", borderRadius: 1, border: 1, borderColor: "divider" }}>
                        <Typography variant="caption" color="text.secondary" sx={{ display: "block" }} gutterBottom>
                          原邮件 · {String(graphMsg.subject ?? row.subject ?? "")}
                        </Typography>
                        <MailBodyPreview graphMsg={graphMsg} />
                        {graphMsg.attachments && graphMsg.attachments.length > 0 && (
                          <Box sx={{ mt: 1.5 }}>
                            <Typography variant="caption" color="text.secondary">
                              附件（点击下载）
                            </Typography>
                            <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                              {graphMsg.attachments.map((a) => (
                                <Link
                                  key={a.id}
                                  href={attachmentUrl(row.id, a.id)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  variant="body2"
                                >
                                  {a.name || a.id}
                                  {a.size != null ? ` (${a.size} B)` : ""}
                                </Link>
                              ))}
                            </Stack>
                          </Box>
                        )}
                      </Box>
                    </Collapse>
                  </>
                ) : null}
              </>
            )}

            {sendError ? (
              <Alert severity="error" sx={{ mt: 1 }}>
                {sendError}
              </Alert>
            ) : null}
          </>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 2, py: 1.5, borderTop: 1, borderColor: "divider" }}>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
          样式接近 Web 版 Gmail / Outlook：主题、抄送密送、富文本与可折叠原信。
        </Typography>
        <Button onClick={onClose} disabled={sending}>
          取消
        </Button>
        <Button variant="contained" onClick={() => void handleSend()} disabled={sending || !graphLoaded}>
          发送
        </Button>
      </DialogActions>
    </Dialog>
  );
}
