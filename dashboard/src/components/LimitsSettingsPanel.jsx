import React from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { limitProviderIconKey, limitProviderName } from "../hooks/use-limits-display-prefs.js";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon.jsx";
import { SegmentedControl, SettingsRow } from "./settings/Controls.jsx";

const LIMITS_SETTINGS_ICON_CLASS = "shrink-0 text-oai-gray-900 dark:text-oai-gray-200";

function ToggleSwitch({ checked, onChange, ariaLabel }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onChange}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500",
        checked ? "bg-oai-brand-500" : "bg-oai-gray-300 dark:bg-oai-gray-700",
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}

function ProviderRow({ id, visible, onToggle }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  const style = {
    transform: CSS.Transform.toString(transform) || undefined,
    transition,
    zIndex: isDragging ? 20 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-3 py-2 rounded-md select-none touch-none",
        "cursor-grab active:cursor-grabbing",
        "hover:bg-oai-gray-100/60 dark:hover:bg-oai-gray-800/60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500",
        isDragging && "relative bg-oai-gray-100 dark:bg-oai-gray-800",
      )}
      {...attributes}
      {...listeners}
    >
      <GripVertical
        className="h-4 w-4 shrink-0 text-oai-gray-400 dark:text-oai-gray-500"
        strokeWidth={1.75}
        aria-hidden
      />

      {limitProviderIconKey(id) ? (
        <ProviderIcon
          provider={limitProviderIconKey(id)}
          size={18}
          className={cn("pointer-events-none", LIMITS_SETTINGS_ICON_CLASS)}
        />
      ) : null}

      <span className="flex-1 text-sm text-oai-gray-900 dark:text-oai-gray-200">
        {limitProviderName(id)}
      </span>

      <div onPointerDown={(e) => e.stopPropagation()}>
        <ToggleSwitch
          checked={visible}
          onChange={onToggle}
          ariaLabel={`${copy("limits.settings.toggle_visible")}: ${limitProviderName(id)}`}
        />
      </div>
    </div>
  );
}

/**
 * Bare drag-and-drop reorder + visibility list for usage-limit providers.
 * Renders bulk visibility controls and the row list; outer chrome is supplied by the
 * surrounding container (e.g. SettingsPage SectionCard).
 *
 * Reordering runs on @dnd-kit (pointer events), not HTML5 `draggable`: the
 * Windows app hosts the dashboard in a windowless WebView2
 * (CoreWebView2CompositionController / DirectComposition), which never wires up
 * the OLE drag loop, so native `dragstart` simply never fires there (issue 387).
 * Pointer events work in every host, and this matches the other reorder UIs
 * (SortableCard, SortableColumnHeader).
 *
 * `prefs` is the return value of `useLimitsDisplayPrefs()`.
 */
export function LimitsSettingsPanel({ prefs }) {
  const { order, visibility, toggle, setAllVisible, moveToward } = prefs;
  const allVisible = order.every((id) => visibility[id] !== false);
  const allHidden = order.every((id) => visibility[id] === false);
  const enabledCount = order.filter((id) => visibility[id] !== false).length;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = ({ active, over }) => {
    if (over && active.id !== over.id) moveToward(active.id, over.id);
  };

  return (
    <>
    <SettingsRow
      label={copy("limits.settings.bulk_visibility")}
      hint={copy("limits.settings.enabled_count", { enabled: enabledCount, total: order.length })}
      control={
        <SegmentedControl
          options={[
            { value: "enabled", label: copy("limits.settings.enable_all") },
            { value: "disabled", label: copy("limits.settings.disable_all") },
          ]}
          value={allVisible ? "enabled" : allHidden ? "disabled" : null}
          onChange={(value) => setAllVisible(value === "enabled")}
        />
      }
    />
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={order} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col">
          {order.map((id) => (
            <ProviderRow
              key={id}
              id={id}
              visible={visibility[id] !== false}
              onToggle={() => toggle(id)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
    </>
  );
}
