"use strict";

/* InstaLeads: панель. Дані в приватному репо, доступ через GitHub API з токеном із localStorage. */
const CFG = { owner: "Stailer42", dataRepo: "instaleads", branch: "main" };
const API = "https://api.github.com";
const TOKEN_KEY = "instaleads.token";
const STATUS = {
  wrote: "Написав",
  wrote_email: "Написав (email)",
  replied: "Відповів",
  refused: "Відмова",
  client: "Клієнт",
};
const FOLLOWUP_DAYS = 4;

const $ = (s, r = document) => r.querySelector(s);
const state = {
  leads: {}, status: {}, sent: { log: [] }, lastRun: null, emailLimit: 8,
  picked: new Set(), runTimer: null, pollTimer: null, mockupPending: new Set(),
};

/* ---------------------------------------------------------------- утиліти */
function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch (_) { return null; }
  return null;
}
const token = () => store(TOKEN_KEY) || "";
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toast(text) {
  const t = $("#toast");
  t.textContent = text; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3200);
}
function notice(text) { const n = $("#notice"); n.textContent = text || ""; n.hidden = !text; }
const daysAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 864e5;
function kyivDate(d) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(d); }
function b64decode(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = ""; bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}
function safeHref(url) { return /^(https:\/\/|tel:|mailto:|viber:\/\/)/i.test(url) ? url : "#"; }

