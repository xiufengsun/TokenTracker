import React from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { Button } from "../ui/components/Button.jsx";
import { copy } from "../lib/copy";

export function AccountDialog({ open, title, description, onClose, busy = false, children }) {
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-[100] bg-black/40" />
      <Dialog.Viewport className="fixed inset-0 z-[101] flex items-center justify-center p-4">
        <Dialog.Popup aria-busy={busy} className="account-dialog max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-2xl bg-oai-white p-5 text-oai-black ring-1 ring-oai-gray-200 dark:bg-oai-gray-950 dark:text-oai-white dark:ring-oai-gray-800 sm:p-6">
          <div className="flex items-center justify-between gap-4">
            <Dialog.Title className="min-w-0 break-words text-base font-semibold">{title}</Dialog.Title>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose} aria-label={copy("accounts.ui.close")}><X size={16} aria-hidden /></Button>
          </div>
          <Dialog.Description className="mt-2 break-words text-sm leading-6 text-oai-gray-600 dark:text-oai-gray-400">{description}</Dialog.Description>
          <div className="mt-5">{children}</div>
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>;
}
