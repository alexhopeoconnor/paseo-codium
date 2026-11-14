import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import {
  cancelRequestRpc, createSessionRpc, openFileRpc, receiptRpc, releaseSessionRpc, sessionStateRpc,
  snapshotRpc, type SessionState,
} from "../shared/rpc";
import { describeFileOpenReceipt, type FileOpenReceipt } from "../shared/receipts";
import {
  ActiveFileTracker, editorPanelVisible, editorPollDelay, editorQueue, editorReceipts, ReceiptInspection,
  relativeWorkspacePath, resolveEditorCloseProtection, restoredEditorTarget, revealOpenedFile,
  shouldProtectEditor, shouldReleaseCreatedSession, type ActiveFileObservation,
} from "./editor-session";
import { makeBootstrapUrl, mountCodiumFrame, newRequestId, observePanelVisibility, type MountedCodiumFrame } from "./web";
import {
  closeProtectionSetter, createRevealLifetime, retainedTabSetter, type CloseProtectionResolver,
  type RevealFileOptions, type RevealFileResult,
} from "./host-capabilities";
import { openAccessHelper, probeCodiumAccess, type AccessProbe } from "./access-probe";
import { EditorToolbar, type EditorConnectionIndicator } from "./editor-toolbar";

type Session = { sessionId: string; ownerKey: string; bootstrapKey: string; directory: string; protocolVersion: 2 };
const unknownState: SessionState = { connected: false, known: false, dirty: false, sequence: 0, expired: false };

declare const document: {
  visibilityState: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};
