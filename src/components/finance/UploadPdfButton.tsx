"use client";

// "Upload PDF" button + modal with a click/drag dropzone. The AI reads the
// chosen bank-statement PDF, extracts every transaction, classifies each, and
// stages them in the review queue (source = "pdf"). Reuses .sync-modal styles.

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { FileText, X, Loader2, Upload } from "lucide-react";
import { uploadPdfAction } from "@/app/(shell)/finance/actions";

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function SubmitButton({ hasFile }: { hasFile: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="primary-btn" disabled={!hasFile || pending}>
      {pending ? (
        <>
          <Loader2 size={13} className="spin" /> Reading PDF…
        </>
      ) : (
        <>
          <Upload size={13} strokeWidth={2} /> Extract &amp; preview
        </>
      )}
    </button>
  );
}

export function UploadPdfButton() {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<{ name: string; size: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function setFromFile(f: File | undefined | null) {
    if (f) setPicked({ name: f.name, size: f.size });
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f && inputRef.current) {
      const dt = new DataTransfer();
      dt.items.add(f);
      inputRef.current.files = dt.files; // so the form submits the dropped file
      setFromFile(f);
    }
  }

  function reset() {
    setPicked(null);
    setDragOver(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <>
      <button type="button" className="ghost-btn" onClick={() => setOpen(true)}>
        <FileText size={13} strokeWidth={2} />
        Upload PDF
      </button>

      {open ? (
        <div className="sync-modal-root">
          <div
            className="sync-modal-backdrop"
            onClick={() => {
              setOpen(false);
              reset();
            }}
          />
          <div className="sync-modal" role="dialog" aria-modal="true">
            <header className="sync-modal-head">
              <div>
                <div className="sync-modal-title">Upload bank statement (PDF)</div>
                <div className="sync-modal-sub">
                  The AI reads the PDF and shows you a preview of everything it
                  found. Nothing changes on the Overview until you confirm.
                </div>
              </div>
              <button
                type="button"
                className="sync-modal-close"
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </header>

            <form action={uploadPdfAction}>
              <div className="sync-modal-body">
                <input
                  ref={inputRef}
                  type="file"
                  name="pdf"
                  accept="application/pdf,.pdf"
                  style={{ display: "none" }}
                  onChange={(e) => setFromFile(e.target.files?.[0])}
                />

                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => inputRef.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDrop}
                  style={{
                    border: `1.5px dashed ${dragOver ? "var(--accent)" : "var(--border-strong)"}`,
                    borderRadius: 10,
                    padding: "26px 18px",
                    textAlign: "center",
                    cursor: "pointer",
                    background: dragOver ? "var(--surface-2)" : "var(--surface)",
                    transition: "background .12s, border-color .12s",
                    outline: "none",
                  }}
                >
                  {picked ? (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 12,
                      }}
                    >
                      <div
                        style={{
                          width: 40,
                          height: 40,
                          borderRadius: 9,
                          background: "var(--surface-3)",
                          display: "grid",
                          placeItems: "center",
                          flexShrink: 0,
                        }}
                      >
                        <FileText size={18} style={{ color: "var(--accent)" }} />
                      </div>
                      <div style={{ textAlign: "left", minWidth: 0 }}>
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: 13,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: 280,
                          }}
                        >
                          {picked.name}
                        </div>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {fmtSize(picked.size)} · click to replace
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: "grid", placeItems: "center", marginBottom: 10 }}>
                        <div
                          style={{
                            width: 44,
                            height: 44,
                            borderRadius: 11,
                            background: "var(--surface-3)",
                            display: "grid",
                            placeItems: "center",
                          }}
                        >
                          <Upload size={19} style={{ color: "var(--muted-strong)" }} />
                        </div>
                      </div>
                      <div style={{ fontWeight: 550, fontSize: 13 }}>
                        Click to choose a PDF
                      </div>
                      <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                        or drag &amp; drop it here · max 20MB
                      </div>
                    </>
                  )}
                </div>

                <p className="sync-note">
                  A long statement can take up to a minute to read — keep this
                  tab open.
                </p>
              </div>

              <footer className="sync-modal-foot">
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => {
                    setOpen(false);
                    reset();
                  }}
                >
                  Cancel
                </button>
                <SubmitButton hasFile={!!picked} />
              </footer>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
