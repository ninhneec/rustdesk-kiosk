#!/bin/bash
# Script All-in-One triển khai Hệ thống RustDesk Server & Dashboard API lên VPS Ubuntu/Debian

# Yêu cầu chạy bằng quyền root
if [ "$EUID" -ne 0 ]; then
  echo "Vui lòng chạy script bằng quyền root (sudo ./deploy_vps.sh)"
  exit
fi

echo "===================================================="
echo "BẮT ĐẦU CÀI ĐẶT RUSTDESK ALL-IN-ONE (BACKEND + CHAT)"
echo "===================================================="

# 1. Cập nhật hệ thống và cài đặt các phụ thuộc
echo "[1/4] Cập nhật hệ thống và cài đặt Docker, Node.js, Git..."
apt update && apt install -y curl wget git jq ufw xxd

# Cài đặt Docker nếu chưa có
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
fi

# Cài đặt Docker Compose nếu chưa có
if ! command -v docker-compose &> /dev/null; then
    apt install -y docker-compose
fi

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

# 3. Triển khai RustDesk Server (hbbs & hbbr) qua Docker
echo "[3/4] Khởi tạo RustDesk Server (hbbs/hbbr)..."
cd $REPO_DIR/server
mkdir -p data

cat <<EOF > docker-compose.yml
version: '3'
networks:
  rustdesk-net:
    external: false
services:
  hbbs:
    container_name: hbbs
    ports:
      - 21115:21115
      - 21116:21116
      - 21116:21116/udp
      - 21118:21118
    image: rustdesk/rustdesk-server:latest
    command: hbbs -r 127.0.0.1:21117
    volumes:
      - ./data:/root
    networks:
      - rustdesk-net
    depends_on:
      - hbbr
    restart: unless-stopped
  hbbr:
    container_name: hbbr
    ports:
      - 21117:21117
      - 21119:21119
    image: rustdesk/rustdesk-server:latest
    command: hbbr
    volumes:
      - ./data:/root
    networks:
      - rustdesk-net
    restart: unless-stopped
EOF

# Chạy Docker Compose
docker-compose up -d

# Đợi vài giây để hbbs tạo file key
sleep 5

# 4. Triển khai Node.js Dashboard API
echo "[4/5] Cài đặt và khởi chạy Chat Server..."
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

# 5. Thiết lập Tường lửa (UFW)
echo "[5/5] Mở Port tường lửa..."
ufw allow 22/tcp # Port SSH
ufw allow 21115:21119/tcp
ufw allow 21116/udp
ufw allow 3000/tcp # Port cho Web API Dashboard
ufw --force enable

echo "===================================================="
echo "CÀI ĐẶT HOÀN TẤT!"
echo "===================================================="
echo ""
echo "=> 1. PUBLIC KEY của RustDesk Server là:"
cat $REPO_DIR/server/data/id_ed25519.pub
echo ""
echo "=> 2. Mật khẩu ADMIN_TOKEN của bạn là: $ADMIN_TOKEN"
echo "=> 3. Chat Server đang chạy ẩn bằng PM2. Xem log bằng lệnh: pm2 logs kiosk-chat"
echo "=> 4. Truy cập Dashboard API tại http://<IP_CUA_VPS>:3000"
echo "=> 5. LƯU LẠI Public Key và ADMIN_TOKEN ở trên để điền vào mã nguồn Client app nhé!"
echo ""
