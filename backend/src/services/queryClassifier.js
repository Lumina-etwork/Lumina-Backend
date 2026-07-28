/**
 * QueryClassifier - Normalizes raw SQL queries, extracts query type,
 * table name, and application name for classification.
 *
 * Issue #49: PostgreSQL Query Performance Monitoring and Slow Query Alerting
 */

const { SlowQuery } = require('../models');

class QueryClassifier {
  /**
   * Classify a raw query into a normalized form with extracted metadata.
   */
  classify({ rawQuery, queryId, calls, meanTimeMs, totalTimeMs, stddevTimeMs, minTimeMs, maxTimeMs }) {
    const normalizedQuery = this.normalizeQuery(rawQuery);
    const queryType = this.extractQueryType(rawQuery);
    const tableName = this.extractTableName(rawQuery);
    const applicationName = this.extractApplicationName(rawQuery);

    return {
      normalizedQuery,
      rawQuery: rawQuery || null,
      queryType,
      tableName: tableName || null,
      applicationName: applicationName || null,
      queryId,
      calls: calls || 0,
      meanTimeMs: meanTimeMs || 0,
      totalTimeMs: totalTimeMs || 0,
      stddevTimeMs: stddevTimeMs || 0,
      minTimeMs: minTimeMs || 0,
      maxTimeMs: maxTimeMs || 0,
    };
  }

  /**
   * Normalize a SQL query by removing literals and parameter values.
   * Replaces string literals, numbers, and IN-list values with placeholders.
   */
  normalizeQuery(query) {
    if (!query) return '';

    let normalized = query
      .trim()
      // Replace string literals
      .replace(/'[^']*'/g, "'?'")
      // Replace numeric literals (but not within identifiers)
      .replace(/\b\d+(\.\d+)?\b/g, '?')
      // Collapse multiple whitespace
      .replace(/\s+/g, ' ')
      .trim();

    return normalized;
  }

  /**
   * Extract the primary SQL query type (SELECT, INSERT, UPDATE, DELETE).
   */
  extractQueryType(query) {
    if (!query) return 'OTHER';

    const trimmed = query.trim().toUpperCase();

    // Check for CTEs (WITH ... SELECT/INSERT/UPDATE/DELETE)
    const cteMatch = trimmed.match(/^WITH\s+.+?\b(SELECT|INSERT|UPDATE|DELETE)\b/i);
    if (cteMatch) {
      return cteMatch[1].toUpperCase();
    }

    if (trimmed.startsWith('SELECT')) return 'SELECT';
    if (trimmed.startsWith('INSERT')) return 'INSERT';
    if (trimmed.startsWith('UPDATE')) return 'UPDATE';
    if (trimmed.startsWith('DELETE')) return 'DELETE';
    if (trimmed.startsWith('CREATE')) return 'CREATE';
    if (trimmed.startsWith('ALTER')) return 'ALTER';
    if (trimmed.startsWith('DROP')) return 'DROP';
    if (trimmed.startsWith('TRUNCATE')) return 'TRUNCATE';
    if (trimmed.startsWith('EXPLAIN')) return 'EXPLAIN';

    return 'OTHER';
  }

  /**
   * Extract the primary table name from a SQL query.
   */
  extractTableName(query) {
    if (!query) return null;

    const trimmed = query.trim().toUpperCase();

    // FROM clause
    const fromMatch = trimmed.match(/FROM\s+["]?(\w+)["]?/i);
    if (fromMatch) return fromMatch[1].toLowerCase();

    // JOIN clause
    const joinMatch = trimmed.match(/JOIN\s+["]?(\w+)["]?/i);
    if (joinMatch) return joinMatch[1].toLowerCase();

    // INSERT INTO
    const insertMatch = trimmed.match(/INSERT\s+INTO\s+["]?(\w+)["]?/i);
    if (insertMatch) return insertMatch[1].toLowerCase();

    // UPDATE
    const updateMatch = trimmed.match(/UPDATE\s+["]?(\w+)["]?/i);
    if (updateMatch) return updateMatch[1].toLowerCase();

    // DELETE FROM
    const deleteMatch = trimmed.match(/DELETE\s+FROM\s+["]?(\w+)["]?/i);
    if (deleteMatch) return deleteMatch[1].toLowerCase();

    return null;
  }

  /**
   * Extract application name from query comments or context.
   * PostgreSQL supports application_name via SET or comment hints.
   */
  extractApplicationName(query) {
    if (!query) return null;

    // Check for application_name comment hint: /* app:myapp */
    const appMatch = query.match(/\/\*\s*app:\s*(\S+)\s*\*\//i);
    if (appMatch) return appMatch[1];

    return null;
  }

  /**
   * Persist classified query metrics to the slow_queries table,
   * updating running statistics for existing entries.
   */
  async persistClassified(classifiedEntries) {
    const results = [];

    for (const entry of classifiedEntries) {
      try {
        const [record, created] = await SlowQuery.findOrCreate({
          where: { normalized_query: entry.normalizedQuery },
          defaults: {
            normalized_query: entry.normalizedQuery,
            raw_query: entry.rawQuery || null,
            query_type: entry.queryType,
            table_name: entry.tableName,
            application_name: entry.applicationName,
            call_count: entry.calls,
            mean_time_ms: entry.meanTimeMs,
            total_time_ms: entry.totalTimeMs,
            stddev_time_ms: entry.stddevTimeMs,
            min_time_ms: entry.minTimeMs,
            max_time_ms: entry.maxTimeMs,
            last_seen: new Date(),
            first_seen: new Date(),
          },
        });

        if (!created) {
          // Update running statistics using Welford's online algorithm for mean/stddev
          const n1 = record.call_count;
          const n2 = entry.calls;
          const n = n1 + n2;

          const mean1 = record.mean_time_ms;
          const mean2 = entry.meanTimeMs;

          // Combined mean
          const combinedMean = ((n1 * mean1) + (n2 * mean2)) / n;

          // Combined stddev using Welford's approach
          const var1 = Math.pow(record.stddev_time_ms, 2);
          const var2 = Math.pow(entry.stddevTimeMs, 2);
          const combinedVar = (
            (n1 - 1) * var1 +
            (n2 - 1) * var2 +
            (n1 * n2 / n) * Math.pow(mean1 - mean2, 2)
          ) / (n - 1);

          await record.update({
            call_count: n,
            mean_time_ms: combinedMean,
            total_time_ms: record.total_time_ms + entry.totalTimeMs,
            stddev_time_ms: Math.sqrt(Math.max(0, combinedVar)),
            min_time_ms: Math.min(record.min_time_ms, entry.minTimeMs),
            max_time_ms: Math.max(record.max_time_ms, entry.maxTimeMs),
            last_seen: new Date(),
            table_name: entry.tableName || record.table_name,
            application_name: entry.applicationName || record.application_name,
          });
        }

        results.push({ id: record.id, created });
      } catch (err) {
        console.error('Failed to persist classified query:', err.message);
      }
    }

    return results;
  }
}

module.exports = QueryClassifier;
