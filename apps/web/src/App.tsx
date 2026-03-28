import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Edge,
  Handle,
  MarkerType,
  Node,
  NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useOnViewportChange,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, LoaderCircle } from "lucide-react";
import {
  DaemonDiagnostics,
  CreateBranchInput,
  CreateBranchTurnInput,
  CreateNetInput,
  CreateRootTurnInput,
  GraphSnapshot,
  MachineRecord,
  MessageNode,
  UiConfig,
  WorkspaceState,
  rootBranchId,
} from "@netchat/shared";
import { create } from "zustand";

import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { cn } from "./lib/cn";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
const messageNodeWidth = 420;
const branchLaneWidth = 620;
const branchMessageGap = 96;
const branchForkGap = 92;
const bubbleComposerGap = 20;
const bubbleComposerWidth = 560;
const messageEstimateCharsPerLine = 30;
const messageEstimateLineHeight = 34;
const webLogPrefix = "[netchat-web]";

type SelectionDraft = {
  sourceMessageId: string;
  selectedText: string;
  startOffset: number;
  endOffset: number;
};

type ComposerAnchor = {
  left: number;
  top: number;
  width: number;
};

type BubbleComposerMode =
  | "root"
  | "continue-root"
  | "continue-branch"
  | "branch-from-message"
  | "branch-from-selection";

type MessageNodeData = {
  message: MessageNode;
  isActiveMessage: boolean;
  hasSelectionDraft: boolean;
  showSessionId: boolean;
  sessionLabelSide: "left" | "right";
  onMeasureHeight: (messageId: string, height: number) => void;
  onPickMessage: (messageId: string) => void;
  onSelectionDraft: (draft: SelectionDraft) => void;
};

const useComposerStore = create<{
  selectedMessageId: string | null;
  setSelectedMessageId: (messageId: string | null) => void;
}>((set) => ({
  selectedMessageId: null,
  setSelectedMessageId: (selectedMessageId) => set({ selectedMessageId }),
}));

export default function App() {
  return (
    <ReactFlowProvider>
      <NetchatApp />
    </ReactFlowProvider>
  );
}

