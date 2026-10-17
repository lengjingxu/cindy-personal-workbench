(function () {
  var CHANNEL_NAME = 'personal-workbench';
  var LABELS = { ok: '正常', alert: '异常', pending: '待处理', unknown: '无法确认', unconnected: '未接入' };
  var AGENT_LABELS = { working: '在干活', finished: '刚交付', idle: '空闲', stuck: '卡住', unknown: '无法确认' };
  var SOURCE_LABELS = { scheduler: '定时', desktop: '桌面', bot: '伙伴', feishu: '飞书', x: 'X' };
  var isMain = document.body.classList.contains('layout-main');
  var state = { updatedAt: null, lines: [], decisions: [], agents: { updatedAt: null, list: [] }, tasks: { updatedAt: null, list: [] } };
  var taskFilter = 'all';
  var ch = null;
  try { ch = new BroadcastChannel(CHANNEL_NAME); } catch (e) { ch = null; }

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function agoText(iso) {
    if (!iso) return '还没有数据';
    var diff = Date.now() - new Date(iso).getTime();
    if (isNaN(diff)) return '更新于 ' + iso;
    var min = Math.round(diff / 60000);
    if (min < 1) return '刚刚更新';
    if (min < 60) return min + ' 分钟前更新';
    var h = Math.round(min / 60);
    if (h < 24) return h + ' 小时前更新';
    return Math.round(h / 24) + ' 天前更新';
  }

  function shortAgo(iso) {
    if (!iso) return '';
    var diff = Date.now() - new Date(iso).getTime();
    if (isNaN(diff)) return String(iso);
    var min = Math.round(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    var h = Math.round(min / 60);
    if (h < 24) return h + ' 小时前';
    return Math.round(h / 24) + ' 天前';
  }

  function taskState(t, now) {
    var activeStart = Number(t.activeTurnStartedAt) || 0;
    if (activeStart && now - activeStart < 15 * 60 * 1000) return 'running';
    if (Number(t.queued) > 0) return 'queued';
    if (Number(t.updatedAt) && now - Number(t.updatedAt) < 24 * 3600 * 1000) return 'recent';
    return 'stale';
  }

  function renderStats() {
    var box = $('wb-stats');
    if (!box) return;
    box.textContent = '';
    var now = Date.now();
    var decisions = (state.decisions || []).length;
    var working = (state.agents.list || []).filter(function (a) { return a.status === 'working'; }).length;
    var running = (state.tasks.list || []).filter(function (t) { return taskState(t, now) === 'running'; }).length;
    var alertLines = (state.lines || []).filter(function (l) { return l.status === 'alert'; }).length;
    var items = [
      { value: decisions, label: '待你拍板', cls: decisions ? 'pending' : '' },
      { value: running, label: '任务在跑', cls: running ? 'run' : '' },
      { value: working, label: '伙伴在干活', cls: '' },
      { value: alertLines, label: '业务线异常', cls: alertLines ? 'alert' : '' }
    ];
    items.forEach(function (it) {
      var card = el('div', 'wb-stat ' + it.cls);
      card.appendChild(el('div', 'wb-stat-value', String(it.value)));
      card.appendChild(el('div', 'wb-stat-label', it.label));
      box.appendChild(card);
    });
  }

  function renderDecisions() {
    var box = $('wb-decisions');
    if (!box) return;
    var count = $('wb-dcount');
    box.textContent = '';
    var list = state.decisions || [];
    if (count) count.textContent = list.length ? '（' + list.length + '）' : '';
    if (!list.length) {
      box.appendChild(el('div', 'wb-empty', '现在没有需要你拍板的事。巡检发现费用、对外承诺、方向取舍这类问题时才会出现在这里。'));
      return;
    }
    list.forEach(function (d) {
      var card = el('div', 'wb-card pending');
      card.appendChild(el('div', 'wb-title', d.title || '待决定'));
      if (d.why) card.appendChild(el('div', 'wb-why', d.why));
      if (d.options && d.options.length) {
        var opts = el('div', 'wb-options');
        d.options.forEach(function (o) { opts.appendChild(el('span', 'wb-option', o)); });
        card.appendChild(opts);
      }
      var meta = el('div', 'wb-meta');
      if (d.deadline) meta.appendChild(el('span', null, '截止 ' + d.deadline));
      if (d.source) meta.appendChild(el('span', null, '来源 ' + d.source));
      if (meta.childNodes.length) card.appendChild(meta);

      var actions = el('div', 'wb-actions');
      var btn = el('button', 'wb-btn', '已处理');
      btn.type = 'button';
      btn.addEventListener('click', function () { markDone(d.id, btn); });
      actions.appendChild(btn);
      card.appendChild(actions);
      box.appendChild(card);
    });
  }

  function agentRow(a) {
    var row = el('div', 'wb-agent' + (a.liveState === 'running' ? ' live' : ''));
    var nameBox = el('div', 'wb-agent-name', a.name);
    if (a.device) nameBox.appendChild(el('div', 'wb-agent-device', a.device));
    row.appendChild(nameBox);

    var status = el('div', 'wb-status ' + (a.status || 'unknown'));
    status.appendChild(el('span', 'wb-dot'));
    status.appendChild(el('span', null, AGENT_LABELS[a.status] || '无法确认'));
    row.appendChild(status);

    var body = el('div', 'wb-agent-body');
    body.appendChild(el('div', null, a.progress || '还没有进度记录'));
    var bits = [];
    if (a.task) bits.push('任务：' + a.task);
    if (a.at) bits.push('更新：' + shortAgo(a.at));
    if (bits.length) body.appendChild(el('div', 'wb-agent-meta', bits.join('　')));
    row.appendChild(body);
    return row;
  }

  function renderAgents() {
    var box = $('wb-agents');
    if (!box) return;
    var count = $('wb-acount');
    box.textContent = '';
    var list = (state.agents && state.agents.list) || [];
    var order = { working: 0, stuck: 1, finished: 2, unknown: 3, idle: 4 };
    var sorted = list.slice().sort(function (a, b) {
      var d = (order[a.status] == null ? 9 : order[a.status]) - (order[b.status] == null ? 9 : order[b.status]);
      return d !== 0 ? d : String(a.name).localeCompare(String(b.name));
    });

    if (!sorted.length) {
      box.appendChild(el('div', 'wb-empty', '还没有伙伴数据。'));
      if (count) count.textContent = '';
      return;
    }

    var show = sorted;
    var hidden = 0;
    if (!isMain) {
      show = sorted.filter(function (a) { return a.status === 'working' || a.status === 'stuck' || a.status === 'finished'; }).slice(0, 5);
      hidden = sorted.length - show.length;
    }
    if (count) count.textContent = isMain ? '（' + sorted.length + '）' : (show.length ? '（' + show.length + '）' : '');

    if (!show.length) {
      box.appendChild(el('div', 'wb-empty', '现在没有伙伴在干活，' + hidden + ' 个伙伴空闲。'));
      return;
    }
    show.forEach(function (a) { box.appendChild(agentRow(a)); });
    if (hidden > 0) box.appendChild(el('div', 'wb-hint', '另有 ' + hidden + ' 个伙伴空闲。'));
  }

  function renderLines() {
    var box = $('wb-lines');
    if (!box) return;
    var count = $('wb-lcount');
    box.textContent = '';
    var list = state.lines || [];
    if (count) count.textContent = list.length ? '（' + list.length + '）' : '';
    if (!list.length) {
      box.appendChild(el('div', 'wb-empty', '还没有接入任何业务线。第一批接入的是睿钛公司业务和 Cindy 技术交付。'));
      return;
    }
    var order = { alert: 0, pending: 1, unknown: 2, ok: 3, unconnected: 4 };
    list.slice().sort(function (a, b) {
      var d = (order[a.status] == null ? 9 : order[a.status]) - (order[b.status] == null ? 9 : order[b.status]);
      return d !== 0 ? d : String(a.name).localeCompare(String(b.name));
    }).forEach(function (l) {
      var row = el('div', 'wb-line');
      row.appendChild(el('div', 'wb-line-name', l.name));
      var status = el('div', 'wb-status ' + (l.status || 'unknown'));
      status.appendChild(el('span', 'wb-dot'));
      status.appendChild(el('span', null, LABELS[l.status] || '无法确认'));
      row.appendChild(status);
      var body = el('div', 'wb-line-body');
      body.appendChild(el('div', null, l.summary || ''));
      var bits = [];
      if (l.owner) bits.push('在处理：' + l.owner);
      if (l.evidence) bits.push('证据：' + l.evidence);
      if (l.checkedAt) bits.push('核实：' + fmtTime(l.checkedAt));
      if (bits.length) body.appendChild(el('div', 'wb-line-meta', bits.join('　')));
      row.appendChild(body);
      box.appendChild(row);
    });
  }

  function renderTaskFilters() {
    var box = $('wb-tfilters');
    if (!box) return;
    var now = Date.now();
    var list = (state.tasks && state.tasks.list) || [];
    var counts = {
      all: list.length,
      running: list.filter(function (t) { return taskState(t, now) === 'running'; }).length,
      queued: list.filter(function (t) { return taskState(t, now) === 'queued'; }).length,
      recent: list.filter(function (t) { return taskState(t, now) === 'recent'; }).length,
      stale: list.filter(function (t) { return taskState(t, now) === 'stale'; }).length
    };
    var defs = [
      ['all', '全部'], ['running', '正在跑'], ['queued', '排队中'], ['recent', '一天内'], ['stale', '停着']
    ];
    box.textContent = '';
    defs.forEach(function (d) {
      var btn = el('button', 'wb-filter' + (taskFilter === d[0] ? ' active' : ''), d[1] + ' ' + (counts[d[0]] || 0));
      btn.type = 'button';
      btn.addEventListener('click', function () { taskFilter = d[0]; renderTasks(); });
      box.appendChild(btn);
    });
  }

  function renderTasks() {
    var box = $('wb-tasks');
    if (!box) return;
    renderTaskFilters();
    var count = $('wb-tcount');
    var now = Date.now();
    var all = (state.tasks && state.tasks.list) || [];
    var list = all.filter(function (t) {
      if (taskFilter === 'all') return true;
      return taskState(t, now) === taskFilter;
    });
    var weight = { running: 0, queued: 1, recent: 2, stale: 3 };
    list = list.slice().sort(function (a, b) {
      var d = weight[taskState(a, now)] - weight[taskState(b, now)];
      if (d !== 0) return d;
      return Number(b.updatedAt) - Number(a.updatedAt);
    }).slice(0, 40);

    if (count) count.textContent = all.length ? '（' + all.length + '）' : '';
    box.textContent = '';
    if (!list.length) {
      box.appendChild(el('div', 'wb-empty', '这里没有符合筛选的任务。'));
      return;
    }
    list.forEach(function (t) {
      var st = taskState(t, now);
      var card = el('div', 'wb-task ' + st);
      var titleRow = el('div', 'wb-task-title');
      titleRow.appendChild(el('span', 'dash'));
      titleRow.appendChild(el('span', null, t.title || '未命名任务'));
      card.appendChild(titleRow);

      var meta = el('div', 'wb-task-meta');
      if (t.project) meta.appendChild(el('span', 'wb-tag', t.project));
      meta.appendChild(el('span', 'wb-tag', SOURCE_LABELS[t.source] || t.source || '其它'));
      meta.appendChild(el('span', null, shortAgo(new Date(Number(t.updatedAt)).toISOString())));
      if (t.model) meta.appendChild(el('span', null, t.model));
      if (t.messageCount) meta.appendChild(el('span', null, t.messageCount + ' 条消息'));
      if (st === 'running') meta.appendChild(el('span', null, '正在跑'));
      if (st === 'queued') meta.appendChild(el('span', null, '排队 ' + t.queued + ' 条'));
      card.appendChild(meta);
      box.appendChild(card);
    });
  }

  function renderAll() {
    if ($('wb-sub')) $('wb-sub').textContent = agoText(state.tasks && state.tasks.updatedAt ? new Date(Number(state.tasks.updatedAt)).toISOString() : state.updatedAt);
    renderStats();
    renderDecisions();
    renderAgents();
    renderLines();
    renderTasks();
  }

  function applyState(next) {
    if (!next) return;
    state = {
      updatedAt: next.updatedAt || null,
      lines: next.lines || [],
      decisions: next.decisions || [],
      agents: next.agents || { updatedAt: null, list: [] },
      tasks: next.tasks || { updatedAt: null, list: [] }
    };
    renderAll();
  }

  function applyLive(m) {
    if (!m || !m.agentId) return;
    var list = (state.agents && state.agents.list) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].botId === m.agentId) {
        list[i].liveState = m.phase === 'running' ? 'running' : 'done';
        list[i].liveAt = m.at;
        if (m.phase === 'running') list[i].status = 'working';
        else if (list[i].status === 'working') list[i].status = 'finished';
        renderAgents();
        renderStats();
        return;
      }
    }
  }

  async function loadFromKv() {
    try {
      var res = await fetch('/kv');
      var data = await res.json();
      if (data && data.workbench) applyState(data.workbench);
      else renderAll();
    } catch (e) {
      renderAll();
    }
  }

  function waitFor(reqId, timeoutMs) {
    return new Promise(function (resolve) {
      var timer = setTimeout(function () { resolve(false); }, timeoutMs);
      var handler = function (ev) {
        var m = ev && ev.data;
        if (!m || m.from !== 'workbench-brain' || m.reqId !== reqId) return;
        clearTimeout(timer);
        if (ch) ch.removeEventListener('message', handler);
        resolve(true);
      };
      if (ch) ch.addEventListener('message', handler);
    });
  }

  async function markDone(id, btn) {
    if (!id) return;
    btn.disabled = true;
    var reqId = 'r' + Date.now() + Math.random().toString(36).slice(2, 7);
    try { await fetch('/wake'); } catch (e) { /* brain may already run */ }
    var ok = false;
    for (var i = 0; i < 12 && !ok; i++) {
      if (ch) ch.postMessage({ from: 'workbench-page', action: 'mark-done', id: id, reqId: reqId });
      ok = await waitFor(reqId, 400);
    }
    btn.disabled = false;
    if (ok) {
      btn.textContent = '已移出';
      btn.classList.add('done');
      state.decisions = (state.decisions || []).filter(function (d) { return d.id !== id; });
      renderDecisions();
      renderStats();
    } else {
      btn.textContent = '再试一次';
    }
  }

  async function kickScan() {
    try { await fetch('/wake'); } catch (e) { /* brain may already run */ }
    if (ch) ch.postMessage({ from: 'workbench-page', action: 'scan', reqId: 's' + Date.now() });
  }

  var refresh = $('wb-refresh');
  if (refresh) refresh.addEventListener('click', function () { loadFromKv(); kickScan(); });

  if (ch) {
    ch.addEventListener('message', function (ev) {
      var m = ev && ev.data;
      if (!m || m.from !== 'workbench-brain') return;
      if (m.state) applyState(m.state);
      if (m.type === 'live') applyLive(m);
    });
  }

  loadFromKv();
  kickScan();
})();
