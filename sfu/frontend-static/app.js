// Main Application Logic with Clock Synchronization Display
let webrtcClient = null;
let currentStreams = [];
let currentStreamId = null;
let metricsUpdateInterval = null;

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
    
    if (offsetValue) {
        const absOffset = Math.abs(syncStats.offset);
        offsetValue.textContent = absOffset.toFixed(2) + 'ms';
        
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
        if (syncStats.offset > 0) {
            offsetDirection.textContent = '(Server ahead)';
            offsetDirection.className = 'offset-direction server-ahead';
        } else {
            offsetDirection.textContent = '(Client ahead)';
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
    
    if (syncIndicator) {
        syncIndicator.className = 'sync-indicator synced';
        syncIndicator.title = 'Clock synchronized';
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
        detailOffset.textContent = syncStats.offset.toFixed(2) + 'ms';
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
        console.log(`Video ${trackId} metadata loaded:`, video.videoWidth, 'x', video.videoHeight);
    };
    
    video.onloadeddata = () => {
        console.log(`Video ${trackId} data loaded`);
    };
    
    video.onplay = () => {
        console.log(`Video ${trackId} started playing`);
    };
    
    video.onerror = (e) => {
        console.error(`Video ${trackId} error:`, e);
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
    
    // Show clock sync status in metrics
    const clockSyncStatus = document.getElementById('clockSyncStatus');
    if (clockSyncStatus) {
        clockSyncStatus.textContent = metrics.clockSynced ? '✓ Synced' : '○ Not synced';
        clockSyncStatus.style.color = metrics.clockSynced ? '#48bb78' : '#ecc94b';
    }

    const totalLatency = metrics.totalLatency || 1;
    
    const rosLatency = metrics.rosLatency || 0;
    const processingLatency = metrics.processingLatency || 0;
    const networkLatency = metrics.networkLatency || 0;
    const renderLatency = metrics.renderLatency || 0;

    document.getElementById('rosLatency').textContent = Math.round(rosLatency) + 'ms';
    document.getElementById('processingLatency').textContent = Math.round(processingLatency) + 'ms';
    document.getElementById('networkLatency').textContent = Math.round(networkLatency) + 'ms';
    document.getElementById('renderLatency').textContent = Math.round(renderLatency) + 'ms';

    document.getElementById('rosLatencyBar').style.width = Math.min((rosLatency / totalLatency * 100), 100) + '%';
    document.getElementById('processingLatencyBar').style.width = Math.min((processingLatency / totalLatency * 100), 100) + '%';
    document.getElementById('networkLatencyBar').style.width = Math.min((networkLatency / totalLatency * 100), 100) + '%';
    document.getElementById('renderLatencyBar').style.width = Math.min((renderLatency / totalLatency * 100), 100) + '%';
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

    const video = document.getElementById('detailVideo');
    video.srcObject = null;
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