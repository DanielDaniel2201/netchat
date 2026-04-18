import {
  CSSProperties,
  FormEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  useUpdateNodeInternals,
  useReactFlow,
  useViewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  Newspaper,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import {
  AgentRuntimeKind,
  AgentRuntimeOption,
  AssistantStreamState,
  CreateBranchInput,
  CreateBranchTurnInput,
  CreateNetInput,
  CreateRootArticleInput,
  CreateRootTurnInput,
  GraphSnapshot,
  MachineWorkspacesState,
  MessageNode,
  PickWorkspaceFolderResult,
  TurnStreamEvent,
  UiConfig,
  WorkspaceDirectoryListing,
  WorkspaceExplorerEntry,
  WorkspaceFileContent,
  UpdateNetInput,
  WorkspaceState,
  buildGraphEdges,
  createPendingAssistantState,
  describeBranchCreation,
  finalizeAssistantState,
  makeId,
  resolveAgentRuntimeLabel,
  rootBranchId,
} from "@netchat/shared";
import remarkGfm from "remark-gfm";
import { create } from "zustand";

import claudeIconUrl from "./assets/claude.svg";
import droidIconUrl from "./assets/droid.svg";
import openaiIconUrl from "./assets/openai.svg";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { cn } from "./lib/cn";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
const messageNodeWidth = Math.round((1480 * 2) / 3);
const branchLaneWidth = 1860;
const branchMessageGap = 96;
const branchForkGap = 92;
const branchForkHandleTop = 112;
const selectionBranchConversationGap = Math.round((branchLaneWidth - messageNodeWidth) / 3);
const selectionBranchLaneWidth = messageNodeWidth + selectionBranchConversationGap;
const bubbleComposerGap = 18;
const bubbleComposerWidth = 760;
const newNetComposerWidth = 840;
const messageEstimateCharsPerLine = 70;
const messageEstimateLineHeight = 34;
const canvasMinZoom = 0.35;
const canvasMaxZoom = 1.45;
const autoFitMaxZoom = 0.86;
const initialRootTurnVerticalCenterRatio = 0.25;
const branchEntryViewportTopGap = 32;
const sidebarCollapsedStorageKey = "netchat.sidebar.collapsed";
const workspaceOrderStorageKey = "netchat.workspace.order";
const workspacePanelsWidthStorageKey = "netchat.workspace.panels.width";
const workspaceExplorerWidthStorageKey = "netchat.workspace.explorer.width";
const desktopCanvasLayoutBreakpoint = 1024;
const expandedSidebarWidth = 288;
const collapsedSidebarWidth = 80;
const desktopWorkspacePanelsDefaultWidth = 860;
const desktopWorkspaceExplorerDefaultWidth = 320;
const desktopWorkspaceExplorerMinWidth = 220;
const desktopWorkspaceFilePreviewMinWidth = 320;
const desktopWorkspacePanelsMinCanvasWidth = 360;
const desktopWorkspacePanelsMaxWidthRatio = 0.72;
const focusViewTopPadding = 144;
const focusViewScrollTopInset = 152;
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

type RootComposerMode = "conversation" | "article";

type MessageNodeData = {
  message: MessageNode;
  persistedAssistantState: AssistantStreamState | null;
  assistantLabel: string;
  isActiveMessage: boolean;
  hasSelectionDraft: boolean;
  selectionAnchors: MessageSelectionAnchor[];
  showSessionId: boolean;
  sessionLabelSide: "left" | "right";
  onMeasureHeight: (messageId: string, height: number) => void;
  onMeasureSelectionAnchors: (messageId: string, anchors: MeasuredSelectionAnchorLayout[]) => void;
  onEnterFocusView: (messageId: string) => void;
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

type MeasuredSelectionAnchorLayout = {
  id: string;
  side: "left" | "right";
  top: number;
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

type AgentDisplayInfo = {
  label: string;
  runtimeKind: AgentRuntimeKind | null;
};

const agentRuntimeIconSources: Partial<Record<AgentRuntimeKind, string>> = {
  claude: claudeIconUrl,
  codex: openaiIconUrl,
  droid: droidIconUrl,
};

type CanvasViewport = {
  x: number;
  y: number;
  zoom: number;
};

type PendingViewportAction = {
  kind: "center-message" | "branch-entry";
  messageId: string;
};

type FocusBranchContinuation = {
  id: string;
  kind: "main" | "branch";
  sourceMessageId: string;
  branchId: string;
  targetMessageId: string;
  focusTargetMessageId: string;
  preview: string;
  isActive: boolean;
};

type WorkspacePaneDragState =
  | {
      kind: "canvas-explorer";
      startClientX: number;
      startPanelsWidth: number;
      hasFilePreview: boolean;
    }
  | {
      kind: "explorer-file";
      startClientX: number;
      startExplorerWidth: number;
      totalPanelsWidth: number;
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
    <h1 className="mb-4 text-[27px] font-semibold leading-[1.18] tracking-[-0.03em] text-[var(--text-main)]">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-4 text-[23px] font-semibold leading-[1.24] tracking-[-0.02em] text-[var(--text-main)]">
      {children}
    </h2>
  ),
  h3: ({ children }) => <h3 className="mb-3 text-[20px] font-semibold leading-[1.3] text-[var(--text-main)]">{children}</h3>,
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
      <table className="min-w-full border-collapse border border-[var(--node-border)] text-[15px] leading-7">
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
    <pre className="my-4 overflow-x-auto border border-[var(--node-border)] bg-[rgba(244,241,234,0.46)] px-4 py-4 text-[14px] leading-7 last:mb-0">
      {children}
    </pre>
  ),
  code: ({ children, className }) => {
    const normalizedClassName = className ?? "";
    const isBlockCode = normalizedClassName.includes("language-");
    const content = String(children).replace(/\n$/, "");

    if (isBlockCode) {
      return <code className={cn(normalizedClassName, "font-mono text-[14px]")}>{content}</code>;
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
  const initialSidebarCollapsed = readBooleanFromLocalStorage(sidebarCollapsedStorageKey, false);
  const initialViewportWidth = typeof window === "undefined" ? desktopCanvasLayoutBreakpoint : window.innerWidth;
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const focusViewScrollRef = useRef<HTMLDivElement>(null);
  const skipNextFocusTargetAutoScrollRef = useRef(false);
  const workspacePanelsHostRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const agentDropdownRef = useRef<HTMLDivElement>(null);
  const openNetMenuRef = useRef<HTMLDivElement>(null);
  const lastAutoFitNetIdRef = useRef<string | null>(null);
  const lastViewportResetNetIdRef = useRef<string | null>(null);
  const selectedMessageId = useComposerStore((state) => state.selectedMessageId);
  const setSelectedMessageId = useComposerStore((state) => state.setSelectedMessageId);
  const [activePathMessageId, setActivePathMessageId] = useState<string | null>(null);
  const [composerValue, setComposerValue] = useState("");
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(null);
  const [composerAnchor, setComposerAnchor] = useState<ComposerAnchor | null>(null);
  const [expandedBranchIds, setExpandedBranchIds] = useState<string[]>([]);
  const [pendingViewportAction, setPendingViewportAction] = useState<PendingViewportAction | null>(null);
  const [focusViewTargetMessageId, setFocusViewTargetMessageId] = useState<string | null>(null);
  const [focusReturnState, setFocusReturnState] = useState<{
    articleMessageId: string;
    sourceMessageId: string;
    branchId: string;
  } | null>(null);
  const [pendingFocusAnchorScroll, setPendingFocusAnchorScroll] = useState<{
    sourceMessageId: string;
    branchId: string;
  } | null>(null);
  const [measuredSelectionAnchorLayoutsByMessageId, setMeasuredSelectionAnchorLayoutsByMessageId] = useState<
    Record<string, MeasuredSelectionAnchorLayout[]>
  >({});
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(initialSidebarCollapsed);
  const [isSidebarTransitionReady, setIsSidebarTransitionReady] = useState(false);
  const [workspaceOrder, setWorkspaceOrder] = useState<string[]>(() => readStringArrayFromLocalStorage(workspaceOrderStorageKey));
  const [viewportWidth, setViewportWidth] = useState(initialViewportWidth);
  const [workspacePanelsWidth, setWorkspacePanelsWidth] = useState(() =>
    readNumberFromLocalStorage(workspacePanelsWidthStorageKey, desktopWorkspacePanelsDefaultWidth),
  );
  const [workspaceExplorerWidth, setWorkspaceExplorerWidth] = useState(() =>
    readNumberFromLocalStorage(workspaceExplorerWidthStorageKey, desktopWorkspaceExplorerDefaultWidth),
  );
  const [workspacePaneDragState, setWorkspacePaneDragState] = useState<WorkspacePaneDragState | null>(null);
  const [viewport, setViewport] = useState<CanvasViewport>(
    () =>
      buildInitialRootTurnViewport({
        canvasSize: getInitialCanvasSize(initialSidebarCollapsed),
        prompt: "",
      }) ?? { x: 0, y: 0, zoom: canvasMinZoom },
  );
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [measuredNodeHeights, setMeasuredNodeHeights] = useState<Record<string, number>>({});
  const [editingNetId, setEditingNetId] = useState<string | null>(null);
  const [editingNetTitle, setEditingNetTitle] = useState("");
  const [openNetMenuId, setOpenNetMenuId] = useState<string | null>(null);
  const [isAgentDropdownOpen, setIsAgentDropdownOpen] = useState(false);
  const [pendingNetDeletion, setPendingNetDeletion] = useState<{ id: string; title: string } | null>(null);
  const [pendingWorkspaceDeletion, setPendingWorkspaceDeletion] = useState<{ id: string; title: string } | null>(null);
  const [isWorkspaceExplorerOpen, setIsWorkspaceExplorerOpen] = useState(false);
  const [expandedExplorerDirectoryPaths, setExpandedExplorerDirectoryPaths] = useState<string[]>([""]);
  const [newRootComposerMode, setNewRootComposerMode] = useState<RootComposerMode>("conversation");
  const [selectedArticleFilePath, setSelectedArticleFilePath] = useState<string | null>(null);
  const [selectedWorkspaceFilePath, setSelectedWorkspaceFilePath] = useState<string | null>(null);
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<string[]>([]);
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState<string | null>(null);
  const [activeStreamedTurn, setActiveStreamedTurn] = useState<ActiveStreamedTurn | null>(null);
  const [streamErrorMessage, setStreamErrorMessage] = useState<string | null>(null);
  const clearLiveAssistantStates = useLiveAssistantStateStore((state) => state.clearStates);
  const pruneLiveAssistantStates = useLiveAssistantStateStore((state) => state.pruneStates);
  const setLiveAssistantState = useLiveAssistantStateStore((state) => state.setState);

  const workspaceQuery = useQuery({
    queryKey: ["workspace"],
    queryFn: () => request<WorkspaceState>("/api/workspace"),
  });
  const workspacesQuery = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => request<MachineWorkspacesState>("/api/workspaces"),
  });
  const graphQuery = useQuery({
    queryKey: ["graph"],
    queryFn: () => request<GraphSnapshot>("/api/graph"),
  });
  const uiConfigQuery = useQuery({
    queryKey: ["ui-config"],
    queryFn: () => request<UiConfig>("/api/ui-config"),
  });
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => request<AgentRuntimeOption[]>("/api/agents"),
    refetchInterval: 2500,
    retry: false,
  });

  const workspace = workspaceQuery.data;
  const machineWorkspaces = workspacesQuery.data;
  const persistedSnapshot = graphQuery.data;
  const snapshot = activeStreamedTurn?.optimisticSnapshot ?? persistedSnapshot;
  const uiConfig = uiConfigQuery.data;
  const agentOptions = agentsQuery.data ?? [];
  const workspaceNets = workspace?.nets ?? [];
  const knownWorkspaces = machineWorkspaces?.workspaces ?? [];
  const defaultWorkspaceOrder = useMemo(
    () =>
      [...knownWorkspaces]
        .sort((left, right) => {
          const creationDelta = right.createdAt.localeCompare(left.createdAt);
          if (creationDelta !== 0) {
            return creationDelta;
          }

          return left.workingDirectory.localeCompare(right.workingDirectory);
        })
        .map((workspaceSummary) => workspaceSummary.workspaceId),
    [knownWorkspaces],
  );
  const orderedWorkspaces = useMemo(() => {
    if (workspaceOrder.length === 0) {
      return [...knownWorkspaces].sort((left, right) => {
        const creationDelta = right.createdAt.localeCompare(left.createdAt);
        if (creationDelta !== 0) {
          return creationDelta;
        }

        return left.workingDirectory.localeCompare(right.workingDirectory);
      });
    }

    const orderIndex = new Map(workspaceOrder.map((workspaceId, index) => [workspaceId, index]));
    return [...knownWorkspaces].sort((left, right) => {
      const leftIndex = orderIndex.get(left.workspaceId);
      const rightIndex = orderIndex.get(right.workspaceId);

      if (leftIndex !== undefined && rightIndex !== undefined) {
        return leftIndex - rightIndex;
      }

      if (leftIndex !== undefined) {
        return -1;
      }

      if (rightIndex !== undefined) {
        return 1;
      }

      const creationDelta = right.createdAt.localeCompare(left.createdAt);
      if (creationDelta !== 0) {
        return creationDelta;
      }

      return left.workingDirectory.localeCompare(right.workingDirectory);
    });
  }, [knownWorkspaces, workspaceOrder]);
  const activeWorkspaceId = machineWorkspaces?.activeWorkspaceId ?? workspace?.workspaceId ?? null;
  const canPickWorkspaceFolder = machineWorkspaces?.canPickWorkspaceFolder ?? true;
  const workspaceFileQuery = useQuery({
    queryKey: ["workspace-file", activeWorkspaceId, selectedWorkspaceFilePath],
    queryFn: () =>
      request<WorkspaceFileContent>(`/api/workspace/file${buildWorkspacePathQueryString(selectedWorkspaceFilePath ?? "")}`),
    enabled: Boolean(isWorkspaceExplorerOpen && activeWorkspaceId && selectedWorkspaceFilePath),
  });
  const activeNetId = workspace?.activeNetId ?? null;
  const activeNet = workspaceNets.find((net) => net.id === activeNetId) ?? null;
  const hasWorkspaceFilePreview = selectedWorkspaceFilePath !== null;
  const isDesktopWorkspacePanels = viewportWidth >= desktopCanvasLayoutBreakpoint;
  const desktopSidebarWidth = isSidebarCollapsed ? collapsedSidebarWidth : expandedSidebarWidth;
  const workspacePanelsHostWidth = Math.max(0, viewportWidth - desktopSidebarWidth);
  const workspacePaneLayout = useMemo(
    () =>
      resolveWorkspacePaneLayout({
        isDesktop: isDesktopWorkspacePanels,
        hostWidth: workspacePanelsHostWidth,
        totalWidth: workspacePanelsWidth,
        explorerWidth: workspaceExplorerWidth,
        hasFilePreview: hasWorkspaceFilePreview,
      }),
    [
      hasWorkspaceFilePreview,
      isDesktopWorkspacePanels,
      workspaceExplorerWidth,
      workspacePanelsHostWidth,
      workspacePanelsWidth,
    ],
  );
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
    selectedMessageId && isConversationSourceRole(messagesById.get(selectedMessageId)?.role)
      ? (messagesById.get(selectedMessageId) ?? null)
      : null;
  const selectedBranch = selectedMessage ? (branchesById.get(selectedMessage.branchId) ?? null) : null;
  const rootBranch = branchesById.get(rootBranchId) ?? null;
  const rootConversationMessage = useMemo(() => (snapshot ? getRootBranchFirstConversationMessage(snapshot) : null), [snapshot]);
  const articleFocusMessage =
    rootConversationMessage && rootConversationMessage.role === "article" ? rootConversationMessage : null;
  const isArticleModeNet = articleFocusMessage !== null;
  const selectedBranchMessages = selectedMessage ? messagesByBranch.get(selectedMessage.branchId) ?? [] : [];
  const selectionForSelectedMessage =
    selectedMessage && selectionDraft?.sourceMessageId === selectedMessage.id ? selectionDraft : null;
  const isFocusViewActive = focusViewTargetMessageId !== null;
  const pathViewportMessageId = isFocusViewActive ? focusViewTargetMessageId : activePathMessageId;
  const selectedMessageIsTail = selectedMessage
    ? selectedBranchMessages.at(-1)?.id === selectedMessage.id
    : true;
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
  const activeNetAgent =
    activeNet?.agentRuntimeId
      ? (agentOptions.find((agent) => agent.runtimeId === activeNet.agentRuntimeId) ?? null)
      : null;
  const fallbackAgent =
    agentOptions.find((agent) => agent.status === "online" && agent.installed) ??
    agentOptions.find((agent) => agent.installed) ??
    agentOptions[0] ??
    null;
  const defaultNewNetAgent = activeNetAgent ?? fallbackAgent;
  const sendTargetRuntimeId =
    sendMode === "root" || sendMode === "continue-root"
      ? rootBranch?.runtimeId ?? activeNet?.agentRuntimeId ?? null
      : sendMode === "continue-branch"
        ? selectedBranch?.runtimeId ?? activeNet?.agentRuntimeId ?? null
        : selectedMessage?.runtimeId ?? activeNet?.agentRuntimeId ?? null;
  const sendTargetRuntimeKind =
    sendMode === "root" || sendMode === "continue-root"
      ? rootBranch?.runtimeKind ?? activeNet?.agentRuntimeKind ?? null
      : sendMode === "continue-branch"
        ? selectedBranch?.runtimeKind ?? activeNet?.agentRuntimeKind ?? null
        : selectedMessage?.runtimeKind ?? activeNet?.agentRuntimeKind ?? null;
  const sendTargetAgent =
    sendTargetRuntimeId ? (agentOptions.find((agent) => agent.runtimeId === sendTargetRuntimeId) ?? null) : null;
  const canSendOnActiveLane = Boolean(sendTargetAgent && sendTargetAgent.status === "online" && sendTargetAgent.installed);
  const activeAgentLabel =
    activeNet?.agentRuntimeLabel ??
    activeNetAgent?.runtimeLabel ??
    (activeNet?.agentRuntimeId
      ? "Unknown agent"
      : (snapshot?.messages.length ?? 0) > 0
        ? "Claude Code"
        : "Select agent");

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
      setNewRootComposerMode("conversation");
      setSelectedArticleFilePath(null);
      setComposerValue("");
      setSelectionDraft(null);
      setExpandedBranchIds([]);
      setSelectedMessageId(null);
      setActivePathMessageId(null);
      clearBrowserSelection();
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
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
      setNewRootComposerMode("conversation");
      setSelectedArticleFilePath(null);
      setComposerValue("");
      setSelectionDraft(null);
      setExpandedBranchIds([]);
      setSelectedMessageId(null);
      setActivePathMessageId(null);
      clearBrowserSelection();
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: (error) => {
      logWeb("error", `Switching nets failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
    },
  });
  const selectWorkspaceMutation = useMutation({
    mutationFn: async (workspaceId: string) => {
      logWeb("info", `Switching to workspace ${workspaceId}.`);
      return request<WorkspaceState>(`/api/workspaces/${workspaceId}/select`, {
        method: "POST",
      });
    },
    onSuccess: async (nextWorkspace) => {
      queryClient.setQueryData(["workspace"], nextWorkspace);
      setNewRootComposerMode("conversation");
      setSelectedArticleFilePath(null);
      setExpandedWorkspaceIds((current) =>
        current.includes(nextWorkspace.workspaceId) ? current : [nextWorkspace.workspaceId, ...current],
      );
      setComposerValue("");
      setSelectionDraft(null);
      setExpandedBranchIds([]);
      setSelectedMessageId(null);
      setActivePathMessageId(null);
      clearBrowserSelection();
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: (error) => {
      logWeb("error", `Switching workspaces failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
    },
  });
  const selectWorkspaceNetMutation = useMutation({
    mutationFn: async (variables: { workspaceId: string; netId: string }) => {
      logWeb("info", `Switching to workspace ${variables.workspaceId} net ${variables.netId}.`);
      return request<WorkspaceState>(`/api/workspaces/${variables.workspaceId}/nets/${variables.netId}/select`, {
        method: "POST",
      });
    },
    onSuccess: async (nextWorkspace) => {
      queryClient.setQueryData(["workspace"], nextWorkspace);
      setNewRootComposerMode("conversation");
      setSelectedArticleFilePath(null);
      setExpandedWorkspaceIds((current) =>
        current.includes(nextWorkspace.workspaceId) ? current : [nextWorkspace.workspaceId, ...current],
      );
      setComposerValue("");
      setSelectionDraft(null);
      setExpandedBranchIds([]);
      setSelectedMessageId(null);
      setActivePathMessageId(null);
      clearBrowserSelection();
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: (error) => {
      logWeb("error", `Switching workspace nets failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
    },
  });
  const openWorkspaceFolderMutation = useMutation({
    mutationFn: async () => {
      logWeb("info", "Opening the native workspace folder picker.");
      const pickedFolder = await request<PickWorkspaceFolderResult>("/api/workspaces/pick-folder", {
        method: "POST",
      });
      if (!pickedFolder.workingDirectory) {
        return null;
      }

      return request<WorkspaceState>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({
          workingDirectory: pickedFolder.workingDirectory,
        }),
      });
    },
    onSuccess: async (nextWorkspace) => {
      if (!nextWorkspace) {
        return;
      }

      queryClient.setQueryData(["workspace"], nextWorkspace);
      setNewRootComposerMode("conversation");
      setSelectedArticleFilePath(null);
      setWorkspaceOrder((current) =>
        current.includes(nextWorkspace.workspaceId) ? current : [nextWorkspace.workspaceId, ...current],
      );
      setExpandedWorkspaceIds((current) =>
        current.includes(nextWorkspace.workspaceId) ? current : [nextWorkspace.workspaceId, ...current],
      );
      setComposerValue("");
      setSelectionDraft(null);
      setExpandedBranchIds([]);
      setSelectedMessageId(null);
      setActivePathMessageId(null);
      clearBrowserSelection();
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: (error) => {
      logWeb("error", `Opening a workspace folder failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
    },
  });
  const deleteWorkspaceMutation = useMutation({
    mutationFn: async (workspaceId: string) => {
      logWeb("info", `Deleting workspace ${workspaceId}.`);
      return request<WorkspaceState>(`/api/workspaces/${workspaceId}`, {
        method: "DELETE",
      });
    },
    onSuccess: async (nextWorkspace, deletedWorkspaceId) => {
      const activeWorkspaceChanged = nextWorkspace.workspaceId !== activeWorkspaceId;
      queryClient.setQueryData(["workspace"], nextWorkspace);
      setWorkspaceOrder((current) => current.filter((workspaceId) => workspaceId !== deletedWorkspaceId));
      setExpandedWorkspaceIds((current) => current.filter((workspaceId) => workspaceId !== deletedWorkspaceId));
      setExpandedWorkspaceIds((current) =>
        current.includes(nextWorkspace.workspaceId) ? current : [nextWorkspace.workspaceId, ...current],
      );
      setOpenNetMenuId(null);
      setPendingNetDeletion(null);
      setPendingWorkspaceDeletion(null);

      if (activeWorkspaceChanged) {
        setNewRootComposerMode("conversation");
        setSelectedArticleFilePath(null);
        setComposerValue("");
        setSelectionDraft(null);
        setExpandedBranchIds([]);
        setSelectedMessageId(null);
        setActivePathMessageId(null);
        clearBrowserSelection();
        await queryClient.invalidateQueries({ queryKey: ["graph"] });
      }

      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: (error) => {
      logWeb("error", `Deleting a workspace failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
    },
  });
  const renameNetMutation = useMutation({
    mutationFn: async (variables: { netId: string; input: UpdateNetInput }) => {
      logWeb("info", `Updating net ${variables.netId}.`);
      return request<WorkspaceState>(`/api/nets/${variables.netId}`, {
        method: "PATCH",
        body: JSON.stringify(variables.input),
      });
    },
    onSuccess: async (nextWorkspace) => {
      queryClient.setQueryData(["workspace"], nextWorkspace);
      setEditingNetId(null);
      setEditingNetTitle("");
      setOpenNetMenuId(null);
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: (error) => {
      logWeb("error", `Renaming a net failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
    },
  });
  const updateNetAgentMutation = useMutation({
    mutationFn: async (variables: { netId: string; input: UpdateNetInput }) => {
      logWeb("info", `Updating net agent for ${variables.netId}.`);
      return request<WorkspaceState>(`/api/nets/${variables.netId}`, {
        method: "PATCH",
        body: JSON.stringify(variables.input),
      });
    },
    onSuccess: async (nextWorkspace) => {
      queryClient.setQueryData(["workspace"], nextWorkspace);
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: (error) => {
      logWeb("error", `Updating a net agent failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
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
        setNewRootComposerMode("conversation");
        setSelectedArticleFilePath(null);
        setComposerValue("");
        setSelectionDraft(null);
        setExpandedBranchIds([]);
        setSelectedMessageId(null);
        setActivePathMessageId(null);
        clearBrowserSelection();
        await queryClient.invalidateQueries({ queryKey: ["graph"] });
      }

      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: (error) => {
      logWeb("error", `Deleting a net failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
    },
  });
  const createRootArticleMutation = useMutation({
    mutationFn: async (filePath: string) => {
      logWeb("info", `Seeding article mode from ${filePath}.`);
      return request<GraphSnapshot>("/api/root-article", {
        method: "POST",
        body: JSON.stringify({
          filePath,
        } satisfies CreateRootArticleInput),
      });
    },
    onSuccess: async (nextSnapshot) => {
      queryClient.setQueryData(["graph"], nextSnapshot);
      setNewRootComposerMode("conversation");
      setComposerValue("");
      setSelectionDraft(null);
      setStreamErrorMessage(null);
      clearBrowserSelection();

      const articleMessageId =
        nextSnapshot.messages.find((message) => message.branchId === rootBranchId && message.role === "article")?.id ?? null;
      setSelectedMessageId(articleMessageId);
      setActivePathMessageId(articleMessageId);
      focusComposer();

      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: (error) => {
      setStreamErrorMessage(formatErrorMessage(error) ?? "The article could not be loaded.");
      logWeb("error", `Seeding article mode failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
    },
  });
  const isThinking = activeStreamedTurn?.isPending ?? false;

  function focusComposer() {
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
  }

  const exitFocusView = useCallback(() => {
    setFocusViewTargetMessageId(null);
  }, []);

  const openFocusView = useCallback(
    (messageId: string) => {
      activateMessagePath(messageId);
      setSelectedMessageId(null);
      setSelectionDraft(null);
      setPendingViewportAction(null);
      clearBrowserSelection();
      setFocusViewTargetMessageId(messageId);
    },
    [setSelectedMessageId],
  );
  const collapseBranchAndDescendants = useCallback(
    (branchId: string) => {
      if (!snapshot) {
        return;
      }

      const descendantBranchIds = new Set(getDescendantBranchIds(snapshot, branchId));
      descendantBranchIds.add(branchId);
      setExpandedBranchIds((current) => current.filter((candidateBranchId) => !descendantBranchIds.has(candidateBranchId)));
    },
    [snapshot],
  );

  const returnToArticleFocusView = useCallback(() => {
    if (!focusReturnState) {
      return;
    }

    collapseBranchAndDescendants(focusReturnState.branchId);
    setPendingFocusAnchorScroll({
      sourceMessageId: focusReturnState.sourceMessageId,
      branchId: focusReturnState.branchId,
    });
    openFocusView(focusReturnState.articleMessageId);
  }, [collapseBranchAndDescendants, focusReturnState, openFocusView]);

  const applyViewport = useCallback(
    (nextViewport: CanvasViewport) => {
      setViewport((current) =>
        current.x === nextViewport.x && current.y === nextViewport.y && current.zoom === nextViewport.zoom
          ? current
          : nextViewport,
      );
      void reactFlow.setViewport(nextViewport, { duration: 0 });
    },
    [reactFlow],
  );

  const setInitialRootTurnViewport = useCallback(
    (prompt: string) => {
      const nextViewport = buildInitialRootTurnViewport({
        canvasSize,
        prompt,
      });
      if (!nextViewport) {
        return false;
      }

      lastAutoFitNetIdRef.current = activeNetId ?? "__active-net__";
      applyViewport(nextViewport);
      return true;
    },
    [activeNetId, applyViewport, canvasSize],
  );

  function activateMessagePath(messageId: string | null) {
    setActivePathMessageId(messageId);
  }

  const syncBubbleComposerAnchor = useCallback(() => {
    if (!selectedMessage) {
      setComposerAnchor((current) => (current === null ? current : null));
      return;
    }

    const nodeElement = isFocusViewActive
      ? focusViewScrollRef.current?.querySelector<HTMLElement>(`[data-focus-message-id="${selectedMessage.id}"]`) ?? null
      : document.querySelector<HTMLElement>(`.react-flow__node[data-id="${selectedMessage.id}"]`);
    if (!nodeElement) {
      setComposerAnchor((current) => (current === null ? current : null));
      return;
    }

    const rect = nodeElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const composerWidth = Math.min(bubbleComposerWidth, Math.max(320, viewportWidth - 32));
    const maxTop = Math.max(16, viewportHeight - 320);

    const nextAnchor = {
      left: clamp(rect.left + rect.width / 2 - composerWidth / 2, 16, viewportWidth - composerWidth - 16),
      top: clamp(rect.bottom + bubbleComposerGap, 16, maxTop),
      width: composerWidth,
    } satisfies ComposerAnchor;

    setComposerAnchor((current) =>
      current &&
      current.left === nextAnchor.left &&
      current.top === nextAnchor.top &&
      current.width === nextAnchor.width
        ? current
        : nextAnchor,
    );
  }, [isFocusViewActive, selectedMessage]);

  function pickMessage(messageId: string) {
    if (selectedMessageId === messageId) {
      activateMessagePath(null);
      setSelectedMessageId(null);
      setSelectionDraft(null);
      clearBrowserSelection();
      return;
    }

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

  function updateActiveNetAgent(runtimeId: string) {
    if (!activeNetId) {
      return;
    }

    const nextAgent = agentOptions.find((agent) => agent.runtimeId === runtimeId);
    if (!nextAgent || nextAgent.runtimeId === activeNet?.agentRuntimeId) {
      return;
    }

    updateNetAgentMutation.mutate({
      netId: activeNetId,
      input: {
        agentRuntimeId: nextAgent.runtimeId,
        agentRuntimeKind: nextAgent.runtimeKind,
      },
    });
  }

  function toggleWorkspaceExpansion(workspaceId: string) {
    setExpandedWorkspaceIds((current) =>
      current.includes(workspaceId)
        ? current.filter((candidate) => candidate !== workspaceId)
        : [...current, workspaceId],
    );
  }

  function handleWorkspaceItemClick(workspaceId: string) {
    setOpenNetMenuId(null);
    toggleWorkspaceExpansion(workspaceId);
  }

  function requestWorkspaceDeletion(workspaceId: string, workspaceName: string) {
    if (deleteWorkspaceMutation.isPending) {
      return;
    }

    setOpenNetMenuId(null);
    setPendingWorkspaceDeletion({ id: workspaceId, title: workspaceName });
  }

  function cancelWorkspaceDeletion() {
    if (deleteWorkspaceMutation.isPending) {
      return;
    }

    setPendingWorkspaceDeletion(null);
  }

  function confirmWorkspaceDeletion() {
    if (!pendingWorkspaceDeletion) {
      return;
    }

    deleteWorkspaceMutation.mutate(pendingWorkspaceDeletion.id);
  }

  function moveWorkspaceBefore(sourceWorkspaceId: string, targetWorkspaceId: string) {
    if (sourceWorkspaceId === targetWorkspaceId) {
      return;
    }

    const currentOrder = orderedWorkspaces.map((workspaceSummary) => workspaceSummary.workspaceId);
    const nextOrder = currentOrder.filter((workspaceId) => workspaceId !== sourceWorkspaceId);
    const targetIndex = nextOrder.indexOf(targetWorkspaceId);
    if (targetIndex === -1) {
      return;
    }

    nextOrder.splice(targetIndex, 0, sourceWorkspaceId);
    setWorkspaceOrder(nextOrder);
    writeStringArrayToLocalStorage(workspaceOrderStorageKey, nextOrder);
  }

  function toggleWorkspaceExplorerDirectory(directoryPath: string) {
    setExpandedExplorerDirectoryPaths((current) =>
      current.includes(directoryPath)
        ? current.filter((candidate) => candidate !== directoryPath)
        : [...current, directoryPath],
    );
  }

  function handleWorkspaceFileSelect(filePath: string) {
    setIsWorkspaceExplorerOpen(true);
    setSelectedWorkspaceFilePath(filePath);
  }

  function handleArticleFileSelect(filePath: string) {
    if (createRootArticleMutation.isPending) {
      return;
    }

    setIsAgentDropdownOpen(false);
    setSelectedArticleFilePath(filePath);
    setSelectionDraft(null);
    setStreamErrorMessage(null);
    clearBrowserSelection();
    createRootArticleMutation.mutate(filePath);
  }

  function startCanvasExplorerResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!isDesktopWorkspacePanels) {
      return;
    }

    event.preventDefault();
    setWorkspacePaneDragState({
      kind: "canvas-explorer",
      startClientX: event.clientX,
      startPanelsWidth: workspacePaneLayout.totalWidth,
      hasFilePreview: hasWorkspaceFilePreview,
    });
  }

  function startExplorerFileResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!isDesktopWorkspacePanels || !hasWorkspaceFilePreview) {
      return;
    }

    event.preventDefault();
    setWorkspacePaneDragState({
      kind: "explorer-file",
      startClientX: event.clientX,
      startExplorerWidth: workspacePaneLayout.explorerWidth,
      totalPanelsWidth: workspacePaneLayout.totalWidth,
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
  const reportSelectionAnchorLayouts = useCallback(
    (messageId: string, anchors: MeasuredSelectionAnchorLayout[]) => {
      const normalizedAnchors = [...anchors]
        .map((anchor) => ({
          id: anchor.id,
          side: anchor.side,
          top: Math.max(0, Math.round(anchor.top)),
        }))
        .sort((left, right) => left.top - right.top || left.id.localeCompare(right.id));

      setMeasuredSelectionAnchorLayoutsByMessageId((current) => {
        const previousAnchors = current[messageId] ?? [];
        if (areMeasuredSelectionAnchorLayoutsEqual(previousAnchors, normalizedAnchors)) {
          return current;
        }

        if (normalizedAnchors.length === 0) {
          if (!(messageId in current)) {
            return current;
          }

          const next = { ...current };
          delete next[messageId];
          return next;
        }

        return {
          ...current,
          [messageId]: normalizedAnchors,
        };
      });
    },
    [],
  );
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
        collapseBranchAndDescendants(anchor.id);
        activateMessagePath(anchor.sourceMessageId);
        if (isFocusViewActive) {
          setFocusViewTargetMessageId(anchor.sourceMessageId);
          setPendingViewportAction(null);
        } else {
          setPendingViewportAction({
            kind: "center-message",
            messageId: anchor.sourceMessageId,
          });
        }
        return;
      }

      if (isFocusViewActive && articleFocusMessage) {
        setExpandedBranchIds((current) => (current.includes(anchor.id) ? current : [...current, anchor.id]));
        activateMessagePath(anchor.targetMessageId);
        setFocusReturnState({
          articleMessageId: articleFocusMessage.id,
          sourceMessageId: anchor.sourceMessageId,
          branchId: anchor.id,
        });
        setPendingFocusAnchorScroll(null);
        exitFocusView();
        setPendingViewportAction({
          kind: "branch-entry",
          messageId: anchor.targetMessageId,
        });
        return;
      }

      setExpandedBranchIds((current) => (current.includes(anchor.id) ? current : [...current, anchor.id]));
      activateMessagePath(anchor.targetMessageId);
      if (isFocusViewActive) {
        setFocusViewTargetMessageId(anchor.targetMessageId);
        setPendingViewportAction(null);
      } else {
        setPendingViewportAction({
          kind: "branch-entry",
          messageId: anchor.targetMessageId,
        });
      }
    },
    [articleFocusMessage, collapseBranchAndDescendants, exitFocusView, isFocusViewActive, snapshot, setSelectedMessageId],
  );

  const graph = useMemo(() => {
    if (!snapshot) {
      return { nodes: [], edges: [] };
    }

    return buildFlowGraph({
      defaultAssistantLabel: activeAgentLabel,
      expandedBranchIds: expandedBranchIdSet,
      snapshot,
      activePathMessageId: pathViewportMessageId,
      persistedAssistantStatesByMessageId,
      onPickMessage: pickMessage,
      onToggleSelectionAnchor: toggleSelectionAnchor,
      onEnterFocusView: openFocusView,
      selectionDraft,
      measuredNodeHeights,
      measuredSelectionAnchorLayoutsByMessageId,
      onMeasureHeight: reportMessageNodeHeight,
      onMeasureSelectionAnchors: reportSelectionAnchorLayouts,
      onSelectionDraft: applySelectionDraft,
      showSessionIds: uiConfig?.showSessionIds ?? false,
    });
  }, [
    activeAgentLabel,
    expandedBranchIdSet,
    measuredNodeHeights,
    measuredSelectionAnchorLayoutsByMessageId,
    openFocusView,
    pathViewportMessageId,
    persistedAssistantStatesByMessageId,
    reportMessageNodeHeight,
    reportSelectionAnchorLayouts,
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
  const focusVisibleBranchIds = useMemo(
    () =>
      snapshot && focusViewTargetMessageId
        ? getVisibleBranchIds(snapshot, focusViewTargetMessageId, expandedBranchIdSet)
        : new Set<string>(),
    [expandedBranchIdSet, focusViewTargetMessageId, snapshot],
  );
  const focusSelectionAnchorsByMessageId = useMemo(
    () =>
      snapshot && focusViewTargetMessageId
        ? buildSelectionAnchorMetadata(snapshot, focusVisibleBranchIds).selectionAnchorsByMessageId
        : new Map<string, MessageSelectionAnchor[]>(),
    [focusViewTargetMessageId, focusVisibleBranchIds, snapshot],
  );
  const focusPathMessages = useMemo(
    () =>
      snapshot && focusViewTargetMessageId ? buildFocusViewMessages(snapshot, focusViewTargetMessageId) : [],
    [focusViewTargetMessageId, snapshot],
  );
  const focusPathSignature = useMemo(() => focusPathMessages.map((message) => message.id).join("|"), [focusPathMessages]);
  const focusPathMessageIdSet = useMemo(() => new Set(focusPathMessages.map((message) => message.id)), [focusPathMessages]);
  const focusWholeMessageContinuationsBySourceMessageId = useMemo(
    () =>
      snapshot && focusViewTargetMessageId
        ? buildFocusWholeMessageContinuations(snapshot, focusPathMessageIdSet)
        : new Map<string, FocusBranchContinuation[]>(),
    [focusPathMessageIdSet, focusViewTargetMessageId, snapshot],
  );

  const handleFocusContinuationSelect = useCallback(
    (continuation: FocusBranchContinuation) => {
      activateMessagePath(continuation.focusTargetMessageId);
      setSelectedMessageId(null);
      setSelectionDraft(null);
      clearBrowserSelection();
      skipNextFocusTargetAutoScrollRef.current = true;
      setFocusViewTargetMessageId(continuation.focusTargetMessageId);
    },
    [setSelectedMessageId],
  );

  const handleViewportChange = useCallback(
    (nextViewport: CanvasViewport) => {
      setViewport((current) =>
        current.x === nextViewport.x && current.y === nextViewport.y && current.zoom === nextViewport.zoom
          ? current
          : nextViewport,
      );
      syncBubbleComposerAnchor();
    },
    [syncBubbleComposerAnchor],
  );

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
    lastAutoFitNetIdRef.current = null;
    lastViewportResetNetIdRef.current = null;
    setFocusReturnState(null);
    setPendingFocusAnchorScroll(null);
  }, [activeNetId]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }

    setExpandedWorkspaceIds((current) =>
      current.includes(activeWorkspaceId) ? current : [activeWorkspaceId, ...current],
    );
  }, [activeWorkspaceId]);

  useEffect(() => {
    setExpandedExplorerDirectoryPaths([""]);
    setSelectedWorkspaceFilePath(null);
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (knownWorkspaces.length === 0) {
      return;
    }

    const liveWorkspaceIds = new Set(knownWorkspaces.map((workspaceSummary) => workspaceSummary.workspaceId));
    setExpandedWorkspaceIds((current) => current.filter((workspaceId) => liveWorkspaceIds.has(workspaceId)));
  }, [knownWorkspaces]);

  useEffect(() => {
    if (!machineWorkspaces) {
      return;
    }

    const liveWorkspaceIds = new Set(defaultWorkspaceOrder);
    const nextOrder = [
      ...workspaceOrder.filter((workspaceId) => liveWorkspaceIds.has(workspaceId)),
      ...defaultWorkspaceOrder.filter((workspaceId) => !workspaceOrder.includes(workspaceId)),
    ];

    if (!stringArraysEqual(workspaceOrder, nextOrder)) {
      setWorkspaceOrder(nextOrder);
    }
  }, [defaultWorkspaceOrder, machineWorkspaces, workspaceOrder]);

  useEffect(() => {
    writeStringArrayToLocalStorage(workspaceOrderStorageKey, workspaceOrder);
  }, [workspaceOrder]);

  useEffect(() => {
    writeBooleanToLocalStorage(sidebarCollapsedStorageKey, isSidebarCollapsed);
  }, [isSidebarCollapsed]);

  useEffect(() => {
    writeNumberToLocalStorage(workspacePanelsWidthStorageKey, workspacePanelsWidth);
  }, [workspacePanelsWidth]);

  useEffect(() => {
    writeNumberToLocalStorage(workspaceExplorerWidthStorageKey, workspaceExplorerWidth);
  }, [workspaceExplorerWidth]);

  useEffect(() => {
    function handleWindowResize() {
      setViewportWidth(window.innerWidth);
    }

    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
    };
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setIsSidebarTransitionReady(true);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (!isDesktopWorkspacePanels || !isWorkspaceExplorerOpen) {
      return;
    }

    if (workspacePaneLayout.totalWidth !== workspacePanelsWidth) {
      setWorkspacePanelsWidth(workspacePaneLayout.totalWidth);
    }

    if (workspacePaneLayout.explorerWidth !== workspaceExplorerWidth) {
      setWorkspaceExplorerWidth(workspacePaneLayout.explorerWidth);
    }
  }, [
    isDesktopWorkspacePanels,
    isWorkspaceExplorerOpen,
    workspaceExplorerWidth,
    workspacePaneLayout.explorerWidth,
    workspacePaneLayout.totalWidth,
    workspacePanelsWidth,
  ]);

  useEffect(() => {
    if (!workspacePaneDragState) {
      return;
    }

    if (!isDesktopWorkspacePanels || !isWorkspaceExplorerOpen) {
      setWorkspacePaneDragState(null);
      return;
    }

    if (workspacePaneDragState.kind === "explorer-file" && !hasWorkspaceFilePreview) {
      setWorkspacePaneDragState(null);
    }
  }, [hasWorkspaceFilePreview, isDesktopWorkspacePanels, isWorkspaceExplorerOpen, workspacePaneDragState]);

  useEffect(() => {
    if (!workspacePaneDragState) {
      return;
    }

    const dragState = workspacePaneDragState;

    function handlePointerMove(event: PointerEvent) {
      if (dragState.kind === "canvas-explorer") {
        const nextPanelsWidth = dragState.startPanelsWidth + (dragState.startClientX - event.clientX);
        const nextLayout = resolveWorkspacePaneLayout({
          isDesktop: true,
          hostWidth: Math.max(0, window.innerWidth - (isSidebarCollapsed ? collapsedSidebarWidth : expandedSidebarWidth)),
          totalWidth: nextPanelsWidth,
          explorerWidth: workspaceExplorerWidth,
          hasFilePreview: dragState.hasFilePreview,
        });
        setWorkspacePanelsWidth(nextLayout.totalWidth);
        if (!dragState.hasFilePreview) {
          setWorkspaceExplorerWidth(nextLayout.explorerWidth);
        }
        return;
      }

      const nextExplorerWidth = dragState.startExplorerWidth + (event.clientX - dragState.startClientX);
      const nextLayout = resolveWorkspacePaneLayout({
        isDesktop: true,
        hostWidth: Math.max(0, window.innerWidth - (isSidebarCollapsed ? collapsedSidebarWidth : expandedSidebarWidth)),
        totalWidth: dragState.totalPanelsWidth,
        explorerWidth: nextExplorerWidth,
        hasFilePreview: true,
      });
      setWorkspaceExplorerWidth(nextLayout.explorerWidth);
    }

    function handlePointerUp() {
      setWorkspacePaneDragState(null);
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [isSidebarCollapsed, workspaceExplorerWidth, workspacePaneDragState]);

  useEffect(() => {
    if (!activeNetId || canvasSize.width <= 0 || canvasSize.height <= 0) {
      return;
    }

    if (lastViewportResetNetIdRef.current === activeNetId) {
      return;
    }

    const nextViewport = buildInitialRootTurnViewport({
      canvasSize,
      prompt: "",
    });
    if (!nextViewport) {
      return;
    }

    lastViewportResetNetIdRef.current = activeNetId;
    applyViewport(nextViewport);
  }, [activeNetId, applyViewport, canvasSize.height, canvasSize.width]);

  useEffect(() => {
    if (graphQuery.isFetching || !snapshot || snapshot.messages.length === 0 || !nodesInitialized) {
      return;
    }

    const autoFitTargetId = activeNetId ?? "__active-net__";
    if (lastAutoFitNetIdRef.current === autoFitTargetId) {
      return;
    }

    const initialRootTurnMessage = getRootBranchFirstConversationMessage(snapshot);
    if (initialRootTurnMessage) {
      if (canvasSize.width <= 0 || canvasSize.height <= 0) {
        return;
      }

      setInitialRootTurnViewport(initialRootTurnMessage.content);
      lastAutoFitNetIdRef.current = autoFitTargetId;
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
          maxZoom: autoFitMaxZoom,
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
    canvasSize.height,
    canvasSize.width,
    graphQuery.isFetching,
    nodesInitialized,
    reactFlow,
    setInitialRootTurnViewport,
    snapshot?.branches.length,
    snapshot?.edges.length,
    snapshot?.messages.length,
  ]);

  useEffect(() => {
    if (!snapshot) {
      if (selectedMessageId !== null) {
        setSelectedMessageId(null);
      }
      setSelectionDraft(null);
      return;
    }

    if (
      selectedMessageId &&
      snapshot.messages.some((message) => message.id === selectedMessageId && isConversationSourceRole(message.role))
    ) {
      return;
    }

    if (selectedMessageId !== null) {
      setSelectedMessageId(null);
    }
    setSelectionDraft(null);
  }, [selectedMessageId, setSelectedMessageId, snapshot]);

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
    if (!focusViewTargetMessageId) {
      return;
    }

    if (!snapshot || !snapshot.messages.some((message) => message.id === focusViewTargetMessageId)) {
      exitFocusView();
    }
  }, [exitFocusView, focusViewTargetMessageId, snapshot]);

  useEffect(() => {
    if (isArticleModeNet) {
      return;
    }

    setFocusReturnState(null);
    setPendingFocusAnchorScroll(null);
  }, [isArticleModeNet]);

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
        if (isFocusViewActive) {
          exitFocusView();
          return;
        }

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
  }, [exitFocusView, isFocusViewActive, setSelectedMessageId]);

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
    if (pendingWorkspaceDeletion && !knownWorkspaces.some((workspaceSummary) => workspaceSummary.workspaceId === pendingWorkspaceDeletion.id)) {
      setPendingWorkspaceDeletion(null);
    }
  }, [knownWorkspaces, pendingWorkspaceDeletion]);

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
    if (!isAgentDropdownOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target;
      if (target instanceof HTMLElement && agentDropdownRef.current?.contains(target)) {
        return;
      }

      setIsAgentDropdownOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsAgentDropdownOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isAgentDropdownOpen]);

  useEffect(() => {
    if (!selectedMessage) {
      setComposerAnchor(null);
      return;
    }

    const frame = window.requestAnimationFrame(syncBubbleComposerAnchor);
    window.addEventListener("resize", syncBubbleComposerAnchor);
    const focusScrollElement = isFocusViewActive ? focusViewScrollRef.current : null;
    focusScrollElement?.addEventListener("scroll", syncBubbleComposerAnchor, { passive: true });

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", syncBubbleComposerAnchor);
      focusScrollElement?.removeEventListener("scroll", syncBubbleComposerAnchor);
    };
  }, [isFocusViewActive, selectedMessage, syncBubbleComposerAnchor]);

  useEffect(() => {
    if (isFocusViewActive || !pendingViewportAction || !snapshot) {
      return;
    }

    const targetAction = pendingViewportAction;
    const targetNode = graph.nodes.find((candidate) => candidate.id === targetAction.messageId) as Node<MessageNodeData> | undefined;
    if (!targetNode) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const nextViewport =
        targetAction.kind === "branch-entry"
          ? buildBranchEntryViewport({
              canvasSize,
              targetNode,
            })
          : buildMessageHorizontalCenterViewport({
              canvasSize,
              targetNode,
              viewport,
            });
      if (!nextViewport) {
        return;
      }

      applyViewport(nextViewport);

      setPendingViewportAction((current) =>
        current?.messageId === targetAction.messageId ? null : current,
      );
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [
    canvasSize.height,
    canvasSize.width,
    graph.nodes,
    isFocusViewActive,
    pendingViewportAction,
    applyViewport,
    snapshot,
    viewport,
  ]);

  useEffect(() => {
    if (!isFocusViewActive || !focusViewTargetMessageId) {
      return;
    }

    if (skipNextFocusTargetAutoScrollRef.current) {
      skipNextFocusTargetAutoScrollRef.current = false;
      return;
    }

    let frameId = 0;
    let attempts = 0;

    const scrollTargetIntoView = () => {
      const container = focusViewScrollRef.current;
      const targetElement = container?.querySelector<HTMLElement>(`[data-focus-message-id="${focusViewTargetMessageId}"]`) ?? null;
      if (!container || !targetElement) {
        if (attempts < 8) {
          attempts += 1;
          frameId = window.requestAnimationFrame(scrollTargetIntoView);
        }
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const targetRect = targetElement.getBoundingClientRect();
      const nextScrollTop = container.scrollTop + (targetRect.top - containerRect.top) - focusViewScrollTopInset;
      container.scrollTo({
        top: Math.max(0, Math.round(nextScrollTop)),
        behavior: "smooth",
      });
    };

    frameId = window.requestAnimationFrame(scrollTargetIntoView);

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [focusPathSignature, focusViewTargetMessageId, isFocusViewActive]);

  useEffect(() => {
    if (!isFocusViewActive || !pendingFocusAnchorScroll) {
      return;
    }

    let frameId = 0;
    let attempts = 0;
    const targetAnchor = pendingFocusAnchorScroll;

    const scrollAnchorIntoView = () => {
      const container = focusViewScrollRef.current;
      const anchorElement =
        container?.querySelector<HTMLElement>(
          `[data-focus-message-id="${targetAnchor.sourceMessageId}"] [data-selection-anchor-id="${targetAnchor.branchId}"]`,
        ) ?? null;
      if (!container || !anchorElement) {
        if (attempts < 12) {
          attempts += 1;
          frameId = window.requestAnimationFrame(scrollAnchorIntoView);
        }
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const anchorRect = anchorElement.getBoundingClientRect();
      const anchorCenter = anchorRect.top - containerRect.top + anchorRect.height / 2;
      const desiredTop = container.clientHeight / 3;
      const nextScrollTop = container.scrollTop + anchorCenter - desiredTop;

      container.scrollTo({
        top: Math.max(0, Math.round(nextScrollTop)),
        behavior: "smooth",
      });
      setPendingFocusAnchorScroll((current) =>
        current?.sourceMessageId === targetAnchor.sourceMessageId && current.branchId === targetAnchor.branchId
          ? null
          : current,
      );
      setFocusReturnState(null);
    };

    frameId = window.requestAnimationFrame(scrollAnchorIntoView);

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [focusPathSignature, isFocusViewActive, pendingFocusAnchorScroll]);

  const isSwitchingNet =
    createNetMutation.isPending ||
    selectNetMutation.isPending ||
    selectWorkspaceMutation.isPending ||
    selectWorkspaceNetMutation.isPending ||
    openWorkspaceFolderMutation.isPending ||
    deleteWorkspaceMutation.isPending ||
    renameNetMutation.isPending ||
    deleteNetMutation.isPending;
  const isUpdatingActiveNetAgent =
    updateNetAgentMutation.isPending && updateNetAgentMutation.variables?.netId === activeNetId;
  const hasMessages = Boolean(snapshot && snapshot.messages.length > 0);
  const isOnNewNetScreen = !graphQuery.isLoading && !hasMessages;
  const showBubbleComposer = Boolean(selectedMessage && composerAnchor);
  const sendDisabled =
    composerValue.trim().length === 0 || isThinking || isSwitchingNet || isUpdatingActiveNetAgent || !canSendOnActiveLane;

  useEffect(() => {
    if (!isOnNewNetScreen && isAgentDropdownOpen) {
      setIsAgentDropdownOpen(false);
    }
  }, [isAgentDropdownOpen, isOnNewNetScreen]);

  useEffect(() => {
    if (!isOnNewNetScreen) {
      return;
    }

    const nextViewport = buildInitialRootTurnViewport({
      canvasSize,
      prompt: "",
    });
    if (!nextViewport) {
      return;
    }

    applyViewport(nextViewport);
  }, [applyViewport, canvasSize, isOnNewNetScreen]);

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
    if (isFocusViewActive) {
      setFocusViewTargetMessageId(optimisticTurn.assistantMessageId);
    }
  }

  function handleCreateNet() {
    setOpenNetMenuId(null);
    if (isOnNewNetScreen) {
      return;
    }

    createNetMutation.mutate({
      title: "",
      ...(defaultNewNetAgent
        ? {
            agentRuntimeId: defaultNewNetAgent.runtimeId,
            agentRuntimeKind: defaultNewNetAgent.runtimeKind,
          }
        : {}),
    });
  }

  function submitCurrentPrompt() {
    const prompt = composerValue.trim();
    if (prompt.length === 0) {
      return;
    }

    if (isOnNewNetScreen && sendMode === "root") {
      setInitialRootTurnViewport(prompt);
    }

    setComposerValue("");
    setSelectionDraft(null);
    setStreamErrorMessage(null);
    clearBrowserSelection();

    if (sendMode === "root" || sendMode === "continue-root") {
      const optimisticTurn = snapshot
        ? buildOptimisticRootStreamTurn(snapshot, {
            machineId: null,
            runtimeId: sendTargetRuntimeId,
            runtimeKind: sendTargetRuntimeKind,
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
            machineId: null,
            runtimeId: sendTargetRuntimeId,
            runtimeKind: sendTargetRuntimeKind,
            selectedText: selectionForSelectedMessage?.selectedText ?? null,
            snapshot,
          }),
      );
      return;
    }

    if (sendMode === "continue-branch" && selectedBranch) {
      const optimisticTurn = snapshot
        ? buildOptimisticBranchTurnStreamTurn(snapshot, {
            branchId: selectedBranch.id,
            machineId: selectedBranch.machineId,
            runtimeId: selectedBranch.runtimeId,
            runtimeKind: selectedBranch.runtimeKind,
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
            machineId: selectedBranch.machineId ?? null,
            runtimeId: selectedBranch.runtimeId ?? activeNet?.agentRuntimeId ?? null,
            runtimeKind: selectedBranch.runtimeKind ?? activeNet?.agentRuntimeKind ?? null,
            selectedText: selectionForSelectedMessage?.selectedText ?? null,
            snapshot,
          }),
      );
      return;
    }

    if (sendMode === "branch-from-selection" && selectedMessage && selectionForSelectedMessage) {
      const optimisticTurn = snapshot
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
            machineId: selectedMessage.machineId ?? null,
            runtimeId: selectedMessage.runtimeId ?? activeNet?.agentRuntimeId ?? null,
            runtimeKind: selectedMessage.runtimeKind ?? activeNet?.agentRuntimeKind ?? null,
            selectedText: selectionForSelectedMessage.selectedText,
            snapshot,
          }),
      );
      return;
    }

    if (sendMode === "branch-from-message" && selectedMessage) {
      const optimisticTurn = snapshot
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
            machineId: selectedMessage.machineId ?? null,
            runtimeId: selectedMessage.runtimeId ?? activeNet?.agentRuntimeId ?? null,
            runtimeKind: selectedMessage.runtimeKind ?? activeNet?.agentRuntimeKind ?? null,
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

  const activeStreamedAssistantMessageId = activeStreamedTurn?.assistantMessageId ?? null;
  const activeStreamedAssistantErrorMessage = useLiveAssistantStateStore(
    useCallback(
      (state) =>
        activeStreamedAssistantMessageId
          ? state.statesByMessageId[activeStreamedAssistantMessageId]?.errorMessage ?? null
          : null,
      [activeStreamedAssistantMessageId],
    ),
  );
  const workingDirectoryValue = workspace?.workingDirectory ?? null;
  const workingDirectoryPath = formatWorkingDirectoryPath(workingDirectoryValue);
  const workspaceDisplayName = resolveWorkspaceName(workingDirectoryPath);
  const selectedWorkspaceFile = workspaceFileQuery.data ?? null;
  const composerPlaceholder =
    !selectedMessage && !activeNet?.agentRuntimeId
      ? "Pick an agent below, then start the first turn..."
      : selectedMessage
        ? selectedMessage.role === "article"
          ? selectionForSelectedMessage
            ? "Ask about the selected passage in this article..."
            : sendMode === "branch-from-message"
              ? "Start a branch from this article..."
              : "Ask about this article..."
          : selectionForSelectedMessage
            ? "Ask about the selected text in this context..."
            : sendMode === "branch-from-message"
              ? "Start a branch from this reply..."
              : "Continue from this reply..."
        : "Start the first turn...";
  const composerErrorMessage =
    activeStreamedTurn && !activeStreamedTurn.isPending
      ? activeStreamedAssistantErrorMessage ?? streamErrorMessage
      : streamErrorMessage;
  const netErrorMessage = formatErrorMessage(
    openWorkspaceFolderMutation.error ??
      deleteWorkspaceMutation.error ??
      selectWorkspaceMutation.error ??
      selectWorkspaceNetMutation.error ??
      createNetMutation.error ??
      selectNetMutation.error ??
      renameNetMutation.error ??
      updateNetAgentMutation.error ??
      deleteNetMutation.error,
  );
  const pendingDeletionNetId = pendingNetDeletion?.id ?? null;
  const pendingDeletionWorkspaceId = pendingWorkspaceDeletion?.id ?? null;
  const isConfirmingWorkspaceDeletion =
    deleteWorkspaceMutation.isPending && deleteWorkspaceMutation.variables === pendingDeletionWorkspaceId;
  const isConfirmingNetDeletion = deleteNetMutation.isPending && deleteNetMutation.variables === pendingDeletionNetId;
  const activeNetAgentValue = activeNet?.agentRuntimeId ?? "";
  const displayedAgentSelectValue =
    activeNetAgentValue || defaultNewNetAgent?.runtimeId || agentOptions[0]?.runtimeId || "";
  const selectedAgentOption =
    agentOptions.find((agent) => agent.runtimeId === displayedAgentSelectValue) ?? defaultNewNetAgent ?? null;
  const selectedAgentDisplay: AgentDisplayInfo = {
    label: selectedAgentOption?.runtimeLabel ?? activeAgentLabel,
    runtimeKind: selectedAgentOption?.runtimeKind ?? activeNet?.agentRuntimeKind ?? null,
  };
  const bubbleComposerAgentDisplay: AgentDisplayInfo = {
    label:
      sendTargetAgent?.runtimeLabel ??
      (sendTargetRuntimeKind ? resolveAgentRuntimeLabel(sendTargetRuntimeKind) : null) ??
      activeAgentLabel,
    runtimeKind: sendTargetAgent?.runtimeKind ?? sendTargetRuntimeKind ?? activeNet?.agentRuntimeKind ?? null,
  };
  const newNetModeToggleButton = (
    <button
      type="button"
      className={cn(
        "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-none border border-[var(--node-border)] bg-[rgba(244,241,234,0.6)] text-[var(--text-main)] transition-colors hover:border-[var(--text-main)] disabled:cursor-not-allowed disabled:text-[rgba(26,26,26,0.36)]",
        newRootComposerMode === "article" ? "border-[var(--text-main)] bg-[rgba(244,241,234,0.84)]" : "",
      )}
      disabled={workspaceQuery.isLoading || !activeWorkspaceId || createRootArticleMutation.isPending}
      title={newRootComposerMode === "article" ? "Switch back to conversation mode" : "Switch to article mode"}
      onClick={() => {
        setIsAgentDropdownOpen(false);
        setNewRootComposerMode((current) => (current === "article" ? "conversation" : "article"));
      }}
    >
      {newRootComposerMode === "article" ? <MessageSquare className="size-4" /> : <Newspaper className="size-4" />}
    </button>
  );
  const newNetComposerBottomBar = (
    <div className="absolute bottom-4 left-6 right-4 flex items-center justify-between gap-4">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
        <div
          className="pointer-events-none max-w-[300px] shrink-0 truncate text-[13px] leading-5 text-[rgba(26,26,26,0.46)]"
          title={workingDirectoryPath}
        >
          {truncateMiddle(workingDirectoryPath, 64)}
        </div>
        <div ref={agentDropdownRef} className="relative shrink-0">
          <button
            aria-expanded={isAgentDropdownOpen}
            aria-haspopup="listbox"
            className="flex h-9 min-w-[188px] items-center gap-3 rounded-none border border-[var(--node-border)] bg-[rgba(244,241,234,0.6)] px-3 text-left text-[13px] font-medium text-[var(--text-main)] shadow-none outline-none transition-colors hover:border-[var(--text-main)] focus-visible:border-[var(--text-main)] disabled:cursor-not-allowed disabled:text-[rgba(26,26,26,0.36)]"
            disabled={workspaceQuery.isLoading || isSwitchingNet || isUpdatingActiveNetAgent || agentOptions.length === 0}
            type="button"
            onClick={() => setIsAgentDropdownOpen((current) => !current)}
          >
            <AgentRuntimeBadge
              className="min-w-0 flex-1"
              iconWrapperClassName="size-5"
              label={selectedAgentDisplay.label}
              labelClassName="truncate"
              runtimeKind={selectedAgentDisplay.runtimeKind}
            />
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-[rgba(26,26,26,0.54)] transition-transform",
                isAgentDropdownOpen ? "rotate-180" : "",
              )}
            />
          </button>

          {isAgentDropdownOpen ? (
            <div className="absolute left-0 top-full z-20 mt-2 w-[244px] border border-[var(--text-main)] bg-white p-1.5 shadow-[10px_10px_0_rgba(26,26,26,0.08)]">
              <div aria-label="Agent options" className="max-h-[240px] overflow-y-auto" role="listbox">
                {agentOptions.map((agent) => {
                  const availabilityLabel = buildAgentAvailabilityLabel(agent);
                  const isSelected = agent.runtimeId === displayedAgentSelectValue;

                  return (
                    <button
                      key={agent.runtimeId}
                      aria-selected={isSelected}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-none px-3 py-2.5 text-left transition-colors",
                        isSelected ? "bg-[var(--bg-cream)]" : "bg-white hover:bg-[rgba(244,241,234,0.72)]",
                        !agent.installed ? "cursor-not-allowed opacity-45" : "",
                      )}
                      disabled={!agent.installed}
                      role="option"
                      type="button"
                      onClick={() => {
                        setIsAgentDropdownOpen(false);
                        updateActiveNetAgent(agent.runtimeId);
                      }}
                    >
                      <AgentRuntimeBadge
                        className="min-w-0 flex-1"
                        iconWrapperClassName="size-6"
                        label={agent.runtimeLabel}
                        labelClassName="truncate text-[13px] font-medium text-[var(--text-main)]"
                        runtimeKind={agent.runtimeKind}
                      />
                      {availabilityLabel ? (
                        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] text-[rgba(26,26,26,0.42)]">
                          {availabilityLabel}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
        {newNetModeToggleButton}
      </div>

      {newRootComposerMode === "conversation" ? (
        <Button
          className="h-11 w-11 shrink-0 rounded-none border border-[var(--text-main)] bg-[var(--text-main)] px-0 text-white shadow-none hover:bg-[var(--block-slate)]"
          disabled={sendDisabled}
          type="submit"
        >
          <ArrowUp className="size-4" />
        </Button>
      ) : null}
    </div>
  );

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--bg-cream)] text-[var(--text-main)] lg:flex-row">
      <aside
        className={cn(
          "relative z-20 flex w-full shrink-0 flex-col overflow-hidden border-b border-[var(--text-main)] bg-[linear-gradient(180deg,rgba(255,255,255,0.9)_0%,rgba(244,241,234,0.96)_100%)] lg:max-h-none",
          isSidebarTransitionReady ? "transition-[max-height,width] duration-300 ease-out" : "",
          isSidebarCollapsed
            ? "max-h-[80px] border-b-0 bg-transparent lg:h-screen lg:w-[80px] lg:self-start lg:border-b-0 lg:border-r"
            : "max-h-[48vh] lg:h-screen lg:w-[288px] lg:border-b-0 lg:border-r",
        )}
      >
        <div
          className={cn(
            isSidebarCollapsed ? "border-0 bg-transparent px-3 py-3" : "border-b border-[var(--text-main)] px-4 py-4",
          )}
        >
          <div className={cn("flex shrink-0 gap-2", isSidebarCollapsed ? "items-center lg:flex-col" : "items-center justify-start")}>
            <button
              type="button"
              className="inline-flex h-9 w-9 items-center justify-center border border-[var(--text-main)] bg-white text-[var(--text-main)] shadow-[6px_6px_0_rgba(26,26,26,0.06)] transition-colors hover:bg-[var(--bg-cream)]"
              title={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={() => setIsSidebarCollapsed((current) => !current)}
            >
              {isSidebarCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
            </button>
            <button
              type="button"
              className="inline-flex h-9 w-9 items-center justify-center border border-[var(--text-main)] bg-white text-[var(--text-main)] shadow-[6px_6px_0_rgba(26,26,26,0.06)] transition-colors hover:bg-[var(--bg-cream)] disabled:cursor-not-allowed disabled:text-[rgba(26,26,26,0.34)]"
              disabled={isSwitchingNet || !canPickWorkspaceFolder}
              title="Add workspace"
              onClick={() => openWorkspaceFolderMutation.mutate()}
            >
              {openWorkspaceFolderMutation.isPending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <FolderPlus className="size-4" />
              )}
            </button>
            <button
              type="button"
              className="inline-flex h-9 w-9 items-center justify-center border border-[var(--text-main)] bg-[var(--text-main)] text-white shadow-[6px_6px_0_rgba(26,26,26,0.06)] transition-colors hover:bg-[var(--block-slate)] disabled:cursor-not-allowed disabled:bg-[rgba(26,26,26,0.42)]"
              disabled={isSwitchingNet || workspaceQuery.isLoading}
              title="Create new net"
              onClick={handleCreateNet}
            >
              {createNetMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Pencil className="size-4" />}
            </button>
          </div>

        </div>

        <div
          aria-hidden={isSidebarCollapsed}
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-hidden transition-[max-height,opacity,transform] duration-300 ease-out",
            isSidebarCollapsed
              ? "pointer-events-none max-h-0 opacity-0 -translate-y-2 lg:-translate-x-2 lg:translate-y-0"
              : "max-h-[calc(48vh-80px)] opacity-100 translate-y-0 lg:max-h-none lg:translate-x-0",
          )}
        >
          {netErrorMessage ? (
            <div className="mt-4 px-4">
              <div className="border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700">
                {netErrorMessage}
              </div>
            </div>
          ) : null}

          <div className="flex-1 overflow-y-auto px-3 py-3">
            {workspacesQuery.isLoading ? (
              <div className="border border-[var(--node-border)] bg-white px-4 py-5 text-[15px] leading-7 text-[rgba(26,26,26,0.58)]">
                Loading local workspaces...
              </div>
            ) : orderedWorkspaces.length ? (
              orderedWorkspaces.map((workspaceSummary) => {
                const formattedWorkspacePath = formatWorkingDirectoryPath(workspaceSummary.workingDirectory);
                const workspaceDisplayName = resolveWorkspaceName(formattedWorkspacePath);
                const isActiveWorkspace = workspaceSummary.workspaceId === activeWorkspaceId;
                const isWorkspaceExpanded = expandedWorkspaceIds.includes(workspaceSummary.workspaceId);
                const hasOpenNetMenu = isActiveWorkspace && workspaceSummary.nets.some((net) => openNetMenuId === net.id);
                const isDeletingWorkspace =
                  deleteWorkspaceMutation.isPending && deleteWorkspaceMutation.variables === workspaceSummary.workspaceId;
                const canDeleteWorkspace = orderedWorkspaces.length > 1 && !isDeletingWorkspace;

                return (
                  <section
                    key={workspaceSummary.workspaceId}
                    draggable={!isSwitchingNet}
                    className={cn(
                      "relative border bg-[rgba(255,255,255,0.86)] transition-[border-color,box-shadow,background-color] duration-200",
                      isActiveWorkspace
                        ? "border-[var(--text-main)] bg-white shadow-[8px_8px_0_rgba(26,26,26,0.06)]"
                        : "border-[var(--node-border)] hover:border-[rgba(26,26,26,0.34)]",
                      draggedWorkspaceId === workspaceSummary.workspaceId ? "opacity-55" : "",
                      hasOpenNetMenu ? "z-30 overflow-visible" : "overflow-hidden",
                    )}
                    onDragStart={(event) => {
                      if (isSwitchingNet) {
                        event.preventDefault();
                        return;
                      }

                      setDraggedWorkspaceId(workspaceSummary.workspaceId);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", workspaceSummary.workspaceId);
                    }}
                    onDragOver={(event) => {
                      if (!draggedWorkspaceId || draggedWorkspaceId === workspaceSummary.workspaceId) {
                        return;
                      }

                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const sourceWorkspaceId = draggedWorkspaceId ?? event.dataTransfer.getData("text/plain");
                      if (!sourceWorkspaceId || sourceWorkspaceId === workspaceSummary.workspaceId) {
                        setDraggedWorkspaceId(null);
                        return;
                      }

                      moveWorkspaceBefore(sourceWorkspaceId, workspaceSummary.workspaceId);
                      setDraggedWorkspaceId(null);
                    }}
                    onDragEnd={() => setDraggedWorkspaceId(null)}
                  >
                    <div
                      role="button"
                      tabIndex={isSwitchingNet ? -1 : 0}
                      className={cn(
                        "flex items-center gap-2 px-3 py-2.5 transition-colors",
                        isActiveWorkspace ? "bg-white" : "hover:bg-[rgba(244,241,234,0.32)]",
                        isSwitchingNet ? "cursor-default" : "cursor-pointer",
                      )}
                      aria-expanded={isWorkspaceExpanded}
                      aria-label={`${isWorkspaceExpanded ? "Collapse" : "Expand"} ${workspaceDisplayName}`}
                      onClick={() => {
                        if (isSwitchingNet) {
                          return;
                        }

                        handleWorkspaceItemClick(workspaceSummary.workspaceId);
                      }}
                      onKeyDown={(event) => {
                        if (isSwitchingNet) {
                          return;
                        }

                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          handleWorkspaceItemClick(workspaceSummary.workspaceId);
                        }
                      }}
                    >
                      <div className="min-w-0 flex-1 truncate text-[14px] font-medium leading-6 text-[var(--text-main)]">
                        {workspaceDisplayName}
                      </div>
                      <button
                        type="button"
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-[rgba(26,26,26,0.46)] transition-colors hover:text-rose-600 disabled:cursor-not-allowed disabled:text-[rgba(26,26,26,0.22)]"
                        disabled={!canDeleteWorkspace || isSwitchingNet}
                        title={orderedWorkspaces.length > 1 ? `Delete ${workspaceDisplayName}` : "The last workspace cannot be deleted"}
                        onClick={(event) => {
                          event.stopPropagation();
                          requestWorkspaceDeletion(workspaceSummary.workspaceId, workspaceDisplayName);
                        }}
                      >
                        {isDeletingWorkspace ? <LoaderCircle className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                      </button>
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center text-[rgba(26,26,26,0.54)]">
                        <ChevronRight className={cn("size-4 transition-transform", isWorkspaceExpanded ? "rotate-90" : "")} />
                      </div>
                    </div>

                    {isWorkspaceExpanded ? (
                      <div className="border-t border-[var(--node-border)] bg-[rgba(244,241,234,0.52)] px-2.5 py-2.5">
                        <div className="space-y-1">
                          {workspaceSummary.nets.map((net) => {
                            const isActiveNet = isActiveWorkspace && net.id === activeNetId;
                            const isEditingNet = isActiveWorkspace && editingNetId === net.id;
                            const isMenuOpen = isActiveWorkspace && openNetMenuId === net.id;
                            const isRenamingNet = renameNetMutation.isPending && renameNetMutation.variables?.netId === net.id;
                            const isDeletingNet = deleteNetMutation.isPending && deleteNetMutation.variables === net.id;
                            const latestMessageLabel = formatNetAgeLabel(net.latestMessageAt ?? net.createdAt);
                            const netTitle = net.title || "Untitled net";

                            return (
                              <div key={`${workspaceSummary.workspaceId}:${net.id}`} className="flex items-start gap-1.5">
                                <div className="min-w-0 flex-1">
                                  {isEditingNet ? (
                                    <div className="space-y-3 border border-[var(--node-border)] bg-white px-3 py-3">
                                      <Input
                                        autoFocus
                                        className="h-10 rounded-none border-[var(--text-main)] px-3 text-[15px] font-medium shadow-none focus:border-[var(--text-main)]"
                                        disabled={isRenamingNet}
                                        maxLength={120}
                                        value={editingNetTitle}
                                        onChange={(event) => setEditingNetTitle(event.target.value)}
                                        onKeyDown={(event) => {
                                          if (event.key === "Enter") {
                                            event.preventDefault();
                                            submitNetRename(net.id, netTitle);
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
                                          onClick={() => submitNetRename(net.id, netTitle)}
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
                                    <div
                                      role="button"
                                      tabIndex={isSwitchingNet || isActiveNet ? -1 : 0}
                                      className={cn(
                                        "flex w-full items-center gap-2 border px-3 py-2.5 text-left transition-colors",
                                        isActiveNet
                                          ? "border-[var(--text-main)] bg-[var(--block-slate)] text-white"
                                          : "border-[var(--node-border)] bg-white hover:bg-[var(--bg-cream)]",
                                        isSwitchingNet || isActiveNet ? "cursor-default" : "cursor-pointer",
                                      )}
                                      onClick={() => {
                                        if (isSwitchingNet || isActiveNet) {
                                          return;
                                        }

                                        if (isActiveWorkspace) {
                                          selectNetMutation.mutate(net.id);
                                          return;
                                        }

                                        selectWorkspaceNetMutation.mutate({
                                          workspaceId: workspaceSummary.workspaceId,
                                          netId: net.id,
                                        });
                                      }}
                                      onKeyDown={(event) => {
                                        if (isSwitchingNet || isActiveNet) {
                                          return;
                                        }

                                        if (event.key === "Enter" || event.key === " ") {
                                          event.preventDefault();
                                          if (isActiveWorkspace) {
                                            selectNetMutation.mutate(net.id);
                                            return;
                                          }

                                          selectWorkspaceNetMutation.mutate({
                                            workspaceId: workspaceSummary.workspaceId,
                                            netId: net.id,
                                          });
                                        }
                                      }}
                                    >
                                      <div className="min-w-0 flex-1">
                                        <div
                                          className={cn(
                                            "truncate text-[14px] font-medium leading-5",
                                            isActiveNet ? "text-white" : "text-[var(--text-main)]",
                                          )}
                                        >
                                          {netTitle}
                                        </div>
                                      </div>
                                      <div className="flex shrink-0 items-center gap-1.5">
                                        <div
                                          className={cn(
                                            "text-[11px] leading-4",
                                            isActiveNet ? "text-white/68" : "text-[rgba(26,26,26,0.54)]",
                                          )}
                                        >
                                          {latestMessageLabel}
                                        </div>
                                        {isActiveWorkspace ? (
                                          <div
                                            ref={isMenuOpen ? openNetMenuRef : null}
                                            className="relative shrink-0"
                                            data-net-actions-root
                                          >
                                            <button
                                              type="button"
                                              className={cn(
                                                "inline-flex h-7 w-7 items-center justify-center rounded-sm transition-colors disabled:cursor-not-allowed",
                                                isActiveNet
                                                  ? "text-white hover:bg-white/12 disabled:text-white/36"
                                                  : "text-[rgba(26,26,26,0.66)] hover:bg-[rgba(26,26,26,0.05)] disabled:text-[rgba(26,26,26,0.32)]",
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
                                              <div className="absolute right-0 top-full z-30 mt-1.5 w-max min-w-0 border border-[var(--text-main)] bg-white shadow-[6px_6px_0_rgba(26,26,26,0.08)]">
                                                <button
                                                  type="button"
                                                  className="block w-full whitespace-nowrap border-b border-[var(--node-border)] px-3 py-2 text-left text-[14px] font-medium text-[var(--text-main)] transition-colors hover:bg-[var(--bg-cream)] disabled:cursor-not-allowed disabled:text-[rgba(26,26,26,0.32)]"
                                                  disabled={isSwitchingNet || isDeletingNet}
                                                  onClick={() => beginNetRename(net.id, netTitle)}
                                                >
                                                  Rename
                                                </button>
                                                <button
                                                  type="button"
                                                  className="block w-full whitespace-nowrap px-3 py-2 text-left text-[14px] font-medium text-rose-700 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:text-rose-300"
                                                  disabled={isSwitchingNet || isDeletingNet}
                                                  onClick={() => requestNetDeletion(net.id, netTitle)}
                                                >
                                                  {isDeletingNet ? "Deleting..." : "Delete"}
                                                </button>
                                              </div>
                                            ) : null}
                                          </div>
                                        ) : null}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </section>
                );
              })
            ) : (
              <div className="border border-[var(--node-border)] bg-white px-4 py-5 text-[15px] leading-7 text-[rgba(26,26,26,0.58)]">
                No local workspaces have been discovered yet.
              </div>
            )}
          </div>
        </div>
      </aside>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={workspacePanelsHostRef} className="flex h-full min-w-0">
          <div ref={canvasHostRef} className="relative min-h-0 flex-1 overflow-hidden">
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-[linear-gradient(180deg,rgba(244,241,234,0.92)_0%,rgba(244,241,234,0)_100%)]" />
            {!isFocusViewActive ? (
              <div className="absolute right-4 top-4 z-20 flex flex-col items-end gap-3">
                <button
                  type="button"
                  className={cn(
                    "inline-flex h-10 w-10 items-center justify-center border border-[var(--text-main)] shadow-[8px_8px_0_rgba(26,26,26,0.06)] transition-colors",
                    isWorkspaceExplorerOpen
                      ? "bg-[var(--text-main)] text-white hover:bg-[var(--block-slate)]"
                      : "bg-white text-[var(--text-main)] hover:bg-[var(--bg-cream)]",
                  )}
                  disabled={workspaceQuery.isLoading || !workspace?.workingDirectory}
                  title={isWorkspaceExplorerOpen ? "Hide workspace explorer" : "Show workspace explorer"}
                  onClick={() => setIsWorkspaceExplorerOpen((current) => !current)}
                >
                  <FolderOpen className="size-4" />
                </button>

                {isArticleModeNet && focusReturnState ? (
                  <button
                    type="button"
                    className="inline-flex h-10 items-center gap-2 border border-[var(--text-main)] bg-white px-3 text-[13px] font-medium text-[var(--text-main)] shadow-[8px_8px_0_rgba(26,26,26,0.06)] transition-colors hover:bg-[var(--bg-cream)]"
                    title="Return to article focus view"
                    onClick={returnToArticleFocusView}
                  >
                    <ArrowLeft className="size-4" />
                    <span>Return</span>
                  </button>
                ) : null}
              </div>
            ) : null}

            <ReactFlow
              className="netchat-flow canvas-flow h-full w-full bg-[var(--bg-cream)]"
              nodes={graph.nodes}
              edges={graph.edges}
              viewport={viewport}
              onViewportChange={handleViewportChange}
              onNodeClick={(_event, node) => {
                const selectedText = window.getSelection()?.toString().trim();
                const message = (node.data as MessageNodeData | undefined)?.message;
                if (isConversationSourceRole(message?.role) && !selectedText) {
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
              panOnDrag={!isOnNewNetScreen}
              zoomOnScroll={!isOnNewNetScreen}
              zoomOnPinch={!isOnNewNetScreen}
              zoomOnDoubleClick={false}
            >
              <Background gap={96} size={1} color="var(--line-color)" />
            </ReactFlow>

        {!isFocusViewActive && graph.nodes.length > 0 ? (
          <CanvasThumbnail
            canvasSize={canvasSize}
            measuredNodeHeights={measuredNodeHeights}
            nodes={graph.nodes as Node<MessageNodeData>[]}
            viewport={viewport}
            onViewportChange={applyViewport}
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
          <div className="absolute inset-0 z-10 flex items-center justify-center px-6 py-8">
            <form className="pointer-events-auto w-full max-w-[840px]" onSubmit={handleSubmit}>
              <div className="relative border border-[var(--text-main)] bg-white px-6 py-5 shadow-[14px_14px_0_rgba(26,26,26,0.08)]">
                {newRootComposerMode === "conversation" ? (
                  <Textarea
                    ref={composerRef}
                    className="!min-h-[172px] resize-none !rounded-none !border-0 !bg-transparent !px-0 !py-0 !pb-18 !pr-18 text-[18px] font-medium leading-9 text-[var(--text-main)] shadow-none placeholder:font-normal placeholder:text-[rgba(26,26,26,0.34)] focus-visible:ring-0"
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
                ) : (
                  <ArticleModeFilePicker
                    expandedDirectoryPaths={expandedExplorerDirectoryPaths}
                    isBusy={createRootArticleMutation.isPending}
                    selectedFilePath={selectedArticleFilePath}
                    workspaceId={activeWorkspaceId}
                    onSelectFile={handleArticleFileSelect}
                    onToggleDirectory={toggleWorkspaceExplorerDirectory}
                  />
                )}
                {newNetComposerBottomBar}
              </div>

              {composerErrorMessage ? (
                <div className="border-x border-b border-rose-200 bg-rose-50 px-7 py-4 text-sm leading-6 text-rose-700">
                  {composerErrorMessage}
                </div>
              ) : null}
            </form>
          </div>
        ) : null}

          </div>

          {isWorkspaceExplorerOpen ? (
            <div
              className="absolute inset-y-0 right-0 z-20 flex w-full justify-end bg-transparent lg:static lg:z-0 lg:w-auto lg:shrink-0"
              style={isDesktopWorkspacePanels ? { width: `${workspacePaneLayout.totalWidth}px` } : undefined}
            >
              <div className="relative flex h-full min-w-0 w-full">
                {isDesktopWorkspacePanels ? (
                  <PanelResizeHandle
                    className="absolute inset-y-0 left-0 z-30 -translate-x-1/2"
                    title="Resize workspace panes"
                    onPointerDown={startCanvasExplorerResize}
                  />
                ) : null}

                <div
                  className={cn("min-w-0 shrink-0", !isDesktopWorkspacePanels ? "w-[min(22rem,52vw)] max-w-[360px]" : "")}
                  style={
                    isDesktopWorkspacePanels
                      ? {
                          width: `${hasWorkspaceFilePreview ? workspacePaneLayout.explorerWidth : workspacePaneLayout.totalWidth}px`,
                        }
                      : undefined
                  }
                >
                  <WorkspaceExplorerPanel
                    expandedDirectoryPaths={expandedExplorerDirectoryPaths}
                    selectedFilePath={selectedWorkspaceFilePath}
                    workspaceDisplayName={workspaceDisplayName}
                    workspaceId={activeWorkspaceId}
                    onClose={() => setIsWorkspaceExplorerOpen(false)}
                    onSelectFile={handleWorkspaceFileSelect}
                    onToggleDirectory={toggleWorkspaceExplorerDirectory}
                  />
                </div>

                {selectedWorkspaceFilePath ? (
                  <>
                    {isDesktopWorkspacePanels ? (
                      <PanelResizeHandle
                        className="absolute inset-y-0 z-30 -translate-x-1/2"
                        style={{ left: `${workspacePaneLayout.explorerWidth}px` }}
                        title="Resize explorer and file preview"
                        onPointerDown={startExplorerFileResize}
                      />
                    ) : null}
                    <div
                      className="min-w-0 flex-1"
                      style={isDesktopWorkspacePanels ? { width: `${workspacePaneLayout.fileWidth}px` } : undefined}
                    >
                      <WorkspaceFilePreviewPanel
                        file={selectedWorkspaceFile}
                        filePath={selectedWorkspaceFilePath}
                        isLoading={workspaceFileQuery.isLoading || workspaceFileQuery.isFetching}
                        errorMessage={formatErrorMessage(workspaceFileQuery.error)}
                        onClose={() => setSelectedWorkspaceFilePath(null)}
                      />
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        {isFocusViewActive ? (
          <div className="fixed inset-0 z-40 bg-[var(--bg-cream)]">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[linear-gradient(180deg,rgba(244,241,234,0.96)_0%,rgba(244,241,234,0)_100%)]" />
            <div className="absolute right-4 top-4 z-10">
              <button
                type="button"
                className="inline-flex h-10 min-w-[2.5rem] items-center justify-center border border-[var(--text-main)] bg-white px-2 text-[var(--text-main)] shadow-[8px_8px_0_rgba(26,26,26,0.06)] transition-colors hover:bg-[var(--bg-cream)]"
                title="Exit focus view"
                onClick={exitFocusView}
              >
                <ZoomOut className="size-4" />
              </button>
            </div>

            <div className="pointer-events-none absolute inset-x-0 top-4 z-10 flex justify-center px-4">
              <div className="border border-[var(--text-main)] bg-white/96 px-4 py-2 text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--text-main)] shadow-[8px_8px_0_rgba(26,26,26,0.06)] backdrop-blur-sm">
                Focus view. Press Esc or use the zoom-out button to exit.
              </div>
            </div>

            <div
              ref={focusViewScrollRef}
              className="h-full overflow-y-auto px-4 pb-16 sm:px-6 lg:px-8"
              style={{ paddingTop: focusViewTopPadding }}
            >
              <div className="mx-auto flex w-full max-w-none flex-col gap-6">
                {focusPathMessages.map((message) => (
                  <div key={message.id} className="flex flex-col gap-4">
                    <FocusMessageBubble
                      assistantLabel={message.runtimeKind ? resolveAgentRuntimeLabel(message.runtimeKind) : activeAgentLabel}
                      hasSelectionDraft={selectionDraft?.sourceMessageId === message.id}
                      isActiveMessage={message.id === focusViewTargetMessageId}
                      message={message}
                      persistedAssistantState={persistedAssistantStatesByMessageId[message.id] ?? null}
                      selectionAnchors={focusSelectionAnchorsByMessageId.get(message.id) ?? []}
                      onPickMessage={pickMessage}
                      onSelectionDraft={applySelectionDraft}
                      onToggleSelectionAnchor={toggleSelectionAnchor}
                    />
                    {(focusWholeMessageContinuationsBySourceMessageId.get(message.id) ?? []).length > 1 ? (
                      <FocusBranchContinuationChooser
                        continuations={focusWholeMessageContinuationsBySourceMessageId.get(message.id) ?? []}
                        onSelect={handleFocusContinuationSelect}
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {showBubbleComposer ? (
          <div className={cn("pointer-events-none fixed inset-0", isFocusViewActive ? "z-50" : "z-30")}>
            <form
              className="pointer-events-auto fixed border border-[var(--text-main)] bg-white text-[var(--text-main)] shadow-[14px_14px_0_rgba(26,26,26,0.08)]"
              style={{
                left: composerAnchor?.left,
                top: composerAnchor?.top,
                width: composerAnchor?.width,
              }}
              onSubmit={handleSubmit}
            >
              {selectionForSelectedMessage ? (
                <div className="border-b border-[var(--node-border)] bg-[rgba(244,241,234,0.52)] px-5 py-3">
                  <div className="break-words text-[15px] italic leading-7 text-[rgba(26,26,26,0.78)]">
                    {`"${truncate(selectionForSelectedMessage.selectedText, 160)}"`}
                  </div>
                </div>
              ) : null}

              <div className="relative px-5 py-4">
                <Textarea
                  ref={composerRef}
                  className="!min-h-[112px] resize-none !rounded-none !border-0 !bg-transparent !px-0 !py-0 !pb-18 !pr-18 text-[17px] font-medium leading-9 text-[var(--text-main)] shadow-none placeholder:font-normal placeholder:text-[rgba(26,26,26,0.34)] focus-visible:ring-0"
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
                <div className="pointer-events-none absolute bottom-0 left-0 flex h-11 max-w-[calc(100%-6rem)] items-center px-5">
                  <AgentRuntimeBadge
                    className="max-w-full"
                    iconWrapperClassName="size-5"
                    label={bubbleComposerAgentDisplay.label}
                    labelClassName="truncate text-[13px] font-medium text-[var(--text-main)]"
                    monochrome
                    runtimeKind={bubbleComposerAgentDisplay.runtimeKind}
                  />
                </div>
                <Button
                  className="absolute bottom-0 right-0 h-11 w-11 rounded-none border border-[var(--text-main)] bg-[var(--text-main)] px-0 text-white shadow-none hover:bg-[var(--block-slate)]"
                  disabled={sendDisabled}
                  type="submit"
                >
                  <ArrowUp className="size-4" />
                </Button>
              </div>

              {composerErrorMessage ? (
                <div className="border-t border-rose-200 bg-rose-50 px-6 py-4 text-sm leading-6 text-rose-700">
                  {composerErrorMessage}
                </div>
              ) : null}
            </form>
          </div>
        ) : null}

        {pendingWorkspaceDeletion ? (
          <DeleteConfirmationDialog
            confirmLabel="Delete"
            confirmPendingLabel="Deleting..."
            description={`Delete "${pendingWorkspaceDeletion.title}" from netchat? This removes its local netchat data only.`}
            isConfirming={isConfirmingWorkspaceDeletion}
            title="Delete workspace?"
            onCancel={cancelWorkspaceDeletion}
            onConfirm={confirmWorkspaceDeletion}
          />
        ) : null}

        {pendingNetDeletion ? (
          <DeleteConfirmationDialog
            confirmLabel="Delete"
            confirmPendingLabel="Deleting..."
            description={`Delete "${pendingNetDeletion.title}" from history?`}
            isConfirming={isConfirmingNetDeletion}
            title="Delete net?"
            onCancel={cancelNetDeletion}
            onConfirm={confirmNetDeletion}
          />
        ) : null}
      </div>
    </div>
  );
}

function PanelResizeHandle({
  title,
  className,
  style,
  onPointerDown,
}: {
  title: string;
  className?: string;
  style?: CSSProperties;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      aria-label={title}
      className={cn("group hidden w-5 touch-none cursor-col-resize items-stretch justify-center lg:flex", className)}
      style={style}
      type="button"
      onPointerDown={onPointerDown}
    >
      <span className="pointer-events-none relative my-3 flex w-full items-center justify-center">
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[rgba(26,26,26,0.16)] transition-colors group-hover:bg-[rgba(26,26,26,0.34)]" />
        <span className="absolute left-1/2 top-1/2 h-9 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[rgba(26,26,26,0.14)] bg-white/92 shadow-[3px_3px_0_rgba(26,26,26,0.05)] transition-colors group-hover:border-[rgba(26,26,26,0.3)] group-hover:bg-[var(--bg-cream)]" />
      </span>
    </button>
  );
}

function ArticleModeFilePicker({
  workspaceId,
  expandedDirectoryPaths,
  selectedFilePath,
  isBusy,
  onToggleDirectory,
  onSelectFile,
}: {
  workspaceId: string | null;
  expandedDirectoryPaths: string[];
  selectedFilePath: string | null;
  isBusy: boolean;
  onToggleDirectory: (directoryPath: string) => void;
  onSelectFile: (filePath: string) => void;
}) {
  return (
    <div className="pb-24">
      <div className="flex items-center justify-between gap-4 border-b border-[var(--node-border)] pb-3">
        <div className="text-[18px] font-medium leading-7 text-[var(--text-main)]">Select a file to start with</div>
        {isBusy ? (
          <div className="flex shrink-0 items-center gap-2 text-[12px] leading-5 text-[rgba(26,26,26,0.54)]">
            <LoaderCircle className="size-3.5 animate-spin" />
            Loading article...
          </div>
        ) : null}
      </div>

      <div className="mt-4 max-h-[320px] overflow-y-auto border border-[var(--node-border)] bg-[rgba(244,241,234,0.3)] px-2 py-2">
        {workspaceId ? (
          <WorkspaceExplorerDirectoryEntries
            depth={0}
            directoryPath=""
            expandedDirectoryPaths={expandedDirectoryPaths}
            selectedFilePath={selectedFilePath}
            variant="article-picker"
            workspaceId={workspaceId}
            onSelectFile={onSelectFile}
            onToggleDirectory={onToggleDirectory}
          />
        ) : (
          <div className="px-3 py-5 text-[13px] leading-6 text-[rgba(26,26,26,0.56)]">
            Workspace files are unavailable right now.
          </div>
        )}
      </div>
    </div>
  );
}

function WorkspaceExplorerPanel({
  workspaceId,
  workspaceDisplayName,
  expandedDirectoryPaths,
  selectedFilePath,
  onToggleDirectory,
  onSelectFile,
  onClose,
}: {
  workspaceId: string | null;
  workspaceDisplayName: string;
  expandedDirectoryPaths: string[];
  selectedFilePath: string | null;
  onToggleDirectory: (directoryPath: string) => void;
  onSelectFile: (filePath: string) => void;
  onClose: () => void;
}) {
  return (
    <aside className="flex h-full w-full min-w-0 flex-col border-l border-[var(--text-main)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(244,241,234,0.98)_100%)] shadow-[-10px_0_0_rgba(26,26,26,0.04)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--text-main)] px-4 py-2.5">
        <div className="min-w-0 truncate text-[14px] font-medium leading-6 text-[var(--text-main)]">{workspaceDisplayName}</div>
        <button
          type="button"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-[var(--node-border)] bg-white text-[rgba(26,26,26,0.58)] transition-colors hover:border-[var(--text-main)] hover:text-[var(--text-main)]"
          title="Hide workspace explorer"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {workspaceId ? (
          <WorkspaceExplorerDirectoryEntries
            depth={0}
            directoryPath=""
            expandedDirectoryPaths={expandedDirectoryPaths}
            selectedFilePath={selectedFilePath}
            workspaceId={workspaceId}
            onSelectFile={onSelectFile}
            onToggleDirectory={onToggleDirectory}
          />
        ) : (
          <div className="px-3 py-5 text-[13px] leading-6 text-[rgba(26,26,26,0.56)]">Workspace files are unavailable right now.</div>
        )}
      </div>
    </aside>
  );
}

function WorkspaceExplorerDirectoryEntries({
  workspaceId,
  directoryPath,
  depth,
  expandedDirectoryPaths,
  selectedFilePath,
  variant = "explorer",
  onToggleDirectory,
  onSelectFile,
}: {
  workspaceId: string;
  directoryPath: string;
  depth: number;
  expandedDirectoryPaths: string[];
  selectedFilePath: string | null;
  variant?: "explorer" | "article-picker";
  onToggleDirectory: (directoryPath: string) => void;
  onSelectFile: (filePath: string) => void;
}) {
  const directoryQuery = useQuery({
    queryKey: ["workspace-explorer", workspaceId, directoryPath],
    queryFn: () => request<WorkspaceDirectoryListing>(`/api/workspace/explorer${buildWorkspacePathQueryString(directoryPath)}`),
    staleTime: 30_000,
  });

  if (directoryQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-[12px] leading-5 text-[rgba(26,26,26,0.5)]">
        <LoaderCircle className="size-3.5 animate-spin" />
        Loading files...
      </div>
    );
  }

  if (directoryQuery.error) {
    return (
      <div className="px-3 py-3 text-[12px] leading-5 text-rose-700">
        {formatErrorMessage(directoryQuery.error) ?? "Workspace files could not be read."}
      </div>
    );
  }

  if (!directoryQuery.data || directoryQuery.data.entries.length === 0) {
    return <div className="px-3 py-2 text-[12px] leading-5 text-[rgba(26,26,26,0.44)]">Empty folder.</div>;
  }

  return (
    <div className="flex flex-col">
      {directoryQuery.data.entries.map((entry) =>
        entry.kind === "directory" ? (
          <WorkspaceExplorerDirectoryNode
            key={entry.path}
            depth={depth}
            entry={entry}
            expandedDirectoryPaths={expandedDirectoryPaths}
            selectedFilePath={selectedFilePath}
            variant={variant}
            workspaceId={workspaceId}
            onSelectFile={onSelectFile}
            onToggleDirectory={onToggleDirectory}
          />
        ) : (
          <button
            key={entry.path}
            type="button"
            className={cn(
              "flex w-full items-center border border-transparent pr-3 text-left text-[13px] leading-5 text-[var(--text-main)] transition-colors",
              variant === "article-picker" ? "py-1.5" : "py-2",
              selectedFilePath === entry.path
                ? variant === "article-picker"
                  ? "border-[var(--text-main)] bg-white shadow-[4px_4px_0_rgba(26,26,26,0.04)]"
                  : "border-[var(--text-main)] bg-[var(--bg-cream)]"
                : variant === "article-picker"
                  ? "hover:border-[rgba(26,26,26,0.12)] hover:bg-white"
                  : "hover:border-[var(--node-border)] hover:bg-[rgba(244,241,234,0.48)]",
            )}
            style={{ paddingLeft: `${depth * 16 + 12}px` }}
            title={entry.path}
            onClick={() => onSelectFile(entry.path)}
          >
            <span className="min-w-0 truncate">{entry.name}</span>
          </button>
        ),
      )}
    </div>
  );
}

function WorkspaceExplorerDirectoryNode({
  workspaceId,
  entry,
  depth,
  expandedDirectoryPaths,
  selectedFilePath,
  variant = "explorer",
  onToggleDirectory,
  onSelectFile,
}: {
  workspaceId: string;
  entry: WorkspaceExplorerEntry;
  depth: number;
  expandedDirectoryPaths: string[];
  selectedFilePath: string | null;
  variant?: "explorer" | "article-picker";
  onToggleDirectory: (directoryPath: string) => void;
  onSelectFile: (filePath: string) => void;
}) {
  const isExpanded = expandedDirectoryPaths.includes(entry.path);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-1 border border-transparent pr-3 text-left text-[13px] leading-5 text-[var(--text-main)] transition-colors",
          variant === "article-picker" ? "py-1.5" : "py-2",
          isExpanded
            ? variant === "article-picker"
              ? "bg-white"
              : "bg-[rgba(244,241,234,0.58)]"
            : variant === "article-picker"
              ? "hover:border-[rgba(26,26,26,0.12)] hover:bg-white"
              : "hover:border-[var(--node-border)] hover:bg-[rgba(244,241,234,0.4)]",
        )}
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
        title={entry.path}
        onClick={() => onToggleDirectory(entry.path)}
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-[rgba(26,26,26,0.42)] transition-transform", isExpanded ? "rotate-90" : "")} />
        <span className="min-w-0 truncate">{entry.name}</span>
      </button>

      {isExpanded ? (
        <WorkspaceExplorerDirectoryEntries
          depth={depth + 1}
          directoryPath={entry.path}
          expandedDirectoryPaths={expandedDirectoryPaths}
          selectedFilePath={selectedFilePath}
          variant={variant}
          workspaceId={workspaceId}
          onSelectFile={onSelectFile}
          onToggleDirectory={onToggleDirectory}
        />
      ) : null}
    </div>
  );
}

function WorkspaceFilePreviewPanel({
  filePath,
  file,
  isLoading,
  errorMessage,
  onClose,
}: {
  filePath: string;
  file: WorkspaceFileContent | null;
  isLoading: boolean;
  errorMessage: string | null;
  onClose: () => void;
}) {
  const fileName = file?.name ?? filePath.split("/").at(-1) ?? filePath;
  const fileLines = useMemo(() => splitWorkspaceFileContentLines(file?.content ?? ""), [file?.content]);
  const isMarkdownPreview = isMarkdownFilePath(file?.path ?? filePath);

  return (
    <aside className="flex h-full w-full min-w-0 flex-col border-l border-[var(--text-main)] bg-white shadow-[-10px_0_0_rgba(26,26,26,0.04)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--text-main)] px-4 py-2.5">
        <div className="min-w-0 truncate text-[14px] font-medium leading-6 text-[var(--text-main)]">{fileName}</div>
        <button
          type="button"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-[var(--node-border)] bg-white text-[rgba(26,26,26,0.58)] transition-colors hover:border-[var(--text-main)] hover:text-[var(--text-main)]"
          title="Close file preview"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-[rgba(244,241,234,0.3)]">
        {isLoading ? (
          <div className="flex h-full min-h-[220px] items-center justify-center px-6 py-8 text-[13px] leading-6 text-[rgba(26,26,26,0.54)]">
            <div className="flex items-center gap-3">
              <LoaderCircle className="size-4 animate-spin" />
              Loading file contents...
            </div>
          </div>
        ) : errorMessage ? (
          <div className="px-6 py-6 text-[13px] leading-6 text-rose-700">{errorMessage}</div>
        ) : !file ? (
          <div className="px-6 py-6 text-[13px] leading-6 text-[rgba(26,26,26,0.54)]">Pick a file to inspect it here.</div>
        ) : file.isBinary ? (
          <div className="px-6 py-6 text-[13px] leading-6 text-[rgba(26,26,26,0.62)]">
            This file looks binary, so the preview is disabled. Size: {formatWorkspaceFileSize(file.size)}.
          </div>
        ) : file.content.length === 0 ? (
          <div className="px-6 py-6 text-[13px] leading-6 text-[rgba(26,26,26,0.54)]">This file is empty.</div>
        ) : isMarkdownPreview ? (
          <div className="px-6 py-5 text-[15px] leading-7 text-[var(--text-main)]">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {file.content}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="min-h-full w-max min-w-full px-0 py-0 font-mono text-[12px] leading-6 text-[var(--text-main)]">
            {fileLines.map((line, index) => (
              <div key={index} className="grid w-max min-w-full grid-cols-[4.5rem,max-content]">
                <div className="select-none border-r border-[rgba(26,26,26,0.08)] bg-[rgba(26,26,26,0.035)] px-3 py-0 text-right tabular-nums text-[rgba(26,26,26,0.36)]">
                  {index + 1}
                </div>
                <div className="px-4 py-0 whitespace-pre">{line || " "}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function DeleteConfirmationDialog({
  title,
  description,
  confirmLabel,
  confirmPendingLabel,
  isConfirming,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  confirmPendingLabel: string;
  isConfirming: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="pointer-events-auto fixed inset-0 z-40 flex items-center justify-center bg-[rgba(26,26,26,0.2)] px-6"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-[420px] border border-[var(--text-main)] bg-white shadow-[14px_14px_0_rgba(26,26,26,0.1)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[var(--node-border)] px-6 py-5">
          <div className="text-[18px] font-medium leading-7 text-[var(--text-main)]">{title}</div>
        </div>

        <div className="px-6 py-5 text-[15px] leading-7 text-[rgba(26,26,26,0.76)]">{description}</div>

        <div className="grid grid-cols-2 gap-px bg-[var(--node-border)]">
          <button
            type="button"
            className="bg-white px-5 py-4 text-left text-[15px] font-medium text-[var(--text-main)] transition-colors hover:bg-[var(--bg-cream)] disabled:cursor-not-allowed disabled:text-[rgba(26,26,26,0.38)]"
            disabled={isConfirming}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="bg-rose-50 px-5 py-4 text-left text-[15px] font-medium text-rose-700 transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:text-rose-300"
            disabled={isConfirming}
            onClick={onConfirm}
          >
            {isConfirming ? confirmPendingLabel : confirmLabel}
          </button>
        </div>
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
  const thumbnailWidth = (248 * 2) / 3;
  const thumbnailHeight = (176 * 2) / 3;

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
    const rawWidth = flowWidth * thumbnailGeometry.scale;
    const rawHeight = flowHeight * thumbnailGeometry.scale;
    const width = Math.min(thumbnailWidth, rawWidth);
    const height = Math.min(thumbnailHeight, rawHeight);
    const maxLeft = Math.max(0, thumbnailWidth - width);
    const maxTop = Math.max(0, thumbnailHeight - height);

    return {
      left: clamp(thumbnailGeometry.offsetX + (flowLeft - bounds.minX) * thumbnailGeometry.scale, 0, maxLeft),
      top: clamp(thumbnailGeometry.offsetY + (flowTop - bounds.minY) * thumbnailGeometry.scale, 0, maxTop),
      width,
      height,
    };
  }, [bounds, canvasSize.height, canvasSize.width, thumbnailGeometry, thumbnailHeight, thumbnailWidth, viewport.x, viewport.y, viewport.zoom]);

  const localPointFromClient = useCallback(
    (clientX: number, clientY: number) => {
      if (!frameRef.current) {
        return null;
      }

      const rect = frameRef.current.getBoundingClientRect();
      return {
        x: clamp(clientX - rect.left, 0, rect.width),
        y: clamp(clientY - rect.top, 0, rect.height),
      };
    },
    [],
  );

  const moveViewportFromThumbnail = useCallback(
    (thumbnailLeft: number, thumbnailTop: number) => {
      if (!bounds || !thumbnailGeometry || !viewportRect || canvasSize.width <= 0 || canvasSize.height <= 0) {
        return;
      }

      const nextLeft = clamp(thumbnailLeft, 0, Math.max(0, thumbnailWidth - viewportRect.width));
      const nextTop = clamp(thumbnailTop, 0, Math.max(0, thumbnailHeight - viewportRect.height));
      const flowWidth = canvasSize.width / viewport.zoom;
      const flowHeight = canvasSize.height / viewport.zoom;
      const flowLeft =
        flowWidth < bounds.width
          ? bounds.minX + (nextLeft - thumbnailGeometry.offsetX) / thumbnailGeometry.scale
          : bounds.minX + (bounds.width - flowWidth) / 2;
      const flowTop =
        flowHeight < bounds.height
          ? bounds.minY + (nextTop - thumbnailGeometry.offsetY) / thumbnailGeometry.scale
          : bounds.minY + (bounds.height - flowHeight) / 2;

      onViewportChange({
        x: -flowLeft * viewport.zoom,
        y: -flowTop * viewport.zoom,
        zoom: viewport.zoom,
      });
    },
    [bounds, canvasSize.height, canvasSize.width, onViewportChange, thumbnailGeometry, thumbnailHeight, thumbnailWidth, viewport.zoom, viewportRect],
  );

  useEffect(() => {
    if (!dragState) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const localPoint = localPointFromClient(event.clientX, event.clientY);
      if (!localPoint) {
        return;
      }

      moveViewportFromThumbnail(localPoint.x - dragState.offsetX, localPoint.y - dragState.offsetY);
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
  }, [dragState, localPointFromClient, moveViewportFromThumbnail]);

  if (!bounds || !thumbnailGeometry || !viewportRect) {
    return null;
  }

  const beginThumbnailDrag = (clientX: number, clientY: number, lockToViewport: boolean) => {
    const localPoint = localPointFromClient(clientX, clientY);
    if (!localPoint) {
      return;
    }

    const offsetX = lockToViewport ? localPoint.x - viewportRect.left : viewportRect.width / 2;
    const offsetY = lockToViewport ? localPoint.y - viewportRect.top : viewportRect.height / 2;

    moveViewportFromThumbnail(localPoint.x - offsetX, localPoint.y - offsetY);
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
  const isAssistant = data.message.role === "assistant";
  const isArticle = data.message.role === "article";
  const isUser = data.message.role === "user";
  const roleLabel = resolveMessageRoleLabel(data.message.role, data.assistantLabel);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const sessionIdLabel = data.message.sessionId ?? "pending";
  const [assistantTraceExpanded, setAssistantTraceExpanded] = useState(false);
  const liveAssistantState = useLiveAssistantStateStore((state) =>
    isAssistant ? (state.statesByMessageId[data.message.id] ?? data.persistedAssistantState ?? null) : null,
  );
  const responseContent = isAssistant
    ? liveAssistantState?.responseText || data.message.content
    : data.message.content;
  const canSelectMessage = isAssistant ? !liveAssistantState || liveAssistantState.status === "complete" : isArticle;
  const showPendingAssistantState =
    isAssistant && liveAssistantState && (liveAssistantState.status === "pending" || liveAssistantState.status === "streaming");
  const renderStreamingResponseAsMarkdown = !showPendingAssistantState;
  const shouldFreezeMeasuredHeight = showPendingAssistantState;
  const visibleAssistantBlocks =
    liveAssistantState?.blocks.filter((block) =>
      block.kind === "thinking"
        ? block.text.trim().length > 0
        : block.inputText.trim().length > 0 || block.outputText.trim().length > 0 || block.status === "error",
    ) ?? [];
  const selectedPassage = isUser ? data.message.selectedText?.trim() ?? "" : "";
  const viewport = useViewport();
  const selectionAnchorSignature = useMemo(
    () =>
      JSON.stringify(
        data.selectionAnchors.map((anchor) => [anchor.id, anchor.isExpanded, anchor.startOffset, anchor.endOffset, anchor.label]),
      ),
    [data.selectionAnchors],
  );

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
  }, [assistantTraceExpanded, data.message.id, data.onMeasureHeight, shouldFreezeMeasuredHeight]);

  useEffect(() => {
    const bubbleElement = bubbleRef.current;
    if (!bubbleElement) {
      return;
    }

    const reportSelectionAnchors = () => {
      const bubbleRect = bubbleElement.getBoundingClientRect();
      const nextAnchors = Array.from(bubbleElement.querySelectorAll<HTMLElement>("[data-selection-anchor-id]"))
        .map((button) => {
          const anchorId = button.dataset.selectionAnchorId?.trim() ?? "";
          if (!anchorId) {
            return null;
          }

          const buttonRect = button.getBoundingClientRect();
          const handleRect = button.querySelector<HTMLElement>(".react-flow__handle")?.getBoundingClientRect() ?? buttonRect;
          return {
            id: anchorId,
            side: button.dataset.selectionAnchorSide === "right" ? ("right" as const) : ("left" as const),
            top: (handleRect.top - bubbleRect.top + handleRect.height / 2) / Math.max(viewport.zoom, 0.0001),
          } satisfies MeasuredSelectionAnchorLayout;
        })
        .filter((anchor): anchor is MeasuredSelectionAnchorLayout => anchor !== null);

      data.onMeasureSelectionAnchors(data.message.id, nextAnchors);
    };

    reportSelectionAnchors();

    const frame = window.requestAnimationFrame(reportSelectionAnchors);
    const observer = new ResizeObserver(reportSelectionAnchors);
    observer.observe(bubbleElement);
    window.addEventListener("resize", reportSelectionAnchors);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", reportSelectionAnchors);
    };
  }, [assistantTraceExpanded, data.message.id, data.onMeasureSelectionAnchors, responseContent, selectionAnchorSignature, viewport.zoom]);

  return (
    <div className="relative" style={{ width: messageNodeWidth }}>
      {data.showSessionId ? (
        <div
          className={cn(
            "pointer-events-none absolute top-1/2 z-10 max-w-[148px] -translate-y-1/2",
            data.sessionLabelSide === "left" ? "right-full mr-3 text-right" : "left-full ml-3 text-left",
          )}
          title={sessionIdLabel}
        >
          <div className="editorial-meta text-[rgba(26,26,26,0.38)]">session_id</div>
          <div className="mt-1.5 break-all font-mono text-[11px] leading-5 text-[rgba(26,26,26,0.68)]">
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
        id={makeForkTargetHandleId("left")}
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="!h-1 !w-1 !border-0 !bg-transparent opacity-0"
        style={{ top: branchForkHandleTop }}
      />
      <Handle
        id={makeForkTargetHandleId("right")}
        type="target"
        position={Position.Right}
        isConnectable={false}
        className="!h-1 !w-1 !border-0 !bg-transparent opacity-0"
        style={{ top: branchForkHandleTop }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="!h-1 !w-1 !border-0 !bg-transparent opacity-0"
      />
      <Handle
        id={makeForkSourceHandleId("left")}
        type="source"
        position={Position.Left}
        isConnectable={false}
        className="!h-1 !w-1 !border-0 !bg-transparent opacity-0"
        style={{ top: branchForkHandleTop }}
      />
      <Handle
        id={makeForkSourceHandleId("right")}
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="!h-1 !w-1 !border-0 !bg-transparent opacity-0"
        style={{ top: branchForkHandleTop }}
      />

      <div
        ref={bubbleRef}
        className={cn(
          "group relative overflow-hidden border border-[var(--node-border)] border-t-[4px] bg-white text-left shadow-[8px_8px_0_rgba(26,26,26,0.08)] transition-all",
          !isAssistant
            ? data.isActiveMessage
              ? "border-t-[var(--block-slate)] bg-[rgba(247,247,242,0.98)] shadow-[10px_10px_0_rgba(58,64,66,0.11)]"
              : "border-t-[var(--block-slate)]"
            : liveAssistantState?.status === "error"
              ? "border-dashed border-rose-300 border-t-rose-500 bg-rose-50 shadow-[8px_8px_0_rgba(190,24,93,0.1)]"
            : showPendingAssistantState
              ? "border-dashed border-[var(--block-ochre)] border-t-[var(--block-ochre)] bg-[rgba(255,249,242,0.98)] shadow-[8px_8px_0_rgba(194,142,85,0.12)]"
            : data.hasSelectionDraft
              ? "border-t-[var(--block-ochre)] bg-[rgba(255,249,242,0.98)] shadow-[8px_8px_0_rgba(194,142,85,0.14)]"
            : data.isActiveMessage
              ? "border-t-[var(--block-green)] bg-[rgba(247,247,242,0.98)] shadow-[10px_10px_0_rgba(62,78,66,0.15)]"
              : "border-t-[var(--block-green)] hover:-translate-y-0.5",
        )}
        style={{ width: messageNodeWidth }}
        onClickCapture={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("[data-selection-anchor=\"true\"]") || target.closest("[data-focus-trigger=\"true\"]")) {
            return;
          }

          if (target.closest("[data-stream-block=\"true\"]")) {
            event.stopPropagation();
            return;
          }

          const selectedText = window.getSelection()?.toString().trim();
          if (isConversationSourceRole(data.message.role) && !selectedText) {
            data.onPickMessage(data.message.id);
          }
          event.stopPropagation();
        }}
        onMouseDownCapture={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("[data-selection-anchor=\"true\"]") || target.closest("[data-focus-trigger=\"true\"]")) {
            return;
          }

          if (target.closest("[data-stream-block=\"true\"]")) {
            event.stopPropagation();
            return;
          }

          if (data.hasSelectionDraft) {
            clearBrowserSelection();
          }

          event.stopPropagation();
        }}
        onPointerDownCapture={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("[data-selection-anchor=\"true\"]") || target.closest("[data-focus-trigger=\"true\"]")) {
            return;
          }

          if (target.closest("[data-stream-block=\"true\"]")) {
            event.stopPropagation();
            return;
          }

          if (data.hasSelectionDraft) {
            clearBrowserSelection();
          }

          event.stopPropagation();
        }}
      >
        <div className="relative flex items-start justify-between gap-4 border-b border-[var(--node-border)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  "editorial-meta",
                  !isAssistant
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
              <div className="mt-2 break-words whitespace-pre-wrap text-[13px] italic leading-5 text-[rgba(26,26,26,0.56)]">
                {`"${selectedPassage}"`}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="editorial-meta text-[rgba(26,26,26,0.42)]">
              {formatMessageTime(data.message.createdAt)}
            </div>
            {isArticle ? (
              <button
                type="button"
                data-focus-trigger="true"
                className="inline-flex h-8 min-w-[2rem] items-center justify-center border border-[var(--text-main)] bg-white px-2 text-[var(--text-main)] transition-colors hover:bg-[var(--bg-cream)]"
                title="Open focus view"
                onMouseDown={(event) => {
                  event.stopPropagation();
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  data.onEnterFocusView(data.message.id);
                }}
              >
                <ZoomIn className="size-3.5" />
              </button>
            ) : null}
          </div>
        </div>

        <div className="relative px-4 py-4">
          {isAssistant && liveAssistantState ? (
            <div className="space-y-3">
              {visibleAssistantBlocks.length > 0 ? (
                <details
                  data-stream-block="true"
                  open={assistantTraceExpanded}
                  onToggle={(event) => {
                    const nextExpanded = event.currentTarget.open;
                    setAssistantTraceExpanded((current) => (current === nextExpanded ? current : nextExpanded));
                  }}
                  className="border border-[var(--node-border)] bg-[rgba(244,241,234,0.34)]"
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <ChevronDown
                      className={cn(
                        "size-4 shrink-0 text-[rgba(26,26,26,0.46)] transition-transform",
                        assistantTraceExpanded ? "rotate-0" : "-rotate-90",
                      )}
                      />
                      <span className="editorial-meta text-[rgba(26,26,26,0.72)]">Thinking & Tools</span>
                    </div>
                  </summary>

                  <div className="space-y-3 border-t border-[var(--node-border)] px-3 py-3">
                    {visibleAssistantBlocks.map((block) => (
                      <details
                        key={block.id}
                        data-stream-block="true"
                        className="border border-[var(--node-border)] bg-[rgba(244,241,234,0.5)]"
                      >
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 border-b border-[var(--node-border)] px-3 py-2.5">
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
                        <div className="space-y-3 px-3 py-3">
                          {block.kind === "thinking" ? (
                            <div className="message-copy whitespace-pre-wrap text-[15px] leading-7 text-[rgba(26,26,26,0.78)]">
                              {block.text || `${data.assistantLabel} is thinking...`}
                            </div>
                          ) : (
                            <>
                              <div>
                                <div className="editorial-meta text-[rgba(26,26,26,0.44)]">Tool input</div>
                                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap border border-[var(--node-border)] bg-white px-3 py-3 text-[13px] leading-6 text-[rgba(26,26,26,0.78)]">
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
                                      "mt-2 overflow-x-auto whitespace-pre-wrap border px-3 py-3 text-[13px] leading-6",
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
                  </div>
                </details>
              ) : null}

              <div
                className={cn(
                  "border px-3 py-3",
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
                      disabled={!canSelectMessage}
                      renderMarkdown={renderStreamingResponseAsMarkdown}
                      onToggleAnchor={data.onToggleSelectionAnchor}
                      onSelection={(draft) => data.onSelectionDraft({ ...draft, sourceMessageId: data.message.id })}
                    />
                  ) : (
                    <div className="flex min-h-[60px] items-center gap-3 text-[15px] leading-7 text-[rgba(26,26,26,0.58)]">
                      <LoaderCircle className="size-4 animate-spin text-[var(--block-ochre)]" />
                      <span>{`Waiting for ${data.assistantLabel} to respond...`}</span>
                    </div>
                  )}
                </div>
              </div>

              {liveAssistantState.errorMessage ? (
                <div className="border border-rose-200 bg-rose-50 px-3 py-2.5 text-[14px] leading-6 text-rose-700">
                  {liveAssistantState.errorMessage}
                </div>
              ) : null}
            </div>
          ) : (
            <SelectableMessage
              nodeId={data.message.id}
              content={responseContent}
              anchors={data.selectionAnchors}
              disabled={!canSelectMessage}
              renderMarkdown={isArticle && isMarkdownFilePath(data.message.sourcePath ?? "")}
              onToggleAnchor={data.onToggleSelectionAnchor}
              onSelection={(draft) => data.onSelectionDraft({ ...draft, sourceMessageId: data.message.id })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function FocusMessageBubble({
  message,
  persistedAssistantState,
  assistantLabel,
  isActiveMessage,
  hasSelectionDraft,
  selectionAnchors,
  onPickMessage,
  onToggleSelectionAnchor,
  onSelectionDraft,
}: {
  message: MessageNode;
  persistedAssistantState: AssistantStreamState | null;
  assistantLabel: string;
  isActiveMessage: boolean;
  hasSelectionDraft: boolean;
  selectionAnchors: MessageSelectionAnchor[];
  onPickMessage: (messageId: string) => void;
  onToggleSelectionAnchor: (anchor: MessageSelectionAnchor) => void;
  onSelectionDraft: (draft: SelectionDraft) => void;
}) {
  const isAssistant = message.role === "assistant";
  const isArticle = message.role === "article";
  const isUser = message.role === "user";
  const roleLabel = resolveMessageRoleLabel(message.role, assistantLabel);
  const [assistantTraceExpanded, setAssistantTraceExpanded] = useState(false);
  const liveAssistantState = useLiveAssistantStateStore((state) =>
    isAssistant ? (state.statesByMessageId[message.id] ?? persistedAssistantState ?? null) : null,
  );
  const responseContent = isAssistant ? liveAssistantState?.responseText || message.content : message.content;
  const canSelectMessage = isAssistant ? !liveAssistantState || liveAssistantState.status === "complete" : isArticle;
  const showPendingAssistantState =
    isAssistant && liveAssistantState && (liveAssistantState.status === "pending" || liveAssistantState.status === "streaming");
  const renderStreamingResponseAsMarkdown = !showPendingAssistantState;
  const visibleAssistantBlocks =
    liveAssistantState?.blocks.filter((block) =>
      block.kind === "thinking"
        ? block.text.trim().length > 0
        : block.inputText.trim().length > 0 || block.outputText.trim().length > 0 || block.status === "error",
    ) ?? [];
  const selectedPassage = isUser ? message.selectedText?.trim() ?? "" : "";

  return (
    <div
      data-focus-message-id={message.id}
      className="w-full"
      style={{ scrollMarginTop: focusViewScrollTopInset }}
    >
      <div
        className={cn(
          "relative overflow-hidden border border-[var(--node-border)] border-t-[4px] bg-white text-left shadow-[10px_10px_0_rgba(26,26,26,0.08)] transition-colors",
          !isAssistant
            ? isActiveMessage
              ? "border-t-[var(--block-slate)] bg-[rgba(247,247,242,0.98)] shadow-[12px_12px_0_rgba(58,64,66,0.11)]"
              : "border-t-[var(--block-slate)]"
            : liveAssistantState?.status === "error"
              ? "border-dashed border-rose-300 border-t-rose-500 bg-rose-50 shadow-[10px_10px_0_rgba(190,24,93,0.1)]"
            : showPendingAssistantState
              ? "border-dashed border-[var(--block-ochre)] border-t-[var(--block-ochre)] bg-[rgba(255,249,242,0.98)] shadow-[10px_10px_0_rgba(194,142,85,0.12)]"
            : hasSelectionDraft
              ? "border-t-[var(--block-ochre)] bg-[rgba(255,249,242,0.98)] shadow-[10px_10px_0_rgba(194,142,85,0.14)]"
            : isActiveMessage
              ? "border-t-[var(--block-green)] bg-[rgba(247,247,242,0.98)] shadow-[12px_12px_0_rgba(62,78,66,0.15)]"
              : "border-t-[var(--block-green)]",
        )}
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
          if (isConversationSourceRole(message.role) && !selectedText) {
            onPickMessage(message.id);
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

          if (hasSelectionDraft) {
            clearBrowserSelection();
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

          if (hasSelectionDraft) {
            clearBrowserSelection();
          }

          event.stopPropagation();
        }}
      >
        <div className="relative flex items-start justify-between gap-4 border-b border-[var(--node-border)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  "editorial-meta",
                  !isAssistant
                    ? "text-[rgba(58,64,66,0.72)]"
                    : showPendingAssistantState || hasSelectionDraft
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
              <div className="mt-2 break-words whitespace-pre-wrap text-[13px] italic leading-5 text-[rgba(26,26,26,0.56)]">
                {`"${selectedPassage}"`}
              </div>
            ) : null}
          </div>
          <div className="shrink-0 editorial-meta text-[rgba(26,26,26,0.42)]">
            {formatMessageTime(message.createdAt)}
          </div>
        </div>

        <div className="relative px-4 py-4">
          {isAssistant && liveAssistantState ? (
            <div className="space-y-3">
              {visibleAssistantBlocks.length > 0 ? (
                <details
                  data-stream-block="true"
                  open={assistantTraceExpanded}
                  onToggle={(event) => {
                    const nextExpanded = event.currentTarget.open;
                    setAssistantTraceExpanded((current) => (current === nextExpanded ? current : nextExpanded));
                  }}
                  className="border border-[var(--node-border)] bg-[rgba(244,241,234,0.34)]"
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <ChevronDown
                        className={cn(
                          "size-4 shrink-0 text-[rgba(26,26,26,0.46)] transition-transform",
                          assistantTraceExpanded ? "rotate-0" : "-rotate-90",
                        )}
                      />
                      <span className="editorial-meta text-[rgba(26,26,26,0.72)]">Thinking & Tools</span>
                    </div>
                  </summary>

                  <div className="space-y-3 border-t border-[var(--node-border)] px-3 py-3">
                    {visibleAssistantBlocks.map((block) => (
                      <details
                        key={block.id}
                        data-stream-block="true"
                        className="border border-[var(--node-border)] bg-[rgba(244,241,234,0.5)]"
                      >
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 border-b border-[var(--node-border)] px-3 py-2.5">
                          <span className="editorial-meta text-[rgba(26,26,26,0.66)]">
                            {block.kind === "thinking" ? "Thinking" : `Tool 路 ${block.toolName}`}
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
                            {block.status === "error" ? "Error" : block.status === "complete" ? "Complete" : "Streaming"}
                          </span>
                        </summary>
                        <div className="space-y-3 px-3 py-3">
                          {block.kind === "thinking" ? (
                            <div className="message-copy whitespace-pre-wrap text-[15px] leading-7 text-[rgba(26,26,26,0.78)]">
                              {block.text || `${assistantLabel} is thinking...`}
                            </div>
                          ) : (
                            <>
                              <div>
                                <div className="editorial-meta text-[rgba(26,26,26,0.44)]">Tool input</div>
                                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap border border-[var(--node-border)] bg-white px-3 py-3 text-[13px] leading-6 text-[rgba(26,26,26,0.78)]">
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
                                      "mt-2 overflow-x-auto whitespace-pre-wrap border px-3 py-3 text-[13px] leading-6",
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
                  </div>
                </details>
              ) : null}

              <div
                className={cn(
                  "border px-3 py-3",
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
                      nodeId={message.id}
                      anchors={selectionAnchors}
                      content={responseContent}
                      disabled={!canSelectMessage}
                      renderAnchorHandles={false}
                      renderMarkdown={renderStreamingResponseAsMarkdown}
                      syncNodeInternals={false}
                      onToggleAnchor={onToggleSelectionAnchor}
                      onSelection={(draft) => onSelectionDraft({ ...draft, sourceMessageId: message.id })}
                    />
                  ) : (
                    <div className="flex min-h-[60px] items-center gap-3 text-[15px] leading-7 text-[rgba(26,26,26,0.58)]">
                      <LoaderCircle className="size-4 animate-spin text-[var(--block-ochre)]" />
                      <span>{`Waiting for ${assistantLabel} to respond...`}</span>
                    </div>
                  )}
                </div>
              </div>

              {liveAssistantState.errorMessage ? (
                <div className="border border-rose-200 bg-rose-50 px-3 py-2.5 text-[14px] leading-6 text-rose-700">
                  {liveAssistantState.errorMessage}
                </div>
              ) : null}
            </div>
          ) : (
            <SelectableMessage
              nodeId={message.id}
              anchors={selectionAnchors}
              content={responseContent}
              disabled={!canSelectMessage}
              renderAnchorHandles={false}
              renderMarkdown={isArticle && isMarkdownFilePath(message.sourcePath ?? "")}
              syncNodeInternals={false}
              onToggleAnchor={onToggleSelectionAnchor}
              onSelection={(draft) => onSelectionDraft({ ...draft, sourceMessageId: message.id })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function FocusBranchContinuationChooser({
  continuations,
  onSelect,
}: {
  continuations: FocusBranchContinuation[];
  onSelect: (continuation: FocusBranchContinuation) => void;
}) {
  if (continuations.length <= 1) {
    return null;
  }

  return (
    <div className="relative -mt-1 w-full pb-2 pt-1">
      <div className="relative h-[138px] w-full">
        {continuations.map((continuation, index) => {
          const left = `${((index + 1) / (continuations.length + 1)) * 100}%`;
          const preview = continuation.preview.replace(/\s+/g, " ").trim() || "(empty)";

          return (
            <div
              key={continuation.id}
              className="absolute top-0 w-[min(15rem,calc(100%-1rem))] -translate-x-1/2"
              style={{ left }}
            >
              <div className="pointer-events-none absolute left-1/2 top-0 h-12 -translate-x-1/2 border-l border-dashed border-[rgba(26,26,26,0.34)]" />
              <ArrowUp className="pointer-events-none absolute left-1/2 top-9 size-3 -translate-x-1/2 rotate-180 text-[rgba(26,26,26,0.42)]" />
              <button
                type="button"
                className={cn(
                  "mt-12 w-full border px-3 py-3 text-left shadow-[8px_8px_0_rgba(26,26,26,0.05)] transition-colors",
                  continuation.isActive
                    ? "border-[var(--text-main)] bg-[var(--text-main)] text-white"
                    : "border-[var(--node-border)] bg-white text-[var(--text-main)] hover:bg-[var(--bg-cream)]",
                )}
                title={preview}
                onClick={() => onSelect(continuation)}
              >
                <div className={cn("editorial-meta", continuation.isActive ? "text-white/76" : "text-[rgba(26,26,26,0.42)]")}>
                  user query
                </div>
                <div className={cn("mt-1 max-h-[3.75rem] overflow-hidden text-[13px] leading-5", continuation.isActive ? "text-white" : "text-[rgba(26,26,26,0.78)]")}>
                  {truncate(preview, 120)}
                </div>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SelectableMessage({
  nodeId,
  content,
  anchors,
  disabled,
  renderAnchorHandles = true,
  renderMarkdown,
  syncNodeInternals = true,
  onToggleAnchor,
  onSelection,
}: {
  nodeId: string;
  content: string;
  anchors: MessageSelectionAnchor[];
  disabled: boolean;
  renderAnchorHandles?: boolean;
  renderMarkdown: boolean;
  syncNodeInternals?: boolean;
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
      setPositionedAnchors((current) => (current.length === 0 ? current : []));
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
  const anchorsForRender = useMemo(
    () =>
      renderableAnchors.map((anchor, index) => {
        const positioned = positionedAnchorsById.get(anchor.id);
        if (positioned) {
          return positioned;
        }

        return {
          ...anchor,
          side: index % 2 === 0 ? ("left" as const) : ("right" as const),
          top: 26 + index * 32,
        };
      }),
    [positionedAnchorsById, renderableAnchors],
  );
  const leftAnchors = useMemo(() => anchorsForRender.filter((anchor) => anchor.side === "left"), [anchorsForRender]);
  const rightAnchors = useMemo(() => anchorsForRender.filter((anchor) => anchor.side === "right"), [anchorsForRender]);
  const nodeInternalsSignature = useMemo(
    () => JSON.stringify(anchorsForRender.map((anchor) => [anchor.id, anchor.handleId, anchor.side, anchor.top])),
    [anchorsForRender],
  );

  useEffect(() => {
    if (!syncNodeInternals) {
      return;
    }

    // React Flow only needs to refresh handles when their layout actually changes.
    const frame = window.requestAnimationFrame(() => {
      updateNodeInternals(nodeId);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [nodeId, nodeInternalsSignature, syncNodeInternals, updateNodeInternals]);

  return (
    <div
      className={cn(
        "message-copy text-[17px] font-medium leading-9 text-[var(--text-main)] selection:bg-[rgba(194,142,85,0.24)] selection:text-[var(--text-main)]",
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
      <div className={cn(hasAnchors ? "grid grid-cols-[116px_minmax(0,1fr)_116px] gap-2" : "")}>
        {hasAnchors ? (
          <div className="relative">
            {leftAnchors.map((anchor) => (
              <button
                key={anchor.id}
                type="button"
                data-selection-anchor="true"
                data-selection-anchor-id={anchor.id}
                data-selection-anchor-side={anchor.side}
                title={anchor.label}
                className={cn(
                  "nodrag nopan absolute left-1/2 z-10 inline-flex w-[112px] -translate-x-1/2 -translate-y-1/2 items-center justify-center border px-2 py-1 text-center text-[10px] leading-4 transition-colors",
                  anchor.isExpanded
                    ? "border-[var(--text-main)] bg-[var(--text-main)] text-white"
                    : "border-[var(--block-ochre)] bg-[rgba(255,249,242,0.98)] text-[var(--block-ochre)] hover:bg-[var(--block-ochre)] hover:text-white",
                )}
                style={{ top: anchor.top, minHeight: 26 }}
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
                {renderAnchorHandles ? (
                  <Handle
                    id={anchor.handleId}
                    type="source"
                    position={anchor.side === "left" ? Position.Left : Position.Right}
                    isConnectable={false}
                    className={cn(
                      "!h-1 !w-1 !border-0 !bg-transparent opacity-0",
                      anchor.side === "left"
                        ? "!left-0 !top-1/2 !-translate-x-0 !-translate-y-1/2"
                        : "!right-0 !top-1/2 !translate-x-0 !-translate-y-1/2",
                    )}
                  />
                ) : null}
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
                data-selection-anchor-id={anchor.id}
                data-selection-anchor-side={anchor.side}
                title={anchor.label}
                className={cn(
                  "nodrag nopan absolute left-1/2 z-10 inline-flex w-[112px] -translate-x-1/2 -translate-y-1/2 items-center justify-center border px-2 py-1 text-center text-[10px] leading-4 transition-colors",
                  anchor.isExpanded
                    ? "border-[var(--text-main)] bg-[var(--text-main)] text-white"
                    : "border-[var(--block-ochre)] bg-[rgba(255,249,242,0.98)] text-[var(--block-ochre)] hover:bg-[var(--block-ochre)] hover:text-white",
                )}
                style={{ top: anchor.top, minHeight: 26 }}
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
                {renderAnchorHandles ? (
                  <Handle
                    id={anchor.handleId}
                    type="source"
                    position={anchor.side === "left" ? Position.Left : Position.Right}
                    isConnectable={false}
                    className={cn(
                      "!h-1 !w-1 !border-0 !bg-transparent opacity-0",
                      anchor.side === "left"
                        ? "!left-0 !top-1/2 !-translate-x-0 !-translate-y-1/2"
                        : "!right-0 !top-1/2 !translate-x-0 !-translate-y-1/2",
                    )}
                  />
                ) : null}
                <span className="line-clamp-2 whitespace-pre-wrap break-words">{anchor.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {hasAnchors ? <div className="mt-2 border-t border-[rgba(26,26,26,0.08)]" /> : null}
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

function areMeasuredSelectionAnchorLayoutsEqual(
  left: MeasuredSelectionAnchorLayout[],
  right: MeasuredSelectionAnchorLayout[],
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

    if (leftAnchor.id !== rightAnchor.id || leftAnchor.side !== rightAnchor.side || leftAnchor.top !== rightAnchor.top) {
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

function makeForkSourceHandleId(side: "left" | "right") {
  return `fork-source-${side}`;
}

function makeForkTargetHandleId(side: "left" | "right") {
  return `fork-target-${side}`;
}

function buildSelectionAnchorMetadata(snapshot: GraphSnapshot, visibleBranchIds: Set<string>) {
  const branchOrder = new Map(snapshot.branches.map((branch, index) => [branch.id, index]));
  const messagesById = new Map(snapshot.messages.map((message) => [message.id, message]));
  const allMessagesByBranch = new Map<string, MessageNode[]>();
  const childBranchesBySourceMessage = new Map<string, typeof snapshot.branches>();
  const selectionAnchorsByMessageId = new Map<string, MessageSelectionAnchor[]>();

  for (const message of snapshot.messages) {
    const branchMessages = allMessagesByBranch.get(message.branchId) ?? [];
    branchMessages.push(message);
    allMessagesByBranch.set(message.branchId, branchMessages);
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
  }

  for (const childBranches of childBranchesBySourceMessage.values()) {
    childBranches.sort((left, right) => (branchOrder.get(left.id) ?? 0) - (branchOrder.get(right.id) ?? 0));
  }

  return {
    childBranchesBySourceMessage,
    selectionAnchorsByMessageId,
  };
}

function buildFocusWholeMessageContinuations(snapshot: GraphSnapshot, activePathMessageIds: Set<string>) {
  const branchOrder = new Map(snapshot.branches.map((branch, index) => [branch.id, index]));
  const messagesByBranch = new Map<string, MessageNode[]>();
  const wholeMessageChildBranchesBySourceMessageId = new Map<string, GraphSnapshot["branches"]>();
  const continuationsBySourceMessageId = new Map<string, FocusBranchContinuation[]>();

  for (const message of snapshot.messages) {
    const branchMessages = messagesByBranch.get(message.branchId) ?? [];
    branchMessages.push(message);
    messagesByBranch.set(message.branchId, branchMessages);
  }

  for (const branch of snapshot.branches) {
    if (!branch.sourceMessageId || branch.selectedText?.trim()) {
      continue;
    }

    const childBranches = wholeMessageChildBranchesBySourceMessageId.get(branch.sourceMessageId) ?? [];
    childBranches.push(branch);
    wholeMessageChildBranchesBySourceMessageId.set(branch.sourceMessageId, childBranches);
  }

  for (const childBranches of wholeMessageChildBranchesBySourceMessageId.values()) {
    childBranches.sort((left, right) => (branchOrder.get(left.id) ?? 0) - (branchOrder.get(right.id) ?? 0));
  }

  for (const message of snapshot.messages) {
    if (!isConversationSourceRole(message.role)) {
      continue;
    }

    const continuations: FocusBranchContinuation[] = [];
    const branchMessages = messagesByBranch.get(message.branchId) ?? [];
    const sourceMessageIndex = branchMessages.findIndex((candidate) => candidate.id === message.id);

    if (sourceMessageIndex >= 0) {
      const nextUserMessage = branchMessages.slice(sourceMessageIndex + 1).find((candidate) => candidate.role === "user") ?? null;
      if (nextUserMessage) {
        continuations.push({
          id: `${message.id}::main`,
          kind: "main",
          sourceMessageId: message.id,
          branchId: message.branchId,
          targetMessageId: nextUserMessage.id,
          focusTargetMessageId: branchMessages.at(-1)?.id ?? nextUserMessage.id,
          preview: nextUserMessage.content,
          isActive: activePathMessageIds.has(nextUserMessage.id),
        });
      }
    }

    const childBranches = wholeMessageChildBranchesBySourceMessageId.get(message.id) ?? [];
    childBranches.forEach((branch) => {
      const branchMessages = messagesByBranch.get(branch.id) ?? [];
      const firstUserMessage = branchMessages.find((candidate) => candidate.role === "user") ?? null;
      if (!firstUserMessage) {
        return;
      }

      continuations.push({
        id: branch.id,
        kind: "branch",
        sourceMessageId: message.id,
        branchId: branch.id,
        targetMessageId: firstUserMessage.id,
        focusTargetMessageId: branchMessages.at(-1)?.id ?? firstUserMessage.id,
        preview: firstUserMessage.content,
        isActive: activePathMessageIds.has(firstUserMessage.id),
      });
    });

    if (continuations.length > 0) {
      continuationsBySourceMessageId.set(message.id, continuations);
    }
  }

  return continuationsBySourceMessageId;
}

function buildVisiblePathMessages(snapshot: GraphSnapshot, targetMessageId: string) {
  const targetMessage = snapshot.messages.find((message) => message.id === targetMessageId);
  if (!targetMessage) {
    return [] as MessageNode[];
  }

  const branchesById = new Map(snapshot.branches.map((branch) => [branch.id, branch]));
  const messagesByBranch = new Map<string, MessageNode[]>();

  for (const message of snapshot.messages) {
    const branchMessages = messagesByBranch.get(message.branchId) ?? [];
    branchMessages.push(message);
    messagesByBranch.set(message.branchId, branchMessages);
  }

  const lineage: GraphSnapshot["branches"] = [];
  let currentBranchId: string | null = targetMessage.branchId;

  while (currentBranchId) {
    const branch = branchesById.get(currentBranchId);
    if (!branch) {
      break;
    }

    lineage.push(branch);
    currentBranchId = branch.parentBranchId;
  }

  lineage.reverse();

  const stopMessageIds = new Map<string, string>();
  stopMessageIds.set(targetMessage.branchId, targetMessage.id);

  for (let index = 1; index < lineage.length; index += 1) {
    const parentBranch = lineage[index - 1];
    const childBranch = lineage[index];
    if (!childBranch.sourceMessageId) {
      continue;
    }

    stopMessageIds.set(parentBranch.id, childBranch.sourceMessageId);
  }

  const visibleMessages: MessageNode[] = [];

  for (const branch of lineage) {
    const branchMessages = messagesByBranch.get(branch.id) ?? [];
    const stopMessageId = stopMessageIds.get(branch.id);
    if (!stopMessageId) {
      continue;
    }

    for (const message of branchMessages) {
      visibleMessages.push(message);
      if (message.id === stopMessageId) {
        break;
      }
    }
  }

  return visibleMessages;
}

function buildFocusViewMessages(snapshot: GraphSnapshot, targetMessageId: string) {
  const targetMessage = snapshot.messages.find((message) => message.id === targetMessageId);
  if (!targetMessage) {
    return [] as MessageNode[];
  }

  const rootArticleContinuations =
    targetMessage.role === "article" && targetMessage.branchId === rootBranchId
      ? buildFocusWholeMessageContinuations(snapshot, new Set<string>()).get(targetMessage.id) ?? []
      : [];

  if (targetMessage.role === "article" && targetMessage.branchId === rootBranchId && rootArticleContinuations.length <= 1) {
    return snapshot.messages.filter((message) => message.branchId === rootBranchId);
  }

  return buildVisiblePathMessages(snapshot, targetMessageId);
}

function buildFlowGraph({
  defaultAssistantLabel,
  expandedBranchIds,
  persistedAssistantStatesByMessageId,
  snapshot,
  activePathMessageId,
  selectionDraft,
  measuredNodeHeights,
  measuredSelectionAnchorLayoutsByMessageId,
  onMeasureHeight,
  onMeasureSelectionAnchors,
  onEnterFocusView,
  onPickMessage,
  onToggleSelectionAnchor,
  onSelectionDraft,
  showSessionIds,
}: {
  defaultAssistantLabel: string;
  expandedBranchIds: Set<string>;
  persistedAssistantStatesByMessageId: Record<string, AssistantStreamState | null>;
  snapshot: GraphSnapshot;
  activePathMessageId: string | null;
  selectionDraft: SelectionDraft | null;
  measuredNodeHeights: Record<string, number>;
  measuredSelectionAnchorLayoutsByMessageId: Record<string, MeasuredSelectionAnchorLayout[]>;
  onMeasureHeight: (messageId: string, height: number) => void;
  onMeasureSelectionAnchors: (messageId: string, anchors: MeasuredSelectionAnchorLayout[]) => void;
  onEnterFocusView: (messageId: string) => void;
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
  const {
    childBranchesBySourceMessage,
    selectionAnchorsByMessageId,
  } = buildSelectionAnchorMetadata(snapshot, visibleBranchIds);
  const visibleBranches = snapshot.branches.filter((branch) => visibleBranchIds.has(branch.id));
  const visibleMessages = snapshot.messages.filter((message) => visibleBranchIds.has(message.branchId));
  const visibleMessagesByBranch = new Map<string, MessageNode[]>();

  for (const message of visibleMessages) {
    const branchMessages = visibleMessagesByBranch.get(message.branchId) ?? [];
    branchMessages.push(message);
    visibleMessagesByBranch.set(message.branchId, branchMessages);
  }

  function getMeasuredSelectionAnchorLayout(sourceMessageId: string, branchId: string) {
    return measuredSelectionAnchorLayoutsByMessageId[sourceMessageId]?.find((anchor) => anchor.id === branchId) ?? null;
  }

  function getBranchHorizontalOffset(branch: GraphSnapshot["branches"][number]) {
    return branch.selectedText?.trim() ? selectionBranchLaneWidth : branchLaneWidth;
  }

  const branchCenterXById = new Map<string, number>([[rootBranchId, 0]]);
  const branchSideById = new Map<string, "center" | "left" | "right">([[rootBranchId, "center"]]);
  let nextCenterLeftX = 0;
  let nextCenterRightX = 0;

  placeBranch(rootBranchId, 0);

  const forkSourceHandleByEdgeId = new Map<string, string>();
  const forkTargetHandleByEdgeId = new Map<string, string>();

  visibleBranches.forEach((branch) => {
    if (!branch.sourceMessageId) {
      return;
    }

    const firstBranchMessage = visibleMessagesByBranch.get(branch.id)?.[0];
    const measuredAnchorLayout = getMeasuredSelectionAnchorLayout(branch.sourceMessageId, branch.id);
    const branchSide = measuredAnchorLayout?.side ?? branchSideById.get(branch.id);
    if (!firstBranchMessage || !branch.selectedText?.trim() || (branchSide !== "left" && branchSide !== "right")) {
      return;
    }

    const forkEdgeId = `edge_fork_${branch.sourceMessageId}_${firstBranchMessage.id}`;
    forkSourceHandleByEdgeId.set(forkEdgeId, makeSelectionAnchorHandleId(branch.id));
    forkTargetHandleByEdgeId.set(
      forkEdgeId,
      makeForkTargetHandleId(branchSide === "left" ? "right" : "left"),
    );
  });

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
      sourceHandle: edge.kind === "fork" ? forkSourceHandleByEdgeId.get(edge.id) : undefined,
      target: edge.target,
      targetHandle: edge.kind === "fork" ? forkTargetHandleByEdgeId.get(edge.id) : undefined,
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

  return { nodes, edges };

  function placeBranch(branchId: string, startY: number) {
    const centerX = branchCenterXById.get(branchId) ?? 0;
    const branchSide = branchSideById.get(branchId) ?? "center";
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
          assistantLabel:
            message.runtimeKind ? resolveAgentRuntimeLabel(message.runtimeKind) : defaultAssistantLabel,
          isActiveMessage: message.id === activePathMessageId,
          hasSelectionDraft: selectionDraft?.sourceMessageId === message.id,
          selectionAnchors: selectionAnchorsByMessageId.get(message.id) ?? [],
          showSessionId: showSessionIds,
          sessionLabelSide: branchSide === "left" ? "left" : "right",
          onMeasureHeight,
          onMeasureSelectionAnchors,
          onEnterFocusView,
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

        assignLaneToBranch(childBranch, branchId);
        const measuredAnchorLayout = getMeasuredSelectionAnchorLayout(message.id, childBranch.id);
        const nextStartY =
          childBranch.selectedText?.trim()
            ? measuredAnchorLayout
              ? cursorY + measuredAnchorLayout.top - branchForkHandleTop
              : cursorY
            : cursorY + height + branchForkGap;
        placeBranch(childBranch.id, nextStartY);
      });

      cursorY += height + branchMessageGap;
    });
  }

  function assignLaneToBranch(branch: GraphSnapshot["branches"][number], parentBranchId: string) {
    const branchId = branch.id;
    if (branchCenterXById.has(branchId)) {
      return;
    }

    const parentSide = branchSideById.get(parentBranchId) ?? "center";
    const parentCenterX = branchCenterXById.get(parentBranchId) ?? 0;
    const isSelectionBranch = Boolean(branch.selectedText?.trim());
    const measuredAnchorLayout = branch.sourceMessageId
      ? getMeasuredSelectionAnchorLayout(branch.sourceMessageId, branch.id)
      : null;
    const horizontalOffset = getBranchHorizontalOffset(branch);
    const side =
      measuredAnchorLayout?.side ??
      (parentSide === "center"
        ? Math.abs(nextCenterLeftX) <= Math.abs(nextCenterRightX)
          ? "left"
          : "right"
        : parentSide);
    let centerX: number;

    if (isSelectionBranch) {
      centerX = parentCenterX + (side === "left" ? -horizontalOffset : horizontalOffset);
    } else if (parentSide === "center") {
      if (side === "left") {
        centerX = nextCenterLeftX === 0 ? -horizontalOffset : nextCenterLeftX - horizontalOffset;
        nextCenterLeftX = centerX;
      } else {
        centerX = nextCenterRightX === 0 ? horizontalOffset : nextCenterRightX + horizontalOffset;
        nextCenterRightX = centerX;
      }
    } else {
      centerX = parentCenterX + (side === "left" ? -horizontalOffset : horizontalOffset);
    }

    branchSideById.set(branchId, side);
    branchCenterXById.set(branchId, centerX);
  }
}


function estimateMessageBubbleHeight(message: MessageNode) {
  return estimateBubbleHeightFromContent(message.content, message.selectedText);
}

function estimateBubbleHeightFromContent(content: string, selectedText: string | null) {
  const normalized = content.replace(/\r\n/g, "\n");
  const selectedPassage = selectedText?.replace(/\r\n/g, "\n").trim() ?? "";
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

function estimateViewportBubbleHeightFromContent(content: string) {
  const normalized = content.replace(/\r\n/g, "\n");
  const wrappedLines = normalized.split("\n").reduce((count, line) => {
    const visibleLength = Math.max(line.trim().length, 1);
    return count + Math.max(1, Math.ceil(visibleLength / messageEstimateCharsPerLine));
  }, 0);

  return 98 + wrappedLines * 40;
}

function buildInitialRootTurnViewport(input: {
  canvasSize: { width: number; height: number };
  prompt: string;
}): CanvasViewport | null {
  if (input.canvasSize.width <= 0 || input.canvasSize.height <= 0) {
    return null;
  }

  const targetBubbleWidth = Math.min(newNetComposerWidth, Math.max(320, input.canvasSize.width - 48));
  const zoom = clamp(targetBubbleWidth / messageNodeWidth, canvasMinZoom, canvasMaxZoom);
  const bubbleHeight = estimateViewportBubbleHeightFromContent(input.prompt);

  return {
    x: input.canvasSize.width / 2,
    y: Math.max(32, input.canvasSize.height * initialRootTurnVerticalCenterRatio - (bubbleHeight / 2) * zoom),
    zoom,
  };
}

function getInitialCanvasSize(sidebarCollapsed: boolean) {
  if (typeof window === "undefined") {
    return { width: 0, height: 0 };
  }

  const isDesktopCanvasLayout = window.innerWidth >= desktopCanvasLayoutBreakpoint;
  const reservedSidebarWidth = isDesktopCanvasLayout
    ? (sidebarCollapsed ? collapsedSidebarWidth : expandedSidebarWidth)
    : 0;

  return {
    width: Math.max(0, window.innerWidth - reservedSidebarWidth),
    height: window.innerHeight,
  };
}

function getRootBranchFirstConversationMessage(snapshot: GraphSnapshot) {
  return snapshot.messages.find(
    (message) => message.branchId === rootBranchId && (message.role === "user" || message.role === "article"),
  ) ?? null;
}

function isConversationSourceRole(role: MessageNode["role"] | undefined): role is "assistant" | "article" {
  return role === "assistant" || role === "article";
}

function resolveMessageRoleLabel(role: MessageNode["role"], assistantLabel: string) {
  switch (role) {
    case "user":
      return "User";
    case "article":
      return "article";
    default:
      return assistantLabel;
  }
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

function readBooleanFromLocalStorage(key: string, fallback: boolean) {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const storedValue = window.localStorage.getItem(key);
    return storedValue === null ? fallback : storedValue === "true";
  } catch {
    return fallback;
  }
}

function writeBooleanToLocalStorage(key: string, value: boolean) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(key, value ? "true" : "false");
  } catch {
    // Ignore storage write failures and keep the in-memory UI state.
  }
}

function readNumberFromLocalStorage(key: string, fallback: number) {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const storedValue = window.localStorage.getItem(key);
    if (storedValue === null) {
      return fallback;
    }

    const parsedValue = Number(storedValue);
    return Number.isFinite(parsedValue) ? parsedValue : fallback;
  } catch {
    return fallback;
  }
}

function writeNumberToLocalStorage(key: string, value: number) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Ignore storage write failures and keep the in-memory UI state.
  }
}

function readStringArrayFromLocalStorage(key: string) {
  if (typeof window === "undefined") {
    return [] as string[];
  }

  try {
    const storedValue = window.localStorage.getItem(key);
    if (!storedValue) {
      return [] as string[];
    }

    const parsed = JSON.parse(storedValue) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [] as string[];
  }
}

function writeStringArrayToLocalStorage(key: string, value: string[]) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage write failures and keep the in-memory UI state.
  }
}

function stringArraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function buildMessageHorizontalCenterViewport(input: {
  canvasSize: { width: number; height: number };
  viewport: CanvasViewport;
  targetNode: Pick<Node<MessageNodeData>, "position">;
}): CanvasViewport | null {
  if (input.canvasSize.width <= 0 || input.canvasSize.height <= 0) {
    return null;
  }

  return {
    x: input.canvasSize.width / 2 - (input.targetNode.position.x + messageNodeWidth / 2) * input.viewport.zoom,
    y: input.viewport.y,
    zoom: input.viewport.zoom,
  };
}

function buildBranchEntryViewport(input: {
  canvasSize: { width: number; height: number };
  targetNode: Pick<Node<MessageNodeData>, "position">;
}): CanvasViewport | null {
  if (input.canvasSize.width <= 0 || input.canvasSize.height <= 0) {
    return null;
  }

  const zoom = clamp((input.canvasSize.width * 5) / (7 * messageNodeWidth), canvasMinZoom, canvasMaxZoom);

  return {
    x: input.canvasSize.width / 2 - (input.targetNode.position.x + messageNodeWidth / 2) * zoom,
    y: branchEntryViewportTopGap - input.targetNode.position.y * zoom,
    zoom,
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

function buildAgentAvailabilityLabel(agent: AgentRuntimeOption) {
  if (!agent.installed) {
    return "Not installed";
  }

  if (agent.status !== "online") {
    return "Offline";
  }

  return null;
}

function AgentRuntimeBadge(props: {
  label: string;
  runtimeKind: AgentRuntimeKind | null;
  className?: string;
  iconWrapperClassName?: string;
  labelClassName?: string;
  monochrome?: boolean;
}) {
  const { label, runtimeKind, className, iconWrapperClassName, labelClassName, monochrome = false } = props;
  const iconSrc = runtimeKind ? agentRuntimeIconSources[runtimeKind] ?? null : null;
  const iconTreatment = getAgentIconTreatment(runtimeKind);

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2.5", className)}>
      <span
        aria-hidden="true"
        className={cn(
          "flex size-5 shrink-0 items-center justify-center overflow-hidden",
          iconTreatment.wrapperClassName,
          iconWrapperClassName,
        )}
      >
        {iconSrc ? (
          <img
            alt=""
            className={cn(
              "h-[70%] w-[70%] object-contain",
              iconTreatment.imageClassName,
              monochrome ? "brightness-0 saturate-0" : "",
            )}
            draggable={false}
            src={iconSrc}
          />
        ) : (
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-main)]">
            {buildAgentBadgeMonogram(label)}
          </span>
        )}
      </span>
      <span className={cn("truncate", labelClassName)}>{label}</span>
    </span>
  );
}

function buildAgentBadgeMonogram(label: string) {
  const words = label
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .slice(0, 2);
  const monogram = words.map((part) => part[0]?.toUpperCase() ?? "").join("");

  return monogram || "?";
}

function getAgentIconTreatment(runtimeKind: AgentRuntimeKind | null) {
  switch (runtimeKind) {
    case "codex":
    case "droid":
      return {
        wrapperClassName: "",
        imageClassName: "brightness-0",
      };
    case "claude":
      return {
        wrapperClassName: "",
        imageClassName: "",
      };
    default:
      return {
        wrapperClassName: "",
        imageClassName: "",
      };
  }
}

function buildOptimisticRootStreamTurn(
  snapshot: GraphSnapshot,
  input: {
    prompt: string;
    machineId: string | null;
    runtimeId: string | null;
    runtimeKind: MessageNode["runtimeKind"];
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
      sourcePath: null,
      selectedText: input.selectedText,
      sessionId: null,
      machineId: input.machineId,
      runtimeId: input.runtimeId,
      runtimeKind: input.runtimeKind,
      createdAt,
    } satisfies MessageNode,
    {
      id: assistantMessageId,
      branchId: rootBranchId,
      role: "assistant",
      content: "",
      sourcePath: null,
      selectedText: null,
      sessionId: null,
      machineId: input.machineId,
      runtimeId: input.runtimeId,
      runtimeKind: input.runtimeKind,
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
    responseText: state.responseText,
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
    runtimeId: sourceMessage.runtimeId,
    runtimeKind: sourceMessage.runtimeKind,
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
      sourcePath: null,
      selectedText: input.input.mode === "selection" ? input.input.selectedText ?? null : null,
      sessionId: null,
      machineId: sourceMessage.machineId,
      runtimeId: sourceMessage.runtimeId,
      runtimeKind: sourceMessage.runtimeKind,
      createdAt,
    } satisfies MessageNode,
    {
      id: assistantMessageId,
      branchId,
      role: "assistant",
      content: "",
      sourcePath: null,
      selectedText: null,
      sessionId: null,
      machineId: sourceMessage.machineId,
      runtimeId: sourceMessage.runtimeId,
      runtimeKind: sourceMessage.runtimeKind,
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
    machineId: string | null;
    runtimeId: string | null;
    runtimeKind: MessageNode["runtimeKind"];
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
      sourcePath: null,
      selectedText: input.selectedText,
      sessionId: null,
      machineId: input.machineId,
      runtimeId: input.runtimeId,
      runtimeKind: input.runtimeKind,
      createdAt,
    } satisfies MessageNode,
    {
      id: assistantMessageId,
      branchId: input.branchId,
      role: "assistant",
      content: "",
      sourcePath: null,
      selectedText: null,
      sessionId: null,
      machineId: input.machineId,
      runtimeId: input.runtimeId,
      runtimeKind: input.runtimeKind,
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
  machineId: string | null;
  runtimeId: string | null;
  runtimeKind: MessageNode["runtimeKind"];
  selectedText: string | null;
  snapshot: GraphSnapshot | undefined;
}): PendingTurnMetadata {
  return buildOptimisticRootStreamTurn(input.snapshot ?? createEmptyRootSnapshot(), {
    prompt: input.prompt,
    machineId: input.machineId,
    runtimeId: input.runtimeId,
    runtimeKind: input.runtimeKind,
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
        runtimeId: null,
        runtimeKind: null,
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

function formatNetAgeLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "0m";
  }

  const diffMs = Math.max(0, Date.now() - date.getTime());
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 60) {
    return `${Math.max(0, diffMinutes)}m`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) {
    return `${diffDays}d`;
  }

  const diffMonths = Math.floor(diffDays / 30);
  return `${Math.max(1, diffMonths)}mo`;
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

function buildWorkspacePathQueryString(path: string) {
  const params = new URLSearchParams();
  if (path) {
    params.set("path", path);
  }

  const query = params.toString();
  return query ? `?${query}` : "";
}

function formatWorkspaceFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function splitWorkspaceFileContentLines(content: string) {
  if (!content) {
    return [];
  }

  return content.replace(/\r\n/g, "\n").split("\n");
}

function isMarkdownFilePath(filePath: string) {
  const normalizedPath = filePath.trim().toLowerCase();
  return normalizedPath.endsWith(".md") || normalizedPath.endsWith(".markdown");
}

function resolveWorkspacePaneLayout(input: {
  isDesktop: boolean;
  hostWidth: number;
  totalWidth: number;
  explorerWidth: number;
  hasFilePreview: boolean;
}) {
  if (!input.isDesktop) {
    return {
      totalWidth: 0,
      explorerWidth: 0,
      fileWidth: 0,
    };
  }

  const minimumTotalWidth = input.hasFilePreview
    ? desktopWorkspaceExplorerMinWidth + desktopWorkspaceFilePreviewMinWidth
    : desktopWorkspaceExplorerMinWidth;
  const maximumTotalWidth = Math.max(
    minimumTotalWidth,
    Math.min(
      Math.max(minimumTotalWidth, input.hostWidth - desktopWorkspacePanelsMinCanvasWidth),
      Math.floor(input.hostWidth * desktopWorkspacePanelsMaxWidthRatio),
    ),
  );
  const totalWidth = clampNumber(input.totalWidth, minimumTotalWidth, maximumTotalWidth);
  const maximumExplorerWidth = input.hasFilePreview ? totalWidth - desktopWorkspaceFilePreviewMinWidth : totalWidth;
  const explorerWidth = clampNumber(input.explorerWidth, desktopWorkspaceExplorerMinWidth, maximumExplorerWidth);

  return {
    totalWidth,
    explorerWidth,
    fileWidth: input.hasFilePreview ? Math.max(0, totalWidth - explorerWidth) : 0,
  };
}

function clampNumber(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
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
