import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  AssistantStreamState,
  Branch,
  CreateBranchInput,
  GraphSnapshot,
  MessageNode,
  RuntimeResponse,
  buildGraphEdges,
  describeBranchCreation,
  makeId,
  nowIso,
  rootBranchId,
} from "@netchat/shared";

type BranchRow = {
  id: string;
  parent_branch_id: string | null;
  source_message_id: string | null;
  session_id: string | null;
  machine_id: string | null;
  title: string;
  selected_text: string | null;
  start_offset: number | null;
  end_offset: number | null;
  created_at: string;
};

type MessageRow = {
  id: string;
  branch_id: string;
  role: MessageNode["role"];
  content: string;
  selected_text: string | null;
  session_id: string | null;
  machine_id: string | null;
  ordinal_in_branch: number;
  created_at: string;
};

type AssistantStateRow = {
  message_id: string;
  state_json: string;
  updated_at: string;
};

export class GraphStore {
  private readonly database: DatabaseSync;
  private readonly databasePath: string;

  constructor(databasePath = resolveGraphDatabasePath()) {
    this.databasePath = databasePath;
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.ensureSchema();
    this.ensureRootBranch();
  }

  getDatabasePath() {
    return this.databasePath;
  }

  dispose() {
    const close = (this.database as unknown as { close?: () => void }).close;
    close?.call(this.database);
  }

  getSnapshot(): GraphSnapshot {
    const branches = this.listBranches();
    const messages = this.listMessages();
    const assistantStates = this.listAssistantStates();

    return {
      branches,
      messages,
      edges: buildGraphEdges({ branches, messages }),
      assistantStates,
    };
  }

  getBranch(branchId: string): Branch | undefined {
    const row = this.database
      .prepare(
        `SELECT id, parent_branch_id, source_message_id, session_id, machine_id, title, selected_text, start_offset, end_offset, created_at
         FROM branches
         WHERE id = ?`,
      )
      .get(branchId) as BranchRow | undefined;

    return row ? mapBranchRow(row) : undefined;
  }

  getMessage(messageId: string): MessageNode | undefined {
    const row = this.database
      .prepare(
        `SELECT id, branch_id, role, content, selected_text, session_id, machine_id, ordinal_in_branch, created_at
         FROM messages
         WHERE id = ?`,
      )
      .get(messageId) as MessageRow | undefined;

    return row ? mapMessageRow(row) : undefined;
  }

  getVisiblePathToMessage(messageId: string): MessageNode[] {
    const sourceMessage = this.getMessage(messageId);
    if (!sourceMessage) {
      throw new Error(`Unknown source message: ${messageId}`);
    }

    const branches = this.listBranches();
    const messages = this.listMessages();
    const branchesById = new Map(branches.map((branch) => [branch.id, branch]));
    const messagesByBranch = new Map<string, MessageNode[]>();

    for (const message of messages) {
      const branchMessages = messagesByBranch.get(message.branchId) ?? [];
      branchMessages.push(message);
      messagesByBranch.set(message.branchId, branchMessages);
    }

    const lineage: Branch[] = [];
    let currentBranchId: string | null = sourceMessage.branchId;

    while (currentBranchId) {
      const branch = branchesById.get(currentBranchId);
      if (!branch) {
        throw new Error(`Branch lineage is missing branch ${currentBranchId}.`);
      }

      lineage.push(branch);
      currentBranchId = branch.parentBranchId;
    }

    lineage.reverse();

    const stopMessageIds = new Map<string, string>();
    stopMessageIds.set(sourceMessage.branchId, sourceMessage.id);

    for (let index = 1; index < lineage.length; index += 1) {
      const parentBranch = lineage[index - 1];
      const childBranch = lineage[index];
      if (!childBranch.sourceMessageId) {
        throw new Error(`Branch ${childBranch.id} is missing a source message id.`);
      }

      stopMessageIds.set(parentBranch.id, childBranch.sourceMessageId);
    }

    const visibleMessages: MessageNode[] = [];

    for (const branch of lineage) {
      const branchMessages = messagesByBranch.get(branch.id) ?? [];
      const stopMessageId = stopMessageIds.get(branch.id);

      if (!stopMessageId) {
        throw new Error(`Could not determine where branch ${branch.id} should stop.`);
      }

      let reachedStopMessage = false;
      for (const message of branchMessages) {
        visibleMessages.push(message);
        if (message.id === stopMessageId) {
          reachedStopMessage = true;
          break;
        }
      }

      if (!reachedStopMessage) {
        throw new Error(`Could not find stop message ${stopMessageId} in branch ${branch.id}.`);
      }
    }

    return visibleMessages;
  }

