#!/usr/bin/env node
/* =====================================================================
 * KK-RECRUITMENT - scripts/update_jobs.js (v1.0) - KK JobHunter
 * Công cụ SĂN TIN TUYỂN DỤNG tự động, chạy 2 lần/ngày (GitHub Actions 06:17 và 18:17 giờ Việt Nam).
 * Lấy tin đang mở từ KÊNH CHÍNH THỨC của 100 nhà tuyển dụng trong data/employers.json:
 *   - API công khai của hệ thống tuyển dụng (ATS) mà doanh nghiệp dùng: Greenhouse, Lever, Ashby,
 *     SmartRecruiters, Workable, Recruitee, Workday, Oracle Recruiting Cloud, Eightfold, Amazon Jobs, Tencent
 *   - Dữ liệu có cấu trúc schema.org JobPosting (JSON-LD) trên trang tuyển dụng của doanh nghiệp
 *   - Tự dò nguồn từ trang tuyển dụng chính thức (careers_url) khi chưa được khai báo
 * Nguyên tắc: tôn trọng robots.txt, giãn cách yêu cầu theo máy chủ, chỉ lưu SIÊU DỮ LIỆU công khai
 * (chức danh, nơi làm việc, bộ phận, ngày đăng, liên kết gốc) - không chép mô tả công việc, không dữ liệu cá nhân;
 * ứng viên luôn ứng tuyển tại trang gốc của doanh nghiệp.
 * An toàn dữ liệu: nguồn lỗi -> giữ tin cũ tối đa 72 giờ; tổng tin giảm bất thường (< 40%) -> giữ bản trước.
 *
 * Chạy:  node scripts/update_jobs.js [--dir=.] [--only=id1,id2] [--probe] [--no-discover]
 *                                    [--timeout=20000] [--dry-run] [--quiet]
 * Ra:    data/jobs.json (tin, khóa rút gọn) - data/jobs_meta.json (số liệu nhỏ cho trang chủ)
 *        data/jobs_report.json (trạng thái từng nhà tuyển dụng / nguồn) - data/jobs_sources_auto.json (nguồn tự dò)
 * Module: module.exports = { run, adapters, detectSources, parseRobots, robotsAllowed, countryOf, parseJsonLd, ... }
 *         (kiểm thử tiêm fetchImpl). Mã thoát 0 kể cả khi có nguồn lỗi; 1 chỉ khi không đọc/ghi được tệp.
 * Bản quyền: Nguyễn Duy Điển
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const UA = "KK-RECRUITMENT-JobHunter/1.0 (+https://www.kk-recruit.net)";
const UA_TOKEN = "kk-recruitment-jobhunter";
const VERSION = 1;

/* ---------------- Tiện ích ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
const clean = (s, max = 160) =>
  String(s == null ? "" : s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const isHttps = (u) => /^https:\/\/[^\s"'<>]+$/i.test(String(u || ""));
const isoDate = (v) => {
  if (v == null || v === "") return "";
  let d;
  if (typeof v === "number") d = new Date(v < 1e12 ? v * 1000 : v);
  else d = new Date(String(v));
  return isNaN(d) ? "" : d.toISOString().slice(0, 10);
};
/** "Posted Today" / "Posted 3 Days Ago" / "Posted 30+ Days Ago" (Workday) -> ngày ISO xấp xỉ */
const relDate = (s, now = Date.now()) => {
  const t = String(s || "").toLowerCase();
  if (!t) return "";
  if (/today|hôm nay/.test(t)) return isoDate(now);
  if (/yesterday|hôm qua/.test(t)) return isoDate(now - 864e5);
  const m = /(\d+)\+?\s*(day|ngày)/.exec(t);
  if (m) return isoDate(now - Number(m[1]) * 864e5);
  return isoDate(t);
};

const VN_RE =
  /vi[eệ]t\s*nam|\bvnm?\b|h[aà]\s*n[oộ]i|hanoi|h[oồ]\s*ch[ií]\s*minh|\bhcmc?\b|saigon|s[aà]i\s*g[oò]n|đ[aà]\s*n[aẵ]ng|da\s*nang|h[aả]i\s*ph[oò]ng|hai\s*phong|b[aắ]c\s*ninh|bac\s*ninh|b[iì]nh\s*d[uư][oơ]ng|binh\s*duong|đ[oồ]ng\s*nai|dong\s*nai|c[aầ]n\s*th[oơ]|can\s*tho|th[aá]i\s*nguy[eê]n|vinh\s*phuc|v[iĩ]nh\s*ph[uú]c|nha\s*trang|v[uũ]ng\s*t[aà]u|quang\s*ninh|qu[aả]ng\s*ninh|long\s*an|h[uư]ng\s*y[eê]n|hung\s*yen/i;
/** 'VN' nếu nơi làm việc ở Việt Nam, ngược lại 'INTL' */
const countryOf = (...parts) => (VN_RE.test(parts.filter(Boolean).join(" | ")) ? "VN" : "INTL");
const remoteOf = (...parts) => /remote|từ xa|work from home|wfh|anywhere/i.test(parts.filter(Boolean).join(" "));

