import React, { useCallback, useState } from "react";
import { motion } from "motion/react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Shell, Card } from "../../components";
import { CostAnalysisModal } from "../components/CostAnalysisModal.jsx";
import { DataDetails } from "../components/DataDetails.jsx";
import { StatsPanel } from "../components/StatsPanel.jsx";
import { UsageOverview } from "../components/UsageOverview.jsx";
import { TrendMonitor } from "../components/TrendMonitor.jsx";
import { SortableCard } from "../components/SortableCard.jsx";
import { FadeIn } from "../../foundation/FadeIn.jsx";
import { MacAppBanner } from "../components/MacAppBanner.jsx";
import { WidgetOnboardingCard } from "../components/WidgetOnboardingCard.jsx";
import { LinuxTopBarCard } from "../components/LinuxTopBarCard.jsx";
import { IslandOnboardingCard } from "../components/IslandOnboardingCard.jsx";
import { QualityPerDollarCard } from "../components/QualityPerDollarCard.jsx";
import { SessionInsightsCard } from "../components/SessionInsightsCard.jsx";
import { LoginCard } from "../../../components/LoginCard.jsx";
import { DashboardSkeleton } from "../../../components/DashboardSkeleton.jsx";
import { cn } from "../../../lib/cn";
import { LogoCarousel } from "../../marketing/LogoCarousel.jsx";
import { AGENT_LOGOS } from "../../marketing/agent-logos.js";

// Curated subset of the canonical agent list for the gate carousel.
const GATE_LOGOS = AGENT_LOGOS.slice(0, 10);

// Entrance stagger timing — computed from each column's *rendered* index so
// the waterfall still looks right after a user drags cards into a new order.
const STEP = 0.06;
const D_LEFT_BASE = 0.11;
const D_RIGHT_BASE = 0.05;
// islandOnboarding must NOT be prunable: it renders null until the native
// bridge pushes settings (async), and a pruned card is unmounted for good —
// it would never get the chance to appear once settings arrive.
const EMPTY_PRUNABLE_CARD_IDS = new Set(["macAppBanner", "widgetOnboarding"]);

function FullPageGateLayout({ title, subtitle, desc, loginCard, copy }) {
  return (
    <div className="min-h-[85vh] w-full flex items-center justify-center text-oai-black dark:text-white relative overflow-hidden px-4 md:px-8 py-8 md:py-16 transition-colors duration-200 bg-[linear-gradient(to_right,#80808007_1px,transparent_1px),linear-gradient(to_bottom,#80808007_1px,transparent_1px)] bg-[size:40px_40px]">
      {/* 科技感背景微光 */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(59,130,246,0.03),transparent_50%)] dark:bg-[radial-gradient(circle_at_50%_0%,rgba(99,102,241,0.05),transparent_50%)] pointer-events-none" />

      <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-16 items-start relative z-10">

        {/* 左侧品牌与价值 */}
        <div className="lg:col-span-7 flex flex-col justify-center space-y-8 text-left pr-0 lg:pr-6">

          {/* Logo 区域：使用精致的圆角矩形，还原精致的 Mac 圆角方形外观，移除多余剪裁 */}
          <div className="flex items-center gap-2.5">
            <img
              src="/app-icon.png"
              alt=""
              width={32}
              height={32}
              className="rounded-md shadow-md border border-oai-gray-200/50 dark:border-oai-gray-800 shadow-black/10 dark:shadow-black/30"
            />
            <span className="text-xl font-bold tracking-tight bg-gradient-to-r from-oai-black to-oai-gray-600 dark:from-white dark:to-oai-gray-400 bg-clip-text text-transparent font-oai">
              {copy("shared.app_name")}
            </span>
          </div>

          {/* 极具视觉张力的 Hero 主标题与简介 */}
          <div className="space-y-5">
            <div className="space-y-4">
              <h1 className="text-3xl md:text-4xl lg:text-4.5xl font-black tracking-tight leading-[1.15] text-oai-black dark:text-white">
                {title}
              </h1>
              <p className="text-oai-gray-500 dark:text-oai-gray-400 text-sm md:text-base max-w-xl leading-relaxed">
                {desc}
              </p>
            </div>

            {/* Logo 跑马灯组件：无限滑动滚动，呼吸感极致平衡 */}
            <div className="w-full max-w-[280px] sm:max-w-md opacity-85 hover:opacity-100 transition-opacity duration-200">
              <div className="flex justify-start">
                <LogoCarousel logos={GATE_LOGOS} columnCount={6} />
              </div>
            </div>
          </div>
        </div>

        {/* 右侧表单 */}
        <div className="lg:col-span-5 flex justify-center">
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3 }}
            className="w-full max-w-[400px] rounded-2xl border border-oai-gray-200/80 dark:border-oai-gray-800 bg-white/70 dark:bg-oai-gray-950/40 backdrop-blur-md shadow-2xl p-1 relative overflow-hidden"
          >
            {/* 表单内部高光 */}
            <div className="absolute -inset-px bg-gradient-to-b from-white/10 dark:from-white/5 to-transparent pointer-events-none rounded-2xl" />
            {loginCard}
          </motion.div>
        </div>

      </div>
    </div>
  );
}

