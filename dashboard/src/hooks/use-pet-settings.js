import { useCallback, useEffect, useState } from "react";
import {
  isNativeApp,
  isNativeLinuxApp,
  isPetBridgeAvailable,
  onNativePetSettings,
  requestNativePetSettings,
  setNativePetSetting,
} from "../lib/native-bridge";
import { BOT_COLOR_CHOICES } from "../lib/bot-appearance.js";
import { normalizePetCharacter } from "../lib/pet-personality";

const DEFAULTS = { visible: false, character: "clawd", size: "medium", botColor: "auto" };

export function usePetSettings() {
  // The Linux app loads the dashboard without `?app=1`, so it can't pass isNativeApp().
  const available = (isNativeApp() || isNativeLinuxApp()) && isPetBridgeAvailable();
  const [settings, setSettings] = useState(DEFAULTS);

  useEffect(() => {
    if (!available) return undefined;
    const unsubscribe = onNativePetSettings((next) => {
      setSettings({
        visible: Boolean(next.visible),
        character: normalizePetCharacter(next.character),
        size: ["small", "medium", "large"].includes(next.size) ? next.size : "medium",
        botColor: BOT_COLOR_CHOICES.includes(next.botColor) ? next.botColor : "auto",
      });
    });
    requestNativePetSettings();
    return unsubscribe;
  }, [available]);

  // Always apply the optimistic local update so the page reflects the choice
  // immediately (and previews work on the plain web build); only the native
  // post is gated on bridge availability.
  const setSetting = useCallback((key, value) => {
    setSettings((current) => ({ ...current, [key]: value }));
    if (available) setNativePetSetting(key, value);
  }, [available]);

  return { available, settings, setSetting };
}
