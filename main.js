
const CHANNEL_NAME = 'personal-workbench';
const EMPTY = { updatedAt: null, lines: [], decisions: [], agents: { updatedAt: null, list: [] }, tasks: { updatedAt: null, list: [] } };

const ch = (function () {
  try { return new BroadcastChannel(CHANNEL_NAME); } catch (e) { return null; }
})();

const live = {};

function slug(text) {
  let h = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) % 2147483647; }
  return 'd' + h.toString(36);
}

async function readAll() {
  try {
    const res = await fetch('/kv');
    const data = await res.json();
    return (data && typeof data === 'object') ? data : {};
  } catch (e) {
    return {};
  }
}

async function writeAll(data) {
  try {
    const res = await fetch('/kv', { method: 'PUT', body: JSON.stringify(data) });
    return !!(res && (res.ok || res.status === 204));
  } catch (e) {
    return false;
  }
}

function currentState(all) {
  const wb = all && all.workbench;
  const base = JSON.parse(JSON.stringify(EMPTY));
  if (!wb || typeof wb !== 'object') return base;
  const agents = wb.agents && typeof wb.agents === 'object' ? wb.agents : base.agents;
  const tasks = wb.tasks && typeof wb.tasks === 'object' ? wb.tasks : base.tasks;
  return {
    updatedAt: wb.updatedAt || null,
    lines: Array.isArray(wb.lines) ? wb.lines : [],
    decisions: Array.isArray(wb.decisions) ? wb.decisions : [],
    agents: {
      updatedAt: agents.updatedAt || null,
      list: Array.isArray(agents.list) ? agents.list : []
    },
    tasks: {
      updatedAt: tasks.updatedAt || null,
      list: Array.isArray(tasks.list) ? tasks.list : []
    }
  };
}

const STATUSES = ['ok', 'alert', 'pending', 'unknown', 'unconnected'];

function normalizeLine(raw) {
  const line = raw || {};
  const status = STATUSES.indexOf(line.status) >= 0 ? line.status : 'unknown';
  return {
    name: String(line.name || '').trim() || '未命名业务线',
    status: status,
    summary: String(line.summary || '').trim(),
    owner: String(line.owner || '').trim(),
    evidence: String(line.evidence || '').trim(),
    checkedAt: String(line.checkedAt || '').trim() || new Date().toISOString()
  };
}

function normalizeDecision(raw) {
  const d = raw || {};
  const title = String(d.title || '').trim();
  return {
    id: slug(title),
    title: title,
    why: String(d.why || '').trim(),
    options: Array.isArray(d.options) ? d.options.map(function (o) { return String(o); }) : [],
    deadline: String(d.deadline || '').trim(),
    source: String(d.source || '').trim(),
    addedAt: new Date().toISOString()
  };
}

const AGENT_STATUSES = ['working', 'finished', 'idle', 'stuck', 'unknown'];

function normalizeAgent(raw, prev) {
  const a = raw || {};
  const status = AGENT_STATUSES.indexOf(a.status) >= 0 ? a.status : (prev && prev.status) || 'unknown';
  const sessions = Array.isArray(a.sessions) ? a.sessions.map(String)
    : (prev && Array.isArray(prev.sessions) ? prev.sessions : []);
  return {
    name: String(a.name || (prev && prev.name) || '').trim() || '未命名伙伴',
    botId: String(a.botId || (prev && prev.botId) || '').trim(),
    device: String(a.device || (prev && prev.device) || '').trim(),
    status: status,
    progress: String(a.progress || '').trim() || (prev && prev.progress) || '',
    task: String(a.task || '').trim() || (prev && prev.task) || '',
    sessions: sessions,
    at: String(a.at || '').trim() || new Date().toISOString()
  };
}

function broadcast(payload) {
  if (!ch) return;
  try { ch.postMessage(payload); } catch (e) { /* page closed */ }
}

