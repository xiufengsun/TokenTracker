import React, { useCallback } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext.jsx";
import { useLoginModal } from "../contexts/LoginModalContext.jsx";
import { copy } from "../lib/copy";
import { LoginCard } from "./LoginCard.jsx";

export function LoginModal() {
  const { isOpen, request, closeLoginModal, completeLoginModal } = useLoginModal();
  const { enabled, configurationError } = useInsforgeAuth();
  const requestId = request?.id;
  const handleClose = useCallback(() => closeLoginModal(requestId), [closeLoginModal, requestId]);
  const handleSuccess = useCallback(() => { completeLoginModal(requestId); }, [completeLoginModal, requestId]);

  return (
    <Dialog.Root open={isOpen} onOpenChange={(next) => { if (!next) handleClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[100] bg-black/40 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 dark:bg-black/60" />
        <Dialog.Viewport className="fixed inset-0 z-[101] flex items-center justify-center overflow-y-auto overscroll-contain p-4">
          <Dialog.Popup className="relative max-h-[calc(100dvh-2rem)] w-full max-w-[420px] overflow-y-auto overscroll-contain rounded-2xl border border-oai-gray-200 bg-white shadow-2xl transition-[opacity,transform] duration-200 data-[ending-style]:translate-y-2 data-[ending-style]:scale-[0.95] data-[ending-style]:opacity-0 data-[starting-style]:translate-y-2 data-[starting-style]:scale-[0.95] data-[starting-style]:opacity-0 motion-reduce:transition-none dark:border-oai-gray-800 dark:bg-oai-gray-950">
            <Dialog.Title className="sr-only">{copy("login.title")}</Dialog.Title>
            {request?.subtitle ? <Dialog.Description className="sr-only">{request.subtitle}</Dialog.Description> : null}
            <button type="button" onClick={handleClose} aria-label={copy("shared.dialog.close")}
              className="absolute right-2 top-2 z-10 flex h-11 w-11 items-center justify-center rounded-md text-oai-gray-400 transition-colors hover:text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:text-oai-gray-500 dark:hover:text-white">
              <X className="h-5 w-5" aria-hidden />
            </button>
            {enabled ? (
              <LoginCard key={requestId} title={request?.nextPath ? copy("login.title") : undefined}
                hideTitle subtitle={request?.subtitle} oauthReturnPath={request?.nextPath}
                onSuccess={handleSuccess} className="p-6 bg-transparent" />
            ) : (
              <p role={configurationError ? "alert" : "status"} className="p-6 pt-14 text-sm leading-6 text-oai-gray-700 dark:text-oai-gray-300">
                {copy(configurationError ? "instance.configuration.invalid" : "login.cloud_only")}
              </p>
            )}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
