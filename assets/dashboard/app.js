// agent-flow dashboard. Vanilla JS, no build step. Ticket text is agent-written (untrusted), so every
// value is written with textContent / attributes — never innerHTML.
(function () {
  "use strict";

  const TOKEN = document.querySelector('meta[name="flow-token"]').content;
  const DEFAULT_ACTOR = document.querySelector('meta[name="flow-actor"]').content;
  const STATUS_LABEL = {
    backlog: "Backlog", ready: "Ready", claimed: "Claimed", in_progress: "In progress",
    blocked: "Blocked", review: "Review", done: "Done", cancelled: "Cancelled",
  };
  const VIEWS = ["board", "review", "activity", "agents", "epics", "stats"];
  const state = {
    /** The hub: every registered project with its summary (GET /api/workspaces). */
    hub: null,
    /** The open project's id, or null on the Projects overview. */
    ws: null,
    meta: null,
    board: null,
    view: "board",
    selected: null,
    detail: null,
    events: [],
    lastSeq: 0,
    dragging: null,
    filter: "",
    swimlane: load("swimlane", "none"),
    showBacklog: load("showBacklog", "1") === "1",
    showDone: load("showDone", "1") === "1",
    actor: load("actor", DEFAULT_ACTOR),
  };

  // ───────────────────────── helpers ─────────────────────────
  function load(k, d) { try { return localStorage.getItem("af." + k) ?? d; } catch { return d; } }
  function save(k, v) { try { localStorage.setItem("af." + k, v); } catch { /* private mode */ } }
  function $(id) { return document.getElementById(id); }

  /** el(tag, {class, text, title, on:{click}, attrs...}, ...children) */
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = String(v);
        else if (k === "on") for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
        else if (k === "style") for (const [sk, sv] of Object.entries(v)) node.style.setProperty(sk, sv);
        else if (k === "dataset") for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
        else node.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return node;
  }
  function svg(tag, attrs, ...children) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "text") node.textContent = v;
      else if (k === "on") for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
      else node.setAttribute(k, String(v));
    }
    for (const c of children.flat()) if (c) node.appendChild(c);
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function scolor(status) { return `var(--s-${status})`; }
  function ago(iso) {
    if (!iso) return "";
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return `${Math.max(0, s)}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }
  function leaseText(iso) {
    if (!iso) return null;
    const m = Math.round((Date.parse(iso) - Date.now()) / 60000);
    return { text: m >= 0 ? `${m}m` : "expired", cls: m < 0 ? "expired" : m < 5 ? "low" : "" };
  }
  function initials(actor) {
    const name = String(actor || "?").split(":").pop() || "?";
    return name.replace(/[^a-z0-9]/gi, "").slice(0, 2) || "?";
  }
  function isHuman(actor) { return String(actor).startsWith("human:"); }

  function toast(text, kind) {
    const t = el("div", { class: `toast ${kind || ""}`, text });
    $("toasts").appendChild(t);
    setTimeout(() => t.remove(), kind === "error" ? 7000 : 3500);
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: Object.assign(
        { "content-type": "application/json", "x-flow-actor": state.actor },
        method === "GET" ? {} : { authorization: `Bearer ${TOKEN}` },
      ),
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = data.error || { message: res.statusText };
      const err = new Error(e.message + (e.next_steps && e.next_steps.length ? `\n→ ${e.next_steps.join("\n→ ")}` : ""));
      err.code = e.code;
      throw err;
    }
    return data;
  }
  /** The open project's API: /api/w/<id>/<rest>. */
  function wapi(method, rest, body) {
    if (!state.ws) return Promise.reject(new Error("no project selected"));
    return api(method, `/api/w/${encodeURIComponent(state.ws)}${rest}`, body);
  }
  function wsName(id) {
    const w = state.hub && state.hub.workspaces.find((x) => x.id === id);
    return w ? w.name : id;
  }
  async function act(fn, okText) {
    try {
      const r = await fn();
      if (okText) toast(okText, "ok");
      await refresh();
      return r;
    } catch (err) {
      toast(err.message, "error");
      return null;
    }
  }
  function ask(label, opts) {
    return new Promise((resolve) => {
      const input = opts && opts.multiline ? el("textarea", { rows: 4 }) : el("input", { type: "text" });
      if (opts && opts.value) input.value = opts.value;
      const extra = opts && opts.second ? el("input", { type: "text", placeholder: opts.second }) : null;
      const close = (v) => { $("modal").hidden = true; clear($("modal")); resolve(v); };
      const form = el("form", { class: "form", on: { submit: (e) => { e.preventDefault(); close(extra ? [input.value, extra.value] : input.value); } } },
        el("label", null, label, input),
        extra ? el("label", null, opts.second, extra) : null,
        el("div", { class: "actions" },
          el("button", { type: "button", class: "btn ghost", text: "Cancel", on: { click: () => close(null) } }),
          el("button", { type: "submit", class: "btn primary", text: (opts && opts.ok) || "OK" })),
      );
      clear($("modal")).appendChild(el("div", { class: "modal", role: "dialog" }, form));
      $("modal").hidden = false;
      input.focus();
    });
  }

  // ───────────────────────── data ─────────────────────────
  async function loadHub() {
    try {
      state.hub = await api("GET", "/api/workspaces");
      renderSwitcher();
    } catch (err) {
      toast(`cannot list projects: ${err.message}`, "error");
    }
  }
  let hubTimer = null;
  function scheduleHub() {
    clearTimeout(hubTimer);
    hubTimer = setTimeout(async () => { await loadHub(); if (state.view === "home") renderHome(); }, 700);
  }

  async function refresh() {
    if (!state.ws) { await loadHub(); render(); return; }
    if (!state.meta) { render(); return; }
    try {
      state.board = await wapi("GET", "/board");
      const review = state.board.columns.find((c) => c.status === "review");
      $("review-count").textContent = review && review.tickets.length ? String(review.tickets.length) : "";
      if (state.selected) {
        try { state.detail = await wapi("GET", `/tickets/${encodeURIComponent(state.selected)}`); } catch { state.detail = null; }
      }
      render();
    } catch (err) {
      toast(`refresh failed: ${err.message}`, "error");
    }
  }
  let refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 250);
  }

  /** One stream for every project; each event carries `workspace`, the project it happened in. */
  function connect() {
    const live = $("live");
    const es = new EventSource("/api/stream");
    let connectedOnce = false;
    es.addEventListener("hello", () => {
      live.className = "live on";
      $("live-text").textContent = "live";
      // After a reconnect, events may have been missed: reload what is on screen.
      if (connectedOnce) { scheduleHub(); if (state.ws) scheduleRefresh(); }
      connectedOnce = true;
    });
    es.addEventListener("flow", (msg) => {
      const e = JSON.parse(msg.data);
      const here = e.workspace === state.ws;
      if (["ticket.claimed", "ticket.approved", "ticket.rejected", "ticket.escalated", "lease.expired", "ticket.submitted"].includes(e.action)) {
        toast(`${here ? "" : `${wsName(e.workspace)} · `}${e.actor} · ${e.action.replace("ticket.", "")} · ${e.ticket_id || ""}`);
      }
      scheduleHub();
      if (!here) return;
      state.lastSeq = Math.max(state.lastSeq, e.seq);
      state.events.unshift(Object.assign(e, { fresh: true }));
      state.events = state.events.slice(0, 300);
      scheduleRefresh();
      if (state.view === "activity") renderActivity();
    });
    es.onerror = () => { live.className = "live off"; $("live-text").textContent = "reconnecting"; };
  }

  // ───────────────────────── filtering ─────────────────────────
  function matches(t) {
    const f = state.filter.trim().toLowerCase();
    if (!f) return true;
    return f.split(/\s+/).every((tok) => {
      if (tok.startsWith("@")) return (t.owner || "").toLowerCase().includes(tok.slice(1));
      if (tok.startsWith("#")) return t.labels.some((l) => l.toLowerCase().includes(tok.slice(1)));
      return t.id.includes(tok) || t.title.toLowerCase().includes(tok) || (t.parent || "").includes(tok);
    });
  }

  // ───────────────────────── board ─────────────────────────
  function card(t) {
    const lease = leaseText(t.lease_until);
    const pct = t.ac_total ? Math.round((100 * t.ac_verified) / t.ac_total) : 0;
    const node = el("article", {
      class: `card${state.selected === t.id ? " selected" : ""}`,
      draggable: "true",
      style: { "--sc": scolor(t.status) },
      dataset: { id: t.id, status: t.status },
      tabindex: "0",
      "aria-label": `${t.id} ${t.title}`,
      on: {
        click: () => openTicket(t.id),
        keydown: (e) => { if (e.key === "Enter") openTicket(t.id); },
        dragstart: (e) => { state.dragging = t; node.classList.add("dragging"); e.dataTransfer.setData("text/plain", t.id); e.dataTransfer.effectAllowed = "move"; highlightDrops(t.status); },
        dragend: () => { state.dragging = null; node.classList.remove("dragging"); highlightDrops(null); },
      },
    },
      el("div", { class: "card-top" },
        el("span", { class: "card-id", text: t.id }),
        el("span", { class: `chip ${t.priority}`, text: t.priority }),
        t.lane === "expedite" ? el("span", { class: "chip expedite", text: "expedite" }) : el("span", { class: "chip", text: t.type }),
        t.labels.includes("needs-human") ? el("span", { class: "chip human", text: "needs human" }) : null,
      ),
      el("div", { class: "card-title", text: t.title }),
      el("div", { class: "card-meta" },
        t.owner ? el("span", { class: "owner", title: t.owner },
          el("span", { class: `avatar${isHuman(t.owner) ? " human" : ""}`, text: initials(t.owner) }),
          lease ? el("span", { class: `lease ${lease.cls}`, text: lease.text, title: `lease until ${t.lease_until}` }) : null) : null,
        t.blocked_by.length ? el("span", { class: "chip blocked", text: `⛔ ${t.blocked_by.length}`, title: `waiting on ${t.blocked_by.join(", ")}` }) : null,
        t.ac_total ? el("span", { title: `${t.ac_verified}/${t.ac_total} acceptance criteria verified`, text: `AC ${t.ac_verified}/${t.ac_total}` }) : null,
        t.ac_total ? el("span", { class: "acbar" }, el("span", { style: { width: `${pct}%` } })) : null,
        ...t.labels.filter((l) => l !== "needs-human").slice(0, 2).map((l) => el("span", { class: "chip label", text: l })),
      ),
    );
    return node;
  }

  function allowedTarget(from, to) {
    if (!state.meta || from === to) return false;
    const map = { promote: "ready", demote: "backlog", claim: "claimed", start: "in_progress", release: "ready", block: "blocked",
      unblock: ["ready", "in_progress"], submit: "review", approve: "done", reject: "in_progress", close: "done", reopen: "ready", cancel: "cancelled" };
    return (state.meta.transitions[from] || []).some((a) => [].concat(map[a]).includes(to));
  }
  function highlightDrops(from) {
    document.querySelectorAll(".cell").forEach((c) => {
      c.classList.remove("drop-ok", "drop-no");
      if (from) c.classList.add(allowedTarget(from, c.dataset.status) ? "drop-ok" : "drop-no");
    });
  }

  async function dropOn(status) {
    const t = state.dragging;
    if (!t || t.status === status) return;
    const body = { to: status };
    if (status === "blocked") {
      const r = await ask(`Why is ${t.id} blocked?`, { second: "Unblock condition", ok: "Block" });
      if (!r) return;
      body.reason = r[0];
      body.unblock_condition = r[1];
    }
    if (t.status === "review" && status === "in_progress") {
      const r = await ask(`Reject ${t.id}: what must change?`, { multiline: true, ok: "Reject" });
      if (!r) return;
      body.reason = r;
    }
    if (t.status === "done" && status === "ready") {
      const r = await ask(`Reopen ${t.id}: why?`, { ok: "Reopen" });
      if (!r) return;
      body.reason = r;
    }
    await act(() => wapi("POST", `/tickets/${t.id}/move`, body), `${t.id} → ${STATUS_LABEL[status]}`);
  }

  function laneKey(t) {
    switch (state.swimlane) {
      case "lane": return t.lane;
      case "priority": return t.priority;
      case "epic": return t.parent || "(no epic)";
      case "owner": return t.owner || "(unowned)";
      default: return "";
    }
  }

  function renderBoard() {
    const root = clear($("view-board"));
    if (!state.board) return;
    const all = state.board.columns.map((c) => Object.assign({}, c, {
      tickets: c.tickets.filter((t) => t.type !== "epic").sort((a, b) => (c.status === "ready" ? a.blocked_by.length - b.blocked_by.length : 0)),
    }));
    const cols = all.filter((c) => (state.showBacklog || c.status !== "backlog") && (state.showDone || c.status !== "done"));
    const tickets = cols.flatMap((c) => c.tickets).filter((t) => t.type !== "epic" && matches(t));
    const board = el("div", { class: "board", style: { "grid-template-columns": `repeat(${cols.length}, 264px)` } });
    for (const c of cols) {
      const n = c.status === "in_progress" ? all.filter((x) => x.status === "claimed" || x.status === "in_progress").reduce((a, x) => a + x.tickets.length, 0) : c.tickets.length;
      const over = c.wip_limit && n > c.wip_limit;
      board.appendChild(el("div", { class: `col-head${over ? " over" : ""}` },
        el("span", { class: "swatch", style: { background: scolor(c.status) } }),
        STATUS_LABEL[c.status],
        el("span", { class: "wip", text: c.wip_limit ? `${c.tickets.length} · WIP ${n}/${c.wip_limit}` : String(c.tickets.length) })));
    }
    const lanes = [...new Set(tickets.map(laneKey))];
    const order = { expedite: 0, bug: 1, feature: 2, maintenance: 3 };
    lanes.sort((a, b) => (order[a] ?? 9) - (order[b] ?? 9) || String(a).localeCompare(String(b)));
    if (lanes.length === 0) lanes.push("");
    const epicTitles = Object.fromEntries(state.board.columns.flatMap((c) => c.tickets).filter((t) => t.type === "epic").map((t) => [t.id, t.title]));
    for (const lane of lanes) {
      const inLane = tickets.filter((t) => laneKey(t) === lane);
      if (state.swimlane !== "none") {
        board.appendChild(el("div", { class: "lane-head" }, epicTitles[lane] ? `${lane} · ${epicTitles[lane]}` : lane, el("span", { class: "n", text: `${inLane.length}` })));
      }
      for (const c of cols) {
        const cell = el("div", {
          class: "cell",
          dataset: { status: c.status },
          on: {
            dragover: (e) => { if (state.dragging && allowedTarget(state.dragging.status, c.status)) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } },
            drop: (e) => { e.preventDefault(); highlightDrops(null); dropOn(c.status); },
          },
        });
        for (const t of inLane.filter((x) => x.status === c.status)) cell.appendChild(card(t));
        board.appendChild(cell);
      }
    }
    root.appendChild(board);
    if (tickets.length === 0) {
      root.appendChild(el("div", { class: "empty" }, state.filter ? "No tickets match the filter." : "No tickets yet. Create one, or run `agent-flow import-tasks tasks.md`."));
    }
  }

  // ───────────────────────── drawer ─────────────────────────
  async function openTicket(id) {
    state.selected = id;
    try {
      state.detail = await wapi("GET", `/tickets/${encodeURIComponent(id)}`);
    } catch (err) {
      toast(err.message, "error");
      return;
    }
    renderDrawer();
    renderBoard();
  }
  function closeDrawer() {
    state.selected = null;
    state.detail = null;
    $("drawer").hidden = true;
    renderBoard();
  }

  function actionButtons(t) {
    const btns = [];
    const allowed = (state.meta && state.meta.transitions[t.status]) || [];
    const mk = (label, cls, fn) => btns.push(el("button", { class: `btn ${cls || ""}`, text: label, on: { click: fn } }));
    const tr = (action, extra) => wapi("POST", `/tickets/${t.id}/transition`, Object.assign({ action }, extra || {}));
    if (t.type === "epic") return btns;
    if (allowed.includes("approve")) mk("Approve", "success", () => act(() => tr("approve"), `${t.id} approved`));
    if (allowed.includes("reject")) mk("Reject…", "danger", async () => { const r = await ask("What must change?", { multiline: true, ok: "Reject" }); if (r) act(() => tr("reject", { reason: r }), `${t.id} sent back`); });
    if (allowed.includes("promote")) mk("Promote to ready", "primary", () => act(() => tr("promote"), `${t.id} is ready`));
    if (allowed.includes("unblock")) mk("Unblock", "primary", () => act(() => tr("unblock"), `${t.id} unblocked`));
    if (allowed.includes("block")) mk("Block…", "", async () => { const r = await ask("Why is it blocked?", { second: "Unblock condition", ok: "Block" }); if (r) act(() => tr("block", { reason: r[0], unblock_condition: r[1] })); });
    if (allowed.includes("release") && t.owner) mk("Release claim", "", () => act(() => tr("release", { reason: "released from dashboard", force: true }), `${t.id} released`));
    if (allowed.includes("demote")) mk("Back to backlog", "ghost", () => act(() => tr("demote")));
    if (allowed.includes("reopen")) mk("Reopen…", "", async () => { const r = await ask("Why reopen?", { ok: "Reopen" }); if (r) act(() => tr("reopen", { reason: r })); });
    if (allowed.includes("cancel")) mk("Cancel", "ghost", async () => { const r = await ask(`Cancel ${t.id}? Reason`, { ok: "Cancel ticket" }); if (r !== null) act(() => tr("cancel", { reason: r || "cancelled from dashboard" })); });
    return btns;
  }

  function renderDrawer() {
    const d = state.detail;
    const drawer = $("drawer");
    if (!d) { drawer.hidden = true; return; }
    drawer.hidden = false;
    clear(drawer);
    const lease = leaseText(d.lease_until);
    drawer.appendChild(el("div", { class: "drawer-head" },
      el("div", { class: "row" },
        el("span", { class: "mono", text: d.id }),
        el("span", { class: "status-badge", style: { "--sc": scolor(d.status) }, text: STATUS_LABEL[d.status] }),
        el("span", { class: `chip ${d.priority}`, text: d.priority }),
        el("span", { class: "chip", text: d.type }),
        el("button", { class: "btn ghost close", text: "Close", "aria-label": "Close details", on: { click: closeDrawer } })),
      el("h2", { text: d.title }),
      el("div", { class: "drawer-actions" }, actionButtons(d))));

    const body = el("div", { class: "drawer-body" });
    const kv = el("dl", { class: "kv" });
    const row = (k, v, mono) => { if (v === null || v === undefined || v === "") return; kv.appendChild(el("dt", { text: k })); kv.appendChild(el("dd", { class: mono ? "mono" : "", text: v })); };
    row("Owner", d.owner ? `${d.owner}${lease ? ` · lease ${lease.text}` : ""}` : null, true);
    row("Lane", d.lane);
    row("Epic", d.parent, true);
    row("Branch", d.branch, true);
    row("Spec", d.spec_ref, true);
    row("Scope", d.scope_paths.join(", "), true);
    row("Labels", d.labels.join(", "));
    row("Blocked", d.blocked_reason ? `${d.blocked_reason}${d.unblock_condition ? ` — unblock when: ${d.unblock_condition}` : ""}` : null);
    row("Attempts", d.attempts || d.rework_count ? `${d.attempts} lease/release · ${d.rework_count} rework` : null);
    row("GitHub", [d.github_issue ? `#${d.github_issue}` : "", d.pr_url || ""].filter(Boolean).join(" "));
    row("Created", `${d.created_by} · ${ago(d.created_at)}`);
    row("Updated", `${ago(d.updated_at)} · v${d.version}`);
    body.appendChild(el("div", { class: "section" }, kv));

    if (d.body.trim()) body.appendChild(el("div", { class: "section" }, el("h3", { text: "Spec" }), el("div", { class: "spec", text: d.body })));

    const acs = el("div", { class: "section" }, el("h3", { text: `Acceptance criteria (${d.acceptance.filter((a) => a.verdict === "Verified").length}/${d.acceptance.length})` }));
    for (const a of d.acceptance) {
      acs.appendChild(el("div", { class: "ac" },
        el("span", { class: `verdict ${a.verdict}`, text: a.verdict }),
        el("div", { class: "ac-text" }, el("div", null, el("span", { class: "mono", text: `${a.ac_id} ` }), a.text), a.evidence ? el("div", { class: "ac-evidence", text: a.evidence }) : null),
        el("div", { class: "ac-actions" },
          el("button", { class: "btn ghost", text: "✔", title: "Mark verified (needs evidence)", on: { click: async () => { const ev = await ask(`Evidence for ${a.ac_id}`, { value: a.evidence || "", ok: "Verify" }); if (ev) act(() => wapi("POST", `/tickets/${d.id}/ac`, { op: "verify", ac_id: a.ac_id, verdict: "Verified", evidence: ev })); } } }),
          el("button", { class: "btn ghost", text: "✘", title: "Mark failed", on: { click: async () => { const ev = await ask(`What fails for ${a.ac_id}?`, { ok: "Mark failed" }); if (ev !== null) act(() => wapi("POST", `/tickets/${d.id}/ac`, { op: "verify", ac_id: a.ac_id, verdict: "Failed", evidence: ev })); } } }))));
    }
    acs.appendChild(el("button", { class: "btn ghost", text: "+ criterion", on: { click: async () => { const t = await ask("New acceptance criterion (Done when…)", { ok: "Add" }); if (t) act(() => wapi("POST", `/tickets/${d.id}/ac`, { op: "add", text: t })); } } }));
    body.appendChild(acs);

    const deps = [...d.depends_on.map((x) => ["→", x]), ...d.dependents.map((x) => ["←", x]), ...d.children.map((x) => ["↳", x])];
    if (deps.length) {
      const sec = el("div", { class: "section" }, el("h3", { text: "Dependencies" }));
      for (const [arrow, x] of deps) {
        sec.appendChild(el("div", { class: "dep", on: { click: () => openTicket(x.id) } },
          el("span", { text: arrow }), el("span", { class: "status-badge", style: { "--sc": scolor(x.status) }, text: STATUS_LABEL[x.status] }),
          el("span", { class: "mono", text: x.id }), el("span", { class: "chip", text: x.kind }), el("span", { class: "dep-title", text: x.title })));
      }
      body.appendChild(sec);
    }

    const notes = el("div", { class: "section" }, el("h3", { text: "Notes & handoffs" }));
    for (const c of [...d.comments].reverse()) {
      notes.appendChild(el("div", { class: `comment ${c.kind}` },
        el("div", { class: "comment-head" }, el("span", { class: "comment-kind", text: c.kind }), el("span", { class: "mono", text: c.actor }), el("span", { text: ago(c.created_at), title: c.created_at })),
        el("div", { class: "comment-body", text: c.body })));
    }
    const ta = el("textarea", { placeholder: "Add a note, review comment, or handoff…", rows: 3 });
    const kind = el("select", null, el("option", { value: "note", text: "note" }), el("option", { value: "review", text: "review" }), el("option", { value: "handoff", text: "handoff" }));
    notes.appendChild(el("div", { class: "composer" }, ta, el("div", { class: "row" }, kind,
      el("button", { class: "btn primary", text: "Add", on: { click: () => { if (ta.value.trim()) act(() => wapi("POST", `/tickets/${d.id}/comments`, { kind: kind.value, body: ta.value })); } } }))));
    body.appendChild(notes);

    if (d.sessions.length) {
      const sec = el("div", { class: "section" }, el("h3", { text: "Sessions & transcripts" }));
      for (const s of d.sessions) {
        sec.appendChild(el("div", { class: "kv" },
          el("dt", { text: s.harness || "session" }),
          el("dd", { class: "mono", text: `${s.session_id}${s.transcript_path ? ` · ${s.transcript_path}` : ""}${s.commit_range ? ` · ${s.commit_range}` : ""}${s.ended_at ? ` · ended ${ago(s.ended_at)}` : " · active"}` })));
      }
      body.appendChild(sec);
    }

    const log = el("div", { class: "section" }, el("h3", { text: "Activity" }));
    for (const e of [...d.events].reverse()) log.appendChild(eventRow(e, false));
    body.appendChild(log);
    drawer.appendChild(body);
  }

  // ───────────────────────── other views ─────────────────────────
  function eventRow(e, withTicket) {
    const details = Object.entries(e.payload || {}).filter(([k]) => !["changed", "dod"].includes(k)).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ");
    return el("div", { class: `event${e.fresh ? " fresh" : ""}` },
      el("span", { class: "seq", text: `#${e.seq}` }),
      el("span", { class: "when", text: ago(e.ts), title: e.ts }),
      el("span", { class: "what" },
        el("span", { class: `actor ${e.actor_kind}`, text: e.actor }), " ",
        el("span", { class: "act", text: e.action }), " ",
        withTicket && e.ticket_id ? el("span", { class: "tid", text: e.ticket_id, on: { click: () => { showView("board"); openTicket(e.ticket_id); } } }) : null,
        details ? el("span", { class: "ac-evidence", text: `  ${details}` }) : null));
  }

  async function renderActivity() {
    const root = clear($("view-activity"));
    if (state.events.length === 0) {
      try { state.events = await wapi("GET", "/events?limit=200"); } catch (err) { toast(err.message, "error"); }
    }
    const feed = el("div", { class: "feed" });
    for (const e of state.events) { feed.appendChild(eventRow(e, true)); e.fresh = false; }
    root.appendChild(feed);
    if (!state.events.length) root.appendChild(el("div", { class: "empty", text: "No activity yet." }));
  }

  async function renderReview() {
    const root = clear($("view-review"));
    const col = state.board && state.board.columns.find((c) => c.status === "review");
    const items = col ? col.tickets : [];
    if (!items.length) { root.appendChild(el("div", { class: "empty", text: "Nothing waiting for review." })); return; }
    for (const t of items) {
      let d;
      try { d = await wapi("GET", `/tickets/${t.id}`); } catch { continue; }
      const handoff = [...d.comments].reverse().find((c) => c.kind === "handoff");
      const unverified = d.acceptance.filter((a) => a.verdict !== "Verified");
      root.appendChild(el("div", { class: "review-card" },
        el("div", { class: "row" }, el("span", { class: "mono", text: d.id }), el("span", { class: `chip ${d.priority}`, text: d.priority }),
          el("span", { class: "chip", text: `AC ${d.acceptance.length - unverified.length}/${d.acceptance.length}` }),
          d.rework_count ? el("span", { class: "chip p1", text: `rework ${d.rework_count}` }) : null,
          el("span", { class: "ac-evidence", text: `by ${d.owner || d.created_by}` })),
        el("h3", { text: d.title, on: { click: () => { showView("board"); openTicket(d.id); } } }),
        handoff ? el("div", { class: "comment handoff" }, el("div", { class: "comment-head" }, el("span", { class: "comment-kind", text: "handoff" }), el("span", { text: ago(handoff.created_at) })), el("div", { class: "comment-body", text: handoff.body })) : null,
        unverified.length ? el("div", { class: "ac-evidence", text: `Unverified: ${unverified.map((a) => `${a.ac_id} ${a.text}`).join(" · ")}` }) : null,
        el("div", { class: "row", style: { "margin-top": "8px" } }, actionButtons(d))));
    }
  }

  async function renderAgents() {
    const root = clear($("view-agents"));
    let agents = [];
    try { agents = await wapi("GET", "/agents"); } catch (err) { toast(err.message, "error"); }
    if (!agents.length) { root.appendChild(el("div", { class: "empty", text: "No agents have claimed work yet." })); return; }
    const tbody = el("tbody");
    for (const a of agents) {
      tbody.appendChild(el("tr", null,
        el("td", null, el("span", { class: "owner" }, el("span", { class: `avatar${isHuman(a.id) ? " human" : ""}`, text: initials(a.id) }), el("span", { class: "mono", text: a.id }))),
        el("td", { text: a.harness || "" }),
        el("td", { text: a.skills.join(", ") }),
        el("td", { text: ago(a.last_seen), title: a.last_seen }),
        el("td", null, a.active.length ? a.active.map((t) => { const l = leaseText(t.lease_until); return el("div", { class: "dep", on: { click: () => { showView("board"); openTicket(t.id); } } }, el("span", { class: "status-badge", style: { "--sc": scolor(t.status) }, text: STATUS_LABEL[t.status] }), el("span", { class: "mono", text: t.id }), el("span", { class: "dep-title", text: t.title }), l ? el("span", { class: `lease ${l.cls}`, text: l.text }) : null); }) : el("span", { class: "ac-evidence", text: "idle" }))));
    }
    root.appendChild(el("table", { class: "grid" }, el("thead", null, el("tr", null, ...["Agent", "Harness", "Skills", "Last seen", "Active tickets"].map((h) => el("th", { text: h })))), tbody));
  }

  function dag(children, edges) {
    const ids = children.map((c) => c.id);
    const byId = Object.fromEntries(children.map((c) => [c.id, c]));
    const preds = Object.fromEntries(ids.map((i) => [i, []]));
    for (const e of edges) if (preds[e.to] && byId[e.from]) preds[e.to].push(e.from);
    const depth = {};
    const visit = (id, seen) => {
      if (depth[id] !== undefined) return depth[id];
      if (seen.has(id)) return 0;
      seen.add(id);
      depth[id] = preds[id].length ? 1 + Math.max(...preds[id].map((p) => visit(p, seen))) : 0;
      return depth[id];
    };
    ids.forEach((i) => visit(i, new Set()));
    const layers = [];
    for (const i of ids) (layers[depth[i]] = layers[depth[i]] || []).push(i);
    const W = 190, H = 46, GX = 50, GY = 14;
    const pos = {};
    layers.forEach((layer, x) => layer.forEach((id, y) => { pos[id] = { x: 10 + x * (W + GX), y: 10 + y * (H + GY) }; }));
    const width = 20 + layers.length * (W + GX) - GX;
    const height = 20 + Math.max(...layers.map((l) => l.length)) * (H + GY) - GY;
    const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "dependency graph" });
    for (const e of edges) {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) continue;
      const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
      root.appendChild(svg("path", { class: "edge", d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 4},${y2}`, "marker-end": "url(#arrow)" }));
    }
    root.insertBefore(svg("defs", null, svg("marker", { id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" }, svg("path", { d: "M0,0 L10,5 L0,10 z", class: "arrowhead" }))), root.firstChild);
    for (const id of ids) {
      const c = byId[id], p = pos[id];
      const title = c.title.length > 28 ? `${c.title.slice(0, 27)}…` : c.title;
      root.appendChild(svg("g", { class: "node", transform: `translate(${p.x},${p.y})`, on: { click: () => { showView("board"); openTicket(id); } } },
        svg("rect", { width: W, height: H, rx: 5 }),
        svg("rect", { width: 4, height: H, rx: 2, class: `stripe s-${c.status}` }),
        svg("text", { x: 12, y: 18, class: "nid", text: `${id} · ${STATUS_LABEL[c.status]}` }),
        svg("text", { x: 12, y: 35, text: title })));
    }
    return root;
  }

  async function renderEpics() {
    const root = clear($("view-epics"));
    let epics = [];
    try { epics = await wapi("GET", "/epics"); } catch (err) { toast(err.message, "error"); }
    if (!epics.length) { root.appendChild(el("div", { class: "empty", text: "No epics. Import a spec's tasks with `agent-flow import-tasks`." })); return; }
    for (const { epic, children, edges } of epics) {
      const done = children.filter((c) => c.status === "done").length;
      const statuses = ["done", "review", "in_progress", "claimed", "blocked", "ready", "backlog"];
      const bar = el("div", { class: "progress", title: `${done}/${children.length} done` }, statuses.map((s) => {
        const n = children.filter((c) => c.status === s).length;
        return n ? el("span", { style: { width: `${(100 * n) / Math.max(1, children.length)}%`, background: scolor(s) } }) : null;
      }));
      root.appendChild(el("div", { class: "epic" },
        el("div", { class: "epic-head" }, el("span", { class: "mono", text: epic.id }),
          el("span", { class: "status-badge", style: { "--sc": scolor(epic.status) }, text: STATUS_LABEL[epic.status] }),
          el("h3", { text: epic.title, on: { click: () => { showView("board"); openTicket(epic.id); } } }), bar,
          el("span", { class: "ac-evidence", text: `${done}/${children.length} done` })),
        children.length ? el("div", { class: "dag" }, dag(children, edges)) : el("div", { class: "empty", text: "No child tickets." })));
    }
  }

  async function renderStats() {
    const root = clear($("view-stats"));
    let s;
    try { s = await wapi("GET", "/stats"); } catch (err) { toast(err.message, "error"); return; }
    const tile = (k, v, sub) => el("div", { class: "tile" }, el("div", { class: "k", text: k }), el("div", { class: "v", text: v }), sub ? el("div", { class: "sub", text: sub }) : null);
    root.appendChild(el("div", { class: "tiles" },
      tile("Ready", s.ready, "unblocked & unclaimed"),
      tile("In flight", s.counts.claimed + s.counts.in_progress, `WIP limit ${s.wip_limits.columns.in_progress ?? "∞"}`),
      tile("In review", s.counts.review),
      tile("Blocked", s.counts.blocked, `${s.needs_human} need a human`),
      tile("Done · 7 days", s.done_last_7d),
      tile("Median cycle", s.median_cycle_minutes === null ? "—" : `${s.median_cycle_minutes}m`, "claim → done"),
      tile("Rework rate", `${Math.round(s.rework_rate * 100)}%`, "done tickets rejected at least once"),
      tile("Outbox", s.outbox.pending, `${s.outbox.failed} failed`),
      tile("Events", s.last_seq, "hash-chained audit log")));
    const counts = el("table", { class: "grid", style: { "margin-top": "16px", "max-width": "520px" } },
      el("thead", null, el("tr", null, el("th", { text: "Status" }), el("th", { text: "Tickets" }))),
      el("tbody", null, Object.entries(s.counts).map(([k, v]) => el("tr", null, el("td", null, el("span", { class: "status-badge", style: { "--sc": scolor(k) }, text: STATUS_LABEL[k] })), el("td", { text: v })))));
    root.appendChild(counts);
  }

  // ───────────────────────── new ticket ─────────────────────────
  function newTicketModal() {
    const m = state.meta;
    const f = {
      title: el("input", { type: "text", required: true, placeholder: "Add GET /api/orders with pagination" }),
      type: el("select", null, m.types.map((t) => el("option", { value: t, text: t }))),
      priority: el("select", null, m.priorities.map((p) => el("option", { value: p, text: p, selected: p === "p2" }))),
      lane: el("select", null, m.lanes.map((l) => el("option", { value: l, text: l, selected: l === "feature" }))),
      body: el("textarea", { rows: 6, placeholder: "Task / Scope / Pattern: what to do, which files, which existing code to follow." }),
      ac: el("textarea", { rows: 3, placeholder: "One acceptance criterion per line (Done when…)" }),
      labels: el("input", { type: "text", placeholder: "agent-ok, skill:frontend" }),
      ready: el("input", { type: "checkbox", checked: true }),
    };
    const close = () => { $("modal").hidden = true; clear($("modal")); };
    const form = el("form", {
      class: "form",
      on: {
        submit: async (e) => {
          e.preventDefault();
          const t = await act(() => wapi("POST", "/tickets", {
            title: f.title.value, type: f.type.value, priority: f.priority.value, lane: f.lane.value, body: f.body.value,
            acceptance: f.ac.value.split("\n").map((x) => x.trim()).filter(Boolean),
            labels: f.labels.value.split(",").map((x) => x.trim()).filter(Boolean), ready: f.ready.checked,
          }), "ticket created");
          if (t) { close(); openTicket(t.id); }
        },
      },
    },
      el("label", null, "Title", f.title),
      el("div", { class: "row" }, el("label", null, "Type", f.type), el("label", null, "Priority", f.priority), el("label", null, "Lane", f.lane)),
      el("label", null, "Spec (the agent's prompt)", f.body),
      el("label", null, "Acceptance criteria", f.ac),
      el("label", null, "Labels", f.labels),
      el("label", { class: "check", style: { display: "flex", "align-items": "center" } }, f.ready, " Put straight into the ready queue"),
      el("div", { class: "actions" }, el("button", { type: "button", class: "btn ghost", text: "Cancel", on: { click: close } }), el("button", { type: "submit", class: "btn primary", text: "Create" })));
    clear($("modal")).appendChild(el("div", { class: "modal", role: "dialog", "aria-label": "New ticket" }, el("h2", { text: "New ticket" }), form));
    $("modal").hidden = false;
    f.title.focus();
  }

  // ───────────────────────── projects overview ─────────────────────────
  const inFlight = (w) => (w.counts ? w.counts.claimed + w.counts.in_progress : 0);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  /** Keep the end of a long path (the part that names the project); the full path is in the tooltip. */
  function shortPath(p) {
    const parts = String(p).split(/[\\/]/).filter(Boolean);
    return parts.length > 3 && p.length > 40 ? `…${p.includes("\\") ? "\\" : "/"}${parts.slice(-3).join(p.includes("\\") ? "\\" : "/")}` : p;
  }
  /** Projects that need a person first, then the most recently active. Unavailable ones sink to the bottom. */
  function rankProjects(list) {
    const attention = (w) => (w.status !== "ok" ? -1 : (w.counts.review ? 2 : 0) + (w.needs_human ? 2 : 0) + (w.counts.blocked ? 1 : 0));
    const lastTs = (w) => (w.last_event ? Date.parse(w.last_event.ts) : 0);
    return [...list].sort((a, b) => attention(b) - attention(a) || lastTs(b) - lastTs(a) || a.name.localeCompare(b.name));
  }

  function statusBar(counts) {
    const order = ["done", "review", "in_progress", "claimed", "blocked", "ready", "backlog"];
    const total = order.reduce((a, k) => a + (counts[k] || 0), 0);
    return el("div", { class: "progress wide", title: order.filter((k) => counts[k]).map((k) => `${STATUS_LABEL[k]} ${counts[k]}`).join(" · ") || "no tickets" },
      order.map((k) => (counts[k] ? el("span", { style: { width: `${(100 * counts[k]) / Math.max(1, total)}%`, background: scolor(k) } }) : null)));
  }

  function projectCard(w) {
    const ok = w.status === "ok";
    const metric = (n, label, cls) => el("span", { class: `metric${n ? ` ${cls || ""}` : " zero"}` }, el("b", { text: n }), ` ${label}`);
    const node = el("article", {
      class: `project-card${ok ? "" : " unavailable"}`,
      tabindex: "0",
      "aria-label": `Open ${w.name}`,
      on: {
        click: () => { if (ok) go(w.id, "board"); },
        keydown: (e) => { if (e.key === "Enter" && ok) go(w.id, "board"); },
      },
    },
      el("div", { class: "project-head" },
        el("span", { class: `pdot ${w.status}`, title: w.status }),
        el("h3", { text: w.name }),
        w.default ? el("span", { class: "chip", text: "this hub", title: "serve was started in this project" }) : null,
        ok && w.needs_human ? el("span", { class: "chip human", text: `${w.needs_human} need a human` }) : null),
      el("div", { class: "project-root mono", text: shortPath(w.root), title: w.root }));
    if (!ok) {
      node.appendChild(el("div", { class: "project-error", text: w.error || "unavailable" }));
      node.appendChild(el("div", { class: "row" },
        el("button", { class: "btn ghost", text: "Forget", title: "Remove from the registry (the project's files are untouched)", on: { click: async (e) => {
          e.stopPropagation();
          await act(() => api("POST", `/api/workspaces/${encodeURIComponent(w.id)}/forget`, {}), `${w.name} removed from the hub`);
        } } })));
      return node;
    }
    node.appendChild(statusBar(w.counts));
    node.appendChild(el("div", { class: "metrics" },
      metric(w.ready, "ready", "ready"),
      metric(inFlight(w), "in flight", "flight"),
      metric(w.counts.review, "review", "review"),
      metric(w.counts.blocked, "blocked", "blocked")));
    const foot = el("div", { class: "project-foot" });
    if (w.agents.length) {
      foot.appendChild(el("span", { class: "avatars", title: w.agents.join(", ") },
        w.agents.slice(0, 5).map((a) => el("span", { class: `avatar${isHuman(a) ? " human" : ""}`, text: initials(a) }))));
    }
    foot.appendChild(w.last_event
      ? el("span", { class: "last", title: w.last_event.ts }, `${w.last_event.actor} · ${w.last_event.action}${w.last_event.ticket_id ? ` ${w.last_event.ticket_id}` : ""} · ${ago(w.last_event.ts)}`)
      : el("span", { class: "last", text: "no activity yet" }));
    node.appendChild(foot);
    return node;
  }

  function crossList(title, rows, emptyText) {
    const sec = el("section", { class: "cross" }, el("h2", { text: title }));
    if (!rows.length) { sec.appendChild(el("div", { class: "empty small", text: emptyText })); return sec; }
    for (const { w, t } of rows) {
      sec.appendChild(el("div", { class: "cross-row", tabindex: "0", on: {
        click: () => openIn(w.id, t.id),
        keydown: (e) => { if (e.key === "Enter") openIn(w.id, t.id); },
      } },
        el("span", { class: "chip project", text: w.name }),
        el("span", { class: "mono", text: t.id }),
        el("span", { class: `chip ${t.priority}`, text: t.priority }),
        el("span", { class: "cross-title", text: t.title }),
        t.owner ? el("span", { class: "owner", title: t.owner }, el("span", { class: `avatar${isHuman(t.owner) ? " human" : ""}`, text: initials(t.owner) })) : null,
        el("span", { class: "when", text: ago(t.updated_at), title: t.updated_at })));
    }
    return sec;
  }

  function renderHome() {
    const root = clear($("view-home"));
    const hub = state.hub;
    if (!hub) return;
    const list = rankProjects(hub.workspaces);
    if (!list.length) {
      root.appendChild(el("div", { class: "empty" },
        el("p", { text: "No projects are registered with this hub yet." }),
        el("p", { class: "mono", text: "agent-flow init   ·   agent-flow workspaces add <dir>   ·   agent-flow workspaces scan <projects-root>" })));
      return;
    }
    const ok = list.filter((w) => w.status === "ok");
    const sum = (f) => ok.reduce((a, w) => a + f(w), 0);
    const tile = (k, v, sub) => el("div", { class: "tile" }, el("div", { class: "k", text: k }), el("div", { class: "v", text: v }), sub ? el("div", { class: "sub", text: sub }) : null);
    const off = list.length - ok.length;
    root.appendChild(el("div", { class: "tiles" },
      tile("Projects", ok.length, off ? `${off} unavailable` : "all reachable"),
      tile("Ready", sum((w) => w.ready), "unblocked & unclaimed"),
      tile("In flight", sum(inFlight), plural(new Set(ok.flatMap((w) => w.agents)).size, "agent working", "agents working")),
      tile("In review", sum((w) => w.counts.review)),
      tile("Blocked", sum((w) => w.counts.blocked), `${sum((w) => w.needs_human)} need a human`),
      tile("Done · 7 days", sum((w) => w.done_last_7d))));
    root.appendChild(el("div", { class: "projects" }, list.map(projectCard)));
    const review = ok.flatMap((w) => w.review.map((t) => ({ w, t }))).sort((a, b) => Date.parse(a.t.updated_at) - Date.parse(b.t.updated_at));
    const flight = ok.flatMap((w) => w.in_flight.map((t) => ({ w, t }))).sort((a, b) => Date.parse(b.t.updated_at) - Date.parse(a.t.updated_at));
    root.appendChild(el("div", { class: "cross-grid" },
      crossList("Waiting for review", review, "Nothing waiting for review in any project."),
      crossList("In flight", flight, "No agent holds a ticket right now.")));
  }

  // ───────────────────────── shell ─────────────────────────
  function hashFor(ws, view) {
    return ws ? `#/${encodeURIComponent(ws)}/${view || "board"}` : "#/";
  }
  /** Navigate (with a history entry) to a project's view, or to the overview when ws is null. */
  function go(ws, view) {
    const h = hashFor(ws, view);
    if (location.hash !== h) history.pushState(null, "", h);
    return route();
  }
  async function openIn(ws, ticketId) {
    await go(ws, "board");
    openTicket(ticketId);
  }

  async function selectProject(id) {
    state.ws = id;
    state.meta = null;
    state.board = null;
    state.selected = null;
    state.detail = null;
    state.events = [];
    state.lastSeq = 0;
    $("drawer").hidden = true;
    $("review-count").textContent = "";
    if (id) {
      try {
        state.meta = await wapi("GET", "/meta");
      } catch (err) {
        toast(`${wsName(id)}: ${err.message}`, "error");
      }
    }
    renderSwitcher();
  }

  /** Read the hash: `#/` overview, `#/<project>/<view>`, or a legacy `#<view>` for the default project. */
  async function route() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
    const known = (id) => !!(state.hub && state.hub.workspaces.some((w) => w.id === id));
    let [ws, view] = parts;
    if (ws && !known(ws) && VIEWS.includes(ws) && !view && state.hub && state.hub.default) { view = ws; ws = state.hub.default; }
    if (ws && !known(ws)) { toast(`no project "${ws}" in this hub`, "error"); ws = null; }
    if (!ws && !parts.length && state.hub && state.hub.workspaces.length === 1 && state.hub.workspaces[0].status === "ok") {
      ws = state.hub.workspaces[0].id; // one project: skip the overview
    }
    if ((ws || null) !== state.ws) await selectProject(ws || null);
    if (!ws) { showView("home"); return; }
    showView(VIEWS.includes(view) ? view : load("view", "board"));
    await refresh();
  }

  function renderSwitcher() {
    const sel = clear($("ws-select"));
    sel.appendChild(el("option", { value: "", text: "All projects" }));
    for (const w of (state.hub ? rankProjects(state.hub.workspaces) : [])) {
      const extra = w.status !== "ok" ? " (unavailable)" : w.counts.review ? ` · ${w.counts.review} in review` : "";
      sel.appendChild(el("option", { value: w.id, text: `${w.name}${extra}`, selected: w.id === state.ws, disabled: w.status !== "ok" && w.id !== state.ws }));
    }
    sel.value = state.ws || "";
    const w = state.ws && state.hub && state.hub.workspaces.find((x) => x.id === state.ws);
    sel.title = w ? w.root : "Every project registered with this hub";
    document.title = w ? `Agent Flow · ${w.name}` : "Agent Flow · Projects";
  }

  function showView(view) {
    state.view = view;
    const home = view === "home";
    if (!home) save("view", view);
    const h = hashFor(home ? null : state.ws, view);
    if (location.hash !== h) history.replaceState(null, "", h);
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
    document.querySelectorAll(".view").forEach((v) => { v.hidden = v.id !== `view-${view}`; });
    $("tabs").hidden = home;
    $("new-ticket").hidden = home || !state.meta;
    $("toolbar").hidden = view !== "board";
    render();
  }
  function render() {
    if (state.view === "home") { renderHome(); return; }
    if (!state.meta) {
      const root = clear($(`view-${state.view}`));
      root.appendChild(el("div", { class: "empty" }, `${wsName(state.ws)} is unavailable. `, el("a", { href: "#/", text: "Back to all projects" })));
      return;
    }
    if (state.view === "board") renderBoard();
    else if (state.view === "review") renderReview();
    else if (state.view === "activity") renderActivity();
    else if (state.view === "agents") renderAgents();
    else if (state.view === "epics") renderEpics();
    else if (state.view === "stats") renderStats();
    if (state.selected) renderDrawer();
  }

  async function init() {
    try {
      state.hub = await api("GET", "/api/workspaces");
    } catch (err) {
      toast(`cannot reach Agent Flow: ${err.message}`, "error");
      return;
    }
    $("actor").value = state.actor;
    $("actor").addEventListener("change", (e) => {
      const v = e.target.value.trim();
      state.actor = /^[a-z][a-z0-9_-]*:/.test(v) ? v : `human:${v || "dashboard"}`;
      e.target.value = state.actor;
      save("actor", state.actor);
    });
    $("swimlane").value = state.swimlane;
    $("swimlane").addEventListener("change", (e) => { state.swimlane = e.target.value; save("swimlane", state.swimlane); renderBoard(); });
    $("show-backlog").checked = state.showBacklog;
    $("show-backlog").addEventListener("change", (e) => { state.showBacklog = e.target.checked; save("showBacklog", e.target.checked ? "1" : "0"); renderBoard(); });
    $("show-done").checked = state.showDone;
    $("show-done").addEventListener("change", (e) => { state.showDone = e.target.checked; save("showDone", e.target.checked ? "1" : "0"); renderBoard(); });
    $("search").addEventListener("input", (e) => { state.filter = e.target.value; renderBoard(); });
    $("new-ticket").addEventListener("click", newTicketModal);
    $("ws-select").addEventListener("change", (e) => go(e.target.value || null, VIEWS.includes(state.view) ? state.view : "board"));
    $("home-link").addEventListener("click", (e) => { e.preventDefault(); go(null); });
    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => go(state.ws, t.dataset.view)));
    window.addEventListener("popstate", () => { route(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { if (!$("modal").hidden) { $("modal").hidden = true; clear($("modal")); } else if (state.selected) closeDrawer(); }
      if (e.key === "/" && document.activeElement === document.body && state.view === "board") { e.preventDefault(); $("search").focus(); }
    });
    $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) { $("modal").hidden = true; clear($("modal")); } });
    renderSwitcher();
    await route();
    connect();
    setInterval(() => { if (state.view === "board") renderBoard(); else if (state.view === "home") renderHome(); }, 30000); // lease countdowns, "ago" labels
  }

  init();
})();