function sameSummary(a, b) {
  return (a && b) ? (a.status === b.status && a.summary === b.summary) : false;
}

function findAgentBySession(state, sessionId) {
  if (!sessionId) return null;
  for (const a of state.agents.list) {
    if (a.sessions && a.sessions.indexOf(sessionId) >= 0) return a;
  }
  return null;
}

async function publish(args) {
  const all = await readAll();
  const prev = currentState(all);
  const prevByName = {};
  prev.lines.forEach(function (l) { prevByName[l.name] = l; });

  const lines = Array.isArray(args.lines) && args.lines.length
    ? args.lines.map(normalizeLine)
    : prev.lines;

  const alerts = lines.filter(function (l) {
    if (l.status !== 'alert' && l.status !== 'unknown') return false;
    return !sameSummary(prevByName[l.name], l);
  });

  const decisions = prev.decisions.slice();
  const known = {};
  decisions.forEach(function (d) { known[d.id] = true; });
  const added = [];
  const incoming = Array.isArray(args.decisions) ? args.decisions.map(normalizeDecision) : [];
  incoming.forEach(function (d) {
    if (!d.title || known[d.id]) return;
    known[d.id] = true;
    decisions.push(d);
    added.push(d);
  });

  const state = {
    updatedAt: new Date().toISOString(),
    lines: lines,
    decisions: decisions,
    agents: prev.agents
  };

  const saved = await writeAll(Object.assign({}, all, { workbench: state }));

  if (added.length || alerts.length) {
    const parts = [];
    if (added.length) parts.push(added.length + ' 件待你拍板');
    if (alerts.length) parts.push(alerts.length + ' 条线不正常');
    const detail = added.length ? added[0].title : alerts[0].name;
    await cindy.send({
      type: 'notify',
      text: '工作台：' + parts.join('，') + '。' + String(detail || '').slice(0, 60),
      tone: alerts.length ? 'warning' : 'info'
    });
    await cindy.send({ type: 'badge', unread: true, summary: parts.join('，') });
  }

  broadcast({ from: 'workbench-brain', type: 'state', state: state });

  return {
    ok: saved,
    updatedAt: state.updatedAt,
    lineCount: lines.length,
    newDecisions: added.map(function (d) { return { id: d.id, title: d.title }; }),
    newAlerts: alerts.map(function (l) { return { name: l.name, status: l.status, summary: l.summary }; }),
    notified: !!(added.length || alerts.length)
  };
}

async function publishAgents(args) {
  const all = await readAll();
  const state = currentState(all);
  const byId = {};
  state.agents.list.forEach(function (a, i) {
    byId[a.botId || a.name] = i;
  });

  const incoming = Array.isArray(args.agents) ? args.agents : [];
  let updated = 0;
  incoming.forEach(function (raw) {
    const key = String(raw.botId || raw.name || '').trim();
    if (!key) return;
    const idx = byId[key];
    const prev = idx == null ? null : state.agents.list[idx];
    const merged = normalizeAgent(raw, prev);
    if (idx == null) {
      state.agents.list.push(merged);
    } else {
      state.agents.list[idx] = merged;
    }
    updated++;
  });

  state.agents.updatedAt = new Date().toISOString();
  state.updatedAt = state.updatedAt || state.agents.updatedAt;

  const saved = await writeAll(Object.assign({}, all, { workbench: state }));
  broadcast({ from: 'workbench-brain', type: 'state', state: state });

  return {
    ok: saved,
    updated: updated,
    total: state.agents.list.length,
    agents: state.agents.list.map(function (a) { return { name: a.name, status: a.status, at: a.at }; })
  };
}

async function markDone(id) {
  const all = await readAll();
  const state = currentState(all);
  const before = state.decisions.length;
  state.decisions = state.decisions.filter(function (d) { return d.id !== id; });
  const removed = before !== state.decisions.length;
  await writeAll(Object.assign({}, all, { workbench: state }));
  broadcast({ from: 'workbench-brain', type: 'state', state: state });
  return { ok: removed, remaining: state.decisions.length };
}