/* ---------------------------------------------------------------- GitHub API */
async function gh(path, opts = {}) {
  if (!token()) throw new Error("Немає токена. Відкрий «Налаштування».");
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: opts.accept || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (res.status === 401) throw new Error("Токен не підходить (401). Перевір у «Налаштуваннях».");
  if (res.status === 403) throw new Error("Немає доступу (403): токену бракує прав Actions/Contents або вичерпано ліміт API.");
  if (res.status === 404 && opts.allow404) return null;
  if (!res.ok && res.status !== 204) {
    const t = await res.text();
    const err = new Error(`GitHub ${res.status}: ${t.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res.text();
}
const repoPath = (p) => `/repos/${CFG.owner}/${CFG.dataRepo}${p}`;

async function readJson(path, fallback, { strict = false } = {}) {
  const r = await gh(repoPath(`/contents/${path}?ref=${CFG.branch}`), { allow404: true });
  if (!r) return { data: fallback, sha: null };
  let text;
  if (r.content && r.encoding === "base64") text = b64decode(r.content);
  else text = await gh(repoPath(`/contents/${path}?ref=${CFG.branch}`), { accept: "application/vnd.github.raw+json" });
  try { return { data: typeof text === "string" ? JSON.parse(text) : text, sha: r.sha }; }
  catch (_) {
    if (strict) throw new Error(`${path} пошкоджений, запис скасовано, щоб не стерти дані`);
    return { data: fallback, sha: r.sha };
  }
}

async function readMockups() {
  const list = await gh(repoPath(`/contents/data/mockups?ref=${CFG.branch}`), { allow404: true });
  if (!Array.isArray(list)) return [];
  const files = list.filter((f) => f.type === "file" && f.name.endsWith(".json"));
  const out = await Promise.all(files.map((f) => readJson(`data/mockups/${f.name}`, null).then((r) => r.data).catch(() => null)));
  return out.filter((x) => x && x.id);
}

async function readText(path) {
  return gh(repoPath(`/contents/${path}?ref=${CFG.branch}`), { accept: "application/vnd.github.raw+json", allow404: true });
}

/* ---------------------------------------------------------------- дані */
async function loadAll() {
  if (!token()) {
    notice("Введи GitHub-токен у «Налаштуваннях», щоб бачити ліди й запускати пошук.");
    return;
  }
  notice("");
  try {
    const [leads, status, sent, last, cfgText, mocks] = await Promise.all([
      readJson("data/leads.json", {}), readJson("data/status.json", {}), readJson("data/sent.json", { log: [] }),
      readJson("data/last_run.json", null), readText("config.yaml"), readMockups(),
    ]);
    state.leads = leads.data || {};
    for (const ov of mocks) {           // накладки від workflow mockup
      if (state.leads[ov.id]) Object.assign(state.leads[ov.id], ov);
    }
    state.status = status.data || {};
    state.sent = sent.data || { log: [] };
    state.lastRun = last.data;
    state.emailLimit = parseLimit(cfgText || "");
    render();
  } catch (e) {
    notice(e.message);
  }
}

function parseLimit(yaml) {
  const num = (k) => { const m = yaml.match(new RegExp(`^\\s*${k}:\\s*(\\d+)`, "m")); return m ? +m[1] : null; };
  const wu = (yaml.match(/^\s*warmup_until:\s*"?(\d{4}-\d{2}-\d{2})/m) || [])[1];
  const base = num("daily_limit") || 8;
  if (wu && kyivDate(new Date()) >= wu) return num("daily_limit_after_warmup") || base;
  return base;
}

function sentFor(id) { return (state.sent.log || []).filter((r) => r.id === id).pop(); }
function mailErr(id) { const e = (state.sent.errors || {})[id]; return e ? (e.errors || []).join("; ") : ""; }
function effectiveStatus(id) {
  const manual = state.status[id];
  const mail = sentFor(id);
  if (manual && ["refused", "client"].includes(manual.status)) return { code: manual.status, ts: manual.ts };
  if (manual && (!mail || new Date(manual.ts) >= new Date(mail.ts))) return { code: manual.status, ts: manual.ts };
  if (mail) return { code: "wrote_email", ts: mail.ts };
  return null;
}
function needsFollowup(id) {
  const st = effectiveStatus(id);
  return !!st && (st.code === "wrote" || st.code === "wrote_email") && daysAgo(st.ts) >= FOLLOWUP_DAYS;
}
function sentToday() {
  const today = kyivDate(new Date());
  return (state.sent.log || []).filter((r) => kyivDate(new Date(r.ts)) === today).length;
}

/* сортування як у score.py: за балом, при різниці ≤ 5 вище той, у кого більше F */
function prioritySort(list) {
  const out = [...list].sort((a, b) => b.score - a.score || (b.f_points || 0) - (a.f_points || 0));
  let changed = true; let guard = 0;
  while (changed && guard++ < out.length * out.length + 1) {
    changed = false;
    for (let i = 0; i < out.length - 1; i++) {
      const x = out[i]; const y = out[i + 1];
      if (x.score - y.score <= 5 && (y.f_points || 0) > (x.f_points || 0)) { out[i] = y; out[i + 1] = x; changed = true; }
    }
  }
  return out;
}

/* ---------------------------------------------------------------- іконки (Lucide) */
const ICON = {
  instagram: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><path d="M17.5 6.5h.01"/></svg>',
  telegram: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
  whatsapp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>',
  viber: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M9 9.5c.5 2 2.5 4 5 5"/></svg>',
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  email: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
};
const CH_NAME = { instagram: "Instagram", telegram: "Telegram", whatsapp: "WhatsApp", viber: "Viber", phone: "Телефон", email: "Email" };
function chLink(ch, v) {
  const d = String(v).replace(/\D/g, "");
  return {
    instagram: `https://www.instagram.com/${encodeURIComponent(v)}/`,
    telegram: `https://t.me/${encodeURIComponent(v)}`,
    whatsapp: `https://wa.me/${d}`,
    viber: `viber://chat?number=%2B${d}`,
    phone: `tel:+${d}`,
    email: `mailto:${v}`,
  }[ch];
}

/* ---------------------------------------------------------------- рендер */
function render() {
  const hideClosed = $("#hide-closed").checked;
  const onlyFu = $("#only-followup").checked;
  let list = prioritySort(Object.values(state.leads));
  const total = list.length;
  list = list.filter((l) => {
    const st = effectiveStatus(l.id);
    if (hideClosed && st && (st.code === "refused" || st.code === "client")) return false;
    if (onlyFu && !needsFollowup(l.id)) return false;
    return true;
  });
  $("#counter").textContent = `Показано ${list.length} з ${total}`;
  const grid = $("#grid");
  grid.innerHTML = "";
  if (!total) {
    grid.innerHTML = '<p class="muted">Лідів ще немає. Натисни «Почати пошук».</p>';
  }
  for (const l of list) grid.appendChild(card(l));
  const lr = state.lastRun;
  $("#last-run").textContent = lr
    ? `Останній пошук: ${new Date(lr.run_id).toLocaleString("uk-UA")}, знайдено ${lr.found}, макетів ${(lr.mockups || []).length}, Apify ≈ $${lr.apify_usd ?? "?"}`
    : "";
  renderSendbar();
  renderStats();
}

function card(l) {
  const st = effectiveStatus(l.id);
  const el = document.createElement("article");
  el.className = "card" + (needsFollowup(l.id) ? " followup" : "") + (st && ["refused", "client"].includes(st.code) ? " closed" : "");
  const ch = Object.keys(l.contacts || {});
  const handle = l.contacts?.instagram?.value;
  const canMail = ch.includes("email") && l.email && !sentFor(l.id) && !(st && ["refused", "client"].includes(st.code));
  el.innerHTML = `
    <button class="card-open" type="button" aria-label="Відкрити ${esc(l.name)}"></button>
    <div class="card-top">
      <div>
        <h3>${esc(l.name)}</h3>
        <div class="handle">${handle ? "@" + esc(handle) : "без Instagram"} / ${esc(l.city || "")}</div>
      </div>
      <div class="score t-${esc(l.tier)}">${esc(l.score)}<small>${esc(l.tier)}</small></div>
    </div>
    <div class="chips">
      ${l.young ? '<span class="chip new">Новий</span>' : ""}
      ${st ? `<span class="chip st">${esc(STATUS[st.code] || st.code)}</span>` : ""}
      ${l.mockup_url ? '<span class="chip">Є макет</span>' : ""}
      ${l.needs_review ? '<span class="chip warn">Перевірити текст</span>' : ""}
      ${needsFollowup(l.id) ? '<span class="chip">Час для фолоуапу</span>' : ""}
      <span class="channels" aria-label="Канали: ${esc(ch.map((c) => CH_NAME[c] || c).join(", "))}">${ch.map((c) => ICON[c] || "").join("")}</span>
    </div>
    ${canMail ? `<label class="pick"><input type="checkbox" data-pick="${esc(l.id)}" ${state.picked.has(l.id) ? "checked" : ""}> Обрати для листа</label>` : ""}
  `;
  el.querySelector(".card-open").addEventListener("click", () => openLead(l.id));
  const pick = el.querySelector("[data-pick]");
  if (pick) pick.addEventListener("change", (e) => {
    if (e.target.checked) state.picked.add(l.id); else state.picked.delete(l.id);
    renderSendbar();
  });
  return el;
}

function copyBtn(text, label) {
  const id = "c" + Math.random().toString(36).slice(2);
  setTimeout(() => {
    const b = document.getElementById(id);
    if (b) b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(text); toast("Скопійовано"); }
      catch (_) { toast("Не вдалося скопіювати"); }
    });
  });
  return `<button class="linkbtn" id="${id}" type="button">${ICON.copy}${esc(label)}</button>`;
}

