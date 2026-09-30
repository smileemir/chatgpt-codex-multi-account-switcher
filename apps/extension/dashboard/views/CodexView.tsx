import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CodexAccountView, CodexEventView, CodexModelView, CodexSessionView, CodexSignInView, CodexTurnView } from "../../../../packages/contracts/src/index";
import { command, errorMessage, NativeCommandError } from "../../shared/bridge";
import { t } from "../../shared/i18n";
import { Badge, Button, Dialog, Notice } from "../../shared/ui";

type Approval = { id: number | string; method: string; params: unknown };
type PendingRegistration = { registrationId: string; createdAt: number };

function eventPreview(value: unknown): string {
  const json = JSON.stringify(value, null, 2) ?? "";
  return json.length > 4_000 ? `${json.slice(0, 4_000)}…` : json;
}

function statusLabel(status: CodexSessionView["status"] | CodexTurnView["status"]): string {
  const keys: Record<string, string> = {
    ready: "statusReady", running: "codexWorking", switching: "codexSwitching", paused: "codexPaused",
    queued: "codexQueued", completed: "codexCompleted", failed: "statusError", interrupted: "codexInterrupted",
  };
  return t(keys[status] ?? "notAvailable");
}

function TurnCard({ turn, accountLabel, events }: { turn: CodexTurnView; accountLabel: string; events: CodexEventView[] }) {
  const activities = events.filter((event) => event.turnId === turn.id &&
    (event.method === "item/started" || event.method === "item/completed"));
  const fallback = turn.status === "running" ? t("codexWorking")
    : turn.errorCode === "USAGE_LIMIT" ? t("codexLimitNotice")
      : turn.errorCode === "UNAUTHORIZED" ? t("errorReauthRequired")
        : turn.errorCode ? t("errorCodexRuntime") : "—";
  return <div className="codex-turn">
    <div className="codex-message codex-message--user">
      <small>{t("codexYou")} · {accountLabel}</small>
      <p>{turn.userText}</p>
    </div>
    <div className="codex-message codex-message--assistant">
      <small>{t("codexAssistant")} · {statusLabel(turn.status)}{turn.attempts > 1 ? ` · ${turn.attempts} ${t("codexAttempts")}` : ""}</small>
      <p>{turn.assistantText || fallback}</p>
    </div>
    {activities.length > 0 && <details className="codex-activity">
      <summary>{t("codexActivity")}</summary>
      {activities.map((event) => <pre key={event.seq} className="codex-event-detail">{event.method}: {eventPreview(event.payload)}</pre>)}
    </details>}
  </div>;
}