async function applyLiveEvent(sessionId, phase) {
  const all = await readAll();
  const state = currentState(all);
  const agent = findAgentBySession(state, sessionId);
  const at = new Date().toISOString();

  live[sessionId] = { state: phase, at: at, botId: agent ? agent.botId : '' };

  if (agent) {
    agent.status = phase === 'running' ? 'working' : agent.status === 'working' ? 'finished' : agent.status;
    agent.liveAt = at;
    agent.liveState = phase;
    const idx = state.agents.list.findIndex(function (a) { return a.botId && a.botId === agent.botId; });
    if (idx >= 0) state.agents.list[idx] = agent;
    await writeAll(Object.assign({}, all, { workbench: state }));
  }

  broadcast({
    from: 'workbench-brain',
    type: 'live',
    sessionId: sessionId,
    phase: phase,
    at: at,
    agentName: agent ? agent.name : '',
    agentId: agent ? agent.botId : ''
  });
}

cindy.onHostMessage(async function (msg) {
  if (msg.type === 'event') {
    const name = msg.name || '';
    const data = msg.data || {};
    const sessionId = data.sessionId || '';
    if (name === 'did-turn-start') await applyLiveEvent(sessionId, 'running');
    else if (name === 'did-turn-end') await applyLiveEvent(sessionId, 'done');
    return;
  }

  if (msg.type !== 'tool-call') return;

  try {
    if (msg.tool === 'workbench_get_state') {
      const all = await readAll();
      const state = currentState(all);
      await cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: state });
      return;
    }

    if (msg.tool === 'workbench_publish') {
      const result = await publish(msg.args || {});
      await cindy.send({ type: 'tool-result', callId: msg.callId, ok: result.ok, result: result });
      return;
    }

    if (msg.tool === 'workbench_publish_agents') {
      const result = await publishAgents(msg.args || {});
      await cindy.send({ type: 'tool-result', callId: msg.callId, ok: result.ok, result: result });
      return;
    }

    if (msg.tool === 'workbench_mark_done') {
      const result = await markDone(String((msg.args || {}).id || ''));
      await cindy.send({ type: 'tool-result', callId: msg.callId, ok: result.ok, result: result });
      return;
    }

    await cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      errorCode: 'UNKNOWN_TOOL',
      message: '工作台不认识这个工具：' + String(msg.tool)
    });
  } catch (err) {
    await cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      message: '工作台执行失败：' + (err && err.message ? err.message : String(err)) + '。可以重试一次；仍然失败请检查工作台页面能否打开。'
    });
  }
});

if (ch) {
  ch.onmessage = async function (ev) {
    const m = ev && ev.data;
    if (!m || m.from !== 'workbench-page') return;
    const all = await readAll();

    if (m.action === 'scan') {
      broadcast({ from: 'workbench-brain', type: 'state', reqId: m.reqId, state: currentState(all) });
      pollAgents();
      return;
    }

    if (m.action === 'state') {
      broadcast({ from: 'workbench-brain', type: 'state', reqId: m.reqId, state: currentState(all) });
      return;
    }

    if (m.action === 'mark-done') {
      const result = await markDone(String(m.id || ''));
      broadcast({ from: 'workbench-brain', type: 'done', reqId: m.reqId, ok: result.ok, remaining: result.remaining });
      return;
    }
  };
}

let pollTimer = null;
let scanFailures = 0;
let scanInFlight = false;

function statusFor(bot, now) {
  const activeStart = Number(bot.activeTurnStartedAt) || 0;
  const updated = Number(bot.updatedAt) || 0;
  if (activeStart && now - activeStart < 5 * 60 * 1000) return 'working';
  if (updated && now - updated < 2 * 60 * 60 * 1000) return 'finished';
  return 'idle';
}

