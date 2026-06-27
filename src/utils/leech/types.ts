export type LeechActionStatus =
  | "start"
  | "progress"
  | "success"
  | "error"
  | "skipped";

export interface LeechDateRange {
  from: Date;
  to: Date;
  fromTs: number;
  toTs: number;
  label: string;
}

export interface LeechChatIdentity {
  input: string;
  chatId: string;
  chatTitle: string;
  chatType: string;
  username?: string;
}

export interface LeechRunOptions {
  targetInput: string;
  range: LeechDateRange;
  batchSize: number;
  limit?: number;
  actor?: string;
}

export interface LeechJobCreateInput {
  actionId: string;
  target: string;
  chat?: LeechChatIdentity;
  range: LeechDateRange;
  batchSize: number;
  limit?: number;
  options?: Record<string, unknown>;
}

export interface LeechStoredMessage {
  chatId: string;
  messageId: number;
  firstJobId: number;
  lastJobId: number;
  dateTs: number;
  dateIso: string;
  editDateTs?: number | null;
  senderId?: string | null;
  senderUsername?: string | null;
  senderName?: string | null;
  messageText?: string | null;
  rawJson: string;
  mediaType?: string | null;
  replyToMsgId?: number | null;
  groupedId?: string | null;
  views?: number | null;
  forwards?: number | null;
  isOut: boolean;
  savedAt: string;
}

export interface LeechActionLogInput {
  actionId: string;
  jobId?: number | null;
  action: string;
  status: LeechActionStatus;
  actor?: string | null;
  target?: string | null;
  details?: Record<string, unknown>;
}

export interface LeechJobSummary {
  id: number;
  action_id: string;
  target: string;
  chat_id?: string | null;
  chat_title?: string | null;
  chat_type?: string | null;
  from_ts: number;
  to_ts: number;
  status: string;
  requested_limit?: number | null;
  batch_size: number;
  saved_count: number;
  scanned_count: number;
  started_at: string;
  finished_at?: string | null;
  error?: string | null;
}

export interface LeechStats {
  chatId?: string;
  totalMessages: number;
  firstMessageIso?: string | null;
  lastMessageIso?: string | null;
  totalJobs: number;
  lastJobStatus?: string | null;
  lastJobFinishedAt?: string | null;
}

