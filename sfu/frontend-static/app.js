// Main Application Logic with Clock Synchronization Display
let webrtcClient = null;
let currentStreams = [];
let currentStreamId = null;
let metricsUpdateInterval = null;

// ==================== LATENCY CHART ====================
let latencyChart = null;
const CHART_DURATION_SECONDS = 25;  // Show 25 seconds of data
const CHART_UPDATE_INTERVAL = 100;  // Update every 100ms for smooth display

// Latency history for graph (stores {time, total, ros, processing, network, render})
let latencyHistory = [];
const MAX_HISTORY_POINTS = CHART_DURATION_SECONDS * 10; // 10 points per second

// Latency statistics
let latencyStats = {
    min: Infinity,
    max: 0,
    sum: 0,
    count: 0,
    current: 0,
    method: '--'
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
    console.log('Initializing ROS2 WebRTC Streaming with Clock Sync...');
    
    await initWebRTC();
});

async function initWebRTC() {
    try {
        // Use same-origin WebSocket
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        const signalingUrl = `${protocol}//${host}/ws`;

        console.log('Connecting to:', signalingUrl);

        webrtcClient = new WebRTCClient(signalingUrl);

        // Setup callbacks
        webrtcClient.onStreamAdded = (trackId, stream) => {
            console.log(' Stream added:', trackId);
            console.log(' Stream tracks:', stream.getTracks());
            addStreamToGrid(trackId, stream);
        };

        webrtcClient.onStreamRemoved = (trackId) => {
            console.log('Stream removed:', trackId);
            removeStreamFromGrid(trackId);
        };

        webrtcClient.onMetricsUpdate = (metricsMap) => {
            updateMetrics(metricsMap);
        };

        webrtcClient.onConnectionStateChange = (state) => {
            updateConnectionStatus(state);
        };
        
        // NEW: Clock synchronization callback
        webrtcClient.onClockSync = (syncStats) => {
            updateClockSyncDisplay(syncStats);
        };

        // Connect
        updateConnectionStatus('connecting');
        await webrtcClient.connect();
        updateConnectionStatus('connected');

    } catch (error) {
        console.error('Failed to initialize WebRTC:', error);
        updateConnectionStatus('failed');
    }
}

// ==================== CLOCK SYNC UI ====================

function updateClockSyncDisplay(syncStats) {
    // Update the clock sync panel
    const offsetValue = document.getElementById('clockOffset');
    const rttValue = document.getElementById('clockRtt');
    const jitterValue = document.getElementById('clockJitter');
    const samplesValue = document.getElementById('clockSamples');
    const syncIndicator = document.getElementById('clockSyncIndicator');
    const offsetDirection = document.getElementById('offsetDirection');
    const syncQualityEl = document.getElementById('syncQuality');
    
    if (offsetValue) {
        const absOffset = Math.abs(syncStats.offset);
        // Show offset in seconds if > 1000ms
        if (absOffset > 1000) {
            offsetValue.textContent = (absOffset / 1000).toFixed(1) + 's';
        } else {
            offsetValue.textContent = absOffset.toFixed(2) + 'ms';
        }
        
        // Color code based on offset magnitude
        if (absOffset < 10) {
            offsetValue.style.color = '#48bb78'; // Green - excellent
        } else if (absOffset < 50) {
            offsetValue.style.color = '#ecc94b'; // Yellow - acceptable
        } else {
            offsetValue.style.color = '#f56565'; // Red - poor
        }
    }
    
    if (offsetDirection) {
        // Show offset source (Python or Go)
        const source = syncStats.offsetSource || 'Go↔Browser';
        if (syncStats.offset > 0) {
            offsetDirection.textContent = `(Server ahead) [${source}]`;
            offsetDirection.className = 'offset-direction server-ahead';
        } else {
            offsetDirection.textContent = `(Client ahead) [${source}]`;
            offsetDirection.className = 'offset-direction client-ahead';
        }
    }
    
    if (rttValue) {
        rttValue.textContent = syncStats.avgRtt.toFixed(2) + 'ms';
    }
    
    if (jitterValue) {
        jitterValue.textContent = syncStats.jitter.toFixed(2) + 'ms';
    }
    
    if (samplesValue) {
        samplesValue.textContent = syncStats.samples;
    }
    
    if (syncQualityEl) {
        // Show Python calibrated status
        if (syncStats.pythonCalibrated) {
            syncQualityEl.textContent = 'Python Synced';
            syncQualityEl.style.color = '#9f7aea'; // Purple for Python
        } else {
            syncQualityEl.textContent = syncStats.syncQuality || 'Syncing...';
            const quality = syncStats.syncQuality || '';
            if (quality === 'Excellent') {
                syncQualityEl.style.color = '#48bb78';
            } else if (quality === 'Good') {
                syncQualityEl.style.color = '#68d391';
            } else if (quality === 'Fair') {
                syncQualityEl.style.color = '#ecc94b';
            } else {
                syncQualityEl.style.color = '#f56565';
            }
        }
    }
    
    if (syncIndicator) {
        syncIndicator.className = 'sync-indicator synced';
        syncIndicator.title = `Clock synchronized (${syncStats.offsetSource || 'Go↔Browser'})`;
    }
    
    // Update detail view clock panel if visible
    updateDetailClockDisplay(syncStats);
}