async function applyAgentScan(scanned) {
  const all = await readAll();
  const state = currentState(all);
  const now = Date.now();
  const finishedNow = [];
  let changed = 0;

  for (const bot of (scanned.bots || [])) {
    const key = String(bot.botId || '');
    if (!key) continue;
    const idx = state.agents.list.findIndex(function (a) { return (a.botId || a.name) === key; });
    const prev = idx >= 0 ? state.agents.list[idx] : {};
    const status = statusFor(bot, now);
    if (prev.status === 'working' && status !== 'working' && bot.task) {
      finishedNow.push(bot.name + ' 刚结束：' + bot.task);
    }
    const message = String(bot.message || '');
    const merged = {
      name: bot.name || prev.name || key,
      botId: key,
      device: prev.device || '',
      status: status,
      progress: message.slice(0, 140) || prev.progress || '',
      task: bot.task || prev.task || '',
      sessions: [bot.sessionId].filter(Boolean)
        .concat((prev.sessions || []).filter(function (s) { return s !== bot.sessionId; }))
        .slice(0, 5),
      at: new Date(Number(bot.updatedAt) || now).toISOString(),
      activeTurnStartedAt: bot.activeTurnStartedAt ? new Date(Number(bot.activeTurnStartedAt)).toISOString() : ''
    };
    if (idx >= 0) state.agents.list[idx] = merged; else state.agents.list.push(merged);
    changed++;
  }

  if (!changed) return { changed: 0, finished: 0 };

  state.agents.updatedAt = new Date().toISOString();
  await writeAll(Object.assign({}, all, { workbench: state }));
  broadcast({ from: 'workbench-brain', type: 'state', state: state });

  if (finishedNow.length) {
    await cindy.send({ type: 'badge', unread: true, summary: finishedNow[0].slice(0, 78) });
  }

  for (const bot of (scanned.bots || [])) {
    if (String(bot.botId || '') && bot.updatedAt) await publishAgentEvent(bot, 'snapshot');
  }

  return { changed: changed, finished: finishedNow.length };
}

async function applyTaskScan(scanned) {
  const list = Array.isArray(scanned.tasks) ? scanned.tasks : [];
  if (!list.length) return { changed: 0 };
  const all = await readAll();
  const state = currentState(all);
  state.tasks = { updatedAt: new Date().toISOString(), list: list.slice(0, 80) };
  await writeAll(Object.assign({}, all, { workbench: state }));
  broadcast({ from: 'workbench-brain', type: 'state', state: state });
  return { changed: list.length };
}

async function pollAgents() {
  if (scanInFlight) return;
  scanInFlight = true;
  try {
    const res = await cindy.node.request({ method: 'agents/scan', params: {}, timeoutMs: 25000 });
    if (res && res.ok && res.result && res.result.ok) {
      scanFailures = 0;
      await applyAgentScan(res.result);
      await applyTaskScan(res.result);
    } else {
      scanFailures++;
    }
  } catch (e) {
    scanFailures++;
  } finally {
    scanInFlight = false;
  }
  const delay = scanFailures >= 3 ? 120000 : 20000;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(pollAgents, delay);
}

setTimeout(pollAgents, 1500);

cindy.send({ type: 'routine-request', action: 'status', status: 'listening' });

async function publishAgentEvent(bot, phase) {
  try {
    await cindy.send({
      type: 'routine-request',
      action: 'publish',
      event: {
        id: 'agent:' + bot.name + ':' + phase + ':' + bot.updatedAt,
        type: 'agent.activity',
        occurredAt: Number(bot.updatedAt) || Date.now(),
        subject: bot.sessionId || bot.name,
        data: { botId: bot.botId || bot.name, phase: phase, task: String(bot.task || '').slice(0, 120) }
      }
    });
  } catch (e) { /* 没有对接的例行任务时忽略 */ }
}