  applyRootTurn(
    prompt: string,
    runtime: RuntimeResponse,
    options?: {
      userMessageId?: string;
      assistantMessageId?: string;
      assistantState?: AssistantStreamState;
      selectedText?: string | null;
    },
  ): GraphSnapshot {
    this.runInTransaction(() => {
      const branch = this.ensureRootBranch();
      const userMessageId = options?.userMessageId ?? makeId("msg");
      const assistantMessageId = options?.assistantMessageId ?? makeId("msg");
      this.database
        .prepare(
          `UPDATE branches
           SET session_id = ?, machine_id = ?, title = ?
           WHERE id = ?`,
        )
        .run(runtime.sessionId, runtime.machineId, "Root session", branch.id);

      const nextOrdinal = this.getNextMessageOrdinal(branch.id);
      this.insertMessage({
        id: userMessageId,
        branchId: branch.id,
        role: "user",
        content: prompt,
        selectedText: options?.selectedText ?? null,
        sessionId: runtime.sessionId,
        machineId: runtime.machineId,
        ordinalInBranch: nextOrdinal,
      });
      this.insertMessage({
        id: assistantMessageId,
        branchId: branch.id,
        role: "assistant",
        content: runtime.assistantMessage,
        selectedText: null,
        sessionId: runtime.sessionId,
        machineId: runtime.machineId,
        ordinalInBranch: nextOrdinal + 1,
      });
      this.upsertAssistantState(assistantMessageId, options?.assistantState);
    });

    return this.getSnapshot();
  }