function NetchatApp() {
  const queryClient = useQueryClient();
  const reactFlow = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const lastAutoSelectedMessageIdRef = useRef<string | null>(null);
  const selectedMessageId = useComposerStore((state) => state.selectedMessageId);
  const setSelectedMessageId = useComposerStore((state) => state.setSelectedMessageId);
  const [composerValue, setComposerValue] = useState("");
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(null);
  const [composerAnchor, setComposerAnchor] = useState<ComposerAnchor | null>(null);
  const [measuredNodeHeights, setMeasuredNodeHeights] = useState<Record<string, number>>({});
  const [showNetHistory, setShowNetHistory] = useState(false);
  const [showRuntimeDetails, setShowRuntimeDetails] = useState(false);

  const workspaceQuery = useQuery({
    queryKey: ["workspace"],
    queryFn: () => request<WorkspaceState>("/api/workspace"),
  });
  const graphQuery = useQuery({
    queryKey: ["graph"],
    queryFn: () => request<GraphSnapshot>("/api/graph"),
  });
  const uiConfigQuery = useQuery({
    queryKey: ["ui-config"],
    queryFn: () => request<UiConfig>("/api/ui-config"),
  });
  const machinesQuery = useQuery({
    queryKey: ["machines"],
    queryFn: () => request<MachineRecord[]>("/api/machines"),
    refetchInterval: 15000,
  });
  const daemonDiagnosticsQuery = useQuery({
    queryKey: ["daemon-diagnostics"],
    queryFn: () => request<DaemonDiagnostics>("/api/runtime/diagnostics"),
    refetchInterval: 2500,
    retry: false,
  });

  const workspace = workspaceQuery.data;
  const snapshot = graphQuery.data;
  const uiConfig = uiConfigQuery.data;
  const machines = machinesQuery.data ?? [];
  const onlineMachines = machines.filter((machine) => machine.status === "online");
  const daemonDiagnostics = daemonDiagnosticsQuery.data;
  const workspaceNets = workspace?.nets ?? [];
  const activeNetId = workspace?.activeNetId ?? null;
  const activeNet = workspaceNets.find((net) => net.id === activeNetId) ?? null;
  const machinesById = useMemo(() => new Map(machines.map((machine) => [machine.id, machine])), [machines]);
  const rootMachine = onlineMachines[0];
  const branchesById = useMemo(
    () => new Map((snapshot?.branches ?? []).map((branch) => [branch.id, branch])),
    [snapshot],
  );

  const messagesByBranch = useMemo(() => {
    const buckets = new Map<string, MessageNode[]>();
    for (const message of snapshot?.messages ?? []) {
      const branchMessages = buckets.get(message.branchId) ?? [];
      branchMessages.push(message);
      buckets.set(message.branchId, branchMessages);
    }
    return buckets;
  }, [snapshot]);

  const messagesById = useMemo(
    () => new Map((snapshot?.messages ?? []).map((message) => [message.id, message])),
    [snapshot],
  );
  const selectedMessage =
    selectedMessageId && messagesById.get(selectedMessageId)?.role === "assistant"
      ? (messagesById.get(selectedMessageId) ?? null)
      : null;
  const selectedBranch = selectedMessage ? (branchesById.get(selectedMessage.branchId) ?? null) : null;
  const selectedBranchMessages = selectedMessage ? messagesByBranch.get(selectedMessage.branchId) ?? [] : [];
  const selectionForSelectedMessage =
    selectedMessage && selectionDraft?.sourceMessageId === selectedMessage.id ? selectionDraft : null;
  const selectedMessageIsTail = selectedMessage
    ? selectedBranchMessages.at(-1)?.id === selectedMessage.id
    : true;
  const selectedBranchMachine =
    selectedBranch?.machineId ? (machinesById.get(selectedBranch.machineId) ?? undefined) : undefined;
  const selectedMessageMachine =
    selectedMessage?.machineId ? (machinesById.get(selectedMessage.machineId) ?? undefined) : undefined;
  const sendMode: BubbleComposerMode =
    !selectedMessage
      ? "root"
      : !selectedMessageIsTail
        ? selectionForSelectedMessage
          ? "branch-from-selection"
          : "branch-from-message"
        : selectedBranch?.id === rootBranchId
          ? "continue-root"
          : "continue-branch";
  const runtimeMachine =
    sendMode === "branch-from-message" || sendMode === "branch-from-selection"
      ? selectedMessageMachine
      : sendMode === "continue-branch"
        ? selectedBranchMachine ?? selectedMessageMachine
        : rootMachine;
  const canSendOnActiveLane =
    sendMode === "branch-from-message" ||
    sendMode === "branch-from-selection" ||
    sendMode === "continue-branch"
      ? runtimeMachine
        ? runtimeMachine.status === "online"
        : true
      : Boolean(rootMachine);

  const rootTurnMutation = useMutation({
    mutationFn: async (input: CreateRootTurnInput) => {
      logWeb(
        "info",
        `Sending root turn (${input.prompt.length} chars) to ${input.machineId ?? "auto-selected machine"}.`,
      );
      return request<GraphSnapshot>("/api/root-turn", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    onSuccess: async (nextSnapshot) => {
      logWeb(
        "info",
        `Root turn completed. Graph now has ${nextSnapshot.messages.length} messages across ${nextSnapshot.branches.length} branches.`,
      );
      queryClient.setQueryData(["graph"], nextSnapshot);
      setComposerValue("");
      setSelectionDraft(null);
      setSelectedMessageId(getLatestAssistantMessageId(nextSnapshot));
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
    },
    onError: (error) => {
      logWeb("error", `Root turn failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
    },
  });

  const branchMutation = useMutation({
    mutationFn: async (input: CreateBranchInput) => {
      logWeb(
        "info",
        input.mode === "message"
          ? `Branching from bubble ${input.sourceMessageId} with ${input.prompt.length} prompt chars.`
          : `Branching from message ${input.sourceMessageId} with ${(input.selectedText ?? "").length} selected chars and ${input.prompt.length} prompt chars.`,
      );
      return request<GraphSnapshot>("/api/branches", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    onSuccess: async (nextSnapshot) => {
      logWeb(
        "info",
        `Branch creation completed. Graph now has ${nextSnapshot.branches.length} branches.`,
      );
      queryClient.setQueryData(["graph"], nextSnapshot);
      setComposerValue("");
      setSelectionDraft(null);
      setSelectedMessageId(getLatestAssistantMessageId(nextSnapshot));
      clearBrowserSelection();
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
    },
    onError: (error) => {
      logWeb("error", `Branch creation failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
    },
  });

  const branchTurnMutation = useMutation({
    mutationFn: async (variables: { branchId: string; input: CreateBranchTurnInput }) => {
      logWeb(
        "info",
        `Sending branch turn for ${variables.branchId} (${variables.input.prompt.length} chars).`,
      );
      return request<GraphSnapshot>(`/api/branches/${variables.branchId}/turns`, {
        method: "POST",
        body: JSON.stringify(variables.input),
      });
    },
    onSuccess: async (nextSnapshot) => {
      logWeb(
        "info",
        `Branch turn completed. Graph now has ${nextSnapshot.messages.length} messages.`,
      );
      queryClient.setQueryData(["graph"], nextSnapshot);
      setComposerValue("");
      setSelectionDraft(null);
      setSelectedMessageId(getLatestAssistantMessageId(nextSnapshot));
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
    },
    onError: (error) => {
      logWeb("error", `Branch turn failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
    },
  });
  const createNetMutation = useMutation({
    mutationFn: async (input: CreateNetInput) => {
      logWeb("info", `Creating a new net for workspace ${workspace?.workspaceId ?? "active"}.`);
      return request<WorkspaceState>("/api/nets", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    onSuccess: async (nextWorkspace) => {
      logWeb("info", `Created net ${nextWorkspace.activeNetId}.`);
      queryClient.setQueryData(["workspace"], nextWorkspace);
      setComposerValue("");
      setSelectionDraft(null);
      setSelectedMessageId(null);
      clearBrowserSelection();
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
    onError: (error) => {
      logWeb("error", `Creating a new net failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
    },
  });
  const selectNetMutation = useMutation({
    mutationFn: async (netId: string) => {
      logWeb("info", `Switching to net ${netId}.`);
      return request<WorkspaceState>(`/api/nets/${netId}/select`, {
        method: "POST",
      });
    },
    onSuccess: async (nextWorkspace) => {
      logWeb("info", `Switched to net ${nextWorkspace.activeNetId}.`);
      queryClient.setQueryData(["workspace"], nextWorkspace);
      setComposerValue("");
      setSelectionDraft(null);
      setSelectedMessageId(null);
      clearBrowserSelection();
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
    onError: (error) => {
      logWeb("error", `Switching nets failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
    },
  });
  const isThinking =
    rootTurnMutation.isPending || branchMutation.isPending || branchTurnMutation.isPending;

  function focusComposer() {
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
  }

  const syncBubbleComposerAnchor = useCallback(() => {
    if (!selectedMessage) {
      setComposerAnchor(null);
      return;
    }

    const nodeElement = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${selectedMessage.id}"]`);
    if (!nodeElement) {
      setComposerAnchor(null);
      return;
    }

    const rect = nodeElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const composerWidth = Math.min(bubbleComposerWidth, Math.max(320, viewportWidth - 32));
    const maxTop = Math.max(16, viewportHeight - 320);

    setComposerAnchor({
      left: clamp(rect.left + rect.width / 2 - composerWidth / 2, 16, viewportWidth - composerWidth - 16),
      top: clamp(rect.bottom + bubbleComposerGap, 16, maxTop),
      width: composerWidth,
    });
  }, [selectedMessage]);

  function pickMessage(messageId: string) {
    setSelectedMessageId(messageId);
    setSelectionDraft(null);
    focusComposer();
  }

  function applySelectionDraft(draft: SelectionDraft) {
    setSelectedMessageId(draft.sourceMessageId);
    setSelectionDraft(draft);
    focusComposer();
  }

  const reportMessageNodeHeight = useCallback((messageId: string, height: number) => {
    const normalizedHeight = Math.max(170, Math.ceil(height));
    setMeasuredNodeHeights((current) =>
      current[messageId] === normalizedHeight
        ? current
        : {
            ...current,
            [messageId]: normalizedHeight,
          },
    );
  }, []);

  const graph = useMemo(() => {
    if (!snapshot) {
      return { nodes: [], edges: [] };
    }

    return buildFlowGraph({
      snapshot,
      selectedMessageId,
      onPickMessage: pickMessage,
      selectionDraft,
      measuredNodeHeights,
      onMeasureHeight: reportMessageNodeHeight,
      onSelectionDraft: applySelectionDraft,
      showSessionIds: uiConfig?.showSessionIds ?? false,
    });
  }, [measuredNodeHeights, reportMessageNodeHeight, selectedMessageId, selectionDraft, snapshot, uiConfig?.showSessionIds]);

  useOnViewportChange({
    onChange: syncBubbleComposerAnchor,
    onEnd: syncBubbleComposerAnchor,
  });

  useEffect(() => {
    if (!snapshot || snapshot.messages.length === 0 || !nodesInitialized) {
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;

    const frame = window.requestAnimationFrame(() => {
      timeoutId = window.setTimeout(() => {
        if (cancelled) {
          return;
        }

        void reactFlow.fitView({
          padding: 0.18,
          duration: 520,
          minZoom: 0.34,
          maxZoom: 1.1,
        });
      }, 80);
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    measuredNodeHeights,
    nodesInitialized,
    reactFlow,
    snapshot?.branches.length,
    snapshot?.edges.length,
    snapshot?.messages.length,
  ]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    const latestAssistantMessageId = getLatestAssistantMessageId(snapshot);

    if (
      !selectedMessageId &&
      latestAssistantMessageId &&
      latestAssistantMessageId !== lastAutoSelectedMessageIdRef.current
    ) {
      lastAutoSelectedMessageIdRef.current = latestAssistantMessageId;
      setSelectedMessageId(latestAssistantMessageId);
      return;
    }

    if (
      selectedMessageId &&
      snapshot.messages.some((message) => message.id === selectedMessageId && message.role === "assistant")
    ) {
      return;
    }

    if (!latestAssistantMessageId) {
      lastAutoSelectedMessageIdRef.current = null;
    }

    if (selectedMessageId !== null) {
      setSelectedMessageId(null);
    }
    setSelectionDraft(null);
  }, [selectedMessageId, setSelectedMessageId, snapshot]);

  useEffect(() => {
    if (!snapshot) {
      setMeasuredNodeHeights({});
      return;
    }

    const liveMessageIds = new Set(snapshot.messages.map((message) => message.id));
    setMeasuredNodeHeights((current) => {
      let changed = false;
      const next: Record<string, number> = {};

      for (const [messageId, height] of Object.entries(current)) {
        if (liveMessageIds.has(messageId)) {
          next[messageId] = height;
          continue;
        }

        changed = true;
      }

      return changed ? next : current;
    });
  }, [snapshot]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectedMessageId(null);
        setSelectionDraft(null);
        clearBrowserSelection();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [setSelectedMessageId]);

  useEffect(() => {
    if (selectionDraft && selectionDraft.sourceMessageId !== selectedMessageId) {
      setSelectionDraft(null);
    }
  }, [selectedMessageId, selectionDraft]);

  useEffect(() => {
    if (!selectedMessage) {
      setComposerAnchor(null);
      return;
    }

    const frame = window.requestAnimationFrame(syncBubbleComposerAnchor);
    window.addEventListener("resize", syncBubbleComposerAnchor);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", syncBubbleComposerAnchor);
    };
  }, [selectedMessage, syncBubbleComposerAnchor]);

  const isSwitchingNet = createNetMutation.isPending || selectNetMutation.isPending;
  const hasMessages = Boolean(snapshot && snapshot.messages.length > 0);
  const showBubbleComposer = Boolean(selectedMessage && composerAnchor);
  const sendDisabled = composerValue.trim().length === 0 || isThinking || isSwitchingNet || !canSendOnActiveLane;

  function submitCurrentPrompt() {
    const prompt = composerValue.trim();
    if (prompt.length === 0) {
      return;
    }

    if (sendMode === "root" || sendMode === "continue-root") {
      rootTurnMutation.mutate({
        prompt,
        machineId: rootMachine?.id,
        selectedText: selectionForSelectedMessage?.selectedText,
      });
      return;
    }

    if (sendMode === "continue-branch" && selectedBranch) {
      branchTurnMutation.mutate({
        branchId: selectedBranch.id,
        input: {
          prompt,
          selectedText: selectionForSelectedMessage?.selectedText,
        },
      });
      return;
    }

    if (sendMode === "branch-from-selection" && selectedMessage && selectionForSelectedMessage) {
      branchMutation.mutate({
        sourceMessageId: selectedMessage.id,
        mode: "selection",
        selectedText: selectionForSelectedMessage.selectedText,
        startOffset: selectionForSelectedMessage.startOffset,
        endOffset: selectionForSelectedMessage.endOffset,
        prompt,
      });
      return;
    }

    if (sendMode === "branch-from-message" && selectedMessage) {
      branchMutation.mutate({
        sourceMessageId: selectedMessage.id,
        mode: "message",
        prompt,
      });
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    submitCurrentPrompt();
  }

  const connectionStatus = buildConnectionStatus(runtimeMachine, daemonDiagnostics, daemonDiagnosticsQuery.error);
  const workingDirectoryValue =
    workspace?.workingDirectory ??
    runtimeMachine?.environment.workingDirectory ??
    daemonDiagnostics?.environment.workingDirectory ??
    null;
  const workingDirectoryPath = formatWorkingDirectoryPath(workingDirectoryValue);
  const workingDirectoryDisplay = truncateMiddle(workingDirectoryPath, 44);
  const workspaceName = resolveWorkspaceName(workingDirectoryPath);
  const runtimeLabel = resolveRuntimeLabel(runtimeMachine, daemonDiagnostics);
  const composerHint = selectedMessage
    ? runtimeMachine && runtimeMachine.status !== "online"
      ? "Reconnect the local runtime to send from this bubble."
      : selectionForSelectedMessage
        ? selectedMessageIsTail
          ? "You are continuing from a highlighted passage in this reply."
          : "You are branching from a highlighted passage in this reply."
      : sendMode === "branch-from-message"
        ? "Next message creates a new branch."
        : "Next message continues this branch."
    : rootMachine
      ? "Your next message starts the main branch."
      : "Bring one local runtime online to start chatting.";
  const composerPlaceholder = selectedMessage
    ? selectionForSelectedMessage
      ? "Ask about the selected text in this context..."
      : sendMode === "branch-from-message"
        ? "Start a branch from this reply..."
        : "Continue from this reply..."
    : "Start the first turn...";
  const composerMetaLabel =
    selectionForSelectedMessage
      ? "Selected passage"
      : sendMode === "branch-from-message"
        ? "New branch"
      : selectedMessage
        ? "Continue lane"
        : "Main canvas";
  const composerErrorMessage = formatErrorMessage(
    rootTurnMutation.error ??
      branchMutation.error ??
      branchTurnMutation.error ??
      createNetMutation.error ??
      selectNetMutation.error,
  );
  const branchCount = snapshot?.branches.length ?? 0;
  const messageCount = snapshot?.messages.length ?? 0;
  const netCount = workspaceNets.length;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--bg-cream)] text-[var(--text-main)]">
      <div className="relative flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-[linear-gradient(180deg,rgba(244,241,234,0.92)_0%,rgba(244,241,234,0)_100%)]" />

        <div className="pointer-events-none absolute right-6 top-6 z-20 flex flex-col items-end gap-3">
          <button
            type="button"
            className="pointer-events-auto w-[min(320px,calc(100vw-3rem))] border border-[var(--text-main)] bg-[var(--block-slate)] px-5 py-4 text-left text-white shadow-[10px_10px_0_rgba(26,26,26,0.1)] transition-transform hover:-translate-y-0.5"
            onClick={() => setShowRuntimeDetails((open) => !open)}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="editorial-meta text-white/62">Runtime</div>
                <div className="mt-3 flex items-center gap-3">
                  <span
                    className={cn(
                      "inline-flex h-3 w-3 border border-white/65",
                      connectionStatus.tone === "connected"
                        ? "bg-[var(--block-green)]"
                        : connectionStatus.tone === "connecting"
                          ? "animate-pulse bg-[var(--block-ochre)]"
                          : "bg-white/35",
                    )}
                  />
                  <div className="min-w-0">
                    <div className="text-[22px] font-medium leading-none text-white">{connectionStatus.label}</div>
                    <div className="mt-2 text-[12px] uppercase tracking-[0.16em] text-white/72">
                      {runtimeLabel}
                    </div>
                  </div>
                </div>
              </div>

              <div className="max-w-[120px] text-right">
                <div className="editorial-meta text-white/62">Workspace</div>
                <div className="mt-3 break-words text-[15px] leading-6 text-white/88">{workspaceName}</div>
              </div>
            </div>
          </button>

          {showRuntimeDetails ? (
            <div className="pointer-events-auto w-[min(320px,calc(100vw-3rem))] border border-[var(--text-main)] bg-white shadow-[10px_10px_0_rgba(26,26,26,0.08)]">
              <div className="border-b border-[var(--node-border)] px-5 py-4">
                <div className="editorial-meta text-[rgba(26,26,26,0.48)]">Local runtime</div>
                <div className="mt-3 text-[17px] font-medium text-[var(--text-main)]">{runtimeLabel}</div>
              </div>
              <div className="border-b border-[var(--node-border)] px-5 py-4">
                <div className="editorial-meta text-[rgba(26,26,26,0.48)]">Status</div>
                <div className="mt-2 text-[15px] leading-7 text-[var(--text-main)]">{connectionStatus.label}</div>
              </div>
              <div className="border-b border-[var(--node-border)] px-5 py-4">
                <div className="editorial-meta text-[rgba(26,26,26,0.48)]">Workspace</div>
                <div className="mt-2 font-mono text-[12px] leading-6 text-[rgba(26,26,26,0.72)]" title={workingDirectoryPath}>
                  {workingDirectoryDisplay}
                </div>
              </div>
              <div className="px-5 py-4">
                <div className="editorial-meta text-[rgba(26,26,26,0.48)]">Engine</div>
                <div className="mt-2 text-[15px] leading-7 text-[var(--text-main)]">{runtimeLabel}</div>
              </div>
            </div>
          ) : null}

          <div className="pointer-events-auto w-[min(320px,calc(100vw-3rem))] border border-[var(--text-main)] bg-white shadow-[10px_10px_0_rgba(26,26,26,0.08)]">
            <div className="border-b border-[var(--node-border)] px-5 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="editorial-meta text-[rgba(26,26,26,0.48)]">Active net</div>
                  <div className="mt-3 text-[18px] font-medium leading-7 text-[var(--text-main)]">
                    {activeNet?.title ?? "Loading..."}
                  </div>
                  <div className="mt-2 text-[11px] uppercase tracking-[0.16em] text-[rgba(26,26,26,0.52)]">
                    {netCount} nets in this workspace
                  </div>
                </div>

                <div className="max-w-[112px] text-right">
                  <div className="editorial-meta text-[rgba(26,26,26,0.48)]">Scoped to</div>
                  <div className="mt-3 break-words text-[15px] leading-6 text-[rgba(26,26,26,0.8)]">
                    {workspaceName}
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-px bg-[var(--node-border)]">
              <button
                type="button"
                className="bg-white px-5 py-4 text-left text-[13px] font-medium uppercase tracking-[0.14em] text-[var(--text-main)] transition-colors hover:bg-[var(--bg-cream)] disabled:cursor-not-allowed disabled:text-[rgba(26,26,26,0.38)]"
                disabled={workspaceQuery.isLoading}
                onClick={() => setShowNetHistory((open) => !open)}
              >
                {showNetHistory ? "Hide history" : "History nets"}
              </button>
              <button
                type="button"
                className="bg-white px-5 py-4 text-left text-[13px] font-medium uppercase tracking-[0.14em] text-[var(--text-main)] transition-colors hover:bg-[var(--bg-cream)] disabled:cursor-not-allowed disabled:text-[rgba(26,26,26,0.38)]"
                disabled={isSwitchingNet || workspaceQuery.isLoading}
                onClick={() => createNetMutation.mutate({ title: "" })}
              >
                {createNetMutation.isPending ? "Creating..." : "New net"}
              </button>
            </div>
          </div>

          {showNetHistory ? (
            <div className="pointer-events-auto w-[min(320px,calc(100vw-3rem))] border border-[var(--text-main)] bg-white shadow-[10px_10px_0_rgba(26,26,26,0.08)]">
              <div className="border-b border-[var(--node-border)] px-5 py-4">
                <div className="editorial-meta text-[rgba(26,26,26,0.48)]">History nets</div>
                <div className="mt-2 text-[14px] leading-6 text-[rgba(26,26,26,0.76)]">
                  Only nets from this workspace appear here.
                </div>
              </div>

              <div className="max-h-[360px] overflow-y-auto">
                {workspaceQuery.isLoading ? (
                  <div className="px-5 py-5 text-[14px] leading-6 text-[rgba(26,26,26,0.62)]">
                    Loading workspace nets...
                  </div>
                ) : workspaceNets.length ? (
                  workspaceNets.map((net) => {
                    const isActiveNet = net.id === activeNetId;
                    return (
                      <button
                        key={net.id}
                        type="button"
                        className={cn(
                          "block w-full border-b border-[var(--node-border)] px-5 py-4 text-left transition-colors last:border-b-0",
                          isActiveNet ? "bg-[rgba(247,247,242,0.92)]" : "bg-white hover:bg-[var(--bg-cream)]",
                        )}
                        disabled={isSwitchingNet || isActiveNet}
                        onClick={() => selectNetMutation.mutate(net.id)}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-[15px] font-medium leading-6 text-[var(--text-main)]">
                              {net.title}
                            </div>
                            <div className="mt-2 text-[11px] uppercase tracking-[0.14em] text-[rgba(26,26,26,0.5)]">
                              Opened {formatNetTime(net.lastOpenedAt)}
                            </div>
                            <div className="mt-1 text-[12px] leading-5 text-[rgba(26,26,26,0.58)]">
                              Created {formatNetTime(net.createdAt)}
                            </div>
                          </div>

                          <div className="text-right">
                            <div className="editorial-meta text-[rgba(26,26,26,0.42)]">
                              {isActiveNet ? "Current" : "Switch"}
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })
                ) : (
                  <div className="px-5 py-5 text-[14px] leading-6 text-[rgba(26,26,26,0.62)]">
                    This workspace does not have any saved nets yet.
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>

        <ReactFlow
          className="netchat-flow canvas-flow h-full w-full bg-[var(--bg-cream)]"
          fitView
          fitViewOptions={{ padding: 0.18, minZoom: 0.34, maxZoom: 1.1 }}
          nodes={graph.nodes}
          edges={graph.edges}
          onNodeClick={(_event, node) => {
            const selectedText = window.getSelection()?.toString().trim();
            const message = (node.data as MessageNodeData | undefined)?.message;
            if (message?.role === "assistant" && !selectedText) {
              pickMessage(node.id);
            }
          }}
          nodeTypes={{
            message: MessageGraphNode,
          }}
          minZoom={0.35}
          maxZoom={1.45}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          onPaneClick={() => {
            setSelectedMessageId(null);
            setSelectionDraft(null);
            clearBrowserSelection();
          }}
          panOnDrag
          zoomOnDoubleClick={false}
        >
          <Background gap={96} size={1} color="var(--line-color)" />
        </ReactFlow>

        {graphQuery.isLoading ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4">
            <div className="border border-[var(--text-main)] bg-white px-6 py-4 text-sm uppercase tracking-[0.16em] text-[rgba(26,26,26,0.62)] shadow-[8px_8px_0_rgba(26,26,26,0.08)]">
              Loading conversation canvas...
            </div>
          </div>
        ) : null}

        {!graphQuery.isLoading && !hasMessages ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6 py-8">
            <form
              className="pointer-events-auto w-full max-w-[880px] border border-[var(--text-main)] bg-white shadow-[14px_14px_0_rgba(26,26,26,0.08)]"
              onSubmit={handleSubmit}
            >
              <div className="grid md:grid-cols-[minmax(0,1.2fr)_280px]">
                <div className="border-b border-[var(--node-border)] px-8 py-8 md:border-b-0 md:border-r">
                  <div className="editorial-meta text-[rgba(26,26,26,0.48)]">Start here</div>
                  <h1
                    className="mt-4 max-w-[12ch] text-4xl leading-[1.03] tracking-[-0.05em] text-[var(--text-main)]"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    Turn one prompt into a branchable canvas.
                  </h1>
                  <p className="mt-5 max-w-[56ch] text-[16px] leading-8 text-[rgba(26,26,26,0.8)]">
                    Conversations read like an editorial layout instead of a chat feed. Click Claude replies or
                    highlight a passage later to open new lanes from the exact point you want to explore.
                  </p>
                </div>

                <div className="bg-[var(--block-slate)] px-6 py-8 text-white">
                  <div className="editorial-meta text-white/58">Current issue</div>
                  <div className="mt-4 text-[26px] leading-[1.08] tracking-[-0.03em]" style={{ fontFamily: "var(--font-display)" }}>
                    Local-first branching.
                  </div>
                  <div className="mt-5 space-y-4 text-[15px] leading-8 text-white/82">
                    <p>{netCount} nets available in this workspace.</p>
                    <p>{branchCount} branches archived on the canvas.</p>
                    <p>{messageCount} messages currently mapped.</p>
                    <p>The active machine determines where the next lane is written.</p>
                  </div>
                </div>
              </div>

              <div className="border-t border-[var(--text-main)] bg-[var(--block-ochre)] px-8 py-7 text-white">
                <div className="editorial-meta text-white/72">{composerMetaLabel}</div>
                <div className="relative mt-4">
                  <Textarea
                    ref={composerRef}
                    className="!min-h-[152px] resize-none !rounded-none !border-0 !bg-transparent !px-0 !py-0 !pb-14 !pr-24 text-[17px] font-medium leading-9 text-white shadow-none placeholder:text-white focus-visible:ring-0"
                    placeholder={composerPlaceholder}
                    value={composerValue}
                    onChange={(event) => setComposerValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        if (!sendDisabled) {
                          submitCurrentPrompt();
                        }
                      }
                    }}
                  />
                  <div className="pointer-events-none absolute bottom-0 left-0 flex max-w-[calc(100%-6rem)] items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-white/68">
                    <span>{composerMetaLabel}</span>
                    <span className="inline-flex h-px w-6 bg-white/36" />
                    <span className="truncate">{composerHint}</span>
                  </div>
                  <Button
                    className="absolute bottom-0 right-0 h-12 w-12 rounded-none border border-white bg-white px-0 text-[var(--block-ochre)] shadow-none hover:bg-[var(--bg-cream)] hover:text-[var(--block-slate)]"
                    disabled={sendDisabled}
                    type="submit"
                  >
                    {isThinking ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <ArrowUp className="size-4" />
                    )}
                  </Button>
                </div>
              </div>

              {composerErrorMessage ? (
                <div className="border-t border-rose-200 bg-rose-50 px-8 py-4 text-sm leading-6 text-rose-700">
                  {composerErrorMessage}
                </div>
              ) : null}
            </form>
          </div>
        ) : null}

        {hasMessages && !showBubbleComposer ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center px-6">
            <div className="border border-[var(--text-main)] bg-white px-4 py-3 text-[11px] uppercase tracking-[0.18em] text-[rgba(26,26,26,0.62)] shadow-[8px_8px_0_rgba(26,26,26,0.06)]">
              Click a Claude block or select a passage to continue from that exact context.
            </div>
          </div>
        ) : null}

        {showBubbleComposer ? (
          <div className="pointer-events-none fixed inset-0 z-30">
            <form
              className="pointer-events-auto fixed border border-[var(--text-main)] bg-[var(--block-ochre)] text-white shadow-[14px_14px_0_rgba(26,26,26,0.12)]"
              style={{
                left: composerAnchor?.left,
                top: composerAnchor?.top,
                width: composerAnchor?.width,
              }}
              onSubmit={handleSubmit}
            >
              {selectionForSelectedMessage ? (
                <div className="border-b border-white/24 px-6 py-4">
                  <div className="break-words text-[15px] font-medium leading-8 text-white">
                    {truncate(selectionForSelectedMessage.selectedText, 160)}
                  </div>
                </div>
              ) : null}

              <div className="relative px-6 py-5">
                <Textarea
                  ref={composerRef}
                  className="!min-h-[126px] resize-none !rounded-none !border-0 !bg-transparent !px-0 !py-0 !pb-4 !pr-20 text-[17px] font-medium leading-9 text-white shadow-none placeholder:text-white focus-visible:ring-0"
                  placeholder={composerPlaceholder}
                  value={composerValue}
                  onChange={(event) => setComposerValue(event.target.value)}
                  onFocus={() => clearBrowserSelection()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      if (!sendDisabled) {
                        submitCurrentPrompt();
                      }
                    }
                  }}
                />
                <Button
                  className="absolute bottom-0 right-0 h-12 w-12 rounded-none border border-white bg-white px-0 text-[var(--block-ochre)] shadow-none hover:bg-[var(--bg-cream)] hover:text-[var(--block-slate)]"
                  disabled={sendDisabled}
                  type="submit"
                >
                  {isThinking ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <ArrowUp className="size-4" />
                  )}
                </Button>
              </div>

              {composerErrorMessage ? (
                <div className="border-t border-white/24 bg-[rgba(58,64,66,0.18)] px-6 py-4 text-sm leading-6 text-white">
                  {composerErrorMessage}
                </div>
              ) : null}
            </form>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MessageGraphNode({ data }: NodeProps<Node<MessageNodeData>>) {
  const isUser = data.message.role === "user";
  const roleLabel = isUser ? "User" : "Claude";
  const bubbleRef = useRef<HTMLDivElement>(null);
  const sessionIdLabel = data.message.sessionId ?? "pending";

  useEffect(() => {
    const bubbleElement = bubbleRef.current;
    if (!bubbleElement) {
      return;
    }

    const reportHeight = () => {
      data.onMeasureHeight(data.message.id, bubbleElement.offsetHeight);
    };

    reportHeight();

    const observer = new ResizeObserver(() => {
      reportHeight();
    });

    observer.observe(bubbleElement);

    return () => {
      observer.disconnect();
    };
  }, [data]);

  return (
    <div className="relative w-[420px]">
      {data.showSessionId ? (
        <div
          className={cn(
            "pointer-events-none absolute top-1/2 z-10 max-w-[164px] -translate-y-1/2",
            data.sessionLabelSide === "left" ? "right-full mr-4 text-right" : "left-full ml-4 text-left",
          )}
          title={sessionIdLabel}
        >
          <div className="editorial-meta text-[rgba(26,26,26,0.38)]">session_id</div>
          <div className="mt-2 break-all font-mono text-[10px] leading-5 text-[rgba(26,26,26,0.68)]">
            {sessionIdLabel}
          </div>
        </div>
      ) : null}

      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="!h-1 !w-1 !border-0 !bg-transparent opacity-0"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="!h-1 !w-1 !border-0 !bg-transparent opacity-0"
      />

      <div
        ref={bubbleRef}
        className={cn(
          "group relative w-[420px] overflow-hidden border border-[var(--node-border)] border-t-[4px] bg-white text-left shadow-[8px_8px_0_rgba(26,26,26,0.08)] transition-all",
          isUser
            ? "border-t-[var(--block-slate)]"
            : data.hasSelectionDraft
              ? "border-t-[var(--block-ochre)] bg-[rgba(255,249,242,0.98)] shadow-[10px_10px_0_rgba(194,142,85,0.14)]"
            : data.isActiveMessage
              ? "border-t-[var(--block-green)] bg-[rgba(247,247,242,0.98)] shadow-[12px_12px_0_rgba(62,78,66,0.16)]"
              : "border-t-[var(--block-green)] hover:-translate-y-0.5",
        )}
        onClickCapture={(event) => {
          const selectedText = window.getSelection()?.toString().trim();
          if (!isUser && !selectedText) {
            data.onPickMessage(data.message.id);
          }
          event.stopPropagation();
        }}
        onMouseDownCapture={(event) => {
          event.stopPropagation();
        }}
        onPointerDownCapture={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="relative flex items-center justify-between gap-4 border-b border-[var(--node-border)] px-5 py-4">
          <div
            className={cn(
              "editorial-meta",
              isUser
                ? "text-[rgba(58,64,66,0.72)]"
                : data.hasSelectionDraft
                  ? "text-[var(--block-ochre)]"
                  : "text-[var(--block-green)]",
            )}
          >
            {roleLabel}
          </div>
          <div className="editorial-meta text-[rgba(26,26,26,0.42)]">
            {formatMessageTime(data.message.createdAt)}
          </div>
        </div>

        <div className="relative px-5 py-5">
          <SelectableMessage
            content={data.message.content}
            disabled={isUser}
            onSelection={(draft) => data.onSelectionDraft({ ...draft, sourceMessageId: data.message.id })}
          />
        </div>
      </div>
    </div>
  );
}

function SelectableMessage({
  content,
  disabled,
  onSelection,
}: {
  content: string;
  disabled: boolean;
  onSelection: (draft: Omit<SelectionDraft, "sourceMessageId">) => void;
}) {
  return (
    <div
      className={cn(
        "message-copy whitespace-pre-wrap text-[17px] font-medium leading-9 text-[var(--text-main)] selection:bg-[rgba(194,142,85,0.24)] selection:text-[var(--text-main)]",
        disabled ? "cursor-default" : "nodrag nopan cursor-text select-text",
      )}
      onClick={(event) => {
        event.stopPropagation();
      }}
      onMouseDown={(event) => {
        event.stopPropagation();
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      onMouseUp={(event) => {
        event.stopPropagation();
        if (disabled) {
          return;
        }

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
          return;
        }

        const rawText = selection.toString();
        const selectedText = rawText.trim();
        if (!selectedText) {
          return;
        }

        const range = selection.getRangeAt(0);
        const container = event.currentTarget;
        if (!container.contains(range.commonAncestorContainer)) {
          return;
        }

        const leadingWhitespace = rawText.match(/^\s*/)?.[0].length ?? 0;
        const trailingWhitespace = rawText.match(/\s*$/)?.[0].length ?? 0;

        const probe = range.cloneRange();
        probe.selectNodeContents(container);
        probe.setEnd(range.startContainer, range.startOffset);
        const rawStartOffset = probe.toString().length;
        const startOffset = rawStartOffset + leadingWhitespace;
        const endOffset = rawStartOffset + rawText.length - trailingWhitespace;

        onSelection({
          selectedText,
          startOffset,
          endOffset,
        });
      }}
    >
      {content}
    </div>
  );
}

function buildFlowGraph({
  snapshot,
  selectedMessageId,
  selectionDraft,
  measuredNodeHeights,
  onMeasureHeight,
  onPickMessage,
  onSelectionDraft,
  showSessionIds,
}: {
  snapshot: GraphSnapshot;
  selectedMessageId: string | null;
  selectionDraft: SelectionDraft | null;
  measuredNodeHeights: Record<string, number>;
  onMeasureHeight: (messageId: string, height: number) => void;
  onPickMessage: (messageId: string) => void;
  onSelectionDraft: (draft: SelectionDraft) => void;
  showSessionIds: boolean;
}) {
  const activeEdgeIds = getActiveEdgeIds(snapshot, selectedMessageId);
  const nodes: Node[] = [];
  const edges: Edge[] = snapshot.edges.map((edge) => {
    const isActive = activeEdgeIds.has(edge.id);
    const strokeColor = isActive ? "#1A1A1A" : edge.kind === "fork" ? "#C2B7A1" : "#8A9288";

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "step",
      zIndex: isActive ? 5 : 1,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: strokeColor,
      },
      style: {
        stroke: strokeColor,
        strokeDasharray: edge.kind === "fork" ? "10 8" : undefined,
        strokeWidth: isActive ? 2.8 : edge.kind === "fork" ? 1.8 : 2.2,
        opacity: isActive ? 1 : edge.kind === "fork" ? 0.78 : 0.92,
      },
    };
  });

  if (snapshot.messages.length === 0) {
    return { nodes, edges };
  }

  const branchOrder = new Map(snapshot.branches.map((branch, index) => [branch.id, index]));
  const messagesByBranch = new Map<string, MessageNode[]>();
  const childBranchesBySourceMessage = new Map<string, typeof snapshot.branches>();

  for (const message of snapshot.messages) {
    const branchMessages = messagesByBranch.get(message.branchId) ?? [];
    branchMessages.push(message);
    messagesByBranch.set(message.branchId, branchMessages);
  }

  for (const branch of snapshot.branches) {
    if (!branch.sourceMessageId) {
      continue;
    }

    const childBranches = childBranchesBySourceMessage.get(branch.sourceMessageId) ?? [];
    childBranches.push(branch);
    childBranchesBySourceMessage.set(branch.sourceMessageId, childBranches);
  }

  for (const childBranches of childBranchesBySourceMessage.values()) {
    childBranches.sort((left, right) => (branchOrder.get(left.id) ?? 0) - (branchOrder.get(right.id) ?? 0));
  }

  const branchLaneById = new Map<string, number>([[rootBranchId, 0]]);
  const branchSideById = new Map<string, "center" | "left" | "right">([[rootBranchId, "center"]]);
  let nextLeftLane = -1;
  let nextRightLane = 1;

  placeBranch(rootBranchId, 0);

  return { nodes, edges };

  function placeBranch(branchId: string, startY: number) {
    const laneIndex = branchLaneById.get(branchId) ?? 0;
    const centerX = laneIndex * branchLaneWidth;
    const branchMessages = messagesByBranch.get(branchId) ?? [];
    let cursorY = startY;

    branchMessages.forEach((message) => {
      const height = measuredNodeHeights[message.id] ?? estimateMessageBubbleHeight(message);

      nodes.push({
        id: message.id,
        type: "message",
        className: cn(
          "message-node-shell nopan",
          message.role === "assistant" ? "message-node-shell--assistant" : "message-node-shell--user",
        ),
        position: {
          x: centerX - messageNodeWidth / 2,
          y: cursorY,
        },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        data: {
          message,
          isActiveMessage: message.id === selectedMessageId,
          hasSelectionDraft: selectionDraft?.sourceMessageId === message.id,
          showSessionId: showSessionIds,
          sessionLabelSide: laneIndex < 0 ? "left" : "right",
          onMeasureHeight,
          onPickMessage,
          onSelectionDraft,
        } satisfies MessageNodeData,
      });

      const childBranches = childBranchesBySourceMessage.get(message.id) ?? [];

      childBranches.forEach((childBranch) => {
        assignLaneToBranch(childBranch.id, branchId);
        placeBranch(childBranch.id, cursorY + height + branchForkGap);
      });

      cursorY += height + branchMessageGap;
    });
  }

  function assignLaneToBranch(
    branchId: string,
    parentBranchId: string,
  ) {
    if (branchLaneById.has(branchId)) {
      return;
    }

    const parentSide = branchSideById.get(parentBranchId) ?? "center";
    const side =
      parentSide === "center"
        ? Math.abs(nextLeftLane) <= Math.abs(nextRightLane)
          ? "left"
          : "right"
        : parentSide;
    const laneIndex = side === "left" ? nextLeftLane-- : nextRightLane++;

    branchSideById.set(branchId, side);
    branchLaneById.set(branchId, laneIndex);
  }
}


function estimateMessageBubbleHeight(message: MessageNode) {
  const normalized = message.content.replace(/\r\n/g, "\n");
  const wrappedLines = normalized.split("\n").reduce((count, line) => {
    const visibleLength = Math.max(line.trim().length, 1);
    return count + Math.max(1, Math.ceil(visibleLength / messageEstimateCharsPerLine));
  }, 0);
  const codeBlockBonus = (normalized.match(/```/g)?.length ?? 0) * 48;

  return Math.max(230, 150 + wrappedLines * messageEstimateLineHeight + codeBlockBonus);
}

function getActiveEdgeIds(snapshot: GraphSnapshot, selectedMessageId: string | null) {
  if (!selectedMessageId) {
    return new Set<string>();
  }

  const edgeByTarget = new Map(snapshot.edges.map((edge) => [edge.target, edge]));
  const activeEdgeIds = new Set<string>();
  let currentMessageId: string | null = selectedMessageId;

  while (currentMessageId) {
    const edge = edgeByTarget.get(currentMessageId);
    if (!edge) {
      break;
    }

    activeEdgeIds.add(edge.id);
    currentMessageId = edge.source;
  }

  return activeEdgeIds;
}

function clearBrowserSelection() {
  window.getSelection()?.removeAllRanges();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function buildConnectionStatus(
  machine: MachineRecord | undefined,
  diagnostics: DaemonDiagnostics | undefined,
  error: unknown,
) {
  if (machine?.status === "online") {
    return {
      label: "Connected",
      tone: "connected" as const,
    };
  }

  if (machine?.status === "offline") {
    return {
      label: "Disconnected",
      tone: "offline" as const,
    };
  }

  if (!diagnostics) {
    const disconnected = error instanceof Error && error.message.trim().length > 0;
    return {
      label: disconnected ? "Disconnected" : "Connecting",
      tone: disconnected ? ("offline" as const) : ("connecting" as const),
    };
  }

  if (
    diagnostics.status === "starting" ||
    diagnostics.status === "registering" ||
    diagnostics.status === "registered"
  ) {
    return {
      label: "Connecting",
      tone: "connecting" as const,
    };
  }

  if (diagnostics.machineId || diagnostics.status === "online") {
    return {
      label: "Connected",
      tone: "connected" as const,
    };
  }

  return {
    label: diagnostics.status === "waiting_for_pairing" || diagnostics.status === "error" ? "Disconnected" : "Connecting",
    tone:
      diagnostics.status === "waiting_for_pairing" || diagnostics.status === "error"
        ? ("offline" as const)
        : ("connecting" as const),
  };
}

function formatMessageTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatErrorMessage(error: unknown) {
  if (!error) {
    return null;
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  return "The request failed. Check the daemon/server logs for more detail.";
}

function getLatestAssistantMessageId(snapshot: GraphSnapshot) {
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    if (snapshot.messages[index]?.role === "assistant") {
      return snapshot.messages[index]!.id;
    }
  }

  return null;
}

function formatNetTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "just now";
  }

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatWorkingDirectoryPath(value: string | null) {
  if (!value) {
    return "Unavailable";
  }

  const normalized = value.replace(/\\/g, "/");
  return normalized.replace(/^[A-Za-z]:\/Users\/[^/]+/i, "~");
}

function resolveWorkspaceName(value: string) {
  const normalized = value.replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts.at(-1) || value;
}

function resolveRuntimeLabel(
  machine: MachineRecord | undefined,
  diagnostics: DaemonDiagnostics | undefined,
) {
  const runtimeMode = machine?.environment.runtimeMode ?? diagnostics?.environment.runtimeMode;
  return runtimeMode === "mock" ? "Mock runtime" : "Claude Code";
}

/*
function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function truncateMiddle(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  const leading = Math.ceil((maxLength - 1) / 2);
  const trailing = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, leading)}…${value.slice(value.length - trailing)}`;
}

*/

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function truncateMiddle(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  const leading = Math.ceil((maxLength - 3) / 2);
  const trailing = Math.floor((maxLength - 3) / 2);
  return `${value.slice(0, leading)}...${value.slice(value.length - trailing)}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const hasBody = init?.body !== undefined && init?.body !== null;
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;

  if (hasBody && !isFormData && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Request failed"));
  }

  return response.json() as Promise<T>;
}

async function readErrorMessage(response: Response, fallback: string) {
  const payload = (await response.text()).trim();
  if (!payload) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(payload) as {
      error?: unknown;
      message?: unknown;
    };
    if (typeof parsed.message === "string" && parsed.message.trim().length > 0) {
      return parsed.message.trim();
    }

    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      return parsed.error.trim();
    }
  } catch {
    return payload;
  }

  return payload;
}

function logWeb(level: "info" | "warn" | "error", message: string) {
  const formatted = `${webLogPrefix}[${level}] ${message}`;
  if (level === "error") {
    console.error(formatted);
    return;
  }

  if (level === "warn") {
    console.warn(formatted);
    return;
  }

  console.info(formatted);
}
