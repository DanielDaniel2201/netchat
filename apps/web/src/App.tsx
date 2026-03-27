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
  CreateRootTurnInput,
  GraphSnapshot,
  MachineRecord,
  MessageNode,
  rootBranchId,
} from "@netchat/shared";
import { create } from "zustand";

import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { cn } from "./lib/cn";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3001";
const daemonBaseUrl = import.meta.env.VITE_DAEMON_BASE_URL ?? "http://127.0.0.1:4318";
const messageNodeWidth = 420;
const branchLaneWidth = 620;
const branchMessageGap = 96;
const branchForkGap = 92;
const bubbleComposerGap = 20;
const bubbleComposerWidth = 560;
const messageEstimateCharsPerLine = 32;
const messageEstimateLineHeight = 30;
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
  const [showRuntimeDetails, setShowRuntimeDetails] = useState(false);

  const graphQuery = useQuery({
    queryKey: ["graph"],
    queryFn: () => request<GraphSnapshot>("/api/graph"),
  });
  const machinesQuery = useQuery({
    queryKey: ["machines"],
    queryFn: () => request<MachineRecord[]>("/api/machines"),
    refetchInterval: 15000,
  });
  const daemonDiagnosticsQuery = useQuery({
    queryKey: ["daemon-diagnostics"],
    queryFn: () => requestDaemon<DaemonDiagnostics>("/runtime/diagnostics"),
    refetchInterval: 2500,
    retry: false,
  });

  const snapshot = graphQuery.data;
  const machines = machinesQuery.data ?? [];
  const onlineMachines = machines.filter((machine) => machine.status === "online");
  const daemonDiagnostics = daemonDiagnosticsQuery.data;
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
      : selectionForSelectedMessage
        ? "branch-from-selection"
      : !selectedMessageIsTail
        ? "branch-from-message"
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
    onSuccess: (nextSnapshot) => {
      logWeb(
        "info",
        `Root turn completed. Graph now has ${nextSnapshot.messages.length} messages across ${nextSnapshot.branches.length} branches.`,
      );
      queryClient.setQueryData(["graph"], nextSnapshot);
      setComposerValue("");
      setSelectionDraft(null);
      setSelectedMessageId(getLatestAssistantMessageId(nextSnapshot));
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
          : `Forking from message ${input.sourceMessageId} with ${(input.selectedText ?? "").length} selected chars and ${input.prompt.length} prompt chars.`,
      );
      return request<GraphSnapshot>("/api/branches", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    onSuccess: (nextSnapshot) => {
      logWeb(
        "info",
        `Branch fork completed. Graph now has ${nextSnapshot.branches.length} branches.`,
      );
      queryClient.setQueryData(["graph"], nextSnapshot);
      setComposerValue("");
      setSelectionDraft(null);
      setSelectedMessageId(getLatestAssistantMessageId(nextSnapshot));
      clearBrowserSelection();
    },
    onError: (error) => {
      logWeb("error", `Branch fork failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
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
    onSuccess: (nextSnapshot) => {
      logWeb(
        "info",
        `Branch turn completed. Graph now has ${nextSnapshot.messages.length} messages.`,
      );
      queryClient.setQueryData(["graph"], nextSnapshot);
      setComposerValue("");
      setSelectionDraft(null);
      setSelectedMessageId(getLatestAssistantMessageId(nextSnapshot));
    },
    onError: (error) => {
      logWeb("error", `Branch turn failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
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
    });
  }, [measuredNodeHeights, reportMessageNodeHeight, selectedMessageId, selectionDraft, snapshot]);

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
          maxZoom: 1.02,
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

  const hasMessages = Boolean(snapshot && snapshot.messages.length > 0);
  const showBubbleComposer = Boolean(selectedMessage && composerAnchor);
  const sendDisabled = composerValue.trim().length === 0 || isThinking || !canSendOnActiveLane;

  function submitCurrentPrompt() {
    const prompt = composerValue.trim();
    if (prompt.length === 0) {
      return;
    }

    if (sendMode === "root" || sendMode === "continue-root") {
      rootTurnMutation.mutate({ prompt, machineId: rootMachine?.id });
      return;
    }

    if (sendMode === "continue-branch" && selectedBranch) {
      branchTurnMutation.mutate({
        branchId: selectedBranch.id,
        input: { prompt },
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
      : sendMode === "branch-from-selection"
        ? "You are branching from a highlighted passage in this reply."
      : sendMode === "branch-from-message"
        ? "Next message creates a new branch."
        : "Next message continues this branch."
    : rootMachine
      ? "Your next message starts the main branch."
      : "Bring one local runtime online to start chatting.";
  const composerPlaceholder = selectedMessage
    ? sendMode === "branch-from-selection"
      ? "Ask about the selected text in this context..."
      : sendMode === "branch-from-message"
        ? "Start a branch from this reply..."
        : "Continue from this reply..."
    : "Start the first turn...";
  const composerMetaLabel =
    sendMode === "branch-from-selection"
      ? "Selected passage"
      : sendMode === "branch-from-message"
        ? "New branch"
      : selectedMessage
        ? "Continue lane"
        : "Main canvas";
  const composerErrorMessage = formatErrorMessage(
    rootTurnMutation.error ?? branchMutation.error ?? branchTurnMutation.error,
  );

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#ecf7f2] text-slate-950">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.98),transparent_34%),radial-gradient(circle_at_84%_12%,rgba(204,251,241,0.74),transparent_22%),radial-gradient(circle_at_50%_100%,rgba(219,234,254,0.62),transparent_28%),linear-gradient(180deg,#f8fffc_0%,#eef8f3_52%,#e7f2ee_100%)]" />

      <div className="pointer-events-none absolute right-5 top-5 z-20 flex flex-col items-end gap-3">
        <button
          type="button"
          className="pointer-events-auto relative overflow-hidden rounded-[28px] border border-white/70 bg-white/60 px-4 py-3 text-left shadow-[0_30px_72px_-42px_rgba(15,23,42,0.38)] backdrop-blur-xl transition-all hover:-translate-y-0.5 hover:border-white/90"
          onClick={() => setShowRuntimeDetails((open) => !open)}
        >
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.94),rgba(240,253,250,0.86)_40%,rgba(239,246,255,0.82)_100%)]" />
          <div className="relative flex items-start gap-3">
            <span
              className={cn(
                "mt-[7px] inline-flex size-2.5 rounded-full",
                connectionStatus.tone === "connected"
                  ? "bg-emerald-500 shadow-[0_0_0_6px_rgba(16,185,129,0.16)]"
                  : connectionStatus.tone === "connecting"
                    ? "animate-pulse bg-amber-400 shadow-[0_0_0_6px_rgba(251,191,36,0.16)]"
                    : "bg-slate-400 shadow-[0_0_0_6px_rgba(148,163,184,0.16)]",
              )}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.28em] text-slate-400">
                  Runtime
                </span>
                <span className="rounded-full border border-slate-900/10 bg-white/72 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-500">
                  {runtimeLabel}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-sm font-semibold text-slate-900">{connectionStatus.label}</span>
                <span className="inline-flex size-1 rounded-full bg-slate-300" />
                <span className="max-w-[180px] truncate text-sm text-slate-500">{workspaceName}</span>
              </div>
            </div>
          </div>
        </button>

        {showRuntimeDetails ? (
          <div className="pointer-events-auto relative w-[min(340px,calc(100vw-2.5rem))] overflow-hidden rounded-[30px] border border-white/80 bg-white/62 p-4 shadow-[0_34px_90px_-52px_rgba(15,23,42,0.46)] backdrop-blur-xl">
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(160deg,rgba(255,255,255,0.94),rgba(240,253,250,0.78)_44%,rgba(239,246,255,0.82)_100%)]" />
            <div className="relative space-y-3">
              <div className="grid gap-1 rounded-[22px] border border-white/70 bg-white/62 px-4 py-3">
                <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                  Status
                </span>
                <span className="text-base font-semibold text-slate-900">{connectionStatus.label}</span>
              </div>

              <div className="grid gap-1 rounded-[22px] border border-white/70 bg-white/62 px-4 py-3">
                <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                  Workspace
                </span>
                <span
                  className="font-mono text-[12px] leading-5 text-slate-700"
                  title={workingDirectoryPath}
                >
                  {workingDirectoryDisplay}
                </span>
              </div>

              <div className="grid gap-1 rounded-[22px] border border-white/70 bg-white/62 px-4 py-3">
                <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                  Engine
                </span>
                <span className="text-sm font-medium text-slate-900">{runtimeLabel}</span>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <ReactFlow
        className="netchat-flow canvas-flow"
        fitView
        fitViewOptions={{ padding: 0.18, minZoom: 0.34, maxZoom: 1.02 }}
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
        maxZoom={1.2}
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
        <Background gap={28} size={1.1} color="#c8ddd5" />
      </ReactFlow>

      {graphQuery.isLoading ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4">
          <div className="rounded-[28px] border border-white/80 bg-white/72 px-6 py-4 text-sm text-slate-500 shadow-[0_24px_56px_-40px_rgba(15,23,42,0.34)] backdrop-blur-xl">
            Loading conversation canvas...
          </div>
        </div>
      ) : null}

      {!graphQuery.isLoading && !hasMessages ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4">
          <form
            className="pointer-events-auto max-w-2xl overflow-hidden rounded-[34px] border border-white/80 bg-white/70 shadow-[0_34px_84px_-48px_rgba(15,23,42,0.36)] backdrop-blur-xl"
            onSubmit={handleSubmit}
          >
            <div className="border-b border-white/80 px-7 py-6">
              <div className="text-sm font-medium uppercase tracking-[0.28em] text-slate-400">
              Start here
              </div>
              <div className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-slate-950">
                Turn one prompt into a branchable canvas.
              </div>
              <div className="mt-3 text-sm leading-7 text-slate-600">
                Conversations stay readable as waterfalls. Later, click any Claude reply or select a passage
                to branch right from that exact point.
              </div>
            </div>

            <div className="relative px-7 py-6">
              <Textarea
                ref={composerRef}
                className="min-h-[136px] resize-none rounded-[30px] border-0 bg-[rgba(255,255,255,0.72)] px-6 py-5 pb-16 pr-24 text-[15px] leading-7 text-slate-800 shadow-[inset_0_0_0_1px_rgba(148,163,184,0.12)] placeholder:text-slate-400"
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
              <div className="pointer-events-none absolute bottom-[2.75rem] left-[3.25rem] flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                <span>{composerMetaLabel}</span>
                <span className="inline-flex size-1 rounded-full bg-slate-300" />
                <span>{composerHint}</span>
              </div>
              <Button
                className="absolute bottom-10 right-[2.75rem] h-12 w-12 rounded-full bg-slate-950/92 px-0 shadow-[0_28px_60px_-30px_rgba(15,23,42,0.7)] backdrop-blur hover:bg-slate-800"
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
              <div className="border-t border-rose-100 bg-rose-50/90 px-7 py-4 text-sm leading-6 text-rose-700">
                {composerErrorMessage}
              </div>
            ) : null}
          </form>
        </div>
      ) : null}

      {hasMessages && !showBubbleComposer ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center px-4">
          <div className="rounded-full border border-white/80 bg-white/72 px-4 py-2 text-xs text-slate-500 shadow-[0_18px_36px_-28px_rgba(15,23,42,0.36)] backdrop-blur-xl">
            Click a Claude bubble or select a passage to keep chatting from that exact context.
          </div>
        </div>
      ) : null}

      {showBubbleComposer ? (
        <div className="pointer-events-none fixed inset-0 z-30">
          <form
            className="pointer-events-auto fixed"
            style={{
              left: composerAnchor?.left,
              top: composerAnchor?.top,
              width: composerAnchor?.width,
            }}
            onSubmit={handleSubmit}
          >
            <div className="relative overflow-hidden rounded-[32px] border border-white/80 bg-white/74 shadow-[0_42px_120px_-58px_rgba(15,23,42,0.54)] backdrop-blur-xl">
              <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.95),rgba(240,253,250,0.9)_38%,rgba(239,246,255,0.84)_100%)]" />

              <div className="relative border-b border-white/80 px-6 py-4">
                <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                  <span>{composerMetaLabel}</span>
                  <span className="inline-flex size-1 rounded-full bg-slate-300" />
                  <span>{composerHint}</span>
                </div>

                {selectionForSelectedMessage ? (
                  <div className="mt-3 flex items-start justify-between gap-3">
                    <div className="min-w-0 rounded-[20px] border border-amber-200/80 bg-amber-50/80 px-4 py-3 text-sm leading-6 text-amber-950">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-amber-700">
                        Selected context
                      </div>
                      <div className="mt-2 break-words">{truncate(selectionForSelectedMessage.selectedText, 140)}</div>
                    </div>
                    <button
                      type="button"
                      className="rounded-full border border-white/80 bg-white/80 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-900"
                      onClick={() => {
                        setSelectionDraft(null);
                        clearBrowserSelection();
                        focusComposer();
                      }}
                    >
                      Clear
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="relative px-6 py-5">
                <Textarea
                  ref={composerRef}
                  className="min-h-[118px] resize-none rounded-[28px] border-0 bg-[rgba(255,255,255,0.64)] px-5 py-4 pb-14 pr-20 text-[15px] leading-7 text-slate-800 shadow-[inset_0_0_0_1px_rgba(148,163,184,0.12)] placeholder:text-slate-400"
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
                <div className="pointer-events-none absolute bottom-9 left-[2.75rem] flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                  <span>Enter sends</span>
                  <span className="inline-flex size-1 rounded-full bg-slate-300" />
                  <span>{runtimeLabel}</span>
                </div>
                <Button
                  className="absolute bottom-9 right-10 h-12 w-12 rounded-full bg-slate-950/92 px-0 shadow-[0_28px_60px_-30px_rgba(15,23,42,0.7)] backdrop-blur hover:bg-slate-800"
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
              <div className="mt-3 rounded-[20px] border border-rose-200 bg-rose-50/95 px-4 py-3 text-sm leading-6 text-rose-700 shadow-[0_20px_40px_-32px_rgba(225,29,72,0.42)]">
                {composerErrorMessage}
              </div>
            ) : null}
          </form>
        </div>
      ) : null}
    </div>
  );
}

