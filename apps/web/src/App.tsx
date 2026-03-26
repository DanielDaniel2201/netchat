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

type ChildSelection = {
  branchId: string;
  selectedText: string;
  startOffset: number | null;
  endOffset: number | null;
  isActive: boolean;
};

type MessageNodeData = {
  message: MessageNode;
  isActiveBranch: boolean;
  childSelections: ChildSelection[];
  onPickBranch: (branchId: string) => void;
  onSelectionDraft: (draft: SelectionMenu) => void;
};

type PositionedBranch = {
  x: number;
  y: number;
  direction: BranchDirection;
};

const useComposerStore = create<{
  selectedBranchId: string;
  setSelectedBranchId: (branchId: string) => void;
}>((set) => ({
  selectedBranchId: rootBranchId,
  setSelectedBranchId: (selectedBranchId) => set({ selectedBranchId }),
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
  const selectedBranchId = useComposerStore((state) => state.selectedBranchId);
  const setSelectedBranchId = useComposerStore((state) => state.setSelectedBranchId);
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
  const activeBranch = snapshot?.branches.find((branch) => branch.id === selectedBranchId) ?? null;
  const machinesById = useMemo(() => new Map(machines.map((machine) => [machine.id, machine])), [machines]);
  const activeBranchMachine =
    activeBranch?.machineId ? (machinesById.get(activeBranch.machineId) ?? undefined) : undefined;
  const rootMachine = onlineMachines[0];
  const runtimeMachine =
    activeBranch && activeBranch.id !== rootBranchId ? activeBranchMachine : rootMachine;

  const messagesByBranch = useMemo(() => {
    const buckets = new Map<string, MessageNode[]>();
    for (const message of snapshot?.messages ?? []) {
      const branchMessages = buckets.get(message.branchId) ?? [];
      branchMessages.push(message);
      buckets.set(message.branchId, branchMessages);
    }
    return buckets;
  }, [snapshot]);

  const activeBranchMessages = activeBranch ? messagesByBranch.get(activeBranch.id) ?? [] : [];
  const activeBranchHasMessages = activeBranchMessages.length > 0;
  const canSendOnActiveLane =
    activeBranch && activeBranch.id !== rootBranchId
      ? runtimeMachine?.status === "online"
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
      setSelectedBranchId(rootBranchId);
    },
    onError: (error) => {
      logWeb("error", `Root turn failed: ${formatErrorMessage(error) ?? "Unknown error"}`);
    },
  });

  const branchMutation = useMutation({
    mutationFn: async (input: CreateBranchInput) => {
      logWeb(
        "info",
        `Forking from message ${input.sourceMessageId} with ${input.selectedText.length} selected chars and ${input.prompt.length} prompt chars.`,
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
      const newestBranch = nextSnapshot.branches.at(-1);
      if (newestBranch) {
        setSelectedBranchId(newestBranch.id);
      }
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

  function pickBranch(branchId: string) {
    setSelectedBranchId(branchId);
    window.setTimeout(() => {
      composerRef.current?.focus();
    }, 0);
  }

  const graph = useMemo(() => {
    if (!snapshot) {
      return { nodes: [], edges: [] };
    }

    return buildFlowGraph({
      snapshot,
      selectedBranchId,
      onPickBranch: pickBranch,
      onSelectionDraft: setSelectionMenu,
    });
  }, [selectedBranchId, snapshot]);

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

    if (!activeBranch || activeBranch.id === rootBranchId) {
      rootTurnMutation.mutate({ prompt, machineId: rootMachine?.id });
      return;
    }

    branchTurnMutation.mutate({
      branchId: activeBranch.id,
      input: { prompt },
    });
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    submitCurrentPrompt();
  }

  const composerBadge = activeBranch && activeBranch.id !== rootBranchId ? "Branch" : "Main";
  const composerLabel =
    activeBranch && activeBranch.id !== rootBranchId
      ? truncate(activeBranch.title, 48)
      : activeBranchHasMessages
        ? "Continue the main explanation"
        : "Start the main explanation";
  const composerContext =
    activeBranch && activeBranch.id !== rootBranchId && activeBranch.selectedText
      ? `Forked from "${truncate(activeBranch.selectedText, 78)}"`
      : rootMachine
        ? `Root turns route through ${rootMachine.name}`
        : "Pair a local daemon so the app can use the user's own Claude Code runtime.";
  const composerPlaceholder =
    activeBranch && activeBranch.id !== rootBranchId
      ? runtimeMachine?.status === "online"
        ? "Continue this branch..."
        : "Bring this branch's machine back online to continue..."
      : !rootMachine
        ? "Bring one local daemon online first..."
      : activeBranchHasMessages
        ? "Continue the main conversation..."
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
      ? `Routing this lane through ${runtimeMachine.name}.`
      : `This lane belongs to ${runtimeMachine.name}, which is currently offline.`
    : buildDaemonSummary(daemonDiagnostics, daemonDiagnosticsQuery.error);
  const footerMessage = isThinking
    ? "Claude is writing the next message bubble..."
    : runtimeMachine
      ? runtimeMachine.status === "online"
        ? `Active lane: ${runtimeMachine.name} on ${formatPlatform(runtimeMachine.environment.platform)}.`
        : `Selected lane paused until ${runtimeMachine.name} reconnects.`
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

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#f3f5f9] text-slate-950">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.96),rgba(243,245,249,0.84)_42%,rgba(243,245,249,0.96)_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(148,163,184,0.12),transparent_34%),radial-gradient(circle_at_top_right,rgba(15,23,42,0.08),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.4),rgba(243,245,249,0))]" />

      {selectionMenu ? (
        <button
          type="button"
          disabled={branchMutation.isPending}
          className="fixed z-30 -translate-x-1/2 -translate-y-full rounded-full border border-slate-950/10 bg-slate-950 px-3 py-1.5 text-xs font-medium text-white shadow-[0_18px_45px_-18px_rgba(15,23,42,0.55)] transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-700"
          style={{
            top: Math.max(selectionMenu.top - 12, 16),
            left: selectionMenu.left,
          }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() =>
            branchMutation.mutate({
              sourceMessageId: selectionMenu.sourceMessageId,
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
        </button>
      ) : null}

      <div className="pointer-events-none absolute left-5 top-5 z-20 max-w-[420px]">
        <div className="pointer-events-auto rounded-[24px] border border-white/70 bg-white/76 px-4 py-3 shadow-[0_28px_70px_-42px_rgba(15,23,42,0.32)] backdrop-blur-xl">
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
        <div className="pointer-events-auto rounded-[24px] border border-white/70 bg-white/76 px-4 py-3 shadow-[0_28px_70px_-42px_rgba(15,23,42,0.32)] backdrop-blur-xl">
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
          <div className="pointer-events-auto rounded-[24px] border border-white/70 bg-white/80 p-4 shadow-[0_28px_70px_-42px_rgba(15,23,42,0.32)] backdrop-blur-xl">
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
          <div className="max-w-xl rounded-[28px] border border-white/80 bg-white/76 px-6 py-5 shadow-[0_35px_90px_-48px_rgba(15,23,42,0.35)] backdrop-blur-xl">
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
          className="pointer-events-auto w-full max-w-[920px] rounded-[30px] border border-white/75 bg-[rgba(255,255,255,0.8)] p-4 shadow-[0_35px_90px_-48px_rgba(15,23,42,0.4)] backdrop-blur-xl"
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
                ? "Click any bubble to continue that lane."
                : "Lane selection stays local to the canvas."}
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
              Clear selection
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
        "group relative overflow-hidden border bg-white/78 px-5 py-4 text-left shadow-[0_28px_70px_-44px_rgba(15,23,42,0.35)] backdrop-blur-xl transition-all",
        isUser ? "w-[320px] rounded-[26px]" : "w-[468px] rounded-[30px]",
        data.isActiveBranch
          ? "border-slate-950 shadow-[0_34px_90px_-46px_rgba(15,23,42,0.46)]"
          : "border-slate-200/80 hover:-translate-y-0.5 hover:border-slate-300",
      )}
      onClick={() => data.onPickBranch(data.message.branchId)}
    >
      <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-slate-900/12 to-transparent" />

      <div className="mb-3 flex items-center justify-between gap-4">
        <div className="inline-flex rounded-full border border-slate-200/80 bg-white/90 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          {roleLabel}
        </div>
        <div className="font-mono text-[11px] text-slate-400">
          {formatMessageTime(data.message.createdAt)}
        </div>
      </div>

      <SelectableMessage
        content={data.message.content}
        disabled={isUser}
        childSelections={data.childSelections}
        onSelection={(draft) => data.onSelectionDraft({ ...draft, sourceMessageId: data.message.id })}
      />

      {!isUser ? (
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-200/70 pt-3">
          <div className="text-xs leading-5 text-slate-500">
            {data.childSelections.length > 0
              ? `${data.childSelections.length} ${data.childSelections.length === 1 ? "branch" : "branches"} fork from this reply.`
              : "Select a phrase in this reply to branch deeper."}
          </div>
          <div
            className={cn(
              "rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]",
              data.isActiveBranch
                ? "border-slate-950 bg-slate-950 text-white"
                : "border-slate-200 bg-white text-slate-500",
            )}
          >
            {data.isActiveBranch ? "Active lane" : "Click to continue"}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SelectableMessage({
  content,
  disabled,
  childSelections,
  onSelection,
}: {
  content: string;
  disabled: boolean;
  childSelections: ChildSelection[];
  onSelection: (draft: Omit<SelectionMenu, "sourceMessageId">) => void;
}) {
  const segments = buildHighlightedSegments(content, childSelections);

  return (
    <div
      className={cn(
        "whitespace-pre-wrap text-[15px] leading-7 text-slate-700 selection:bg-slate-900/12 selection:text-slate-950",
        disabled ? "cursor-default" : "cursor-text",
      )}
      onMouseUp={(event) => {
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
      {segments.map((segment, index) => (
        <span
          key={`${segment.start}-${segment.end}-${index}`}
          className={
            segment.highlighted
              ? cn(
                  "rounded-[10px] px-1.5 py-0.5",
                  segment.active
                    ? "bg-slate-950 text-white shadow-[0_8px_24px_-14px_rgba(15,23,42,0.8)]"
                    : "bg-slate-100 text-slate-950 ring-1 ring-slate-200",
                )
              : undefined
          }
        >
          {segment.text}
        </span>
      ))}
    </div>
  );
}

function buildFlowGraph({
  snapshot,
  selectedBranchId,
  onPickBranch,
  onSelectionDraft,
}: {
  snapshot: GraphSnapshot;
  selectedBranchId: string;
  onPickBranch: (branchId: string) => void;
  onSelectionDraft: (draft: SelectionMenu) => void;
}) {
  const nodes: Node[] = [];
  const edges: Edge[] = snapshot.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "smoothstep",
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: edge.kind === "fork" ? "#475569" : "#94a3b8",
    },
    style: {
      stroke: edge.kind === "fork" ? "#475569" : "#94a3b8",
      strokeDasharray: edge.kind === "fork" ? "8 8" : undefined,
      strokeWidth: edge.kind === "fork" ? 1.5 : 1.15,
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

      const childBranches = childBranchesBySource.get(message.id) ?? [];
      const childSelections = childBranches.map((childBranch) => ({
        branchId: childBranch.id,
        selectedText: childBranch.selectedText ?? childBranch.title,
        startOffset: childBranch.startOffset,
        endOffset: childBranch.endOffset,
        isActive: childBranch.id === selectedBranchId,
      }));

      nodes.push({
        id: message.id,
        type: "message",
        position: { x: messageX, y: messageY },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        data: {
          message,
          isActiveBranch: branch.id === selectedBranchId,
          childSelections,
          onPickBranch,
          onSelectionDraft,
        } satisfies MessageNodeData,
      });

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

function buildHighlightedSegments(content: string, childSelections: ChildSelection[]) {
  const ranges = childSelections
    .map((selection) => {
      if (
        typeof selection.startOffset === "number" &&
        typeof selection.endOffset === "number" &&
        selection.startOffset >= 0 &&
        selection.endOffset > selection.startOffset &&
        selection.endOffset <= content.length
      ) {
        return {
          start: selection.startOffset,
          end: selection.endOffset,
          active: selection.isActive,
        };
      }

      const fallbackIndex = content.indexOf(selection.selectedText);
      if (fallbackIndex < 0) {
        return null;
      }

      return {
        start: fallbackIndex,
        end: fallbackIndex + selection.selectedText.length,
        active: selection.isActive,
      };
    })
    .filter((range): range is { start: number; end: number; active: boolean } => Boolean(range))
    .sort((left, right) => left.start - right.start || Number(right.active) - Number(left.active));

  const nonOverlapping: Array<{ start: number; end: number; active: boolean }> = [];
  let currentEnd = -1;

  for (const range of ranges) {
    if (range.start >= currentEnd) {
      nonOverlapping.push(range);
      currentEnd = range.end;
    }
  }

  const segments: Array<{
    active: boolean;
    end: number;
    highlighted: boolean;
    start: number;
    text: string;
  }> = [];

  let cursor = 0;
  for (const range of nonOverlapping) {
    if (range.start > cursor) {
      segments.push({
        active: false,
        end: range.start,
        highlighted: false,
        start: cursor,
        text: content.slice(cursor, range.start),
      });
    }

    segments.push({
      active: range.active,
      end: range.end,
      highlighted: true,
      start: range.start,
      text: content.slice(range.start, range.end),
    });
    cursor = range.end;
  }

  if (cursor < content.length) {
    segments.push({
      active: false,
      end: content.length,
      highlighted: false,
      start: cursor,
      text: content.slice(cursor),
    });
  }

  return segments;
}

function clearBrowserSelection() {
  window.getSelection()?.removeAllRanges();
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
