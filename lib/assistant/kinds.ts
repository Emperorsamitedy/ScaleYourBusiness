// The closed set of change kinds — one per row of the change catalogue
// (lib/assistant/catalogue.ts). Its own module so the model's output
// schema and the table share one list without importing each other.

export const CHANGE_KINDS = [
  "stop",
  "resume",
  "reply_time",
  "support_notify",
  "opening_hours",
  "size_band",
  "standing_rule_remove",
  "standing_rule",
  "goal",
  "knowledge_answer",
  "content_item",
  "connection",
  "fact_value",
] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number];

export function isChangeKind(v: unknown): v is ChangeKind {
  return typeof v === "string" && (CHANGE_KINDS as readonly string[]).includes(v);
}