function updateDetailClockDisplay(syncStats) {
    const detailOffset = document.getElementById('detailClockOffset');
    const detailRtt = document.getElementById('detailClockRtt');
    const detailMinRtt = document.getElementById('detailMinRtt');
    const detailMaxRtt = document.getElementById('detailMaxRtt');
    const detailStdDev = document.getElementById('detailStdDev');
    
    if (detailOffset) {
        const absOffset = Math.abs(syncStats.offset);
        // Show offset in seconds if > 1000ms
        let offsetText;
        if (absOffset > 1000) {
            offsetText = (absOffset / 1000).toFixed(1) + 's';
        } else {
            offsetText = absOffset.toFixed(2) + 'ms';
        }
        
        const source = syncStats.offsetSource || 'Go↔Browser';
        const direction = syncStats.offset > 0 ? 'Server ahead' : 'Client ahead';
        detailOffset.textContent = `${offsetText} (${direction})`;
        detailOffset.title = `Source: ${source}`;
        
        // Add Python indicator color if calibrated
        if (syncStats.pythonCalibrated) {
            detailOffset.style.color = '#9f7aea';
        } else {
            detailOffset.style.color = '';
        }
    }
    if (detailRtt) {
        detailRtt.textContent = syncStats.avgRtt.toFixed(2) + 'ms';
    }
    if (detailMinRtt) {
        detailMinRtt.textContent = syncStats.minRtt.toFixed(2) + 'ms';
    }
    if (detailMaxRtt) {
        detailMaxRtt.textContent = syncStats.maxRtt.toFixed(2) + 'ms';
    }
    if (detailStdDev) {
        detailStdDev.textContent = syncStats.stdDev.toFixed(2) + 'ms';
    }
}

// ==================== CONNECTION STATUS ====================

function updateConnectionStatus(state) {
    const indicator = document.getElementById('statusIndicator');
    const text = document.getElementById('statusText');
    
    indicator.className = 'status-indicator ' + state;
    
    const statusText = {
        'connecting': 'Connecting...',
        'connected': 'Connected',
        'disconnected': 'Disconnected',
        'failed': 'Connection Failed'
    };
    
    text.textContent = statusText[state] || state;
}

// ==================== STREAM GRID ====================

