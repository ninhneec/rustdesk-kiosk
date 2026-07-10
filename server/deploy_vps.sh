#!/bin/bash
# Script triển khai tự động Hệ thống RustDesk Server & Dashboard API lên VPS Ubuntu/Debian

# Yêu cầu chạy bằng quyền root
if [ "$EUID" -ne 0 ]; then
  echo "Vui lòng chạy script bằng quyền root (sudo ./deploy_vps.sh)"
  exit
fi

echo "===================================================="
echo "BẮT ĐẦU CÀI ĐẶT RUSTDESK SERVER & DASHBOARD"
echo "===================================================="

# 1. Cập nhật hệ thống và cài đặt các phụ thuộc
echo "[1/4] Cập nhật hệ thống và cài đặt Docker, Node.js..."
apt update && apt upgrade -y
apt install -y curl wget git jq ufw

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
npm install -g pm2

# 2. Triển khai RustDesk Server (hbbs & hbbr) qua Docker
echo "[2/4] Khởi tạo RustDesk Server (hbbs/hbbr)..."
mkdir -p /opt/rustdesk-server
cd /opt/rustdesk-server

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

# 3. Triển khai Node.js Dashboard API
echo "[3/4] Cài đặt Dashboard API..."
mkdir -p /opt/rustdesk-api
cd /opt/rustdesk-api

# Tạo file package.json
cat <<EOF > package.json
{
  "name": "rustdesk-custom-api",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "cors": "^2.8.5",
    "express": "^4.19.2",
    "sqlite3": "^5.1.7"
  }
}
EOF

# Cài thư viện
npm install

# (Trong thực tế bạn copy thư mục server/ của dự án lên đây)
# Giả lập copy code server từ local lên bằng cách tải file (Hoặc upload thủ công)
# Tạm thời script chỉ cấu hình sẵn thư mục, bạn cần up file index.js và thư mục public/ vào /opt/rustdesk-api/
echo "Đã tạo thư mục Node.js tại /opt/rustdesk-api."
echo "Bạn hãy tải thư mục 'server/' ở dưới máy tính của bạn lên thư mục /opt/rustdesk-api/ này."
# (Giả định code đã có, chạy pm2)
# pm2 start index.js --name "rustdesk-api"
# pm2 save
# pm2 startup

# 4. Thiết lập Tường lửa (UFW)
echo "[4/4] Mở Port tường lửa..."
ufw allow 21115:21119/tcp
ufw allow 21116/udp
ufw allow 3000/tcp # Port cho Web API Dashboard
ufw --force enable

echo "===================================================="
echo "CÀI ĐẶT HOÀN TẤT!"
echo "===================================================="
echo ""
echo "=> 1. PUBLIC KEY của RustDesk Server là:"
cat /opt/rustdesk-server/data/id_ed25519.pub
echo ""
echo "=> 2. Nhớ Upload code trong thư mục 'server/' lên '/opt/rustdesk-api/' trên VPS và chạy 'pm2 start index.js'."
echo "=> 3. Truy cập Dashboard API tại http://<IP_CUA_VPS>:3000"
echo "=> 4. Copy Public Key ở trên và thay vào file config.rs ở dưới máy local rồi Build app là xong!"