/* ---------------- HTTP: giãn cách theo máy chủ + robots.txt ---------------- */
function makeHttp(opts) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeout = opts.timeout || 20000;
  const gap = opts.gap == null ? 800 : opts.gap; // ms giữa 2 yêu cầu cùng máy chủ
  const last = new Map();
  const robots = new Map();
  let count = 0;
  async function raw(url, init = {}, tries = 2) {
    const host = new URL(url).host;
    const wait = (last.get(host) || 0) + gap - Date.now();
    if (wait > 0) await sleep(wait);
    last.set(host, Date.now());
    count++;
    const headers = Object.assign(
      { "User-Agent": UA, Accept: "application/json, text/html;q=0.9, */*;q=0.5", "Accept-Language": "en-US,en;q=0.9,vi;q=0.8" },
      init.headers || {},
    );
    try {
      const r = await fetchImpl(url, Object.assign({}, init, { headers, redirect: "follow", signal: AbortSignal.timeout(timeout) }));
      if ((r.status === 429 || r.status >= 500) && tries > 1) {
        await sleep(2500);
        return raw(url, init, tries - 1);
      }
      return r;
    } catch (e) {
      if (tries > 1) {
        await sleep(1500);
        return raw(url, init, tries - 1);
      }
      throw e;
    }
  }
  async function allowed(url) {
    const u = new URL(url);
    const key = u.protocol + "//" + u.host;
    if (!robots.has(key)) {
      robots.set(
        key,
        (async () => {
          try {
            const r = await raw(key + "/robots.txt", { headers: { Accept: "text/plain,*/*" } }, 1);
            if (r.status >= 400 && r.status < 500) return null; // không có robots.txt -> được phép
            if (!r.ok) return { error: "robots " + r.status };
            return parseRobots(await r.text());
          } catch (e) {
            return { error: "robots " + (e.name === "TimeoutError" ? "timeout" : e.message) };
          }
        })(),
      );
    }
    const rules = await robots.get(key);
    if (rules && rules.error) return false; // không đọc được robots.txt (5xx/mạng) -> thận trọng: bỏ qua lần này
    return robotsAllowed(rules, u.pathname + u.search);
  }
  async function get(url, init = {}, kind = "json") {
    if (!(await allowed(url))) {
      const e = new Error("robots.txt không cho phép");
      e.code = "ROBOTS";
      throw e;
    }
    const r = await raw(url, init);
    if (!r.ok) {
      const e = new Error("HTTP " + r.status);
      e.code = "HTTP" + r.status;
      throw e;
    }
    if (kind === "text") return r.text();
    const txt = await r.text();
    try {
      return JSON.parse(txt);
    } catch (e) {
      const er = new Error("Không phải JSON");
      er.code = "NOTJSON";
      throw er;
    }
  }
  return {
    json: (url, init) => get(url, init, "json"),
    text: (url, init) => get(url, init, "text"),
    post: (url, body, init = {}) =>
      get(
        url,
        Object.assign({ method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Accept: "application/json" } }, init),
        "json",
      ),
    allowed,
    count: () => count,
  };
}

/** robots.txt -> nhóm luật áp dụng cho JobHunter (ưu tiên nhóm đích danh, sau đó '*') */
function parseRobots(txt) {
  const groups = [];
  let cur = null,
    lastWasAgent = false;
  for (const line0 of String(txt).split(/\r?\n/)) {
    const line = line0.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase(),
      v = m[2].trim();
    if (k === "user-agent") {
      if (!lastWasAgent || !cur) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (k === "allow" || k === "disallow") cur.rules.push({ allow: k === "allow", path: v });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && UA_TOKEN.includes(a)));
  const star = groups.filter((g) => g.agents.includes("*"));
  const use = mine.length ? mine : star;
  return { rules: use.flatMap((g) => g.rules) };
}
function robotsAllowed(rules, p) {
  if (!rules || !rules.rules || !rules.rules.length) return true;
  let best = null;
  for (const r of rules.rules) {
    if (r.path === "") {
      if (!r.allow) continue; // "Disallow:" rỗng = cho phép tất cả
    }
    const re = new RegExp(
      "^" +
        r.path
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\\\$$/, "$"),
    );
    if (re.test(p)) {
      const len = r.path.length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
    }
  }
  return best ? best.allow : true;
}

/* ---------------- schema.org JobPosting (JSON-LD) ---------------- */
function parseJsonLd(html, pageUrl) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    const t = [].concat(o["@type"] || []).map(String);
    if (t.includes("JobPosting")) out.push(o);
    if (o["@graph"]) walk(o["@graph"]);
    if (o.itemListElement) walk([].concat(o.itemListElement).map((x) => (x && x.item ? x.item : x)));
  };
  while ((m = re.exec(html))) {
    try {
      walk(JSON.parse(m[1].trim()));
    } catch (e) {
      /* khối JSON-LD hỏng -> bỏ qua */
    }
  }
  return out.map((j) => {
    const locs = [].concat(j.jobLocation || []).map((l) => (l && l.address ? l.address : l || {}));
    const loc = locs
      .map((a) =>
        [a.addressLocality, a.addressRegion, typeof a.addressCountry === "object" ? a.addressCountry.name : a.addressCountry].filter(Boolean).join(", "),
      )
      .filter(Boolean)
      .join(" / ");
    return {
      title: j.title || j.name,
      location: loc || (j.jobLocationType === "TELECOMMUTE" ? "Remote" : ""),
      department: (j.occupationalCategory && String(j.occupationalCategory)) || "",
      type: [].concat(j.employmentType || []).join(", "),
      posted: j.datePosted,
      url: j.url && /^https?:/.test(j.url) ? j.url : pageUrl,
      remote: j.jobLocationType === "TELECOMMUTE",
    };
  });
}