export function DashboardView(props) {

  const {
    copy,
    onOpenShare,
    screenshotMode,
    showExpiredGate,
    showAuthGate,
    identityDisplayName,
    identityStartDate,
    activeDays,
    identitySubscriptions,
    identityScrambleDurationMs,
    projectUsageEntries,
    projectUsageLimit,
    setProjectUsageLimit,
    projectDetailQuery,
    topModels,
    signedIn,
    publicMode,
    isLocalMode,
    shouldShowInstall,
    installPrompt,
    handleCopyInstall,
    installCopied,
    installInitCmdDisplay,
    trendRowsForDisplay,
    trendFromForDisplay,
    trendToForDisplay,
    trendZoomConfig,
    usageFrom,
    usageTo,
    period,
    trendTimeZoneLabel,
    activityHeatmapBlock,
    periodsForDisplay,
    setSelectedPeriod,
    customFrom,
    customTo,
    onCustomRangeApply,
    customRangeOpen,
    onCustomRangeOpenChange,
    summaryLabel,
    summaryValue,
    summaryFullValue,
    hasSummary,
    summaryLoading,
    providersLoading,
    onToggleSummaryFormat,
    summaryTotalTokensRaw,
    summaryCostValue,
    summaryConversationsValue,
    rollingUsage,
    costInfoEnabled,
    openCostModal,
    costModalOpen,
    closeCostModal,
    allowBreakdownToggle,
    refreshAll,
    usageLoadingState,
    announceUsageLoading,
    initialDashboardLoading,
    fleetData,
    hasDetailsActual,
    dailyEmptyPrefix,
    installSyncCmd,
    dailyEmptySuffix,
    detailsColumns,
    ariaSortFor,
    toggleSort,
    sortIconFor,
    pagedDetails,
    dailyBreakdownRows,
    dailyBreakdownColumns,
    dailyBreakdownAriaSortFor,
    dailyBreakdownSortIconFor,
    dailyBreakdownDateKey,
    detailsDateKey,
    renderDetailDate,
    renderDailyBreakdownDate,
    renderDetailCell,
    DETAILS_PAGED_PERIODS,
    detailsPageCount,
    detailsPage,
    setDetailsPage,
    deviceOptions,
    selectedDevice,
    onDeviceChange,
    deviceUsageBlock,
    leftCardOrder,
    onLeftReorder,
    rightCardOrder,
    onRightReorder,
  } = props;

  // Header 和 Footer 已简化
  const header = null;
  const footer = null;

  // Cards that are permanently hidden after mount (dismissed native banners,
  // widget onboarding) get dropped from sortable `items` entirely. Async cards
  // such as QualityPerDollarCard must stay mounted while their data loads.
  const [emptyCardIds, setEmptyCardIds] = useState(() => new Set());
  const handleCardEmptyChange = useCallback((id, isEmpty) => {
    if (!EMPTY_PRUNABLE_CARD_IDS.has(id)) return;
    setEmptyCardIds((prev) => {
      if (prev.has(id) === isEmpty) return prev;
      const next = new Set(prev);
      if (isEmpty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const leftVisible = {
    macAppBanner: isLocalMode,
    statsPanel: true,
    islandOnboarding: isLocalMode,
    widgetOnboarding: isLocalMode,
    linuxTopBarCard: isLocalMode,
    installCopy: shouldShowInstall,
    activityHeatmap: Boolean(activityHeatmapBlock),
    deviceUsage: Boolean(deviceUsageBlock),
    trendMonitor: !screenshotMode,
    qualityPerDollar: !screenshotMode,
    sessionInsights: isLocalMode && !screenshotMode,
  };
  const visibleLeftOrder = (leftCardOrder || []).filter(
    (id) => leftVisible[id] && !emptyCardIds.has(id),
  );

  const rightVisible = {
    usageOverview: true,
    dataDetails: !screenshotMode,
  };
  const visibleRightOrder = (rightCardOrder || []).filter(
    (id) => rightVisible[id] && !emptyCardIds.has(id),
  );

  function renderLeftCard(id, delay) {
    switch (id) {
      case "macAppBanner": {
        return (
          <MacAppBanner
            todayTokens={summaryTotalTokensRaw}
            isSyncing={usageLoadingState}
            enterDelay={delay}
          />
        );
      }
      case "statsPanel": {
        return (
          <FadeIn delay={delay}>
            <StatsPanel
              title={copy("dashboard.identity.title")}
              subtitle={copy("dashboard.identity.subtitle")}
              period={period}
              startDate={identityStartDate ?? copy("identity_card.rank_placeholder")}
              streakDays={activeDays}
              subscriptions={identitySubscriptions}
              periodConversations={summaryConversationsValue}
              rolling={rollingUsage}
              topModels={topModels}
            />
          </FadeIn>
        );
      }
      case "islandOnboarding": {
        return <IslandOnboardingCard enterDelay={delay} />;
      }
      case "widgetOnboarding": {
        return <WidgetOnboardingCard enterDelay={delay} />;
      }
      case "linuxTopBarCard": {
        return <LinuxTopBarCard enterDelay={delay} />;
      }
      case "installCopy": {
        return (
          <FadeIn delay={delay}>
            <div className="rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-3">
              <div className="text-xs text-oai-gray-500 dark:text-oai-gray-300 mb-1.5">{installPrompt}</div>
              <motion.button
                onClick={handleCopyInstall}
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
                className="w-full flex items-center justify-between px-3 py-2 bg-oai-gray-50 dark:bg-oai-gray-800 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-700 rounded-lg transition-colors"
              >
                <code className="text-xs font-mono text-oai-gray-700 dark:text-oai-gray-300">{installInitCmdDisplay}</code>
                <motion.span
                  key={installCopied ? "copied" : "copy"}
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-xs text-oai-brand"
                >
                  {installCopied ? "Copied ✓" : "Copy"}
                </motion.span>
              </motion.button>
            </div>
          </FadeIn>
        );
      }
      case "activityHeatmap": {
        return <FadeIn delay={delay}>{activityHeatmapBlock}</FadeIn>;
      }
      case "deviceUsage": {
        return <FadeIn delay={delay}>{deviceUsageBlock}</FadeIn>;
      }
      case "trendMonitor": {
        return (
          <FadeIn delay={delay}>
            <TrendMonitor
              rows={trendRowsForDisplay}
              from={trendFromForDisplay}
              to={trendToForDisplay}
              period={period}
              timeZoneLabel={trendTimeZoneLabel}
              showTimeZoneLabel={false}
              zoomConfig={trendZoomConfig}
            />
          </FadeIn>
        );
      }
      case "qualityPerDollar": {
        return (
          <QualityPerDollarCard
            from={usageFrom}
            to={usageTo}
            deviceId={selectedDevice}
          />
        );
      }
      case "sessionInsights": {
        return <SessionInsightsCard from={usageFrom} to={usageTo} />;
      }
      default: {
        return null;
      }
    }
  }

  function renderRightCard(id, delay) {
    switch (id) {
      case "usageOverview": {
        return (
          <FadeIn delay={delay}>
            <UsageOverview
              period={period}
              periods={periodsForDisplay}
              onPeriodChange={setSelectedPeriod}
              summaryLabel={summaryLabel}
              summaryValue={summaryValue}
              summaryFullValue={summaryFullValue}
              hasSummary={hasSummary}
              summaryLoading={summaryLoading}
              providersLoading={providersLoading}
              onToggleSummaryFormat={hasSummary ? onToggleSummaryFormat : null}
              summaryCostValue={summaryCostValue}
              onCostInfo={costInfoEnabled ? openCostModal : null}
              fleetData={fleetData}
              onRefresh={screenshotMode ? null : refreshAll}
              loading={usageLoadingState}
              announceLoading={announceUsageLoading}
              onOpenShare={screenshotMode ? null : onOpenShare}
              customFrom={customFrom}
              customTo={customTo}
              onCustomRangeApply={onCustomRangeApply}
              customRangeOpen={customRangeOpen}
              onCustomRangeOpenChange={onCustomRangeOpenChange}
              from={usageFrom}
              to={usageTo}
              deviceOptions={deviceOptions}
              selectedDevice={selectedDevice}
              onDeviceChange={onDeviceChange}
            />
          </FadeIn>
        );
      }
      case "dataDetails": {
        return (
          <FadeIn delay={delay}>
            <DataDetails
              projectEntries={projectUsageEntries}
              projectLimit={projectUsageLimit}
              onProjectLimitChange={setProjectUsageLimit}
              projectDetailQuery={projectDetailQuery}
              copy={copy}
              hasDetailsActual={hasDetailsActual}
              dailyEmptyPrefix={dailyEmptyPrefix}
              installSyncCmd={installSyncCmd}
              dailyEmptySuffix={dailyEmptySuffix}
              detailsColumns={detailsColumns}
              ariaSortFor={ariaSortFor}
              toggleSort={toggleSort}
              sortIconFor={sortIconFor}
              pagedDetails={pagedDetails}
              dailyBreakdownRows={dailyBreakdownRows}
              dailyBreakdownColumns={dailyBreakdownColumns}
              dailyBreakdownAriaSortFor={dailyBreakdownAriaSortFor}
              dailyBreakdownSortIconFor={dailyBreakdownSortIconFor}
              dailyBreakdownDateKey={dailyBreakdownDateKey}
              detailsDateKey={detailsDateKey}
              renderDetailDate={renderDetailDate}
              renderDailyBreakdownDate={renderDailyBreakdownDate}
              renderDetailCell={renderDetailCell}
              DETAILS_PAGED_PERIODS={DETAILS_PAGED_PERIODS}
              period={period}
              detailsPageCount={detailsPageCount}
              detailsPage={detailsPage}
              setDetailsPage={setDetailsPage}
            />
          </FadeIn>
        );
      }
      default: {
        return null;
      }
    }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleLeftDragEnd = useCallback(
    (event) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      onLeftReorder?.(String(active.id), String(over.id));
    },
    [onLeftReorder],
  );

  const handleRightDragEnd = useCallback(
    (event) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      onRightReorder?.(String(active.id), String(over.id));
    },
    [onRightReorder],
  );

  function renderSortableColumn(order, renderCard, baseDelay, onDragEnd) {
    if (screenshotMode) {
      return (
        <>
          {order.map((id, i) => (
            <React.Fragment key={id}>{renderCard(id, baseDelay + STEP * i)}</React.Fragment>
          ))}
        </>
      );
    }
    return (
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          {order.map((id, i) => (
            <SortableCard key={id} id={id} onEmptyChange={handleCardEmptyChange}>
              {renderCard(id, baseDelay + STEP * i)}
            </SortableCard>
          ))}
        </SortableContext>
      </DndContext>
    );
  }

  const leftColumnContent = renderSortableColumn(
    visibleLeftOrder,
    renderLeftCard,
    D_LEFT_BASE,
    handleLeftDragEnd,
  );
  const rightColumnContent = renderSortableColumn(
    visibleRightOrder,
    renderRightCard,
    D_RIGHT_BASE,
    handleRightDragEnd,
  );

  return (
    <>
      <Shell
        bare={!screenshotMode}
        hideHeader={screenshotMode}
        header={header}
        footer={!screenshotMode ? footer : null}
        className={screenshotMode ? "screenshot-mode" : ""}
      >
        {showAuthGate && (
          <FullPageGateLayout
            title={copy("dashboard.auth_gate.hero_title")}
            desc={copy("dashboard.auth_gate.desc")}
            copy={copy}
            loginCard={
              <LoginCard
                title={copy("dashboard.auth_gate.title")}
                subtitle={copy("dashboard.auth_gate.subtitle")}
                hideLogo={true}
                className="bg-transparent rounded-xl"
              />
            }
          />
        )}
        {showExpiredGate && (
          <FullPageGateLayout
            title={copy("dashboard.expired_gate.hero_title")}
            desc={copy("dashboard.expired_gate.desc")}
            copy={copy}
            loginCard={
              <LoginCard
                title={copy("dashboard.expired_gate.title")}
                subtitle={copy("dashboard.expired_gate.subtitle")}
                hideLogo={true}
                className="bg-transparent rounded-xl"
              />
            }
          />
        )}
        {!showAuthGate && !showExpiredGate && initialDashboardLoading && (
          <DashboardSkeleton />
        )}
        {!showAuthGate && !showExpiredGate && !initialDashboardLoading && (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              <div className="lg:col-span-4 flex flex-col gap-4 min-w-0 order-2 lg:order-1">
                {leftColumnContent}
              </div>

              <div className="lg:col-span-8 flex flex-col gap-4 min-w-0 order-1 lg:order-2">
                {rightColumnContent}
              </div>
            </div>
          </>
        )}
      </Shell>
      <CostAnalysisModal isOpen={costModalOpen} onClose={closeCostModal} fleetData={fleetData} />
    </>
  );
}
