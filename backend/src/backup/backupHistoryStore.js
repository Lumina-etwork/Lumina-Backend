const fs = require("fs");
const path = require("path");

/**
 * Local JSONL history store for backup verification reports.
 *
 * Each run (backup, integrity verification, restore test) appends one JSON
 * line, keeping a lightweight, dependency-free audit trail that does not
 * require a schema migration. The newest entries are kept up to
 * `maxEntries`; older entries are pruned.
 */
class BackupHistoryStore {
  constructor({ dir, fileName = "verification-history.jsonl", maxEntries = 500 }) {
    this.dir = dir;
    this.filePath = path.join(dir, fileName);
    this.maxEntries = maxEntries;
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  append(entry) {
    this.ensureDir();
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    this.prune();
    return entry;
  }

  list(limit = 50) {
    if (!fs.existsSync(this.filePath)) return [];
    const lines = fs.readFileSync(this.filePath, "utf8").split("\n");
    const entries = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // Skip corrupt lines rather than failing the whole history.
      }
    }
    return entries.slice(-limit).reverse();
  }

  latest() {
    return this.list(1)[0] || null;
  }

  prune() {
    if (!fs.existsSync(this.filePath)) return;
    const lines = fs
      .readFileSync(this.filePath, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    if (lines.length <= this.maxEntries) return;
    fs.writeFileSync(this.filePath, `${lines.slice(-this.maxEntries).join("\n")}\n`, "utf8");
  }
}

module.exports = { BackupHistoryStore };
