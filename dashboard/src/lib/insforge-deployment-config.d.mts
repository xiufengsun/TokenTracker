export const OFFICIAL_INSFORGE_URL: string;
export type DeploymentConfiguration = { baseUrl: string; anonKey: string; errorCode: string | null };
export function isPublicAnonKey(value: unknown): boolean;
export function validateInsforgeDeployment(options?: {
  baseUrl?: unknown; anonKey?: unknown; strictPair?: boolean; defaultBaseUrl?: string; defaultAnonKey?: string;
}): DeploymentConfiguration;
export function validateInsforgeBuildEnv(env: Record<string, string | undefined>): DeploymentConfiguration;
