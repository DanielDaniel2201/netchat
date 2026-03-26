import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Edge,
  MarkerType,
  Node,
  NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, LoaderCircle } from "lucide-react";
import {
  Branch,
  DaemonDiagnostics,
  CreateBranchInput,
  CreateBranchTurnInput,
  CreateRootTurnInput,
  GraphSnapshot,
  HostPlatform,
  MachineRecord,
  MessageNode,
  PairingSession,
  rootBranchId,
} from "@netchat/shared";
import { create } from "zustand";

import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { cn } from "./lib/cn";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3001";
const daemonBaseUrl = import.meta.env.VITE_DAEMON_BASE_URL ?? "http://127.0.0.1:4318";
const branchMessageGap = 184;
const branchLaneWidth = 560;
const branchDrop = 312;
const webLogPrefix = "[netchat-web]";

type SelectionDraft = {
  sourceMessageId: string;
  selectedText: string;
  startOffset: number;
  endOffset: number;
};

type SelectionMenu = SelectionDraft & {
  top: number;
  left: number;
};

type BranchDirection = "center" | "left" | "right" | "down";

type MessageNodeData = {
  message: MessageNode;
  isActiveMessage: boolean;
  onPickMessage: (messageId: string) => void;
  onSelectionDraft: (draft: SelectionMenu) => void;
};

