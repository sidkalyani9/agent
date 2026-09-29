import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { api, streamChat } from "../api.js";
import { IconAssistant, IconBack, IconChats, IconClose, IconPlus, IconSend } from "../icons.jsx";

const READY = "Ask what an office spent, or tell me to add or delete a pantry item. I will ask you to confirm before anything is saved or deleted.";
const MISSING = "The assistant is not switched on yet. Recording on the pantry screen still works.";

export function ChatDock({ configured, onSaved }) {
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState("thread");
  const [threads, setThreads] = useState([]);
  const [threadId, setThreadId] = useState("");
  const threadIdRef = useRef("");
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const threadRef = useRef(null);
  const chatEpoch = useRef(0);
  const greeting = configured ? READY : MISSING;

  async function loadThreads() {
    const data = await api("/api/chat/threads");
    setThreads(data.threads);
    return data.threads;
  }

  function remember(id) {
    if (!id) return;
    threadIdRef.current = id;
    setThreadId(id);
  }

  async function openThread(id) {
    const data = await api(`/api/chat/threads/${id}`);
    remember(id);
    setMessages(data.messages.length ? data.messages : [{ role: "assistant", content: greeting }]);
    setPane("thread");
  }

  useEffect(() => {
    if (!open) return undefined;
    let cancel = false;
    const epoch = chatEpoch.current;
    loadThreads()
      .then((list) => {
        if (cancel || epoch !== chatEpoch.current || threadIdRef.current) return;
        if (list[0]) return openThread(list[0].id);
        setMessages([{ role: "assistant", content: greeting }]);
      })
      .catch((err) => {
        if (!cancel) setError(err.message);
      });
    return () => {
      cancel = true;
    };
  }, [open]);

  useEffect(() => {
    setMessages((current) => {
      if (current.length === 1 && (current[0].content === READY || current[0].content === MISSING) && current[0].content !== greeting) {
        return [{ role: "assistant", content: greeting }];
      }
      return current;
    });
  }, [greeting]);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, busy, open, pane]);

  function startNew() {
    setError("");
    chatEpoch.current += 1;
    threadIdRef.current = "";
    setThreadId("");
    setText("");
    setMessages([{ role: "assistant", content: greeting }]);
    setPane("thread");
  }

  async function send(event) {
    event.preventDefault();
    const message = text.trim();
    if (!message || busy) return;
    setMessages((current) => {
      const kept = current.length === 1 && current[0].content === greeting ? [] : current;
      return [...kept, { role: "user", content: message }];
    });
    setText("");
    setBusy(true);
    setError("");
    try {
      await streamChat({ message, threadId: threadIdRef.current || undefined }, (eventName, data) => {
        if (eventName === "thread") remember(data.threadId);
        if (eventName === "delta") {
          flushSync(() => {
            setMessages((current) => {
              const next = [...current];
              const last = next[next.length - 1];
              if (last?.streaming) {
                next[next.length - 1] = { ...last, content: `${last.content || ""}${data.text || ""}` };
                return next;
              }
              return [...next, { role: "assistant", content: data.text || "", streaming: true }];
            });
          });
        }
        if (eventName === "replace") {
          flushSync(() => {
            setMessages((current) => {
              const next = [...current];
              const last = next[next.length - 1];
              if (last?.streaming) {
                next[next.length - 1] = { ...last, content: data.text || "" };
                return next;
              }
              return [...next, { role: "assistant", content: data.text || "", streaming: true }];
            });
          });
        }
        if (eventName === "done") {
          remember(data.threadId);
          setMessages((current) => {
            const next = [...current];
            const bubble = { role: "assistant", content: data.reply || "", proposals: data.proposals || [] };
            if (next[next.length - 1]?.streaming) {
              next[next.length - 1] = bubble;
              return next;
            }
            return [...next, bubble];
          });
          if (data.saved) onSaved();
        }
        if (eventName === "error") {
          remember(data.threadId);
          const error = new Error(data.error || "The assistant could not reply.");
          error.threadId = data.threadId || "";
          throw error;
        }
      });
      loadThreads().catch(() => {});
    } catch (err) {
      remember(err.threadId);
      setError(err.message);
    } finally {
      setBusy(false);
      setMessages((current) => current.map((item) => (item.streaming ? { ...item, streaming: false } : item)));
    }
  }

  async function confirm(proposalId) {
    setBusy(true);
    setError("");
    try {
      const data = await api("/api/chat/confirm", { method: "POST", body: { proposalId, threadId: threadIdRef.current } });
      setMessages((current) => [
        ...current.map((item) =>
          item.proposals ? { ...item, proposals: item.proposals.filter((proposal) => proposal.id !== proposalId) } : item,
        ),
        { role: "assistant", content: data.reply || `Saved. ${data.summary}` },
      ]);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function dismiss(proposalId) {
    await api("/api/chat/dismiss", { method: "POST", body: { proposalId } }).catch(() => {});
    setMessages((current) =>
      current.map((item) =>
        item.proposals ? { ...item, proposals: item.proposals.filter((proposal) => proposal.id !== proposalId) } : item,
      ),
    );
  }

  return (
    <div className={`dock${open ? " open" : ""}`}>
      {open ? (
        <aside className="card chat" role="dialog" aria-label="Assistant">
          <header>
            <div className="card-head">
              {pane === "history" ? (
                <button className="icon-button" type="button" aria-label="Back to chat" onClick={() => setPane("thread")}><IconBack /></button>
              ) : (
                <h2 className="with-icon"><IconAssistant /> Assistant</h2>
              )}
              <div className="row-actions">
                {pane === "thread" ? (
                  <button className="icon-button" type="button" aria-label="Past chats" onClick={() => { setPane("history"); loadThreads().catch((err) => setError(err.message)); }}>
                    <IconChats />
                  </button>
                ) : <h2>Past chats</h2>}
                <button className="icon-button" type="button" aria-label="New chat" onClick={startNew}><IconPlus /></button>
                <button className="icon-button" type="button" aria-label="Close assistant" onClick={() => setOpen(false)}><IconClose /></button>
              </div>
            </div>
          </header>
          {pane === "history" ? (
            <div className="thread">
              {threads.length ? threads.map((thread) => (
                <button key={thread.id} type="button" className="thread-row" onClick={() => openThread(thread.id).catch((err) => setError(err.message))}>
                  <strong>{thread.title}</strong>
                  <span>{thread.updatedAtLabel}</span>
                </button>
              )) : <p className="muted">No chats yet.</p>}
            </div>
          ) : (
            <div className="thread" ref={threadRef} aria-live="polite">
              {messages.map((item, index) => (
                <div key={item.id || index} className={`bubble ${item.role}${item.streaming ? " streaming" : ""}`}>
                  {item.content}
                  {(item.proposals || []).map((proposal) => (
                    <div className="proposal" key={proposal.id}>
                      <p>{proposal.summary}</p>
                      <div className="row-actions">
                        <button className="solid" type="button" disabled={busy} onClick={() => confirm(proposal.id)}>Confirm</button>
                        <button className="ghost" type="button" disabled={busy} onClick={() => dismiss(proposal.id)}>Leave unsaved</button>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
              {busy && !messages.some((item) => item.streaming && item.content) ? <p className="muted">Working…</p> : null}
              {error ? <p className="error">{error}</p> : null}
            </div>
          )}
          {pane === "thread" ? (
            <form onSubmit={send}>
              <textarea
                aria-label="Message the assistant"
                value={text}
                placeholder="What did Ahmedabad spend on coffee?"
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form.requestSubmit();
                  }
                }}
              />
              <button className="solid icon-button send" type="submit" aria-label="Send" disabled={busy}><IconSend /></button>
            </form>
          ) : null}
        </aside>
      ) : null}
      <button
        className="launcher"
        type="button"
        aria-expanded={open}
        aria-label={open ? "Close assistant" : "Open assistant"}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <IconClose /> : <IconAssistant />}
      </button>
    </div>
  );
}
