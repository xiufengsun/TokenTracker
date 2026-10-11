import type { CloudCatalog, CloudMembership, CloudAccount } from "./cloud-billing";

export const CLOUD_PROMPT_COOLDOWN_MS: number;
export type CloudPromptScene = "sync" | "view" | "history" | "devices";
export type CloudPromptFailure = { code: string; source: string };
export type CloudPromptState = {
  membership?: CloudMembership;
  subscriptions?: CloudAccount["subscriptions"];
  intent?: CloudPromptScene | null;
  failure?: CloudPromptFailure | null;
  paymentConflict?: boolean;
  catalog?: CloudCatalog;
  catalogObservedAt?: number;
};
export type CloudPromptDecision = {
  scene: string;
  kind: "promotion" | "explanation" | "operation" | "deadline";
  bodyKey: string;
  ctaKey?: string;
  href?: string;
  date?: string;
};
export function subscribeCloudPrompts(listener: () => void): () => void;
export function cloudPromptRevision(): number;
export function clearCloudPromptBackendState(): void;
export function readCloudPromptState(userId: string): CloudPromptState;
export function cloudPromptOwnerFromToken(token: string | undefined): string | null;
export function publishCloudPromptBilling(action: string, value: unknown, userId: string | null, now?: number): void;
export function recordCloudPromptIntent(userId: string, scene: CloudPromptScene): void;
export function clearCloudPromptIntent(userId: string): void;
export function recordCloudPromptFailure(userId: string, code: string, membership: unknown, source: string): void;
export function clearCloudPromptFailure(userId: string, source: string): void;
export function dismissCloudPrompt(userId: string, scene: string, now?: number, storage?: Storage): void;
export function cloudContextualPromptDecision(options: CloudPromptState & {
  userId: string; intentional?: boolean; scene: CloudPromptScene; now?: number; storage?: Storage;
}): CloudPromptDecision | null;
export function cloudDeadlinePromptDecision(options: {
  userId: string; membership: CloudMembership; subscriptions?: CloudAccount["subscriptions"];
  now?: number; storage?: Storage;
}): CloudPromptDecision | null;