function openLead(id) {
  const l = state.leads[id];
  if (!l) return;
  const st = effectiveStatus(id);
  $("#lead-title").textContent = `${l.name} / ${l.score}`;
  const ct = l.contacts || {};
  const links = Object.entries(ct).map(([ch, c]) => {
    const href = safeHref(chLink(ch, c.value));
    const ext = href.startsWith("https") ? ' target="_blank" rel="noopener"' : "";
    return `<a href="${esc(href)}"${ext}>${ICON[ch] || ""}${esc(CH_NAME[ch] || ch)}</a>`;
  }).join("");
  const signals = (l.signals || []).map((s) => `<li>${esc(s.text)}${s.quote ? ` <q>${esc(s.quote)}</q>` : ""} <span class="muted small">${esc(s.source || "")}</span></li>`).join("");
  const rows = (l.breakdown || []).map((r) => `<tr><td>${esc(r.block)}</td><td>${esc(r.item)}${r.evidence ? `<br><span class="muted">${esc(r.evidence)}</span>` : ""}</td><td class="pts">${r.points > 0 && r.block === "+" ? "+" : ""}${esc(r.points)}${r.max ? " / " + esc(r.max) : ""}</td></tr>`).join("");
  const mail = l.email ? `
    <h4>Лист</h4>
    <p class="small muted">Тема: ${esc(l.email.subject)}</p>
    <pre class="msg">${esc(l.email.body)}</pre>
    ${sentFor(id) ? `<p class="small">Надіслано ${new Date(sentFor(id).ts).toLocaleString("uk-UA")} на ${esc(sentFor(id).to)}</p>` : ""}
    ${mailErr(id) ? `<p class="warn small">Лист не пішов: ${esc(mailErr(id))}</p>` : ""}` : "";
  const pending = state.mockupPending.has(id);
  const mock = l.mockup_url
    ? `<div class="links"><a href="${esc(safeHref(l.mockup_url))}" target="_blank" rel="noopener">${ICON.open}Відкрити макет</a>${copyBtn(l.mockup_url, "Копіювати посилання")}</div>`
    : `<button class="primary" type="button" id="btn-mockup" ${pending ? "disabled" : ""}>${pending ? "Макет робиться…" : "Зробити макет"}</button>`;
  $("#lead-body").innerHTML = `
    ${l.needs_review ? `<p class="warn small">Тексти не пройшли автоперевірку: ${esc((l.review_notes || []).join("; "))}</p>` : ""}
    <dl class="kv">
      <dt>Місто</dt><dd>${esc(l.city || "")}</dd>
      <dt>Ніша</dt><dd>${esc(l.niche_query || l.niche || "")}</dd>
      <dt>Підписники</dt><dd>${l.followers != null ? esc(l.followers) : "невідомо"}</dd>
      <dt>Оцінка</dt><dd>${esc(l.score)}, ${esc(l.tier)}, достовірність ${esc(l.reliability)}${l.young ? ", новий бізнес" : ""}</dd>
      ${l.address ? `<dt>Адреса</dt><dd>${esc(l.address)}</dd>` : ""}
    </dl>
    ${l.summary ? `<p>${esc(l.summary)}</p>` : ""}
    <h4>Де написати</h4>
    <div class="links">${links}${l.maps_url ? `<a href="${esc(safeHref(l.maps_url))}" target="_blank" rel="noopener">${ICON.open}Google Maps</a>` : ""}</div>
    <h4>Повідомлення</h4>
    <pre class="msg">${esc(l.dm || "")}</pre>
    <div class="row">${copyBtn(l.dm || "", "Копіювати")}</div>
    <h4>Фолоуап (через ${FOLLOWUP_DAYS} дні без відповіді)</h4>
    <pre class="msg">${esc(l.followup || "")}</pre>
    <div class="row">${copyBtn(l.followup || "", "Копіювати")}</div>
    ${mail}
    <h4>Макет</h4>
    ${mock}
    <h4>Статус</h4>
    <div class="status-row">
      ${["wrote", "replied", "refused", "client"].map((s) => `<button class="ghost" type="button" data-status="${s}" aria-pressed="${!!(st && st.code === s)}">${STATUS[s]}</button>`).join("")}
    </div>
    ${st ? `<p class="small muted">${esc(STATUS[st.code] || st.code)}: ${new Date(st.ts).toLocaleString("uk-UA")}</p>` : ""}
    <h4>Чому такий бал</h4>
    ${signals ? `<ul class="signals">${signals}</ul>` : ""}
    <table class="bd"><tbody>${rows}</tbody></table>
  `;
  $("#lead-body").querySelectorAll("[data-status]").forEach((b) => b.addEventListener("click", () => setStatus(id, b.dataset.status)));
  const mb = $("#btn-mockup");
  if (mb) mb.addEventListener("click", () => requestMockup(id));
  $("#dlg-lead").showModal();
}