/* ---------------- Bộ chuyển đổi theo hệ thống tuyển dụng ----------------
 * Mỗi adapter(src, http, ctx) -> { jobs: [{title, location, department, type, posted, url, remote}], total, key }
 * ctx: { vnLimit, intlLimit } - lấy đủ tin Việt Nam (tối đa vnLimit) + mẫu tin mới nhất toàn cầu (intlLimit) */
const adapters = {
  async greenhouse(s, http) {
    const d = await http.json(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s.token)}/jobs`);
    const jobs = (d.jobs || []).map((j) => ({ title: j.title, location: j.location && j.location.name, posted: j.updated_at, url: j.absolute_url }));
    return { jobs, total: jobs.length, key: "greenhouse:" + s.token };
  },
  async lever(s, http) {
    const d = await http.json(`https://api.lever.co/v0/postings/${encodeURIComponent(s.site)}?mode=json`);
    const jobs = (Array.isArray(d) ? d : []).map((j) => {
      const c = j.categories || {};
      return {
        title: j.text,
        location: c.location || (c.allLocations || []).join(" / "),
        department: c.team || c.department,
        type: c.commitment,
        posted: j.createdAt,
        url: j.hostedUrl,
        remote: j.workplaceType === "remote",
      };
    });
    return { jobs, total: jobs.length, key: "lever:" + s.site };
  },
  async ashby(s, http) {
    const d = await http.json(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s.org)}`);
    const jobs = (d.jobs || []).map((j) => ({
      title: j.title,
      location: j.location,
      department: j.department || j.team,
      type: j.employmentType,
      posted: j.publishedAt,
      url: j.jobUrl,
      remote: !!j.isRemote,
    }));
    return { jobs, total: jobs.length, key: "ashby:" + s.org };
  },
  async smartrecruiters(s, http, ctx) {
    const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(s.company)}/postings`;
    const map = (j) => {
      const l = j.location || {};
      return {
        title: j.name,
        location: l.fullLocation || [l.city, l.region, (l.country || "").toUpperCase()].filter(Boolean).join(", "),
        country: (l.country || "").toLowerCase() === "vn" ? "VN" : "",
        department: j.department && j.department.label,
        type: j.typeOfEmployment && j.typeOfEmployment.label,
        posted: j.releasedDate,
        url: `https://jobs.smartrecruiters.com/${encodeURIComponent(s.company)}/${j.id}`,
        remote: !!l.remote,
      };
    };
    const jobs = [];
    let total = 0;
    // 1) Tin tại Việt Nam (phân trang)
    for (let off = 0; off < ctx.vnLimit; off += 100) {
      const d = await http.json(`${base}?country=vn&limit=100&offset=${off}`);
      (d.content || []).forEach((j) => jobs.push(map(j)));
      if (!d.content || d.content.length < 100) break;
    }
    // 2) Mẫu tin mới nhất toàn cầu (doanh nghiệp toàn cầu)
    if (ctx.intlLimit > 0) {
      const d = await http.json(`${base}?limit=${Math.min(100, ctx.intlLimit)}&offset=0`);
      total = d.totalFound || 0;
      (d.content || []).forEach((j) => jobs.push(map(j)));
    }
    return { jobs, total: total || jobs.length, key: "smartrecruiters:" + s.company };
  },
  async workable(s, http) {
    const d = await http.json(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(s.account)}`);
    const jobs = (d.jobs || []).map((j) => ({
      title: j.title,
      location: [j.city, j.state, j.country].filter(Boolean).join(", "),
      department: j.department,
      type: j.employment_type,
      posted: j.published_on || j.created_at,
      url: j.url || j.shortlink,
      remote: !!j.telecommuting,
    }));
    return { jobs, total: jobs.length, key: "workable:" + s.account };
  },
  async recruitee(s, http) {
    const d = await http.json(`https://${encodeURIComponent(s.sub)}.recruitee.com/api/offers/`);
    const jobs = (d.offers || []).map((j) => ({
      title: j.title,
      location: j.location || [j.city, j.country].filter(Boolean).join(", "),
      department: j.department,
      type: j.employment_type_code,
      posted: j.published_at || j.created_at,
      url: j.careers_url,
      remote: !!j.remote,
    }));
    return { jobs, total: jobs.length, key: "recruitee:" + s.sub };
  },
  /** Workday: API JSON công khai của trang tuyển dụng (POST .../wday/cxs/{tenant}/{site}/jobs) */
  async workday(s, http, ctx) {
    const api = `https://${s.host}/wday/cxs/${s.tenant}/${s.site}/jobs`;
    const map = (j) => ({
      title: j.title,
      location: j.locationsText,
      posted: relDate(j.postedOn),
      url: `https://${s.host}/${s.site}${j.externalPath || ""}`,
      department: "",
    });
    const first = await http.post(api, { appliedFacets: {}, limit: 20, offset: 0, searchText: "" });
    const jobs = [];
    const total = first.total || 0;
    if (ctx.intlLimit > 0) (first.jobPostings || []).slice(0, ctx.intlLimit).forEach((j) => jobs.push(map(j)));
    // Tìm giá trị bộ lọc "Vietnam" trong facets (đệ quy); ưu tiên bộ lọc cấp QUỐC GIA, nếu không có thì gộp các địa điểm VN
    const hits = [];
    const scan = (arr, param) =>
      (arr || []).forEach((f) => {
        const p = f.facetParameter || param;
        (f.values || []).forEach((v) => {
          if (/viet\s*nam/i.test(v.descriptor || "") && v.id) hits.push({ param: p, id: v.id, count: v.count || 0 });
          if (v.values) scan([v], p);
        });
      });
    scan(first.facets);
    let facet = null;
    if (hits.length) {
      const byParam = {};
      hits.forEach((h) => (byParam[h.param] = byParam[h.param] || { param: h.param, ids: [], count: 0 }).ids.push(h.id) && (byParam[h.param].count += h.count));
      const groups = Object.values(byParam);
      facet = groups.find((g) => /country/i.test(g.param)) || groups.sort((a, b) => b.count - a.count)[0];
      facet = { param: facet.param, ids: facet.ids, count: facet.count };
    }
    if (facet) {
      for (let off = 0; off < Math.min(ctx.vnLimit, facet.count || ctx.vnLimit); off += 20) {
        const d = await http.post(api, { appliedFacets: { [facet.param]: facet.ids }, limit: 20, offset: off, searchText: "" });
        (d.jobPostings || []).forEach((j) => jobs.push(Object.assign(map(j), { country: "VN" })));
        if (!d.jobPostings || d.jobPostings.length < 20) break;
      }
    } else if (s.vnSearch !== false) {
      const d = await http.post(api, { appliedFacets: {}, limit: 20, offset: 0, searchText: "Vietnam" });
      (d.jobPostings || []).forEach((j) => {
        const m = map(j);
        if (countryOf(m.location) === "VN") jobs.push(m);
      });
    }
    return { jobs, total, key: `workday:${s.tenant}/${s.site}` };
  },
  /** Oracle Recruiting Cloud (Candidate Experience) - REST công khai */
  async oracle(s, http, ctx) {
    const jobs = [];
    let total = 0;
    const pages = Math.max(1, Math.ceil((s.scan || 200) / 25));
    for (let i = 0; i < pages; i++) {
      const url = `https://${s.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=${s.site},limit=25,offset=${i * 25},sortBy=POSTING_DATES_DESC`;
      const d = await http.json(url);
      const it = (d.items || [])[0] || {};
      total = it.TotalJobsCount || total;
      const list = it.requisitionList || [];
      list.forEach((j, k) => {
        const loc = [j.PrimaryLocation, ...(j.secondaryLocations || []).map((x) => x.Name)].filter(Boolean).join(" / ");
        const vn = j.PrimaryLocationCountry === "VN" || countryOf(loc) === "VN";
        if (vn || i * 25 + k < ctx.intlLimit)
          jobs.push({
            title: j.Title,
            location: loc,
            country: vn ? "VN" : "",
            department: j.JobFamily || j.Organization || "",
            type: j.WorkerType || j.JobSchedule,
            posted: j.PostedDate,
            url: `https://${s.host}/hcmUI/CandidateExperience/en/sites/${s.site}/job/${j.Id}`,
          });
      });
      if (list.length < 25) break;
    }
    return { jobs, total, key: `oracle:${s.host.split(".")[0]}/${s.site}` };
  },
  /** Eightfold (apply.*): /api/apply/v2/jobs */
  async eightfold(s, http, ctx) {
    const jobs = [];
    let total = 0;
    const map = (p) => ({
      title: p.name,
      location: p.location || (p.locations || []).join(" / "),
      department: p.department,
      posted: p.t_create,
      url: p.canonicalPositionUrl || `https://${s.host}/careers/job/${p.id}`,
      type: p.type,
    });
    const vn = await http.json(
      `https://${s.host}/api/apply/v2/jobs?domain=${encodeURIComponent(s.domain)}&start=0&num=${Math.min(100, ctx.vnLimit)}&location=Vietnam&sort_by=timestamp`,
    );
    (vn.positions || []).forEach((p) => {
      const m = map(p);
      if (countryOf(m.location) === "VN") jobs.push(Object.assign(m, { country: "VN" }));
    });
    if (ctx.intlLimit > 0) {
      const g = await http.json(`https://${s.host}/api/apply/v2/jobs?domain=${encodeURIComponent(s.domain)}&start=0&num=${ctx.intlLimit}&sort_by=timestamp`);
      total = g.count || 0;
      (g.positions || []).forEach((p) => jobs.push(map(p)));
    }
    return { jobs, total, key: "eightfold:" + s.domain };
  },
  async amazon(s, http, ctx) {
    const jobs = [];
    let total = 0;
    const map = (j) => ({
      title: j.title,
      location: j.normalized_location || j.location,
      department: j.job_category || j.business_category,
      posted: j.posted_date,
      url: "https://www.amazon.jobs" + (j.job_path || ""),
      type: j.job_schedule_type,
    });
    const vn = await http.json(`https://www.amazon.jobs/en/search.json?normalized_country_code%5B%5D=VNM&result_limit=100&offset=0&sort=recent`);
    (vn.jobs || []).forEach((j) => jobs.push(Object.assign(map(j), { country: "VN" })));
    if (ctx.intlLimit > 0) {
      const g = await http.json(`https://www.amazon.jobs/en/search.json?result_limit=${ctx.intlLimit}&offset=0&sort=recent`);
      total = g.hits || 0;
      (g.jobs || []).forEach((j) => jobs.push(map(j)));
    }
    return { jobs, total, key: "amazon" };
  },
  async tencent(s, http, ctx) {
    const d = await http.json(
      `https://careers.tencent.com/tencentcareer/api/post/Query?timestamp=${Date.now()}&pageIndex=1&pageSize=${Math.max(20, ctx.intlLimit)}&language=en-us&area=us&keyword=`,
    );
    const D = d.Data || {};
    const jobs = (D.Posts || []).map((j) => ({
      title: j.RecruitPostName,
      location: [j.LocationName, j.CountryName].filter(Boolean).join(", "),
      department: j.CategoryName || j.BGName,
      posted: j.LastUpdateTime,
      url: j.PostURL || `https://careers.tencent.com/en-us/jobdesc.html?postId=${j.PostId}`,
    }));
    return { jobs, total: D.Count || jobs.length, key: "tencent" };
  },
  /** API JSON công khai của trang tuyển dụng tự xây (cấu hình ánh xạ trường):
   *  {type:'json', url, method?, body?, format?:'nextdata', list:'data.items', fields:{title, location, department, type, posted, url}}
   *  Giá trị trường: đường dẫn 'a.b.c' hoặc mẫu chứa {a.b} (vd 'https://x.vn/job/{id}'); nhiều trang: pages + {page} trong url/body */
  async json(s, http) {
    const get = (o, p) =>
      String(p)
        .split(".")
        .reduce((x, k) => (x == null ? x : x[k]), o);
    const val = (o, spec) =>
      spec == null ? "" : String(spec).includes("{") ? String(spec).replace(/\{([^}]+)\}/g, (_, p) => encodeURIComponent(get(o, p) ?? "")) : get(o, spec);
    const jobs = [];
    let total = 0;
    for (let page = s.firstPage ?? 1, n = 0; n < (s.pages || 1); n++, page++) {
      const url = String(s.url).replace("{page}", page);
      let d;
      if (s.format === "nextdata") {
        // Trang Next.js dựng sẵn phía máy chủ: dữ liệu nằm trong <script id="__NEXT_DATA__">
        const html = await http.text(url, { headers: { Accept: "text/html,application/xhtml+xml" } });
        const m = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/.exec(html);
        d = m ? JSON.parse(m[1]) : {};
      } else d = s.method === "POST" ? await http.post(url, JSON.parse(JSON.stringify(s.body || {}).replace('"{page}"', page))) : await http.json(url);
      const list = get(d, s.list) || [];
      if (s.totalPath) total = Number(get(d, s.totalPath)) || total;
      list.forEach((o) => {
        const f = s.fields || {};
        jobs.push({
          title: val(o, f.title),
          location: val(o, f.location),
          department: val(o, f.department),
          type: val(o, f.type),
          posted: val(o, f.posted),
          url: val(o, f.url),
          remote: false,
        });
      });
      if (!Array.isArray(list) || list.length === 0 || (s.pageSize && list.length < s.pageSize)) break;
    }
    return { jobs, total: total || jobs.length, key: "json:" + new URL(String(s.url).replace("{page}", "1")).host };
  },
  /** Trang HTML có JobPosting JSON-LD (một hoặc nhiều URL) */
  async page(s, http) {
    const jobs = [];
    for (const u of [].concat(s.url || [])) {
      const html = await http.text(u, { headers: { Accept: "text/html,application/xhtml+xml" } });
      parseJsonLd(html, u).forEach((j) => jobs.push(j));
    }
    return { jobs, total: jobs.length, key: "page:" + new URL([].concat(s.url)[0]).host };
  },
};

