import type { Status } from "./config.js";

export type ActorKind = "agent" | "human" | "system";
export type DepKind = "blocks" | "parent" | "discovered-from";
export type CommentKind = "note" | "handoff" | "review" | "system";
export type Verdict = "Verified" | "Failed" | "Unknown";

export interface Ticket {
  id: string;
  type: string;
  title: string;
  body: string;
  status: Status;
  priority: string;
  lane: string;
  labels: string[];
  scope_paths: string[];
  owner: string | null;
  lease_until: string | null;
  claimed_at: string | null;
  attempts: number;
  rework_count: number;
  blocked_reason: string | null;
  unblock_condition: string | null;
  spec_ref: string | null;
  branch: string | null;
  github_issue: number | null;
  pr_url: string | null;
  external_key: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  version: number;
  /** Epic / parent ticket id, if any. */
  parent: string | null;
  /** Open `blocks` dependencies (ids of tickets not yet done/cancelled). */
  blocked_by: string[];
  /** Acceptance-criteria tally. */
  ac_total: number;
  ac_verified: number;
}

export interface AcceptanceCriterion {
  ac_id: string;
  text: string;
  verdict: Verdict;
  evidence: string | null;
  updated_at: string;
}

export interface DepRef {
  id: string;
  kind: DepKind;
  title: string;
  status: Status;
}

export interface Comment {
  id: number;
  kind: CommentKind;
  actor: string;
  body: string;
  created_at: string;
}

export interface SessionRecord {
  id: number;
  ticket_id: string | null;
  session_id: string;
  harness: string | null;
  actor: string | null;
  transcript_path: string | null;
  branch: string | null;
  commit_range: string | null;
  reason: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface FlowEvent {
  seq: number;
  ts: string;
  actor: string;
  actor_kind: ActorKind;
  action: string;
  ticket_id: string | null;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export interface TicketDetail extends Ticket {
  acceptance: AcceptanceCriterion[];
  depends_on: DepRef[];
  dependents: DepRef[];
  children: DepRef[];
  comments: Comment[];
  sessions: SessionRecord[];
  events: FlowEvent[];
}

export interface AgentRecord {
  id: string;
  harness: string | null;
  skills: string[];
  last_seen: string;
  active: Array<{ id: string; title: string; status: Status; lease_until: string | null }>;
}

export interface CreateTicketInput {
  title: string;
  body?: string;
  type?: string;
  priority?: string;
  lane?: string;
  labels?: string[];
  scope_paths?: string[];
  status?: "backlog" | "ready";
  spec_ref?: string | null;
  parent?: string | null;
  depends_on?: string[];
  discovered_from?: string | null;
  acceptance?: Array<string | { ac_id?: string; text: string }>;
  external_key?: string | null;
  id?: string;
}

export interface UpdateTicketInput {
  title?: string;
  body?: string;
  type?: string;
  priority?: string;
  lane?: string;
  labels?: string[];
  add_labels?: string[];
  remove_labels?: string[];
  scope_paths?: string[];
  spec_ref?: string | null;
  branch?: string | null;
  github_issue?: number | null;
  pr_url?: string | null;
}

export interface ListFilter {
  status?: Status | Status[];
  owner?: string;
  label?: string;
  lane?: string;
  type?: string;
  epic?: string;
  query?: string;
  includeClosed?: boolean;
  limit?: number;
}

export interface ReadyFilter {
  label?: string | null;
  epic?: string;
  lane?: string;
  skills?: string[];
  limit?: number;
}