  applyBranchCreation(
    input: CreateBranchInput,
    runtime: RuntimeResponse,
    options?: {
      branchId?: string;
      userMessageId?: string;
      assistantMessageId?: string;
      assistantState?: AssistantStreamState;
    },
  ): GraphSnapshot {
    const sourceMessage = this.getMessage(input.sourceMessageId);
    if (!sourceMessage) {
      throw new Error(`Unknown source message: ${input.sourceMessageId}`);
    }

    const isSelectionBranch = input.mode === "selection";
    const { branchTitle, userMessageContent } = describeBranchCreation(input, sourceMessage);

    this.runInTransaction(() => {
      const branchId = options?.branchId ?? makeId("branch");
      const userMessageId = options?.userMessageId ?? makeId("msg");
      const assistantMessageId = options?.assistantMessageId ?? makeId("msg");
      this.database
        .prepare(
          `INSERT INTO branches (
             id,
             parent_branch_id,
             source_message_id,
             session_id,
             machine_id,
             title,
             selected_text,
             start_offset,
             end_offset,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          branchId,
          sourceMessage.branchId,
          sourceMessage.id,
          runtime.sessionId,
          runtime.machineId,
          branchTitle,
          isSelectionBranch ? input.selectedText! : null,
          isSelectionBranch ? input.startOffset! : null,
          isSelectionBranch ? input.endOffset! : null,
          nowIso(),
        );

      this.insertMessage({
        id: userMessageId,
        branchId,
        role: "user",
        content: userMessageContent,
        selectedText: isSelectionBranch ? input.selectedText! : null,
        sessionId: runtime.sessionId,
        machineId: runtime.machineId,
        ordinalInBranch: 0,
      });
      this.insertMessage({
        id: assistantMessageId,
        branchId,
        role: "assistant",
        content: runtime.assistantMessage,
        selectedText: null,
        sessionId: runtime.sessionId,
        machineId: runtime.machineId,
        ordinalInBranch: 1,
      });
      this.upsertAssistantState(assistantMessageId, options?.assistantState);
    });

    return this.getSnapshot();
  }

  applyBranchTurn(
    branchId: string,
    prompt: string,
    runtime: RuntimeResponse,
    options?: {
      userMessageId?: string;
      assistantMessageId?: string;
      assistantState?: AssistantStreamState;
      selectedText?: string | null;
    },
  ): GraphSnapshot {
    const branch = this.getBranch(branchId);
    if (!branch) {
      throw new Error(`Unknown branch: ${branchId}`);
    }

    this.runInTransaction(() => {
      const userMessageId = options?.userMessageId ?? makeId("msg");
      const assistantMessageId = options?.assistantMessageId ?? makeId("msg");
      this.database
        .prepare(
          `UPDATE branches
           SET session_id = ?, machine_id = ?
           WHERE id = ?`,
        )
        .run(runtime.sessionId, runtime.machineId, branchId);

      const nextOrdinal = this.getNextMessageOrdinal(branchId);
      this.insertMessage({
        id: userMessageId,
        branchId,
        role: "user",
        content: prompt,
        selectedText: options?.selectedText ?? null,
        sessionId: runtime.sessionId,
        machineId: runtime.machineId,
        ordinalInBranch: nextOrdinal,
      });
      this.insertMessage({
        id: assistantMessageId,
        branchId,
        role: "assistant",
        content: runtime.assistantMessage,
        selectedText: null,
        sessionId: runtime.sessionId,
        machineId: runtime.machineId,
        ordinalInBranch: nextOrdinal + 1,
      });
      this.upsertAssistantState(assistantMessageId, options?.assistantState);
    });

    return this.getSnapshot();
  }

  saveAssistantState(messageId: string, state: AssistantStreamState) {
    this.upsertAssistantState(messageId, state);
  }

  private listBranches() {
    const rows = this.database
      .prepare(
        `SELECT id, parent_branch_id, source_message_id, session_id, machine_id, title, selected_text, start_offset, end_offset, created_at
         FROM branches
         ORDER BY created_at ASC, id ASC`,
      )
      .all() as BranchRow[];

    return rows.map(mapBranchRow);
  }

  private listMessages() {
    const rows = this.database
      .prepare(
        `SELECT id, branch_id, role, content, selected_text, session_id, machine_id, ordinal_in_branch, created_at
         FROM messages
         ORDER BY created_at ASC, ordinal_in_branch ASC, id ASC`,
      )
      .all() as MessageRow[];

    return rows.map(mapMessageRow);
  }

  private listAssistantStates() {
    const rows = this.database
      .prepare(
        `SELECT message_id, state_json, updated_at
         FROM assistant_states`,
      )
      .all() as AssistantStateRow[];

    return rows.reduce<Record<string, AssistantStreamState>>((states, row) => {
      try {
        states[row.message_id] = JSON.parse(row.state_json) as AssistantStreamState;
      } catch {
        return states;
      }

      return states;
    }, {});
  }

  private ensureSchema() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS branches (
        id TEXT PRIMARY KEY,
        parent_branch_id TEXT,
        source_message_id TEXT,
        session_id TEXT,
        machine_id TEXT,
        title TEXT NOT NULL,
        selected_text TEXT,
        start_offset INTEGER,
        end_offset INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        selected_text TEXT,
        session_id TEXT,
        machine_id TEXT,
        ordinal_in_branch INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS messages_branch_ordinal_idx
        ON messages (branch_id, ordinal_in_branch);

      CREATE TABLE IF NOT EXISTS assistant_states (
        message_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.ensureMessageSelectedTextColumn();
  }

  private ensureRootBranch(): Branch {
    const existing = this.getBranch(rootBranchId);
    if (existing) {
      return existing;
    }

    const created: Branch = {
      id: rootBranchId,
      parentBranchId: null,
      sourceMessageId: null,
      sessionId: null,
      machineId: null,
      title: "Root session",
      selectedText: null,
      startOffset: null,
      endOffset: null,
      createdAt: nowIso(),
    };

    this.database
      .prepare(
        `INSERT INTO branches (
           id,
           parent_branch_id,
           source_message_id,
           session_id,
           machine_id,
           title,
           selected_text,
           start_offset,
           end_offset,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        created.id,
        created.parentBranchId,
        created.sourceMessageId,
        created.sessionId,
        created.machineId,
        created.title,
        created.selectedText,
        created.startOffset,
        created.endOffset,
        created.createdAt,
      );

    return created;
  }

  private insertMessage(input: {
    id: string;
    branchId: string;
    role: MessageNode["role"];
    content: string;
    selectedText: string | null;
    sessionId: string | null;
    machineId: string | null;
    ordinalInBranch: number;
  }) {
    this.database
      .prepare(
        `INSERT INTO messages (
           id,
           branch_id,
           role,
           content,
           selected_text,
           session_id,
           machine_id,
           ordinal_in_branch,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.branchId,
        input.role,
        input.content,
        input.selectedText,
        input.sessionId,
        input.machineId,
        input.ordinalInBranch,
        nowIso(),
      );
  }

  private getNextMessageOrdinal(branchId: string) {
    const row = this.database
      .prepare(
        `SELECT COALESCE(MAX(ordinal_in_branch), -1) + 1 AS next_ordinal
         FROM messages
         WHERE branch_id = ?`,
      )
      .get(branchId) as { next_ordinal: number };

    return row.next_ordinal;
  }

  private upsertAssistantState(messageId: string, state: AssistantStreamState | undefined) {
    if (!state) {
      return;
    }

    this.database
      .prepare(
        `INSERT INTO assistant_states (
           message_id,
           state_json,
           updated_at
         ) VALUES (?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
      )
      .run(messageId, JSON.stringify(state), nowIso());
  }

  private runInTransaction<T>(callback: () => T) {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = callback();
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  private ensureMessageSelectedTextColumn() {
    const columns = this.database.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "selected_text")) {
      return;
    }

    this.database.exec(`ALTER TABLE messages ADD COLUMN selected_text TEXT;`);
  }
}

export function readLatestMessageTimestamp(databasePath: string) {
  if (!existsSync(databasePath)) {
    return null;
  }

  const database = new DatabaseSync(databasePath);
  try {
    const row = database
      .prepare(
        `SELECT MAX(created_at) AS latest_message_at
         FROM messages`,
      )
      .get() as { latest_message_at: string | null } | undefined;

    return typeof row?.latest_message_at === "string" && row.latest_message_at.trim().length > 0
      ? row.latest_message_at
      : null;
  } catch {
    return null;
  } finally {
    const close = (database as unknown as { close?: () => void }).close;
    close?.call(database);
  }
}

function resolveGraphDatabasePath() {
  const configuredPath = process.env.NETCHAT_APP_DB_PATH?.trim();
  if (configuredPath) {
    return configuredPath;
  }

  const dataDirectory =
    process.env.NETCHAT_APP_DATA_DIR?.trim() || path.join(os.homedir(), ".netchat");
  return path.join(dataDirectory, "app.db");
}

function mapBranchRow(row: BranchRow): Branch {
  return {
    id: row.id,
    parentBranchId: row.parent_branch_id,
    sourceMessageId: row.source_message_id,
    sessionId: row.session_id,
    machineId: row.machine_id,
    title: row.title,
    selectedText: row.selected_text,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    createdAt: row.created_at,
  };
}

function mapMessageRow(row: MessageRow): MessageNode {
  return {
    id: row.id,
    branchId: row.branch_id,
    role: row.role,
    content: row.content,
    selectedText: row.selected_text,
    sessionId: row.session_id,
    machineId: row.machine_id,
    createdAt: row.created_at,
  };
}
