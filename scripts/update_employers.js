#!/usr/bin/env node
/* =====================================================================
 * KK-RECRUITMENT - scripts/update_employers.js (v1.3)
 * Cập nhật data/employers.json từ Wikidata cho các bản ghi có wikidata_id:
 *   P1128 (employees) -> employees_approx, P2139 (total revenue) -> revenue_usd_bn_approx
 *   (quy đổi USD theo bảng tỷ giá tham khảo khi đơn vị khác USD),
 *   P856 (official website) -> website, P159 (headquarters) -> hq_city (nhãn en/vi).
 * Chỉ dùng Node 22 chuẩn (fetch, AbortSignal.timeout), không npm.
 *
 * Chạy:  node scripts/update_employers.js [--dry-run] [--timeout=8000] [--file=data/employers.json]
 *                                         [--limit=N] [--only=VN|GLOBAL] [--mock] [--quiet]
 *   --dry-run : chỉ in báo cáo thay đổi, không ghi file
 *   --mock    : dùng dữ liệu Wikidata giả lập (kiểm thử offline)
 * Lỗi mạng/bản ghi được bỏ qua (không dừng), mã thoát 0; chỉ thoát 1 khi không đọc/ghi được file.
 * Module: module.exports = { run, parseEntity, parseArgs, extractTime, FX } - test có thể tiêm fetchImpl.
 * Bản quyền: Nguyễn Duy Điển (KK-2026)
 * ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const WD_ENTITY = (qid) => `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`;
const WD_LABELS = (ids) =>
  `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.join('|')}&props=labels&languages=en|vi&format=json`;
/** Tỷ giá tham khảo -> USD (cập nhật thủ công, chỉ để ước lượng) */
const FX = {
  Q4917: 1, // USD
  Q4916: 1.08, // EUR
  Q25224: 1.27, // GBP
  Q8146: 0.0066, // JPY
  Q8183: 0.00073, // KRW
  Q39099: 0.14, // CNY
  Q208526: 0.031, // TWD
  Q25344: 1.12, // CHF
  Q80524: 0.012, // INR
  Q192090: 0.00004, // VND
  Q4578: 0.0028 // (dự phòng) - đơn vị không xác định sẽ bị bỏ qua
};

function parseArgs(argv) {
  const a = { dryRun: false, timeout: 8000, file: null, limit: 0, only: '', mock: false, quiet: false };
  for (const x of argv) {
    if (x === '--dry-run') a.dryRun = true;
    else if (x === '--mock') a.mock = true;
    else if (x === '--quiet') a.quiet = true;
    else if (x.startsWith('--timeout=')) a.timeout = Math.max(1000, Number(x.slice(10)) || 8000);
    else if (x.startsWith('--file=')) a.file = x.slice(7);
    else if (x.startsWith('--limit=')) a.limit = Math.max(0, Number(x.slice(8)) || 0);
    else if (x.startsWith('--only=')) a.only = x.slice(7).toUpperCase();
  }
  return a;
}

/** Lấy thời điểm (P585 point in time / P580 start) của một statement để chọn giá trị mới nhất */
function extractTime(st) {
  const q = (st && st.qualifiers) || {};
  const t = (q.P585 || q.P580 || [])[0];
  const v = t && t.datavalue && t.datavalue.value && t.datavalue.value.time;
  return v ? String(v).replace(/^\+/, '').slice(0, 10) : '';
}
/** Chọn statement tốt nhất: rank preferred > normal, rồi thời điểm mới nhất */
function bestStatement(list) {
  const ok = (list || []).filter((s) => s.rank !== 'deprecated' && s.mainsnak && s.mainsnak.datavalue);
  if (!ok.length) return null;
  const score = (s) => (s.rank === 'preferred' ? 1 : 0);
  return ok.slice().sort((a, b) => score(b) - score(a) || (extractTime(b) > extractTime(a) ? 1 : extractTime(b) < extractTime(a) ? -1 : 0))[0];
}
/** Trích các trường quan tâm từ JSON Special:EntityData */
function parseEntity(json, qid) {
  const ent = json && json.entities && json.entities[qid];
  if (!ent) return null;
  const cl = ent.claims || {};
  const out = { qid, label: (ent.labels && ((ent.labels.en || {}).value || (ent.labels.vi || {}).value)) || null };
  const emp = bestStatement(cl.P1128);
  if (emp) {
    const n = Number(emp.mainsnak.datavalue.value.amount);
    if (isFinite(n) && n > 0) {
      out.employees = Math.round(n);
      out.employees_time = extractTime(emp);
    }
  }
  const rev = bestStatement(cl.P2139);
  if (rev) {
    const v = rev.mainsnak.datavalue.value;
    const amount = Number(v.amount);
    const unit = String(v.unit || '').replace(/^.*\/(Q\d+)$/, '$1');
    const fx = FX[unit];
    if (isFinite(amount) && fx) {
      out.revenue_usd_bn = Math.round((amount * fx) / 1e9 * 100) / 100;
      out.revenue_unit = unit;
      out.revenue_time = extractTime(rev);
    } else if (isFinite(amount)) out.revenue_skipped_unit = unit || 'unknown';
  }
  const web = bestStatement(cl.P856);
  if (web && typeof web.mainsnak.datavalue.value === 'string') out.website = web.mainsnak.datavalue.value.trim();
  const hq = bestStatement(cl.P159);
  if (hq && hq.mainsnak.datavalue.value && hq.mainsnak.datavalue.value.id) out.hq_qid = hq.mainsnak.datavalue.value.id;
  return out;
}

