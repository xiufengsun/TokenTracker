"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { formatSyncUploadSummaryLine } = require("../src/commands/sync");

test("sync upload summary distinguishes OAuth-on-disk from truly missing token (#851)", () => {
  assert.equal(
    formatSyncUploadSummaryLine({
      runtimeDeviceToken: "tok",
      uploadResult: { inserted: 2, skipped: 1 },
      tokenPresentOnDisk: true,
    }),
    "- Uploaded: 2 inserted, 1 skipped",
  );
  assert.equal(
    formatSyncUploadSummaryLine({
      runtimeDeviceToken: null,
      uploadResult: { inserted: 0, skipped: 0 },
      tokenPresentOnDisk: true,
    }),
    "- Uploaded: skipped (handled by local server; device token is set)",
  );
  assert.equal(
    formatSyncUploadSummaryLine({
      runtimeDeviceToken: "",
      uploadResult: { inserted: 0, skipped: 0 },
      tokenPresentOnDisk: false,
    }),
    "- Uploaded: skipped (no device token)",
  );
});