function addStreamToGrid(trackId, stream) {
    console.log('addStreamToGrid called for:', trackId);
    
    if (!currentStreams.includes(trackId)) {
        currentStreams.push(trackId);
        updateStreamCount();
    }

    const grid = document.getElementById('streamGrid');
    
    const loading = grid.querySelector('.loading');
    if (loading) {
        loading.remove();
    }

    if (document.getElementById(`card-${trackId}`)) {
        console.log('Card already exists for:', trackId);
        return;
    }

    const card = document.createElement('div');
    card.className = 'stream-card';
    card.id = `card-${trackId}`;
    card.onclick = () => showDetail(trackId);

    const video = document.createElement('video');
    video.id = `video-${trackId}`;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    
    video.onloadedmetadata = () => {
        console.log(`📺 Video ${trackId} metadata loaded:`, video.videoWidth, 'x', video.videoHeight);
    };
    
    video.onloadeddata = () => {
        console.log(`📺 Video ${trackId} data loaded`);
    };
    
    video.onplay = () => {
        console.log(`📺 Video ${trackId} started playing`);
    };
    
    video.onerror = (e) => {
        console.error(`📺 Video ${trackId} error:`, e);
    };
    
    const playVideo = async () => {
        try {
            await video.play();
            console.log(`Video ${trackId} playing`);
        } catch (err) {
            console.warn(`Video ${trackId} play failed:`, err.message);
            setTimeout(playVideo, 500);
        }
    };
    
    setTimeout(playVideo, 100);

    const info = document.createElement('div');
    info.className = 'stream-card-info';

    const title = document.createElement('div');
    title.className = 'stream-card-title';
    title.textContent = formatStreamName(trackId);

    const stats = document.createElement('div');
    stats.className = 'stream-card-stats';
    stats.innerHTML = `
        <div class="stream-stat">
            <span class="stream-stat-label">Latency</span>
            <span class="stream-stat-value" id="card-latency-${trackId}">0ms</span>
        </div>
        <div class="stream-stat">
            <span class="stream-stat-label">Frames</span>
            <span class="stream-stat-value" id="card-frames-${trackId}">0</span>
        </div>
        <div class="stream-stat">
            <span class="stream-stat-label">Status</span>
            <span class="stream-stat-value" id="card-status-${trackId}">● Connecting</span>
        </div>
    `;

    info.appendChild(title);
    info.appendChild(stats);
    card.appendChild(video);
    card.appendChild(info);
    grid.appendChild(card);
    
    console.log('Stream card created for:', trackId);
    
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
        console.log('📹 Video track state:', videoTrack.readyState, 'enabled:', videoTrack.enabled, 'muted:', videoTrack.muted);
        
        videoTrack.onended = () => {
            console.log(`Video track ${trackId} ended`);
            const statusEl = document.getElementById(`card-status-${trackId}`);
            if (statusEl) statusEl.textContent = '● Ended';
        };
        
        videoTrack.onmute = () => {
            console.log(`Video track ${trackId} muted`);
            const statusEl = document.getElementById(`card-status-${trackId}`);
            if (statusEl) statusEl.textContent = '● Muted';
        };
        
        videoTrack.onunmute = () => {
            console.log(`Video track ${trackId} unmuted`);
            const statusEl = document.getElementById(`card-status-${trackId}`);
            if (statusEl) statusEl.textContent = '● Live';
        };
        
        if (videoTrack.readyState === 'live' && !videoTrack.muted) {
            const statusEl = document.getElementById(`card-status-${trackId}`);
            if (statusEl) statusEl.textContent = '● Live';
        }
    }
}

function removeStreamFromGrid(trackId) {
    currentStreams = currentStreams.filter(id => id !== trackId);
    updateStreamCount();

    const card = document.getElementById(`card-${trackId}`);
    if (card) {
        card.remove();
    }

    if (currentStreams.length === 0) {
        const grid = document.getElementById('streamGrid');
        grid.innerHTML = `
            <div class="loading">
                <div class="spinner"></div>
                <p>Waiting for streams...</p>
            </div>
        `;
    }
}

// ==================== METRICS ====================

function updateMetrics(metricsMap) {
    currentStreams.forEach(trackId => {
        const metrics = metricsMap.get(trackId);
        if (metrics) {
            const latencyEl = document.getElementById(`card-latency-${trackId}`);
            const framesEl = document.getElementById(`card-frames-${trackId}`);
            
            if (latencyEl) {
                latencyEl.textContent = Math.round(metrics.totalLatency || 0) + 'ms';
            }
            if (framesEl) {
                framesEl.textContent = metrics.frameCount || 0;
            }
        }
    });

    if (currentStreamId) {
        const metrics = metricsMap.get(currentStreamId);
        if (metrics) {
            updateDetailMetrics(metrics);
        }
    }
}

