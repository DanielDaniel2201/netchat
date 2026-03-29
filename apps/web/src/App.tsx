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
import { ArrowUp, LoaderCircle, MoreHorizontal } from "lucide-react";
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
import { create } from "zustand";

import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
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
  liveAssistantState: AssistantStreamState | null;
  isActiveMessage: boolean;
  hasSelectionDraft: boolean;
  selectionAnchors: MessageSelectionAnchor[];
  showSessionId: boolean;
  sessionLabelSide: "left" | "right";
  onMeasureHeight: (messageId: string, height: number) => void;
  onPickMessage: (messageId: string) => void;
  onActivateMessagePath: (messageId: string) => void;
  onSelectionDraft: (draft: SelectionDraft) => void;
};

type MessageSelectionAnchor = {
  id: string;
  handleId: string;
  targetMessageId: string;
  label: string;
  startOffset: number;
  endOffset: number;
  isActive: boolean;
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
  const openNetMenuRef = useRef<HTMLDivElement>(null);
  const lastAutoSelectedMessageIdRef = useRef<string | null>(null);
  const selectedMessageId = useComposerStore((state) => state.selectedMessageId);
  const setSelectedMessageId = useComposerStore((state) => state.setSelectedMessageId);
  const [activePathMessageId, setActivePathMessageId] = useState<string | null>(null);
  const [composerValue, setComposerValue] = useState("");
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(null);
  const [composerAnchor, setComposerAnchor] = useState<ComposerAnchor | null>(null);
  const [measuredNodeHeights, setMeasuredNodeHeights] = useState<Record<string, number>>({});
  const [editingNetId, setEditingNetId] = useState<string | null>(null);
  const [editingNetTitle, setEditingNetTitle] = useState("");
  const [openNetMenuId, setOpenNetMenuId] = useState<string | null>(null);
  const [pendingNetDeletion, setPendingNetDeletion] = useState<{ id: string; title: string } | null>(null);
  const [showNetHistory, setShowNetHistory] = useState(false);
  const [activeStreamedTurn, setActiveStreamedTurn] = useState<ActiveStreamedTurn | null>(null);
  const [liveAssistantStates, setLiveAssistantStates] = useState<Record<string, AssistantStreamState>>({});
  const [streamErrorMessage, setStreamErrorMessage] = useState<string | null>(null);

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
          setLiveAssistantStates((current) => ({
            ...current,
            [event.assistantMessageId]: event.assistantState,
          }));
          setSelectedMessageId(event.assistantMessageId);
          setActivePathMessageId(event.assistantMessageId);
          return;
        }

        if (event.type === "assistant.patch") {
          setLiveAssistantStates((current) => ({
            ...current,
            [event.assistantMessageId]: event.state,
          }));
          return;
        }

        if (event.type === "turn.committed") {
          queryClient.setQueryData(["graph"], event.snapshot);
          const persistedAssistantState = event.snapshot.assistantStates?.[event.assistantMessageId] ?? null;
          const committedMessage =
            event.snapshot.messages.find((message) => message.id === event.assistantMessageId) ?? null;
          setActiveStreamedTurn(null);
          setLiveAssistantStates((current) => ({
            ...current,
            [event.assistantMessageId]:
              persistedAssistantState ??
              finalizeAssistantState(current[event.assistantMessageId], committedMessage?.content ?? ""),
          }));
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
      setLiveAssistantStates((current) => ({
        ...current,
        [optimisticTurn.assistantMessageId]: {
          ...(current[optimisticTurn.assistantMessageId] ?? optimisticTurn.assistantState),
          status: "error",
          errorMessage: message,
        },
      }));
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

  function activateSelectionAnchorTarget(messageId: string) {
    activateMessagePath(messageId);
    setSelectedMessageId(null);
    setSelectionDraft(null);
    clearBrowserSelection();
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

  const graph = useMemo(() => {
    if (!snapshot) {
      return { nodes: [], edges: [] };
    }

    return buildFlowGraph({
      liveAssistantStates,
      snapshot,
      activePathMessageId,
      onPickMessage: pickMessage,
      onActivateMessagePath: activateSelectionAnchorTarget,
      selectionDraft,
      measuredNodeHeights,
      onMeasureHeight: reportMessageNodeHeight,
      onSelectionDraft: applySelectionDraft,
      showSessionIds: uiConfig?.showSessionIds ?? false,
    });
  }, [
    activePathMessageId,
    liveAssistantStates,
    measuredNodeHeights,
    reportMessageNodeHeight,
    selectionDraft,
    snapshot,
    uiConfig?.showSessionIds,
  ]);

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
      setLiveAssistantStates({});
      return;
    }

    const liveMessageIds = new Set(snapshot.messages.map((message) => message.id));
    setLiveAssistantStates((current) => {
      let changed = false;
      const next: Record<string, AssistantStreamState> = {};

      for (const [messageId, state] of Object.entries(current)) {
        if (liveMessageIds.has(messageId)) {
          next[messageId] = state;
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

  const isSwitchingNet =
    createNetMutation.isPending ||
    selectNetMutation.isPending ||
    renameNetMutation.isPending ||
    deleteNetMutation.isPending;
  const hasMessages = Boolean(snapshot && snapshot.messages.length > 0);
  const showBubbleComposer = Boolean(selectedMessage && composerAnchor);
  const sendDisabled = composerValue.trim().length === 0 || isThinking || isSwitchingNet || !canSendOnActiveLane;

  function beginOptimisticTurn(optimisticTurn: PendingTurnMetadata) {
    setActiveStreamedTurn({
      turnId: optimisticTurn.turnId,
      assistantMessageId: optimisticTurn.assistantMessageId,
      optimisticSnapshot: optimisticTurn.optimisticSnapshot,
      isPending: true,
    });
    setLiveAssistantStates((current) => ({
      ...current,
      [optimisticTurn.assistantMessageId]: optimisticTurn.assistantState,
    }));
    setSelectedMessageId(optimisticTurn.assistantMessageId);
    setActivePathMessageId(optimisticTurn.assistantMessageId);
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
  const branchCount = snapshot?.branches.length ?? 0;
  const messageCount = snapshot?.messages.length ?? 0;
  const netCount = workspaceNets.length;
  const pendingDeletionNetId = pendingNetDeletion?.id ?? null;
  const isConfirmingDeletion = deleteNetMutation.isPending && deleteNetMutation.variables === pendingDeletionNetId;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--bg-cream)] text-[var(--text-main)]">
      <div className="relative flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-[linear-gradient(180deg,rgba(244,241,234,0.92)_0%,rgba(244,241,234,0)_100%)]" />

        <div className="pointer-events-none absolute right-6 top-6 z-20 flex flex-col items-end gap-3">
          <div className="pointer-events-auto w-[min(320px,calc(100vw-3rem))] border border-[var(--text-main)] bg-white shadow-[10px_10px_0_rgba(26,26,26,0.08)]">
            <div className="border-b border-[var(--node-border)] px-5 py-4">
              <div className="flex items-start justify-between gap-4 text-[13px] font-medium leading-5">
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

              <div className="mt-5 text-center text-[20px] font-medium leading-7 text-[var(--text-main)]">
                {activeNet?.title ?? "Loading..."}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-px bg-[var(--node-border)]">
              <button
                type="button"
                className="bg-white px-5 py-4 text-left text-[13px] font-medium text-[var(--text-main)] transition-colors hover:bg-[var(--bg-cream)] disabled:cursor-not-allowed disabled:text-[rgba(26,26,26,0.38)]"
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
                className="bg-white px-5 py-4 text-left text-[13px] font-medium text-[var(--text-main)] transition-colors hover:bg-[var(--bg-cream)] disabled:cursor-not-allowed disabled:text-[rgba(26,26,26,0.38)]"
                disabled={isSwitchingNet || workspaceQuery.isLoading}
                onClick={() => {
                  setOpenNetMenuId(null);
                  createNetMutation.mutate({ title: "" });
                }}
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
              <div className="border-b border-[var(--node-border)] px-5 py-4 text-[15px] font-medium text-[var(--text-main)]">
                History nets
              </div>

              <div className="max-h-[360px] overflow-y-auto">
                {workspaceQuery.isLoading ? (
                  <div className="px-5 py-5 text-[14px] leading-6 text-[rgba(26,26,26,0.62)]">
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
                                  className="h-11 rounded-none border-[var(--text-main)] px-3 text-[15px] font-medium shadow-none focus:border-[var(--text-main)]"
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
                                    className="border border-[var(--text-main)] bg-[var(--text-main)] px-3 py-2 text-[12px] font-medium text-white transition-colors hover:bg-[var(--block-slate)] disabled:cursor-not-allowed disabled:bg-[rgba(26,26,26,0.42)]"
                                    disabled={isRenamingNet || editingNetTitle.trim().length === 0}
                                    onClick={() => submitNetRename(net.id, net.title)}
                                  >
                                    {isRenamingNet ? "Saving..." : "Save"}
                                  </button>
                                  <button
                                    type="button"
                                    className="border border-[var(--node-border)] bg-white px-3 py-2 text-[12px] font-medium text-[rgba(26,26,26,0.72)] transition-colors hover:bg-[var(--bg-cream)]"
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
                                <div className={cn("truncate text-[15px] font-medium leading-6", isActiveNet ? "text-white" : "text-[var(--text-main)]")}>
                                  {net.title}
                                </div>
                                <div
                                  className={cn(
                                    "mt-1 text-[12px] leading-5",
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
                                    className="block w-full border-b border-[var(--node-border)] px-4 py-3 text-left text-[13px] font-medium text-[var(--text-main)] transition-colors hover:bg-[var(--bg-cream)] disabled:cursor-not-allowed disabled:text-[rgba(26,26,26,0.32)]"
                                    disabled={isSwitchingNet || isDeletingNet}
                                    onClick={() => beginNetRename(net.id, net.title)}
                                  >
                                    Rename
                                  </button>
                                  <button
                                    type="button"
                                    className="block w-full px-4 py-3 text-left text-[13px] font-medium text-rose-700 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:text-rose-300"
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
                    <ArrowUp className="size-4" />
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
                <div className="text-[18px] font-medium leading-7 text-[var(--text-main)]">Delete net?</div>
              </div>

              <div className="px-6 py-5 text-[15px] leading-7 text-[rgba(26,26,26,0.76)]">
                Delete "{pendingNetDeletion.title}" from history?
              </div>

              <div className="grid grid-cols-2 gap-px bg-[var(--node-border)]">
                <button
                  type="button"
                  className="bg-white px-5 py-4 text-left text-[13px] font-medium text-[var(--text-main)] transition-colors hover:bg-[var(--bg-cream)] disabled:cursor-not-allowed disabled:text-[rgba(26,26,26,0.38)]"
                  disabled={isConfirmingDeletion}
                  onClick={cancelNetDeletion}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="bg-rose-50 px-5 py-4 text-left text-[13px] font-medium text-rose-700 transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:text-rose-300"
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

function MessageGraphNode({ data }: NodeProps<Node<MessageNodeData>>) {
  const isUser = data.message.role === "user";
  const roleLabel = isUser ? "User" : "Claude";
  const bubbleRef = useRef<HTMLDivElement>(null);
  const sessionIdLabel = data.message.sessionId ?? "pending";
  const liveAssistantState = !isUser ? data.liveAssistantState : null;
  const responseContent = !isUser
    ? liveAssistantState?.responseText || data.message.content
    : data.message.content;
  const canSelectAssistantResponse = !liveAssistantState || liveAssistantState.status === "complete";
  const showPendingAssistantState =
    !isUser && liveAssistantState && (liveAssistantState.status === "pending" || liveAssistantState.status === "streaming");
  const visibleAssistantBlocks =
    liveAssistantState?.blocks.filter(
      (block) => block.kind !== "thinking" || block.text.trim().length > 0 || block.status !== "complete",
    ) ?? [];

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
  }, [data.message.id, data.onMeasureHeight]);

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
        onClickCapture={(event) => {
          if ((event.target as HTMLElement).closest("[data-selection-anchor=\"true\"]")) {
            return;
          }

          const selectedText = window.getSelection()?.toString().trim();
          if (!isUser && !selectedText) {
            data.onPickMessage(data.message.id);
          }
          event.stopPropagation();
        }}
        onMouseDownCapture={(event) => {
          if ((event.target as HTMLElement).closest("[data-selection-anchor=\"true\"]")) {
            return;
          }

          event.stopPropagation();
        }}
        onPointerDownCapture={(event) => {
          if ((event.target as HTMLElement).closest("[data-selection-anchor=\"true\"]")) {
            return;
          }

          event.stopPropagation();
        }}
      >
        <div className="relative flex items-center justify-between gap-4 border-b border-[var(--node-border)] px-5 py-4">
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
          <div className="editorial-meta text-[rgba(26,26,26,0.42)]">
            {formatMessageTime(data.message.createdAt)}
          </div>
        </div>

        <div className="relative px-5 py-5">
          {!isUser && liveAssistantState ? (
            <div className="space-y-4">
              {visibleAssistantBlocks.map((block) => (
                <details
                  key={block.id}
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
                      <div className="message-copy whitespace-pre-wrap text-[15px] leading-7 text-[rgba(26,26,26,0.78)]">
                        {block.text || "Claude is thinking..."}
                      </div>
                    ) : (
                      <>
                        <div>
                          <div className="editorial-meta text-[rgba(26,26,26,0.44)]">Tool input</div>
                          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap border border-[var(--node-border)] bg-white px-3 py-3 text-[12px] leading-6 text-[rgba(26,26,26,0.78)]">
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
                                "mt-2 overflow-x-auto whitespace-pre-wrap border px-3 py-3 text-[12px] leading-6",
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
                    canSelectAssistantResponse ? (
                      <SelectableMessage
                        content={responseContent}
                        anchors={data.selectionAnchors}
                        disabled={false}
                        onActivateAnchor={data.onActivateMessagePath}
                        onSelection={(draft) => data.onSelectionDraft({ ...draft, sourceMessageId: data.message.id })}
                      />
                    ) : (
                      <div className="message-copy whitespace-pre-wrap text-[17px] font-medium leading-9 text-[var(--text-main)]">
                        {responseContent}
                      </div>
                    )
                  ) : (
                    <div className="flex min-h-[72px] items-center gap-3 text-[15px] leading-7 text-[rgba(26,26,26,0.58)]">
                      <LoaderCircle className="size-4 animate-spin text-[var(--block-ochre)]" />
                      <span>Waiting for Claude to respond…</span>
                    </div>
                  )}
                </div>
              </div>

              {liveAssistantState.errorMessage ? (
                <div className="border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] leading-6 text-rose-700">
                  {liveAssistantState.errorMessage}
                </div>
              ) : null}
            </div>
          ) : (
            <SelectableMessage
              content={responseContent}
              anchors={data.selectionAnchors}
              disabled={isUser}
              onActivateAnchor={data.onActivateMessagePath}
              onSelection={(draft) => data.onSelectionDraft({ ...draft, sourceMessageId: data.message.id })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SelectableMessage({
  content,
  anchors,
  disabled,
  onActivateAnchor,
  onSelection,
}: {
  content: string;
  anchors: MessageSelectionAnchor[];
  disabled: boolean;
  onActivateAnchor: (messageId: string) => void;
  onSelection: (draft: Omit<SelectionDraft, "sourceMessageId">) => void;
}) {
  const renderableAnchors = getRenderableSelectionAnchors(content, anchors);

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
      {renderableAnchors.length > 0
        ? renderableAnchors.map((anchor, index) => {
            const previousEndOffset = renderableAnchors[index - 1]?.endOffset ?? 0;
            const nextLeadingText = content.slice(previousEndOffset, anchor.startOffset);

            return (
              <span key={anchor.id}>
                {nextLeadingText}
                <button
                  type="button"
                  data-selection-anchor="true"
                  className={cn(
                    "relative inline-flex max-w-full items-center border px-1.5 py-0.5 text-left align-baseline text-[0.95em] leading-[1.7] transition-colors",
                    anchor.isActive
                      ? "border-[var(--text-main)] bg-[var(--text-main)] text-white"
                      : "border-[var(--block-ochre)] bg-[rgba(255,249,242,0.98)] text-[var(--block-ochre)] hover:bg-[var(--block-ochre)] hover:text-white",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    onActivateAnchor(anchor.targetMessageId);
                  }}
                  onMouseDown={(event) => {
                    event.stopPropagation();
                  }}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <Handle
                    id={anchor.handleId}
                    type="source"
                    position={Position.Bottom}
                    isConnectable={false}
                    className="!bottom-0 !left-1/2 !h-1 !w-1 !-translate-x-1/2 !translate-y-0 !border-0 !bg-transparent opacity-0"
                  />
                  <span className="whitespace-pre-wrap break-words">{anchor.label}</span>
                </button>
              </span>
            );
          })
        : content}
      {renderableAnchors.length > 0 ? content.slice(renderableAnchors.at(-1)?.endOffset ?? 0) : null}
    </div>
  );
}

function getRenderableSelectionAnchors(content: string, anchors: MessageSelectionAnchor[]) {
  if (anchors.length === 0) {
    return [];
  }

  const sortedAnchors = [...anchors].sort((left, right) => {
    if (left.startOffset !== right.startOffset) {
      return left.startOffset - right.startOffset;
    }

    if (left.endOffset !== right.endOffset) {
      return left.endOffset - right.endOffset;
    }

    return left.id.localeCompare(right.id);
  });
  const renderableAnchors: MessageSelectionAnchor[] = [];
  let cursor = 0;

  for (const anchor of sortedAnchors) {
    const startOffset = clamp(anchor.startOffset, 0, content.length);
    const endOffset = clamp(anchor.endOffset, 0, content.length);

    if (startOffset >= endOffset || startOffset < cursor) {
      continue;
    }

    renderableAnchors.push({
      ...anchor,
      label: content.slice(startOffset, endOffset) || anchor.label,
      startOffset,
      endOffset,
    });
    cursor = endOffset;
  }

  return renderableAnchors;
}

function makeSelectionAnchorHandleId(branchId: string) {
  return `selection-anchor-${branchId}`;
}

function buildFlowGraph({
  liveAssistantStates,
  snapshot,
  activePathMessageId,
  selectionDraft,
  measuredNodeHeights,
  onMeasureHeight,
  onPickMessage,
  onActivateMessagePath,
  onSelectionDraft,
  showSessionIds,
}: {
  liveAssistantStates: Record<string, AssistantStreamState>;
  snapshot: GraphSnapshot;
  activePathMessageId: string | null;
  selectionDraft: SelectionDraft | null;
  measuredNodeHeights: Record<string, number>;
  onMeasureHeight: (messageId: string, height: number) => void;
  onPickMessage: (messageId: string) => void;
  onActivateMessagePath: (messageId: string) => void;
  onSelectionDraft: (draft: SelectionDraft) => void;
  showSessionIds: boolean;
}) {
  const activeEdgeIds = getActiveEdgeIds(snapshot, activePathMessageId);
  const nodes: Node[] = [];

  if (snapshot.messages.length === 0) {
    return { nodes, edges: [] };
  }

  const branchOrder = new Map(snapshot.branches.map((branch, index) => [branch.id, index]));
  const messagesById = new Map(snapshot.messages.map((message) => [message.id, message]));
  const messagesByBranch = new Map<string, MessageNode[]>();
  const childBranchesBySourceMessage = new Map<string, typeof snapshot.branches>();
  const selectionAnchorsByMessageId = new Map<string, MessageSelectionAnchor[]>();
  const sourceHandleByEdgeId = new Map<string, string>();

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

    const firstBranchMessage = messagesByBranch.get(branch.id)?.[0];
    const sourceMessage = messagesById.get(branch.sourceMessageId);
    if (
      !firstBranchMessage ||
      !sourceMessage ||
      !branch.selectedText ||
      typeof branch.startOffset !== "number" ||
      typeof branch.endOffset !== "number" ||
      branch.startOffset < 0 ||
      branch.endOffset > sourceMessage.content.length ||
      branch.endOffset <= branch.startOffset
    ) {
      continue;
    }

    const forkEdgeId = `edge_fork_${branch.sourceMessageId}_${firstBranchMessage.id}`;
    const anchors = selectionAnchorsByMessageId.get(branch.sourceMessageId) ?? [];
    const label = branch.selectedText.trim() || "Selected passage";

    anchors.push({
      id: branch.id,
      handleId: makeSelectionAnchorHandleId(branch.id),
      targetMessageId: firstBranchMessage.id,
      label,
      startOffset: branch.startOffset,
      endOffset: branch.endOffset,
      isActive: activeEdgeIds.has(forkEdgeId),
    });
    selectionAnchorsByMessageId.set(branch.sourceMessageId, anchors);
    sourceHandleByEdgeId.set(forkEdgeId, makeSelectionAnchorHandleId(branch.id));
  }

  for (const childBranches of childBranchesBySourceMessage.values()) {
    childBranches.sort((left, right) => (branchOrder.get(left.id) ?? 0) - (branchOrder.get(right.id) ?? 0));
  }

  const edges: Edge[] = snapshot.edges.map((edge) => {
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
          liveAssistantState: liveAssistantStates[message.id] ?? snapshot.assistantStates[message.id] ?? null,
          isActiveMessage: message.id === activePathMessageId,
          hasSelectionDraft: selectionDraft?.sourceMessageId === message.id,
          selectionAnchors: selectionAnchorsByMessageId.get(message.id) ?? [],
          showSessionId: showSessionIds,
          sessionLabelSide: laneIndex < 0 ? "left" : "right",
          onMeasureHeight,
          onPickMessage,
          onActivateMessagePath,
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

function buildOptimisticRootStreamTurn(
  snapshot: GraphSnapshot,
  input: {
    prompt: string;
    machineId: string;
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
      sessionId: null,
      machineId: input.machineId,
      createdAt,
    } satisfies MessageNode,
    {
      id: assistantMessageId,
      branchId: rootBranchId,
      role: "assistant",
      content: "",
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
      sessionId: null,
      machineId: sourceMessage.machineId,
      createdAt,
    } satisfies MessageNode,
    {
      id: assistantMessageId,
      branchId,
      role: "assistant",
      content: "",
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
      sessionId: null,
      machineId: input.machineId,
      createdAt,
    } satisfies MessageNode,
    {
      id: assistantMessageId,
      branchId: input.branchId,
      role: "assistant",
      content: "",
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
  snapshot: GraphSnapshot | undefined;
}): PendingTurnMetadata {
  return buildOptimisticRootStreamTurn(input.snapshot ?? createEmptyRootSnapshot(), {
    prompt: input.prompt,
    machineId: input.machineId,
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
