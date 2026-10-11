import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useInsforgeAuth } from "../../contexts/InsforgeAuthContext.jsx";
import { resolveAuthAccessTokenWithRetry } from "../../lib/auth-token";
import { getPublicVisibility, setPublicVisibility } from "../../lib/api";
import { runCloudUsageSyncNow } from "../../lib/cloud-sync";
import {
  CLOUD_USAGE_SYNCED_EVENT,
  getCloudSyncEnabled,
  isLocalDashboardHost,
  setCloudSyncEnabled,
} from "../../lib/cloud-sync-prefs";
import { copy } from "../../lib/copy";
import { normalizeGithubProfileUrl, pickDisplayName, pickEmail } from "./AccountSectionUtils.js";
import { clearCloudPromptFailure, recordCloudPromptFailure, readCloudPromptState, subscribeCloudPrompts, cloudPromptRevision } from "../../lib/cloud-prompt-policy.js";
import { isOfficialInsforgeInstance } from "../../lib/insforge-config";

function warnSettingsAction(label, error) {
  console.warn(`[tokentracker] settings ${label}:`, error);
}

function useCloudSyncControl(getAccessToken, enabled, signedIn, userId) {
  const [cloudSyncOn, setCloudSyncOn] = useState(() => getCloudSyncEnabled());
  const showLocalCloudSync = enabled && signedIn && isLocalDashboardHost();
  const scope = useMemo(() => ({ active: true, busy: false }), [getAccessToken, enabled, signedIn, userId]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [syncState, setSyncState] = useState(null);
  const currentSyncState = syncState?.scope === scope ? syncState : null;

  useEffect(() => {
    scope.active = true;
    const preferenceChanged = () => {
      const next = getCloudSyncEnabled();
      setCloudSyncOn(next);
      if (!next) setSyncState((current) => current?.scope === scope ? { ...current, error: null } : current);
    };
    const uploaded = () => {
      setSyncState((current) => current?.scope === scope ? { ...current, error: null } : current);
      clearCloudPromptFailure(userId, "cloud-sync");
    };
    preferenceChanged();
    window.addEventListener("tt.cloudSyncChanged", preferenceChanged);
    window.addEventListener("storage", preferenceChanged);
    window.addEventListener(CLOUD_USAGE_SYNCED_EVENT, uploaded);
    return () => {
      scope.active = false;
      window.removeEventListener("tt.cloudSyncChanged", preferenceChanged);
      window.removeEventListener("storage", preferenceChanged);
      window.removeEventListener(CLOUD_USAGE_SYNCED_EVENT, uploaded);
    };
  }, [scope, userId]);

  const handleCloudSyncRetry = useCallback(async () => {
    if (!showLocalCloudSync || !getCloudSyncEnabled() || scope.busy || !scope.active || currentScope.current !== scope) return;
    scope.busy = true;
    setSyncState({ scope, pending: true, error: null });
    const isCurrent = () => scope.active && currentScope.current === scope && getCloudSyncEnabled();
    try {
      await runCloudUsageSyncNow(() => getAccessToken());
      // This API returns void for uploads, no-op and cooldown alike. The saved
      // opt-in remains enabled; only CLOUD_USAGE_SYNCED_EVENT proves an upload.
    } catch (error) {
      if (!isCurrent()) return;
      const accessFailure = ["cloud_membership_required", "cloud_read_only_expired", "cloud_history_window_exceeded",
        "cloud_machine_limit", "machine_limit_exceeded", "cloud_machine_paused"].includes(error?.code);
      if (accessFailure) recordCloudPromptFailure(userId, error.code, error.membership, "cloud-sync");
      else setSyncState({ scope, pending: true, error: { code: "billing_network_error" } });
      warnSettingsAction("cloud sync", error);
    } finally {
      scope.busy = false;
      if (scope.active && currentScope.current === scope)
        setSyncState((current) => current?.scope === scope ? { ...current, pending: false } : current);
    }
  }, [showLocalCloudSync, scope, getAccessToken, userId]);

  const handleCloudSyncToggle = useCallback(async () => {
    if (!showLocalCloudSync || scope.busy || !scope.active || currentScope.current !== scope) return;
    const next = !getCloudSyncEnabled();
    setSyncState({ scope, pending: false, error: null });
    setCloudSyncEnabled(next);
    setCloudSyncOn(next);
    if (next) await handleCloudSyncRetry();
    else clearCloudPromptFailure(userId, "cloud-sync");
  }, [showLocalCloudSync, scope, handleCloudSyncRetry, userId]);

  const handleCloudSyncDisable = useCallback(() => {
    if (!showLocalCloudSync || !scope.active || currentScope.current !== scope) return;
    // "Use local data" remains an immediate opt-out even while a manual
    // attempt is pending. The sync runner observes the changed preference.
    setCloudSyncEnabled(false);
    setCloudSyncOn(false);
    setSyncState((current) => current?.scope === scope ? { ...current, error: null } : current);
    clearCloudPromptFailure(userId, "cloud-sync");
  }, [showLocalCloudSync, scope, userId]);

  return { cloudSyncOn, cloudSyncPending: Boolean(currentSyncState?.pending), cloudSyncError: currentSyncState?.error,
    handleCloudSyncToggle, handleCloudSyncRetry, handleCloudSyncDisable, showLocalCloudSync };
}

function useProfileState(user) {
  const [publicProfileOn, setPublicProfileOn] = useState(false);
  const [anonymousOn, setAnonymousOn] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [customDisplayName, setCustomDisplayName] = useState(null);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [showGithubOn, setShowGithubOn] = useState(false);
  const [githubUrl, setGithubUrl] = useState("");
  const [githubInput, setGithubInput] = useState("");
  const [editingGithub, setEditingGithub] = useState(false);
  const [githubError, setGithubError] = useState(null);
  const displayName = useMemo(() => pickDisplayName(user), [user]);
  const email = useMemo(() => pickEmail(user), [user]);
  const userId = useMemo(() => (typeof user?.id === "string" ? user.id.trim() : ""), [user]);
  const loadSetters = useMemo(() => ({
    setAnonymousOn,
    setCustomDisplayName,
    setGithubUrl,
    setProfileLoading,
    setPublicProfileOn,
    setShowGithubOn,
  }), []);

  return {
    anonymousOn,
    customDisplayName,
    displayName,
    editingGithub,
    editingName,
    email,
    githubError,
    githubInput,
    githubUrl,
    loadSetters,
    nameInput,
    profileLoading,
    profileSaving,
    publicProfileOn,
    setAnonymousOn,
    setCustomDisplayName,
    setEditingGithub,
    setEditingName,
    setGithubError,
    setGithubInput,
    setGithubUrl,
    setNameInput,
    setProfileLoading,
    setProfileSaving,
    setPublicProfileOn,
    setShowGithubOn,
    showGithubOn,
    userId,
  };
}

function useProfileLoad(getAccessToken, signedIn, state) {
  useEffect(() => {
    if (!signedIn) return undefined;
    let active = true;
    state.setProfileLoading(true);
    (async () => {
      try {
        const token = await resolveAuthAccessTokenWithRetry({ getAccessToken });
        if (!active || !token) return;
        const data = await getPublicVisibility({ accessToken: token });
        if (!active) return;
        state.setPublicProfileOn(Boolean(data?.enabled));
        state.setAnonymousOn(Boolean(data?.anonymous));
        if (data?.display_name) state.setCustomDisplayName(data.display_name);
        state.setShowGithubOn(Boolean(data?.show_github_url));
        state.setGithubUrl(data?.github_url || "");
      } catch (error) {
        warnSettingsAction("load public profile", error);
      } finally {
        if (active) state.setProfileLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [getAccessToken, signedIn, state]);
}

function useProfileMutation(getAccessToken, state, available) {
  return useCallback(async (payload, { label, onError, onSuccess } = {}) => {
    if (!available || state.profileSaving) return false;
    state.setProfileSaving(true);
    try {
      const token = await resolveAuthAccessTokenWithRetry({ getAccessToken });
      if (!token) return false;
      const response = await setPublicVisibility({ accessToken: token, ...payload });
      onSuccess?.(response);
      return true;
    } catch (error) {
      if (onError) onError(error);
      else warnSettingsAction(label || "mutate profile", error);
      return false;
    } finally {
      state.setProfileSaving(false);
    }
  }, [getAccessToken, state, available]);
}

function buildNameProps(state, actions) {
  return {
    anonymousOn: state.anonymousOn,
    customDisplayName: state.customDisplayName,
    displayName: state.displayName,
    editingName: state.editingName,
    handleAnonymousToggle: actions.handleAnonymousToggle,
    handleSaveName: actions.handleSaveName,
    nameInput: state.nameInput,
    profileLoading: state.profileLoading,
    profileSaving: state.profileSaving,
    setEditingName: state.setEditingName,
    setNameInput: state.setNameInput,
    startEditingName: actions.startEditingName,
  };
}

function buildGithubProps(state, actions) {
  return {
    editingGithub: state.editingGithub,
    githubError: state.githubError,
    githubInput: state.githubInput,
    githubUrl: state.githubUrl,
    handleSaveGithub: actions.handleSaveGithub,
    handleShowGithubToggle: actions.handleShowGithubToggle,
    profileLoading: state.profileLoading,
    profileSaving: state.profileSaving,
    setEditingGithub: state.setEditingGithub,
    setGithubError: state.setGithubError,
    setGithubInput: state.setGithubInput,
    showGithubOn: state.showGithubOn,
    startEditingGithub: actions.startEditingGithub,
  };
}

function useVisibilityActions(state, mutateProfile) {
  const handlePublicProfileToggle = useCallback(async () => {
    const next = !state.publicProfileOn;
    await mutateProfile(
      { enabled: next },
      { label: "toggle public profile", onSuccess: () => state.setPublicProfileOn(next) },
    );
  }, [mutateProfile, state]);

  const handleAnonymousToggle = useCallback(async () => {
    const next = !state.anonymousOn;
    await mutateProfile(
      { anonymous: next },
      { label: "toggle anonymous", onSuccess: () => state.setAnonymousOn(next) },
    );
  }, [mutateProfile, state]);

  return { handleAnonymousToggle, handlePublicProfileToggle };
}

function useNameActions(state, mutateProfile, refreshDisplayName) {
  const handleSaveName = useCallback(async () => {
    const trimmed = state.nameInput.trim().slice(0, 50);
    if (!trimmed) return;
    await mutateProfile({ display_name: trimmed }, {
      label: "save display name",
      onSuccess: () => {
        state.setCustomDisplayName(trimmed);
        state.setEditingName(false);
        // Propagate to the shared auth-context displayName so the sidebar
        // avatar/name updates immediately, without a full page reload. The
        // leaderboard self-name comes from a server snapshot and updates on
        // its own refresh cadence.
        refreshDisplayName?.();
      },
    });
  }, [mutateProfile, state, refreshDisplayName]);

  const startEditingName = useCallback(() => {
    state.setNameInput(state.customDisplayName || state.displayName);
    state.setEditingName(true);
  }, [state]);

  return { handleSaveName, startEditingName };
}

function useGithubActions(state, mutateProfile) {
  const handleShowGithubToggle = useCallback(async () => {
    if (!state.showGithubOn && !state.githubUrl) {
      state.setEditingGithub(true);
      state.setGithubInput("");
      state.setGithubError(null);
      return;
    }
    const next = !state.showGithubOn;
    await mutateProfile(
      { show_github_url: next },
      { label: "toggle GitHub profile", onSuccess: () => state.setShowGithubOn(next) },
    );
  }, [mutateProfile, state]);

  const handleSaveGithub = useCallback(async () => {
    const normalizedUrl = normalizeGithubProfileUrl(state.githubInput);
    if (state.githubInput.trim() && !normalizedUrl) {
      state.setGithubError(copy("settings.account.githubUrlInvalid"));
      return;
    }
    state.setGithubError(null);
    await mutateProfile(
      { github_url: normalizedUrl, show_github_url: Boolean(normalizedUrl) },
      {
        label: "save GitHub profile",
        onError: (error) => state.setGithubError(error?.message || copy("settings.account.githubUrlInvalid")),
        onSuccess: (response) => {
          state.setGithubUrl(response?.github_url || normalizedUrl || "");
          state.setShowGithubOn(Boolean(normalizedUrl));
          state.setEditingGithub(false);
        },
      },
    );
  }, [mutateProfile, state]);

  const startEditingGithub = useCallback(() => {
    state.setGithubInput(state.githubUrl);
    state.setGithubError(null);
    state.setEditingGithub(true);
  }, [state]);

  return { handleSaveGithub, handleShowGithubToggle, startEditingGithub };
}

export function useAccountProfileSettings() {
  const auth = useInsforgeAuth();
  useSyncExternalStore(subscribeCloudPrompts, cloudPromptRevision, () => 0);
  const promptState = readCloudPromptState(auth.user?.id);
  const selfHosted = promptState.membership?.status === "self_hosted" || promptState.catalog?.policy?.hosting_mode === "self_hosted";
  const publicProfileAvailable = !selfHosted && (isOfficialInsforgeInstance() || promptState.membership?.hosting_mode === "hosted");
  const state = useProfileState(auth.user);
  const cloudSync = useCloudSyncControl(auth.getAccessToken, auth.enabled, auth.signedIn, auth.user?.id);
  useProfileLoad(auth.getAccessToken, auth.signedIn && publicProfileAvailable, state.loadSetters);
  const mutateProfile = useProfileMutation(auth.getAccessToken, state, publicProfileAvailable);
  const visibilityActions = useVisibilityActions(state, mutateProfile);
  const nameActions = useNameActions(state, mutateProfile, auth.refreshDisplayName);
  const githubActions = useGithubActions(state, mutateProfile);

  return {
    ...auth,
    ...cloudSync,
    email: state.email,
    handlePublicProfileToggle: visibilityActions.handlePublicProfileToggle,
    userId: state.userId,
    name: buildNameProps(state, { ...visibilityActions, ...nameActions }),
    github: buildGithubProps(state, githubActions),
    profileLoading: state.profileLoading,
    profileSaving: state.profileSaving,
    publicProfileOn: publicProfileAvailable && state.publicProfileOn,
    publicProfileAvailable,
  };
}