type PositionedBranch = {
  x: number;
  y: number;
  direction: BranchDirection;
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
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const selectedMessageId = useComposerStore((state) => state.selectedMessageId);
  const setSelectedMessageId = useComposerStore((state) => state.setSelectedMessageId);
  const [composerValue, setComposerValue] = useState("");
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenu | null>(null);

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
  const selectedMessageIsTail = selectedMessage
    ? selectedBranchMessages.at(-1)?.id === selectedMessage.id
    : true;
  const selectedBranchMachine =
    selectedBranch?.machineId ? (machinesById.get(selectedBranch.machineId) ?? undefined) : undefined;
  const selectedMessageMachine =
    selectedMessage?.machineId ? (machinesById.get(selectedMessage.machineId) ?? undefined) : undefined;
  const sendMode: "root" | "continue-root" | "continue-branch" | "branch-from-message" =
    !selectedMessage
      ? "root"
      : !selectedMessageIsTail
        ? "branch-from-message"
        : selectedBranch?.id === rootBranchId
          ? "continue-root"
          : "continue-branch";
  const runtimeMachine =
    sendMode === "branch-from-message"
      ? selectedMessageMachine
      : sendMode === "continue-branch"
        ? selectedBranchMachine ?? selectedMessageMachine
        : rootMachine;
  const canSendOnActiveLane =
    sendMode === "branch-from-message" || sendMode === "continue-branch"
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
      setSelectedMessageId(getLatestAssistantMessageId(nextSnapshot));
      setSelectionMenu(null);
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
      setSelectedMessageId(getLatestAssistantMessageId(nextSnapshot));
    },
    onError: (error) => {
      logWeb("error", `Branch turn failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
    },
  });
  const pairingMutation = useMutation({
    mutationFn: async () => {
      logWeb("info", "Requesting a new daemon pairing code.");
      return request<PairingSession>("/api/machines/pairing-sessions", {
        method: "POST",
        body: JSON.stringify({
          label: "Local daemon",
        }),
      });
    },
    onSuccess: (session) => {
      logWeb("info", `Generated pairing code ${session.pairingCode} (expires ${session.expiresAt}).`);
    },
    onError: (error) => {
      logWeb("error", `Pairing code generation failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
    },
  });

  const isThinking =
    rootTurnMutation.isPending || branchMutation.isPending || branchTurnMutation.isPending;

  function focusComposer() {
    composerRef.current?.focus();
  }

  function pickMessage(messageId: string) {
    setSelectedMessageId(messageId);
  }

  const graph = useMemo(() => {
    if (!snapshot) {
      return { nodes: [], edges: [] };
    }

    return buildFlowGraph({
      snapshot,
      selectedMessageId,
      onPickMessage: pickMessage,
      onSelectionDraft: setSelectionMenu,
    });
  }, [selectedMessageId, snapshot]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    const latestAssistantMessageId = getLatestAssistantMessageId(snapshot);

    if (snapshot.messages.length === 0 || !latestAssistantMessageId) {
      if (selectedMessageId !== null) {
        setSelectedMessageId(null);
      }
      return;
    }

    if (
      selectedMessageId &&
      snapshot.messages.some((message) => message.id === selectedMessageId && message.role === "assistant")
    ) {
      return;
    }

    setSelectedMessageId(latestAssistantMessageId);
  }, [selectedMessageId, setSelectedMessageId, snapshot]);

  useEffect(() => {
    function onSelectionChange() {
      const selection = window.getSelection();
      if (!selection || selection.toString().trim().length > 0) {
        return;
      }

      setSelectionMenu(null);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectionMenu(null);
        clearBrowserSelection();
      }
    }

    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

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

  const selectedMessagePreview = selectedMessage ? summarizeMessage(selectedMessage.content) : null;
  const composerBadge =
    sendMode === "branch-from-message" ? "Branch" : snapshot?.messages.length ? "Continue" : "Start";
  const composerLabel =
    sendMode === "branch-from-message"
      ? "Next send forks from the selected bubble"
      : selectedMessage
        ? "Next send appends after the selected bubble"
        : "Start the main conversation";
  const composerContext = selectedMessage
    ? `${selectedMessage.role === "assistant" ? "Claude Code" : "You"} · ${formatMessageTime(selectedMessage.createdAt)} · ${truncate(selectedMessagePreview ?? "", 92)}`
    : rootMachine
      ? `Root turns route through ${rootMachine.name}.`
      : "Pair a local daemon so the app can use the user's own Claude Code runtime.";
  const composerPlaceholder =
    sendMode === "branch-from-message"
      ? runtimeMachine?.status === "online"
        ? "Branch from the selected bubble..."
        : "Bring this bubble's machine back online to branch here..."
      : sendMode === "continue-branch"
        ? runtimeMachine?.status === "online"
          ? "Continue after the selected bubble..."
          : "Bring this branch's machine back online to continue..."
        : !rootMachine
          ? "Bring one local daemon online first..."
          : snapshot?.messages.length
            ? "Continue after the selected bubble..."
            : "Start the walkthrough...";
  const composerErrorMessage = formatErrorMessage(
    rootTurnMutation.error ?? branchMutation.error ?? branchTurnMutation.error,
  );
  const workingDirectoryHint = processPathHint(
    runtimeMachine?.environment.workingDirectory ??
      daemonDiagnostics?.environment.workingDirectory ??
      "Waiting for local runtime",
  );
  const machineHeading = runtimeMachine
    ? runtimeMachine.name
    : daemonDiagnosticsQuery.isSuccess
      ? "Local daemon detected"
      : "No machine online";
  const machineBadges = buildRuntimeBadges(runtimeMachine, onlineMachines.length, daemonDiagnostics);
  const machineDescription = runtimeMachine
    ? runtimeMachine.status === "online"
      ? sendMode === "branch-from-message"
        ? `The next send will fork a new branch from the selected bubble on ${runtimeMachine.name}.`
        : `The next send will continue the selected lane on ${runtimeMachine.name}.`
      : sendMode === "branch-from-message"
        ? `The selected bubble belongs to ${runtimeMachine.name}, which is currently offline, so branching is paused.`
        : `The selected lane belongs to ${runtimeMachine.name}, which is currently offline.`
    : buildDaemonSummary(daemonDiagnostics, daemonDiagnosticsQuery.error);
  const footerMessage = isThinking
    ? "Claude is writing the next message bubble..."
    : selectedMessage
      ? sendMode === "branch-from-message"
        ? "The selected bubble sits in the middle of a lane, so the next send creates an alternate path."
        : "The selected bubble is the end of its lane, so the next send continues it."
      : runtimeMachine
        ? runtimeMachine.status === "online"
          ? `Ready on ${runtimeMachine.name} (${formatPlatform(runtimeMachine.environment.platform)}).`
          : `Waiting for ${runtimeMachine.name} to reconnect.`
      : daemonDiagnosticsQuery.isSuccess
        ? "Local daemon reachable, but no machine is registered with the server yet."
        : "No local runtime paired yet.";
  const daemonLogs = daemonDiagnostics?.logs.slice(0, 6) ?? [];
  const pairingCommand = pairingMutation.data
    ? buildPairingCommand({
        pairingCode: pairingMutation.data.pairingCode,
        serverUrl: apiBaseUrl,
      })
    : null;
  const selectionToolbarPosition = selectionMenu ? resolveSelectionToolbarPosition(selectionMenu) : null;

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#f5f4ef] text-slate-950">
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(245,244,239,1))]" />

      {selectionMenu && selectionToolbarPosition ? (
        <div
          className="fixed z-30 -translate-x-1/2 -translate-y-[calc(100%+10px)]"
          style={selectionToolbarPosition}
          onMouseDown={(event) => event.preventDefault()}
        >
          <div className="selection-toolbar inline-flex max-w-[min(70vw,420px)] items-center gap-2 rounded-full border border-slate-950 bg-[#fffdf7] px-2 py-2 shadow-[0_14px_28px_-22px_rgba(15,23,42,0.35)]">
            <div className="max-w-[220px] truncate rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-500">
              {truncate(selectionMenu.selectedText, 42)}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={branchMutation.isPending}
              className="nodrag nopan border-slate-950 bg-slate-950 text-white shadow-none hover:bg-slate-800"
              onClick={() =>
                branchMutation.mutate({
                  sourceMessageId: selectionMenu.sourceMessageId,
                  mode: "selection",
                  selectedText: selectionMenu.selectedText,
                  startOffset: selectionMenu.startOffset,
                  endOffset: selectionMenu.endOffset,
                  prompt: "",
                })
              }
            >
              {branchMutation.isPending ? (
                <span className="inline-flex items-center gap-2">
                  <LoaderCircle className="size-3 animate-spin" />
                  Asking...
                </span>
              ) : (
                "Ask more"
              )}
            </Button>
            <button
              type="button"
              className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500 transition-colors hover:border-slate-950 hover:text-slate-950"
              onClick={() => {
                setSelectionMenu(null);
                clearBrowserSelection();
              }}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none absolute left-5 top-5 z-20 max-w-[420px]">
        <div className="pointer-events-auto rounded-[22px] border border-slate-300 bg-[#fffdf8] px-4 py-3 shadow-[0_12px_24px_-20px_rgba(15,23,42,0.14)]">
          <div className="flex items-center gap-2">
            <div className="rounded-full border border-slate-200/80 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-500">
              netchat
            </div>
            <div className="text-xs text-slate-500">canvas-first local runtime routing</div>
          </div>
          <div className="mt-3 text-[11px] uppercase tracking-[0.24em] text-slate-400">
            Working directory
          </div>
          <div className="mt-1 font-mono text-sm text-slate-700">{workingDirectoryHint}</div>
        </div>
      </div>

      <ReactFlow
        className="netchat-flow canvas-flow"
        fitView
        fitViewOptions={{ padding: 0.24, minZoom: 0.45, maxZoom: 1 }}
        nodes={graph.nodes}
        edges={graph.edges}
        onNodeClick={(_event, node) => {
          const message = (node.data as MessageNodeData | undefined)?.message;
          if (message?.role === "assistant") {
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
          setSelectionMenu(null);
          clearBrowserSelection();
        }}
        panOnDrag
        zoomOnDoubleClick={false}
      >
        <Background gap={32} size={1} color="#d5dbe6" />
      </ReactFlow>

      <div className="pointer-events-none absolute right-5 top-5 z-20 max-w-[520px]">
        <div className="pointer-events-auto rounded-[22px] border border-slate-300 bg-[#fffdf8] px-4 py-3 shadow-[0_12px_24px_-20px_rgba(15,23,42,0.14)]">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex size-2.5 rounded-full",
                runtimeMachine
                  ? runtimeMachine.status === "online"
                    ? "bg-emerald-500"
                    : "bg-amber-400"
                  : "bg-slate-300",
              )}
            />
            <div className="text-sm font-medium text-slate-900">{machineHeading}</div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {machineBadges.map((badge) => (
              <span
                key={badge}
                className="inline-flex rounded-full border border-slate-200/80 bg-white/84 px-3 py-1 text-xs font-medium text-slate-600"
              >
                {badge}
              </span>
            ))}
          </div>
          <div className="mt-3 text-xs leading-6 text-slate-500">{machineDescription}</div>
        </div>
      </div>

      {!runtimeMachine || daemonDiagnosticsQuery.isSuccess || daemonDiagnosticsQuery.isError ? (
        <div className="pointer-events-none absolute bottom-40 left-5 z-20 w-[min(440px,calc(100vw-2.5rem))]">
          <div className="pointer-events-auto rounded-[22px] border border-slate-300 bg-[#fffdf8] p-4 shadow-[0_12px_24px_-20px_rgba(15,23,42,0.14)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                  Local daemon
                </div>
                <div className="mt-1 text-sm font-medium text-slate-900">
                  {daemonDiagnosticsQuery.isSuccess ? "Diagnostics available" : "Diagnostics unavailable"}
                </div>
              </div>
              <div
                className={cn(
                  "rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]",
                  daemonDiagnosticsQuery.isSuccess
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-amber-200 bg-amber-50 text-amber-700",
                )}
              >
                {daemonDiagnosticsQuery.isSuccess ? "Reachable" : "Unreachable"}
              </div>
            </div>

            {daemonDiagnosticsQuery.isSuccess ? (
              <>
                <div className="mt-3 flex flex-wrap gap-2">
                  {buildDaemonBadges(daemonDiagnostics!).map((badge) => (
                    <span
                      key={badge}
                      className="inline-flex rounded-full border border-slate-200/80 bg-white px-3 py-1 text-xs font-medium text-slate-600"
                    >
                      {badge}
                    </span>
                  ))}
                </div>

                <div className="mt-3 rounded-[18px] border border-slate-200/80 bg-slate-50/80 px-4 py-3 text-sm leading-6 text-slate-600">
                  {buildDaemonSummary(daemonDiagnostics!, null)}
                  {daemonDiagnostics?.lastError ? (
                    <div className="mt-2 text-rose-600">Last error: {daemonDiagnostics.lastError}</div>
                  ) : null}
                </div>

                <div className="mt-3 rounded-[18px] border border-slate-200/80 bg-white/90 px-4 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                    Recent log
                  </div>
                  <div className="mt-2 space-y-2">
                    {daemonLogs.length > 0 ? (
                      daemonLogs.map((entry) => (
                        <div key={entry.id} className="font-mono text-[12px] leading-5 text-slate-600">
                          <span className="text-slate-400">{formatLogTime(entry.timestamp)}</span>{" "}
                          <span
                            className={cn(
                              entry.level === "error"
                                ? "text-rose-600"
                                : entry.level === "warn"
                                  ? "text-amber-600"
                                  : "text-slate-500",
                            )}
                          >
                            [{entry.level}]
                          </span>{" "}
                          {entry.message}
                        </div>
                      ))
                    ) : (
                      <div className="text-sm text-slate-500">No daemon log entries yet.</div>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="mt-3 rounded-[18px] border border-amber-200 bg-amber-50/90 px-4 py-3 text-sm leading-6 text-amber-700">
                Web could not reach the local daemon at {daemonBaseUrl}. Start or restart
                the daemon process to see runtime detection and registration diagnostics here.
              </div>
            )}

            {!runtimeMachine && !daemonDiagnostics?.localMode ? (
              <div className="mt-3 rounded-[18px] border border-slate-200/80 bg-white/90 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                      Pair local daemon
                    </div>
                    <div className="mt-1 text-sm text-slate-600">
                      Generate a one-time pairing code and restart the daemon with it.
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full"
                    disabled={pairingMutation.isPending}
                    onClick={() => pairingMutation.mutate()}
                  >
                    {pairingMutation.isPending ? "Generating..." : "Generate code"}
                  </Button>
                </div>

                {pairingMutation.data ? (
                  <div className="mt-3 space-y-3">
                    <div className="rounded-[16px] border border-slate-200 bg-slate-50/90 px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                        Pairing code
                      </div>
                      <div className="mt-2 font-mono text-lg font-semibold text-slate-950">
                        {pairingMutation.data.pairingCode}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        Expires at {new Date(pairingMutation.data.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </div>
                      <div className="mt-2 text-xs leading-5 text-slate-500">
                        Codes are tied to the current dev server process. If the server restarts or the code expires, generate a fresh one.
                      </div>
                    </div>

                    <div className="rounded-[16px] border border-slate-200 bg-slate-950 px-4 py-3 text-[12px] leading-6 text-slate-100">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                        PowerShell
                      </div>
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono">
                        {pairingCommand}
                      </pre>
                    </div>
                  </div>
                ) : null}

                {pairingMutation.error ? (
                  <div className="mt-3 text-sm text-rose-600">
                    {formatErrorMessage(pairingMutation.error)}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {!graphQuery.isLoading && (!snapshot || snapshot.messages.length === 0) ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4">
          <div className="max-w-xl rounded-[24px] border border-slate-300 bg-[#fffdf8] px-6 py-5 shadow-[0_16px_30px_-22px_rgba(15,23,42,0.16)]">
            <div className="text-sm font-medium uppercase tracking-[0.28em] text-slate-400">
              Start here
            </div>
            <div className="mt-3 text-3xl font-semibold tracking-[-0.03em] text-slate-950">
              Turn one prompt into a branchable canvas.
            </div>
            <div className="mt-3 text-sm leading-7 text-slate-600">
              Each message becomes a bubble. Select any phrase in an assistant reply, click Ask more,
              and continue that lane without polluting the main thread.
            </div>
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-5">
        <form
          className="pointer-events-auto w-full max-w-[920px] rounded-[26px] border border-slate-300 bg-[#fffdf8] p-4 shadow-[0_18px_34px_-26px_rgba(15,23,42,0.16)]"
          onSubmit={handleSubmit}
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/70 px-1 pb-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex rounded-full border border-slate-200/80 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                  {composerBadge}
                </span>
                <span className="text-sm font-medium text-slate-900">{composerLabel}</span>
              </div>
              <div className="mt-2 text-sm leading-6 text-slate-500">{composerContext}</div>
            </div>
            <div className="text-xs text-slate-500">{footerMessage}</div>
          </div>

          <div className="mt-3 flex items-end gap-3">
            <Textarea
              ref={composerRef}
              className="min-h-[104px] resize-none rounded-[24px] border border-white/90 bg-white/78 px-4 py-3 text-[15px] leading-7 shadow-[inset_0_0_0_1px_rgba(148,163,184,0.14)] focus:border-slate-950 focus:bg-white"
              placeholder={composerPlaceholder}
              value={composerValue}
              onChange={(event) => setComposerValue(event.target.value)}
              onFocus={() => setSelectionMenu(null)}
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
              className="mb-1 h-11 min-w-11 rounded-full bg-slate-950 px-0 shadow-[0_20px_50px_-24px_rgba(15,23,42,0.7)] hover:bg-slate-800"
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
            <div className="mt-3 rounded-[20px] border border-rose-200 bg-rose-50/90 px-4 py-3 text-sm leading-6 text-rose-700">
              {composerErrorMessage}
            </div>
          ) : null}

          <div className="mt-3 flex items-center justify-between gap-3 px-1 text-xs text-slate-500">
            <div>
              {runtimeMachine?.status === "online"
                ? "Click any bubble to choose where the next turn lands."
                : "Bubble selection stays local to the canvas."}
            </div>
            <button
              type="button"
              className="pointer-events-auto rounded-full border border-slate-200/80 bg-white px-3 py-1 transition-colors hover:border-slate-300 hover:text-slate-900"
              onClick={() => {
                setSelectionMenu(null);
                clearBrowserSelection();
                focusComposer();
              }}
            >
              Clear text selection
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function MessageGraphNode({ data }: NodeProps<Node<MessageNodeData>>) {
  const isUser = data.message.role === "user";
  const roleLabel = isUser ? "You" : "Claude Code";

  return (
    <div
      className={cn(
        "group relative w-[476px] overflow-hidden rounded-[28px] border px-5 py-4 text-left shadow-[0_12px_26px_-22px_rgba(15,23,42,0.14)] transition-all",
        isUser
          ? "border-slate-300/90 bg-[#fffefb]"
          : data.isActiveMessage
            ? "border-slate-950 bg-[#fff7fb] shadow-[0_22px_40px_-28px_rgba(15,23,42,0.28)] ring-1 ring-slate-950/10"
            : "border-[#efcfda] bg-[#fffafd] hover:border-[#e5b8cb]",
      )}
      onClickCapture={(event) => {
        if (!isUser) {
          data.onPickMessage(data.message.id);
        }
        event.stopPropagation();
      }}
      onMouseDownCapture={(event) => {
        if (!isUser) {
          data.onPickMessage(data.message.id);
        }
        event.stopPropagation();
      }}
      onPointerDownCapture={(event) => {
        if (!isUser) {
          data.onPickMessage(data.message.id);
        }
        event.stopPropagation();
      }}
    >
      <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-slate-900/10 to-transparent" />

      <div className="mb-3 flex items-center justify-between gap-4">
        <div className="inline-flex rounded-full border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
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
  onSelection: (draft: Omit<SelectionMenu, "sourceMessageId">) => void;
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
        const rect = range.getBoundingClientRect();

        onSelection({
          selectedText,
          startOffset,
          endOffset,
          top: rect.top,
          left: rect.left + rect.width / 2,
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
  onPickMessage,
  onSelectionDraft,
}: {
  snapshot: GraphSnapshot;
  selectedMessageId: string | null;
  onPickMessage: (messageId: string) => void;
  onSelectionDraft: (draft: SelectionMenu) => void;
}) {
  const activeEdgeIds = getActiveEdgeIds(snapshot, selectedMessageId);
  const nodes: Node[] = [];
  const edges: Edge[] = snapshot.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "smoothstep",
    zIndex: activeEdgeIds.has(edge.id) ? 5 : 1,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: activeEdgeIds.has(edge.id)
        ? "#0f172a"
        : edge.kind === "fork"
          ? "#94a3b8"
          : "#cbd5e1",
    },
    style: {
      stroke: activeEdgeIds.has(edge.id)
        ? "#0f172a"
        : edge.kind === "fork"
          ? "#94a3b8"
          : "#cbd5e1",
      strokeDasharray: edge.kind === "fork" ? "8 8" : undefined,
      strokeWidth: activeEdgeIds.has(edge.id) ? 2.15 : edge.kind === "fork" ? 1.5 : 1.15,
      opacity: activeEdgeIds.has(edge.id) ? 1 : edge.kind === "fork" ? 0.8 : 0.48,
    },
  }));

  const branchesById = new Map<string, Branch>();
  const messagesByBranch = new Map<string, MessageNode[]>();
  const childBranchesBySource = new Map<string, Branch[]>();

  for (const branch of snapshot.branches) {
    branchesById.set(branch.id, branch);
    if (branch.sourceMessageId) {
      const children = childBranchesBySource.get(branch.sourceMessageId) ?? [];
      children.push(branch);
      childBranchesBySource.set(branch.sourceMessageId, children);
    }
  }

  for (const message of snapshot.messages) {
    const branchMessages = messagesByBranch.get(message.branchId) ?? [];
    branchMessages.push(message);
    messagesByBranch.set(message.branchId, branchMessages);
  }

  const rootBranch = branchesById.get(rootBranchId);
  if (!rootBranch) {
    return { nodes, edges };
  }

  placeBranch(rootBranch, { x: 0, y: 0, direction: "center" });
  return { nodes, edges };

  function placeBranch(branch: Branch, placement: PositionedBranch) {
    const messages = messagesByBranch.get(branch.id) ?? [];

    messages.forEach((message, index) => {
      const messageX = placement.x;
      const messageY = placement.y + index * branchMessageGap;

      nodes.push({
        id: message.id,
        type: "message",
        className: cn(
          "message-node-shell nopan",
          message.role === "assistant" ? "message-node-shell--assistant" : "message-node-shell--user",
        ),
        position: { x: messageX, y: messageY },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        data: {
          message,
          isActiveMessage: message.id === selectedMessageId,
          onPickMessage,
          onSelectionDraft,
        } satisfies MessageNodeData,
      });

      const childBranches = childBranchesBySource.get(message.id) ?? [];

      childBranches.forEach((childBranch, childIndex) => {
        placeBranch(childBranch, getChildPlacement(placement, messageX, messageY, childIndex));
      });
    });
  }
}

function getChildPlacement(
  placement: PositionedBranch,
  messageX: number,
  messageY: number,
  childIndex: number,
): PositionedBranch {
  const pattern = getPlacementPattern(placement.direction);
  const slot = pattern[childIndex % pattern.length];
  const tier = Math.floor(childIndex / pattern.length);
  const tierX =
    slot.direction === "left" ? -tier * 120 : slot.direction === "right" ? tier * 120 : 0;
  const tierY = tier * 220;

  return {
    direction: slot.direction,
    x: messageX + slot.dx + tierX,
    y: messageY + slot.dy + tierY,
  };
}

function getPlacementPattern(direction: BranchDirection) {
  switch (direction) {
    case "left":
      return [
        { direction: "left" as const, dx: -branchLaneWidth, dy: 170 },
        { direction: "down" as const, dx: 96, dy: branchDrop },
      ];
    case "right":
      return [
        { direction: "down" as const, dx: -96, dy: branchDrop },
        { direction: "right" as const, dx: branchLaneWidth, dy: 170 },
      ];
    case "down":
      return [
        { direction: "left" as const, dx: -branchLaneWidth, dy: 170 },
        { direction: "right" as const, dx: branchLaneWidth, dy: 170 },
        { direction: "down" as const, dx: 0, dy: branchDrop },
      ];
    case "center":
    default:
      return [
        { direction: "left" as const, dx: -branchLaneWidth, dy: 170 },
        { direction: "down" as const, dx: 0, dy: branchDrop },
        { direction: "right" as const, dx: branchLaneWidth, dy: 170 },
      ];
  }
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

function resolveSelectionToolbarPosition(selectionMenu: SelectionMenu) {
  const viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth;
  const gutter = 120;
  const minLeft = gutter;
  const maxLeft = viewportWidth > 0 ? Math.max(minLeft, viewportWidth - gutter) : selectionMenu.left;

  return {
    top: Math.max(selectionMenu.top - 14, 18),
    left: clamp(selectionMenu.left, minLeft, maxLeft),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function buildRuntimeBadges(
  machine: MachineRecord | undefined,
  onlineCount: number,
  daemonDiagnostics?: DaemonDiagnostics,
) {
  if (!machine) {
    if (daemonDiagnostics) {
      return buildDaemonBadges(daemonDiagnostics);
    }

    return ["Waiting for daemon", "User-local runtime", `${onlineCount} online`];
  }

  const onlineLabel = `${onlineCount} ${onlineCount === 1 ? "machine" : "machines"} online`;
  const statusLabel = machine.status === "online" ? "Online" : "Offline";
  const modeLabel =
    machine.environment.runtimeMode === "claude" ? "Claude Code" : "Mock runtime";
  const claudeLabel = machine.environment.claudeInstalled ? "Claude detected" : "Claude missing";

  return [statusLabel, onlineLabel, formatPlatform(machine.environment.platform), modeLabel, claudeLabel];
}

function buildDaemonBadges(diagnostics: DaemonDiagnostics) {
  const badges = [
    formatDaemonStatus(diagnostics.status),
    `${diagnostics.environment.runtimeMode === "claude" ? "Claude Code" : "Mock runtime"}`,
    diagnostics.environment.claudeInstalled ? "Claude detected" : "Claude missing",
    diagnostics.serverUrl ? "Server linked" : "Server URL missing",
  ];

  badges.push(diagnostics.localMode ? "Local-first mode" : diagnostics.pairingCodeConfigured ? "Pairing code set" : "Pairing code missing");
  return badges;
}

function buildDaemonSummary(diagnostics: DaemonDiagnostics | undefined, error: unknown) {
  if (!diagnostics) {
    if (error instanceof Error && error.message.trim()) {
      return error.message.trim();
    }

    return `The web app cannot reach the local daemon at ${daemonBaseUrl}.`;
  }

  if (!diagnostics.localMode && diagnostics.lastError && /invalid pairing code/i.test(diagnostics.lastError)) {
    return "The pairing code is stale or no longer exists on the current server process. Generate a fresh code and restart the daemon with the new command.";
  }

  if (!diagnostics.serverUrl) {
    return "Claude can be detected locally, but NETCHAT_SERVER_URL is not configured, so the daemon is not trying to register a machine.";
  }

  if (diagnostics.localMode && !diagnostics.machineId) {
    return "The daemon is running in local-first mode and will register itself with the local controller automatically.";
  }

  if (!diagnostics.machineId && !diagnostics.pairingCodeConfigured) {
    return "The daemon can talk to the server, but it has no stored machine identity and no pairing code yet. Generate a pairing code and restart the daemon with it.";
  }

  if (diagnostics.status === "waiting_for_pairing") {
    return "The daemon is waiting for a pairing code before it can register a machine with the server.";
  }

  if (diagnostics.status === "registering") {
    return "The daemon is trying to register this machine with the server.";
  }

  if (diagnostics.lastError) {
    return diagnostics.lastError;
  }

  if (diagnostics.status === "registered" || diagnostics.status === "online") {
    return diagnostics.machineId
      ? `Daemon is registered as ${diagnostics.machineId} and polling the server.`
      : "Daemon is registered and polling the server.";
  }

  return "Daemon diagnostics are available.";
}

function formatDaemonStatus(status: DaemonDiagnostics["status"]) {
  switch (status) {
    case "local_only":
      return "Local only";
    case "waiting_for_pairing":
      return "Waiting for pairing";
    case "registering":
      return "Registering";
    case "registered":
      return "Registered";
    case "online":
      return "Online";
    case "error":
      return "Error";
    case "starting":
    default:
      return "Starting";
  }
}

function formatPlatform(platform: HostPlatform) {
  switch (platform) {
    case "macos":
      return "macOS";
    case "windows":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return "Unknown OS";
  }
}

function formatMessageTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatLogTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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

function processPathHint(value: string) {
  const normalized = value.replace(/\\/g, "/");
  const homeRewritten = normalized.replace(/^[A-Za-z]:\/Users\/[^/]+/i, "~");

  return truncateMiddle(homeRewritten, 46);
}

function getLatestAssistantMessageId(snapshot: GraphSnapshot) {
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    if (snapshot.messages[index]?.role === "assistant") {
      return snapshot.messages[index]!.id;
    }
  }

  return null;
}

function summarizeMessage(value: string) {
  return value.replace(/\s+/g, " ").trim() || "(empty message)";
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

function buildPairingCommand({
  pairingCode,
  serverUrl,
}: {
  pairingCode: string;
  serverUrl: string;
}) {
  return `npx netchat daemon --server ${serverUrl} --pair ${pairingCode}`;
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
