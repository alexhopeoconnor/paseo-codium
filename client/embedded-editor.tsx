import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { createSessionRpc, openFileRpc, releaseSessionRpc, sessionStateRpc, type SessionState } from "../shared/rpc";
import { editorQueue, resolveEditorCloseProtection, restoredEditorTarget, shouldProtectEditor } from "./editor-session";
import { makeBootstrapUrl, mountCodiumFrame, newRequestId, type MountedCodiumFrame } from "./web";
import { closeProtectionSetter, retainedTabSetter, type CloseProtectionResolver } from "./host-capabilities";
import { EditorToolbar, type EditorConnectionIndicator } from "./editor-toolbar";

type Session = { sessionId: string; ownerKey: string; bootstrapKey: string; directory: string; protocolVersion: 1 };
const unknownState: SessionState = { connected: false, known: false, dirty: false, sequence: 0, expired: false };

export function EmbeddedEditor(props: PluginWorkspacePanelProps & {
  retainEditor: boolean; freshCloseProtection: boolean; origin: string; connectionKey: string; externalUrl: string;
  openSettings(): void; onProtectedChange(value: boolean): void; setBeforeCloseResolver(resolver: CloseProtectionResolver | null): void;
}) {
  const create = useRpc(createSessionRpc);
  const getState = useRpc(sessionStateRpc);
  const openFile = useRpc(openFileRpc);
  const release = useRpc(releaseSessionRpc);
  const api = useRef({ create, getState, openFile, release }); api.current = { create, getState, openFile, release };
  const panel = useRef(props); panel.current = props;
  const host = useRef<View>(null);
  const [generation, setGeneration] = useState(0);
  const [connection, setConnection] = useState<EditorConnectionIndicator>({ kind: "connecting", message: "Starting editor…" });
  const [error, setError] = useState("");
  const [confirmReload, setConfirmReload] = useState(false);
  const [checking, setChecking] = useState(false);
  const beforeClose = useRef<CloseProtectionResolver>(() => true);
  const protection = useRef(true);
  const state = useRef<SessionState>(unknownState);
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
    let disposed = false;
    let session: Session | undefined;
    let frame: MountedCodiumFrame | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let draining = false;
    let frameFocused = false;
    let focusEpoch = 0;
    const started = Date.now();
    state.current = unknownState; protection.current = true;
    panel.current.tab.setModified(true); panel.current.onProtectedChange(true);
    setConnection({ kind: "connecting", message: "Starting editor…" }); setError(""); setChecking(false);
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
        return await resolveEditorCloseProtection(
          () => api.current.getState({ sessionId: requestedSession.sessionId, ownerKey: requestedSession.ownerKey }),
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
    const drain = async () => {
      if (draining || disposed || !session || !state.current.known) return;
      draining = true;
      try {
        let request;
        while (!disposed && state.current.known && (request = queue.peekForConnection(props.connectionKey))) {
          try {
            await api.current.openFile({ sessionId: session.sessionId, ownerKey: session.ownerKey, requestId: request.requestId, target: request.target });
            if (disposed) return;
            queue.complete(request.requestId, props.connectionKey, true);
            panel.current.tab.setState({ connectionKey: props.connectionKey, lastTarget: JSON.parse(JSON.stringify(request.target)) });
            queue.takeExpiredNotice();
            setError("");
          } catch {
            if (!disposed) { queue.complete(request.requestId, props.connectionKey, false); setError("Codium could not confirm opening the file. Check the editor connection, then open the file again from the explorer, search or original link."); }
            break;
          }
        }
      } finally { draining = false; }
    };
    const unsubscribe = queue.subscribe(() => { void drain(); });
    const poll = async () => {
      if (disposed || !session) return;
      if (queue.takeExpiredNotice()) setError("A pending file request expired after five minutes. Open the file again from the explorer, search or original link.");
      try {
        const observedFocusEpoch = focusEpoch;
        const next = await api.current.getState({ sessionId: session.sessionId, ownerKey: session.ownerKey });
        if (disposed) return;
        if (next.sequence >= state.current.sequence) protect(next, observedFocusEpoch);
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
      }
      if (!disposed) timer = setTimeout(() => { void poll(); }, 500);
    };
    void api.current.create({ workspaceId: props.workspaceId, clientId: newRequestId() }).then((created) => {
      if (disposed) { void api.current.release({ sessionId: created.sessionId, ownerKey: created.ownerKey }).catch(() => {}); return; }
      session = created;
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
        void poll();
      } catch { setConnection({ kind: "disconnected", message: "Embedded editor unavailable." }); setError("This client could not create the embedded editor. Use Open directly to open Codium."); }
    }).catch(() => { if (!disposed) { setConnection({ kind: "disconnected", message: "Editor connection unavailable." }); setError("The Paseo companion bridge could not start. Check the installed plugin and companion versions."); } });
    return () => {
      disposed = true; if (timer !== undefined) clearTimeout(timer); unsubscribe(); frame?.remove();
      beforeClose.current = () => true;
      setCloseProtection?.(null); setBeforeCloseResolver(null);
      if (session) void api.current.release({ sessionId: session.sessionId, ownerKey: session.ownerKey }).catch(() => {});
      // Unmount can follow a user-approved dirty close. Never emit a fabricated clean snapshot.
    };
  }, [props.workspaceId, props.host.id, props.origin, props.connectionKey, generation, queue, setCloseProtection, setBeforeCloseResolver]);

  const reload = async () => {
    if (checking) return;
    const resolve = beforeClose.current;
    setChecking(true);
    const protectedNow = await resolve();
    if (beforeClose.current !== resolve) return;
    setChecking(false);
    if (protectedNow) setConfirmReload(true); else setGeneration((value) => value + 1);
  };
  return (
    <View style={{ flex: 1 }}>
      <EditorToolbar theme={props.theme} externalUrl={props.externalUrl} connection={connection} reconnecting={checking}
        onReconnect={() => { void reload(); }} openSettings={props.openSettings} onError={setError} />
      {error || confirmReload ? <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 8, backgroundColor: colors.surface0 }}>
        {error ? <Text style={{ color: colors.statusDanger }}>{error}</Text> : null}
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
