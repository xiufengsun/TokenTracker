export interface InsforgeAuthUser {
  id?: string | null;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
  profile?: Record<string, unknown> | null;
}

export interface InsforgeAuthValue {
  enabled: boolean;
  configurationError?: string | null;
  connectionHost?: string | null;
  client: any;
  user: InsforgeAuthUser | null;
  signedIn: boolean;
  loading: boolean;
  displayName: string;
  refreshUser: () => Promise<void>;
  refreshDisplayName: () => Promise<void>;
  signInWithOAuth: (provider: string, redirectToOverride?: string) => Promise<any>;
  signInWithPassword: (request: any) => Promise<any>;
  signUp: (request: any) => Promise<any>;
  getPublicAuthConfig: () => Promise<any>;
  signOut: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
}

export function resolveInsforgeClientAccessToken(
  client: any,
  options?: { skewMs?: number },
): Promise<string | null>;

export function InsforgeAuthProvider(props: { children?: any }): any;

export function useInsforgeAuth(): InsforgeAuthValue;
