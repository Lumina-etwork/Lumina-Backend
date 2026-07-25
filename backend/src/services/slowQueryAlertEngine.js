/**
 * SlowQueryAlertEngine - Evaluates slow query thresholds and fires alerts
 * via PagerDuty for critical+ queries exceeding 10 occurrences in 5 minutes.
 *
 * Issue #49: PostgreSQL Query Performance Monitoring and Slow Query Alerting
 *
 * Thresholds:
 *   - warning:   > 200ms
 *   - critical:  > 1000ms (1s)
 *   - emergency: > 5000ms (5s)
 *
 * PagerDuty alert: critical+ queries firing > 10 times in 5 minutes.
 */

const axios = require('axios');
const { Op } = require('sequelize');
const { SlowQuery, SlowQueryAlert } = require('../models');

const THRESHOLDS = {
  warning: 200,
  critical: 1000,
  emergency: 5000,
};

const FIRE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MIN_FIRE_COUNT = 10;

class SlowQueryAlertEngine {
  constructor({ pagerDutyRoutingKey, logger } = {}) {
    this.pagerDutyRoutingKey =
      pagerDutyRoutingKey ||
      process.env.PAGERDUTY_ROUTING_KEY ||
      process.env.SLOW_QUERY_PAGERDUTY_ROUTING_KEY ||
      '';
    this.logger = logger || console;
  }

  /**
   * Determine severity based on mean_time_ms.
   */
  determineSeverity(meanTimeMs) {
    const ms = Number(meanTimeMs);
    if (ms >= THRESHOLDS.emergency) return 'emergency';
    if (ms >= THRESHOLDS.critical) return 'critical';
    if (ms >= THRESHOLDS.warning) return 'warning';
    return null;
  }

  /**
   * Evaluate all tracked slow queries and fire alerts where needed.
   */
  async evaluateAll() {
    const queries = await SlowQuery.findAll({
      where: {
        mean_time_ms: {
          [Op.gte]: THRESHOLDS.warning,
        },
      },
      order: [['mean_time_ms', 'DESC']],
    });

    const results = [];

    for (const query of queries) {
      const result = await this.evaluateQuery(query);
      if (result) results.push(result);
    }

    return { evaluated: queries.length, alerts: results };
  }

  /**
   * Evaluate a single slow query for alerting.
   */
  async evaluateQuery(slowQuery) {
    const severity = this.determineSeverity(slowQuery.mean_time_ms);
    if (!severity) return null;

    const now = new Date();
    const windowStart = new Date(now.getTime() - FIRE_WINDOW_MS);

    // Check existing alert within the window
    const existingAlert = await SlowQueryAlert.findOne({
      where: {
        slow_query_id: slowQuery.id,
        severity,
        first_fired_at: {
          [Op.gte]: windowStart,
        },
      },
    });

    if (existingAlert) {
      // Bump fire count and update last_fired_at
      await existingAlert.update({
        fire_count: existingAlert.fire_count + 1,
        last_fired_at: now,
      });

      // Only send PagerDuty for critical+ if fire count > threshold
      if (
        severity !== 'warning' &&
        existingAlert.fire_count + 1 >= MIN_FIRE_COUNT &&
        this.pagerDutyRoutingKey
      ) {
        await this.sendPagerDutyAlert(slowQuery, existingAlert);
      }

      return {
        id: existingAlert.id,
        slow_query_id: slowQuery.id,
        severity,
        fire_count: existingAlert.fire_count + 1,
        escalated: severity !== 'warning' && existingAlert.fire_count + 1 >= MIN_FIRE_COUNT,
      };
    }

    // No existing alert, create one
    const alert = await SlowQueryAlert.create({
      slow_query_id: slowQuery.id,
      severity,
      threshold_ms: THRESHOLDS[severity],
      actual_mean_time_ms: slowQuery.mean_time_ms,
      fire_count: 1,
      first_fired_at: now,
      last_fired_at: now,
    });

    // For critical+ queries, log a detailed alert message
    if (severity !== 'warning') {
      this.logger.warn(
        `Slow query alert [${severity}]: ${slowQuery.query_type} on ${slowQuery.table_name || 'unknown'} ` +
        `- mean: ${slowQuery.mean_time_ms}ms, threshold: ${THRESHOLDS[severity]}ms, ` +
        `query: ${slowQuery.normalized_query.substring(0, 200)}`
      );
    }

    return {
      id: alert.id,
      slow_query_id: slowQuery.id,
      severity,
      fire_count: 1,
      escalated: false,
    };
  }

  /**
   * Send a PagerDuty alert via Events API v2.
   */
  async sendPagerDutyAlert(slowQuery, alert) {
    if (!this.pagerDutyRoutingKey) {
      this.logger.warn('PagerDuty routing key not configured; skipping PagerDuty alert');
      return null;
    }

    const dedupKey = `slow-query-${slowQuery.id}-${alert.severity}`;

    try {
      const response = await axios.post(
        'https://events.pagerduty.com/v2/enqueue',
        {
          routing_key: this.pagerDutyRoutingKey,
          event_action: 'trigger',
          dedup_key: dedupKey,
          payload: {
            summary: `Slow query alert: ${slowQuery.query_type} on ${slowQuery.table_name || 'unknown'} (${alert.severity})`,
            source: `lumina-backend-${process.env.NODE_ENV || 'production'}`,
            severity: alert.severity === 'emergency' ? 'critical' : alert.severity,
            timestamp: new Date().toISOString(),
            component: 'database',
            group: 'query-performance',
            class: 'slow-query',
            custom_details: {
              normalized_query: slowQuery.normalized_query,
              query_type: slowQuery.query_type,
              table_name: slowQuery.table_name,
              mean_time_ms: slowQuery.mean_time_ms,
              threshold_ms: alert.threshold_ms,
              fire_count: alert.fire_count,
              call_count: slowQuery.call_count,
              max_time_ms: slowQuery.max_time_ms,
            },
          },
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      // Store PagerDuty incident ID
      if (response.data && response.data.dedup_key) {
        await alert.update({
          pagerduty_incident_id: response.data.dedup_key,
        });
      }

      this.logger.info(`PagerDuty alert sent for slow query ${slowQuery.id}: ${dedupKey}`);
      return response.data;
    } catch (err) {
      this.logger.error('Failed to send PagerDuty alert:', err.message);
      return null;
    }
  }

  /**
   * Acknowledge an alert.
   */
  async acknowledgeAlert(alertId, acknowledgedBy) {
    const alert = await SlowQueryAlert.findByPk(alertId);
    if (!alert) {
      throw new Error(`Alert not found: ${alertId}`);
    }

    await alert.update({
      acknowledged: true,
      acknowledged_by: acknowledgedBy,
      acknowledged_at: new Date(),
    });

    return alert;
  }

  /**
   * Get alert statistics.
   */
  async getAlertStats() {
    const now = new Date();
    const windowStart = new Date(now.getTime() - FIRE_WINDOW_MS);

    const [totalAlerts, recentAlerts, unacknowledged] = await Promise.all([
      SlowQueryAlert.count(),
      SlowQueryAlert.count({
        where: {
          last_fired_at: { [Op.gte]: windowStart },
        },
      }),
      SlowQueryAlert.count({
        where: { acknowledged: false },
      }),
    ]);

    return {
      totalAlerts,
      recentAlerts,
      unacknowledged,
      windowMs: FIRE_WINDOW_MS,
      thresholds: THRESHOLDS,
    };
  }
}

module.exports = SlowQueryAlertEngine;