function MessageGraphNode({ data }: NodeProps<Node<MessageNodeData>>) {
  const isUser = data.message.role === "user";
  const roleLabel = isUser ? "You" : "Claude Code";
  const bubbleRef = useRef<HTMLDivElement>(null);

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
    <div
      ref={bubbleRef}
      className={cn(
        "group relative w-[420px] overflow-hidden rounded-[30px] border px-6 py-5 text-left shadow-[0_30px_72px_-46px_rgba(15,23,42,0.36)] backdrop-blur-[18px] transition-all",
        isUser
          ? "border-white/75 bg-[rgba(255,255,255,0.8)]"
          : data.hasSelectionDraft
            ? "border-amber-300/80 bg-[rgba(255,251,235,0.94)] shadow-[0_40px_100px_-54px_rgba(217,119,6,0.18)] ring-1 ring-amber-200/80"
          : data.isActiveMessage
            ? "border-slate-900/16 bg-[rgba(247,255,251,0.95)] shadow-[0_40px_100px_-54px_rgba(15,23,42,0.5)] ring-1 ring-emerald-300/35"
            : "border-[#d6ebe3] bg-[rgba(244,255,250,0.92)] hover:-translate-y-0.5 hover:border-[#bddccf] hover:shadow-[0_34px_84px_-48px_rgba(15,23,42,0.42)]",
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
        className={cn(
          "pointer-events-none absolute inset-0",
          isUser
            ? "bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(248,250,252,0.78))]"
            : data.hasSelectionDraft
              ? "bg-[radial-gradient(circle_at_top_left,rgba(254,243,199,0.72),transparent_42%),linear-gradient(180deg,rgba(255,251,235,0.98),rgba(255,247,237,0.84))]"
            : data.isActiveMessage
              ? "bg-[radial-gradient(circle_at_top_left,rgba(236,253,245,0.92),transparent_48%),linear-gradient(180deg,rgba(255,255,255,0.98),rgba(240,253,250,0.84))]"
              : "bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(240,253,250,0.82))]",
        )}
      />
      <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-slate-900/10 to-transparent" />

      <div className="relative mb-4 flex items-center justify-between gap-4">
        <div
          className={cn(
            "inline-flex rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.24em]",
            isUser
              ? "border-slate-200 bg-white/72 text-slate-500"
              : data.hasSelectionDraft
                ? "border-amber-200/80 bg-white/72 text-amber-700"
                : "border-emerald-200/80 bg-white/72 text-emerald-700",
          )}
        >
          {roleLabel}
        </div>
        <div className="font-mono text-[11px] text-slate-400">
          {formatMessageTime(data.message.createdAt)}
        </div>
      </div>

      <SelectableMessage
        content={data.message.content}
        disabled={isUser}
        onSelection={(draft) => data.onSelectionDraft({ ...draft, sourceMessageId: data.message.id })}
      />

      {!isUser ? (
        <div className="relative mt-4 flex items-center justify-between gap-3 border-t border-slate-900/6 pt-4">
          <span className="text-[11px] uppercase tracking-[0.18em] text-slate-400">
            Click to focus or select text to branch
          </span>
          <button
            type="button"
            className={cn(
              "rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] transition-colors",
              data.hasSelectionDraft
                ? "border-amber-200 bg-white/78 text-amber-700 hover:border-amber-300"
                : data.isActiveMessage
                  ? "border-emerald-200 bg-white/78 text-emerald-700 hover:border-emerald-300"
                  : "border-slate-200 bg-white/78 text-slate-500 hover:border-slate-300 hover:text-slate-900",
            )}
            onClick={(event) => {
              event.stopPropagation();
              data.onPickMessage(data.message.id);
            }}
          >
            Continue here
          </button>
        </div>
      ) : null}
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
        "message-copy whitespace-pre-wrap text-[15px] leading-7 text-slate-700 selection:bg-amber-200 selection:text-slate-950",
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
}: {
  snapshot: GraphSnapshot;
  selectedMessageId: string | null;
  selectionDraft: SelectionDraft | null;
  measuredNodeHeights: Record<string, number>;
  onMeasureHeight: (messageId: string, height: number) => void;
  onPickMessage: (messageId: string) => void;
  onSelectionDraft: (draft: SelectionDraft) => void;
}) {
  const activeEdgeIds = getActiveEdgeIds(snapshot, selectedMessageId);
  const nodes: Node[] = [];
  const edges: Edge[] = snapshot.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "simplebezier",
    zIndex: activeEdgeIds.has(edge.id) ? 5 : 1,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: "#111111",
    },
    style: {
      stroke: "#111111",
      strokeDasharray: edge.kind === "fork" ? "8 10" : undefined,
      strokeWidth: activeEdgeIds.has(edge.id) ? 3 : edge.kind === "fork" ? 2.2 : 2.5,
      opacity: activeEdgeIds.has(edge.id) ? 1 : edge.kind === "fork" ? 0.72 : 0.92,
    },
  }));

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

  return Math.max(210, 142 + wrappedLines * messageEstimateLineHeight + codeBlockBonus);
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
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Request failed"));
  }

  return response.json() as Promise<T>;
}

async function requestDaemon<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${daemonBaseUrl}${path}`, {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Daemon request failed"));
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
