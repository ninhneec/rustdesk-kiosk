# RustDesk kiosk chat server

Backend này độc lập hoàn toàn với `hbbs`/`hbbr`:

- Remote desktop mặc định vẫn dùng host public của RustDesk.
- Chat, dashboard, device key và cảnh báo chạy trên VPS riêng.
- `ADMIN_TOKEN` chỉ dùng để đăng nhập web, không nhúng vào client.
- Mỗi máy có chat token riêng; quyền chat được cấp bằng key theo máy/chỗ ngồi.

## Chạy local

```bash
cd server
npm ci
ADMIN_TOKEN='a-long-random-admin-token' \
CHAT_SESSION_SECRET='a-separate-long-random-secret' \
PORT=3000 npm start
```

Kiểm tra trước khi deploy:

```bash
npm run check
npm test
```

## Hai chế độ key

1. **Gán thẳng:** admin chọn máy/ghế; client tự mở chat, không phải nhập key.
2. **Tự hủy:** admin ép một máy hoặc toàn bộ máy nhập key. Server giữ nguyên ghế, khóa quyền cũ và sinh mã riêng cho từng máy. Khi nhập đúng trong cửa sổ chat, hash của mã bị thay ngay nên không thể dùng lại.

Mọi tin nhắn từ client đều tạo cảnh báo realtime trên dashboard. Tin chứa từ khóa trong mục **Cảnh báo** được ưu tiên khẩn.

## Deploy VPS chat riêng

```bash
sudo bash server/deploy_chat_only.sh
```

Script lưu database tại `/var/lib/rustdesk-kiosk-chat/devices.db` và giữ secret tại `/etc/rustdesk-kiosk-chat.env`, vì vậy deploy lại không làm đổi mã admin hoặc mất key/ghế.

Nên đặt Node.js sau Nginx/Caddy HTTPS và chỉ cho public truy cập cổng 80/443. Client hiện trỏ chat tới `http://ad.apndocs.site:3000`; khi có TLS hãy đổi hằng `_apiServer` và URL trong `src/server.rs` sang `https://...`.

`ALERT_KEYWORDS` là danh sách từ khóa khẩn cách nhau bằng dấu phẩy; sau lần đầu có thể chỉnh trực tiếp trên dashboard.
