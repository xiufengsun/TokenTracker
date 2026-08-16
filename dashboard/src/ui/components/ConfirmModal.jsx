import { Dialog } from "@base-ui/react/dialog";
import React from "react";
import { Button } from "./Button";
import { cn } from "../../lib/cn";

/**
 * Generic confirm dialog. Use for destructive actions to replace native
 * window.confirm. Cancel / Confirm buttons; press Esc or click backdrop to
 * dismiss. When `destructive` is true the confirm button uses red styling.
 */
export function ConfirmModal({
  open,
  title,
  description,
  error = null,
  confirmLabel,
  cancelLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel?.();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 z-[101] flex items-center justify-center p-4">
          <Dialog.Popup className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.25)] ring-1 ring-oai-gray-200 transition-[opacity,transform] duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] data-[ending-style]:translate-y-2 data-[ending-style]:scale-[0.96] data-[ending-style]:opacity-0 data-[starting-style]:translate-y-2 data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0 dark:bg-oai-gray-950 dark:shadow-[0_20px_60px_-10px_rgba(0,0,0,0.65)] dark:ring-oai-gray-800">
            <Dialog.Title className="text-base font-semibold text-oai-black dark:text-white">
              {title}
            </Dialog.Title>
            {description ? (
              <Dialog.Description className="mt-2 text-sm leading-6 text-oai-gray-600 dark:text-oai-gray-300">
                {description}
              </Dialog.Description>
            ) : null}
            {error ? (
              <p className="mt-2 text-sm leading-6 text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => onCancel?.()}
              >
                {cancelLabel}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => onConfirm?.()}
                className={cn(
                  destructive &&
                    "!bg-red-600 hover:!bg-red-700 focus-visible:!outline-red-600 dark:!bg-red-600 dark:hover:!bg-red-500",
                )}
              >
                {confirmLabel}
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
