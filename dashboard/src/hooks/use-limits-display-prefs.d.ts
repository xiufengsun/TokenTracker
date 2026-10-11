export declare const LIMITS_PREFS_CHANGED_EVENT: string;
export declare const LIMIT_DISPLAY_MODES: {
  readonly USED: "used";
  readonly REMAINING: "remaining";
};
export declare const LIMIT_PROVIDER_ICON_KEYS: readonly string[];

export declare function isLimitsPrefsStorageKey(key: string | null): boolean;
export declare function isDevinProviderSelected(): boolean;
export declare function limitProviderIconKey(id: string): string | null;
export declare function limitProviderName(id: string): string;

export interface LimitsDisplayPrefs {
  order: string[];
  visibility: Record<string, boolean>;
  displayMode: string;
  showSubscriptions: boolean;
  visibleOrdered: string[];
  setDisplayMode(mode: string): void;
  setShowSubscriptions(value: boolean): void;
  toggle(id: string): void;
  setAllVisible(visible: boolean): void;
  moveUp(id: string): void;
  moveDown(id: string): void;
  moveToward(sourceId: string, targetId: string): void;
  reset(): void;
}

export declare function useLimitsDisplayPrefs(): LimitsDisplayPrefs;
