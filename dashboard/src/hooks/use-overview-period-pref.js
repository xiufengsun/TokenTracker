import { useCallback, useState } from "react";
import { persistOverviewPeriod, readOverviewPeriod } from "../lib/overview-period-pref.js";

export function useOverviewPeriodPref() {
  const [period, setPeriod] = useState(readOverviewPeriod);
  const setOverviewPeriod = useCallback((value) => {
    setPeriod(persistOverviewPeriod(value));
  }, []);
  return { period, setOverviewPeriod };
}
