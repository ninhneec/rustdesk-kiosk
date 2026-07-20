#!/bin/bash
# Script triển khai độc lập Web Chat Server lên VPS Ubuntu/Debian (Không kèm RustDesk Backend)

# Yêu cầu chạy bằng quyền root
if [ "$EUID" -ne 0 ]; then
  echo "Vui lòng chạy script bằng quyền root (sudo ./deploy_chat_only.sh)"
  exit
fi

echo "===================================================="
echo "BẮT ĐẦU CÀI ĐẶT WEB CHAT SERVER (ĐỘC LẬP)"
echo "===================================================="

# 1. Cập nhật hệ thống và cài đặt các phụ thuộc
echo "[1/4] Cập nhật hệ thống và cài đặt Node.js, Git..."
apt update && apt install -y curl wget git jq ufw xxd

# Cài đặt Node.js (Version 20) & PM2
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
fi
if ! command -v pm2 &> /dev/null; then
    npm install -g pm2
fi

# 2. Lấy mã nguồn từ GitHub
echo "[2/4] Tải mã nguồn từ GitHub..."
REPO_DIR="/opt/rustdesk-kiosk"
if [ -d "$REPO_DIR" ]; then
    echo "Đã tìm thấy thư mục mã nguồn, tiến hành cập nhật..."
    cd $REPO_DIR
    git pull origin master
else
    git clone https://github.com/ninhneec/rustdesk-kiosk.git $REPO_DIR
    cd $REPO_DIR
fi

# 3. Triển khai Node.js Dashboard API
echo "[3/4] Cài đặt và khởi chạy Chat Server..."
cd $REPO_DIR/server

# Cài thư viện Node.js
npm ci

# Yêu cầu nhập ADMIN_TOKEN hoặc tạo ngẫu nhiên
ADMIN_TOKEN=$(head -c 16 /dev/urandom | xxd -p)
echo "Đã tạo ngẫu nhiên ADMIN_TOKEN: $ADMIN_TOKEN"

# Khởi động bằng PM2
pm2 delete kiosk-chat &> /dev/null || true
ADMIN_TOKEN=$ADMIN_TOKEN PORT=3000 pm2 start index.js --name "kiosk-chat"
pm2 save
pm2 startup

# 4. Thiết lập Tường lửa (UFW)
echo "[4/4] Mở Port tường lửa..."
ufw allow 3000/tcp # Port cho Web API Dashboard
ufw --force enable

echo "===================================================="
echo "CÀI ĐẶT HOÀN TẤT!"
echo "===================================================="
echo ""
echo "=> 1. Mật khẩu ADMIN_TOKEN của bạn là: $ADMIN_TOKEN"
echo "=> 2. Chat Server đang chạy ẩn bằng PM2. Xem log bằng lệnh: pm2 logs kiosk-chat"
echo "=> 3. Truy cập Dashboard API tại http://<IP_CUA_VPS>:3000"
echo "=> LƯU LẠI ADMIN_TOKEN ở trên để điền vào mã nguồn Client app nhé!"
echo ""