/* ---------- Mock Wikidata (kiểm thử offline) ---------- */
function mockFetch(url) {
  const m = /Special:EntityData\/(Q\d+)\.json/.exec(url);
  const body = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (m) {
    const qid = m[1];
    const seed = [...qid].reduce((a, c) => a + c.charCodeAt(0), 0);
    const amount = 10000 + (seed % 90) * 1000;
    return Promise.resolve(
      body({
        entities: {
          [qid]: {
            labels: { en: { value: 'Mock ' + qid } },
            claims: {
              P1128: [
                {
                  rank: 'normal',
                  mainsnak: { datavalue: { value: { amount: '+' + amount } } },
                  qualifiers: { P585: [{ datavalue: { value: { time: '+2025-12-31T00:00:00Z' } } }] }
                },
                { rank: 'normal', mainsnak: { datavalue: { value: { amount: '+' + (amount - 500) } } }, qualifiers: { P585: [{ datavalue: { value: { time: '+2023-12-31T00:00:00Z' } } }] } }
              ],
              P2139: [
                {
                  rank: 'normal',
                  mainsnak: { datavalue: { value: { amount: '+' + amount * 1000000, unit: 'http://www.wikidata.org/entity/Q4917' } } },
                  qualifiers: { P585: [{ datavalue: { value: { time: '+2025-12-31T00:00:00Z' } } }] }
                }
              ],
              P856: [{ rank: 'preferred', mainsnak: { datavalue: { value: 'https://mock.example.com/' + qid.toLowerCase() } } }],
              P159: [{ rank: 'normal', mainsnak: { datavalue: { value: { id: 'Q1' + qid.slice(1) } } } }]
            }
          }
        }
      })
    );
  }
  if (/wbgetentities/.test(url)) {
    const ids = decodeURIComponent(url.split('ids=')[1].split('&')[0]).split('|');
    const entities = {};
    ids.forEach((id) => (entities[id] = { labels: { en: { value: 'Mock City ' + id } } }));
    return Promise.resolve(body({ entities }));
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
}

async function fetchJson(fetchImpl, url, timeout) {
  const res = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': 'KK-RECRUITMENT-employers-updater/1.3 (https://www.kk-recruit.net)' },
    signal: AbortSignal.timeout(timeout)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/**
 * Chạy cập nhật. opts: {file, dryRun, timeout, limit, only, mock, fetchImpl, quiet, log}
 * Trả về {total, checked, changed, errors, skipped, changes:[{id,field,from,to}], doc}
 */
async function run(opts) {
  opts = opts || {};
  const file = opts.file || path.resolve(__dirname, '..', 'data', 'employers.json');
  const log = opts.quiet ? () => {} : opts.log || ((...a) => console.log(...a));
  const fetchImpl = opts.fetchImpl || (opts.mock ? mockFetch : globalThis.fetch);
  if (!fetchImpl) throw new Error('Môi trường không có fetch (cần Node >= 18)');
  const timeout = opts.timeout || 8000;
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(doc.employers) ? doc.employers : [];
  let targets = list.filter((e) => e.wikidata_id && /^Q\d+$/.test(e.wikidata_id));
  if (opts.only) targets = targets.filter((e) => e.region === opts.only);
  if (opts.limit) targets = targets.slice(0, opts.limit);
  const report = { total: list.length, checked: 0, changed: 0, errors: 0, skipped: list.length - targets.length, changes: [], errorList: [] };
  const now = new Date().toISOString();
  const hqToResolve = new Map();
  const parsed = new Map();
  log(`[employers] ${now} - ${targets.length}/${list.length} bản ghi có wikidata_id${opts.dryRun ? ' (DRY-RUN)' : ''}${opts.mock ? ' (MOCK)' : ''}`);
  for (const e of targets) {
    try {
      const json = await fetchJson(fetchImpl, WD_ENTITY(e.wikidata_id), timeout);
      const p = parseEntity(json, e.wikidata_id);
      if (!p) throw new Error('Không có entity ' + e.wikidata_id);
      parsed.set(e.id, p);
      if (p.hq_qid) hqToResolve.set(p.hq_qid, null);
      report.checked++;
    } catch (err) {
      report.errors++;
      report.errorList.push({ id: e.id, error: err.message || String(err) });
      log(`  ! ${e.id}: bỏ qua (${err.message || err})`);
    }
  }
  // Nhãn trụ sở (batch 50 QID / lần)
  const hqIds = [...hqToResolve.keys()];
  for (let i = 0; i < hqIds.length; i += 50) {
    const chunk = hqIds.slice(i, i + 50);
    try {
      const j = await fetchJson(fetchImpl, WD_LABELS(chunk), timeout);
      for (const id of chunk) {
        const ent = j.entities && j.entities[id];
        const lb = ent && ent.labels && ((ent.labels.vi || {}).value || (ent.labels.en || {}).value);
        if (lb) hqToResolve.set(id, lb);
      }
    } catch (err) {
      log(`  ! nhãn trụ sở: bỏ qua (${err.message || err})`);
    }
  }
  const apply = (e, field, to, meta) => {
    const from = e[field];
    if (to === undefined || to === null || to === '' || from === to) return;
    report.changes.push({ id: e.id, field, from, to, meta: meta || null });
    e[field] = to;
    e._changed = true;
  };
  for (const e of targets) {
    const p = parsed.get(e.id);
    if (!p) continue;
    if (p.employees) apply(e, 'employees_approx', p.employees, { time: p.employees_time });
    if (p.revenue_usd_bn) apply(e, 'revenue_usd_bn_approx', p.revenue_usd_bn, { unit: p.revenue_unit, time: p.revenue_time });
    if (p.website) apply(e, 'website', p.website);
    if (p.hq_qid && hqToResolve.get(p.hq_qid)) apply(e, 'hq_city', hqToResolve.get(p.hq_qid), { qid: p.hq_qid });
    if (e._changed) {
      e.updated_at = now;
      e.wikidata_checked_at = now;
      report.changed++;
    } else e.wikidata_checked_at = now;
    delete e._changed;
  }
  if (report.changed) doc.updated_at = now;
  doc.last_update_run = { at: now, checked: report.checked, changed: report.changed, errors: report.errors, dry_run: !!opts.dryRun, mock: !!opts.mock };
  for (const c of report.changes) log(`  ~ ${c.id}.${c.field}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}${c.meta && c.meta.time ? ' (' + c.meta.time + ')' : ''}`);
  log(`[employers] kiểm tra ${report.checked}, thay đổi ${report.changed} trường/bản ghi, lỗi ${report.errors}, bỏ qua (không QID) ${report.skipped}`);
  if (!opts.dryRun) {
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    log(`[employers] đã ghi ${path.relative(process.cwd(), file)}`);
  } else log('[employers] DRY-RUN: không ghi file');
  report.doc = doc;
  return report;
}

module.exports = { run, parseEntity, parseArgs, extractTime, bestStatement, mockFetch, FX };

if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  run({ dryRun: a.dryRun, timeout: a.timeout, file: a.file ? path.resolve(a.file) : null, limit: a.limit, only: a.only, mock: a.mock, quiet: a.quiet })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[employers] THẤT BẠI:', e.message);
      process.exit(1);
    });
}