/* ---------------------------------------------------------------- статуси */
async function setStatus(id, code) {
  if (code === "refused" && !confirm("Відмова назавжди: цьому бізнесу більше не пишемо і не шукаємо його. Так?")) return;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const { data, sha } = await readJson("data/status.json", {}, { strict: true });
      const cur = data[id] || {};
      data[id] = { status: code, ts: new Date().toISOString(), history: [...(cur.history || []), { status: code, ts: new Date().toISOString() }] };
      await gh(repoPath("/contents/data/status.json"), {
        method: "PUT",
        body: JSON.stringify({ message: `status: ${id} -> ${code}`, content: b64encode(JSON.stringify(data, null, 2) + "\n"), branch: CFG.branch, ...(sha ? { sha } : {}) }),
      });
      state.status = data;
      toast(`Статус: ${STATUS[code]}`);
      render();
      openLead(id);
      return;
    } catch (e) {
      if ((e.status === 409 || e.status === 422) && attempt < 3) continue;
      toast(e.message);
      return;
    }
  }
}

/* ---------------------------------------------------------------- запуск workflow і таймер */
async function dispatch(workflow, inputs) {
  const started = Date.now();
  const r = await gh(repoPath(`/actions/workflows/${workflow}/dispatches`), {
    method: "POST", body: JSON.stringify({ ref: CFG.branch, inputs, return_run_details: true }),
  });
  if (r && r.workflow_run_id) return { id: r.workflow_run_id, started };
  for (let i = 0; i < 12; i++) {
    await new Promise((res) => setTimeout(res, 2500));
    const runs = await gh(repoPath(`/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=5`));
    const run = (runs.workflow_runs || []).find((x) => new Date(x.created_at).getTime() >= started - 15000);
    if (run) return { id: run.id, started };
  }
  return { id: null, started };
}

