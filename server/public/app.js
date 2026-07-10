document.addEventListener('DOMContentLoaded', () => {
    const deviceList = document.getElementById('device-list');
    const deviceCount = document.getElementById('device-count');
    const searchInput = document.getElementById('search-input');
    const refreshBtn = document.getElementById('refresh-btn');
    const toast = document.getElementById('toast');

    let devices = [];

    // Lấy danh sách thiết bị từ API
    const fetchDevices = async () => {
        try {
            const response = await fetch('/api/devices');
            devices = await response.json();
            renderDevices(devices);
        } catch (error) {
            console.error('Error fetching devices:', error);
            deviceList.innerHTML = '<tr><td colspan="6" style="text-align:center; color: var(--danger-color);">Lỗi kết nối đến Server</td></tr>';
        }
    };

    // Hiển thị danh sách thiết bị
    const renderDevices = (data) => {
        deviceList.innerHTML = '';
        
        if (data.length === 0) {
            deviceList.innerHTML = '<tr><td colspan="6" style="text-align:center; color: var(--text-secondary);">Chưa có thiết bị nào kết nối</td></tr>';
            deviceCount.textContent = '0 Online';
            return;
        }

        let onlineCount = 0;
        const now = new Date();

        data.forEach(device => {
            const lastSeen = new Date(device.last_seen);
            const diffMinutes = Math.floor((now - lastSeen) / 1000 / 60);
            
            // Nếu update trong vòng 5 phút thì coi như Online
            const isOnline = diffMinutes < 5;
            if (isOnline) onlineCount++;

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>
                    <span class="status-indicator ${isOnline ? '' : 'offline'}" title="${isOnline ? 'Online' : 'Offline'}"></span>
                </td>
                <td style="font-weight: 500;">${device.hostname || 'Unknown'}</td>
                <td>
                    <span class="id-cell" onclick="copyToClipboard('${device.id}')" title="Copy ID">
                        ${device.id}
                    </span>
                </td>
                <td>
                    <span class="pass-cell" onclick="copyToClipboard('${device.pass}')" title="Copy Password">
                        ${device.pass}
                    </span>
                </td>
                <td class="time-cell">
                    ${formatDate(lastSeen)}
                </td>
                <td>
                    <a href="rustdesk://connect?id=${device.id}" class="btn-connect">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                        Connect
                    </a>
                </td>
            `;
            deviceList.appendChild(tr);
        });

        deviceCount.textContent = `${onlineCount} Online`;
    };

    // Format ngày giờ
    const formatDate = (date) => {
        return date.toLocaleString('vi-VN', {
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            day: '2-digit', month: '2-digit', year: 'numeric'
        });
    };

    // Copy vào Clipboard
    window.copyToClipboard = (text) => {
        navigator.clipboard.writeText(text).then(() => {
            showToast();
        });
    };

    // Hiển thị thông báo Toast
    const showToast = () => {
        toast.classList.add('show');
        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    };

    // Tìm kiếm thiết bị
    searchInput.addEventListener('input', (e) => {
        const keyword = e.target.value.toLowerCase();
        const filtered = devices.filter(d => 
            (d.hostname || '').toLowerCase().includes(keyword) || 
            (d.id || '').toLowerCase().includes(keyword)
        );
        renderDevices(filtered);
    });

    // Nút làm mới
    refreshBtn.addEventListener('click', () => {
        refreshBtn.style.transform = 'rotate(180deg)';
        setTimeout(() => refreshBtn.style.transform = 'none', 300);
        fetchDevices();
    });

    // Auto refresh mỗi 30 giây
    setInterval(fetchDevices, 30000);

    // Initial fetch
    fetchDevices();
});