/* ---------------- Tự dò nguồn từ trang tuyển dụng chính thức ---------------- */
const ATS_PATTERNS = [
  [/(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9_-]+)/i, (m) => ({ type: "greenhouse", token: m[1] })],
  [/boards-api\.greenhouse\.io\/v1\/boards\/([A-Za-z0-9_-]+)/i, (m) => ({ type: "greenhouse", token: m[1] })],
  [/jobs\.lever\.co\/([A-Za-z0-9_-]+)/i, (m) => ({ type: "lever", site: m[1] })],
  [/jobs\.ashbyhq\.com\/([A-Za-z0-9_.-]+)/i, (m) => ({ type: "ashby", org: m[1] })],
  [/(?:careers|jobs)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/i, (m) => ({ type: "smartrecruiters", company: m[1] })],
  [/apply\.workable\.com\/([A-Za-z0-9_-]+)/i, (m) => ({ type: "workable", account: m[1] })],
  [/([a-z0-9-]+)\.recruitee\.com/i, (m) => ({ type: "recruitee", sub: m[1] })],
  [
    /([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/,
    (m) => ({ type: "workday", host: `${m[1]}.${m[2]}.myworkdayjobs.com`, tenant: m[1], site: m[3] }),
  ],
  [
    /([a-z0-9-]+\.fa(?:\.[a-z0-9-]+)?\.oraclecloud\.com)\/hcmUI\/CandidateExperience\/[a-z-]+\/sites\/([A-Za-z0-9_]+)/i,
    (m) => ({ type: "oracle", host: m[1], site: m[2] }),
  ],
];
const SKIP_TOKENS = new Set(["embed", "v1", "api", "jobs", "careers", "www", "job", "en", "en-us", "search"]);
function detectSources(html, pageUrl) {
  const found = [];
  const seen = new Set();
  for (const [re, mk] of ATS_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m;
    while ((m = g.exec(html))) {
      const s = mk(m);
      const id = JSON.stringify(s);
      const tok = s.token || s.site || s.org || s.company || s.account || s.sub;
      if (seen.has(id) || (tok && SKIP_TOKENS.has(String(tok).toLowerCase()))) continue;
      seen.add(id);
      found.push(Object.assign(s, { discovered: pageUrl }));
    }
  }
  if (parseJsonLd(html, pageUrl).length) found.push({ type: "page", url: pageUrl, discovered: pageUrl });
  return found;
}
/** Liên kết nội bộ có khả năng dẫn tới trang tuyển dụng / danh sách việc làm */
function careerLinks(html, base) {
  const out = [];
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 40) {
    const txt = clean(m[2], 80);
    if (!/career|job|tuy[eể]n\s*d[uụ]ng|tuyen-dung|recruit|vi[eệ]c\s*l[aà]m|opportunit|join us|gia nh[aậ]p/i.test(m[1] + " " + txt)) continue;
    try {
      const u = new URL(m[1], base);
      if (u.protocol === "https:" && !out.includes(u.href)) out.push(u.href);
    } catch (e) {
      /* bỏ qua */
    }
  }
  return out;
}
async function discover(emp, http, maxPages = 3) {
  const start = emp.careers_url || emp.website;
  if (!isHttps(start)) return { sources: [], pages: 0, note: "không có trang tuyển dụng https" };
  const queue = [start];
  const visited = new Set();
  const sources = [];
  let note = "";
  while (queue.length && visited.size < maxPages) {
    const u = queue.shift();
    if (visited.has(u)) continue;
    visited.add(u);
    let html;
    try {
      html = await http.text(u, { headers: { Accept: "text/html,application/xhtml+xml" } });
    } catch (e) {
      note = e.code === "ROBOTS" ? "robots.txt chặn trang tuyển dụng" : e.message;
      continue;
    }
    detectSources(html, u).forEach((s) => {
      if (!sources.some((x) => JSON.stringify({ ...x, discovered: 0 }) === JSON.stringify({ ...s, discovered: 0 }))) sources.push(s);
    });
    if (sources.some((s) => s.type !== "page")) break; // đã thấy hệ thống ATS -> đủ
    const host = new URL(u).host.replace(/^www\./, "");
    careerLinks(html, u)
      .filter((l) => {
        const h = new URL(l).host.replace(/^www\./, "");
        return h === host || h.endsWith("." + host) || /myworkdayjobs|greenhouse|lever\.co|smartrecruiters|ashbyhq|workable|recruitee|oraclecloud/.test(h);
      })
      .slice(0, 6)
      .forEach((l) => {
        if (!visited.has(l) && !queue.includes(l)) queue.push(l);
      });
  }
  return { sources, pages: visited.size, note };
}

