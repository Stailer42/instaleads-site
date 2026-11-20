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
  texts: {}, regenPending: new Set(), openId: null,
  deleted: { cleared_before: null, ids: {} }, pendingDel: new Set(), delTimer: null,
  runs: [], insight: null, nicheNames: {}, runId: null, ringMax: 0,
};
const VAR_KINDS = ["dm", "followup", "after_yes"];
const VAR_KEY = "instaleads.var";
const FU_COPIED_KEY = "instaleads.fucopied";   // який фолоуап копіювали (для висновків тижня)
const FILTER_KEY = "instaleads.filter";
const COUNT_KEY = "instaleads.count";
const NOCONFIRM_KEY = "instaleads.noconfirm";
const DEFAULT_FILTER = ["new", "wrote", "replied"];   // як раніше: без відмов і клієнтів
const UNDO_MS = 5000;

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
function toast(text, { action, onAction, ms = 3200 } = {}) {
  const t = $("#toast"); const btn = $("#toast-act");
  $("#toast-text").textContent = text;
  btn.hidden = !action;
  btn.textContent = action || "";
  btn.onclick = action ? () => { t.hidden = true; onAction(); } : null;
  t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}
function jsonStore(key, fallback) {
  try { const v = JSON.parse(store(key) || "null"); return v ?? fallback; } catch (_) { return fallback; }
}
const fmtUsd = (n) => (typeof n === "number" ? "$" + n.toFixed(2) : "?");
function fmtTokens(n) {
  if (typeof n !== "number") return "?";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(".0", "") + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(n);
}
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
function notice(text) { const n = $("#notice"); n.textContent = text || ""; n.hidden = !text; }
const daysAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 864e5;
function kyivDate(d) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(d); }
/* День тижня і час за Києвом: для статусів і статистики «Коли писати». */
const DOW = ["пн", "вт", "ср", "чт", "пт", "сб", "нд"];
const DOW_FULL = ["понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота", "неділя"];
const KYIV_PARTS = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function kyivParts(ts) {
  const d = new Date(ts);
  if (!ts || isNaN(d)) return null;
  const p = Object.fromEntries(KYIV_PARTS.formatToParts(d).map((x) => [x.type, x.value]));
  return { dow: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday), hour: Number(p.hour), time: `${p.hour}:${p.minute}`, date: `${p.day}.${p.month}` };
}
function whenShort(ts) { const k = kyivParts(ts); return k ? `${DOW[k.dow]} ${k.time}` : ""; }
function whenLong(ts) { const k = kyivParts(ts); return k ? `${DOW_FULL[k.dow]}, ${k.date}, ${k.time}` : ""; }
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
    cache: "no-store",   // GitHub шле max-age=60: без цього readJson бере старий sha, і запис падає з 409
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
  // сирий файл (config.yaml, json як текст) завжди читаємо як текст: GitHub шле тип "...raw+json"
  if ((opts.accept || "").includes("raw")) return res.text();
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

async function readOverlays(dir) {
  const list = await gh(repoPath(`/contents/data/${dir}?ref=${CFG.branch}`), { allow404: true });
  if (!Array.isArray(list)) return [];
  const files = list.filter((f) => f.type === "file" && f.name.endsWith(".json"));
  const out = await Promise.all(files.map((f) => readJson(`data/${dir}/${f.name}`, null).then((r) => r.data).catch(() => null)));
  return out.filter((x) => x && x.id);
}

/* Читає JSON, змінює mutate(data) і пише з sha; при конфлікті (409/422) перечитує й повторює. */
async function writeJson(path, fallback, mutate, message) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const { data: raw, sha } = await readJson(path, fallback, { strict: true });
      const data = mutate(raw ?? structuredClone(fallback)) ?? raw;
      await gh(repoPath(`/contents/${path}`), {
        method: "PUT",
        body: JSON.stringify({ message, content: b64encode(JSON.stringify(data, null, 2) + "\n"), branch: CFG.branch, ...(sha ? { sha } : {}) }),
      });
      return data;
    } catch (e) {
      if ((e.status === 409 || e.status === 422) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw new Error("Не вдалося записати після 4 спроб");
}

async function readLatestInsight() {
  const list = await gh(repoPath(`/contents/data/insights?ref=${CFG.branch}`), { allow404: true });
  if (!Array.isArray(list)) return null;
  const files = list.filter((x) => x.type === "file" && /^\d{4}-\d{2}-\d{2}(-\d+)?\.json$/.test(x.name))
    .sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true })).slice(0, 3);
  let first = null;
  for (const f of files) {   // найсвіжіший; але нерозглянуте proposed важливіше за пізніший skipped
    const { data } = await readJson(`data/insights/${f.name}`, null);
    if (!data) continue;
    const item = { ...data, path: `data/insights/${f.name}` };
    first = first || item;
    if (data.status === "proposed") return item;
    if (data.status !== "skipped") break;
  }
  return first;
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
    const [leads, status, sent, last, cfgText, mocks, texts, deleted, runsIdx, insight] = await Promise.all([
      readJson("data/leads.json", {}), readJson("data/status.json", {}), readJson("data/sent.json", { log: [] }),
      readJson("data/last_run.json", null), readText("config.yaml"), readOverlays("mockups"), readOverlays("texts"),
      readJson("data/deleted.json", { cleared_before: null, ids: {} }), readJson("data/runs_index.json", null),
      readLatestInsight().catch(() => null),
    ]);
    state.leads = leads.data || {};
    for (const ov of mocks) {           // накладки від workflow mockup
      if (state.leads[ov.id]) Object.assign(state.leads[ov.id], ov);
    }
    state.texts = {};                   // нові варіанти від workflow regen: дописуються, не замінюють
    for (const ov of texts) state.texts[ov.id] = ov.variants || {};
    state.status = status.data || {};
    state.sent = sent.data || { log: [] };
    state.lastRun = last.data;
    state.emailLimit = parseLimit(cfgText || "");
    state.nicheNames = parseNiches(cfgText || "");
    state.deleted = { cleared_before: null, ids: {}, ...(deleted.data || {}) };
    // до першого пошуку з новим merge.py індексу ще немає: показуємо хоча б останній пошук
    state.runs = (runsIdx.data && Array.isArray(runsIdx.data.runs)) ? runsIdx.data.runs
      : (last.data ? [{ ...last.data, excluded: (last.data.excluded || []).length }] : []);
    state.insight = insight;
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

