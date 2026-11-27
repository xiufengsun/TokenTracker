# Show Token Tracker quota in T3 Code

Token Tracker can provide Kimi Coding quota to T3 Code over its [HTTP quota source](https://github.com/pingdotgg/t3code/pull/41291). The source publishes the windows, used percentages and reset times. T3 Code can show them in Usage → Limits and in the thread details for an optionally bound provider instance.

1. Sign in to Kimi Coding on the machine running Token Tracker. Confirm that the Kimi windows appear in Token Tracker's Limits page.
2. Set `TOKENTRACKER_T3_QUOTA_TOKEN` in the environment of the Token Tracker CLI to a random secret of at least 32 characters. Reuse it when restarting the CLI. To show the windows in thread details, set `TOKENTRACKER_T3_QUOTA_INSTANCE` to the exact T3 Code provider instance ID for Kimi.
3. Start Token Tracker on a free, fixed loopback port. If you already run the desktop app, use `--no-sync` so it remains responsible for syncing history.

   ```sh
   tokentracker-cli serve --port 17680 --no-open --no-sync
   ```

4. In T3 Code open **Settings → Providers → Usage providers → Add HTTP source**. Choose the environment running on the same machine and in the same network namespace as the Token Tracker CLI. Set the URL to `http://127.0.0.1:17680/functions/tokentracker-t3-quota` and enter the secret from step 2 as the bearer token.

The stable port belongs to this CLI process. When T3 Code runs its server in WSL, run the exporting CLI in that same WSL environment. If readings expire or Kimi is unavailable, the source reports unavailable until it can obtain fresh windows. Disable the source by unsetting `TOKENTRACKER_T3_QUOTA_TOKEN` and restarting the exporting CLI.
