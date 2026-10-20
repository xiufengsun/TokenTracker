import React, { useCallback, useEffect, useRef, useState } from "react";
import { copy } from "../../lib/copy";
import { Button } from "../../ui/components/Button.jsx";
import { SectionCard, SettingsRow } from "./Controls.jsx";
import { localUsageAction, readLocalUsageDevices, LOCAL_USAGE_CHANGED_EVENT, LOCAL_USAGE_MAX_BYTES } from "../../lib/local-usage-transfer";
import { saveLocalUsageExport } from "../../lib/native-bridge";

const ERROR_CODES = new Set(["invalid_snapshot", "self_import", "snapshot_conflict", "preview_changed",
  "transfer_busy", "legacy_imports", "invalid_queue", "invalid_state", "identity_unavailable", "too_many_devices", "unknown_device"]);

export function LocalDataSection({ active = true }) {
  const fileInput = useRef(null);
  const [devices, setDevices] = useState([]);
  const [pending, setPending] = useState(null);
  const [removing, setRemoving] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const load = useCallback(async () => setDevices((await readLocalUsageDevices()).devices || []), []);
  useEffect(() => { if (active) load().catch(() => setError(copy("settings.local_data.error.transfer_failed"))); }, [active, load]);

  async function run(action) {
    setBusy(true);
    setError("");
    setStatus("");
    try { await action(); }
    catch (e) {
      setPending(null);
      setError(copy(`settings.local_data.error.${ERROR_CODES.has(e?.code) ? e.code : "transfer_failed"}`));
    } finally { setBusy(false); }
  }
  async function changed() {
    window.dispatchEvent(new Event(LOCAL_USAGE_CHANGED_EVENT));
    await load();
  }
  async function exportUsage() {
    await run(async () => {
      const { snapshot } = await localUsageAction("export");
      const filename = `tokentracker-local-${snapshot.machine.id.slice(0, 12)}-${snapshot.sequence}.json`;
      const content = JSON.stringify(snapshot);
      const saved = await saveLocalUsageExport({ filename, content, format: "json" });
      if (saved) setStatus(copy("settings.local_data.saved", { filename: saved.filename }));
      else {
        const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setStatus(copy("settings.local_data.download_started"));
      }
    });
  }
  async function selectFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPending(null);
    await run(async () => {
      if (file.size > LOCAL_USAGE_MAX_BYTES) throw Object.assign(new Error(), { code: "invalid_snapshot" });
      let snapshot;
      try { snapshot = JSON.parse(await file.text()); }
      catch { throw Object.assign(new Error(), { code: "invalid_snapshot" }); }
      const preview = await localUsageAction("preview", { snapshot });
      setPending({ snapshot, preview });
    });
  }
  const imports = devices.filter((device) => { return Boolean(device.imported_at); });
  return (
    <div className="space-y-4">
      <SectionCard title={copy("settings.local_data.title")}>
        <p className="py-3 text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("settings.local_data.scope")}</p>
        <SettingsRow label={copy("settings.local_data.export")}
          control={<Button variant="secondary" size="sm" disabled={busy} onClick={exportUsage}>{copy("settings.local_data.export")}</Button>} />
        <SettingsRow label={copy("settings.local_data.import")}
          control={<Button variant="secondary" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>{copy("settings.local_data.choose")}</Button>} />
        <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" aria-label={copy("settings.local_data.choose")} onChange={selectFile} />
      </SectionCard>
      {pending && (
        <SectionCard title={copy("settings.local_data.preview")}>
          <div className="space-y-3 py-3 text-sm">
            <p>{pending.preview.machine.name}</p>
            <p className="text-oai-gray-500">{copy("settings.local_data.snapshot_time", { time: new Date(pending.preview.exported_at).toLocaleString() })}</p>
            <p>{copy("settings.local_data.change", { before: pending.preview.before.toLocaleString(), after: pending.preview.after.toLocaleString() })}</p>
            {["unchanged", "outdated"].includes(pending.preview.action) && <p>{copy(`settings.local_data.${pending.preview.action}`)}</p>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy || ["unchanged", "outdated"].includes(pending.preview.action)} onClick={() => run(async () => {
                await localUsageAction("import", { snapshot: pending.snapshot, token: pending.preview.token });
                setPending(null);
                setStatus(copy("settings.local_data.imported"));
                await changed();
              })}>{copy("settings.local_data.confirm")}</Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setPending(null)}>{copy("settings.local_data.cancel")}</Button>
            </div>
          </div>
        </SectionCard>
      )}
      <SectionCard title={copy("settings.local_data.sources")}>
        {imports.length === 0 && <p className="py-3 text-sm text-oai-gray-500">{copy("settings.local_data.empty")}</p>}
        {imports.map((device) => <SettingsRow key={device.id} label={device.device_name}
          hint={copy("settings.local_data.snapshot_time", { time: new Date(device.exported_at).toLocaleString() })}
          control={removing === device.machine_id ? <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => run(async () => {
              await localUsageAction("remove", { machine_id: device.machine_id });
              setRemoving("");
              setStatus(copy("settings.local_data.removed"));
              await changed();
            })}>{copy("settings.local_data.confirm_remove")}</Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setRemoving("")}>{copy("settings.local_data.cancel")}</Button>
          </div> : <Button variant="secondary" size="sm" disabled={busy} onClick={() => setRemoving(device.machine_id)}>{copy("settings.local_data.remove")}</Button>} />)}
      </SectionCard>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {status && <p role="status" className="text-sm text-oai-gray-500">{status}</p>}
    </div>
  );
}