/* ---------------- Chuẩn hóa + chạy ---------------- */
function normalize(raw, emp, srcKey, now) {
  const title = clean(raw.title, 140);
  const url = String(raw.url || "").trim();
  if (!title || !isHttps(url)) return null;
  const location = clean(raw.location, 120);
  const c = raw.country === "VN" ? "VN" : countryOf(location, emp.region === "VN" && !location ? "Vietnam" : "");
  return {
    i: sha(url),
    e: emp.id,
    t: title,
    l: location,
    c,
    d: clean(raw.department, 60),
    y: clean(raw.type, 40),
    r: raw.remote || remoteOf(location) ? 1 : 0,
    p: isoDate(raw.posted),
    u: url,
    s: srcKey.split(":")[0],
    f: now,
    z: now,
  };
}

function parseArgs(argv) {
  const a = { dir: ".", only: [], probe: false, discover: true, timeout: 20000, dryRun: false, quiet: false, gap: 800 };
  for (const x of argv) {
    if (x === "--probe") a.probe = true;
    else if (x === "--no-discover") a.discover = false;
    else if (x === "--dry-run") a.dryRun = true;
    else if (x === "--quiet") a.quiet = true;
    else if (x.startsWith("--dir=")) a.dir = x.slice(6);
    else if (x.startsWith("--only=")) a.only = x.slice(7).split(",").filter(Boolean);
    else if (x.startsWith("--timeout=")) a.timeout = Math.max(3000, Number(x.slice(10)) || 20000);
    else if (x.startsWith("--gap=")) a.gap = Math.max(0, Number(x.slice(6)) || 0);
  }
  return a;
}
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    return d;
  }
};