function startTimer(fromMs) {
  clearInterval(state.runTimer);
  const tick = () => {
    const s = Math.max(0, Math.floor((Date.now() - fromMs) / 1000));
    $("#timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  tick();
  state.runTimer = setInterval(tick, 1000);
}

const RUN_LABEL = { queued: "У черзі", in_progress: "Шукаю…", waiting: "Чекаю", pending: "У черзі", requested: "У черзі" };

async function watchRun(runId, onDone) {
  clearInterval(state.pollTimer);
  const check = async () => {
    try {
      const run = await gh(repoPath(`/actions/runs/${runId}`));
      if (run.run_started_at) startTimerOnce(new Date(run.run_started_at).getTime());
      if (run.status !== "completed") {
        $("#run-status").textContent = RUN_LABEL[run.status] || run.status;
        return;
      }
      clearInterval(state.pollTimer);
      clearInterval(state.runTimer);
      $("#btn-parse").disabled = false;
      if (run.conclusion === "success") {
        $("#run-status").textContent = "Готово";
        await onDone();
      } else if (run.conclusion === "cancelled") {
        $("#run-status").innerHTML = `Скасовано. <a href="${esc(safeHref(run.html_url))}" target="_blank" rel="noopener">Деталі</a>`;
      } else {
        $("#run-status").innerHTML = `Помилка (${esc(run.conclusion)}). <a href="${esc(safeHref(run.html_url))}" target="_blank" rel="noopener">Лог</a>`;
      }
    } catch (e) { $("#run-status").textContent = e.message; }
  };
  await check();
  state.pollTimer = setInterval(check, 10000);
}
function startTimerOnce(ms) { if (startTimerOnce.ms !== ms) { startTimerOnce.ms = ms; startTimer(ms); } }

async function startParse() {
  const count = document.querySelector('input[name="count"]:checked').value;
  const btn = $("#btn-parse");
  btn.disabled = true;
  $("#run-status").textContent = "Запускаю…";
  startTimer(Date.now());
  try {
    const { id } = await dispatch("parse.yml", { count });
    if (!id) throw new Error("Запуск не знайдено. Перевір вкладку Actions у репо.");
    store("instaleads.run", String(id));
    await watchRun(id, async () => { store("instaleads.run", null); await loadAll(); toast("Нові ліди завантажено"); });
  } catch (e) {
    btn.disabled = false;
    clearInterval(state.runTimer);
    $("#run-status").textContent = e.message;
  }
}

async function resumeRun() {
  if (!token()) return;
  try {
    const runs = await gh(repoPath("/actions/workflows/parse.yml/runs?per_page=1"));
    const run = (runs.workflow_runs || [])[0];
    if (run && run.status !== "completed") {
      $("#btn-parse").disabled = true;
      await watchRun(run.id, async () => { await loadAll(); toast("Нові ліди завантажено"); });
    }
  } catch (_) { /* тихо: панель працює і без цього */ }
}

async function requestMockup(id) {
  state.mockupPending.add(id);
  openLead(id);
  try {
    const { id: runId } = await dispatch("mockup.yml", { id });
    toast("Макет робиться, це 3-10 хвилин");
    if (!runId) return;
    const poll = setInterval(async () => {
      try {
        const run = await gh(repoPath(`/actions/runs/${runId}`));
        if (run.status !== "completed") return;
        clearInterval(poll);
        state.mockupPending.delete(id);
        if (run.conclusion === "success") { await loadAll(); toast("Макет готовий"); }
        else toast("Макет не вдався, дивись лог в Actions");
        if ($("#dlg-lead").open) openLead(id);
      } catch (_) { /* наступна спроба */ }
    }, 15000);
  } catch (e) {
    state.mockupPending.delete(id);
    toast(e.message);
    openLead(id);
  }
}

/* ---------------------------------------------------------------- розсилка */
function renderSendbar() {
  const n = state.picked.size;
  $("#sendbar").hidden = n === 0;
  $("#send-count").textContent = `Обрано листів: ${n}`;
}
function openSend() {
  const ids = [...state.picked];
  const left = Math.max(0, state.emailLimit - sentToday());
  $("#send-limit").textContent = `Сьогодні надіслано ${sentToday()} з ${state.emailLimit}. Зараз піде ${Math.min(left, ids.length)}, решта ${Math.max(0, ids.length - left)} завтра.`;
  $("#send-list").innerHTML = ids.map((id) => {
    const l = state.leads[id];
    const first = (l.email?.body || "").split(/(?<=[.?])\s/)[0];
    return `<li><strong>${esc(l.name)}</strong> <span class="muted small">${esc(l.contacts.email.value)}</span><small>Тема: ${esc(l.email?.subject || "")}</small><small>${esc(first)}</small></li>`;
  }).join("");
  $("#dlg-send").showModal();
}
async function goSend() {
  const ids = [...state.picked];
  const btn = $("#btn-send-go");
  btn.disabled = true;
  try {
    // запит лежить у файлі: навіть якщо GitHub скасує запуск у черзі, наступний запуск або cron його підхопить
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}.json`;
    await gh(repoPath(`/contents/data/email_requests/${name}`), {
      method: "PUT",
      body: JSON.stringify({ message: `email request: ${ids.length}`, content: b64encode(JSON.stringify({ ids, ts: new Date().toISOString() }) + "\n"), branch: CFG.branch }),
    });
    const { id } = await dispatch("send.yml", {});
    $("#dlg-send").close();
    state.picked.clear();
    render();
    toast("Розсилку запущено. Між листами пауза 1-2 хвилини.");
    if (id) {
      const poll = setInterval(async () => {
        try {
          const run = await gh(repoPath(`/actions/runs/${id}`));
          if (run.status !== "completed") return;
          clearInterval(poll);
          await loadAll();
          toast(run.conclusion === "success" ? "Розсилку завершено" : run.conclusion === "cancelled"
            ? "Запуск скасовано, запит піде з наступним" : "Частина листів не пішла, причини в картках");
        } catch (_) { /* наступна спроба */ }
      }, 20000);
    }
  } catch (e) { toast(e.message); }
  btn.disabled = false;
}

/* ---------------------------------------------------------------- калібрування */
function renderStats() {
  const withSt = Object.values(state.leads).filter((l) => effectiveStatus(l.id));
  const box = $("#stats");
  if (withSt.length < 50) { box.hidden = true; return; }
  const bands = [[85, 100], [70, 84], [50, 69], [30, 49], [1, 29]];
  const rows = bands.map(([lo, hi]) => {
    const inBand = withSt.filter((l) => l.score >= lo && l.score <= hi);
    const rep = inBand.filter((l) => ["replied", "client"].includes(effectiveStatus(l.id).code)).length;
    return `<tr><td>${lo}-${hi}</td><td class="pts">${inBand.length}</td><td class="pts">${inBand.length ? Math.round((rep / inBand.length) * 100) : 0}%</td></tr>`;
  }).join("");
  box.hidden = false;
  box.innerHTML = `<h2 class="small muted">Калібрування: відповіді за діапазонами балів (${withSt.length} лідів зі статусом)</h2>
    <table class="bd"><thead><tr><td>Бали</td><td class="pts">Написано</td><td class="pts">Відповіли</td></tr></thead><tbody>${rows}</tbody></table>`;
}

/* ---------------------------------------------------------------- старт */
document.addEventListener("click", (e) => {
  const close = e.target.closest("[data-close]");
  if (close) close.closest("dialog").close();
});
document.querySelectorAll("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));
$("#btn-settings").addEventListener("click", () => { $("#token").value = token(); $("#dlg-settings").showModal(); });
$("#form-settings").addEventListener("submit", () => { store(TOKEN_KEY, $("#token").value.trim() || null); loadAll().then(resumeRun); });
$("#btn-logout").addEventListener("click", () => { store(TOKEN_KEY, null); $("#token").value = ""; state.leads = {}; render(); notice("Токен видалено."); });
$("#btn-parse").addEventListener("click", startParse);
$("#hide-closed").addEventListener("change", render);
$("#only-followup").addEventListener("change", render);
$("#btn-send-open").addEventListener("click", openSend);
$("#btn-send-go").addEventListener("click", goSend);

render();
loadAll().then(resumeRun);
