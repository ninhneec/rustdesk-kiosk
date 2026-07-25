# RustDesk kiosk chat server

Backend này độc lập hoàn toàn với `hbbs`/`hbbr`:

- Remote desktop mặc định vẫn dùng host public của RustDesk.
- Chat, dashboard, device key và cảnh báo chạy trên VPS riêng.
- Dashboard đăng nhập bằng mật khẩu admin do người triển khai tự đặt. Server chỉ lưu hash `scrypt`, không lưu mật khẩu thô và không dùng `ADMIN_TOKEN`.
- Mỗi máy có chat token riêng; quyền chat được cấp bằng key theo máy/chỗ ngồi.

## Chạy local

```bash
cd server
npm ci
ADMIN_PASSWORD_HASH='scrypt:base64url-salt:base64url-hash' \
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

Key sinh tự động có dạng ngắn `p20412345`. Admin có thể sửa key đang chờ dùng thành mã 8–16 ký tự chữ/số; hệ thống tự đổi về chữ thường và chặn mã trùng. Chỗ ngồi chỉ nhận `M01`–`M36`, mỗi chỗ chỉ được gán cho một máy.

Mọi tin nhắn từ client đều tạo cảnh báo realtime trên dashboard. Tin chứa từ khóa trong mục **Cảnh báo** được ưu tiên khẩn.

## Deploy VPS chat riêng

Khuyên dùng wizard ngắn; chỉ hỏi đổi mật khẩu và bật/tắt backup:

```bash
sudo bash server/setup_vps.sh
```

```bash
sudo bash server/deploy_chat_only.sh
```

Hoặc chạy trực tiếp trên VPS để kéo bản mới nhất từ GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/ninhneec/rustdesk-kiosk/master/server/deploy_chat_only.sh | sudo bash
```

Script lưu database tại `/var/lib/rustdesk-kiosk-chat/devices.db` và giữ secret/hash mật khẩu tại `/etc/rustdesk-kiosk-chat.env`, vì vậy deploy lại không mất key/ghế.

Lần triển khai đầu, đặt mật khẩu bằng biến môi trường (không ghi mật khẩu vào file):

```bash
sudo ADMIN_PASSWORD='mat-khau-rieng-cua-ban' bash server/deploy_chat_only.sh
```

Backup Google Drive chạy mỗi ngày lúc 00:00 theo múi giờ của VPS. Liên kết OAuth một lần bằng `sudo rclone config`, tạo remote tên `gdrive`, sau đó thử:

```bash
sudo /usr/local/sbin/rustdesk-kiosk-backup
```

Các bản backup được upload vào `gdrive:rustdesk-kiosk-backups`; bản local cũ hơn 7 ngày được tự dọn.

Nên đặt Node.js sau Nginx/Caddy HTTPS và chỉ cho public truy cập cổng 80/443. Client hiện trỏ chat tới `http://ad.apndocs.site:3000`; khi có TLS hãy đổi hằng `_apiServer` và URL trong `src/server.rs` sang `https://...`.

`ALERT_KEYWORDS` là danh sách từ khóa khẩn cách nhau bằng dấu phẩy; sau lần đầu có thể chỉnh trực tiếp trên dashboard.
