# Hướng dẫn Deploy Web Chat lên VPS

## 1. Yêu cầu hệ thống
- Đã cài đặt Node.js (v16 trở lên) và npm trên VPS.
- Đã cài đặt PM2 (công cụ quản lý Process cho Node.js).
  ```bash
  npm install -g pm2
  ```

## 2. Triển khai
1. Copy toàn bộ thư mục `vps-web-chat` lên VPS của bạn (có thể nén thành file zip rồi dùng sftp hoặc tải qua git).
2. Di chuyển vào thư mục code trên VPS:
   ```bash
   cd vps-web-chat
   ```
3. Chạy lệnh cài đặt thư viện:
   ```bash
   npm install
   ```
4. Khởi chạy Server bằng PM2 để nó chạy nền 24/7 (ngay cả khi khởi động lại VPS):
   ```bash
   pm2 start server.js --name "kiosk-chat"
   pm2 save
   pm2 startup
   ```

## 3. Cấu hình Port
- Mặc định, Server sẽ chạy ở cổng `3000`.
- Đảm bảo bạn đã mở cổng (open port) 3000 trên tường lửa (Firewall) của VPS.
- Bạn có thể truy cập bằng địa chỉ: `http://<IP_CUA_VPS>:3000`
