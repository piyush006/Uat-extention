import express from "express";
import { getPool } from "../database/db.js";
import { createIssueId } from "../services/ids.js";
import { maskSensitive } from "../services/masking.js";

export const reportsRouter = express.Router();

reportsRouter.post("/", async (req, res, next) => {
  const activePool = await getPool();
  const client = await activePool.connect();

  try {
    const rawPayload = req.body || {};
    const payload = rawPayload.captureSensitive === true ? rawPayload : maskSensitive(rawPayload);
    const session = payload.session || {};
    const issue = payload.issue || {};
    const events = Array.isArray(payload.events) ? payload.events : [];
    const networkEvents = Array.isArray(payload.networkEvents) ? payload.networkEvents : [];
    const issueId = issue.issueId || createIssueId();
    const sessionId = session.sessionId;

    if (!sessionId) {
      return res.status(400).json({ ok: false, error: "session.sessionId is required" });
    }

    await client.query("begin");

    await client.query(
      `
        insert into sessions (
          session_id, user_identifier, environment, started_at, ended_at,
          browser_info, application_url, issue_status
        )
        values ($1,$2,$3,$4,$5,$6,$7,'new')
        on conflict (session_id) do update set
          user_identifier = excluded.user_identifier,
          environment = excluded.environment,
          ended_at = excluded.ended_at,
          browser_info = excluded.browser_info,
          application_url = excluded.application_url,
          issue_status = 'new'
      `,
      [
        sessionId,
        session.userIdentifier || null,
        session.environment || null,
        session.startedAt || null,
        session.endedAt || new Date().toISOString(),
        session.browserInfo || {},
        session.applicationUrl || issue.currentUrl || null
      ]
    );

    await client.query(
      `
        insert into issues (issue_id, session_id, description, status, current_url, screenshot)
        values ($1,$2,$3,'new',$4,$5)
        on conflict (issue_id) do nothing
      `,
      [
        issueId,
        sessionId,
        issue.description || "",
        issue.currentUrl || session.applicationUrl || null,
        issue.screenshot || null
      ]
    );

    for (const event of events) {
      await client.query(
        `
          insert into events (session_id, timestamp, event_type, event_data)
          values ($1,$2,$3,$4)
        `,
        [
          sessionId,
          event.timestamp || new Date().toISOString(),
          event.type || "event",
          event
        ]
      );
    }

    for (const networkEvent of networkEvents) {
      await client.query(
        `
          insert into network_events (
            session_id, timestamp, method, url, status, duration,
            page_url, page_title, tab_id, window_id, page_instance_id,
            request_data, response_data
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `,
        [
          sessionId,
          networkEvent.timestamp || new Date().toISOString(),
          networkEvent.method || null,
          networkEvent.url || null,
          networkEvent.status || null,
          networkEvent.duration || null,
          networkEvent.pageUrl || networkEvent.page_url || null,
          networkEvent.pageTitle || networkEvent.page_title || null,
          networkEvent.tabId === null || networkEvent.tabId === undefined ? null : String(networkEvent.tabId),
          networkEvent.windowId === null || networkEvent.windowId === undefined ? null : String(networkEvent.windowId),
          networkEvent.pageInstanceId || networkEvent.page_instance_id || null,
          networkEvent.request || {},
          networkEvent.response || {}
        ]
      );
    }

    await client.query("commit");
    res.status(201).json({ ok: true, issueId });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});
