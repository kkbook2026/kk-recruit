#!/usr/bin/env node
/* KK JobHunter - kiểm thử ngoại tuyến (fetch giả lập): node scripts/test_update_jobs.js  -> exit 1 nếu lỗi
 * Bao phủ: robots.txt, JSON-LD JobPosting, nhận diện Việt Nam, 6 bộ chuyển đổi, tự dò nguồn, gộp dữ liệu
 * (giữ ngày phát hiện, tin đóng, nguồn lỗi giữ tin cũ, chốt an toàn khi tổng giảm bất thường), v1.1 chống giới hạn tần suất
 * (nhóm máy chủ, Retry-After, chờ lũy tiến, robots.txt 429, lượt thử lại cuối, ngắt mạch, ngân sách thời gian). Tác giả: Nguyễn Duy Điển */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const J = require("./update_jobs.js");

let pass = 0,
  fail = 0;
const ok = (c, m) => {
  if (c) pass++;
  else {
    fail++;
    console.log("  FAIL", m);
  }
};
const res = (body, status = 200, type = "application/json") => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => type },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

(async () => {
  /* 1. robots.txt */
  const rb = J.parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/jobs\nDisallow: /*.pdf$\n\nUser-agent: Googlebot\nDisallow: /");
  ok(J.robotsAllowed(rb, "/careers") === true, "robots: /careers được phép");
  ok(J.robotsAllowed(rb, "/private/x") === false, "robots: /private bị chặn");
  ok(J.robotsAllowed(rb, "/private/jobs/1") === true, "robots: Allow dài hơn thắng");
  ok(J.robotsAllowed(rb, "/a/b.pdf") === false, "robots: ký tự đại diện * và $");
  ok(J.robotsAllowed(J.parseRobots("User-agent: *\nDisallow:"), "/x") === true, "robots: Disallow rỗng = cho phép");
  ok(
    J.robotsAllowed(J.parseRobots("User-agent: KK-RECRUITMENT-JobHunter\nDisallow: /\n\nUser-agent: *\nAllow: /"), "/x") === false,
    "robots: nhóm đích danh được ưu tiên",
  );

  /* 2. Việt Nam / ngày tương đối / JSON-LD */
  ["Ho Chi Minh City, Vietnam", "Hà Nội", "HCMC", "Da Nang, VN", "Bac Ninh Province", "Việt Nam"].forEach((l) => ok(J.countryOf(l) === "VN", "VN: " + l));
  ["Singapore", "Santa Clara, CA, US", "Hanover, Germany", "Remote - India"].forEach((l) => ok(J.countryOf(l) === "INTL", "INTL: " + l));
  const now = Date.parse("2026-11-06T00:00:00Z");
  ok(
    J.relDate("Posted Today", now) === "2026-11-06" &&
      J.relDate("Posted 3 Days Ago", now) === "2026-11-03" &&
      J.relDate("Posted 30+ Days Ago", now) === "2026-10-07",
    "relDate Workday",
  );
  const html = `<html><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"JobPosting","title":"Kỹ sư Phần mềm","datePosted":"2026-11-01","url":"https://ex.vn/jobs/1","jobLocation":{"@type":"Place","address":{"addressLocality":"Hà Nội","addressCountry":"VN"}},"employmentType":"FULL_TIME"}]}</script>
  <script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"ListItem","item":{"@type":"JobPosting","title":"Kế toán","jobLocation":[{"address":{"addressLocality":"Đà Nẵng"}}]}}]}</script><script type="application/ld+json">{hỏng</script></html>`;
  const ld = J.parseJsonLd(html, "https://ex.vn/careers");
  ok(
    ld.length === 2 && ld[0].title === "Kỹ sư Phần mềm" && ld[0].location === "Hà Nội, VN" && ld[1].url === "https://ex.vn/careers",
    "JSON-LD @graph + ItemList + khối hỏng",
  );

  /* 3. Tự dò nguồn */
  const det = J.detectSources(
    '<a href="https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite">Jobs</a><iframe src="https://boards.greenhouse.io/embed/job_board?for=acme"></iframe><a href="https://jobs.lever.co/foo-bar/123">x</a><a href="https://jobs.smartrecruiters.com/BoschGroup/744">y</a>',
    "https://ex.com/careers",
  );
  const types = det.map((d) => d.type + ":" + (d.token || d.tenant || d.site || d.company));
  ok(
    types.includes("workday:nvidia") && types.includes("greenhouse:acme") && types.includes("lever:foo-bar") && types.includes("smartrecruiters:BoschGroup"),
    "detectSources: " + types.join(","),
  );
  ok(det.find((d) => d.type === "workday").site === "NVIDIAExternalCareerSite", "detectSources: Workday site");
  ok(
    J.careerLinks('<a href="/tuyen-dung">Tuyển dụng</a><a href="/about">Giới thiệu</a><a href="https://x.com/careers">Careers</a>', "https://a.vn/").length ===
      2,
    "careerLinks",
  );

  /* 3b. API JSON / __NEXT_DATA__ có phân trang */
  const nd = (n) =>
    `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          total: 3,
          jobs:
            n === 1
              ? [
                  { title: "Kỹ sư Dữ liệu", location: "Thành phố Hồ Chí Minh", slug: "1-ky-su", job_family: "Data" },
                  { title: "Chuyên viên Pháp chế", location: "Hà Nội", slug: "2-phap-che" },
                ]
              : n === 2
                ? [{ title: "Thực tập sinh", location: "Hà Nội", slug: "3-tts" }]
                : [],
        },
      },
    })}</script></html>`;
  const httpNd = { text: async (u) => nd(Number(new URL(u).searchParams.get("page"))) };
  const ndOut = await J.adapters.json(
    {
      format: "nextdata",
      url: "https://c.vn/jobs?page={page}",
      pages: 5,
      pageSize: 2,
      list: "props.pageProps.jobs",
      totalPath: "props.pageProps.total",
      fields: { title: "title", location: "location", department: "job_family", url: "https://c.vn/job/{slug}" },
    },
    httpNd,
  );
  ok(
    ndOut.jobs.length === 3 && ndOut.total === 3 && ndOut.jobs[0].url === "https://c.vn/job/1-ky-su" && ndOut.jobs[0].department === "Data",
    "json/nextdata: phân trang + ánh xạ trường",
  );

  /* 4. Chạy đầy đủ với máy chủ giả lập */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jh-"));
  fs.mkdirSync(path.join(dir, "data"));
  fs.mkdirSync(path.join(dir, "scripts"));
  const emps = [
    { id: "vn-a", region: "VN", name: "A VN", careers_url: "https://a.vn/tuyen-dung" },
    { id: "vn-b", region: "VN", name: "B VN", careers_url: "https://b.vn/careers" },
    { id: "gl-c", region: "GLOBAL", name: "C Global", careers_url: "https://c.com/careers" },
    { id: "gl-d", region: "GLOBAL", name: "D Global", careers_url: "https://d.com/careers" },
    { id: "gl-e", region: "GLOBAL", name: "E Global", careers_url: "https://e.com/careers" },
    { id: "vn-f", region: "VN", name: "F VN", careers_url: "https://f.vn/careers" },
  ];
  fs.writeFileSync(path.join(dir, "data/employers.json"), JSON.stringify({ employers: emps }));
  fs.writeFileSync(
    path.join(dir, "scripts/jobs_sources.json"),
    JSON.stringify({
      policy: { intlLimit: 2, vnLimit: 50, concurrency: 3 },
      sources: {
        "gl-c": [{ type: "workday", host: "c.wd1.myworkdayjobs.com", tenant: "c", site: "Ext" }],
        "gl-d": [{ type: "smartrecruiters", company: "DCo" }],
        "gl-e": [{ type: "greenhouse", token: "eco" }],
        "vn-f": [{ type: "oracle", host: "f.fa.oraclecloud.com", site: "CX_1", scan: 50 }],
      },
    }),
  );
  // dữ liệu cũ: 1 tin của gl-e còn hạn giữ (nguồn gl-e sẽ lỗi) + 1 tin đã đóng của gl-d
  const old = new Date(now - 10 * 864e5).toISOString();
  const recent = new Date(now - 3600e3).toISOString();
  fs.writeFileSync(
    path.join(dir, "data/jobs.json"),
    JSON.stringify({
      jobs: [
        { i: "keep1", e: "gl-e", t: "Giữ lại", l: "Berlin", c: "INTL", u: "https://e.com/j/1", f: old, z: recent },
        { i: "closed1", e: "gl-d", t: "Đã đóng", l: "Paris", c: "INTL", u: "https://d.com/j/9", f: old, z: recent },
      ],
    }),
  );
  const wdPost = (body) => {
    const b = JSON.parse(body);
    if (b.appliedFacets && b.appliedFacets.locationCountry)
      return {
        total: 1200,
        jobPostings: [
          { title: "Kỹ sư GPU", externalPath: "/job/Ho-Chi-Minh-City/GPU_JR1", locationsText: "Ho Chi Minh City, Vietnam", postedOn: "Posted 2 Days Ago" },
        ],
      };
    return {
      total: 1200,
      facets: [
        {
          facetParameter: "locationMainGroup",
          values: [
            {
              facetParameter: "locationCountry",
              descriptor: "Country",
              values: [
                { descriptor: "Vietnam", id: "vn123", count: 1 },
                { descriptor: "Germany", id: "de", count: 30 },
              ],
            },
          ],
        },
      ],
      jobPostings: [
        { title: "Senior Engineer", externalPath: "/job/Santa-Clara/SE_JR2", locationsText: "Santa Clara, CA, US", postedOn: "Posted Today" },
        { title: "Data Scientist", externalPath: "/job/Berlin/DS_JR3", locationsText: "Berlin, Germany", postedOn: "Posted 5 Days Ago" },
        { title: "Extra", externalPath: "/job/X/X_JR4", locationsText: "Tokyo, Japan", postedOn: "Posted 9 Days Ago" },
      ],
    };
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === "/robots.txt") return u.host === "b.vn" ? res("User-agent: *\nDisallow: /", 200, "text/plain") : res("nf", 404, "text/plain");
    if (u.host === "a.vn")
      return res(
        `<a href="https://apply.workable.com/acoworks/">Jobs</a><script type="application/ld+json">{"@type":"JobPosting","title":"Chuyên viên Kinh doanh","url":"https://a.vn/job/2","jobLocation":{"address":{"addressLocality":"Cần Thơ"}}}</script>`,
        200,
        "text/html",
      );
    if (u.host === "apply.workable.com")
      return res({
        jobs: [
          { title: "Nhân viên Hỗ trợ", city: "Hanoi", country: "Vietnam", url: "https://apply.workable.com/acoworks/j/AB12/", published_on: "2026-11-04" },
        ],
      });
    if (u.host === "c.wd1.myworkdayjobs.com") return res(wdPost(init.body));
    if (u.host === "api.smartrecruiters.com") {
      if (u.searchParams.get("country") === "vn")
        return res({
          content: [
            {
              id: "77",
              name: "Kỹ sư Tự động hóa",
              releasedDate: "2026-11-05T01:00:00Z",
              location: { city: "Hanoi", country: "vn" },
              department: { label: "Engineering" },
            },
          ],
        });
      return res({ totalFound: 5000, content: [{ id: "88", name: "Sales Manager", releasedDate: "2026-11-05", location: { city: "Paris", country: "fr" } }] });
    }
    if (u.host === "boards-api.greenhouse.io") return res("down", 503, "text/plain");
    if (u.host === "f.fa.oraclecloud.com")
      return res({
        items: [
          {
            TotalJobsCount: 2,
            requisitionList: [
              { Id: "501", Title: "Trưởng phòng Tài chính", PrimaryLocation: "Ha Noi, Vietnam", PrimaryLocationCountry: "VN", PostedDate: "2026-11-02" },
              { Id: "502", Title: "Analyst", PrimaryLocation: "Austin, TX", PrimaryLocationCountry: "US", PostedDate: "2026-11-01" },
            ],
          },
        ],
      });
    return res("nf", 404, "text/plain");
  };
  const out = await J.run({ dir, only: [], probe: false, discover: true, timeout: 5000, dryRun: false, quiet: true, gap: 0 }, { fetchImpl, now });
  const jobs = JSON.parse(fs.readFileSync(path.join(dir, "data/jobs.json"), "utf8")).jobs;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "data/jobs_meta.json"), "utf8"));
  const rep = JSON.parse(fs.readFileSync(path.join(dir, "data/jobs_report.json"), "utf8"));
  const st = Object.fromEntries(rep.employers.map((r) => [r.id, r]));
  ok(st["vn-a"].status === "ok" && /workable/.test(st["vn-a"].source), "vn-a: tự dò Workable -> ok (" + st["vn-a"].source + ")");
  ok(st["vn-b"].status === "nosource" && /robots/.test(st["vn-b"].error), "vn-b: robots.txt chặn -> không thu thập (" + st["vn-b"].error + ")");
  ok(
    st["gl-c"].status === "ok" && st["gl-c"].vn === 1 && st["gl-c"].jobs === 3,
    "gl-c Workday: 1 tin VN qua bộ lọc quốc gia + 2 tin toàn cầu (" + st["gl-c"].jobs + ")",
  );
  ok(st["gl-d"].status === "ok" && st["gl-d"].vn === 1, "gl-d SmartRecruiters VN + toàn cầu");
  ok(st["gl-e"].status === "error", "gl-e Greenhouse lỗi 503 -> error");
  ok(st["vn-f"].status === "ok" && st["vn-f"].vn === 1, "vn-f Oracle: lọc tin VN");
  ok(
    jobs.some((j) => j.i === "keep1"),
    "nguồn lỗi -> giữ tin cũ còn hạn",
  );
  ok(!jobs.some((j) => j.i === "closed1"), "nguồn chạy tốt -> tin không còn = đã đóng, bị loại");
  const gpu = jobs.find((j) => j.t === "Kỹ sư GPU");
  ok(
    gpu && gpu.c === "VN" && gpu.u === "https://c.wd1.myworkdayjobs.com/Ext/job/Ho-Chi-Minh-City/GPU_JR1" && gpu.p === "2026-11-04",
    "Workday: URL + ngày + VN",
  );
  ok(
    jobs.every((j) => /^https:\/\//.test(j.u) && j.t && j.e && j.f),
    "mọi tin có URL https, chức danh, nhà tuyển dụng, ngày phát hiện",
  );
  ok(!JSON.stringify(jobs).match(/[–—]/), "không có gạch dài");
  ok(
    meta.total === jobs.length && meta.vn >= 4 && meta.by_employer["gl-c"] === 3 && meta.runs.length === 1,
    "jobs_meta: tổng, VN, theo nhà tuyển dụng, lịch sử",
  );
  ok(!calls.some((c) => c.startsWith("https://b.vn/careers")), "không tải trang bị robots.txt chặn");
  const auto = JSON.parse(fs.readFileSync(path.join(dir, "data/jobs_sources_auto.json"), "utf8"));
  ok(auto.sources["vn-a"] && auto.sources["vn-a"].sources.some((s) => s.type === "workable"), "lưu nguồn tự dò");

  /* 5. Lần chạy 2: giữ first_seen; chốt an toàn khi tổng giảm bất thường */
  const firstSeen = gpu.f;
  await J.run({ dir, only: [], probe: false, discover: true, timeout: 5000, quiet: true, gap: 0 }, { fetchImpl, now: now + 12 * 3600e3 });
  const jobs2 = JSON.parse(fs.readFileSync(path.join(dir, "data/jobs.json"), "utf8")).jobs;
  ok(jobs2.find((j) => j.t === "Kỹ sư GPU").f === firstSeen, "lần 2: giữ ngày phát hiện đầu tiên");
  const big = Array.from({ length: 100 }, (_, k) => ({ i: "x" + k, e: "gl-c", t: "Job " + k, c: "INTL", u: "https://c.com/" + k, f: old, z: old }));
  fs.writeFileSync(path.join(dir, "data/jobs.json"), JSON.stringify({ jobs: big }));
  const down = async (url) => (new URL(url).pathname === "/robots.txt" ? res("", 404) : res("down", 503));
  await J.run({ dir, only: [], probe: false, discover: false, timeout: 5000, quiet: true, gap: 0 }, { fetchImpl: down, now });
  const m3 = JSON.parse(fs.readFileSync(path.join(dir, "data/jobs_meta.json"), "utf8"));
  ok(
    m3.degraded === true && JSON.parse(fs.readFileSync(path.join(dir, "data/jobs.json"), "utf8")).jobs.length === 100,
    "mọi nguồn sập -> giữ nguyên bản trước (degraded)",
  );

  /* 6. v1.1 - chống giới hạn tần suất (HTTP 429): nhóm máy chủ, Retry-After, chờ lũy tiến, lượt thử lại cuối */
  ok(
    J.familyOf("nvidia.wd5.myworkdayjobs.com") === "myworkdayjobs.com" &&
      J.familyOf("pwc.wd3.myworkdayjobs.com") === "myworkdayjobs.com" &&
      J.familyOf("eeho.fa.us2.oraclecloud.com") === "oraclecloud.com" &&
      J.familyOf("career.vng.com.vn") === "career.vng.com.vn",
    "familyOf: mọi tenant Workday chung một nhóm, máy chủ riêng giữ nguyên",
  );
  const hdr = (h) => ({ headers: { get: (k) => h[String(k).toLowerCase()] || null } });
  ok(
    J.retryAfterMs(hdr({ "retry-after": "7" })) === 7000 &&
      J.retryAfterMs(hdr({ "retry-after": "Wed, 25 Nov 2026 00:00:30 GMT" }), Date.parse("2026-11-25T00:00:00Z")) === 30000 &&
      J.retryAfterMs(hdr({})) === null &&
      J.retryAfterMs({ headers: { get: () => "application/json" } }) === null,
    "retryAfterMs: giây, ngày giờ HTTP, không có",
  );
  const res429 = (h) => ({ ok: false, status: 429, headers: { get: (k) => (h || {})[String(k).toLowerCase()] || null }, text: async () => "slow down" });
  const mkClock = () => {
    // đồng hồ ảo: mỗi lần "ngủ" đẩy thời gian lên đúng số mili giây đã chờ
    const st = { t: Date.parse("2026-11-24T00:00:00Z"), naps: [] };
    return { st, clock: () => st.t, sleep: async (ms) => { st.naps.push(ms); st.t += ms; } };
  };
  {
    // 6a. 429 kèm Retry-After: 7 -> chờ >= 7 giây rồi thử lại thành công
    const c = mkClock();
    let n = 0;
    const f = async (url) => (new URL(url).pathname === "/robots.txt" ? res("nf", 404, "text/plain") : ++n === 1 ? res429({ "retry-after": "7" }) : res({ ok: 1 }));
    const h = J.makeHttp({ fetchImpl: f, gap: 800, sleep: c.sleep, clock: c.clock, jitter: 0 });
    const d = await h.json("https://x.wd1.myworkdayjobs.com/wday/cxs/x/Ext/jobs");
    ok(d.ok === 1 && n === 2 && c.st.naps.some((ms) => ms >= 7000) && h.stats().r429 === 1, "429 + Retry-After: chờ đủ rồi thử lại thành công");
  }
  {
    // 6b. 429 không có Retry-After 3 lần liên tiếp -> chờ lũy tiến 3-8-20 giây, lần thứ 4 thành công
    const c = mkClock();
    let n = 0;
    const f = async (url) => (new URL(url).pathname === "/robots.txt" ? res("nf", 404, "text/plain") : ++n <= 3 ? res429() : res({ ok: 2 }));
    const h = J.makeHttp({ fetchImpl: f, gap: 800, sleep: c.sleep, clock: c.clock, jitter: 0 });
    const d = await h.json("https://api.example.com/jobs");
    const big = c.st.naps.filter((ms) => ms >= 3000);
    ok(d.ok === 2 && n === 4 && big.length === 3 && big[0] === 3000 && big[1] === 8000 && big[2] === 20000, "429 không Retry-After: chờ lũy tiến 3-8-20 giây (" + big.join(",") + ")");
  }
  {
    // 6c. 429 kéo dài -> dừng sau 4 lần, báo HTTP 429 (không lặp vô hạn)
    const c = mkClock();
    let n = 0;
    const f = async (url) => (new URL(url).pathname === "/robots.txt" ? res("nf", 404, "text/plain") : (++n, res429()));
    const h = J.makeHttp({ fetchImpl: f, gap: 800, sleep: c.sleep, clock: c.clock, jitter: 0 });
    let msg = "";
    try {
      await h.json("https://api.example.com/jobs");
    } catch (e) {
      msg = e.message;
    }
    ok(msg === "HTTP 429" && n === 4, "429 kéo dài: dừng sau 4 lần, báo HTTP 429");
  }
  {
    // 6d. hai tenant Workday khác nhau xếp chung một hàng: yêu cầu thứ hai chờ >= 1,5 giây dù khác tên máy chủ
    const c = mkClock();
    const f = async (url) => (new URL(url).pathname === "/robots.txt" ? res("nf", 404, "text/plain") : res({ ok: 3 }));
    const h = J.makeHttp({ fetchImpl: f, gap: 800, sleep: c.sleep, clock: c.clock, jitter: 0 });
    await Promise.all([h.json("https://a.wd1.myworkdayjobs.com/wday/cxs/a/S/jobs"), h.json("https://b.wd5.myworkdayjobs.com/wday/cxs/b/S/jobs")]);
    ok(c.st.naps.filter((ms) => ms >= 1500).length >= 1 && h.stats().waitedMs >= 1500, "nhóm Workday: các tenant giãn cách chung >= 1,5 giây");
  }
  {
    // 6e. robots.txt trả 429 KHÔNG được coi là "không có robots.txt": báo lỗi tạm thời, không tải trang
    const c = mkClock();
    const seen = [];
    const f = async (url) => {
      seen.push(new URL(url).pathname);
      return new URL(url).pathname === "/robots.txt" ? res429() : res({ ok: 4 });
    };
    const h = J.makeHttp({ fetchImpl: f, gap: 800, sleep: c.sleep, clock: c.clock, jitter: 0 });
    let code = "";
    try {
      await h.json("https://api.example.com/jobs");
    } catch (e) {
      code = e.code + "|" + e.message;
    }
    ok(code === "ROBOTS_TEMP|HTTP 429 (robots.txt)" && !seen.includes("/jobs"), "robots.txt 429: lỗi tạm thời, không tải trang (" + code + ")");
    // một lần 429 thoáng qua ở robots.txt -> chờ rồi đọc lại ngay trong lượt (không phải đợi lượt thử lại cuối)
    const cA = mkClock();
    let rbA = 0;
    const fA = async (url) => (new URL(url).pathname === "/robots.txt" ? (++rbA === 1 ? res429() : res("nf", 404, "text/plain")) : res({ ok: 5 }));
    const hA = J.makeHttp({ fetchImpl: fA, gap: 800, sleep: cA.sleep, clock: cA.clock, jitter: 0 });
    const dA = await hA.json("https://api.example.com/jobs");
    ok(dA.ok === 5 && rbA === 2 && cA.st.naps.some((ms) => ms >= 3000), "robots.txt 429 thoáng qua: chờ rồi đọc lại ngay trong lượt");
    // robots.txt 429 suốt 4 lần -> lỗi tạm thời, không gửi thêm; sau forgetRobotsErrors + resetBreakers thì đọc lại và tải được
    const cB = mkClock();
    let rbB = 0;
    const fB = async (url) => (new URL(url).pathname === "/robots.txt" ? (++rbB <= 4 ? res429() : res("nf", 404, "text/plain")) : res({ ok: 6 }));
    const hB = J.makeHttp({ fetchImpl: fB, gap: 800, sleep: cB.sleep, clock: cB.clock, jitter: 0 });
    const codeOf = async () => {
      try {
        await hB.json("https://api.example.com/jobs");
        return "ok";
      } catch (e) {
        return e.code;
      }
    };
    const first = await codeOf();
    const second = await codeOf();
    const rbSeen = rbB;
    await hB.forgetRobotsErrors();
    hB.resetBreakers();
    const dB = await hB.json("https://api.example.com/jobs");
    ok(first === "ROBOTS_TEMP" && second === "ROBOTS_TEMP" && rbSeen === 4 && dB.ok === 6, "forgetRobotsErrors + resetBreakers: lượt sau đọc lại robots.txt và tải được");
  }
  {
    // 6f. Chạy đầy đủ: nguồn Workday bị 429 suốt lượt chính, lượt thử lại cuối thì thông -> trạng thái ok, có đánh dấu retried
    const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), "jh6-"));
    fs.mkdirSync(path.join(dir6, "data"));
    fs.mkdirSync(path.join(dir6, "scripts"));
    fs.writeFileSync(
      path.join(dir6, "data/employers.json"),
      JSON.stringify({ employers: [{ id: "gl-w", region: "GLOBAL", name: "W Global", careers_url: "https://w.com/careers" }, { id: "gl-z", region: "GLOBAL", name: "Z Global", careers_url: "https://z.com/careers" }] }),
    );
    fs.writeFileSync(
      path.join(dir6, "scripts/jobs_sources.json"),
      JSON.stringify({
        policy: { intlLimit: 5, vnLimit: 50, concurrency: 2, retryPassWaitMs: 45000 },
        sources: { "gl-w": [{ type: "workday", host: "w.wd1.myworkdayjobs.com", tenant: "w", site: "Ext" }], "gl-z": [{ type: "workday", host: "z.wd3.myworkdayjobs.com", tenant: "z", site: "Ext" }] },
      }),
    );
    const c = mkClock();
    let wCalls = 0;
    const f = async (url) => {
      const u = new URL(url);
      if (u.pathname === "/robots.txt") return res("nf", 404, "text/plain");
      if (u.host === "z.wd3.myworkdayjobs.com") return res429(); // luôn bị giới hạn
      if (u.host === "w.wd1.myworkdayjobs.com") {
        wCalls++;
        if (wCalls <= 4) return res429(); // lượt chính: 4 lần đều 429
        return res({ total: 2, facets: [], jobPostings: [{ title: "Site Reliability Engineer", externalPath: "/job/Remote/SRE_1", locationsText: "Remote, US", postedOn: "Posted Today" }] });
      }
      return res("nf", 404, "text/plain");
    };
    const out6 = await J.run({ dir: dir6, only: [], probe: false, discover: false, timeout: 5000, quiet: true, gap: 0 }, { fetchImpl: f, now, sleep: c.sleep, clock: c.clock, jitter: 0 });
    const rw = out6.report.employers.find((e) => e.id === "gl-w");
    const rz = out6.report.employers.find((e) => e.id === "gl-z");
    ok(rw.status === "ok" && rw.retried === true && rw.jobs === 1, "lượt thử lại: nguồn 429 ở lượt chính được phục hồi (gl-w " + rw.status + ")");
    ok(rz.status === "error" && rz.retried === true && /HTTP 429/.test(rz.error), "lượt thử lại: nguồn vẫn 429 thì giữ trạng thái lỗi (gl-z)");
    ok(out6.report.net.retry_pass.tried === 2 && out6.report.net.retry_pass.recovered === 1 && out6.report.net.rate_limited >= 8, "báo cáo mạng: retry_pass 2 thử / 1 phục hồi, đếm số lần 429");
    ok(c.st.naps.includes(45000), "lượt thử lại: nghỉ đúng retryPassWaitMs trước khi thử");
    ok(out6.report.employers.length === 2 && out6.meta.sources_ok === 1 && !("net" in out6.meta), "jobs_meta giữ nguyên cấu trúc (không thêm trường mới), mỗi nhà tuyển dụng 1 dòng báo cáo");
    ok(typeof out6.report.net.skipped === "number" && Array.isArray(out6.report.net.blocked) && out6.report.net.blocked.includes("z.wd3.myworkdayjobs.com"), "báo cáo mạng: ghi máy chủ đang bị ngắt mạch (" + out6.report.net.blocked.join(",") + ")");

    // 6j. Hết ngân sách thời gian (policy.maxRunMs): không chờ, không chạy lượt thử lại, lượt chạy vẫn kết thúc và ghi báo cáo
    const cfg6 = JSON.parse(fs.readFileSync(path.join(dir6, "scripts/jobs_sources.json"), "utf8"));
    cfg6.policy.maxRunMs = 0;
    fs.writeFileSync(path.join(dir6, "scripts/jobs_sources.json"), JSON.stringify(cfg6));
    const c7 = mkClock();
    let calls7 = 0;
    const f7 = async (url) => {
      if (new URL(url).pathname === "/robots.txt") return res("nf", 404, "text/plain");
      calls7++;
      return res429();
    };
    const out7 = await J.run({ dir: dir6, only: [], probe: false, discover: false, timeout: 5000, quiet: true, gap: 0 }, { fetchImpl: f7, now, sleep: c7.sleep, clock: c7.clock, jitter: 0 });
    ok(
      out7.report.net.retry_pass.tried === 0 && !c7.st.naps.includes(45000) && calls7 === 2 && out7.report.employers.every((e) => e.status === "error" && !e.retried),
      "hết ngân sách thời gian: không chờ, bỏ lượt thử lại, vẫn ghi báo cáo (" + calls7 + " yêu cầu)",
    );
  }
  {
    // 6g. Ngắt mạch theo nhóm: 2 tenant Workday khác nhau hết lượt thử vẫn 429 -> tenant thứ ba KHÔNG bị gửi yêu cầu nào
    const c = mkClock();
    const hits = {};
    const f = async (url) => {
      const u = new URL(url);
      hits[u.host] = (hits[u.host] || 0) + 1;
      return u.pathname === "/robots.txt" ? res("nf", 404, "text/plain") : res429();
    };
    const h = J.makeHttp({ fetchImpl: f, gap: 800, sleep: c.sleep, clock: c.clock, jitter: 0 });
    const errs = [];
    for (const t of ["a.wd1", "b.wd5", "c.wd3"]) {
      try {
        await h.json(`https://${t}.myworkdayjobs.com/wday/cxs/x/S/jobs`);
      } catch (e) {
        errs.push(e.message);
      }
    }
    ok(
      errs.length === 3 &&
        errs.every((m) => /^HTTP 429/.test(m)) &&
        hits["a.wd1.myworkdayjobs.com"] === 5 &&
        hits["b.wd5.myworkdayjobs.com"] === 5 &&
        !hits["c.wd3.myworkdayjobs.com"] &&
        h.stats().skipped >= 1 &&
        h.blocked().includes("*.myworkdayjobs.com"),
      "ngắt mạch nhóm: sau 2 tenant bị 429 hết lượt, tenant thứ ba không bị gửi yêu cầu (" + JSON.stringify(hits) + ")",
    );
    h.resetBreakers();
    ok(h.blocked().length === 0, "resetBreakers: mở lại chốt trước lượt thử lại");
  }
  {
    // 6h. Một tenant bị 429 riêng lẻ KHÔNG làm ngắt cả nhóm (xen giữa có tenant trả lời bình thường); máy chủ đã hết lượt thì không gửi thêm
    const c = mkClock();
    const hits = {};
    const f = async (url) => {
      const u = new URL(url);
      hits[u.host] = (hits[u.host] || 0) + 1;
      if (u.pathname === "/robots.txt") return res("nf", 404, "text/plain");
      return /^bad\d\./.test(u.host) ? res429() : res({ ok: 7 });
    };
    const h = J.makeHttp({ fetchImpl: f, gap: 800, sleep: c.sleep, clock: c.clock, jitter: 0 });
    const outs = [];
    for (const t of ["bad1.wd1", "good.wd1", "bad2.wd1", "fine.wd5", "bad1.wd1"]) {
      try {
        outs.push(String((await h.json(`https://${t}.myworkdayjobs.com/wday/cxs/x/S/jobs`)).ok));
      } catch (e) {
        outs.push(e.message);
      }
    }
    ok(
      outs.join("|") === "HTTP 429|7|HTTP 429|7|HTTP 429" && hits["bad1.wd1.myworkdayjobs.com"] === 5 && h.stats().skipped === 1 && !h.blocked().includes("*.myworkdayjobs.com"),
      "tenant bị 429 riêng lẻ không ngắt cả nhóm; máy chủ đã hết lượt không bị gửi thêm (" + outs.join("|") + ")",
    );
  }
  {
    // 6i. Retry-After dài hơn mức chờ tối đa (600 giây) -> tôn trọng: không thử lại, không gửi thêm trong lượt, kể cả sau resetBreakers
    const c = mkClock();
    let n = 0;
    const f = async (url) => (new URL(url).pathname === "/robots.txt" ? res("nf", 404, "text/plain") : (++n, res429({ "retry-after": "600" })));
    const h = J.makeHttp({ fetchImpl: f, gap: 800, sleep: c.sleep, clock: c.clock, jitter: 0 });
    const msgOf = async () => {
      try {
        await h.json("https://api.example.com/jobs");
        return "ok";
      } catch (e) {
        return e.message;
      }
    };
    const m1 = await msgOf();
    h.resetBreakers();
    const m2 = await msgOf();
    ok(m1 === "HTTP 429" && m2 === "HTTP 429" && n === 1 && !c.st.naps.some((ms) => ms >= 60000), "Retry-After 600 giây: tôn trọng, không thử lại, không gửi thêm trong lượt");
    // quá ngân sách thời gian -> gặp 429 không chờ / thử lại
    const c2 = mkClock();
    let n2 = 0;
    const f2 = async (url) => (new URL(url).pathname === "/robots.txt" ? res("nf", 404, "text/plain") : (++n2, res429()));
    const h2 = J.makeHttp({ fetchImpl: f2, gap: 800, sleep: c2.sleep, clock: c2.clock, jitter: 0, deadline: c2.clock() - 1 });
    let m3 = "";
    try {
      await h2.json("https://api.example.com/jobs");
    } catch (e) {
      m3 = e.message;
    }
    ok(m3 === "HTTP 429" && n2 === 1 && !c2.st.naps.some((ms) => ms >= 3000), "quá ngân sách thời gian: gặp 429 không chờ, không thử lại");
  }
  {
    // 6k. Tình huống xấu nhất: cả 15 tenant Workday luôn trả 429 kèm Retry-After 60 giây, chạy với cấu hình thật (gap 800 ms, 6 luồng).
    //     Đồng hồ ảo kiểu sự kiện rời rạc (nhiều luồng cùng chờ thì thời gian trôi theo luồng thức dậy sớm nhất) -> đo thời gian như chạy thật.
    //     Yêu cầu: lượt chạy kết thúc xa dưới giới hạn 40 phút của workflow, các nguồn khác không bị ảnh hưởng.
    const dirK = fs.mkdtempSync(path.join(os.tmpdir(), "jhk-"));
    fs.mkdirSync(path.join(dirK, "data"));
    fs.mkdirSync(path.join(dirK, "scripts"));
    const empsK = [];
    const srcK = {};
    for (let i = 0; i < 15; i++) {
      empsK.push({ id: "gl-w" + i, region: "GLOBAL", name: "W" + i, careers_url: "https://w" + i + ".com/careers" });
      srcK["gl-w" + i] = [{ type: "workday", host: "t" + i + ".wd" + (1 + (i % 5)) + ".myworkdayjobs.com", tenant: "t" + i, site: "Ext" }];
    }
    for (let i = 0; i < 10; i++) {
      empsK.push({ id: "gl-g" + i, region: "GLOBAL", name: "G" + i, careers_url: "https://g" + i + ".com/careers" });
      srcK["gl-g" + i] = [{ type: "greenhouse", token: "g" + i }];
    }
    fs.writeFileSync(path.join(dirK, "data/employers.json"), JSON.stringify({ employers: empsK }));
    fs.writeFileSync(path.join(dirK, "scripts/jobs_sources.json"), JSON.stringify({ policy: { intlLimit: 5, vnLimit: 50 }, sources: srcK }));
    const ev = { t: now, timers: [], alive: true };
    const pump = () => {
      if (!ev.alive) return;
      if (ev.timers.length) {
        ev.timers.sort((x, y) => x.at - y.at);
        const tm = ev.timers.shift();
        ev.t = Math.max(ev.t, tm.at);
        tm.res();
      }
      setImmediate(pump);
    };
    setImmediate(pump);
    let wdReq = 0;
    const fK = async (url) => {
      const u = new URL(url);
      if (/myworkdayjobs\.com$/.test(u.host)) {
        wdReq++;
        return res429({ "retry-after": "60" });
      }
      if (u.pathname === "/robots.txt") return res("nf", 404, "text/plain");
      if (/greenhouse/.test(u.host)) return res({ jobs: [{ id: 1, title: "Engineer", absolute_url: "https://x.example/j/1", location: { name: "Berlin" }, updated_at: "2026-11-05T00:00:00Z" }], meta: { total: 1 } });
      return res("nf", 404, "text/plain");
    };
    const outK = await J.run(
      { dir: dirK, only: [], probe: false, discover: false, timeout: 20000, quiet: true, gap: 800 },
      { fetchImpl: fK, now, sleep: (ms) => new Promise((r) => ev.timers.push({ at: ev.t + ms, res: r })), clock: () => ev.t, jitter: 0.25 },
    );
    ev.alive = false;
    const minK = (ev.t - now) / 60000;
    ok(minK < 15 && wdReq <= 40 && outK.report.net.blocked.includes("*.myworkdayjobs.com"), "xấu nhất (cả nhóm Workday 429 + Retry-After 60 giây): lượt chạy kết thúc sau " + minK.toFixed(1) + " phút ảo, " + wdReq + " yêu cầu tới Workday");
    ok(outK.meta.sources_ok === 10 && outK.report.employers.length === 25, "xấu nhất: 10 nguồn khác vẫn thu thập bình thường, đủ 25 dòng báo cáo");
  }

  console.log(`\nKK JobHunter - kiểm thử ngoại tuyến: ${pass}/${pass + fail} PASS`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
