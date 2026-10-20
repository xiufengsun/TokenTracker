export const LOCAL_USAGE_CHANGED_EVENT: string;
export const LOCAL_USAGE_MAX_BYTES: number;
export function localDeviceUsage(devices: any[], accountSources: any[], selectedDevice?: string | null): { devices: any[]; accountSources: any[] };
export function localUsageAction(action: string, values?: Record<string, unknown>): Promise<any>;
export function readLocalUsageDevices(options?: { from?: string; to?: string; timeZone?: string; tzOffsetMinutes?: number }): Promise<any>;