async function run(args, deps = {}) {
  const t0 = Date.now();
  const nowIso = new Date(deps.now || Date.now()).toISOString();
  const log = args.quiet ? () => {} : deps.log || console.log;
  const D = (f) => path.join(args.dir, f);
  const empDoc = readJson(D("data/employers.json"), null);
  if (!empDoc || !Array.isArray(empDoc.employers)) throw new Error("Không đọc được data/employers.json");
  const cfg = readJson(D("scripts/jobs_sources.json"), { policy: {}, sources: {} });
  const auto = readJson(D("data/jobs_sources_auto.json"), { updated_at: null, sources: {} });
  const prev = readJson(D("data/jobs.json"), { jobs: [] });
  const prevMeta = readJson(D("data/jobs_meta.json"), { runs: [] });
  const P = Object.assign(
    { vnLimit: 300, intlLimit: 20, keepStaleHours: 72, minRatio: 0.4, maxTotal: 4000, rediscoverDays: 7, concurrency: 6 },
    cfg.policy || {},
  );
  const http = makeHttp({ fetchImpl: deps.fetchImpl, timeout: args.timeout, gap: args.gap });
  const prevById = new Map((prev.jobs || []).map((j) => [j.i, j]));
  const emps = empDoc.employers.filter((e) => !args.only.length || args.only.includes(e.id));
  const report = [];
  const fresh = [];
  const autoOut = { updated_at: nowIso, sources: Object.assign({}, auto.sources || {}) };

  async function handle(emp) {
    const r = { id: emp.id, name: emp.name, region: emp.region, status: "nosource", source: "", jobs: 0, vn: 0, total: 0, ms: 0, error: "", tried: [] };
    const t1 = Date.now();
    const ctx = { vnLimit: P.vnLimit, intlLimit: emp.region === "GLOBAL" ? P.intlLimit : P.vnLimit };
    const ctxFor = (s) => (s.scope === "VN" ? Object.assign({}, ctx, { intlLimit: 0 }) : ctx);
    let list = [].concat((cfg.sources || {})[emp.id] || []);
    const a = autoOut.sources[emp.id];
    const stale = !a || !a.checked_at || Date.now() - Date.parse(a.checked_at) > P.rediscoverDays * 864e5;
    if (a && a.sources && a.sources.length) list = list.concat(a.sources.filter((s) => !list.some((x) => x.type === s.type)));
    if (args.discover && (!list.length || (stale && !(cfg.sources || {})[emp.id]))) {
      const d = await discover(emp, http);
      if (emp.region === "VN") d.sources.forEach((x) => (x.scope = x.scope || "VN")); // pháp nhân VN: chỉ lấy tin tại Việt Nam
      autoOut.sources[emp.id] = { checked_at: nowIso, sources: d.sources, pages: d.pages, note: d.note };
      d.sources.forEach((s) => {
        if (!list.some((x) => JSON.stringify({ ...x, discovered: 0 }) === JSON.stringify({ ...s, discovered: 0 }))) list.push(s);
      });
      if (!d.sources.length && d.note) r.error = d.note;
    }
    const tryAll = async (srcs) => {
      for (const s of srcs) {
        const fn = adapters[s.type];
        if (!fn) continue;
        try {
          const out = await fn(s, http, ctxFor(s));
          // scope: 'VN' = chỉ tin tại Việt Nam (pháp nhân VN của tập đoàn), 'INTL' = chỉ tin ngoài VN (tránh trùng với pháp nhân VN)
          const jobs = out.jobs
            .map((j) => normalize(j, emp, out.key, nowIso))
            .filter(Boolean)
            .filter((j) => !s.scope || (s.scope === "VN" ? j.c === "VN" : j.c !== "VN"));
          r.tried.push({ key: out.key, ok: true, jobs: jobs.length });
          if (!jobs.length && !args.probe) {
            r.status = r.status === "ok" ? "ok" : "empty";
            if (!r.source) r.source = out.key;
            continue;
          }
          // chọn tin: toàn bộ tin VN (<= vnLimit) + intlLimit tin toàn cầu mới nhất
          const vn = jobs.filter((j) => j.c === "VN").slice(0, P.vnLimit);
          const intl = jobs
            .filter((j) => j.c !== "VN")
            .sort((x, y) => (y.p || "").localeCompare(x.p || ""))
            .slice(0, emp.region === "GLOBAL" ? P.intlLimit : P.vnLimit);
          const pick = vn.concat(intl);
          pick.forEach((j) => fresh.push(j));
          r.status = "ok";
          r.source = out.key;
          r.jobs += pick.length;
          r.vn += vn.length;
          r.total = Math.max(r.total, out.total || 0);
          if (!args.probe) break; // nguồn đầu tiên có tin là đủ
        } catch (e) {
          r.tried.push({
            key: s.type + ":" + (s.token || s.site || s.org || s.company || s.account || s.sub || s.tenant || s.host || s.domain || ""),
            ok: false,
            error: e.code === "ROBOTS" ? "robots" : e.name === "TimeoutError" ? "timeout" : e.message,
          });
          if (r.status !== "ok") {
            r.status = e.code === "ROBOTS" ? "robots" : "error";
            r.error = e.code === "ROBOTS" ? "robots.txt không cho phép" : e.name === "TimeoutError" ? "hết thời gian chờ" : e.message;
          }
        }
      }
    };
    await tryAll(list);
    // Tự phục hồi: nguồn khai báo lỗi / không có tin -> dò lại từ trang tuyển dụng chính thức (tối đa 1 lần / rediscoverDays)
    const done = autoOut.sources[emp.id] && autoOut.sources[emp.id].checked_at === nowIso;
    if (r.status !== "ok" && args.discover && !done && stale && list.length) {
      const d = await discover(emp, http);
      if (emp.region === "VN") d.sources.forEach((x) => (x.scope = x.scope || "VN"));
      autoOut.sources[emp.id] = { checked_at: nowIso, sources: d.sources, pages: d.pages, note: d.note };
      const extra = d.sources.filter(
        (s) => !list.some((x) => JSON.stringify({ ...x, discovered: 0, scope: 0 }) === JSON.stringify({ ...s, discovered: 0, scope: 0 })),
      );
      if (extra.length) await tryAll(extra);
    }
    if (r.status === "ok") r.error = "";
    if (!list.length && r.status === "nosource" && !r.error) r.error = "chưa có kênh dữ liệu máy đọc được";
    r.ms = Date.now() - t1;
    report.push(r);
    log(
      `${r.status.padEnd(8)} ${emp.id.padEnd(36)} ${String(r.jobs).padStart(4)} tin (VN ${r.vn}) ${r.source || r.error}${args.probe ? "\n         thử: " + JSON.stringify(r.tried) + (autoOut.sources[emp.id] && autoOut.sources[emp.id].checked_at === nowIso ? "\n         dò: " + JSON.stringify(autoOut.sources[emp.id]) : "") : ""}`,
    );
  }
  // Chạy song song có giới hạn (mỗi máy chủ vẫn giãn cách riêng)
  const queue = emps.slice();
  await Promise.all(
    Array.from({ length: Math.min(P.concurrency, queue.length) }, async () => {
      while (queue.length) await handle(queue.shift());
    }),
  );

  // Hợp nhất với dữ liệu cũ: giữ first_seen; nguồn lỗi -> giữ tin cũ tối đa keepStaleHours
  const okEmp = new Set(report.filter((r) => r.status === "ok" || r.status === "empty").map((r) => r.id));
  const byId = new Map();
  const regionOf = Object.fromEntries(empDoc.employers.map((e) => [e.id, e.region]));
  for (const j of fresh) {
    // cùng một tin do 2 pháp nhân cùng tập đoàn trả về: tin tại VN ưu tiên gán cho pháp nhân Việt Nam
    if (byId.has(j.i) && !(j.c === "VN" && regionOf[j.e] === "VN" && regionOf[byId.get(j.i).e] !== "VN")) continue;
    const old = prevById.get(j.i);
    if (old && old.f) j.f = old.f;
    byId.set(j.i, j);
  }
  const keepBefore = Date.now() - P.keepStaleHours * 36e5;
  let kept = 0;
  for (const j of prev.jobs || []) {
    if (byId.has(j.i) || okEmp.has(j.e)) continue; // nguồn chạy tốt mà không còn tin -> tin đã đóng
    if (args.only.length && !args.only.includes(j.e)) {
      byId.set(j.i, j); // chạy một phần -> giữ nguyên tin của doanh nghiệp khác
      continue;
    }
    if (Date.parse(j.z || j.f || 0) >= keepBefore) {
      byId.set(j.i, j);
      kept++;
    }
  }
  let jobs = Array.from(byId.values()).sort((a, b) => (b.p || b.f || "").localeCompare(a.p || a.f || "") || a.t.localeCompare(b.t));
  if (jobs.length > P.maxTotal)
    jobs = jobs
      .filter((j) => j.c === "VN")
      .concat(jobs.filter((j) => j.c !== "VN"))
      .slice(0, P.maxTotal);

  // Chốt an toàn: tổng giảm bất thường -> giữ bản trước (không xóa sạch trang Việc làm vì sự cố mạng)
  const prevTotal = (prev.jobs || []).length;
  let degraded = false;
  if (!args.only.length && prevTotal >= 50 && jobs.length < prevTotal * P.minRatio) {
    degraded = true;
    log(`CẢNH BÁO: tổng tin giảm bất thường ${prevTotal} -> ${jobs.length}; giữ bản trước`);
    jobs = prev.jobs;
  }
  const dayAgo = Date.now() - 864e5;
  const byEmp = {};
  jobs.forEach((j) => (byEmp[j.e] = (byEmp[j.e] || 0) + 1));
  const stats = {
    total: jobs.length,
    vn: jobs.filter((j) => j.c === "VN").length,
    intl: jobs.filter((j) => j.c !== "VN").length,
    new_24h: jobs.filter((j) => Date.parse(j.f) >= dayAgo).length,
    employers_with_jobs: Object.keys(byEmp).length,
    sources_ok: report.filter((r) => r.status === "ok").length,
    employers_checked: report.length,
    requests: http.count(),
    duration_s: Math.round((Date.now() - t0) / 1000),
    kept_stale: kept,
    degraded,
  };
  const runs = (prevMeta.runs || []).concat([{ at: nowIso, total: stats.total, vn: stats.vn, new: stats.new_24h, ok: stats.sources_ok }]).slice(-60);
  const meta = Object.assign({ v: VERSION, updated_at: nowIso, schedule_vn: ["06:17", "18:17"], by_employer: byEmp }, stats, { runs });
  const rep = {
    v: VERSION,
    updated_at: nowIso,
    policy: P,
    stats,
    employers: report.sort((a, b) => a.id.localeCompare(b.id)).map((r) => ({ ...r, tried: r.tried.slice(0, 6) })),
  };
  if (!args.dryRun && !args.probe) {
    fs.mkdirSync(D("data"), { recursive: true });
    fs.writeFileSync(
      D("data/jobs.json"),
      JSON.stringify({
        v: VERSION,
        updated_at: nowIso,
        keys: "i=id e=employer t=title l=location c=VN|INTL d=department y=type r=remote p=posted f=first_seen z=last_seen u=url s=source",
        jobs,
      }),
    );
    fs.writeFileSync(D("data/jobs_meta.json"), JSON.stringify(meta, null, 1));
    fs.writeFileSync(D("data/jobs_report.json"), JSON.stringify(rep, null, 1));
    fs.writeFileSync(D("data/jobs_sources_auto.json"), JSON.stringify(autoOut, null, 1));
  }
  log(
    `\nKẾT QUẢ: ${stats.total} tin (VN ${stats.vn}, toàn cầu ${stats.intl}, mới 24h ${stats.new_24h}) từ ${stats.employers_with_jobs} nhà tuyển dụng; nguồn tốt ${stats.sources_ok}/${stats.employers_checked}; ${stats.requests} yêu cầu; ${stats.duration_s}s${degraded ? " [GIỮ BẢN TRƯỚC]" : ""}`,
  );
  return { jobs, meta, report: rep };
}

module.exports = { run, adapters, detectSources, careerLinks, parseRobots, robotsAllowed, countryOf, parseJsonLd, relDate, normalize, makeHttp, parseArgs };

if (require.main === module) {
  run(parseArgs(process.argv.slice(2))).catch((e) => {
    console.error("LỖI:", e.message);
    process.exit(1);
  });
}
