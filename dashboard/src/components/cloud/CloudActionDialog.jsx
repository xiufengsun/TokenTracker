import React from "react";
import { Dialog } from "@base-ui/react/dialog";
import { ChevronRight, X } from "lucide-react";
import { copy } from "../../lib/copy";

export function CloudActionDialog({
  open,
  onOpenChange,
  title,
  triggerLabel = title,
  icon: Icon,
  wide = false,
  preventClose = false,
  initialFocus,
  children,
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen, details) => {
      if (!nextOpen && preventClose) {
        details.cancel();
        return;
      }
      onOpenChange(nextOpen);
    }}>
      <Dialog.Trigger className="inline-flex h-11 w-full items-center gap-3 rounded-md border-0 bg-transparent p-0 text-left text-sm font-medium text-oai-black transition-colors hover:bg-oai-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oai-gray-500 dark:text-oai-white dark:hover:bg-oai-gray-800">
        {Icon ? <Icon size={16} className="shrink-0" aria-hidden /> : null}
        <span className="min-w-0 flex-1">{triggerLabel}</span>
        <ChevronRight size={16} className="shrink-0 text-oai-gray-500 dark:text-oai-gray-400" aria-hidden />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="tt-cloud-action-backdrop fixed inset-0 z-[100] bg-black/40 dark:bg-black/60" />
        <Dialog.Viewport className="tt-cloud-settings fixed inset-0 z-[101] flex items-center justify-center overflow-y-auto overscroll-contain p-4">
          <Dialog.Popup initialFocus={initialFocus} aria-modal="true"
            className={`tt-cloud-action-popup tt-cloud-theme relative max-h-[calc(100dvh-2rem)] w-full ${wide ? "max-w-2xl" : "max-w-lg"} overflow-y-auto overscroll-contain rounded-xl bg-white p-5 shadow-xl outline-none dark:bg-oai-gray-900`}>
            <div className="mb-3 flex min-h-11 items-center justify-between gap-4">
              <Dialog.Title className="min-w-0 text-lg font-semibold text-oai-black dark:text-oai-white">{title}</Dialog.Title>
              <Dialog.Close disabled={preventClose} aria-label={copy("shared.dialog.close")}
                className="inline-flex size-11 min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md border-0 bg-transparent p-0 text-oai-gray-500 transition-colors hover:bg-oai-gray-100 hover:text-oai-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oai-gray-500 disabled:cursor-wait disabled:opacity-40 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800 dark:hover:text-oai-white">
                <X size={18} aria-hidden />
              </Dialog.Close>
            </div>
            <div data-settings-panel="cloud" className="min-w-0">{children}</div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
