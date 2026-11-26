// Bundle the three strings used by the desktop handoff, in the dashboard's languages.
import { readFileSync } from "node:fs";
import { readCopyRegistry } from "../../scripts/validate-locale-coverage.cjs";

const content = new URL("../../dashboard/src/content/", import.meta.url);
const labels = ["auth.callback.success", "auth.callback.redirecting", "cloud.action.open_app"];
const english = Object.fromEntries(readCopyRegistry().map(({ key, text }) => [key, text]));
function select(dictionary) {
  return labels.map(key => {
    if (!dictionary[key]) throw new Error("Missing native callback copy: " + key);
    return dictionary[key];
  });
}
const messages = { en: select(english) };
for (const locale of ["zh", "zh-TW", "ja", "ko", "de"]) {
  const read = name => JSON.parse(readFileSync(new URL(`i18n/${locale}/${name}.json`, content), "utf8"));
  messages[locale === "zh" ? "zh-CN" : locale] = select({ ...read("core"), ...read("dashboard") });
}
export const nativeReturnDefine = { __NATIVE_RETURN_COPY__: JSON.stringify(messages) };
