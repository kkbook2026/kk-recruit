# KK-RECRUITMENT - Nền tảng Tuyển dụng & Khảo thí AI Toàn cầu

Website: https://www.kk-recruit.net

Bản quyền: Nguyễn Duy Điển. Kho này chỉ chứa bản dựng Web App (một file `site/index.html`, chế độ Standalone) để phục vụ qua GitHub Pages; Backend FastAPI + PostgreSQL, ai-worker, media-worker, avatar-agent và bộ tài liệu đầy đủ được quản lý riêng.

- Triển khai: GitHub Actions `pages.yml` -> GitHub Pages, tên miền tùy chỉnh `www.kk-recruit.net` (file `site/CNAME`).
- Cập nhật: build lại `dist/index.html` từ mã nguồn KK-RECRUITMENT v1.1, chép vào `site/index.html` (và `site/404.html`), đẩy lên nhánh `main`.
