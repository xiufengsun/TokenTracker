import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { clearCloudAction } from "../lib/cloud-action-intent.js";

export function cloudLoginNextPath(value) {
  if (typeof value !== "string" || !/^\/(cloud|billing\/checkout)(\?|$)/.test(value) || value.includes("\\") ||
    Array.from(value).some((char) => { return char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127; })) return null;
  return value;
}

function clearModalReturn(request) {
  if (!request?.nextPath) return;
  try {
    if (window.sessionStorage.getItem("tt.cloud.return") === request.nextPath)
      window.sessionStorage.removeItem("tt.cloud.return");
  } catch { /* Closing still invalidates the in-memory request. */ }
}

const LoginModalContext = createContext({
  isOpen: false,
  request: null,
  openLoginModal: () => {},
  closeLoginModal: () => {},
  completeLoginModal: () => {},
});

export function LoginModalProvider({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const locationKey = useRef(location.key);
  locationKey.current = location.key;
  const [isOpen, setIsOpen] = useState(false);
  const [request, setRequest] = useState(null);
  const pending = useRef(null);
  const requestSequence = useRef(0);
  const openLoginModal = useCallback((options) => {
    clearCloudAction(pending.current?.nextPath);
    clearModalReturn(pending.current);
    // Existing callers pass this callback directly to onClick. A MouseEvent
    // has none of these explicit options and opens the ordinary login dialog.
    const next = {
      id: ++requestSequence.current,
      locationKey: locationKey.current,
      nextPath: cloudLoginNextPath(options?.nextPath),
      subtitle: typeof options?.subtitle === "string" ? options.subtitle : undefined,
      closePath: options?.closePath === "/cloud" ? "/cloud" : null,
    };
    pending.current = next;
    setRequest(next);
    setIsOpen(true);
  }, []);
  const closeLoginModal = useCallback((requestId) => {
    const current = pending.current;
    if (!current || (typeof requestId === "number" && current.id !== requestId)) return;
    // Invalidate before the closing animation or a late auth result can run.
    pending.current = null;
    clearCloudAction(current.nextPath);
    clearModalReturn(current);
    setIsOpen(false);
    if (current.closePath && current.locationKey === locationKey.current) navigate(current.closePath, { replace: true });
  }, [navigate]);
  const completeLoginModal = useCallback((requestId) => {
    const current = pending.current;
    if (!current || current.id !== requestId) return;
    if (current.locationKey !== locationKey.current) {
      closeLoginModal(requestId);
      return;
    }
    pending.current = null;
    clearModalReturn(current);
    setIsOpen(false);
    if (current.nextPath) navigate(current.nextPath, { replace: true });
  }, [navigate, closeLoginModal]);
  useEffect(() => {
    const current = pending.current;
    if (current && current.locationKey !== location.key) closeLoginModal(current.id);
  }, [location.key, closeLoginModal]);

  return (
    <LoginModalContext.Provider value={{ isOpen, request, openLoginModal, closeLoginModal, completeLoginModal }}>
      {children}
    </LoginModalContext.Provider>
  );
}

export function useLoginModal() {
  return useContext(LoginModalContext);
}