function updateDetailMetrics(metrics) {
    document.getElementById('totalLatency').textContent = Math.round(metrics.totalLatency || 0) + 'ms';
    document.getElementById('frameCount').textContent = metrics.frameCount || 0;
    
    if (metrics.width && metrics.height) {
        document.getElementById('resolution').textContent = `${metrics.width}x${metrics.height}`;
    }
    
    // Show clock sync status and latency method
    const clockSyncStatus = document.getElementById('clockSyncStatus');
    if (clockSyncStatus) {
        let statusText = metrics.clockSynced ? '✓ Synced' : '○ Syncing...';
        if (metrics.latencyMethod) {
            statusText += ` (${metrics.latencyMethod})`;
        }
        clockSyncStatus.textContent = statusText;
        clockSyncStatus.style.color = metrics.clockSynced ? '#48bb78' : '#ecc94b';
    }

    // Update latency component values
    const rosLatency = metrics.rosLatency || 0;
    const processingLatency = metrics.processingLatency || 0;
    const networkLatency = metrics.networkLatency || 0;
    const renderLatency = metrics.renderLatency || 0;

    document.getElementById('rosLatency').textContent = Math.round(rosLatency) + 'ms';
    document.getElementById('processingLatency').textContent = Math.round(processingLatency) + 'ms';
    document.getElementById('networkLatency').textContent = Math.round(networkLatency) + 'ms';
    document.getElementById('renderLatency').textContent = Math.round(renderLatency) + 'ms';
    
    // Update the latency chart
    updateLatencyChart(metrics);
}

// ==================== DETAIL VIEW ====================

function showDetail(streamId) {
    console.log('Showing detail for:', streamId);
    currentStreamId = streamId;

    const stream = webrtcClient.getStream(streamId);
    if (!stream) {
        console.error('Stream not found:', streamId);
        return;
    }

    document.getElementById('dashboardView').style.display = 'none';
    document.getElementById('detailView').style.display = 'block';

    document.getElementById('streamTitle').textContent = formatStreamName(streamId);

    const video = document.getElementById('detailVideo');
    video.srcObject = stream;
    video.play().catch(err => console.warn('Detail video play error:', err.message));

    // Reset latency history and stats when showing detail
    latencyHistory = [];
    latencyStats = { min: Infinity, max: 0, sum: 0, count: 0, current: 0, method: '--' };
    
    // Initialize the latency chart
    initLatencyChart();

    const metrics = webrtcClient.getMetrics(streamId);
    if (metrics) {
        updateDetailMetrics(metrics);
    }
    
    // Update clock sync display in detail view
    const clockStats = webrtcClient.getClockSyncStats();
    if (clockStats) {
        updateDetailClockDisplay(clockStats);
    }
}

function showDashboard() {
    currentStreamId = null;
    
    document.getElementById('dashboardView').style.display = 'block';
    document.getElementById('detailView').style.display = 'none';

    // Destroy chart when leaving detail view
    if (latencyChart) {
        latencyChart.destroy();
        latencyChart = null;
    }

    const video = document.getElementById('detailVideo');
    video.srcObject = null;
}

// ==================== LATENCY CHART ====================

function initLatencyChart() {
    const ctx = document.getElementById('latencyChart');
    if (!ctx) {
        console.error('Latency chart canvas not found');
        return;
    }
    
    // Destroy existing chart if any
    if (latencyChart) {
        latencyChart.destroy();
    }
    
    latencyChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'Total Latency',
                    data: [],
                    borderColor: '#9C27B0',
                    backgroundColor: 'rgba(156, 39, 176, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.3,
                    pointRadius: 0,
                    pointHitRadius: 10
                },
                {
                    label: 'Network',
                    data: [],
                    borderColor: '#4facfe',
                    backgroundColor: 'rgba(79, 172, 254, 0.1)',
                    borderWidth: 1.5,
                    fill: false,
                    tension: 0.3,
                    pointRadius: 0,
                    borderDash: [5, 5]
                },
                {
                    label: 'ROS + Encoding',
                    data: [],
                    borderColor: '#43e97b',
                    backgroundColor: 'rgba(67, 233, 123, 0.1)',
                    borderWidth: 1.5,
                    fill: false,
                    tension: 0.3,
                    pointRadius: 0,
                    borderDash: [2, 2]
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: {
                duration: 0 // Disable animation for real-time feel
            },
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        color: '#4a5568',
                        usePointStyle: true,
                        padding: 15,
                        font: { size: 11 }
                    }
                },
                tooltip: {
                    enabled: true,
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    titleColor: 'white',
                    bodyColor: 'white',
                    callbacks: {
                        label: function(context) {
                            return `${context.dataset.label}: ${context.parsed.y.toFixed(1)}ms`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    display: true,
                    grid: { 
                        color: 'rgba(0, 0, 0, 0.05)',
                        drawBorder: false
                    },
                    ticks: { 
                        color: '#718096',
                        maxTicksLimit: 10,
                        font: { size: 10 }
                    },
                    title: {
                        display: true,
                        text: 'Time',
                        color: '#718096',
                        font: { size: 11 }
                    }
                },
                y: {
                    display: true,
                    grid: { 
                        color: 'rgba(0, 0, 0, 0.05)',
                        drawBorder: false
                    },
                    ticks: { 
                        color: '#718096',
                        font: { size: 10 },
                        callback: function(value) {
                            return value + 'ms';
                        }
                    },
                    title: {
                        display: true,
                        text: 'Latency (ms)',
                        color: '#718096',
                        font: { size: 11 }
                    },
                    beginAtZero: true,
                    suggestedMax: 150
                }
            }
        }
    });
    
    console.log('Latency chart initialized');
}