function parseNiches(yaml) {
  const out = {};
  for (const m of yaml.matchAll(/\{\s*id:\s*([\w-]+)\s*,[^}]*query:\s*"([^"]+)"/g)) out[m[1]] = m[2];
  return out;
}

/* Прибрані в панелі: хрестик (ids) або «Очистити все» (знайдені до cleared_before). Як is_deleted у common.py. */
function isDeleted(l) {
  const d = state.deleted || {};
  if ((d.ids || {})[l.id]) return true;
  if (!d.cleared_before) return false;
  const found = new Date(l.found_at || NaN);
  return isNaN(found) || found <= new Date(d.cleared_before);   // без дати = старий лід, як is_deleted у common.py
}
const isVisible = (l) => !isDeleted(l) && !state.pendingDel.has(l.id);

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
/* Усі зміни статусу ліда разом з надісланим листом, від старих до нових. */
function statusLog(id) {
  const cur = state.status[id];
  const hist = cur ? (cur.history?.length ? cur.history : [{ status: cur.status, ts: cur.ts }]) : [];
  const ev = hist.map((h) => ({ code: h.status, ts: h.ts }));
  const m = sentFor(id);
  if (m) ev.push({ code: "wrote_email", ts: m.ts });
  return ev.filter((e) => kyivParts(e.ts)).sort((a, b) => new Date(a.ts) - new Date(b.ts));
}
/* Коли вперше написав: перший «Написав» або лист. Без нього (одразу «Відповів») час невідомий. */
function wroteAt(id) {
  const e = statusLog(id).find((x) => x.code === "wrote" || x.code === "wrote_email");
  return e ? e.ts : null;
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
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
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
/* ---------------------------------------------------------------- фільтр і пошук */
function getFilter() {
  const f = jsonStore(FILTER_KEY, DEFAULT_FILTER);
  return new Set(Array.isArray(f) ? f : DEFAULT_FILTER);
}
function setFilter(set) { store(FILTER_KEY, JSON.stringify([...set])); }
function matchFilter(l, f) {
  if (!f.size) return true;
  const st = effectiveStatus(l.id);
  const code = st ? st.code : null;
  return (f.has("new") && !code)
    || (f.has("wrote") && (code === "wrote" || code === "wrote_email"))
    || (f.has("followup") && needsFollowup(l.id))
    || (f.has(code) && ["replied", "refused", "client"].includes(code));
}
const norm = (s) => String(s ?? "").toLowerCase().replace(/ʼ|’|`/g, "'").trim();
function matchQuery(l, q) {
  if (!q) return true;
  const h = l.contacts?.instagram?.value || "";
  return [l.name, h, "@" + h, l.city].some((x) => norm(x).includes(q));
}
function renderFilterChips() {
  const f = getFilter();
  document.querySelectorAll(".fchip").forEach((b) => {
    if (b.dataset.f === "all") b.setAttribute("aria-pressed", String(!f.size));
    else b.setAttribute("aria-pressed", String(f.has(b.dataset.f)));
  });
}

function render() {
  const f = getFilter();
  const q = norm($("#q").value).replace(/^@/, "");
  const all = prioritySort(Object.values(state.leads).filter(isVisible));
  const total = all.length;
  const list = all.filter((l) => matchFilter(l, f) && matchQuery(l, q));
  renderFilterChips();
  $("#counter").textContent = `Показано ${list.length} з ${total}`;
  $("#btn-clear").disabled = !total;
  for (const id of state.picked) if (!state.leads[id] || !isVisible(state.leads[id])) state.picked.delete(id);
  const grid = $("#grid");
  grid.innerHTML = "";
  if (!total) {
    grid.innerHTML = '<p class="muted">Лідів ще немає. Натисни «Почати пошук».</p>';
  } else if (!list.length) {
    grid.innerHTML = '<p class="muted">Нічого не знайдено. Зміни пошук або фільтр.</p>';
  }
  for (const l of list) grid.appendChild(card(l));
  const lr = state.lastRun;
  $("#last-run").textContent = lr
    ? `Останній пошук: ${new Date(lr.run_id).toLocaleString("uk-UA")}, знайдено ${lr.found}, макетів ${(lr.mockups || []).length}, Apify ≈ $${lr.apify_usd ?? "?"}`
    : "";
  renderSendbar();
  renderStats();
  renderWhen();
  renderAllTime();
  renderInsight();
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
      ${st ? `<span class="chip st">${esc(STATUS[st.code] || st.code)}${kyivParts(st.ts) ? ` / ${esc(whenShort(st.ts))}` : ""}</span>` : ""}
      ${l.mockup_url ? '<span class="chip">Є макет</span>' : ""}
      ${l.needs_review ? '<span class="chip warn">Перевірити текст</span>' : ""}
      ${needsFollowup(l.id) ? '<span class="chip">Час для фолоуапу</span>' : ""}
      <span class="channels" aria-label="Канали: ${esc(ch.map((c) => CH_NAME[c] || c).join(", "))}">${ch.map((c) => ICON[c] || "").join("")}</span>
    </div>
    <div class="card-foot">
      ${canMail ? `<label class="pick"><input type="checkbox" data-pick="${esc(l.id)}" ${state.picked.has(l.id) ? "checked" : ""}> Обрати для листа</label>` : "<span></span>"}
      <button class="card-del" type="button" aria-label="Видалити ${esc(l.name)}">${ICON.x}</button>
    </div>
  `;
  el.querySelector(".card-open").addEventListener("click", () => openLead(l.id));
  el.querySelector(".card-del").addEventListener("click", () => deleteLead(l.id));
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

/* ---------------------------------------------------------------- варіанти текстів */
function varMap() {
  try { return JSON.parse(store(VAR_KEY) || "{}") || {}; } catch (_) { return {}; }
}
function getVarIdx(id, kind) {
  const v = varMap()[`${id}|${kind}`];
  return Number.isInteger(v) && v >= 0 ? v : 0;
}
function setVarIdx(id, kind, i) {
  const m = varMap(); m[`${id}|${kind}`] = i; store(VAR_KEY, JSON.stringify(m));
}
function textList(l, kind) {
  const out = [];
  const all = [l[kind], ...((l.variants || {})[kind] || []), ...((state.texts[l.id] || {})[kind] || [])];
  for (const t of all) {
    if (typeof t === "string" && t.trim() && !out.includes(t.trim())) out.push(t.trim());
  }
  return out;
}
function textBlock(l, kind) {
  const list = textList(l, kind);
  if (!list.length) return `<p class="small muted">Тексту немає.</p>`;
  const i = Math.min(getVarIdx(l.id, kind), list.length - 1);
  const last = i >= list.length - 1;
  const pending = state.regenPending.has(l.id);
  const more = last
    ? `<button class="linkbtn" type="button" data-act="regen" ${pending ? "disabled" : ""}>${ICON.refresh}${pending ? "Пишу нові…" : "Нові варіанти"}</button>`
      + (list.length > 1 ? `<button class="linkbtn" type="button" data-act="first">З початку</button>` : "")
    : `<button class="linkbtn" type="button" data-act="next">${ICON.refresh}Інший варіант</button>`;
  return `<div class="var" data-kind="${kind}">
    <pre class="msg">${esc(list[i])}</pre>
    <div class="row">
      <button class="linkbtn" type="button" data-act="copy">${ICON.copy}Копіювати</button>
      ${more}
      <span class="muted small var-count">${i + 1} з ${list.length}</span>
    </div>
  </div>`;
}
function refreshVar(kind) {
  const l = state.leads[state.openId];
  const box = $(`#lead-body .var[data-kind="${kind}"]`);
  if (l && box) box.outerHTML = textBlock(l, kind);
}
async function onVarClick(e) {
  const b = e.target.closest("[data-act]");
  const box = b && b.closest(".var");
  if (!box || b.disabled) return;
  const id = state.openId, kind = box.dataset.kind, l = state.leads[id];
  if (!l) return;
  const n = textList(l, kind).length;
  const i = Math.min(getVarIdx(id, kind), n - 1);
  if (b.dataset.act === "copy") {
    try {
      await navigator.clipboard.writeText(box.querySelector(".msg").textContent); toast("Скопійовано");
      if (kind === "followup") { const m = jsonStore(FU_COPIED_KEY, {}); m[id] = i; store(FU_COPIED_KEY, JSON.stringify(m)); }
    } catch (_) { toast("Не вдалося скопіювати"); }
  } else if (b.dataset.act === "next") {
    setVarIdx(id, kind, Math.min(i + 1, n - 1)); refreshVar(kind);
  } else if (b.dataset.act === "first") {
    setVarIdx(id, kind, 0); refreshVar(kind);
  } else if (b.dataset.act === "regen") {
    requestRegen(id);
  }
}

async function requestRegen(id) {
  const l = state.leads[id];
  const before = Object.fromEntries(VAR_KINDS.map((k) => [k, textList(l, k).length]));
  state.regenPending.add(id);
  VAR_KINDS.forEach(refreshVar);
  const done = (msg) => {
    state.regenPending.delete(id);
    if (msg) toast(msg);
    if ($("#dlg-lead").open && state.openId === id) openLead(id);
  };
  try {
    const { id: runId } = await dispatch("regen.yml", { id });
    toast("Пишу нові варіанти, це 1-3 хвилини");
    if (!runId) { done("Запуск пішов. Онови сторінку за кілька хвилин"); return; }
    const poll = setInterval(async () => {
      try {
        const run = await gh(repoPath(`/actions/runs/${runId}`));
        if (run.status !== "completed") return;
        clearInterval(poll);
        if (run.conclusion === "success") {
          await loadAll();
          const nl = state.leads[id];
          if (nl) VAR_KINDS.forEach((k) => { if (textList(nl, k).length > before[k]) setVarIdx(id, k, before[k]); });
          done("Нові варіанти готові");
        } else done("Нові варіанти не вдались, дивись лог в Actions");
      } catch (_) { /* наступна спроба */ }
    }, 10000);
  } catch (e) {
    done(e.message);
  }
}

function openLead(id) {
  const l = state.leads[id];
  if (!l) return;
  state.openId = id;
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
  const after = l.mockup_url && textList(l, "after_yes").length
    ? textBlock(l, "after_yes")
    : l.mockup_url
      ? `<p class="small muted">Скиньте посилання на макет з блоку «Макет» нижче.</p>`
      : `<p class="small muted">Спершу зробіть макет кнопкою нижче. Текст з посиланням з'явиться тут.</p>`;
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
    <h4>Перше повідомлення (без посилання)</h4>
    ${textBlock(l, "dm")}
    <h4>Якщо відповіли «так»</h4>
    ${after}
    <h4>Фолоуап (через ${FOLLOWUP_DAYS} дні без відповіді)</h4>
    ${textBlock(l, "followup")}
    ${mail}
    <h4>Макет</h4>
    ${mock}
    <h4>Статус</h4>
    <label class="small muted" for="st-note">Що відповіли (необов'язково, для висновків тижня)</label>
    <textarea id="st-note" class="note" rows="2" maxlength="300" placeholder="Наприклад: дорого, вже є розробник, попросили приклади">${esc(state.status[id]?.note || "")}</textarea>
    <div class="status-row">
      ${["wrote", "replied", "refused", "client"].map((s) => `<button class="ghost" type="button" data-status="${s}" aria-pressed="${!!(st && st.code === s)}">${STATUS[s]}</button>`).join("")}
    </div>
    ${statusLog(id).length ? `<ul class="st-log small muted">${statusLog(id).map((e) => `<li>${esc(STATUS[e.code] || e.code)}: ${esc(whenLong(e.ts))}</li>`).join("")}</ul>` : ""}
    <h4>Чому такий бал</h4>
    ${signals ? `<ul class="signals">${signals}</ul>` : ""}
    <table class="bd"><tbody>${rows}</tbody></table>
  `;
  $("#lead-body").querySelectorAll("[data-status]").forEach((b) => b.addEventListener("click", () => setStatus(id, b.dataset.status)));
  const mb = $("#btn-mockup");
  if (mb) mb.addEventListener("click", () => requestMockup(id));
  if (!$("#dlg-lead").open) $("#dlg-lead").showModal();
}

/* ---------------------------------------------------------------- статуси */
/* Знімок ознак ліда в status.json: висновки тижня працюють і після видалення ліда з панелі. */
function leadSnapshot(l) {
  return {
    niche: l.niche || null, city: l.city || null, score: l.score ?? null, tier: l.tier || null,
    followers: l.followers ?? null, young: !!l.young,
    signals: (l.signals || []).map((x) => x.code).filter(Boolean),
    channels: Object.keys(l.contacts || {}),
  };
}
/* Текст, який реально пішов: обраний зараз варіант DM і фолоуап, якщо його копіювали. */
function sentTexts(l) {
  const dms = textList(l, "dm"); const fus = textList(l, "followup");
  const dm = dms.length ? dms[Math.min(getVarIdx(l.id, "dm"), dms.length - 1)] : null;
  const fi = jsonStore(FU_COPIED_KEY, {})[l.id];
  const fu = Number.isInteger(fi) && fus.length ? fus[Math.min(fi, fus.length - 1)] : null;
  return { dm, fu };
}

async function setStatus(id, code) {
  if (code === "refused" && !(await confirmBox("Відмова назавжди?", "Цьому бізнесу більше не пишемо і не шукаємо його.", "Так, відмова"))) return;
  const l = state.leads[id];
  const note = ($("#st-note")?.value || "").trim().slice(0, 300);
  const { dm, fu } = l ? sentTexts(l) : {};
  try {
    const data = await writeJson("data/status.json", {}, (d) => {
      const cur = d[id] || {};
      const ts = new Date().toISOString();
      const ev = { status: code, ts, ...(note && note !== cur.note ? { note } : {}) };
      d[id] = {
        ...cur, status: code, ts, history: [...(cur.history || []), ev],
        ...(note ? { note } : {}),
        // перший відправлений DM не перезаписуємо: саме він дав (або не дав) відповідь
        ...(dm && !cur.dm_text ? { dm_text: dm } : {}),
        ...(fu && !cur.followup_text ? { followup_text: fu } : {}),
        ...(l ? { lead: leadSnapshot(l) } : {}),
      };
      return d;
    }, `status: ${id} -> ${code}`);
    state.status = data;
    toast(`Статус: ${STATUS[code]}`);
    render();
    openLead(id);
  } catch (e) { toast(e.message); }
}

/* ---------------------------------------------------------------- підтвердження */
function confirmBox(title, text, okLabel) {
  return new Promise((resolve) => {
    const d = $("#dlg-confirm"); const ok = $("#btn-confirm-ok");
    $("#confirm-title").textContent = title;
    $("#confirm-text").textContent = text;
    ok.textContent = okLabel;
    d.returnValue = "";
    const onClose = () => { d.removeEventListener("close", onClose); ok.onclick = null; resolve(d.returnValue === "ok"); };
    d.addEventListener("close", onClose);
    ok.onclick = () => d.close("ok");
    d.showModal();
  });
}

/* ---------------------------------------------------------------- видалення */
// Пише тільки data/deleted.json: leads.json належить workflow, merge.py сам вичистить прибраних.
async function saveDeleted(mutate, message) {
  state.deleted = await writeJson("data/deleted.json", { cleared_before: null, ids: {} }, (d) => {
    d.ids = d.ids || {};
    mutate(d);
    return d;
  }, message);
}

async function deleteLead(id) {
  const l = state.leads[id];
  if (!l) return;
  if ($("#no-confirm").checked) {
    state.pendingDel.add(id);
    render();
    clearTimeout(state.delTimer);
    const n = state.pendingDel.size;
    toast(n > 1 ? `Видалено: ${n}` : `Видалено «${l.name}»`, {
      action: "Повернути", ms: UNDO_MS,
      onAction: () => { clearTimeout(state.delTimer); state.pendingDel.clear(); render(); },
    });
    state.delTimer = setTimeout(flushDeletes, UNDO_MS);
    return;
  }
  if (!(await confirmBox("Видалити акаунт?", `«${l.name}» зникне з панелі. Шукати його знову не будемо, статус лишиться в статистиці.`, "Так, видалити"))) return;
  try {
    await saveDeleted((d) => { d.ids[id] = new Date().toISOString(); }, `delete: ${id}`);
    render();
    toast("Видалено");
  } catch (e) { toast(e.message); }
}

async function flushDeletes() {
  const ids = [...state.pendingDel];
  if (!ids.length) return;
  try {
    const ts = new Date().toISOString();
    await saveDeleted((d) => { ids.forEach((x) => { d.ids[x] = ts; }); }, `delete: ${ids.length}`);
    ids.forEach((x) => state.pendingDel.delete(x));
    render();
  } catch (e) {
    ids.forEach((x) => state.pendingDel.delete(x));   // не записалось: картки повертаються
    render();
    toast(`Не видалено: ${e.message}`);
  }
}

async function clearAll() {
  const n = Object.values(state.leads).filter(isVisible).length;
  if (!n) return;
  // завжди з підтвердженням, галочка «без підтвердження» стосується тільки хрестика
  if (!(await confirmBox("Очистити все?", `Прибрати ${n} акаунтів з панелі? Шукати їх знову не будемо. Статуси, історія пошуків і статистика лишаться.`, "Так, очистити"))) return;
  try {
    clearTimeout(state.delTimer); state.pendingDel.clear();
    await saveDeleted((d) => { d.cleared_before = new Date().toISOString(); }, `clear all: ${n}`);
    state.picked.clear();
    render();
    toast("Панель очищено");
  } catch (e) { toast(e.message); }
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

/* ---------------------------------------------------------------- кільце прогресу */
const RING_LEN = 2 * Math.PI * 52;
function setRing(percent, label) {
  const p = Math.max(state.ringMax, Math.min(100, Math.round(percent)));   // ніколи не назад
  state.ringMax = p;
  const box = $("#progress");
  box.hidden = false;
  box.setAttribute("aria-valuenow", String(p));
  box.setAttribute("aria-valuetext", `${p}%${label ? ", " + label : ""}`);
  $("#ring-fg").style.strokeDashoffset = String(RING_LEN * (1 - p / 100));
  $("#ring-pct").textContent = `${p}%`;
  if (label !== undefined) $("#ring-label").textContent = label;
}
function resetRing() { state.ringMax = 0; setRing(0, "Запускаю"); }

// Етап з кроків job, якщо progress.json ще немає (перші секунди або старий workflow)
const STEP_PCT = [[/Збір кандидатів/, 3, "Збираю в Apify"], [/Claude/, 10, "Claude оцінює"], [/Детерміно|Склонувати|Опублікувати|Збереження|Коміт/, 95, "Зберігаю"]];
async function pollProgress(runId) {
  try {
    const raw = await gh(repoPath("/contents/progress.json?ref=progress"), { accept: "application/vnd.github.raw+json", allow404: true });
    const pr = raw ? JSON.parse(raw) : null;
    if (pr && String(pr.run_id) === String(runId) && typeof pr.percent === "number") { setRing(pr.percent, pr.label || ""); return; }
  } catch (_) { /* нижче запасний варіант */ }
  try {
    const jobs = await gh(repoPath(`/actions/runs/${runId}/jobs`));
    const steps = ((jobs.jobs || [])[0] || {}).steps || [];
    const cur = steps.find((x) => x.status === "in_progress");
    const hit = cur && STEP_PCT.find(([re]) => re.test(cur.name));
    if (hit) setRing(hit[1], hit[2]);
  } catch (_) { /* тихо: кільце лишається як було */ }
}

async function watchRun(runId, onDone) {
  clearInterval(state.pollTimer);
  if (state.runId !== runId) { state.runId = runId; resetRing(); }
  const check = async () => {
    try {
      const run = await gh(repoPath(`/actions/runs/${runId}`));
      if (run.run_started_at) startTimerOnce(new Date(run.run_started_at).getTime());
      if (run.status !== "completed") {
        $("#run-status").textContent = RUN_LABEL[run.status] || run.status;
        if (run.status === "in_progress") await pollProgress(runId);
        return;
      }
      clearInterval(state.pollTimer);
      clearInterval(state.runTimer);
      $("#btn-parse").disabled = false;
      if (run.conclusion === "success") {
        $("#run-status").textContent = "Готово";
        setRing(100, "Готово");
        await onDone();
      } else if (run.conclusion === "cancelled") {
        $("#run-status").innerHTML = `Скасовано. <a href="${esc(safeHref(run.html_url))}" target="_blank" rel="noopener">Деталі</a>`;
      } else {
        $("#run-status").innerHTML = `Помилка (${esc(run.conclusion)}). <a href="${esc(safeHref(run.html_url))}" target="_blank" rel="noopener">Лог</a>`;
        $("#ring-label").textContent = "Зупинилось з помилкою";
      }
    } catch (e) { $("#run-status").textContent = e.message; }
  };
  await check();
  state.pollTimer = setInterval(check, 10000);
}
function startTimerOnce(ms) { if (startTimerOnce.ms !== ms) { startTimerOnce.ms = ms; startTimer(ms); } }

async function startParse() {
  const count = String(Math.min(30, Math.max(1, parseInt($("#count").value, 10) || 20)));
  const btn = $("#btn-parse");
  btn.disabled = true;
  $("#run-status").textContent = "Запускаю…";
  state.runId = null; resetRing();
  startTimer(Date.now());
  try {
    const { id } = await dispatch("parse.yml", { count });
    if (!id) throw new Error("Запуск не знайдено. Перевір вкладку Actions у репо.");
    store("instaleads.run", String(id));
    await watchRun(id, async () => { store("instaleads.run", null); await loadAll(); toast("Нові ліди завантажено"); });
  } catch (e) {
    btn.disabled = false;
    clearInterval(state.runTimer);
    $("#progress").hidden = true;
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

/* ---------------------------------------------------------------- коли писати */
const HOUR_BANDS = [[0, 9, "до 9"], [9, 12, "9-12"], [12, 15, "12-15"], [15, 18, "15-18"], [18, 21, "18-21"], [21, 24, "після 21"]];
const WHEN_MIN = 5;
function renderWhen() {
  const box = $("#when");
  // status.json і лист живуть і після видалення ліда, тож рахуємо всіх, кому писав
  const ids = new Set([...Object.keys(state.status), ...(state.sent.log || []).map((r) => r.id)]);
  const rows = [...ids].map((id) => ({ k: kyivParts(wroteAt(id)), pos: positive(id) })).filter((r) => r.k);
  if (rows.length < WHEN_MIN) { box.hidden = true; return; }
  const table = (title, labels, keyOf) => {
    const body = labels.map((lab, i) => {
      const g = rows.filter((r) => keyOf(r.k) === i);
      const rep = g.filter((r) => r.pos).length;
      return `<tr><td>${esc(lab)}</td><td class="pts">${g.length}</td><td class="pts">${g.length ? `${rep} <span class="muted">(${pct(rep, g.length)}%)</span>` : ""}</td></tr>`;
    }).join("");
    return `<table class="bd"><thead><tr><td>${esc(title)}</td><td class="pts">Написав</td><td class="pts">Відповіли</td></tr></thead><tbody>${body}</tbody></table>`;
  };
  box.hidden = false;
  box.innerHTML = `<h2 class="small muted">Коли писати: день тижня і година першого повідомлення (${rows.length} лідів, час київський)</h2>
    <div class="when-grid">
      ${table("День", DOW, (k) => k.dow)}
      ${table("Година", HOUR_BANDS.map((b) => b[2]), (k) => HOUR_BANDS.findIndex(([lo, hi]) => k.hour >= lo && k.hour < hi))}
    </div>
    ${rows.length < 30 ? '<p class="small muted">Поки менше 30 лідів, відсотки ще випадкові.</p>' : ""}`;
}

/* ---------------------------------------------------------------- історія і статистика */
// «Відповів» або «Клієнт» будь-коли в історії статусу (клієнт спершу відповів)
function positive(id) {
  const st = state.status[id];
  if (!st) return false;
  return ["replied", "client"].includes(st.status) || (st.history || []).some((h) => ["replied", "client"].includes(h.status));
}
function renderHistory() {
  const runs = [...state.runs].reverse();
  if (!runs.length) { $("#hist-body").innerHTML = '<p class="muted">Пошуків ще не було.</p>'; return; }
  const sum = (k) => runs.reduce((a, r) => a + (typeof r[k] === "number" ? r[k] : 0), 0);
  const anyTok = runs.some((r) => typeof r.claude_tokens === "number");
  let repTotal = 0;
  const rows = runs.map((r) => {
    const ids = r.lead_ids || [];
    const rep = ids.filter(positive).length;
    repTotal += rep;
    const d = new Date(r.run_id).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    return `<tr><td>${esc(d)}</td><td class="pts">${esc(r.requested ?? "?")}</td><td class="pts">${esc(r.found ?? "?")}</td>
      <td class="pts">${esc(r.candidates ?? "?")}</td><td class="pts">${esc(fmtUsd(r.apify_usd))}</td>
      <td class="pts">${esc(fmtTokens(r.claude_tokens))}</td><td class="pts">${rep}${ids.length ? ` <span class="muted">(${pct(rep, ids.length)}%)</span>` : ""}</td></tr>`;
  }).join("");
  const found = sum("found");
  $("#hist-body").innerHTML = `<table class="bd hist"><thead><tr><td>Коли</td><td class="pts">Просив</td><td class="pts">Знайдено</td>
    <td class="pts">Без сайту</td><td class="pts">Apify</td><td class="pts">Токени Claude</td><td class="pts">Відповіли</td></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td>Разом ${runs.length}</td><td class="pts">${sum("requested")}</td><td class="pts">${found}</td><td class="pts">${sum("candidates")}</td>
    <td class="pts">${esc(fmtUsd(sum("apify_usd")))}</td><td class="pts">${anyTok ? esc(fmtTokens(sum("claude_tokens"))) : "?"}</td>
    <td class="pts">${repTotal} <span class="muted">(${pct(repTotal, found)}%)</span></td></tr></tfoot></table>`;
}
function renderAllTime() {
  const box = $("#alltime");
  const runs = state.runs;
  box.hidden = !runs.length && !Object.keys(state.status).length;
  if (box.hidden) return;
  const found = runs.reduce((a, r) => a + (r.found || 0), 0);
  const usd = runs.reduce((a, r) => a + (typeof r.apify_usd === "number" ? r.apify_usd : 0), 0);
  const mailed = new Set((state.sent.log || []).map((r) => r.id));
  const wrote = new Set([...Object.keys(state.status), ...mailed]).size;
  const rep = Object.keys(state.status).filter(positive).length;
  const clients = Object.values(state.status).filter((s) => s.status === "client").length;
  const refused = Object.values(state.status).filter((s) => s.status === "refused").length;
  box.textContent = `За весь час: пошуків ${runs.length} / знайдено ${found} / Apify ${fmtUsd(usd)} / `
    + `написав ${wrote} / відповіли ${rep} (${pct(rep, wrote)}%) / відмов ${refused} / клієнтів ${clients}`;
}

/* ---------------------------------------------------------------- висновки тижня */
function renderInsight() {
  const box = $("#insight");
  const ins = state.insight;
  if (!ins) { box.hidden = true; return; }
  const date = new Date(ins.date + "T12:00:00").toLocaleDateString("uk-UA", { day: "numeric", month: "long" });
  box.hidden = false;
  if (ins.status !== "proposed") {
    const what = { skipped: esc(ins.summary || "мало даних"), applied: "застосовано", rejected: "відхилено" }[ins.status] || esc(ins.status);
    box.innerHTML = `<p class="small muted">Висновки тижня від ${esc(date)}: ${what}</p>`;
    return;
  }
  const p = ins.proposed || {};
  const w = (obj, names) => Object.entries(obj || {}).filter(([, v]) => v !== 1)
    .map(([k, v]) => `${esc(names ? (names[k] || k) : k)} ×${esc(v)}`).join(", ");
  const nw = w(p.niche_weight, state.nicheNames); const cw = w(p.city_weight);
  const li = (arr) => (arr || []).map((t) => `<li>${esc(t)}</li>`).join("");
  box.innerHTML = `
    <h2>Висновки тижня, ${esc(date)}</h2>
    <p>${esc(ins.summary)}</p>
    <ol class="findings">${(ins.findings || []).map((f) => `<li>${esc(f.text)} <span class="muted small">${esc(f.evidence)}</span></li>`).join("")}</ol>
    <h3>Нові правила</h3>
    <ul class="rules">
      ${nw ? `<li>Частіше або рідше шукати ніші: ${nw}</li>` : ""}
      ${cw ? `<li>Міста: ${cw}</li>` : ""}
      ${li(p.message_hints)}
      ${(p.exclude_hints || []).length ? li(p.exclude_hints.map((t) => "Не брати: " + t)) : ""}
    </ul>
    <div class="row">
      <button class="primary" type="button" id="btn-ins-apply">Застосувати правила</button>
      <button class="ghost" type="button" id="btn-ins-reject">Відхилити</button>
    </div>
    <p class="muted small">Застосовані правила підуть у наступні пошуки. Бал рахується як раніше.</p>`;
  $("#btn-ins-apply").addEventListener("click", () => decideInsight(true));
  $("#btn-ins-reject").addEventListener("click", () => decideInsight(false));
}
async function decideInsight(apply) {
  const ins = state.insight;
  if (!ins || ins.status !== "proposed") return;
  document.querySelectorAll("#insight button").forEach((b) => { b.disabled = true; });
  try {
    if (apply) {
      const p = ins.proposed || {};
      await writeJson("data/rules.json", {}, (cur) => ({
        niche_weight: { ...(cur.niche_weight || {}), ...(p.niche_weight || {}) },
        city_weight: { ...(cur.city_weight || {}), ...(p.city_weight || {}) },
        message_hints: p.message_hints || [], exclude_hints: p.exclude_hints || [],
        source: ins.date, applied_at: new Date().toISOString(),
      }), `rules: висновки ${ins.date}`);
    }
    const status = apply ? "applied" : "rejected";
    await writeJson(ins.path, {}, (d) => ({ ...d, status, decided_at: new Date().toISOString() }), `insights: ${ins.date} ${status}`);
    state.insight = { ...ins, status };
    toast(apply ? "Правила застосовано" : "Висновки відхилено");
  } catch (e) { toast(e.message); }
  renderInsight();
}

/* ---------------------------------------------------------------- старт */
document.addEventListener("click", (e) => {
  const close = e.target.closest("[data-close]");
  if (close) close.closest("dialog").close();
});
document.querySelectorAll("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));
$("#lead-body").addEventListener("click", onVarClick);
$("#btn-settings").addEventListener("click", () => { $("#token").value = token(); $("#dlg-settings").showModal(); });
$("#form-settings").addEventListener("submit", () => { store(TOKEN_KEY, $("#token").value.trim() || null); loadAll().then(resumeRun); });
$("#btn-logout").addEventListener("click", () => {
  store(TOKEN_KEY, null); $("#token").value = "";
  Object.assign(state, { leads: {}, status: {}, sent: { log: [] }, runs: [], insight: null, lastRun: null });
  render(); notice("Токен видалено.");
});
$("#btn-parse").addEventListener("click", startParse);
$("#btn-clear").addEventListener("click", clearAll);
$("#btn-history").addEventListener("click", () => { renderHistory(); $("#dlg-history").showModal(); });
document.querySelector(".filters").addEventListener("click", (e) => {
  const b = e.target.closest(".fchip");
  if (!b) return;
  const f = getFilter();
  if (b.dataset.f === "all") f.clear();
  else if (f.has(b.dataset.f)) f.delete(b.dataset.f); else f.add(b.dataset.f);
  setFilter(f);
  render();
});
$("#q").addEventListener("input", () => { clearTimeout(render.q); render.q = setTimeout(render, 150); });
{
  const c = $("#count"); const out = $("#count-out");
  const saved = parseInt(store(COUNT_KEY), 10);
  if (saved >= 1 && saved <= 30) c.value = String(saved);
  const sync = () => { out.textContent = c.value; c.setAttribute("aria-valuetext", `${c.value} бізнесів`); };
  sync();
  c.addEventListener("input", sync);
  c.addEventListener("change", () => store(COUNT_KEY, c.value));
  const nc = $("#no-confirm");
  nc.checked = store(NOCONFIRM_KEY) === "1";
  nc.addEventListener("change", () => store(NOCONFIRM_KEY, nc.checked ? "1" : null));
}
$("#btn-send-open").addEventListener("click", openSend);
$("#btn-send-go").addEventListener("click", goSend);

render();
loadAll().then(resumeRun);
