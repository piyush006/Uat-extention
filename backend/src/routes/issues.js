import express from "express";
import { query } from "../database/db.js";

export const issuesRouter = express.Router();

issuesRouter.get("/", async (req, res, next) => {
  try {
    const status = String(req.query.status || "all").trim().toLowerCase();
    const dateFrom = String(req.query.dateFrom || "").trim();
    const dateTo = String(req.query.dateTo || "").trim();
    const values = [];
    const filters = [];

    if (["new", "reviewed", "closed"].includes(status)) {
      values.push(status);
      filters.push(`i.status = $${values.length}`);
    }

    if (dateFrom) {
      values.push(dateFrom);
      filters.push(`i.created_at >= $${values.length}::date`);
    }

    if (dateTo) {
      values.push(dateTo);
      filters.push(`i.created_at < ($${values.length}::date + interval '1 day')`);
    }

    const result = await query(`
      select
        i.issue_id,
        i.description,
        i.status,
        i.created_at,
        s.session_id,
        s.user_identifier,
        s.environment,
        s.application_url
      from issues i
      join sessions s on s.session_id = i.session_id
      ${filters.length ? `where ${filters.join(" and ")}` : ""}
      order by i.created_at desc
      limit 200
    `, values);

    res.json({ ok: true, issues: result.rows });
  } catch (error) {
    next(error);
  }
});

issuesRouter.get("/stats/summary", async (req, res, next) => {
  try {
    const statusResult = await query(`
      select status, count(*)::int as count
      from issues
      group by status
    `);

    const todayResult = await query(`
      select status, count(*)::int as count
      from issues
      where created_at >= current_date
      group by status
    `);

    res.json({
      ok: true,
      overall: statusResult.rows,
      today: todayResult.rows
    });
  } catch (error) {
    next(error);
  }
});

issuesRouter.get("/:issueId", async (req, res, next) => {
  try {
    const issueResult = await query(
      `
        select i.*, s.user_identifier, s.environment, s.started_at, s.ended_at,
               s.browser_info, s.application_url
        from issues i
        join sessions s on s.session_id = i.session_id
        where i.issue_id = $1
      `,
      [req.params.issueId]
    );

    if (!issueResult.rows.length) {
      return res.status(404).json({ ok: false, error: "Issue not found" });
    }

    const issue = issueResult.rows[0];
    const eventsResult = await query(
      `
        select timestamp, event_type, event_data
        from events
        where session_id = $1
        order by timestamp asc
      `,
      [issue.session_id]
    );
    const networkResult = await query(
      `
        select timestamp, method, url, status, duration,
               page_url, page_title, tab_id, window_id, page_instance_id,
               request_data, response_data
        from network_events
        where session_id = $1
        order by timestamp asc
      `,
      [issue.session_id]
    );

    res.json({
      ok: true,
      issue,
      events: eventsResult.rows,
      networkEvents: networkResult.rows
    });
  } catch (error) {
    next(error);
  }
});

issuesRouter.patch("/:issueId", async (req, res, next) => {
  try {
    const status = String(req.body?.status || "").trim();
    if (!["new", "reviewed", "closed"].includes(status)) {
      return res.status(400).json({ ok: false, error: "Invalid status" });
    }

    const result = await query("update issues set status = $1 where issue_id = $2", [status, req.params.issueId]);
    if (!result.rowCount) {
      return res.status(404).json({ ok: false, error: "Issue not found" });
    }

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

issuesRouter.delete("/", async (req, res, next) => {
  try {
    await query("delete from sessions");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

issuesRouter.delete("/:issueId", async (req, res, next) => {
  try {
    const result = await query(
      `
        delete from sessions
        where session_id = (
          select session_id from issues where issue_id = $1
        )
      `,
      [req.params.issueId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ ok: false, error: "Issue not found" });
    }

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
