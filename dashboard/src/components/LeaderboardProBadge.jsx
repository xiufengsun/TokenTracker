import React from "react";
import { Tooltip } from "@base-ui/react/tooltip";
import { copy } from "../lib/copy";

export function LeaderboardProBadge({ proActive = false }) {
  if (proActive !== true) return null;
  return (
    <Tooltip.Provider delay={350}>
      <Tooltip.Root>
        <Tooltip.Trigger
          render={<span role="img" tabIndex={0} />}
          className="leaderboard-pro-badge"
          aria-label={copy("leaderboard.pro.badge_aria")}
          aria-description={copy("leaderboard.pro.tooltip")}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          }}
        >
          {copy("leaderboard.pro.badge")}
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner side="top" sideOffset={6} className="leaderboard-pro-tooltip-layer">
            <Tooltip.Popup className="leaderboard-pro-tooltip">
              {copy("leaderboard.pro.tooltip")}
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