declare const window: {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

export function EmbeddedEditor(props: PluginWorkspacePanelProps & {
  retainEditor: boolean; freshCloseProtection: boolean; closePrimarySidebar: boolean;
  hostVisible?: boolean; origin: string; connectionKey: string; externalUrl: string;
  revealFile?(path: string, intent: "auto" | "explicit", options?: RevealFileOptions): Promise<RevealFileResult>;
  openSettings(): void; onProtectedChange(value: boolean): void; setBeforeCloseResolver(resolver: CloseProtectionResolver | null): void;
}) {
  const create = useRpc(createSessionRpc);
  const getState = useRpc(sessionStateRpc);
  const snapshot = useRpc(snapshotRpc);
  const openFile = useRpc(openFileRpc);
  const cancel = useRpc(cancelRequestRpc);
  const receipt = useRpc(receiptRpc);
  const release = useRpc(releaseSessionRpc);
  const api = useRef({ create, getState, snapshot, openFile, cancel, receipt, release });
  api.current = { create, getState, snapshot, openFile, cancel, receipt, release };
  const panel = useRef(props); panel.current = props;
  const host = useRef<View>(null);
  const [generation, setGeneration] = useState(0);
  const [observedVisible, setObservedVisible] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(true);
  const visible = editorPanelVisible(props.hostVisible, observedVisible, documentVisible);
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const refreshPoll = useRef<() => void>(() => {});
  const [connection, setConnection] = useState<EditorConnectionIndicator>({ kind: "connecting", message: "Checking Codium access…" });
  const [error, setError] = useState("");
  const [outcomeRequest, setOutcomeRequest] = useState<string | null>(null);
  const [outcomeReceipt, setOutcomeReceipt] = useState<FileOpenReceipt | null>(null);
  const [outcomeNote, setOutcomeNote] = useState("");
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const currentFileRef = useRef<string | null>(null); currentFileRef.current = currentFile;
  const revealLifetime = useRef(createRevealLifetime());
  const activeFileTracker = useRef(new ActiveFileTracker());
  const outcomeRequestRef = useRef<string | null>(null); outcomeRequestRef.current = outcomeRequest;
  const inspection = useRef(new ReceiptInspection());
  const [accessUnconfirmed, setAccessUnconfirmed] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [checking, setChecking] = useState(false);
  const beforeClose = useRef<CloseProtectionResolver>(() => true);
  const protection = useRef(true);
  const state = useRef<SessionState>(unknownState);
  const retryAccess = useRef<() => void>(() => {});
  const signIn = useRef<() => void>(() => {});
  const checkOutcome = useRef<() => void>(() => {});
  const queue = editorQueue(props.host.id, props.workspaceId);
  const { colors } = props.theme;
  const setRetained = retainedTabSetter(props.tab, props.retainEditor);
  const setCloseProtection = closeProtectionSetter(props.tab, props.freshCloseProtection);
  const setBeforeCloseResolver = props.setBeforeCloseResolver;

  useEffect(() => {
    setRetained?.(true);
    return () => setRetained?.(false);
  }, [setRetained]);

  useEffect(() => {
    if (props.hostVisible !== undefined || Platform.OS !== "web") return;
    return observePanelVisibility(host.current, setObservedVisible);
  }, [props.hostVisible]);

  useEffect(() => {
    if (visible) refreshPoll.current();
  }, [visible]);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const update = () => setDocumentVisible(document.visibilityState === "visible");
    const refresh = () => { update(); if (document.visibilityState === "visible") refreshPoll.current(); };
    update();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let session: Session | undefined;
    let frame: MountedCodiumFrame | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let draining = false;
    let polling = false;
    let refreshQueued = false;
    let frameFocused = false;
    let focusEpoch = 0;
    let probe: AccessProbe | undefined;
    let accessAttempt = 0;
    let removeReturnListeners = () => {};
    const started = Date.now();
    state.current = unknownState; protection.current = true;
    panel.current.tab.setModified(true); panel.current.onProtectedChange(true);
    setConnection({ kind: "connecting", message: "Checking Codium access…" }); setError(""); setChecking(false); setAccessUnconfirmed(false);
    inspection.current.clear();
    revealLifetime.current.abort();
    revealLifetime.current = createRevealLifetime();
    activeFileTracker.current.reset();
    setOutcomeRequest(null); setOutcomeReceipt(null); setOutcomeNote(""); setCurrentFile(null);
    const protect = (next: SessionState, observedFocusEpoch = focusEpoch) => {
      state.current = next;
      // Capable hosts ask for fresh state at close time. Stock hosts still need
      // conservative focus protection because their close uses this polled flag.
      protection.current = shouldProtectEditor(next, frameFocused, observedFocusEpoch, focusEpoch, !!setCloseProtection);
      panel.current.tab.setModified(protection.current);
      panel.current.onProtectedChange(protection.current);
    };
    const resolveProtection: CloseProtectionResolver = async () => {
      if (disposed || !session || !frame?.blurForClose()) return true;
      const requestedSession = session, observedFocusEpoch = focusEpoch;
      try {
        // Always a new paired-window snapshot, never the last display poll.
        return await resolveEditorCloseProtection(
          () => api.current.snapshot({ sessionId: requestedSession.sessionId, ownerKey: requestedSession.ownerKey }),
          () => !disposed && session === requestedSession && !frameFocused && focusEpoch === observedFocusEpoch,
          (next) => {
            if (next.sequence >= state.current.sequence) protect(next, observedFocusEpoch);
            return protection.current;
          },
        );
      } catch {
        if (!disposed) protect({ ...state.current, connected: false, known: false });
        return true;
      }
    };
    beforeClose.current = resolveProtection;
    setCloseProtection?.(resolveProtection);
    setBeforeCloseResolver(resolveProtection);
    const reportFileIssue = (requestId: string, message: string) => {
      // A new issue invalidates any older Check-outcome query still in flight.
      inspection.current.show(requestId);
      setError(message);
      setOutcomeRequest(requestId);
      setOutcomeReceipt(editorReceipts.get(requestId) ?? null);
      setOutcomeNote("");
    };
    const showObservedActiveFile = (observation: ActiveFileObservation) => {
      if (!observation.changed) return;
      setCurrentFile(observation.activeFile ?? null);
      if (observation.reveal && panel.current.revealFile) {
        void panel.current.revealFile(observation.reveal, "auto", { signal: revealLifetime.current.signal });
      }
    };
    const refreshActiveFileBoundary = () => {
      if (disposed || !session || activeFileTracker.current.awaitingFresh) return;
      const token = activeFileTracker.current.beginFresh();
      const requestedSession = session;
      void api.current.snapshot({ sessionId: requestedSession.sessionId, ownerKey: requestedSession.ownerKey }).then((fresh) => {
        if (disposed || session !== requestedSession) return;
        if (!fresh.connected || !fresh.known) {
          // No paired companion proof (for example a disconnected session
          // returning cached state): keep the confirmed target and retry later.
          activeFileTracker.current.failFresh(token);
          return;
        }
        const observation = activeFileTracker.current.resolveFresh(fresh.activeFile, fresh.sequence, token);
        if (observation) showObservedActiveFile(observation);
      }).catch(() => {
        if (!disposed && session === requestedSession) activeFileTracker.current.failFresh(token);
      });
    };
    const drain = async () => {
      if (draining || disposed || !session || !state.current.known) return;
      draining = true;
      try {
        let request: ReturnType<typeof queue.peekForConnection>;
        while (!disposed && state.current.known && (request = queue.peekForConnection(props.connectionKey))) {
          const requestId = request.requestId;
          const onAbort = () => {
            if (disposed) return;
            // Crossed the RPC boundary: cancellation is advisory and the outcome
            // is unknown, never authoritative not-sent.
            editorReceipts.advance(requestId, "execution", "uncertain", "cancelled");
            void api.current.cancel({ sessionId: session!.sessionId, ownerKey: session!.ownerKey, requestId }).catch(() => {});
          };
          request.signal?.addEventListener?.("abort", onAbort);
          // Explicit local dispatch ownership: queue pruning and connection
          // changes must not turn an in-flight RPC into not_sent.
          editorReceipts.advance(requestId, "execution", "sent");
          try {
            const { receipt } = await api.current.openFile({ sessionId: session.sessionId, ownerKey: session.ownerKey, requestId, target: request.target });
            if (disposed) return;
            editorReceipts.merge(requestId, receipt);
            if (receipt.outcome === "opened") {
              queue.complete(requestId, props.connectionKey, "opened");
              panel.current.tab.setState({ connectionKey: props.connectionKey, lastTarget: JSON.parse(JSON.stringify(request.target)) });
              queue.takeExpiredNotice();
              setError("");
              if (outcomeRequestRef.current === requestId) {
                inspection.current.clear();
                setOutcomeRequest(null);
              }
              const relativePath = relativeWorkspacePath(session.directory, request.target.path);
              const priorActive = activeFileTracker.current.current;
              activeFileTracker.current.confirm(relativePath, state.current.sequence);
              setCurrentFile(relativePath);
              // Editor navigation keeps the Paseo Files selection in sync only
              // when Files is already visible; this never opens another file tab.
              // This is a fresh panel-scoped reveal, not the settled host request.
              // A state observation of the same confirmed file already revealed it.
              if (priorActive !== relativePath) {
                revealOpenedFile({
                  reveal: panel.current.revealFile ? (path) => {
                    void panel.current.revealFile!(path, "auto", { signal: revealLifetime.current.signal });
                  } : undefined,
                  directory: session.directory,
                  path: request.target.path,
                  isCurrent: () => !disposed,
                });
              }
              // The cached server sequence can be ahead with an old active file
              // while the companion's new state is still coalesced. Establish a
              // real companion sequence boundary with a fresh snapshot; polled
              // active files are suspended until it resolves.
              refreshActiveFileBoundary();
            } else if (receipt.outcome === "failed") {
              queue.complete(requestId, props.connectionKey, "failed");
              reportFileIssue(requestId, "Codium reported that the file could not be opened. Check the editor connection, then open the file again from the explorer, search or original link.");
            } else if (receipt.outcome === "not_sent") {
              queue.complete(requestId, props.connectionKey, "not_sent");
              reportFileIssue(requestId, "Codium recorded the file request as not sent. Open the file again to retry.");
            } else {
              // Unknown after dispatch: the editor may have opened it. Never retry
              // automatically or reuse this request identity.
              queue.complete(requestId, props.connectionKey, "uncertain");
              reportFileIssue(requestId, "Codium may have opened the file but did not confirm it. Check the editor, then open the file again to retry.");
            }
          } catch {
            if (!disposed) {
              // A lost RPC response can follow a socket write, so this is unknown,
              // not authoritative non-admission. No automatic retry.
              editorReceipts.advance(requestId, "execution", "uncertain", "disconnected");
              queue.complete(requestId, props.connectionKey, "uncertain");
              reportFileIssue(requestId, "Codium did not confirm the file request. Check the editor, then open the file again to retry.");
            }
            break;
          } finally {
            request.signal?.removeEventListener?.("abort", onAbort);
          }
        }
      } finally { draining = false; }
    };
    const unsubscribe = queue.subscribe(() => { void drain(); });
    const schedulePoll = (delay: number) => {
      if (disposed) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { void poll(); }, delay);
    };
    const applyActiveFile = (next: SessionState, epoch: number) => {
      // Passive tree-only reveal for an actual active-file change; repeated
      // heartbeats with the same file do not reveal again.
      showObservedActiveFile(activeFileTracker.current.observe(next.activeFile, next.sequence, epoch));
    };
    const poll = async () => {
      if (disposed || !session || polling) return;
      polling = true;
      if (queue.takeExpiredNotice()) setError("A pending file request expired after five minutes. Open the file again from the explorer, search or original link.");
      try {
        const observedFocusEpoch = focusEpoch;
        const activeEpoch = activeFileTracker.current.epoch;
        // Cached heartbeat state only; close protection takes a fresh snapshot.
        const next = await api.current.getState({ sessionId: session.sessionId, ownerKey: session.ownerKey });
        if (disposed) return;
        if (next.sequence >= state.current.sequence) {
          protect(next, observedFocusEpoch);
          // A poll that started before an open ACK must not apply its stale active
          // file over the newly confirmed target.
          applyActiveFile(next, activeEpoch);
        }
        const observed = state.current;
        setConnection(observed.known && observed.connected ? { kind: "connected", message: observed.dirty ? "Connected · unsaved changes" : "Connected", dirty: observed.dirty } :
          observed.expired ? { kind: "disconnected", message: "Pairing expired." } :
          Date.now() - started > 15_000 ? { kind: "disconnected", message: "The editor has not confirmed it is ready." } :
          { kind: "connecting", message: "Connecting editor…" });
        if (observed.known) void drain();
      } catch {
        if (disposed) return;
        protect({ ...state.current, connected: false, known: false });
        setConnection({ kind: "disconnected", message: "Editor connection unavailable. Unsaved state is unknown." });
      } finally {
        polling = false;
        // A failed ACK boundary retries through the existing fresh snapshot once
        // per normal poll/refresh cycle, never by reopening the file.
        if (!disposed && activeFileTracker.current.needsResync) refreshActiveFileBoundary();
        // Visible panels refresh every 2s; hidden panels every 15s. A focus or
        // visibility return queues an immediate refresh; heartbeat and fresh close
        // snapshots remain independent of this display poll.
        const delay = refreshQueued ? 10 : editorPollDelay(visibleRef.current);
        refreshQueued = false;
        schedulePoll(delay);
      }
    };
    refreshPoll.current = () => {
      if (disposed || !session) return;
      if (polling) { refreshQueued = true; return; }
      if (timer !== undefined) clearTimeout(timer);
      void poll();
    };
    const armReturnProbe = () => {
      removeReturnListeners();
      const inspect = () => {
        if (disposed || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
        removeReturnListeners();
        void attemptAccess();
      };
      window.addEventListener("focus", inspect);
      document.addEventListener("visibilitychange", inspect);
      removeReturnListeners = () => {
        window.removeEventListener("focus", inspect);
        document.removeEventListener("visibilitychange", inspect);
        removeReturnListeners = () => {};
      };
    };
    const attemptAccess = async () => {
      if (disposed || session) return;
      const attempt = ++accessAttempt;
      probe?.cancel(); removeReturnListeners();
      setAccessUnconfirmed(false); setError(""); setChecking(false);
      setConnection({ kind: "connecting", message: "Checking Codium access…" });
      queue.advancePending(props.connectionKey, "access_probe");
      let current: AccessProbe;
      try { current = probeCodiumAccess(props.origin); }
      catch {
        setAccessUnconfirmed(true);
        setConnection({ kind: "disconnected", message: "Codium access is unconfirmed." });
        return;
      }
      probe = current;
      const outcome = await current.result;
      if (disposed || attempt !== accessAttempt || outcome !== "ready") {
        if (!disposed && attempt === accessAttempt) {
          // Access is unconfirmed, not an authentication verdict and not a pairing
          // allocation. The user can sign in or check again.
          setAccessUnconfirmed(true);
          setConnection({ kind: "disconnected", message: "Codium access is unconfirmed." });
        }
        return;
      }
      setConnection({ kind: "connecting", message: "Pairing editor…" });
      queue.advancePending(props.connectionKey, "pairing");
      try {
        const created = await api.current.create({
          workspaceId: props.workspaceId, clientId: newRequestId(),
          presentation: { closePrimarySidebar: panel.current.closePrimarySidebar },
        });
        if (shouldReleaseCreatedSession({
          disposed, attempt, currentAttempt: accessAttempt, hasSession: !!session,
        })) {
          // A superseded retry or disposed panel must not mount or retain this
          // session/frame. Release it without touching the current attempt.
          void api.current.release({ sessionId: created.sessionId, ownerKey: created.ownerKey }).catch(() => {});
          return;
        }
        session = created;
        queue.advancePending(props.connectionKey, "bridge");
        try {
          frame = mountCodiumFrame(host.current, makeBootstrapUrl(props.origin, created.directory, created.bootstrapKey), (focused) => {
            if (disposed) return;
            frameFocused = focused; focusEpoch++;
            if (!setCloseProtection) {
              protection.current = true;
              panel.current.tab.setModified(true); panel.current.onProtectedChange(true);
            } else if (focused) {
              // Re-entry invalidates an already-clean bulk-close result while
              // other panels are still being checked. Our own blur must not.
              setCloseProtection(() => resolveProtection());
            }
          });
          const previous = queue.lastTargetFor(props.connectionKey) ?? restoredEditorTarget(panel.current.tab.state, props.connectionKey);
          if (!queue.peek() && previous) queue.enqueue({ requestId: newRequestId(), connectionKey: props.connectionKey, target: previous });
          setConnection({ kind: "connecting", message: "Connecting editor…" });
          schedulePoll(editorPollDelay(visibleRef.current));
        } catch {
          setConnection({ kind: "disconnected", message: "Embedded editor unavailable." });
          setError("This client could not create the embedded editor. Use Open directly to open Codium.");
        }
      } catch {
        if (!disposed) {
          setConnection({ kind: "disconnected", message: "Editor connection unavailable." });
          setError("The Paseo companion bridge could not start. Check the installed plugin and companion versions.");
        }
      }
    };
    retryAccess.current = () => { void attemptAccess(); };
    signIn.current = () => {
      try { openAccessHelper(props.origin); armReturnProbe(); }
      catch { setError("This client could not open the Codium sign-in page. Open the Codium address in a browser and sign in, then check again."); }
    };
    checkOutcome.current = () => {
      // A new token invalidates older checks for the same or a replaced request.
      const token = inspection.current.begin();
      if (!token || !session || disposed) return;
      const requestId = token.requestId;
      setOutcomeNote("Checking the retained receipt…");
      void api.current.receipt({ sessionId: session.sessionId, ownerKey: session.ownerKey, requestId }).then(({ receipt }) => {
        if (disposed || !inspection.current.accepts(token)) return;
        if (!receipt) {
          // Null/expired receipt is UNKNOWN, never not_sent and never a reason
          // to resend the file request automatically.
          setOutcomeReceipt(null);
          setOutcomeNote(describeFileOpenReceipt(null));
          return;
        }
        editorReceipts.merge(requestId, receipt);
        setOutcomeReceipt(receipt);
        setOutcomeNote(describeFileOpenReceipt(receipt));
        if (receipt.outcome === "opened") setError("");
        else if (receipt.outcome === "not_sent") setError("Codium recorded the file request as not sent. Open the file again to retry.");
        else if (receipt.outcome === "failed") setError("Codium reported that the file could not be opened.");
        else if (receipt.outcome === "uncertain") setError("The editor may have opened the file; the authoritative outcome is still unknown.");
      }).catch(() => {
        if (!disposed && inspection.current.accepts(token)) {
          setOutcomeNote("Outcome unknown. The receipt query failed; no file request was sent by this check.");
        }
      });
    };
    void attemptAccess();
    return () => {
      disposed = true; accessAttempt++; probe?.cancel(); removeReturnListeners();
      inspection.current.clear(); revealLifetime.current.abort();
      refreshPoll.current = () => {}; checkOutcome.current = () => {};
      if (timer !== undefined) clearTimeout(timer); unsubscribe(); frame?.remove();
      beforeClose.current = () => true;
      setCloseProtection?.(null); setBeforeCloseResolver(null);
      if (session) void api.current.release({ sessionId: session.sessionId, ownerKey: session.ownerKey }).catch(() => {});
      // Unmount can follow a user-approved dirty close. Never emit a fabricated clean snapshot.
    };
  }, [props.workspaceId, props.host.id, props.origin, props.connectionKey, generation, queue, setCloseProtection, setBeforeCloseResolver]);

  const reload = async () => {
    if (checking) return;
    if (accessUnconfirmed) { retryAccess.current(); return; }
    const resolve = beforeClose.current;
    setChecking(true);
    const protectedNow = await resolve();
    if (beforeClose.current !== resolve) return;
    setChecking(false);
    if (protectedNow) setConfirmReload(true); else setGeneration((value) => value + 1);
  };
  const revealCurrentFile = () => {
    const path = currentFileRef.current, reveal = panel.current.revealFile;
    if (!path || !reveal) return;
    void reveal(path, "explicit", { signal: revealLifetime.current.signal }).then((outcome) => {
      if (outcome === "revealed") setError("");
      else if (outcome === "cancelled") setError("Reveal in Files was cancelled.");
      else setError("Paseo Files could not reveal this file.");
    }, () => setError("Paseo Files could not reveal this file."));
  };
  return (
    <View style={{ flex: 1 }}>
      <EditorToolbar theme={props.theme} externalUrl={props.externalUrl} connection={connection} reconnecting={checking}
        onReconnect={() => { void reload(); }} onRevealInFiles={currentFile && props.revealFile ? revealCurrentFile : undefined}
        openSettings={props.openSettings} onError={setError} />
      {error || outcomeRequest || accessUnconfirmed || confirmReload ? <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 8, backgroundColor: colors.surface0 }}>
        {accessUnconfirmed ? <View style={{ gap: 10 }}>
          <Text testID="codium-access-unconfirmed" style={{ color: colors.foreground }}>
            Codium access is unconfirmed. Sign in to the editor, then check again. This only checks access; the editor has not been paired yet.
          </Text>
          <View style={{ flexDirection: "row", gap: 20 }}>
            <Pressable testID="codium-access-sign-in" accessibilityRole="button" onPress={() => signIn.current()}><Text style={{ color: colors.accent }}>Sign in to editor</Text></Pressable>
            <Pressable testID="codium-access-retry" accessibilityRole="button" onPress={() => retryAccess.current()}><Text style={{ color: colors.accent }}>Check again</Text></Pressable>
          </View>
        </View> : null}
        {error ? <Text style={{ color: colors.statusDanger }}>{error}</Text> : null}
        {outcomeRequest ? <View style={{ gap: 6 }}>
          <Text testID="codium-receipt-status" selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>
            {outcomeReceipt ? describeFileOpenReceipt(outcomeReceipt) : `Request ${outcomeRequest} · outcome unknown (no retained receipt)`}
          </Text>
          <Pressable testID="codium-check-outcome" accessibilityRole="button" onPress={() => checkOutcome.current()}>
            <Text style={{ color: colors.accent }}>Check outcome</Text>
          </Pressable>
          {outcomeNote ? <Text testID="codium-receipt-note" style={{ color: colors.foregroundMuted, fontSize: 12 }}>{outcomeNote}</Text> : null}
        </View> : null}
        {confirmReload ? (
          <View style={{ gap: 10 }}>
            <Text style={{ color: colors.foreground }}>Reload this editor? Unsaved changes may be lost. Its saved files remain on the host.</Text>
            <View style={{ flexDirection: "row", gap: 20 }}>
              <Pressable testID="codium-reload-cancel" accessibilityRole="button" onPress={() => setConfirmReload(false)}><Text style={{ color: colors.accent }}>Keep editing</Text></Pressable>
              <Pressable testID="codium-reload-confirm" accessibilityRole="button" onPress={() => { setConfirmReload(false); setGeneration((value) => value + 1); }}><Text style={{ color: colors.statusDanger }}>Reload anyway</Text></Pressable>
            </View>
          </View>
        ) : null}
      </View> : null}
      <View ref={host} style={{ flex: 1 }} testID="codium-frame" />
    </View>
  );
}
