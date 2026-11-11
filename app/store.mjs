import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, request_key TEXT UNIQUE, parent INTEGER UNIQUE REFERENCES messages(id),
        source TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
        image TEXT REFERENCES media(id), audio TEXT REFERENCES media(id),
        state TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    `);
  }

  transaction(run) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = run();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  putMedia(attachment) {
    if (!attachment) return null;
    const id = randomUUID();
    this.db.prepare('INSERT INTO media VALUES (?, ?, ?)').run(id, attachment.mime, attachment.bytes);
    return id;
  }

  insert({ source, role, text, image, audio, parent = null, requestKey = null, state }) {
    const row = this.db.prepare(`
      INSERT INTO messages (request_key, parent, source, role, text, image, audio, state, created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `).get(requestKey, parent, source, role, text, this.putMedia(image), this.putMedia(audio), state, Date.now());
    return row;
  }

  reserve(turn) {
    const existing = this.db.prepare('SELECT * FROM messages WHERE request_key = ?').get(turn.requestKey);
    if (existing) return { row: existing, fresh: false };
    const row = this.transaction(() => this.insert({ ...turn, role: 'user', state: 'pending' }));
    return { row, fresh: true };
  }

  setText(id, text) {
    this.db.prepare('UPDATE messages SET text = ? WHERE id = ?').run(text, id);
  }

  finish(id, reply) {
    return this.transaction(() => {
      const row = this.insert({ ...reply, role: 'assistant', parent: id, state: 'done' });
      this.db.prepare("UPDATE messages SET state = 'done' WHERE id = ?").run(id);
      return row;
    });
  }

  setAudio(id, audio) {
    this.transaction(() => {
      this.db.prepare('UPDATE messages SET audio = ? WHERE id = ?').run(this.putMedia(audio), id);
    });
  }

  note(id, error) {
    this.db.prepare('UPDATE messages SET error = ? WHERE id = ?').run(error, id);
  }

  fail(id, error) {
    this.db.prepare("UPDATE messages SET state = 'failed', error = ? WHERE id = ?").run(error, id);
  }

  recover() {
    this.db.prepare("UPDATE messages SET state = 'failed', error = ? WHERE state = 'pending'")
      .run('电脑服务重启，无法确认本轮是否完成。请检查记录后再发送。');
  }

  history(before = Number.MAX_SAFE_INTEGER) {
    return this.db.prepare(`
      SELECT id, parent, source, role, text, image, audio, state, error, created
      FROM messages WHERE id < ? ORDER BY id DESC LIMIT 60
    `).all(before).reverse();
  }

  getMedia(id) {
    return this.db.prepare('SELECT mime, bytes FROM media WHERE id = ?').get(id);
  }

  getSetting(key) {
    return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
  }

  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  close() {
    this.db.close();
  }
}
