// Deploy only to the synthetic QA database. Each real timer tick runs one production handler.
import { scheduledReports } from "../src/report-jobs";

const schedules = [
  "17,47 * * * *",
  "23 */6 * * *",
  "32 */6 * * *",
  "17 * * * *",
  "41 * * * *",
  "*/10 * * * *",
  "12 4 * * *",
];
const harness: ExportedHandler<{
  DB: D1Database;
  LEADERBOARD_BLOCKED_USER_IDS: string;
}> = {
  async scheduled(event: ScheduledController, env) {
    const row = await env.DB.prepare(
      "UPDATE qa_timer_receipts SET started=? WHERE slot=(SELECT min(slot) FROM qa_timer_receipts WHERE started IS NULL) RETURNING slot",
    )
      .bind(event.scheduledTime)
      .first<{ slot: number }>();
    if (!row) return;
    try {
      await scheduledReports(schedules[row.slot], env);
      await env.DB.prepare(
        "UPDATE qa_timer_receipts SET finished=?,success=1 WHERE slot=?",
      )
        .bind(Date.now(), row.slot)
        .run();
    } catch (error) {
      const detail =
        error instanceof Error ? error.message.slice(0, 160) : "failed";
      await env.DB.prepare(
        "UPDATE qa_timer_receipts SET finished=?,success=0,detail=? WHERE slot=?",
      )
        .bind(Date.now(), detail, row.slot)
        .run();
      throw error;
    }
  },
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
};

export default harness;
