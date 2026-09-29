"use strict";

// Redirect os.homedir() to an isolated directory for the duration of a test.
//
// os.homedir() honors $HOME on POSIX but reads %USERPROFILE% on Windows and
// ignores HOME. A test that swaps only HOME therefore still resolves to the
// developer's real home on Windows, so commands under test write into the real
// ~/.tokentracker — which is how `npm test` on Windows silently rewrote
// config.baseUrl to a test value and broke cloud upload. Swap BOTH vars.
//
// Returns a restore() to call from the test's finally block.
function withHome(dir) {
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    DSH_HOME: process.env.DSH_HOME,
    TOKENTRACKER_DSH_HOME: process.env.TOKENTRACKER_DSH_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  // The DeepSeek Harness exports DSH_HOME to every child process, so running
  // the suite inside a dsh session would otherwise leak the real ~/.dsh past
  // this isolation. Clear both harness-home overrides so the dsh parser
  // resolves to the isolated HOME's `.dsh` instead.
  delete process.env.DSH_HOME;
  delete process.env.TOKENTRACKER_DSH_HOME;
  // CLAUDE_CONFIG_DIR is an implicit Claude Code scan root (#657), so a suite
  // run inside a Claude Code session with a relocated config dir would scan
  // the developer's real transcripts past this isolation. Clear it the same
  // way; a test that wants it sets it explicitly after withHome().
  delete process.env.CLAUDE_CONFIG_DIR;
  return function restoreHome() {
    for (const key of ["HOME", "USERPROFILE", "DSH_HOME", "TOKENTRACKER_DSH_HOME", "CLAUDE_CONFIG_DIR"]) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  };
}

module.exports = { withHome };