export function CodexView() {
  const [accounts, setAccounts] = useState<CodexAccountView[]>([]);
  const [pendingRegistrations, setPendingRegistrations] = useState<PendingRegistration[]>([]);
  const [sessions, setSessions] = useState<CodexSessionView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [session, setSession] = useState<CodexSessionView | null>(null);
  const [turns, setTurns] = useState<CodexTurnView[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [events, setEvents] = useState<CodexEventView[]>([]);
  const [signIn, setSignIn] = useState<CodexSignInView | null>(null);
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<CodexModelView[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [pool, setPool] = useState<string[]>([]);
  const [autoSwitch, setAutoSwitch] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disconnectId, setDisconnectId] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  async function refreshIndex() {
    const [nextAccounts, nextPending, nextSessions] = await Promise.all([
      command<"codex.accounts.list", CodexAccountView[]>("codex.accounts.list", {}),
      command<"codex.auth.pending", PendingRegistration[]>("codex.auth.pending", {}),
      command<"codex.sessions.list", CodexSessionView[]>("codex.sessions.list", {}),
    ]);
    setAccounts(nextAccounts);
    setPool((current) => current.filter((id) => nextAccounts.some((account) => account.id === id && account.connected)));
    setPendingRegistrations(nextPending);
    setSessions(nextSessions);
    setSelectedId((current) => current ?? nextSessions[0]?.id ?? null);
  }

  async function refreshSession(id: string) {
    const [nextSession, nextTurns, nextApprovals, nextEvents] = await Promise.all([
      command<"codex.sessions.get", CodexSessionView>("codex.sessions.get", { sessionId: id }),
      command<"codex.turns.list", CodexTurnView[]>("codex.turns.list", { sessionId: id }),
      command<"codex.approvals.list", Approval[]>("codex.approvals.list", { sessionId: id }),
      command<"codex.events.recent", CodexEventView[]>("codex.events.recent", { sessionId: id }),
    ]);
    if (selectedRef.current !== id) return;
    setSession(nextSession);
    setTurns(nextTurns);
    setApprovals(nextApprovals);
    setEvents(nextEvents);
  }

  useEffect(() => {
    let active = true;
    void refreshIndex().then(() => { if (active) setLoading(false); }).catch((cause) => {
      if (active) { setError(errorMessage(cause)); setLoading(false); }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selectedId) { setSession(null); setTurns([]); setEvents([]); setApprovals([]); return; }
    let active = true;
    const poll = async () => {
      try { await refreshSession(selectedId); if (active) setError(null); }
      catch (cause) { if (active) setError(errorMessage(cause)); }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [selectedId]);

  useEffect(() => {
    if (!signIn || signIn.state !== "pending") return;
    const timer = window.setInterval(() => {
      void command<"codex.auth.status", CodexSignInView>("codex.auth.status", { jobId: signIn.jobId })
        .then(async (job) => {
          setSignIn(job);
          if (job.state !== "pending") await refreshIndex();
        }).catch((cause) => setError(errorMessage(cause)));
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [signIn?.jobId, signIn?.state]);

  useEffect(() => {
    if (pool.length === 0) { setModels([]); setModel(""); setModelError(null); return; }
    let active = true;
    setModelError(null);
    void Promise.all(pool.map((accountId) => command<"codex.models.list", CodexModelView[]>("codex.models.list", { accountId })))
      .then((catalogs) => {
        if (!active) return;
        const common = catalogs[0].filter((item) => catalogs.every((catalog) => catalog.some((candidate) => candidate.slug === item.slug)));
        setModels(common);
        setModel((current) => common.some((item) => item.slug === current) ? current : (common[0]?.slug ?? ""));
      }).catch((cause) => { if (active) { setModels([]); setModel(""); setModelError(errorMessage(cause)); } });
    return () => { active = false; };
  }, [pool]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await action(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function connect(id?: string) {
    await run(async () => {
      const job = await command<"codex.auth.start", CodexSignInView>("codex.auth.start", id ? { accountId: id } : {});
      setSignIn(job);
    });
  }

  function togglePool(id: string) {
    setPool((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !cwd.trim() || !models.some((item) => item.slug === model) || pool.length === 0) {
      setError(t("codexRequired")); return;
    }
    await run(async () => {
      const created = await command<"codex.sessions.create", CodexSessionView>("codex.sessions.create", {
        title: title.trim(), cwd: cwd.trim(), model: model.trim(), accountOrder: pool, autoSwitch,
      });
      await refreshIndex();
      setSelectedId(created.id);
      setTitle("");
    });
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!selectedId || !message.trim()) return;
    await run(async () => {
      await command("codex.turns.start", { sessionId: selectedId, text: message.trim() });
      setMessage("");
      await refreshSession(selectedId);
    });
  }

  async function switchTo(id: string) {
    if (!selectedId) return;
    await run(async () => {
      await command("codex.sessions.switch", { sessionId: selectedId, accountId: id });
      await refreshSession(selectedId);
      await refreshIndex();
    });
  }

  async function resolveApproval(id: number | string, decision: "accept" | "decline") {
    if (!selectedId) return;
    await run(async () => {
      await command("codex.approvals.resolve", { sessionId: selectedId, approvalId: id, decision });
      await refreshSession(selectedId);
    });
  }

  const selectedAccount = accounts.find((item) => item.id === session?.activeAccountId);
  const inPool = accounts.filter((item) => session?.accountOrder.includes(item.id));
  const connected = accounts.filter((item) => item.connected);
  const canSend = session && session.status !== "running" && session.status !== "switching";

  return <>
    <div className="cma-page-heading">
      <span className="cma-eyebrow">{t("codexEyebrow")}</span>
      <h1>{t("codexTitle")}</h1>
      <p>{t("codexIntro")}</p>
    </div>
    <Notice tone="warn">{t("codexBoundary")}</Notice>
    {sessions.length > 0 && <div className="codex-session-tabs" aria-label={t("codexSessionsTitle")}>{sessions.map((item) => <Button key={item.id} variant={selectedId === item.id ? "primary" : "secondary"} onClick={() => setSelectedId(item.id)}>{item.title}</Button>)}</div>}
    {error && <Notice tone="bad" action={<Button onClick={() => void refreshIndex()}>{t("retry")}</Button>}>{error}</Notice>}
    {loading ? <Notice>{t("loading")}</Notice> : <div className="codex-page-blocks">
      <section className="cma-stack" aria-label={t("codexAccountsTitle")}>
        <div className="dashboard-section-heading"><div><h2>{t("codexAccountsTitle")}</h2><p>{t("codexAccountsHint")}</p></div><Button onClick={() => void connect()} disabled={busy || signIn?.state === "pending"}>{t("codexConnect")}</Button></div>
        {signIn?.state === "pending" && <Notice>{t("codexSignInPending")}</Notice>}
        {signIn?.state === "failed" && <Notice tone="bad">{t("codexSignInFailed")} {signIn.errorCode ? errorMessage(new NativeCommandError(signIn.errorCode)) : ""}</Notice>}
        {signIn?.state === "succeeded" && <Notice tone="good">{t("codexSignInSucceeded")}</Notice>}
        {pendingRegistrations.length > 0 && <div className="cma-card codex-list"><strong>{t("codexPendingRegistration")}</strong>{pendingRegistrations.map((item) => <div key={item.registrationId} className="codex-row"><span>{new Date(item.createdAt).toLocaleString()}</span><Button onClick={() => void connect(item.registrationId)} disabled={busy}>{t("codexRetryRegistration")}</Button></div>)}</div>}
        {accounts.length === 0 ? <Notice>{t("codexAccountsEmpty")}</Notice> : <div className="cma-card codex-list">{accounts.map((account) => <div className="codex-row" key={account.id}><div><strong>{account.label}</strong><small>{account.email ?? t("notAvailable")}</small></div><Badge tone={account.connected ? "good" : "warn"}>{account.connected ? t("statusReady") : t("statusUnavailable")}</Badge><Button onClick={() => void connect(account.id)} disabled={busy}>{t("codexReconnect")}</Button><Button variant="quiet" onClick={() => setDisconnectId(account.id)} disabled={busy || !account.connected}>{t("codexDisconnect")}</Button></div>)}</div>}
      </section>
      <section className="cma-stack" aria-label={t("codexSessionsTitle")}>
        <div className="dashboard-section-heading"><div><h2>{t("codexSessionsTitle")}</h2><p>{t("codexSessionsHint")}</p></div></div>
        <form className="cma-card codex-create" onSubmit={(event) => void create(event)}>
          <div className="cma-field"><label htmlFor="codex-title">{t("codexSessionName")}</label><input id="codex-title" className="cma-input" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} /></div>
          <div className="cma-field"><label htmlFor="codex-cwd">{t("codexWorkspace")}</label><input id="codex-cwd" className="cma-input" value={cwd} maxLength={4096} autoComplete="off" onChange={(event) => setCwd(event.target.value)} /><p className="cma-field-hint">{t("codexWorkspaceHint")}</p></div>
          <div className="cma-field"><label htmlFor="codex-model">{t("codexModel")}</label><select id="codex-model" className="cma-select" value={model} onChange={(event) => setModel(event.target.value)}><option value="">{t("codexSelectModel")}</option>{models.map((item) => <option key={item.slug} value={item.slug}>{item.displayName}</option>)}</select>{modelError && <p className="cma-field-error" role="alert">{modelError}</p>}{pool.length > 0 && !modelError && models.length === 0 && <p className="cma-field-hint">{t("codexNoCommonModel")}</p>}</div>
          <fieldset className="codex-pool"><legend>{t("codexPool")}</legend>{connected.length === 0 ? <p>{t("codexAccountsEmpty")}</p> : connected.map((account) => <label key={account.id}><input type="checkbox" checked={pool.includes(account.id)} onChange={() => togglePool(account.id)} />{account.label}</label>)}</fieldset>
          <label className="settings-checkbox-row"><input type="checkbox" checked={autoSwitch} onChange={(event) => setAutoSwitch(event.target.checked)} /><span>{t("codexAutoSwitch")}</span></label>
          <p className="cma-field-hint">{t("codexAutoSwitchHint")}</p>
          <div className="cma-action-row"><Button variant="primary" type="submit" disabled={busy}>{busy ? t("loading") : t("codexCreateSession")}</Button></div>
        </form>
        {sessions.length === 0 && <Notice>{t("codexSessionsEmpty")}</Notice>}
      </section>
      {session && <section className="cma-stack codex-conversation" aria-label={session.title}>
        <div className="dashboard-section-heading"><div><h2>{session.title}</h2><p>{session.cwd}</p></div><Badge tone={session.status === "ready" ? "good" : session.status === "running" ? "warn" : "bad"}>{statusLabel(session.status)}</Badge></div>
        <div className="cma-card codex-runtime-controls"><div><strong>{t("codexActiveAccount")}: {selectedAccount?.label ?? t("notAvailable")}</strong><small>{t("codexModel")}: {session.model} · {t("codexThread")}: {session.threadId ?? "—"}</small></div><div className="codex-account-switch">{inPool.map((account) => <Button key={account.id} variant={account.id === session.activeAccountId ? "primary" : "secondary"} disabled={busy || session.status === "running" || session.status === "switching" || !account.connected || account.id === session.activeAccountId} onClick={() => void switchTo(account.id)}>{account.label}</Button>)}</div></div>
        {approvals.map((approval) => <Notice key={String(approval.id)} tone="warn" title={t("codexApprovalTitle")} action={<div className="cma-action-row"><Button onClick={() => void resolveApproval(approval.id, "decline")}>{t("codexDecline")}</Button><Button variant="primary" onClick={() => void resolveApproval(approval.id, "accept")}>{t("codexApprove")}</Button></div>}><strong>{approval.method}</strong><pre className="codex-event-detail">{eventPreview(approval.params)}</pre></Notice>)}
        <div className="cma-card codex-transcript">{turns.length === 0 ? <p>{t("codexTurnsEmpty")}</p> : turns.map((turn) => <TurnCard key={turn.id} turn={turn} accountLabel={accounts.find((item) => item.id === turn.accountId)?.label ?? turn.accountId} events={events} />)}</div>
        {events.some((event) => event.method === "account/limitReached") && <Notice tone="warn">{t("codexLimitNotice")}</Notice>}
        <form className="cma-card codex-compose" onSubmit={(event) => void send(event)}><label htmlFor="codex-message">{t("codexMessage")}</label><textarea id="codex-message" className="cma-input" rows={5} maxLength={64000} value={message} onChange={(event) => setMessage(event.target.value)} /><div className="cma-action-row"><Button variant="primary" type="submit" disabled={busy || !canSend || !message.trim()}>{t("codexSend")}</Button>{session.status === "running" && <Button onClick={() => void run(async () => { await command("codex.turns.interrupt", { sessionId: session.id }); })}>{t("codexStop")}</Button>}</div></form>
      </section>}
    </div>}
    {disconnectId && <Dialog title={t("codexDisconnectTitle")} onClose={() => setDisconnectId(null)} actions={<><Button onClick={() => setDisconnectId(null)}>{t("cancel")}</Button><Button variant="danger" disabled={busy} onClick={() => void run(async () => { await command("codex.auth.disconnect", { accountId: disconnectId }); setDisconnectId(null); await refreshIndex(); })}>{t("codexDisconnect")}</Button></>}><p>{t("codexDisconnectWarning")}</p></Dialog>}
  </>;
}
