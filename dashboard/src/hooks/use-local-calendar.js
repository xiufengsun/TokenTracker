import { useEffect, useState } from "react";
import {
  getBrowserTimeZone,
  getBrowserTimeZoneOffsetMinutes,
  getLocalDayKey,
} from "../lib/timezone";

function readCalendar(now) {
  const date = now || new Date();
  const timeZone = getBrowserTimeZone();
  const tzOffsetMinutes = getBrowserTimeZoneOffsetMinutes(date);
  return {
    timeZone,
    tzOffsetMinutes,
    todayKey: getLocalDayKey({ timeZone, offsetMinutes: tzOffsetMinutes, date }),
  };
}

export function useLocalCalendar(now = null) {
  const [calendar, setCalendar] = useState(() => readCalendar(now));

  useEffect(() => {
    let timer;
    const update = () => {
      const date = now || new Date();
      const next = readCalendar(date);
      // Focus events within the same day must not churn request identities.
      setCalendar((current) => current.todayKey === next.todayKey
        && current.timeZone === next.timeZone
        && current.tzOffsetMinutes === next.tzOffsetMinutes ? current : next);
      if (now) return;
      window.clearTimeout(timer);
      const midnight = new Date(date);
      midnight.setHours(24, 0, 0, 0);
      timer = window.setTimeout(update, midnight.getTime() - Date.now());
    };
    update();
    // A supplied mock date stays fixed for reproducible screenshots/tests.
    if (now) return;
    const handleVisible = () => {
      if (document.visibilityState === "visible") update();
    };
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", handleVisible);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", handleVisible);
    };
  }, [now]);

  return calendar;
}
