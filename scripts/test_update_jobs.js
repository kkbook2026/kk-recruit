#!/usr/bin/env node
/* KK JobHunter - kiểm thử ngoại tuyến (fetch giả lập): node scripts/test_update_jobs.js  -> exit 1 nếu lỗi
 * Bao phủ: robots.txt, JSON-LD JobPosting, nhận diện Việt Nam, 6 bộ chuyển đổi, tự dò nguồn, gộp dữ liệu
 * (giữ ngày phát hiện, tin đóng, nguồn lỗi giữ tin cũ, chốt an toàn khi tổng giảm bất thường). Tác giả: Nguyễn Duy Điển */
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

  console.log(`\nKK JobHunter - kiểm thử ngoại tuyến: ${pass}/${pass + fail} PASS`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