function updateLatencyChart(metrics) {
    if (!latencyChart) return;
    
    const now = new Date();
    const timeLabel = now.toLocaleTimeString('en-US', { 
        hour12: false, 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit' 
    });
    
    const totalLatency = metrics.totalLatency || 0;
    const networkLatency = metrics.networkLatency || 0;
    const processingLatency = (metrics.rosLatency || 0) + (metrics.encodingLatency || 0);
    
    // Add to history
    latencyHistory.push({
        time: timeLabel,
        total: totalLatency,
        network: networkLatency,
        processing: processingLatency,
        timestamp: now.getTime()
    });
    
    // Remove old entries (keep only last CHART_DURATION_SECONDS seconds)
    const cutoffTime = now.getTime() - (CHART_DURATION_SECONDS * 1000);
    while (latencyHistory.length > 0 && latencyHistory[0].timestamp < cutoffTime) {
        latencyHistory.shift();
    }
    
    // Also cap at MAX_HISTORY_POINTS
    while (latencyHistory.length > MAX_HISTORY_POINTS) {
        latencyHistory.shift();
    }
    
    // Update chart data
    latencyChart.data.labels = latencyHistory.map(h => h.time);
    latencyChart.data.datasets[0].data = latencyHistory.map(h => h.total);
    latencyChart.data.datasets[1].data = latencyHistory.map(h => h.network);
    latencyChart.data.datasets[2].data = latencyHistory.map(h => h.processing);
    
    // Auto-scale Y axis based on data
    const maxVal = Math.max(...latencyHistory.map(h => h.total), 50);
    latencyChart.options.scales.y.suggestedMax = Math.ceil(maxVal * 1.2 / 10) * 10; // Round up to nearest 10
    
    latencyChart.update('none'); // 'none' mode for no animation
    
    // Update statistics
    if (totalLatency > 0) {
        latencyStats.current = totalLatency;
        latencyStats.min = Math.min(latencyStats.min, totalLatency);
        latencyStats.max = Math.max(latencyStats.max, totalLatency);
        latencyStats.sum += totalLatency;
        latencyStats.count++;
        latencyStats.method = metrics.latencyMethod || '--';
        
        // Update stats display
        updateLatencyStatsDisplay();
    }
}

function updateLatencyStatsDisplay() {
    const currentEl = document.getElementById('latencyCurrentValue');
    const minEl = document.getElementById('latencyMinValue');
    const avgEl = document.getElementById('latencyAvgValue');
    const maxEl = document.getElementById('latencyMaxValue');
    const methodEl = document.getElementById('latencyMethodValue');
    
    if (currentEl) currentEl.textContent = latencyStats.current.toFixed(1) + 'ms';
    if (minEl) minEl.textContent = (latencyStats.min === Infinity ? '--' : latencyStats.min.toFixed(1) + 'ms');
    if (avgEl && latencyStats.count > 0) {
        avgEl.textContent = (latencyStats.sum / latencyStats.count).toFixed(1) + 'ms';
    }
    if (maxEl) maxEl.textContent = (latencyStats.max === 0 ? '--' : latencyStats.max.toFixed(1) + 'ms');
    if (methodEl) {
        methodEl.textContent = latencyStats.method;
        // Color code by method
        methodEl.className = 'value method-badge method-' + latencyStats.method;
    }
}

// ==================== UTILITIES ====================

function formatStreamName(streamId) {
    return streamId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function updateStreamCount() {
    document.getElementById('streamCount').textContent = currentStreams.length;
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (webrtcClient) {
        webrtcClient.disconnect();
    }
});