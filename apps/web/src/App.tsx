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
  useUpdateNodeInternals,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, LoaderCircle, MoreHorizontal } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import {
  AssistantStreamState,
  DaemonDiagnostics,
  CreateBranchInput,
  CreateBranchTurnInput,
  CreateNetInput,
  CreateRootTurnInput,
  GraphSnapshot,
  MachineRecord,
  MessageNode,
  TurnStreamEvent,
  UiConfig,
  UpdateNetInput,
  WorkspaceState,
  buildGraphEdges,
  createPendingAssistantState,
  describeBranchCreation,
  finalizeAssistantState,
  makeId,
  rootBranchId,
} from "@netchat/shared";
import remarkGfm from "remark-gfm";
import { create } from "zustand";

import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { cn } from "./lib/cn";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
const messageNodeWidth = 1340;
const branchLaneWidth = 1860;
const branchMessageGap = 96;
const branchForkGap = 92;
const bubbleComposerGap = 20;
const bubbleComposerWidth = 840;
const messageEstimateCharsPerLine = 90;
const messageEstimateLineHeight = 38;
const canvasMinZoom = 0.35;
const canvasMaxZoom = 1.45;
const branchRevealBubbleWidthRatio = 5 / 6;
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
  persistedAssistantState: AssistantStreamState | null;
  isActiveMessage: boolean;
  hasSelectionDraft: boolean;
  selectionAnchors: MessageSelectionAnchor[];
  showSessionId: boolean;
  sessionLabelSide: "left" | "right";
  onMeasureHeight: (messageId: string, height: number) => void;
  onPickMessage: (messageId: string) => void;
  onToggleSelectionAnchor: (anchor: MessageSelectionAnchor) => void;
  onSelectionDraft: (draft: SelectionDraft) => void;
};

type MessageSelectionAnchor = {
  id: string;
  handleId: string;
  sourceMessageId: string;
  targetMessageId: string;
  label: string;
  startOffset: number | null;
  endOffset: number | null;
  isExpanded: boolean;
};

type ActiveStreamedTurn = {
  turnId: string;
  assistantMessageId: string;
  optimisticSnapshot: GraphSnapshot;
  isPending: boolean;
};

type PendingTurnMetadata = {
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
  createdAt: string;
  branchId?: string;
  optimisticSnapshot: GraphSnapshot;
  assistantState: AssistantStreamState;
};

type CanvasViewport = {
  x: number;
  y: number;
  zoom: number;
};

type PendingViewportAction =
  | {
      kind: "center-message";
      messageId: string;
    }
  | {
      kind: "frame-message-at-top";
      messageId: string;
    };

const useComposerStore = create<{
  selectedMessageId: string | null;
  setSelectedMessageId: (messageId: string | null) => void;
}>((set) => ({
  selectedMessageId: null,
  setSelectedMessageId: (selectedMessageId) => set({ selectedMessageId }),
}));

const useLiveAssistantStateStore = create<{
  statesByMessageId: Record<string, AssistantStreamState>;
  clearStates: () => void;
  pruneStates: (messageIds: string[]) => void;
  setState: (messageId: string, nextState: AssistantStreamState) => void;
}>((set) => ({
  statesByMessageId: {},
  clearStates: () =>
    set((current) =>
      Object.keys(current.statesByMessageId).length === 0
        ? current
        : {
            statesByMessageId: {},
          },
    ),
  pruneStates: (messageIds) =>
    set((current) => {
      const liveMessageIds = new Set(messageIds);
      let changed = false;
      const nextStates: Record<string, AssistantStreamState> = {};

      for (const [messageId, state] of Object.entries(current.statesByMessageId)) {
        if (!liveMessageIds.has(messageId)) {
          changed = true;
          continue;
        }

        nextStates[messageId] = state;
      }

      return changed
        ? {
            statesByMessageId: nextStates,
          }
        : current;
    }),
  setState: (messageId, nextState) =>
    set((current) =>
      assistantStatesEqual(current.statesByMessageId[messageId] ?? null, nextState)
        ? current
        : {
            statesByMessageId: {
              ...current.statesByMessageId,
              [messageId]: nextState,
            },
          },
    ),
}));

