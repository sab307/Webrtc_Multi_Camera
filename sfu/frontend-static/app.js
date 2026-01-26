// Main Application Logic
let webrtcClient = null;
let currentStreams = [];
let currentStreamId = null;
let metricsUpdateInterval = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
    console.log('Initializing ROS2 WebRTC Streaming...');
    
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

        // Connect
        updateConnectionStatus('connecting');
        await webrtcClient.connect();
        updateConnectionStatus('connected');

    } catch (error) {
        console.error('Failed to initialize WebRTC:', error);
        updateConnectionStatus('failed');
    }
}

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

function addStreamToGrid(trackId, stream) {
    console.log('addStreamToGrid called for:', trackId);
    
    // Add to current streams
    if (!currentStreams.includes(trackId)) {
        currentStreams.push(trackId);
        updateStreamCount();
    }

    const grid = document.getElementById('streamGrid');
    
    // Remove loading message if it exists
    const loading = grid.querySelector('.loading');
    if (loading) {
        loading.remove();
    }

    // Check if card already exists
    if (document.getElementById(`card-${trackId}`)) {
        console.log('Card already exists for:', trackId);
        return;
    }

    // Create stream card
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
    
    // Debug: log when video gets data
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
    
    // Force play with retry
    const playVideo = async () => {
        try {
            await video.play();
            console.log(`Video ${trackId} playing`);
        } catch (err) {
            console.warn(`Video ${trackId} play failed:`, err.message);
            // Retry after a short delay
            setTimeout(playVideo, 500);
        }
    };
    
    // Start playing once added to DOM
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
    
    // Monitor the video track state
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
        
        // Update status based on current state
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

    // Show loading message if no streams
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

function updateMetrics(metricsMap) {
    // Update grid card metrics
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

    // Update detail view if open
    if (currentStreamId) {
        const metrics = metricsMap.get(currentStreamId);
        if (metrics) {
            updateDetailMetrics(metrics);
        }
    }
}

function updateDetailMetrics(metrics) {
    // Update stats
    document.getElementById('totalLatency').textContent = Math.round(metrics.totalLatency || 0) + 'ms';
    document.getElementById('frameCount').textContent = metrics.frameCount || 0;
    
    if (metrics.width && metrics.height) {
        document.getElementById('resolution').textContent = `${metrics.width}x${metrics.height}`;
    }

    // Update latency bars
    const totalLatency = metrics.totalLatency || 1; // Avoid division by zero
    
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

function showDetail(streamId) {
    console.log('Showing detail for:', streamId);
    currentStreamId = streamId;

    // Get stream
    const stream = webrtcClient.getStream(streamId);
    if (!stream) {
        console.error('Stream not found:', streamId);
        return;
    }

    // Hide dashboard, show detail
    document.getElementById('dashboardView').style.display = 'none';
    document.getElementById('detailView').style.display = 'block';

    // Update title
    document.getElementById('streamTitle').textContent = formatStreamName(streamId);

    // Attach stream to video
    const video = document.getElementById('detailVideo');
    video.srcObject = stream;
    video.play().catch(err => console.warn('Detail video play error:', err.message));

    // Update metrics immediately
    const metrics = webrtcClient.getMetrics(streamId);
    if (metrics) {
        updateDetailMetrics(metrics);
    }
}

function showDashboard() {
    currentStreamId = null;
    
    // Show dashboard, hide detail
    document.getElementById('dashboardView').style.display = 'block';
    document.getElementById('detailView').style.display = 'none';

    // Clear detail video
    const video = document.getElementById('detailVideo');
    video.srcObject = null;
}

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