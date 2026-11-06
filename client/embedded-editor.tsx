import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { createSessionRpc, openFileRpc, releaseSessionRpc, sessionStateRpc, type SessionState } from "../shared/rpc";
import { editorQueue, restoredEditorTarget, shouldProtectEditor } from "./editor-session";
import { makeBootstrapUrl, mountCodiumFrame, newRequestId } from "./web";
import { retainedTabSetter } from "./host-capabilities";

type Session = { sessionId: string; ownerKey: string; bootstrapKey: string; directory: string; protocolVersion: 1 };
const unknownState: SessionState = { connected: false, known: false, dirty: false, sequence: 0, expired: false };

export function EmbeddedEditor(props: PluginWorkspacePanelProps & { retainEditor: boolean; origin: string; connectionKey: string; onProtectedChange(value: boolean): void }) {
  const create = useRpc(createSessionRpc);
  const getState = useRpc(sessionStateRpc);
  const openFile = useRpc(openFileRpc);
  const release = useRpc(releaseSessionRpc);
  const api = useRef({ create, getState, openFile, release }); api.current = { create, getState, openFile, release };
  const panel = useRef(props); panel.current = props;
  const host = useRef<View>(null);
  const [generation, setGeneration] = useState(0);
  const [status, setStatus] = useState("Starting editor…");
  const [error, setError] = useState("");
  const [confirmReload, setConfirmReload] = useState(false);
  const protection = useRef(true);
  const state = useRef<SessionState>(unknownState);
  const queue = editorQueue(props.host.id, props.workspaceId);
  const { colors } = props.theme;
  const setRetained = retainedTabSetter(props.tab, props.retainEditor);

  useEffect(() => {
    setRetained?.(true);
    return () => setRetained?.(false);
  }, [setRetained]);

  useEffect(() => {
    let disposed = false;
    let session: Session | undefined;
    let removeFrame: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let draining = false;
    let frameFocused = false;
    let focusEpoch = 0;
    const started = Date.now();
    state.current = unknownState; protection.current = true;
    panel.current.tab.setModified(true); panel.current.onProtectedChange(true);
    setStatus("Starting editor…"); setError("");
    const protect = (next: SessionState, observedFocusEpoch = focusEpoch) => {
      state.current = next;
      // An iframe can be removed without its beforeunload firing. While it has
      // focus, editing may outrun RPC state updates; keep closure protected until
      // a fresh snapshot requested after focus leaves confirms the editor clean.
      protection.current = shouldProtectEditor(next, frameFocused, observedFocusEpoch, focusEpoch);
      panel.current.tab.setModified(protection.current);
      panel.current.onProtectedChange(protection.current);
    };
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
        setStatus(next.known ? (next.dirty ? "Connected · unsaved changes" : "Connected") :
          next.expired ? "Pairing expired. Reconnect when ready." :
          Date.now() - started > 15_000 ? "The editor has not confirmed it is ready." : "Connecting editor…");
        if (next.known) void drain();
      } catch {
        if (disposed) return;
        protect({ ...state.current, connected: false, known: false });
        setStatus("Editor connection unavailable. Unsaved state is unknown.");
      }
      if (!disposed) timer = setTimeout(() => { void poll(); }, 500);
    };
    void api.current.create({ workspaceId: props.workspaceId, clientId: newRequestId() }).then((created) => {
      if (disposed) { void api.current.release({ sessionId: created.sessionId, ownerKey: created.ownerKey }).catch(() => {}); return; }
      session = created;
      try {
        removeFrame = mountCodiumFrame(host.current, makeBootstrapUrl(props.origin, created.directory, created.bootstrapKey), (focused) => {
          if (disposed) return;
          frameFocused = focused; focusEpoch++;
          protection.current = true;
          panel.current.tab.setModified(true); panel.current.onProtectedChange(true);
        });
        const previous = queue.lastTargetFor(props.connectionKey) ?? restoredEditorTarget(panel.current.tab.state, props.connectionKey);
        if (!queue.peek() && previous) queue.enqueue({ requestId: newRequestId(), connectionKey: props.connectionKey, target: previous });
        void poll();
      } catch { setError("This client could not create the embedded editor. Open Codium in your browser."); }
    }).catch(() => { if (!disposed) { setStatus("Editor connection unavailable."); setError("The Paseo companion bridge could not start. Check the installed plugin and companion versions."); } });
    return () => {
      disposed = true; if (timer !== undefined) clearTimeout(timer); unsubscribe(); removeFrame?.();
      if (session) void api.current.release({ sessionId: session.sessionId, ownerKey: session.ownerKey }).catch(() => {});
      // Unmount can follow a user-approved dirty close. Never emit a fabricated clean snapshot.
    };
  }, [props.workspaceId, props.host.id, props.origin, props.connectionKey, generation, queue]);

  const reload = () => { if (protection.current) setConfirmReload(true); else setGeneration((value) => value + 1); };
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 8, backgroundColor: colors.surface0 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 18 }}>
          <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 12 }}>{status}</Text>
          <ExternalLink href={props.origin}><Text style={{ color: colors.accent }}>Sign in in browser</Text></ExternalLink>
          <Pressable testID="codium-reconnect" accessibilityRole="button" onPress={reload}><Text style={{ color: colors.accent }}>Reconnect</Text></Pressable>
        </View>
        {error ? <Text style={{ color: colors.statusDanger }}>{error}</Text> : null}
        {!state.current.known ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>If access needs renewing, sign in in your browser, return here and reconnect. The tab is protected while editor state is unknown.</Text> : null}
        {confirmReload ? (
          <View style={{ gap: 10 }}>
            <Text style={{ color: colors.foreground }}>Reload this editor? Unsaved changes may be lost. Its saved files remain on the host.</Text>
            <View style={{ flexDirection: "row", gap: 20 }}>
              <Pressable testID="codium-reload-cancel" accessibilityRole="button" onPress={() => setConfirmReload(false)}><Text style={{ color: colors.accent }}>Keep editing</Text></Pressable>
              <Pressable testID="codium-reload-confirm" accessibilityRole="button" onPress={() => { setConfirmReload(false); setGeneration((value) => value + 1); }}><Text style={{ color: colors.statusDanger }}>Reload anyway</Text></Pressable>
            </View>
          </View>
        ) : null}
      </View>
      <View ref={host} style={{ flex: 1 }} testID="codium-frame" />
    </View>
  );
}
