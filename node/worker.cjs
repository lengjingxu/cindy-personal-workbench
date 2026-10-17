const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CINDY_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Cindy');

function findDb() {
  const candidates = [];
  let names = [];
  try { names = fs.readdirSync(CINDY_DIR); } catch (e) { return null; }
  for (const name of names) {
    if (!/^cindy-.*\.db$/.test(name)) continue;
    const full = path.join(CINDY_DIR, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile() && st.size > 1024 * 1024) candidates.push({ file: full, size: st.size });
    } catch (e) { /* skip */ }
  }
  candidates.sort((a, b) => b.size - a.size);
  return candidates.length ? candidates[0].file : null;
}

function botIdFromWorkdir(dirPath) {
  const m = String(dirPath || '').match(/\/bots\/(bot_[^/]+)\//);
  return m ? m[1] : '';
}

function looksLikeJson(s) {
  const t = String(s || '').trim();
  return t.startsWith('{') || t.startsWith('[');
}

function pluckText(value, depth) {
  if (depth > 3 || value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const t = pluckText(item, depth + 1);
      if (t) return t;
    }
    return '';
  }
  if (typeof value === 'object') {
    for (const key of ['text', 'content', 'message', 'summary', 'result', 'output', 'note']) {
      const t = pluckText(value[key], depth + 1);
      if (t) return t;
    }
  }
  return '';
}

function excerpt(text, max) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  if (looksLikeJson(s)) {
    try {
      s = pluckText(JSON.parse(s), 0);
    } catch (e) {
      s = '';
    }
  }
  if (!s) return '';
  s = s.replace(/[#*>\`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('.'));
  return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut + '…');
}

function scan() {
  const file = findDb();
  if (!file) return { ok: false, reason: 'NO_DB' };

  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) {
    return { ok: false, reason: 'NO_SQLITE_MODULE' };
  }

  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (e) {
    return { ok: false, reason: 'OPEN_FAILED', message: String(e && e.message) };
  }

  try {
    const names = {};
    for (const row of db.prepare('SELECT id, display_name FROM bot_profiles').all()) {
      names[row.id] = row.display_name;
    }

    const sessionRows = db.prepare(
      "SELECT id, title, working_dir, status, source, updated_at, active_turn_started_at, " +
      "last_turn_ended_at, list_message_count, model, list_preview " +
      "FROM sessions WHERE status != 'deleted' ORDER BY updated_at DESC LIMIT 90"
    ).all();

    const lastMsg = db.prepare(
      'SELECT content, created_at FROM messages WHERE session_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1'
    );
    const queueRow = db.prepare('SELECT payload FROM agent_input_queue_snapshots WHERE session_id = ?');

    const bots = [];
    const seen = {};
    const tasks = [];

    for (const s of sessionRows) {
      const botId = botIdFromWorkdir(s.working_dir);
      const updatedAt = Number(s.updated_at) || 0;
      const activeStart = Number(s.active_turn_started_at) || 0;
      const lastEnd = Number(s.last_turn_ended_at) || 0;
      const workdir = String(s.working_dir || '');

      if (botId) {
        if (seen[botId] && seen[botId].updatedAt >= updatedAt) continue;
        let message = '';
        try {
          const row = lastMsg.get(s.id, 'assistant');
          if (row && row.content) message = excerpt(row.content, 400);
        } catch (e) { /* ignore */ }
        seen[botId] = {
          botId: botId,
          name: names[botId] || botId,
          sessionId: s.id,
          task: String(s.title || ''),
          message: message,
          updatedAt: updatedAt,
          activeTurnStartedAt: activeStart,
          lastTurnEndedAt: lastEnd
        };
        continue;
      }

      let queued = 0;
      try {
        const q = queueRow.get(s.id);
        if (q && q.payload) {
          const parsed = JSON.parse(q.payload);
          if (Array.isArray(parsed)) queued = parsed.length;
        }
      } catch (e) { /* ignore */ }

      tasks.push({
        id: s.id,
        title: String(s.title || ''),
        project: workdir ? path.basename(workdir) : '',
        workdir: workdir,
        status: String(s.status || ''),
        source: String(s.source || ''),
        model: String(s.model || ''),
        messageCount: Number(s.list_message_count) || 0,
        queued: queued,
        updatedAt: updatedAt,
        activeTurnStartedAt: activeStart,
        lastTurnEndedAt: lastEnd,
        preview: excerpt(s.list_preview || '', 160)
      });
    }

    for (const botId of Object.keys(seen)) bots.push(seen[botId]);

    return { ok: true, scannedAt: Date.now(), bots: bots, tasks: tasks };
  } catch (e) {
    return { ok: false, reason: 'QUERY_FAILED', message: String(e && e.message) };
  } finally {
    try { db.close(); } catch (e) { /* ignore */ }
  }
}

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch (e) { return; }

  if (request.method === 'agents/scan' || request.method === 'status/scan') {
    reply({ jsonrpc: '2.0', id: request.id, result: scan() });
    return;
  }

  if (request.method === 'ping') {
    reply({ jsonrpc: '2.0', id: request.id, result: { ok: true, db: findDb() } });
    return;
  }

  reply({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
});
