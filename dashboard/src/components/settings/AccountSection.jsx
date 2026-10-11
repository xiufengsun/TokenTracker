import React from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, LogOut } from "lucide-react";
import { copy } from "../../lib/copy";
import { useAccountProfileSettings } from "./useAccountProfileSettings.js";
import { PublicProfileFields, SignedOutAccountSection } from "./AccountSectionParts.jsx";
import { SectionCard, SettingsRow, ToggleSwitch } from "./Controls.jsx";

export function AccountSection({ settings } = {}) {
  return settings ? <AccountProfileSection settings={settings} /> : <StandaloneAccountSection />;
}

function StandaloneAccountSection() {
  const settings = useAccountProfileSettings();
  return <AccountProfileSection settings={settings} />;
}

function AccountProfileSection({ settings }) {
  if (!settings.enabled) return null;
  if (!settings.signedIn) { return <SignedOutAccountSection />; }

  return (
    <SectionCard
      title={copy("settings.section.account")}
      subtitle={settings.email || (settings.name.customDisplayName || settings.name.displayName)}
      action={<SignOutButton onSignOut={settings.signOut} />}
    >
      <UserIdRow userId={settings.userId} />
      <PublicProfileToggleRow
        checked={settings.publicProfileOn}
        disabled={settings.profileLoading || settings.profileSaving || settings.publicProfileAvailable === false}
        onChange={settings.handlePublicProfileToggle}
        unavailable={settings.publicProfileAvailable === false}
      />
      <PublicProfileDetails visible={settings.publicProfileOn} name={settings.name} github={settings.github} />
    </SectionCard>
  );
}

function UserIdRow({ userId }) {
  const [copied, setCopied] = React.useState(false);
  if (!userId) return null;

  const handleCopy = async () => {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
      await navigator.clipboard.writeText(userId);
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-oai-gray-900 dark:text-oai-gray-200">
          {copy("settings.account.userId")}
        </div>
        <div className="mt-0.5 truncate font-mono text-xs text-oai-gray-500 dark:text-oai-gray-400">
          {userId}
        </div>
      </div>
      <button
        type="button"
        onClick={handleCopy}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-oai-gray-200 px-3 text-xs font-medium text-oai-gray-700 transition-colors hover:bg-oai-gray-100 dark:border-oai-gray-800 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800"
        aria-label={copy("settings.account.copyUserId")}
      >
        {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
        {copied ? copy("settings.account.copied") : copy("settings.account.copy")}
      </button>
    </div>
  );
}

function SignOutButton({ onSignOut }) {
  return (
    <button
      type="button"
      onClick={() => onSignOut()}
      className="inline-flex h-7 items-center gap-1.5 text-xs font-medium text-oai-gray-500 transition-colors hover:text-oai-gray-700 dark:hover:text-oai-gray-300"
    >
      <LogOut className="h-3.5 w-3.5" aria-hidden />
      {copy("settings.account.signOut")}
    </button>
  );
}

function PublicProfileToggleRow({ checked, disabled, onChange, unavailable }) {
  return (
    <SettingsRow
      label={copy("settings.account.publicProfile")}
      hint={copy(unavailable ? "cloud.self_host.public_profile_disabled" : "settings.account.publicProfileHint")}
      control={
        <ToggleSwitch
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          ariaLabel={copy("settings.account.publicProfile")}
        />
      }
    />
  );
}

function PublicProfileDetails({ visible, name, github }) {
  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.div
          key="public-profile-fields"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{
            height: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
            opacity: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
          }}
          style={{ overflow: "hidden" }}
          className="divide-y divide-oai-gray-200/60 dark:divide-oai-gray-800/60"
        >
          <PublicProfileFields name={name} github={github} />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