const markdownComponents: Components = {
  h1: ({ children }) => (
    <h1 className="mb-4 text-[30px] font-semibold leading-[1.18] tracking-[-0.03em] text-[var(--text-main)]">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-4 text-[26px] font-semibold leading-[1.24] tracking-[-0.02em] text-[var(--text-main)]">
      {children}
    </h2>
  ),
  h3: ({ children }) => <h3 className="mb-3 text-[22px] font-semibold leading-[1.3] text-[var(--text-main)]">{children}</h3>,
  p: ({ children }) => <p className="mb-4 whitespace-pre-wrap last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-4 ml-6 list-disc space-y-2 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-4 ml-6 list-decimal space-y-2 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mb-4 border-l-2 border-[var(--block-ochre)] pl-4 italic text-[rgba(26,26,26,0.72)] last:mb-0">
      {children}
    </blockquote>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target={href?.startsWith("#") ? undefined : "_blank"}
      rel={href?.startsWith("#") ? undefined : "noreferrer"}
      className="break-words text-[var(--block-ochre)] underline decoration-[rgba(194,142,85,0.4)] underline-offset-4"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-5 border-0 border-t border-[var(--node-border)]" />,
  table: ({ children }) => (
    <div className="mb-4 overflow-x-auto last:mb-0">
      <table className="min-w-full border-collapse border border-[var(--node-border)] text-[16px] leading-7">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-[rgba(244,241,234,0.66)]">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="border-b border-[var(--node-border)] last:border-b-0">{children}</tr>,
  th: ({ children }) => <th className="border-r border-[var(--node-border)] px-3 py-2 text-left font-semibold last:border-r-0">{children}</th>,
  td: ({ children }) => <td className="border-r border-[var(--node-border)] px-3 py-2 align-top last:border-r-0">{children}</td>,
  pre: ({ children }) => (
    <pre className="my-4 overflow-x-auto border border-[var(--node-border)] bg-[rgba(244,241,234,0.46)] px-4 py-4 text-[15px] leading-7 last:mb-0">
      {children}
    </pre>
  ),
  code: ({ children, className }) => {
    const normalizedClassName = className ?? "";
    const isBlockCode = normalizedClassName.includes("language-");
    const content = String(children).replace(/\n$/, "");

    if (isBlockCode) {
      return <code className={cn(normalizedClassName, "font-mono text-[15px]")}>{content}</code>;
    }

    return (
      <code className="rounded bg-[rgba(244,241,234,0.84)] px-1.5 py-0.5 font-mono text-[0.92em] text-[rgba(26,26,26,0.84)]">
        {content}
      </code>
    );
  },
};

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
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const openNetMenuRef = useRef<HTMLDivElement>(null);
  const lastAutoSelectedMessageIdRef = useRef<string | null>(null);
  const lastAutoFitNetIdRef = useRef<string | null>(null);
  const selectedMessageId = useComposerStore((state) => state.selectedMessageId);
  const setSelectedMessageId = useComposerStore((state) => state.setSelectedMessageId);
  const [activePathMessageId, setActivePathMessageId] = useState<string | null>(null);
  const [composerValue, setComposerValue] = useState("");
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(null);
  const [composerAnchor, setComposerAnchor] = useState<ComposerAnchor | null>(null);
  const [expandedBranchIds, setExpandedBranchIds] = useState<string[]>([]);
  const [pendingViewportAction, setPendingViewportAction] = useState<PendingViewportAction | null>(null);
  const [viewport, setViewport] = useState<CanvasViewport>({ x: 0, y: 0, zoom: 1 });
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [measuredNodeHeights, setMeasuredNodeHeights] = useState<Record<string, number>>({});
  const [editingNetId, setEditingNetId] = useState<string | null>(null);
  const [editingNetTitle, setEditingNetTitle] = useState("");
  const [openNetMenuId, setOpenNetMenuId] = useState<string | null>(null);
  const [pendingNetDeletion, setPendingNetDeletion] = useState<{ id: string; title: string } | null>(null);
  const [showNetHistory, setShowNetHistory] = useState(false);
  const [activeStreamedTurn, setActiveStreamedTurn] = useState<ActiveStreamedTurn | null>(null);
  const [streamErrorMessage, setStreamErrorMessage] = useState<string | null>(null);
  const liveAssistantStates = useLiveAssistantStateStore((state) => state.statesByMessageId);
  const clearLiveAssistantStates = useLiveAssistantStateStore((state) => state.clearStates);
  const pruneLiveAssistantStates = useLiveAssistantStateStore((state) => state.pruneStates);
  const setLiveAssistantState = useLiveAssistantStateStore((state) => state.setState);

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
  const persistedSnapshot = graphQuery.data;
  const snapshot = activeStreamedTurn?.optimisticSnapshot ?? persistedSnapshot;
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
  const persistedAssistantStatesByMessageId = useMemo(() => {
    const states: Record<string, AssistantStreamState | null> = {};

    for (const [messageId, state] of Object.entries(snapshot?.assistantStates ?? {})) {
      states[messageId] = projectAssistantStateForRender(state) ?? null;
    }

    return states;
  }, [snapshot?.assistantStates]);

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

  async function runStreamedTurn(
    path: string,
    init: RequestInit,
    logLabel: string,
    optimisticTurn: PendingTurnMetadata,
  ) {
    try {
      await streamRequest<TurnStreamEvent>(path, init, async (event) => {
        if (event.type === "turn.bootstrap") {
          logWeb("info", `${logLabel} started streaming.`);
          setStreamErrorMessage(null);
          setActiveStreamedTurn({
            turnId: event.turnId,
            assistantMessageId: event.assistantMessageId,
            optimisticSnapshot: event.snapshot,
            isPending: true,
          });
          const renderableState = projectAssistantStateForRender(event.assistantState);
          setLiveAssistantState(event.assistantMessageId, renderableState ?? event.assistantState);
          setSelectedMessageId(event.assistantMessageId);
          setActivePathMessageId(event.assistantMessageId);
          return;
        }

        if (event.type === "assistant.patch") {
          const renderableState = projectAssistantStateForRender(event.state);
          setLiveAssistantState(event.assistantMessageId, renderableState ?? event.state);
          return;
        }

        if (event.type === "turn.committed") {
          queryClient.setQueryData(["graph"], event.snapshot);
          const persistedAssistantState = projectAssistantStateForRender(
            event.snapshot.assistantStates?.[event.assistantMessageId] ?? null,
          );
          const committedMessage =
            event.snapshot.messages.find((message) => message.id === event.assistantMessageId) ?? null;
          setActiveStreamedTurn(null);
          const currentLiveAssistantState =
            useLiveAssistantStateStore.getState().statesByMessageId[event.assistantMessageId] ?? null;
          setLiveAssistantState(
            event.assistantMessageId,
            persistedAssistantState ??
              projectAssistantStateForRender(
                finalizeAssistantState(currentLiveAssistantState, committedMessage?.content ?? ""),
              ) ??
              finalizeAssistantState(currentLiveAssistantState, committedMessage?.content ?? ""),
          );
          setSelectedMessageId(event.assistantMessageId);
          setActivePathMessageId(event.assistantMessageId);
          await queryClient.invalidateQueries({ queryKey: ["workspace"] });
          logWeb("info", `${logLabel} completed.`);
          return;
        }

        setActiveStreamedTurn((current) =>
          current?.turnId === event.turnId
            ? {
                ...current,
                isPending: false,
              }
            : current,
        );
        setStreamErrorMessage(event.message);
        logWeb("error", `${logLabel} failed: ${event.message}`);
      });
    } catch (error) {
      const message = formatErrorMessage(error) ?? "Unknown error";
      setActiveStreamedTurn((current) =>
        current?.turnId === optimisticTurn.turnId
          ? {
              ...current,
              isPending: false,
            }
          : current,
      );
      const currentLiveAssistantState =
        useLiveAssistantStateStore.getState().statesByMessageId[optimisticTurn.assistantMessageId] ??
        optimisticTurn.assistantState;
      setLiveAssistantState(
        optimisticTurn.assistantMessageId,
        projectAssistantStateForRender({
          ...currentLiveAssistantState,
          status: "error",
          errorMessage: message,
        }) ?? {
          ...currentLiveAssistantState,
          status: "error",
          errorMessage: message,
        },
      );
      setStreamErrorMessage(message);
      logWeb("error", `${logLabel} failed: ${message}`);
    }
  }
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
      setExpandedBranchIds([]);
      setSelectedMessageId(null);
      setActivePathMessageId(null);
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
      setExpandedBranchIds([]);
      setSelectedMessageId(null);
      setActivePathMessageId(null);
      clearBrowserSelection();
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
    onError: (error) => {
      logWeb("error", `Switching nets failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
    },
  });
  const renameNetMutation = useMutation({
    mutationFn: async (variables: { netId: string; input: UpdateNetInput }) => {
      logWeb("info", `Renaming net ${variables.netId}.`);
      return request<WorkspaceState>(`/api/nets/${variables.netId}`, {
        method: "PATCH",
        body: JSON.stringify(variables.input),
      });
    },
    onSuccess: (nextWorkspace) => {
      queryClient.setQueryData(["workspace"], nextWorkspace);
      setEditingNetId(null);
      setEditingNetTitle("");
      setOpenNetMenuId(null);
    },
    onError: (error) => {
      logWeb("error", `Renaming a net failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
    },
  });
  const deleteNetMutation = useMutation({
    mutationFn: async (netId: string) => {
      logWeb("info", `Deleting net ${netId}.`);
      return request<WorkspaceState>(`/api/nets/${netId}`, {
        method: "DELETE",
      });
    },
    onSuccess: async (nextWorkspace) => {
      const activeNetChanged = nextWorkspace.activeNetId !== activeNetId;
      queryClient.setQueryData(["workspace"], nextWorkspace);
      setEditingNetId(null);
      setEditingNetTitle("");
      setOpenNetMenuId(null);
      setPendingNetDeletion(null);

      if (activeNetChanged) {
        setComposerValue("");
        setSelectionDraft(null);
        setExpandedBranchIds([]);
        setSelectedMessageId(null);
        setActivePathMessageId(null);
        clearBrowserSelection();
        await queryClient.invalidateQueries({ queryKey: ["graph"] });
      }
    },
    onError: (error) => {
      logWeb("error", `Deleting a net failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
    },
  });
  const isThinking = activeStreamedTurn?.isPending ?? false;

  function focusComposer() {
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
  }

  function activateMessagePath(messageId: string | null) {
    setActivePathMessageId(messageId);
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
    activateMessagePath(messageId);
    setSelectedMessageId(messageId);
    setSelectionDraft(null);
    clearBrowserSelection();
    focusComposer();
  }

  function applySelectionDraft(draft: SelectionDraft) {
    activateMessagePath(draft.sourceMessageId);
    setSelectedMessageId(draft.sourceMessageId);
    setSelectionDraft(draft);
    focusComposer();
  }

  function beginNetRename(netId: string, title: string) {
    setOpenNetMenuId(null);
    setEditingNetId(netId);
    setEditingNetTitle(title);
  }

  function cancelNetRename() {
    setEditingNetId(null);
    setEditingNetTitle("");
  }

  function submitNetRename(netId: string, fallbackTitle: string) {
    const normalizedTitle = editingNetTitle.trim();
    if (!normalizedTitle) {
      setEditingNetTitle(fallbackTitle);
      return;
    }

    if (normalizedTitle === fallbackTitle) {
      cancelNetRename();
      return;
    }

    renameNetMutation.mutate({
      netId,
      input: {
        title: normalizedTitle,
      },
    });
  }

  function requestNetDeletion(netId: string, title: string) {
    setOpenNetMenuId(null);
    setPendingNetDeletion({ id: netId, title });
  }

  function cancelNetDeletion() {
    if (deleteNetMutation.isPending) {
      return;
    }

    setPendingNetDeletion(null);
  }

  function confirmNetDeletion() {
    if (!pendingNetDeletion) {
      return;
    }

    deleteNetMutation.mutate(pendingNetDeletion.id);
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
  const expandedBranchIdSet = useMemo(() => new Set(expandedBranchIds), [expandedBranchIds]);

  const toggleSelectionAnchor = useCallback(
    (anchor: MessageSelectionAnchor) => {
      if (!snapshot) {
        return;
      }

      setSelectedMessageId(null);
      setSelectionDraft(null);
      clearBrowserSelection();

      if (anchor.isExpanded) {
        const descendantBranchIds = new Set(getDescendantBranchIds(snapshot, anchor.id));
        descendantBranchIds.add(anchor.id);
        setExpandedBranchIds((current) => current.filter((branchId) => !descendantBranchIds.has(branchId)));
        activateMessagePath(anchor.sourceMessageId);
        setPendingViewportAction({
          kind: "center-message",
          messageId: anchor.sourceMessageId,
        });
        return;
      }

      setExpandedBranchIds((current) => (current.includes(anchor.id) ? current : [...current, anchor.id]));
      activateMessagePath(anchor.targetMessageId);
      setPendingViewportAction({
        kind: "frame-message-at-top",
        messageId: anchor.targetMessageId,
      });
    },
    [snapshot, setSelectedMessageId],
  );

  const graph = useMemo(() => {
    if (!snapshot) {
      return { nodes: [], edges: [] };
    }

    return buildFlowGraph({
      expandedBranchIds: expandedBranchIdSet,
      snapshot,
      activePathMessageId,
      persistedAssistantStatesByMessageId,
      onPickMessage: pickMessage,
      onToggleSelectionAnchor: toggleSelectionAnchor,
      selectionDraft,
      measuredNodeHeights,
      onMeasureHeight: reportMessageNodeHeight,
      onSelectionDraft: applySelectionDraft,
      showSessionIds: uiConfig?.showSessionIds ?? false,
    });
  }, [
    activePathMessageId,
    expandedBranchIdSet,
    measuredNodeHeights,
    persistedAssistantStatesByMessageId,
    reportMessageNodeHeight,
    selectionDraft,
    snapshot,
    toggleSelectionAnchor,
    uiConfig?.showSessionIds,
  ]);
  const nodeTypes = useMemo(
    () => ({
      message: MessageGraphNode,
    }),
    [],
  );

  useOnViewportChange({
    onChange: (nextViewport) => {
      setViewport(nextViewport);
      syncBubbleComposerAnchor();
    },
    onEnd: (nextViewport) => {
      setViewport(nextViewport);
      syncBubbleComposerAnchor();
    },
  });

  useEffect(() => {
    const hostElement = canvasHostRef.current;
    if (!hostElement) {
      return;
    }

    const updateCanvasSize = () => {
      setCanvasSize({
        width: hostElement.clientWidth,
        height: hostElement.clientHeight,
      });
    };

    updateCanvasSize();

    const observer = new ResizeObserver(() => {
      updateCanvasSize();
    });

    observer.observe(hostElement);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!snapshot || snapshot.messages.length === 0 || !nodesInitialized) {
      return;
    }

    const autoFitTargetId = activeNetId ?? "__active-net__";
    if (lastAutoFitNetIdRef.current === autoFitTargetId) {
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
        lastAutoFitNetIdRef.current = autoFitTargetId;
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
    activeNetId,
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
      !activePathMessageId &&
      latestAssistantMessageId &&
      latestAssistantMessageId !== lastAutoSelectedMessageIdRef.current
    ) {
      lastAutoSelectedMessageIdRef.current = latestAssistantMessageId;
      setSelectedMessageId(latestAssistantMessageId);
      setActivePathMessageId(latestAssistantMessageId);
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
  }, [activePathMessageId, selectedMessageId, setSelectedMessageId, snapshot]);

  useEffect(() => {
    if (!snapshot) {
      setActivePathMessageId(null);
      return;
    }

    if (activePathMessageId && !snapshot.messages.some((message) => message.id === activePathMessageId)) {
      setActivePathMessageId(null);
    }
  }, [activePathMessageId, snapshot]);

  useEffect(() => {
    if (!snapshot) {
      setExpandedBranchIds([]);
      return;
    }

    const liveBranchIds = new Set(snapshot.branches.map((branch) => branch.id));
    setExpandedBranchIds((current) => {
      const next = current.filter((branchId) => branchId !== rootBranchId && liveBranchIds.has(branchId));
      return next.length === current.length && next.every((branchId, index) => branchId === current[index]) ? current : next;
    });
  }, [snapshot]);

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
    if (!snapshot) {
      clearLiveAssistantStates();
      return;
    }

    pruneLiveAssistantStates(snapshot.messages.map((message) => message.id));
  }, [clearLiveAssistantStates, pruneLiveAssistantStates, snapshot]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        activateMessagePath(null);
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
    if (editingNetId && !workspaceNets.some((net) => net.id === editingNetId)) {
      cancelNetRename();
    }
  }, [editingNetId, workspaceNets]);

  useEffect(() => {
    if (openNetMenuId && !workspaceNets.some((net) => net.id === openNetMenuId)) {
      setOpenNetMenuId(null);
    }
  }, [openNetMenuId, workspaceNets]);

  useEffect(() => {
    if (pendingNetDeletion && !workspaceNets.some((net) => net.id === pendingNetDeletion.id)) {
      setPendingNetDeletion(null);
    }
  }, [pendingNetDeletion, workspaceNets]);

  useEffect(() => {
    if (!openNetMenuId) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target;
      if (target instanceof HTMLElement && openNetMenuRef.current?.contains(target)) {
        return;
      }

      setOpenNetMenuId(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenNetMenuId(null);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [openNetMenuId]);

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

  useEffect(() => {
    if (!pendingViewportAction || !snapshot) {
      return;
    }

    const targetAction = pendingViewportAction;
    const targetNode = graph.nodes.find((candidate) => candidate.id === targetAction.messageId) as Node<MessageNodeData> | undefined;
    if (!targetNode) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      if (targetAction.kind === "frame-message-at-top") {
        if (canvasSize.width <= 0 || canvasSize.height <= 0) {
          return;
        }

        const zoom = clamp((canvasSize.width * branchRevealBubbleWidthRatio) / messageNodeWidth, canvasMinZoom, canvasMaxZoom);
        const nextViewport = {
          x: canvasSize.width / 2 - (targetNode.position.x + messageNodeWidth / 2) * zoom,
          y: -targetNode.position.y * zoom,
          zoom,
        } satisfies CanvasViewport;

        void reactFlow.setViewport(nextViewport, {
          duration: 360,
        });
      } else {
        void reactFlow.setCenter(
          targetNode.position.x + messageNodeWidth / 2,
          targetNode.position.y +
            (measuredNodeHeights[targetAction.messageId] ?? estimateMessageBubbleHeight(targetNode.data.message)) / 2,
          {
            duration: 320,
            zoom: Math.max(viewport.zoom, 0.42),
          },
        );
      }

      setPendingViewportAction((current) =>
        current?.kind === targetAction.kind && current.messageId === targetAction.messageId ? null : current,
      );
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [canvasSize.height, canvasSize.width, graph.nodes, measuredNodeHeights, pendingViewportAction, reactFlow, snapshot, viewport.zoom]);

  const isSwitchingNet =
    createNetMutation.isPending ||
    selectNetMutation.isPending ||
    renameNetMutation.isPending ||
    deleteNetMutation.isPending;
  const hasMessages = Boolean(snapshot && snapshot.messages.length > 0);
  const isOnNewNetScreen = !graphQuery.isLoading && !hasMessages;
  const showBubbleComposer = Boolean(selectedMessage && composerAnchor);
  const sendDisabled = composerValue.trim().length === 0 || isThinking || isSwitchingNet || !canSendOnActiveLane;

  function beginOptimisticTurn(optimisticTurn: PendingTurnMetadata) {
    setActiveStreamedTurn({
      turnId: optimisticTurn.turnId,
      assistantMessageId: optimisticTurn.assistantMessageId,
      optimisticSnapshot: optimisticTurn.optimisticSnapshot,
      isPending: true,
    });
    setLiveAssistantState(optimisticTurn.assistantMessageId, optimisticTurn.assistantState);
    setSelectedMessageId(optimisticTurn.assistantMessageId);
    setActivePathMessageId(optimisticTurn.assistantMessageId);
  }

  function handleCreateNet() {
    setOpenNetMenuId(null);
    if (isOnNewNetScreen) {
      return;
    }

    createNetMutation.mutate({ title: "" });
  }

  function submitCurrentPrompt() {
    const prompt = composerValue.trim();
    if (prompt.length === 0) {
      return;
    }

    setComposerValue("");
    setSelectionDraft(null);
    setStreamErrorMessage(null);
    clearBrowserSelection();

    if (sendMode === "root" || sendMode === "continue-root") {
      const optimisticTurn =
        snapshot && rootMachine
          ? buildOptimisticRootStreamTurn(snapshot, {
              machineId: rootMachine.id,
              prompt,
              selectedText: selectionForSelectedMessage?.selectedText ?? null,
            })
          : null;
      if (optimisticTurn) {
        beginOptimisticTurn(optimisticTurn);
      }
      void runStreamedTurn(
        "/api/root-turn/stream",
        {
          method: "POST",
          body: JSON.stringify({
            prompt,
            machineId: rootMachine?.id,
            selectedText: selectionForSelectedMessage?.selectedText,
            clientTurnId: optimisticTurn?.turnId,
            clientUserMessageId: optimisticTurn?.userMessageId,
            clientAssistantMessageId: optimisticTurn?.assistantMessageId,
            clientCreatedAt: optimisticTurn?.createdAt,
          } satisfies CreateRootTurnInput),
        },
        "Root turn",
        optimisticTurn ??
          buildFallbackOptimisticTurn({
            prompt,
            machineId: rootMachine?.id ?? "machine_pending",
            selectedText: selectionForSelectedMessage?.selectedText ?? null,
            snapshot,
          }),
      );
      return;
    }

    if (sendMode === "continue-branch" && selectedBranch) {
      const optimisticTurn =
        snapshot && runtimeMachine
          ? buildOptimisticBranchTurnStreamTurn(snapshot, {
              branchId: selectedBranch.id,
              machineId: runtimeMachine.id,
              prompt,
              selectedText: selectionForSelectedMessage?.selectedText ?? null,
            })
          : null;
      if (optimisticTurn) {
        beginOptimisticTurn(optimisticTurn);
      }
      void runStreamedTurn(
        `/api/branches/${selectedBranch.id}/turns/stream`,
        {
          method: "POST",
          body: JSON.stringify({
            prompt,
            selectedText: selectionForSelectedMessage?.selectedText,
            clientTurnId: optimisticTurn?.turnId,
            clientUserMessageId: optimisticTurn?.userMessageId,
            clientAssistantMessageId: optimisticTurn?.assistantMessageId,
            clientCreatedAt: optimisticTurn?.createdAt,
          } satisfies CreateBranchTurnInput),
        },
        "Branch turn",
        optimisticTurn ??
          buildFallbackOptimisticTurn({
            prompt,
            machineId: runtimeMachine?.id ?? "machine_pending",
            selectedText: selectionForSelectedMessage?.selectedText ?? null,
            snapshot,
          }),
      );
      return;
    }

    if (sendMode === "branch-from-selection" && selectedMessage && selectionForSelectedMessage) {
      const optimisticTurn =
        snapshot && selectedMessage.machineId
          ? buildOptimisticBranchCreationStreamTurn(snapshot, {
              input: {
                sourceMessageId: selectedMessage.id,
                mode: "selection",
                selectedText: selectionForSelectedMessage.selectedText,
                startOffset: selectionForSelectedMessage.startOffset,
                endOffset: selectionForSelectedMessage.endOffset,
                prompt,
              } satisfies CreateBranchInput,
            })
          : null;
      if (optimisticTurn) {
        if (optimisticTurn.branchId) {
          setExpandedBranchIds((current) =>
            current.includes(optimisticTurn.branchId!) ? current : [...current, optimisticTurn.branchId!],
          );
        }
        beginOptimisticTurn(optimisticTurn);
      }
      void runStreamedTurn(
        "/api/branches/stream",
        {
          method: "POST",
          body: JSON.stringify({
            sourceMessageId: selectedMessage.id,
            mode: "selection",
            selectedText: selectionForSelectedMessage.selectedText,
            startOffset: selectionForSelectedMessage.startOffset,
            endOffset: selectionForSelectedMessage.endOffset,
            prompt,
            clientTurnId: optimisticTurn?.turnId,
            clientUserMessageId: optimisticTurn?.userMessageId,
            clientAssistantMessageId: optimisticTurn?.assistantMessageId,
            clientCreatedAt: optimisticTurn?.createdAt,
            clientBranchId: optimisticTurn?.branchId,
          } satisfies CreateBranchInput),
        },
        "Branch creation",
        optimisticTurn ??
          buildFallbackOptimisticTurn({
            prompt,
            machineId: selectedMessage.machineId ?? "machine_pending",
            selectedText: selectionForSelectedMessage.selectedText,
            snapshot,
          }),
      );
      return;
    }

    if (sendMode === "branch-from-message" && selectedMessage) {
      const optimisticTurn =
        snapshot && selectedMessage.machineId
          ? buildOptimisticBranchCreationStreamTurn(snapshot, {
              input: {
                sourceMessageId: selectedMessage.id,
                mode: "message",
                prompt,
              } satisfies CreateBranchInput,
            })
          : null;
      if (optimisticTurn) {
        beginOptimisticTurn(optimisticTurn);
      }
      void runStreamedTurn(
        "/api/branches/stream",
        {
          method: "POST",
          body: JSON.stringify({
            sourceMessageId: selectedMessage.id,
            mode: "message",
            prompt,
            clientTurnId: optimisticTurn?.turnId,
            clientUserMessageId: optimisticTurn?.userMessageId,
            clientAssistantMessageId: optimisticTurn?.assistantMessageId,
            clientCreatedAt: optimisticTurn?.createdAt,
            clientBranchId: optimisticTurn?.branchId,
          } satisfies CreateBranchInput),
        },
        "Branch creation",
        optimisticTurn ??
          buildFallbackOptimisticTurn({
            prompt,
            machineId: selectedMessage.machineId ?? "machine_pending",
            selectedText: null,
            snapshot,
          }),
      );
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
  const workspaceName = resolveWorkspaceName(workingDirectoryPath);
  const composerPlaceholder = selectedMessage
    ? selectionForSelectedMessage
      ? "Ask about the selected text in this context..."
      : sendMode === "branch-from-message"
        ? "Start a branch from this reply..."
        : "Continue from this reply..."
    : "Start the first turn...";
  const composerErrorMessage =
    activeStreamedTurn && !activeStreamedTurn.isPending
      ? liveAssistantStates[activeStreamedTurn.assistantMessageId]?.errorMessage ?? streamErrorMessage
      : streamErrorMessage;
  const netErrorMessage = formatErrorMessage(
    createNetMutation.error ??
      selectNetMutation.error ??
      renameNetMutation.error ??
      deleteNetMutation.error,
  );
  const pendingDeletionNetId = pendingNetDeletion?.id ?? null;
  const isConfirmingDeletion = deleteNetMutation.isPending && deleteNetMutation.variables === pendingDeletionNetId;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--bg-cream)] text-[var(--text-main)]">
      <div ref={canvasHostRef} className="relative flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-[linear-gradient(180deg,rgba(244,241,234,0.92)_0%,rgba(244,241,234,0)_100%)]" />

        <div className="pointer-events-none absolute right-6 top-6 z-20 flex flex-col items-end gap-3">
          <div className="pointer-events-auto w-[min(320px,calc(100vw-3rem))] border border-[var(--text-main)] bg-white shadow-[10px_10px_0_rgba(26,26,26,0.08)]">
            <div className="border-b border-[var(--node-border)] px-5 py-4">
              <div className="flex items-start justify-between gap-4 text-[15px] font-medium leading-6">
                <div className="flex min-w-0 items-center gap-2 text-[var(--text-main)]">
                  <span>Claude Code</span>
                  <span
                    className={cn(
                      "inline-flex h-2.5 w-2.5 rounded-full border border-[rgba(26,26,26,0.16)]",
                      connectionStatus.tone === "connected"
                        ? "bg-[var(--block-green)]"
                        : connectionStatus.tone === "connecting"
                          ? "animate-pulse bg-[var(--block-ochre)]"
                          : "bg-rose-500",
                    )}
                    title={connectionStatus.label}
                  />
                </div>
                <div
                  className="max-w-[128px] truncate text-right text-[rgba(26,26,26,0.66)]"
                  title={workingDirectoryPath}
                >
                  {workspaceName}
                </div>
              </div>

              <div className="mt-5 text-center text-[22px] font-medium leading-8 text-[var(--text-main)]">
                {activeNet?.title ?? "Loading..."}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-px bg-[var(--node-border)]">
              <button
                type="button"
                className="bg-white px-5 py-4 text-left text-[15px] font-medium text-[var(--text-main)] transition-colors hover:bg-[var(--bg-cream)] disabled:cursor-not-allowed disabled:text-[rgba(26,26,26,0.38)]"
                disabled={workspaceQuery.isLoading}
                onClick={() => {
                  setOpenNetMenuId(null);
                  setShowNetHistory((open) => !open);
                }}
              >
                {showNetHistory ? "Hide history" : "History nets"}
              </button>
              <button
                type="button"
                className="bg-white px-5 py-4 text-left text-[15px] font-medium text-[var(--text-main)] transition-colors hover:bg-[var(--bg-cream)] disabled:cursor-not-allowed disabled:text-[rgba(26,26,26,0.38)]"
                disabled={isSwitchingNet || workspaceQuery.isLoading}
                onClick={handleCreateNet}
              >
                {createNetMutation.isPending ? "Creating..." : "New net"}
              </button>
            </div>

            {netErrorMessage ? (
              <div className="border-t border-rose-200 bg-rose-50 px-5 py-4 text-sm leading-6 text-rose-700">
                {netErrorMessage}
              </div>
            ) : null}
          </div>

          {showNetHistory ? (
            <div className="pointer-events-auto w-[min(320px,calc(100vw-3rem))] border border-[var(--text-main)] bg-white shadow-[10px_10px_0_rgba(26,26,26,0.08)]">
              <div className="border-b border-[var(--node-border)] px-5 py-4 text-[17px] font-medium text-[var(--text-main)]">
                History nets
              </div>

              <div className="max-h-[360px] overflow-y-auto">
                {workspaceQuery.isLoading ? (
                  <div className="px-5 py-5 text-[16px] leading-7 text-[rgba(26,26,26,0.62)]">
                    Loading workspace nets...
                  </div>
                ) : workspaceNets.length ? (
                  workspaceNets.map((net) => {
                    const isActiveNet = net.id === activeNetId;
                    const isEditingNet = editingNetId === net.id;
                    const isMenuOpen = openNetMenuId === net.id;
                    const isRenamingNet = renameNetMutation.isPending && renameNetMutation.variables?.netId === net.id;
                    const isDeletingNet = deleteNetMutation.isPending && deleteNetMutation.variables === net.id;
                    const latestMessageLabel = formatLatestMessageTime(net.latestMessageAt);
                    return (
                      <div
                        key={net.id}
                        className={cn(
                          "border-b border-[var(--node-border)] px-5 py-4 transition-colors last:border-b-0",
                          isActiveNet ? "bg-[var(--block-slate)] text-white" : "bg-white hover:bg-[var(--bg-cream)]",
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            {isEditingNet ? (
                              <div className="space-y-3">
                                <Input
                                  autoFocus
                                  className="h-11 rounded-none border-[var(--text-main)] px-3 text-[17px] font-medium shadow-none focus:border-[var(--text-main)]"
                                  disabled={isRenamingNet}
                                  maxLength={120}
                                  value={editingNetTitle}
                                  onChange={(event) => setEditingNetTitle(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                      event.preventDefault();
                                      submitNetRename(net.id, net.title);
                                    }

                                    if (event.key === "Escape") {
                                      event.preventDefault();
                                      cancelNetRename();
                                    }
                                  }}
                                />
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    className="border border-[var(--text-main)] bg-[var(--text-main)] px-3 py-2 text-[14px] font-medium text-white transition-colors hover:bg-[var(--block-slate)] disabled:cursor-not-allowed disabled:bg-[rgba(26,26,26,0.42)]"
                                    disabled={isRenamingNet || editingNetTitle.trim().length === 0}
                                    onClick={() => submitNetRename(net.id, net.title)}
                                  >
                                    {isRenamingNet ? "Saving..." : "Save"}
                                  </button>
                                  <button
                                    type="button"
                                    className="border border-[var(--node-border)] bg-white px-3 py-2 text-[14px] font-medium text-[rgba(26,26,26,0.72)] transition-colors hover:bg-[var(--bg-cream)]"
                                    disabled={isRenamingNet}
                                    onClick={cancelNetRename}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="block w-full text-left disabled:cursor-not-allowed"
                                disabled={isSwitchingNet || isActiveNet}
                                onClick={() => selectNetMutation.mutate(net.id)}
                              >
                                <div className={cn("truncate text-[17px] font-medium leading-7", isActiveNet ? "text-white" : "text-[var(--text-main)]")}>
                                  {net.title}
                                </div>
                                <div
                                  className={cn(
                                    "mt-1 text-[14px] leading-6",
                                    isActiveNet ? "text-white/64" : "text-[rgba(26,26,26,0.56)]",
                                  )}
                                >
                                  {latestMessageLabel ?? "No messages yet"}
                                </div>
                              </button>
                            )}
                          </div>

                          {isEditingNet ? null : (
                            <div
                              ref={isMenuOpen ? openNetMenuRef : null}
                              className="relative shrink-0"
                              data-net-actions-root
                            >
                              <button
                                type="button"
                                className={cn(
                                  "inline-flex h-9 w-9 items-center justify-center border transition-colors disabled:cursor-not-allowed",
                                  isActiveNet
                                    ? "border-white/18 bg-white/8 text-white hover:bg-white/14 disabled:text-white/36"
                                    : "border-[var(--node-border)] bg-white text-[rgba(26,26,26,0.66)] hover:bg-[var(--bg-cream)] disabled:text-[rgba(26,26,26,0.32)]",
                                )}
                                disabled={isSwitchingNet}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setOpenNetMenuId((current) => (current === net.id ? null : net.id));
                                }}
                              >
                                <MoreHorizontal className="size-4" />
                              </button>
                              {isMenuOpen ? (
                                <div className="absolute right-0 top-full z-30 mt-2 w-36 border border-[var(--text-main)] bg-white shadow-[8px_8px_0_rgba(26,26,26,0.08)]">
                                  <button
                                    type="button"
                                    className="block w-full border-b border-[var(--node-border)] px-4 py-3 text-left text-[15px] font-medium text-[var(--text-main)] transition-colors hover:bg-[var(--bg-cream)] disabled:cursor-not-allowed disabled:text-[rgba(26,26,26,0.32)]"
                                    disabled={isSwitchingNet || isDeletingNet}
                                    onClick={() => beginNetRename(net.id, net.title)}
                                  >
                                    Rename
                                  </button>
                                  <button
                                    type="button"
                                    className="block w-full px-4 py-3 text-left text-[15px] font-medium text-rose-700 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:text-rose-300"
                                    disabled={isSwitchingNet || isDeletingNet}
                                    onClick={() => requestNetDeletion(net.id, net.title)}
                                  >
                                    {isDeletingNet ? "Deleting..." : "Delete"}
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="px-5 py-5 text-[16px] leading-7 text-[rgba(26,26,26,0.62)]">
                    This workspace does not have any saved nets yet.
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>

        <ReactFlow
          className="netchat-flow canvas-flow h-full w-full bg-[var(--bg-cream)]"
          nodes={graph.nodes}
          edges={graph.edges}
          onNodeClick={(_event, node) => {
            const selectedText = window.getSelection()?.toString().trim();
            const message = (node.data as MessageNodeData | undefined)?.message;
            if (message?.role === "assistant" && !selectedText) {
              pickMessage(node.id);
            }
          }}
          nodeTypes={nodeTypes}
          minZoom={canvasMinZoom}
          maxZoom={canvasMaxZoom}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          onPaneClick={() => {
            activateMessagePath(null);
            setSelectedMessageId(null);
            setSelectionDraft(null);
            clearBrowserSelection();
          }}
          panOnDrag
          zoomOnDoubleClick={false}
        >
          <Background gap={96} size={1} color="var(--line-color)" />
        </ReactFlow>

        {graph.nodes.length > 0 ? (
          <CanvasThumbnail
            canvasSize={canvasSize}
            measuredNodeHeights={measuredNodeHeights}
            nodes={graph.nodes as Node<MessageNodeData>[]}
            viewport={viewport}
            onViewportChange={(nextViewport) => {
              void reactFlow.setViewport(nextViewport, { duration: 0 });
            }}
          />
        ) : null}

        {graphQuery.isLoading ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4">
            <div className="border border-[var(--text-main)] bg-white px-6 py-4 text-sm tracking-[0.08em] text-[rgba(26,26,26,0.62)] shadow-[8px_8px_0_rgba(26,26,26,0.08)]">
              Loading conversation canvas...
            </div>
          </div>
        ) : null}

        {!graphQuery.isLoading && !hasMessages ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6 py-8">
            <form className="pointer-events-auto w-full max-w-[920px]" onSubmit={handleSubmit}>
              <div className="relative border border-[var(--text-main)] bg-white px-7 py-6 shadow-[14px_14px_0_rgba(26,26,26,0.08)]">
                <Textarea
                  ref={composerRef}
                  className="!min-h-[188px] resize-none !rounded-none !border-0 !bg-transparent !px-0 !py-0 !pb-16 !pr-20 text-[20px] font-medium leading-10 text-[var(--text-main)] shadow-none placeholder:font-normal placeholder:text-[rgba(26,26,26,0.34)] focus-visible:ring-0"
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
                <div
                  className="pointer-events-none absolute bottom-6 left-7 max-w-[calc(100%-7.5rem)] truncate text-[14px] leading-6 text-[rgba(26,26,26,0.46)]"
                  title={workingDirectoryPath}
                >
                  {truncateMiddle(workingDirectoryPath, 88)}
                </div>
                <Button
                  className="absolute bottom-4 right-4 h-12 w-12 rounded-none border border-[var(--text-main)] bg-[var(--text-main)] px-0 text-white shadow-none hover:bg-[var(--block-slate)]"
                  disabled={sendDisabled}
                  type="submit"
                >
                  <ArrowUp className="size-4" />
                </Button>
              </div>

              {composerErrorMessage ? (
                <div className="border-x border-b border-rose-200 bg-rose-50 px-7 py-4 text-sm leading-6 text-rose-700">
                  {composerErrorMessage}
                </div>
              ) : null}
            </form>
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
                  <div className="text-[14px] font-medium leading-6 text-white/72">User</div>
                  <div className="mt-2 break-words text-[17px] italic leading-9 text-white/82">
                    {`“${truncate(selectionForSelectedMessage.selectedText, 160)}”`}
                  </div>
                </div>
              ) : null}

              <div className="relative px-6 py-5">
                <Textarea
                  ref={composerRef}
                  className="!min-h-[126px] resize-none !rounded-none !border-0 !bg-transparent !px-0 !py-0 !pb-4 !pr-20 text-[19px] font-medium leading-10 text-white shadow-none placeholder:font-normal placeholder:text-white/48 focus-visible:ring-0"
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
                  <ArrowUp className="size-4" />
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

        {pendingNetDeletion ? (
          <div
            className="pointer-events-auto fixed inset-0 z-40 flex items-center justify-center bg-[rgba(26,26,26,0.2)] px-6"
            onClick={cancelNetDeletion}
          >
            <div
              className="w-full max-w-[420px] border border-[var(--text-main)] bg-white shadow-[14px_14px_0_rgba(26,26,26,0.1)]"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="border-b border-[var(--node-border)] px-6 py-5">
                <div className="text-[20px] font-medium leading-8 text-[var(--text-main)]">Delete net?</div>
              </div>

              <div className="px-6 py-5 text-[17px] leading-8 text-[rgba(26,26,26,0.76)]">
                Delete "{pendingNetDeletion.title}" from history?
              </div>

              <div className="grid grid-cols-2 gap-px bg-[var(--node-border)]">
                <button
                  type="button"
                  className="bg-white px-5 py-4 text-left text-[15px] font-medium text-[var(--text-main)] transition-colors hover:bg-[var(--bg-cream)] disabled:cursor-not-allowed disabled:text-[rgba(26,26,26,0.38)]"
                  disabled={isConfirmingDeletion}
                  onClick={cancelNetDeletion}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="bg-rose-50 px-5 py-4 text-left text-[15px] font-medium text-rose-700 transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:text-rose-300"
                  disabled={isConfirmingDeletion}
                  onClick={confirmNetDeletion}
                >
                  {isConfirmingDeletion ? "Deleting..." : "Delete"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CanvasThumbnail({
  nodes,
  measuredNodeHeights,
  viewport,
  canvasSize,
  onViewportChange,
}: {
  nodes: Node<MessageNodeData>[];
  measuredNodeHeights: Record<string, number>;
  viewport: CanvasViewport;
  canvasSize: { width: number; height: number };
  onViewportChange: (viewport: CanvasViewport) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [dragState, setDragState] = useState<{ offsetX: number; offsetY: number } | null>(null);
  const thumbnailWidth = 248;
  const thumbnailHeight = 176;

  const bounds = useMemo(() => {
    if (nodes.length === 0) {
      return null;
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const node of nodes) {
      const data = node.data as MessageNodeData | undefined;
      const messageHeight =
        measuredNodeHeights[node.id] ??
        (data?.message ? estimateMessageBubbleHeight(data.message) : 240);

      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + messageNodeWidth);
      maxY = Math.max(maxY, node.position.y + messageHeight);
    }

    const paddedMinX = minX - 180;
    const paddedMinY = minY - 140;
    const paddedMaxX = maxX + 180;
    const paddedMaxY = maxY + 140;

    return {
      minX: paddedMinX,
      minY: paddedMinY,
      maxX: paddedMaxX,
      maxY: paddedMaxY,
      width: Math.max(1, paddedMaxX - paddedMinX),
      height: Math.max(1, paddedMaxY - paddedMinY),
    };
  }, [measuredNodeHeights, nodes]);

  const thumbnailGeometry = useMemo(() => {
    if (!bounds) {
      return null;
    }

    const scale = Math.min(thumbnailWidth / bounds.width, thumbnailHeight / bounds.height);
    const contentWidth = bounds.width * scale;
    const contentHeight = bounds.height * scale;

    return {
      scale,
      offsetX: (thumbnailWidth - contentWidth) / 2,
      offsetY: (thumbnailHeight - contentHeight) / 2,
    };
  }, [bounds, thumbnailHeight, thumbnailWidth]);

  const viewportRect = useMemo(() => {
    if (!bounds || !thumbnailGeometry || canvasSize.width <= 0 || canvasSize.height <= 0 || viewport.zoom <= 0) {
      return null;
    }

    const flowLeft = -viewport.x / viewport.zoom;
    const flowTop = -viewport.y / viewport.zoom;
    const flowWidth = canvasSize.width / viewport.zoom;
    const flowHeight = canvasSize.height / viewport.zoom;

    return {
      left: thumbnailGeometry.offsetX + (flowLeft - bounds.minX) * thumbnailGeometry.scale,
      top: thumbnailGeometry.offsetY + (flowTop - bounds.minY) * thumbnailGeometry.scale,
      width: flowWidth * thumbnailGeometry.scale,
      height: flowHeight * thumbnailGeometry.scale,
      flowLeft,
      flowTop,
      flowWidth,
      flowHeight,
    };
  }, [bounds, canvasSize.height, canvasSize.width, thumbnailGeometry, viewport.x, viewport.y, viewport.zoom]);

  const flowPointFromClient = useCallback(
    (clientX: number, clientY: number) => {
      if (!bounds || !thumbnailGeometry || !frameRef.current) {
        return null;
      }

      const rect = frameRef.current.getBoundingClientRect();
      const localX = clamp(clientX - rect.left, 0, rect.width);
      const localY = clamp(clientY - rect.top, 0, rect.height);

      return {
        x: bounds.minX + (localX - thumbnailGeometry.offsetX) / thumbnailGeometry.scale,
        y: bounds.minY + (localY - thumbnailGeometry.offsetY) / thumbnailGeometry.scale,
      };
    },
    [bounds, thumbnailGeometry],
  );

  const moveViewport = useCallback(
    (flowLeft: number, flowTop: number) => {
      if (!bounds || !viewportRect) {
        return;
      }

      const nextLeft = clamp(flowLeft, bounds.minX, Math.max(bounds.minX, bounds.maxX - viewportRect.flowWidth));
      const nextTop = clamp(flowTop, bounds.minY, Math.max(bounds.minY, bounds.maxY - viewportRect.flowHeight));

      onViewportChange({
        x: -nextLeft * viewport.zoom,
        y: -nextTop * viewport.zoom,
        zoom: viewport.zoom,
      });
    },
    [bounds, onViewportChange, viewport.zoom, viewportRect],
  );

  useEffect(() => {
    if (!dragState) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const flowPoint = flowPointFromClient(event.clientX, event.clientY);
      if (!flowPoint) {
        return;
      }

      moveViewport(flowPoint.x - dragState.offsetX, flowPoint.y - dragState.offsetY);
    };

    const handlePointerUp = () => {
      setDragState(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragState, flowPointFromClient, moveViewport]);

  if (!bounds || !thumbnailGeometry || !viewportRect) {
    return null;
  }

  const beginThumbnailDrag = (clientX: number, clientY: number, lockToViewport: boolean) => {
    const flowPoint = flowPointFromClient(clientX, clientY);
    if (!flowPoint) {
      return;
    }

    const offsetX = lockToViewport ? flowPoint.x - viewportRect.flowLeft : viewportRect.flowWidth / 2;
    const offsetY = lockToViewport ? flowPoint.y - viewportRect.flowTop : viewportRect.flowHeight / 2;

    moveViewport(flowPoint.x - offsetX, flowPoint.y - offsetY);
    setDragState({ offsetX, offsetY });
  };

  return (
    <div className="pointer-events-none absolute bottom-6 right-6 z-20">
      <div className="pointer-events-auto border border-[var(--text-main)] bg-white p-2 shadow-[10px_10px_0_rgba(26,26,26,0.08)]">
        <div
          ref={frameRef}
          className={cn(
            "relative overflow-hidden bg-[rgba(244,241,234,0.78)]",
            dragState ? "cursor-grabbing" : "cursor-grab",
          )}
          style={{ width: thumbnailWidth, height: thumbnailHeight }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();

            const lockToViewport = Boolean((event.target as HTMLElement).closest("[data-thumbnail-viewport=\"true\"]"));
            beginThumbnailDrag(event.clientX, event.clientY, lockToViewport);
          }}
        >
          {nodes.map((node) => {
            const data = node.data as MessageNodeData | undefined;
            const height =
              measuredNodeHeights[node.id] ??
              (data?.message ? estimateMessageBubbleHeight(data.message) : 240);
            const left = thumbnailGeometry.offsetX + (node.position.x - bounds.minX) * thumbnailGeometry.scale;
            const top = thumbnailGeometry.offsetY + (node.position.y - bounds.minY) * thumbnailGeometry.scale;
            const width = messageNodeWidth * thumbnailGeometry.scale;
            const scaledHeight = height * thumbnailGeometry.scale;
            const message = data?.message;
            const isAssistant = message?.role === "assistant";

            return (
              <div
                key={node.id}
                className="pointer-events-none absolute border"
                style={{
                  left,
                  top,
                  width,
                  height: scaledHeight,
                  borderColor:
                    data?.persistedAssistantState?.status === "error"
                      ? "#BE185D"
                      : isAssistant
                        ? "#3E4E42"
                        : "#3A4042",
                  borderTopWidth: Math.max(1, Math.round(4 * thumbnailGeometry.scale)),
                  backgroundColor: isAssistant ? "rgba(255,255,255,0.9)" : "rgba(247,247,242,0.96)",
                  opacity: 0.96,
                }}
              />
            );
          })}

          <div
            data-thumbnail-viewport="true"
            className="pointer-events-none absolute border-2 border-[rgba(26,26,26,0.8)] bg-[rgba(26,26,26,0.08)] transition-colors"
            style={{
              left: viewportRect.left,
              top: viewportRect.top,
              width: Math.max(24, viewportRect.width),
              height: Math.max(24, viewportRect.height),
            }}
          />
        </div>
      </div>
    </div>
  );
}

function MessageGraphNode({ data }: NodeProps<Node<MessageNodeData>>) {
  const isUser = data.message.role === "user";
  const roleLabel = isUser ? "User" : "Claude";
  const bubbleRef = useRef<HTMLDivElement>(null);
  const sessionIdLabel = data.message.sessionId ?? "pending";
  const liveAssistantState = useLiveAssistantStateStore((state) =>
    !isUser ? (state.statesByMessageId[data.message.id] ?? data.persistedAssistantState ?? null) : null,
  );
  const responseContent = !isUser
    ? liveAssistantState?.responseText || data.message.content
    : data.message.content;
  const canSelectAssistantResponse = !liveAssistantState || liveAssistantState.status === "complete";
  const showPendingAssistantState =
    !isUser && liveAssistantState && (liveAssistantState.status === "pending" || liveAssistantState.status === "streaming");
  const shouldFreezeMeasuredHeight = showPendingAssistantState;
  const visibleAssistantBlocks =
    liveAssistantState?.blocks.filter((block) =>
      block.kind === "thinking"
        ? block.text.trim().length > 0
        : block.inputText.trim().length > 0 || block.outputText.trim().length > 0 || block.status === "error",
    ) ?? [];
  const selectedPassage = isUser ? data.message.selectedText?.trim() ?? "" : "";

  useEffect(() => {
    const bubbleElement = bubbleRef.current;
    if (!bubbleElement) {
      return;
    }

    const reportHeight = () => {
      data.onMeasureHeight(data.message.id, bubbleElement.offsetHeight);
    };

    reportHeight();

    if (shouldFreezeMeasuredHeight) {
      return;
    }

    const observer = new ResizeObserver(() => {
      reportHeight();
    });

    observer.observe(bubbleElement);

    return () => {
      observer.disconnect();
    };
  }, [data.message.id, data.onMeasureHeight, shouldFreezeMeasuredHeight]);

  return (
    <div className="relative" style={{ width: messageNodeWidth }}>
      {data.showSessionId ? (
        <div
          className={cn(
            "pointer-events-none absolute top-1/2 z-10 max-w-[164px] -translate-y-1/2",
            data.sessionLabelSide === "left" ? "right-full mr-4 text-right" : "left-full ml-4 text-left",
          )}
          title={sessionIdLabel}
        >
          <div className="editorial-meta text-[rgba(26,26,26,0.38)]">session_id</div>
          <div className="mt-2 break-all font-mono text-[12px] leading-6 text-[rgba(26,26,26,0.68)]">
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
          "group relative overflow-hidden border border-[var(--node-border)] border-t-[4px] bg-white text-left shadow-[8px_8px_0_rgba(26,26,26,0.08)] transition-all",
          isUser
            ? data.isActiveMessage
              ? "border-t-[var(--block-slate)] bg-[rgba(247,247,242,0.98)] shadow-[12px_12px_0_rgba(58,64,66,0.12)]"
              : "border-t-[var(--block-slate)]"
            : liveAssistantState?.status === "error"
              ? "border-dashed border-rose-300 border-t-rose-500 bg-rose-50 shadow-[10px_10px_0_rgba(190,24,93,0.1)]"
            : showPendingAssistantState
              ? "border-dashed border-[var(--block-ochre)] border-t-[var(--block-ochre)] bg-[rgba(255,249,242,0.98)] shadow-[10px_10px_0_rgba(194,142,85,0.12)]"
            : data.hasSelectionDraft
              ? "border-t-[var(--block-ochre)] bg-[rgba(255,249,242,0.98)] shadow-[10px_10px_0_rgba(194,142,85,0.14)]"
            : data.isActiveMessage
              ? "border-t-[var(--block-green)] bg-[rgba(247,247,242,0.98)] shadow-[12px_12px_0_rgba(62,78,66,0.16)]"
              : "border-t-[var(--block-green)] hover:-translate-y-0.5",
        )}
        style={{ width: messageNodeWidth }}
        onClickCapture={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("[data-selection-anchor=\"true\"]")) {
            return;
          }

          if (target.closest("[data-stream-block=\"true\"]")) {
            event.stopPropagation();
            return;
          }

          const selectedText = window.getSelection()?.toString().trim();
          if (!isUser && !selectedText) {
            data.onPickMessage(data.message.id);
          }
          event.stopPropagation();
        }}
        onMouseDownCapture={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("[data-selection-anchor=\"true\"]")) {
            return;
          }

          if (target.closest("[data-stream-block=\"true\"]")) {
            event.stopPropagation();
            return;
          }

          event.stopPropagation();
        }}
        onPointerDownCapture={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("[data-selection-anchor=\"true\"]")) {
            return;
          }

          if (target.closest("[data-stream-block=\"true\"]")) {
            event.stopPropagation();
            return;
          }

          event.stopPropagation();
        }}
      >
        <div className="relative flex items-start justify-between gap-4 border-b border-[var(--node-border)] px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  "editorial-meta",
                  isUser
                    ? "text-[rgba(58,64,66,0.72)]"
                    : showPendingAssistantState || data.hasSelectionDraft
                      ? "text-[var(--block-ochre)]"
                      : liveAssistantState?.status === "error"
                        ? "text-rose-700"
                        : "text-[var(--block-green)]",
                )}
              >
                {roleLabel}
              </div>
              {showPendingAssistantState ? <LoaderCircle className="size-3.5 animate-spin text-[var(--block-ochre)]" /> : null}
            </div>
            {isUser && selectedPassage ? (
              <div className="mt-2 break-words whitespace-pre-wrap text-[14px] italic leading-6 text-[rgba(26,26,26,0.56)]">
                {`"${selectedPassage}"`}
              </div>
            ) : null}
          </div>
          <div className="shrink-0 editorial-meta text-[rgba(26,26,26,0.42)]">
            {formatMessageTime(data.message.createdAt)}
          </div>
        </div>

        <div className="relative px-5 py-5">
          {!isUser && liveAssistantState ? (
            <div className="space-y-4">
              {visibleAssistantBlocks.map((block) => (
                <details
                  key={block.id}
                  data-stream-block="true"
                  className="border border-[var(--node-border)] bg-[rgba(244,241,234,0.5)]"
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 border-b border-[var(--node-border)] px-4 py-3">
                    <span className="editorial-meta text-[rgba(26,26,26,0.66)]">
                      {block.kind === "thinking" ? "Thinking" : `Tool · ${block.toolName}`}
                    </span>
                    <span
                      className={cn(
                        "editorial-meta",
                        block.kind === "thinking"
                          ? block.status === "complete"
                            ? "text-[rgba(26,26,26,0.44)]"
                            : "text-[var(--block-ochre)]"
                          : block.status === "error"
                            ? "text-rose-700"
                            : block.status === "complete"
                              ? "text-[rgba(26,26,26,0.44)]"
                              : "text-[var(--block-ochre)]",
                      )}
                    >
                      {block.status === "error"
                        ? "Error"
                        : block.status === "complete"
                          ? "Complete"
                          : "Streaming"}
                    </span>
                  </summary>
                  <div className="space-y-3 px-4 py-4">
                    {block.kind === "thinking" ? (
                      <div className="message-copy whitespace-pre-wrap text-[17px] leading-8 text-[rgba(26,26,26,0.78)]">
                        {block.text || "Claude is thinking..."}
                      </div>
                    ) : (
                      <>
                        <div>
                          <div className="editorial-meta text-[rgba(26,26,26,0.44)]">Tool input</div>
                          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap border border-[var(--node-border)] bg-white px-3 py-3 text-[14px] leading-7 text-[rgba(26,26,26,0.78)]">
                            {block.inputText || "Waiting for tool arguments..."}
                          </pre>
                        </div>
                        {block.outputText ? (
                          <div>
                            <div className="editorial-meta text-[rgba(26,26,26,0.44)]">
                              {block.isError ? "Tool error" : "Tool result"}
                            </div>
                            <pre
                              className={cn(
                                "mt-2 overflow-x-auto whitespace-pre-wrap border px-3 py-3 text-[14px] leading-7",
                                block.isError
                                  ? "border-rose-200 bg-rose-50 text-rose-700"
                                  : "border-[var(--node-border)] bg-white text-[rgba(26,26,26,0.78)]",
                              )}
                            >
                              {block.outputText}
                            </pre>
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                </details>
              ))}

              <div
                className={cn(
                  "border px-4 py-4",
                  showPendingAssistantState
                    ? "border-dashed border-[var(--block-ochre)] bg-[rgba(255,249,242,0.72)]"
                    : liveAssistantState.status === "error"
                      ? "border-rose-200 bg-rose-50"
                      : "border-[var(--node-border)] bg-white",
                )}
              >
                <div className="editorial-meta text-[rgba(26,26,26,0.44)]">Response</div>
                <div className="mt-3">
                  {responseContent ? (
                    <SelectableMessage
                      nodeId={data.message.id}
                      content={responseContent}
                      anchors={data.selectionAnchors}
                      disabled={!canSelectAssistantResponse}
                      renderMarkdown
                      onToggleAnchor={data.onToggleSelectionAnchor}
                      onSelection={(draft) => data.onSelectionDraft({ ...draft, sourceMessageId: data.message.id })}
                    />
                  ) : (
                    <div className="flex min-h-[72px] items-center gap-3 text-[17px] leading-8 text-[rgba(26,26,26,0.58)]">
                      <LoaderCircle className="size-4 animate-spin text-[var(--block-ochre)]" />
                      <span>Waiting for Claude to respond…</span>
                    </div>
                  )}
                </div>
              </div>

              {liveAssistantState.errorMessage ? (
                <div className="border border-rose-200 bg-rose-50 px-4 py-3 text-[15px] leading-7 text-rose-700">
                  {liveAssistantState.errorMessage}
                </div>
              ) : null}
            </div>
          ) : (
            <SelectableMessage
              nodeId={data.message.id}
              content={responseContent}
              anchors={data.selectionAnchors}
              disabled={isUser}
              renderMarkdown={!isUser}
              onToggleAnchor={data.onToggleSelectionAnchor}
              onSelection={(draft) => data.onSelectionDraft({ ...draft, sourceMessageId: data.message.id })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SelectableMessage({
  nodeId,
  content,
  anchors,
  disabled,
  renderMarkdown,
  onToggleAnchor,
  onSelection,
}: {
  nodeId: string;
  content: string;
  anchors: MessageSelectionAnchor[];
  disabled: boolean;
  renderMarkdown: boolean;
  onToggleAnchor: (anchor: MessageSelectionAnchor) => void;
  onSelection: (draft: Omit<SelectionDraft, "sourceMessageId">) => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const updateNodeInternals = useUpdateNodeInternals();
  const renderableAnchors = useMemo(() => getRenderableSelectionAnchors(content, anchors), [anchors, content]);
  const hasAnchors = renderableAnchors.length > 0;
  const [positionedAnchors, setPositionedAnchors] = useState<PositionedSelectionAnchor[]>([]);

  useEffect(() => {
    if (!hasAnchors || !contentRef.current) {
      setPositionedAnchors([]);
      return;
    }

    const container = contentRef.current;
    const updateLayout = () => {
      setPositionedAnchors((current) => {
        const previousLayoutById = new Map(
          current.map((anchor) => [
            anchor.id,
            {
              side: anchor.side,
              top: anchor.top,
            },
          ]),
        );
        const next = buildSelectionAnchorGutterLayout(container, renderableAnchors, previousLayoutById);
        return arePositionedSelectionAnchorsEqual(current, next) ? current : next;
      });
    };

    updateLayout();

    const frame = window.requestAnimationFrame(updateLayout);
    const observer = new ResizeObserver(updateLayout);
    observer.observe(container);
    window.addEventListener("resize", updateLayout);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", updateLayout);
    };
  }, [hasAnchors, renderableAnchors]);

  const positionedAnchorsById = useMemo(() => new Map(positionedAnchors.map((anchor) => [anchor.id, anchor])), [positionedAnchors]);
  const anchorsForRender = renderableAnchors.map((anchor, index) => {
    const positioned = positionedAnchorsById.get(anchor.id);
    if (positioned) {
      return positioned;
    }

    return {
      ...anchor,
      side: index % 2 === 0 ? ("left" as const) : ("right" as const),
      top: 30 + index * 36,
    };
  });
  const leftAnchors = anchorsForRender.filter((anchor) => anchor.side === "left");
  const rightAnchors = anchorsForRender.filter((anchor) => anchor.side === "right");

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      updateNodeInternals(nodeId);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [anchorsForRender, nodeId, updateNodeInternals]);

  return (
    <div
      className={cn(
        "message-copy text-[19px] font-medium leading-10 text-[var(--text-main)] selection:bg-[rgba(194,142,85,0.24)] selection:text-[var(--text-main)]",
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

        if ((event.target as HTMLElement).closest("[data-selection-anchor=\"true\"]")) {
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

        const selectionContainer = contentRef.current;
        if (!selectionContainer) {
          return;
        }

        const range = selection.getRangeAt(0);
        if (!selectionContainer.contains(range.commonAncestorContainer)) {
          return;
        }

        const leadingWhitespace = rawText.match(/^\s*/)?.[0].length ?? 0;
        const trailingWhitespace = rawText.match(/\s*$/)?.[0].length ?? 0;
        const textNodes = collectTextNodes(selectionContainer);
        const rawStartOffsetFromTextNodes = resolveTextOffsetFromBoundaryTextNode(
          textNodes,
          range.startContainer,
          range.startOffset,
        );
        const rawEndOffsetFromTextNodes = resolveTextOffsetFromBoundaryTextNode(textNodes, range.endContainer, range.endOffset);

        let rawStartOffset: number;
        let rawEndOffset: number;

        if (typeof rawStartOffsetFromTextNodes === "number" && typeof rawEndOffsetFromTextNodes === "number") {
          rawStartOffset = Math.min(rawStartOffsetFromTextNodes, rawEndOffsetFromTextNodes);
          rawEndOffset = Math.max(rawStartOffsetFromTextNodes, rawEndOffsetFromTextNodes);
        } else {
          const probe = range.cloneRange();
          probe.selectNodeContents(selectionContainer);
          probe.setEnd(range.startContainer, range.startOffset);
          rawStartOffset = probe.toString().length;
          rawEndOffset = rawStartOffset + rawText.length;
        }

        const startOffset = rawStartOffset + leadingWhitespace;
        const endOffset = rawEndOffset - trailingWhitespace;
        if (endOffset <= startOffset) {
          return;
        }

        onSelection({
          selectedText,
          startOffset,
          endOffset,
        });
      }}
    >
      <div className={cn(hasAnchors ? "grid grid-cols-[132px_minmax(0,1fr)_132px] gap-3" : "")}>
        {hasAnchors ? (
          <div className="relative">
            {leftAnchors.map((anchor) => (
              <button
                key={anchor.id}
                type="button"
                data-selection-anchor="true"
                title={anchor.label}
                className={cn(
                  "nodrag nopan absolute left-1/2 z-10 inline-flex w-[124px] -translate-x-1/2 -translate-y-1/2 items-center justify-center border px-2 py-1 text-center text-[11px] leading-4 transition-colors",
                  anchor.isExpanded
                    ? "border-[var(--text-main)] bg-[var(--text-main)] text-white"
                    : "border-[var(--block-ochre)] bg-[rgba(255,249,242,0.98)] text-[var(--block-ochre)] hover:bg-[var(--block-ochre)] hover:text-white",
                )}
                style={{ top: anchor.top, minHeight: 28 }}
                onMouseDown={(event) => {
                  event.stopPropagation();
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleAnchor(anchor);
                }}
              >
                <Handle
                  id={anchor.handleId}
                  type="source"
                  position={Position.Bottom}
                  isConnectable={false}
                  className="!bottom-0 !left-1/2 !h-1 !w-1 !-translate-x-1/2 !translate-y-0 !border-0 !bg-transparent opacity-0"
                />
                <span className="line-clamp-2 whitespace-pre-wrap break-words">{anchor.label}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div ref={contentRef} data-selection-content="true" className="min-w-0">
          {renderMarkdown
            ? (
                <div className="message-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {content}
                  </ReactMarkdown>
                </div>
              )
            : <div className="whitespace-pre-wrap break-words">{content}</div>}
        </div>

        {hasAnchors ? (
          <div className="relative">
            {rightAnchors.map((anchor) => (
              <button
                key={anchor.id}
                type="button"
                data-selection-anchor="true"
                title={anchor.label}
                className={cn(
                  "nodrag nopan absolute left-1/2 z-10 inline-flex w-[124px] -translate-x-1/2 -translate-y-1/2 items-center justify-center border px-2 py-1 text-center text-[11px] leading-4 transition-colors",
                  anchor.isExpanded
                    ? "border-[var(--text-main)] bg-[var(--text-main)] text-white"
                    : "border-[var(--block-ochre)] bg-[rgba(255,249,242,0.98)] text-[var(--block-ochre)] hover:bg-[var(--block-ochre)] hover:text-white",
                )}
                style={{ top: anchor.top, minHeight: 28 }}
                onMouseDown={(event) => {
                  event.stopPropagation();
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleAnchor(anchor);
                }}
              >
                <Handle
                  id={anchor.handleId}
                  type="source"
                  position={Position.Bottom}
                  isConnectable={false}
                  className="!bottom-0 !left-1/2 !h-1 !w-1 !-translate-x-1/2 !translate-y-0 !border-0 !bg-transparent opacity-0"
                />
                <span className="line-clamp-2 whitespace-pre-wrap break-words">{anchor.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {hasAnchors ? <div className="mt-3 border-t border-[rgba(26,26,26,0.08)]" /> : null}
    </div>
  );
}

type RenderableSelectionAnchor = MessageSelectionAnchor & {
  startOffset: number | null;
  endOffset: number | null;
};

type PositionedSelectionAnchor = RenderableSelectionAnchor & {
  side: "left" | "right";
  top: number;
};

function getRenderableSelectionAnchors(content: string, anchors: MessageSelectionAnchor[]): RenderableSelectionAnchor[] {
  if (anchors.length === 0) {
    return [];
  }

  return [...anchors]
    .sort((left, right) => {
      const leftStartOffset = typeof left.startOffset === "number" ? left.startOffset : Number.MAX_SAFE_INTEGER;
      const rightStartOffset = typeof right.startOffset === "number" ? right.startOffset : Number.MAX_SAFE_INTEGER;
      if (leftStartOffset !== rightStartOffset) {
        return leftStartOffset - rightStartOffset;
      }

      const leftEndOffset = typeof left.endOffset === "number" ? left.endOffset : Number.MAX_SAFE_INTEGER;
      const rightEndOffset = typeof right.endOffset === "number" ? right.endOffset : Number.MAX_SAFE_INTEGER;
      if (leftEndOffset !== rightEndOffset) {
        return leftEndOffset - rightEndOffset;
      }

      return left.id.localeCompare(right.id);
    })
    .map((anchor) => {
      const fallbackLabel =
        typeof anchor.startOffset === "number" &&
        typeof anchor.endOffset === "number" &&
        anchor.endOffset > anchor.startOffset
          ? content.slice(clamp(anchor.startOffset, 0, content.length), clamp(anchor.endOffset, 0, content.length))
          : "";

      return {
        ...anchor,
        label: anchor.label || fallbackLabel || "Selected passage",
        startOffset: typeof anchor.startOffset === "number" ? anchor.startOffset : null,
        endOffset: typeof anchor.endOffset === "number" ? anchor.endOffset : null,
      };
    });
}

function buildSelectionAnchorGutterLayout(
  container: HTMLElement,
  anchors: RenderableSelectionAnchor[],
  previousLayoutById?: Map<string, { side: "left" | "right"; top: number }>,
): PositionedSelectionAnchor[] {
  const textNodes = collectTextNodes(container);
  const fullText = textNodes.map((node) => node.textContent ?? "").join("");
  const totalLength = fullText.length;
  const containerRect = container.getBoundingClientRect();
  const containerHeight = container.offsetHeight || Math.round(containerRect.height);
  const verticalScale = containerHeight > 0 && containerRect.height > 0 ? containerRect.height / containerHeight : 1;
  const maxTop = Math.max(20, containerHeight - 20);

  const positioned: PositionedSelectionAnchor[] = anchors.map((anchor, index) => {
    const anchorRect = resolveSelectionAnchorRect(textNodes, fullText, totalLength, anchor);
    const previousLayout = previousLayoutById?.get(anchor.id);
    const centerX = anchorRect ? anchorRect.left + anchorRect.width / 2 : containerRect.left + containerRect.width / 2;
    const side: "left" | "right" =
      previousLayout?.side ?? (centerX <= containerRect.left + containerRect.width / 2 ? "left" : "right");
    const baseTop = anchorRect
      ? (anchorRect.top - containerRect.top + Math.max(anchorRect.height / 2, 10)) / verticalScale
      : previousLayout?.top ?? 28 + index * 36;

    return {
      ...anchor,
      side,
      top: Math.round(clamp(baseTop, 20, maxTop)),
    };
  });

  const left = normalizeGutterAnchorTops(positioned.filter((item) => item.side === "left"), containerHeight);
  const right = normalizeGutterAnchorTops(positioned.filter((item) => item.side === "right"), containerHeight);
  return [...left, ...right];
}

function normalizeGutterAnchorTops<T extends { id: string; top: number }>(items: T[], containerHeight: number): T[] {
  if (items.length <= 1) {
    return items;
  }

  const minTop = 20;
  const maxTop = Math.max(minTop, containerHeight - 20);
  const minGap = 30;
  const sorted = [...items].sort((left, right) => {
    if (left.top !== right.top) {
      return left.top - right.top;
    }

    return left.id.localeCompare(right.id);
  });

  let cursor = minTop;
  for (const item of sorted) {
    item.top = clamp(item.top, cursor, maxTop);
    cursor = item.top + minGap;
  }

  const overflow = cursor - minGap - maxTop;
  if (overflow > 0) {
    let carry = overflow;
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const floor = index > 0 ? sorted[index - 1].top + minGap : minTop;
      const nextTop = Math.max(floor, sorted[index].top - carry);
      carry -= sorted[index].top - nextTop;
      sorted[index].top = nextTop;
      if (carry <= 0) {
        break;
      }
    }
  }

  return sorted;
}

function arePositionedSelectionAnchorsEqual(
  left: PositionedSelectionAnchor[],
  right: PositionedSelectionAnchor[],
) {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftAnchor = left[index];
    const rightAnchor = right[index];
    if (!rightAnchor) {
      return false;
    }

    if (
      leftAnchor.id !== rightAnchor.id ||
      leftAnchor.handleId !== rightAnchor.handleId ||
      leftAnchor.sourceMessageId !== rightAnchor.sourceMessageId ||
      leftAnchor.targetMessageId !== rightAnchor.targetMessageId ||
      leftAnchor.label !== rightAnchor.label ||
      leftAnchor.startOffset !== rightAnchor.startOffset ||
      leftAnchor.endOffset !== rightAnchor.endOffset ||
      leftAnchor.isExpanded !== rightAnchor.isExpanded ||
      leftAnchor.side !== rightAnchor.side ||
      leftAnchor.top !== rightAnchor.top
    ) {
      return false;
    }
  }

  return true;
}

function resolveSelectionAnchorRect(
  textNodes: Text[],
  fullText: string,
  totalLength: number,
  anchor: RenderableSelectionAnchor,
) {
  if (textNodes.length === 0 || totalLength === 0) {
    return null;
  }

  const resolvedOffsets = resolveSelectionAnchorOffsets(fullText, totalLength, anchor);
  if (!resolvedOffsets) {
    return null;
  }

  const { startOffset: normalizedStart, endOffset: normalizedEnd } = resolvedOffsets;
  const startPosition = locateTextOffset(textNodes, normalizedStart);
  const endPosition = locateTextOffset(textNodes, normalizedEnd);
  if (!startPosition || !endPosition) {
    return null;
  }

  const range = document.createRange();
  try {
    range.setStart(startPosition.node, startPosition.offset);
    range.setEnd(endPosition.node, endPosition.offset);
  } catch {
    return null;
  }

  const rangeRects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  const firstRect = rangeRects[0] ?? range.getBoundingClientRect();
  if (!firstRect || (firstRect.width <= 0 && firstRect.height <= 0)) {
    return null;
  }

  return firstRect;
}

function resolveSelectionAnchorOffsets(
  fullText: string,
  totalLength: number,
  anchor: RenderableSelectionAnchor,
) {
  const normalizedLabel = anchor.label.trim();
  const preferredMatch =
    typeof anchor.startOffset === "number" && typeof anchor.endOffset === "number" && anchor.endOffset > anchor.startOffset
      ? {
          startOffset: clamp(anchor.startOffset, 0, totalLength),
          endOffset: clamp(anchor.endOffset, clamp(anchor.startOffset, 0, totalLength) + 1, totalLength),
        }
      : null;

  if (preferredMatch) {
    const candidateText = fullText.slice(preferredMatch.startOffset, preferredMatch.endOffset);
    if (!normalizedLabel || areAnchorTextsEquivalent(candidateText, normalizedLabel)) {
      return preferredMatch;
    }
  }

  if (!normalizedLabel) {
    return preferredMatch;
  }

  const foundOffset = findClosestTextMatchOffset(fullText, normalizedLabel, preferredMatch?.startOffset ?? 0);
  if (foundOffset < 0) {
    return preferredMatch;
  }

  return {
    startOffset: foundOffset,
    endOffset: foundOffset + normalizedLabel.length,
  };
}

function areAnchorTextsEquivalent(left: string, right: string) {
  return normalizeAnchorText(left) === normalizeAnchorText(right);
}

function normalizeAnchorText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function findClosestTextMatchOffset(fullText: string, query: string, targetOffset: number) {
  const matches: number[] = [];
  let searchStart = 0;

  while (searchStart <= fullText.length) {
    const matchIndex = fullText.indexOf(query, searchStart);
    if (matchIndex < 0) {
      break;
    }

    matches.push(matchIndex);
    searchStart = matchIndex + 1;
  }

  if (matches.length === 0) {
    return -1;
  }

  return matches.reduce((bestMatch, currentMatch) =>
    Math.abs(currentMatch - targetOffset) < Math.abs(bestMatch - targetOffset) ? currentMatch : bestMatch,
  );
}

function collectTextNodes(container: HTMLElement) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    if (current instanceof Text && (current.textContent?.length ?? 0) > 0) {
      textNodes.push(current);
    }
    current = walker.nextNode();
  }

  return textNodes;
}

function resolveTextOffsetFromBoundaryTextNode(
  textNodes: Text[],
  boundaryContainer: globalThis.Node,
  boundaryOffset: number,
) {
  if (!(boundaryContainer instanceof Text)) {
    return null;
  }

  let cursor = 0;
  for (const node of textNodes) {
    const length = node.textContent?.length ?? 0;
    if (node === boundaryContainer) {
      return cursor + clamp(boundaryOffset, 0, length);
    }
    cursor += length;
  }

  return null;
}

function locateTextOffset(textNodes: Text[], targetOffset: number) {
  let cursor = 0;
  for (const node of textNodes) {
    const length = node.textContent?.length ?? 0;
    const nextCursor = cursor + length;
    if (targetOffset <= nextCursor) {
      return {
        node,
        offset: clamp(targetOffset - cursor, 0, length),
      };
    }
    cursor = nextCursor;
  }

  const lastNode = textNodes.at(-1);
  if (!lastNode) {
    return null;
  }

  return {
    node: lastNode,
    offset: lastNode.textContent?.length ?? 0,
  };
}

function makeSelectionAnchorHandleId(branchId: string) {
  return `selection-anchor-${branchId}`;
}

function buildFlowGraph({
  expandedBranchIds,
  persistedAssistantStatesByMessageId,
  snapshot,
  activePathMessageId,
  selectionDraft,
  measuredNodeHeights,
  onMeasureHeight,
  onPickMessage,
  onToggleSelectionAnchor,
  onSelectionDraft,
  showSessionIds,
}: {
  expandedBranchIds: Set<string>;
  persistedAssistantStatesByMessageId: Record<string, AssistantStreamState | null>;
  snapshot: GraphSnapshot;
  activePathMessageId: string | null;
  selectionDraft: SelectionDraft | null;
  measuredNodeHeights: Record<string, number>;
  onMeasureHeight: (messageId: string, height: number) => void;
  onPickMessage: (messageId: string) => void;
  onToggleSelectionAnchor: (anchor: MessageSelectionAnchor) => void;
  onSelectionDraft: (draft: SelectionDraft) => void;
  showSessionIds: boolean;
}) {
  const activeEdgeIds = getActiveEdgeIds(snapshot, activePathMessageId);
  const nodes: Node[] = [];

  if (snapshot.messages.length === 0) {
    return { nodes, edges: [] };
  }

  const visibleBranchIds = getVisibleBranchIds(snapshot, activePathMessageId, expandedBranchIds);
  const branchOrder = new Map(snapshot.branches.map((branch, index) => [branch.id, index]));
  const messagesById = new Map(snapshot.messages.map((message) => [message.id, message]));
  const allMessagesByBranch = new Map<string, MessageNode[]>();
  const childBranchesBySourceMessage = new Map<string, typeof snapshot.branches>();
  const selectionAnchorsByMessageId = new Map<string, MessageSelectionAnchor[]>();
  const sourceHandleByEdgeId = new Map<string, string>();
  const visibleBranches = snapshot.branches.filter((branch) => visibleBranchIds.has(branch.id));
  const visibleMessages = snapshot.messages.filter((message) => visibleBranchIds.has(message.branchId));
  const visibleMessagesByBranch = new Map<string, MessageNode[]>();

  for (const message of snapshot.messages) {
    const branchMessages = allMessagesByBranch.get(message.branchId) ?? [];
    branchMessages.push(message);
    allMessagesByBranch.set(message.branchId, branchMessages);
  }

  for (const message of visibleMessages) {
    const branchMessages = visibleMessagesByBranch.get(message.branchId) ?? [];
    branchMessages.push(message);
    visibleMessagesByBranch.set(message.branchId, branchMessages);
  }

  for (const branch of snapshot.branches) {
    if (!branch.sourceMessageId) {
      continue;
    }

    const childBranches = childBranchesBySourceMessage.get(branch.sourceMessageId) ?? [];
    childBranches.push(branch);
    childBranchesBySourceMessage.set(branch.sourceMessageId, childBranches);

    const firstBranchMessage = allMessagesByBranch.get(branch.id)?.[0];
    if (!firstBranchMessage || !messagesById.get(branch.sourceMessageId) || !branch.selectedText?.trim()) {
      continue;
    }

    const forkEdgeId = `edge_fork_${branch.sourceMessageId}_${firstBranchMessage.id}`;
    const anchors = selectionAnchorsByMessageId.get(branch.sourceMessageId) ?? [];
    const label = branch.selectedText.trim() || "Selected passage";

    anchors.push({
      id: branch.id,
      handleId: makeSelectionAnchorHandleId(branch.id),
      sourceMessageId: branch.sourceMessageId,
      targetMessageId: firstBranchMessage.id,
      label,
      startOffset: branch.startOffset ?? null,
      endOffset: branch.endOffset ?? null,
      isExpanded: visibleBranchIds.has(branch.id),
    });
    selectionAnchorsByMessageId.set(branch.sourceMessageId, anchors);

    if (visibleBranchIds.has(branch.id)) {
      sourceHandleByEdgeId.set(forkEdgeId, makeSelectionAnchorHandleId(branch.id));
    }
  }

  for (const childBranches of childBranchesBySourceMessage.values()) {
    childBranches.sort((left, right) => (branchOrder.get(left.id) ?? 0) - (branchOrder.get(right.id) ?? 0));
  }

  const visibleEdgeSnapshot = buildGraphEdges({
    branches: visibleBranches,
    messages: visibleMessages,
  });
  const edges: Edge[] = visibleEdgeSnapshot.map((edge) => {
    const isActive = activeEdgeIds.has(edge.id);
    const strokeColor = isActive ? "#1A1A1A" : edge.kind === "fork" ? "#C2B7A1" : "#8A9288";

    return {
      id: edge.id,
      source: edge.source,
      sourceHandle: sourceHandleByEdgeId.get(edge.id),
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

  const branchLaneById = new Map<string, number>([[rootBranchId, 0]]);
  const branchSideById = new Map<string, "center" | "left" | "right">([[rootBranchId, "center"]]);
  let nextLeftLane = -1;
  let nextRightLane = 1;

  placeBranch(rootBranchId, 0);

  return { nodes, edges };

  function placeBranch(branchId: string, startY: number) {
    const laneIndex = branchLaneById.get(branchId) ?? 0;
    const centerX = laneIndex * branchLaneWidth;
    const branchMessages = visibleMessagesByBranch.get(branchId) ?? [];
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
          persistedAssistantState: persistedAssistantStatesByMessageId[message.id] ?? null,
          isActiveMessage: message.id === activePathMessageId,
          hasSelectionDraft: selectionDraft?.sourceMessageId === message.id,
          selectionAnchors: selectionAnchorsByMessageId.get(message.id) ?? [],
          showSessionId: showSessionIds,
          sessionLabelSide: laneIndex < 0 ? "left" : "right",
          onMeasureHeight,
          onPickMessage,
          onToggleSelectionAnchor,
          onSelectionDraft,
        } satisfies MessageNodeData,
      });

      const childBranches = childBranchesBySourceMessage.get(message.id) ?? [];

      childBranches.forEach((childBranch) => {
        if (!visibleBranchIds.has(childBranch.id)) {
          return;
        }

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
  const selectedPassage = message.selectedText?.replace(/\r\n/g, "\n").trim() ?? "";
  const selectionLines = selectedPassage
    ? selectedPassage.split("\n").reduce((count, line) => {
        const visibleLength = Math.max(line.trim().length, 1);
        return count + Math.max(1, Math.ceil(visibleLength / messageEstimateCharsPerLine));
      }, 0)
    : 0;
  const wrappedLines = normalized.split("\n").reduce((count, line) => {
    const visibleLength = Math.max(line.trim().length, 1);
    return count + Math.max(1, Math.ceil(visibleLength / messageEstimateCharsPerLine));
  }, 0);
  const codeBlockBonus = (normalized.match(/```/g)?.length ?? 0) * 48;
  const selectionBonus = selectedPassage ? 24 + selectionLines * 24 : 0;

  return Math.max(230, 150 + wrappedLines * messageEstimateLineHeight + codeBlockBonus + selectionBonus);
}

function getVisibleBranchIds(
  snapshot: GraphSnapshot,
  activePathMessageId: string | null,
  expandedBranchIds: Set<string>,
) {
  const visibleBranchIds = new Set<string>();
  const branchesById = new Map(snapshot.branches.map((branch) => [branch.id, branch]));
  const messagesById = new Map(snapshot.messages.map((message) => [message.id, message]));

  for (const branch of snapshot.branches) {
    if (branch.id === rootBranchId || !branch.selectedText?.trim()) {
      visibleBranchIds.add(branch.id);
    }
  }

  for (const branchId of expandedBranchIds) {
    if (branchesById.has(branchId)) {
      visibleBranchIds.add(branchId);
    }
  }

  let currentBranchId = activePathMessageId ? (messagesById.get(activePathMessageId)?.branchId ?? null) : null;
  while (currentBranchId) {
    visibleBranchIds.add(currentBranchId);
    currentBranchId = branchesById.get(currentBranchId)?.parentBranchId ?? null;
  }

  return visibleBranchIds;
}

function getDescendantBranchIds(snapshot: GraphSnapshot, parentBranchId: string) {
  const childBranchIdsByParent = new Map<string, string[]>();
  for (const branch of snapshot.branches) {
    if (!branch.parentBranchId) {
      continue;
    }

    const childBranchIds = childBranchIdsByParent.get(branch.parentBranchId) ?? [];
    childBranchIds.push(branch.id);
    childBranchIdsByParent.set(branch.parentBranchId, childBranchIds);
  }

  const descendants: string[] = [];
  const queue = [...(childBranchIdsByParent.get(parentBranchId) ?? [])];
  while (queue.length > 0) {
    const branchId = queue.shift();
    if (!branchId) {
      continue;
    }

    descendants.push(branchId);
    queue.push(...(childBranchIdsByParent.get(branchId) ?? []));
  }

  return descendants;
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

function buildOptimisticRootStreamTurn(
  snapshot: GraphSnapshot,
  input: {
    prompt: string;
    machineId: string;
    selectedText: string | null;
  },
): PendingTurnMetadata {
  const turnId = makeId("turn");
  const userMessageId = makeId("msg");
  const assistantMessageId = makeId("msg");
  const createdAt = new Date().toISOString();
  const assistantState = createPendingAssistantState();
  const messages = [
    ...snapshot.messages,
    {
      id: userMessageId,
      branchId: rootBranchId,
      role: "user",
      content: input.prompt,
      selectedText: input.selectedText,
      sessionId: null,
      machineId: input.machineId,
      createdAt,
    } satisfies MessageNode,
    {
      id: assistantMessageId,
      branchId: rootBranchId,
      role: "assistant",
      content: "",
      selectedText: null,
      sessionId: null,
      machineId: input.machineId,
      createdAt,
    } satisfies MessageNode,
  ];

  return {
    turnId,
    userMessageId,
    assistantMessageId,
    createdAt,
    assistantState,
    optimisticSnapshot: {
      branches: snapshot.branches,
      messages,
      edges: buildGraphEdges({
        branches: snapshot.branches,
        messages,
      }),
      assistantStates: {
        ...snapshot.assistantStates,
        [assistantMessageId]: assistantState,
      },
    },
  };
}

function projectAssistantStateForRender(state: AssistantStreamState | null | undefined): AssistantStreamState | null {
  if (!state) {
    return null;
  }

  return {
    ...state,
    blocks: state.blocks.filter((block) =>
      block.kind === "thinking"
        ? block.text.trim().length > 0
        : block.inputText.trim().length > 0 || block.outputText.trim().length > 0 || block.status === "error",
    ),
    responseText: state.status === "complete" ? state.responseText : "",
  };
}

function assistantStatesEqual(left: AssistantStreamState | null, right: AssistantStreamState | null) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  if (
    left.status !== right.status ||
    left.responseText !== right.responseText ||
    left.errorMessage !== right.errorMessage ||
    left.blocks.length !== right.blocks.length
  ) {
    return false;
  }

  for (let index = 0; index < left.blocks.length; index += 1) {
    const leftBlock = left.blocks[index];
    const rightBlock = right.blocks[index];

    if (!rightBlock) {
      return false;
    }

    if (
      leftBlock.id !== rightBlock.id ||
      leftBlock.order !== rightBlock.order ||
      leftBlock.kind !== rightBlock.kind ||
      leftBlock.status !== rightBlock.status
    ) {
      return false;
    }

    if (leftBlock.kind === "thinking" && rightBlock.kind === "thinking") {
      if (leftBlock.text !== rightBlock.text) {
        return false;
      }
      continue;
    }

    if (
      leftBlock.kind !== "thinking" &&
      rightBlock.kind !== "thinking" &&
      (leftBlock.toolCallId !== rightBlock.toolCallId ||
        leftBlock.toolName !== rightBlock.toolName ||
        leftBlock.inputText !== rightBlock.inputText ||
        leftBlock.outputText !== rightBlock.outputText ||
        leftBlock.isError !== rightBlock.isError)
    ) {
      return false;
    }
  }

  return true;
}

function buildOptimisticBranchCreationStreamTurn(
  snapshot: GraphSnapshot,
  input: {
    input: CreateBranchInput;
  },
): PendingTurnMetadata {
  const sourceMessage = snapshot.messages.find((message) => message.id === input.input.sourceMessageId);
  if (!sourceMessage) {
    throw new Error(`Unknown source message: ${input.input.sourceMessageId}`);
  }

  const turnId = makeId("turn");
  const branchId = makeId("branch");
  const userMessageId = makeId("msg");
  const assistantMessageId = makeId("msg");
  const createdAt = new Date().toISOString();
  const assistantState = createPendingAssistantState();
  const { branchTitle, userMessageContent } = describeBranchCreation(input.input, sourceMessage);
  const branch = {
    id: branchId,
    parentBranchId: sourceMessage.branchId,
    sourceMessageId: sourceMessage.id,
    sessionId: null,
    machineId: sourceMessage.machineId,
    title: branchTitle,
    selectedText: input.input.mode === "selection" ? input.input.selectedText ?? null : null,
    startOffset: input.input.mode === "selection" ? input.input.startOffset ?? null : null,
    endOffset: input.input.mode === "selection" ? input.input.endOffset ?? null : null,
    createdAt,
  };
  const branches = [...snapshot.branches, branch];
  const messages = [
    ...snapshot.messages,
    {
      id: userMessageId,
      branchId,
      role: "user",
      content: userMessageContent,
      selectedText: input.input.mode === "selection" ? input.input.selectedText ?? null : null,
      sessionId: null,
      machineId: sourceMessage.machineId,
      createdAt,
    } satisfies MessageNode,
    {
      id: assistantMessageId,
      branchId,
      role: "assistant",
      content: "",
      selectedText: null,
      sessionId: null,
      machineId: sourceMessage.machineId,
      createdAt,
    } satisfies MessageNode,
  ];

  return {
    turnId,
    branchId,
    userMessageId,
    assistantMessageId,
    createdAt,
    assistantState,
    optimisticSnapshot: {
      branches,
      messages,
      edges: buildGraphEdges({ branches, messages }),
      assistantStates: {
        ...snapshot.assistantStates,
        [assistantMessageId]: assistantState,
      },
    },
  };
}

function buildOptimisticBranchTurnStreamTurn(
  snapshot: GraphSnapshot,
  input: {
    branchId: string;
    prompt: string;
    machineId: string;
    selectedText: string | null;
  },
): PendingTurnMetadata {
  const turnId = makeId("turn");
  const userMessageId = makeId("msg");
  const assistantMessageId = makeId("msg");
  const createdAt = new Date().toISOString();
  const assistantState = createPendingAssistantState();
  const messages = [
    ...snapshot.messages,
    {
      id: userMessageId,
      branchId: input.branchId,
      role: "user",
      content: input.prompt,
      selectedText: input.selectedText,
      sessionId: null,
      machineId: input.machineId,
      createdAt,
    } satisfies MessageNode,
    {
      id: assistantMessageId,
      branchId: input.branchId,
      role: "assistant",
      content: "",
      selectedText: null,
      sessionId: null,
      machineId: input.machineId,
      createdAt,
    } satisfies MessageNode,
  ];

  return {
    turnId,
    userMessageId,
    assistantMessageId,
    createdAt,
    assistantState,
    optimisticSnapshot: {
      branches: snapshot.branches,
      messages,
      edges: buildGraphEdges({
        branches: snapshot.branches,
        messages,
      }),
      assistantStates: {
        ...snapshot.assistantStates,
        [assistantMessageId]: assistantState,
      },
    },
  };
}

function buildFallbackOptimisticTurn(input: {
  prompt: string;
  machineId: string;
  selectedText: string | null;
  snapshot: GraphSnapshot | undefined;
}): PendingTurnMetadata {
  return buildOptimisticRootStreamTurn(input.snapshot ?? createEmptyRootSnapshot(), {
    prompt: input.prompt,
    machineId: input.machineId,
    selectedText: input.selectedText,
  });
}

function createEmptyRootSnapshot(): GraphSnapshot {
  return {
    branches: [
      {
        id: rootBranchId,
        parentBranchId: null,
        sourceMessageId: null,
        sessionId: null,
        machineId: null,
        title: "Root session",
        selectedText: null,
        startOffset: null,
        endOffset: null,
        createdAt: new Date().toISOString(),
      },
    ],
    messages: [],
    edges: [],
    assistantStates: {},
  };
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

function formatLatestMessageTime(value: string | null) {
  if (!value) {
    return null;
  }

  return formatNetTime(value);
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

async function streamRequest<T>(path: string, init: RequestInit, onEvent: (event: T) => Promise<void> | void) {
  const headers = new Headers(init.headers);
  const hasBody = init.body !== undefined && init.body !== null;
  const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;

  if (hasBody && !isFormData && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Streaming request failed"));
  }

  if (!response.body) {
    throw new Error("The streaming response body was empty.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), {
      stream: !done,
    });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line) {
        await onEvent(JSON.parse(line) as T);
      }

      newlineIndex = buffer.indexOf("\n");
    }

    if (done) {
      const tail = buffer.trim();
      if (tail) {
        await onEvent(JSON.parse(tail) as T);
      }
      break;
    }
  }
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
