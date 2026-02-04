// WebRTC Client for ROS2 Streaming
// 
// FIXES APPLIED:
// 1. getClockSyncStats() returns ALL fields app.js expects (minRtt, maxRtt, etc.)
// 2. Timestamp correlation: store timestamps in buffer, calculate latency at DISPLAY time
// 3. Works with EXISTING Go relay (no Go changes needed) - frame_id sent inside 'metrics' messages
// 4. Backward compatible with old metrics format
//
class WebRTCClient {
    constructor(signalingUrl) {
        this.signalingUrl = signalingUrl;
        this.ws = null;
        this.pc = null;
        this.dataChannel = null;
        this.streams = new Map();
        this.metrics = new Map();
        this.videoElements = new Map();
        this.clientId = null;
        
        // ==================== CLOCK SYNCHRONIZATION STATE ====================
        this.clockSyncSamples = [];
        this.rttSamples = [];
        this.pendingPings = new Map();
        this.clockSyncInterval = null;
        this.clockOffset = 0;           // Go Server ↔ Browser offset (ping/pong)
        this.clockSynced = false;
        this.lastSyncTime = null;
        
        // ==================== TWO-STAGE CLOCK SYNC ====================
        this.pythonBrowserOffset = 0;
        this.pythonOffsetCalibrated = false;
        this.rawLatencySamples = [];
        
        // ==================== TIMESTAMP BUFFER FOR FRAME CORRELATION ====================
        //
        // WHY THIS EXISTS:
        // Timestamps arrive via DataChannel/WebSocket (~25-40ms path)
        // Video frames arrive via RTP/decode/display (~60-120ms path)
        //
        // So timestamps arrive 40-80ms BEFORE their video frame!
        //
        // OLD BUG: Calculated latency when timestamp arrived → showed ~40ms (wrong!)
        // FIX: Store timestamp, calculate when video displays → shows ~100ms (correct!)
        //
        this.timestampBuffer = new Map();  // frame_id -> {capture_ms, receive_ms, ...}
        this.frameIdOffset = null;         // Maps browser's presentedFrames → Python's frame_id
        this.glassLatencyHistory = [];     // Smoothing buffer
        
        // Callbacks
        this.onStreamAdded = null;
        this.onStreamRemoved = null;
        this.onMetricsUpdate = null;
        this.onConnectionStateChange = null;
        this.onClockSync = null;
    }
    
    // ==================== CLOCK SYNCHRONIZATION ====================
    
    startClockSync() {
        console.log('Starting clock synchronization...');
        
        for (let i = 0; i < 5; i++) {
            setTimeout(() => this.sendPing(), i * 200);
        }
        
        this.clockSyncInterval = setInterval(() => {
            this.sendPing();
        }, 5000);
    }
    
    stopClockSync() {
        if (this.clockSyncInterval) {
            clearInterval(this.clockSyncInterval);
            this.clockSyncInterval = null;
        }
    }
    
    sendPing() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        
        const pingId = Math.random().toString(36).substring(2, 10);
        const t1 = Date.now();
        
        this.pendingPings.set(pingId, { t1 });
        
        this.sendMessage({
            type: 'ping',
            ping_id: pingId,
            client_time: t1
        });
        
        setTimeout(() => {
            if (this.pendingPings.has(pingId)) {
                this.pendingPings.delete(pingId);
            }
        }, 5000);
    }
    
    handlePong(msg) {
        const t4 = Date.now();
        
        const pingData = this.pendingPings.get(msg.ping_id);
        if (!pingData) return;
        this.pendingPings.delete(msg.ping_id);
        
        const t1 = pingData.t1;
        const t2 = msg.server_receive;
        const t3 = msg.server_send;
        
        const rtt = (t4 - t1) - (t3 - t2);
        const oneWayDelay = rtt / 2;
        const offset = (t2 + oneWayDelay) - t4;
        
        const MAX_VALID_RTT = 500;
        if (rtt > MAX_VALID_RTT || rtt < 0) return;
        
        this.clockSyncSamples.push({ offset, rtt, timestamp: t4 });
        if (this.clockSyncSamples.length > 20) this.clockSyncSamples.shift();
        
        if (this.clockSyncSamples.length >= 3) {
            const sortedByRTT = [...this.clockSyncSamples].sort((a, b) => a.rtt - b.rtt);
            const bestSamples = sortedByRTT.slice(0, Math.ceil(sortedByRTT.length / 2));
            
            const offsets = bestSamples.map(s => s.offset).sort((a, b) => a - b);
            this.clockOffset = offsets[Math.floor(offsets.length / 2)];
            this.clockSynced = true;
            this.lastSyncTime = Date.now();
            this.rttSamples = bestSamples.map(s => s.rtt);
            
            if (this.clockSyncSamples.length <= 5 || this.clockSyncSamples.length % 5 === 0) {
                const rtts = bestSamples.map(s => s.rtt);
                const avgRtt = rtts.reduce((a, b) => a + b, 0) / rtts.length;
                console.log(`Clock Sync: offset=${this.clockOffset.toFixed(2)}ms, RTT=${rtt.toFixed(2)}ms (avg best: ${avgRtt.toFixed(2)}ms)`);
            }
            
            if (this.onClockSync) {
                this.onClockSync(this.getClockSyncStats());
            }
        }
    }
    
    serverToClientTime(serverTime) {
        return serverTime - this.clockOffset;
    }
    
    clientToServerTime(clientTime) {
        return clientTime + this.clockOffset;
    }
    
    getSyncedServerTime() {
        return Date.now() + this.clockOffset;
    }
    
    /**
     * Get clock sync statistics.
     * IMPORTANT: Returns ALL fields that app.js expects for backward compatibility!
     */
    getClockSyncStats() {
        if (!this.clockSynced && !this.pythonOffsetCalibrated) {
            return null;
        }
        
        const avgRtt = this.rttSamples.length > 0
            ? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length
            : 0;
        const minRtt = this.rttSamples.length > 0 ? Math.min(...this.rttSamples) : 0;
        const maxRtt = this.rttSamples.length > 0 ? Math.max(...this.rttSamples) : 0;
        
        const allOffsets = this.clockSyncSamples.map(s => s.offset);
        const avgOffset = allOffsets.length > 0
            ? allOffsets.reduce((a, b) => a + b, 0) / allOffsets.length
            : 0;
        const variance = allOffsets.length > 0
            ? allOffsets.reduce((sum, val) => sum + Math.pow(val - avgOffset, 2), 0) / allOffsets.length
            : 0;
        const stdDev = Math.sqrt(variance);
        
        let syncQuality = 'Excellent';
        if (stdDev > 20) syncQuality = 'Good';
        if (stdDev > 50) syncQuality = 'Fair';
        if (stdDev > 100) syncQuality = 'Poor';
        
        const activeOffset = this.pythonOffsetCalibrated ? this.pythonBrowserOffset : this.clockOffset;
        const offsetSource = this.pythonOffsetCalibrated ? 'Python↔Browser' : 'Go↔Browser';
        
        return {
            // ═══ Fields required by app.js (backward compatible) ═══
            offset: activeOffset,
            offsetDirection: activeOffset > 0 ? 'Server ahead' : 'Client ahead',
            offsetSource: offsetSource,
            goOffset: this.clockOffset,
            pythonOffset: this.pythonBrowserOffset,
            pythonCalibrated: this.pythonOffsetCalibrated,
            avgRtt: avgRtt,
            minRtt: minRtt,           // ← app.js needs this!
            maxRtt: maxRtt,           // ← app.js needs this!
            jitter: maxRtt - minRtt,  // ← app.js needs this!
            stdDev: stdDev,           // ← app.js needs this!
            syncQuality: syncQuality, // ← app.js needs this!
            samples: this.clockSyncSamples.length,
            usedSamples: Math.ceil(this.clockSyncSamples.length / 2),
            synced: this.clockSynced || this.pythonOffsetCalibrated,
            lastSyncTime: this.lastSyncTime,
            
            // ═══ Glass-to-glass latency stats ═══
            glassLatency: this.glassLatencyHistory.length > 0
                ? this.glassLatencyHistory[this.glassLatencyHistory.length - 1]
                : null,
            smoothedGlassLatency: this.glassLatencyHistory.length > 0
                ? this.glassLatencyHistory.reduce((a, b) => a + b, 0) / this.glassLatencyHistory.length
                : null,
            timestampBufferSize: this.timestampBuffer.size
        };
    }

    // ==================== TIMESTAMP BUFFER FOR FRAME CORRELATION ====================
    //
    // CONCEPT:
    // ────────
    // Timestamps travel via DataChannel (fast: ~25-40ms)
    // Video frames travel via RTP → decode → display (slow: ~60-120ms)
    //
    // So timestamp for frame N arrives 40-80ms BEFORE frame N displays!
    //
    // OLD BUG:
    //   handleMetrics() calculated latency = now - timestamp → showed ~40ms
    //   This was DataChannel latency, NOT glass-to-glass!
    //
    // FIX:
    //   1. When timestamp arrives → ONLY store in buffer (don't calculate!)
    //   2. When video frame displays → look up timestamp → NOW calculate latency
    //
    // MATH:
    //   glass_latency = T_display - T_capture - clock_offset
    //
    //   Where:
    //   - T_display = when frame actually painted to screen (from requestVideoFrameCallback)
    //   - T_capture = when Python captured the frame (from timestamp message)
    //   - clock_offset = Python_clock - Browser_clock
    //
    // ═════════════════════════════════════════════════════════════════════════════════
    
    /**
     * Buffer a frame timestamp. Called when timestamp arrives (BEFORE video displays).
     * We do NOT calculate latency here!
     */
    bufferFrameTimestamp(frameId, captureMs, trackId, extraData) {
        if (frameId === undefined || captureMs === undefined) return;
        
        this.timestampBuffer.set(frameId, {
            frame_id: frameId,
            capture_ms: captureMs,
            receive_ms: Date.now(),
            track_id: trackId,
            extra: extraData || {},
            matched: false
        });
        
        // Cleanup old entries (keep last 300 = ~10 seconds at 30fps)
        if (this.timestampBuffer.size > 300) {
            const cutoff = frameId - 300;
            for (const [id] of this.timestampBuffer) {
                if (id < cutoff) this.timestampBuffer.delete(id);
            }
        }
    }
    
    /**
     * Called when a video frame actually DISPLAYS (from requestVideoFrameCallback).
     * THIS is where glass-to-glass latency is calculated!
     */
    correlateDisplayedFrame(trackId, metadata) {
        if (!metadata || !metadata.presentedFrames) return;
        
        const displayTime = Date.now();
        const browserFrameNum = metadata.presentedFrames;
        
        // ════════════════════════════════════════════════════════════════════════
        // FIND MATCHING TIMESTAMP
        // ════════════════════════════════════════════════════════════════════════
        //
        // Browser's presentedFrames counter ≠ Python's frame_id counter
        // They started at different times with different offsets.
        //
        // Strategy:
        // 1. First time: Search buffer for best timing match → learn the offset
        // 2. After that: Use known offset for direct lookup
        //
        // ════════════════════════════════════════════════════════════════════════
        
        let matchedTs = null;
        let matchedId = null;
        
        if (this.frameIdOffset !== null) {
            // We know the offset between counters - direct lookup
            const expectedId = browserFrameNum + this.frameIdOffset;
            
            // Try exact match first, then nearby
            for (let delta = 0; delta <= 5; delta++) {
                for (const tryDelta of (delta === 0 ? [0] : [-delta, delta])) {
                    const tryId = expectedId + tryDelta;
                    const ts = this.timestampBuffer.get(tryId);
                    if (ts && !ts.matched) {
                        matchedTs = ts;
                        matchedId = tryId;
                        break;
                    }
                }
                if (matchedTs) break;
            }
        } else {
            // Don't know offset yet - search for best timing match
            let bestScore = Infinity;
            
            for (const [frameId, ts] of this.timestampBuffer) {
                if (ts.matched) continue;
                
                const timeSinceReceive = displayTime - ts.receive_ms;
                // Video takes ~30-200ms from when timestamp was received to display
                if (timeSinceReceive > 0 && timeSinceReceive < 500) {
                    const score = Math.abs(timeSinceReceive - 80);
                    if (score < bestScore) {
                        bestScore = score;
                        matchedTs = ts;
                        matchedId = frameId;
                    }
                }
            }
            
            // Learn the offset
            if (matchedTs && matchedId !== null) {
                this.frameIdOffset = matchedId - browserFrameNum;
                console.log(`🔗 Frame ID offset: ${this.frameIdOffset} (browser #${browserFrameNum} = python frame_id ${matchedId})`);
            }
        }
        
        if (!matchedTs) return;
        
        // Mark as matched
        matchedTs.matched = true;
        
        // ════════════════════════════════════════════════════════════════════════
        // CALCULATE GLASS-TO-GLASS LATENCY
        // ════════════════════════════════════════════════════════════════════════
        //
        // glass_latency = T_display(browser_clock) - T_capture(python_clock) - offset
        //
        // If clocks are synced:
        //   offset = Python↔Browser combined offset
        //   glass_latency = displayTime - captureMs - offset
        //
        // If not synced:
        //   Use two-stage calibration (raw latency → estimated offset)
        //
        // ════════════════════════════════════════════════════════════════════════
        
        const rawDisplayLatency = displayTime - matchedTs.capture_ms;
        let glassLatency;
        let method;
        
        if (this.pythonOffsetCalibrated) {
            glassLatency = rawDisplayLatency - this.pythonBrowserOffset;
            method = 'python-synced';
        } else if (this.clockSynced) {
            // Go↔Browser synced but not Python↔Browser
            // Use raw latency for calibration
            if (Math.abs(rawDisplayLatency) > 1000) {
                // Large skew detected - calibrate
                this.rawLatencySamples.push(rawDisplayLatency);
                if (this.rawLatencySamples.length > 10) this.rawLatencySamples.shift();
                
                if (this.rawLatencySamples.length >= 3) {
                    const sorted = [...this.rawLatencySamples].sort((a, b) => a - b);
                    const median = sorted[Math.floor(sorted.length / 2)];
                    const estimatedNetwork = this.rttSamples.length > 0
                        ? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length / 2 + 50
                        : 75;
                    this.pythonBrowserOffset = median - estimatedNetwork;
                    this.pythonOffsetCalibrated = true;
                    console.log(` Python↔Browser offset calibrated: ${this.pythonBrowserOffset.toFixed(1)}ms`);
                }
                
                glassLatency = this.rttSamples.length > 0
                    ? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length / 2 + 50
                    : 75;
                method = 'calibrating';
            } else {
                // No skew - clocks are roughly aligned
                glassLatency = rawDisplayLatency;
                method = 'raw-display';
            }
        } else {
            glassLatency = rawDisplayLatency;
            method = 'raw';
        }
        
        // Sanity check
        if (glassLatency > 0 && glassLatency < 5000) {
            this.glassLatencyHistory.push(glassLatency);
            if (this.glassLatencyHistory.length > 30) this.glassLatencyHistory.shift();
            
            const smoothed = this.glassLatencyHistory.reduce((a, b) => a + b, 0) / this.glassLatencyHistory.length;
            
            // Update metrics for this track
            const metrics = this.metrics.get(trackId) || {};
            metrics.glassLatency = glassLatency;
            metrics.smoothedGlassLatency = smoothed;
            metrics.latencyMethod = method;
            metrics.lastMatchedFrameId = matchedId;
            this.metrics.set(trackId, metrics);
            
            if (matchedId % 30 === 0) {
                console.log(` Glass latency: ${glassLatency.toFixed(1)}ms (smoothed: ${smoothed.toFixed(1)}ms) [${method}]`);
            }
        }
        
        // Remove from buffer
        this.timestampBuffer.delete(matchedId);
    }
    
    // ==================== CONNECTION ====================

    async connect() {
        return new Promise((resolve, reject) => {
            console.log('Connecting to signaling server:', this.signalingUrl);
            
            this.ws = new WebSocket(this.signalingUrl);

            this.ws.onopen = () => {
                console.log('WebSocket connected');
                this.setupWebRTC();
                this.startClockSync();
                resolve();
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                reject(error);
            };

            this.ws.onclose = () => {
                console.log('WebSocket disconnected');
                this.stopClockSync();
                if (this.onConnectionStateChange) {
                    this.onConnectionStateChange('disconnected');
                }
                this.cleanup();
            };

            this.ws.onmessage = async (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    await this.handleSignalingMessage(msg);
                } catch (error) {
                    console.error('Error handling message:', error);
                }
            };
        });
    }

    setupWebRTC() {
        console.log('Setting up WebRTC with low-latency optimizations...');

        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ],
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        };

        this.pc = new RTCPeerConnection(configuration);

        const dcOptions = { 
            ordered: false,
            maxRetransmits: 0
        };
        this.dataChannel = this.pc.createDataChannel('metrics', dcOptions);
        console.log('Created data channel, initial state:', this.dataChannel.readyState);
        
        const setupDataChannelHandlers = (dc, label) => {
            console.log(`Setting up handlers for data channel: ${label}, state: ${dc.readyState}`);
            
            if (dc.readyState === 'open') {
                console.log(`Data channel ${label} already OPEN!`);
            }
            
            dc.onopen = () => console.log(`Data channel ${label} OPENED!`);
            dc.onclose = () => console.log(`Data channel ${label} closed`);
            dc.onerror = (error) => console.error(`Data channel ${label} error:`, error);
            
            let dcMsgCount = 0;
            
            dc.onmessage = (event) => {
                dcMsgCount++;
                try {
                    let jsonStr;
                    if (typeof event.data === 'string') {
                        jsonStr = event.data;
                    } else if (event.data instanceof ArrayBuffer) {
                        jsonStr = new TextDecoder().decode(event.data);
                    } else if (event.data instanceof Blob) {
                        return;
                    } else {
                        return;
                    }
                    
                    const data = JSON.parse(jsonStr);
                    if (data.type === 'metrics') {
                        this.handleMetrics(data.data, data.timestamp);
                    }
                } catch (error) {
                    if (dcMsgCount <= 3) {
                        console.warn(`Data channel parse error (msg #${dcMsgCount})`);
                    }
                }
            };
        };
        
        setupDataChannelHandlers(this.dataChannel, 'metrics (local)');

        // Handle incoming tracks
        this.pc.ontrack = (event) => {
            console.log('Received track event:', event);
            console.log('Track ID:', event.track.id);
            console.log('Track kind:', event.track.kind);
            
            // Low latency settings
            const receiver = event.receiver;
            if (receiver) {
                if (receiver.playoutDelayHint !== undefined) {
                    receiver.playoutDelayHint = 0.0;
                    console.log('Set playoutDelayHint to 0ms');
                }
                if (receiver.jitterBufferTarget !== undefined) {
                    receiver.jitterBufferTarget = 0.01;
                    console.log('Set jitterBufferTarget to 10ms');
                }
            }
            
            let trackId = event.track.id;
            
            if (event.streams && event.streams.length > 0) {
                const streamId = event.streams[0].id;
                if (streamId && streamId.startsWith('stream_')) {
                    trackId = streamId.replace('stream_', '');
                }
            }
            
            const stream = event.streams[0];
            if (stream) {
                this.streams.set(trackId, stream);
                
                this.metrics.set(trackId, {
                    frameCount: 0,
                    totalLatency: 0,
                    rosLatency: 0,
                    processingLatency: 0,
                    networkLatency: 0,
                    renderLatency: 0,
                    jitterBufferDelay: 0,
                    decodeTime: 0,
                    glassLatency: 0,
                    smoothedGlassLatency: 0
                });
                
                try {
                    if (this.onStreamAdded) {
                        this.onStreamAdded(trackId, stream);
                    }
                } catch (error) {
                    console.error('Error in onStreamAdded callback:', error);
                }

                try {
                    this.setupFrameCallback(trackId, stream);
                } catch (error) {
                    console.error('Error setting up frame callback:', error);
                }
            }
        };

        // Handle incoming data channel from server
        this.pc.ondatachannel = (event) => {
            console.log('Received data channel from server:', event.channel.label);
            const channel = event.channel;
            
            channel.onopen = () => console.log('Server data channel opened');
            channel.onclose = () => console.log('Server data channel closed');

            channel.onmessage = (msgEvent) => {
                try {
                    let jsonStr;
                    if (typeof msgEvent.data === 'string') {
                        jsonStr = msgEvent.data;
                    } else if (msgEvent.data instanceof ArrayBuffer) {
                        jsonStr = new TextDecoder().decode(msgEvent.data);
                    } else {
                        return;
                    }
                    
                    const data = JSON.parse(jsonStr);
                    if (data.type === 'metrics') {
                        this.handleMetrics(data.data, data.timestamp);
                    }
                } catch (error) {
                    // ignore
                }
            };
        };

        this.pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendMessage({
                    type: 'candidate',
                    candidate: event.candidate.toJSON()
                });
            }
        };

        this.pc.onconnectionstatechange = () => {
            console.log('Connection state:', this.pc.connectionState);
            if (this.onConnectionStateChange) {
                this.onConnectionStateChange(this.pc.connectionState);
            }
        };

        this.pc.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', this.pc.iceConnectionState);
        };

        this.sendMessage({
            type: 'join',
            role: 'viewer'
        });
    }

    setupFrameCallback(trackId, stream) {
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        video.autoplay = true;
        video.preload = 'none';
        if (video.latencyHint !== undefined) {
            video.latencyHint = 'low';
        }
        
        video.play().catch(e => {
            console.warn('Video play error (hidden element):', e.message);
        });

        let lastPresentationTime = 0;
        let frameCount = 0;
        let processingDurationSamples = [];

        const callback = (now, metadata) => {
            frameCount++;
            const metrics = this.metrics.get(trackId) || {};
            metrics.frameCount = frameCount;
            
            if (metadata) {
                metrics.presentedFrames = metadata.presentedFrames;
                metrics.width = metadata.width;
                metrics.height = metadata.height;
                
                if (metadata.processingDuration !== undefined) {
                    const processingMs = metadata.processingDuration * 1000;
                    processingDurationSamples.push(processingMs);
                    if (processingDurationSamples.length > 30) processingDurationSamples.shift();
                    const sorted = [...processingDurationSamples].sort((a, b) => a - b);
                    metrics.renderLatency = sorted[Math.floor(sorted.length / 2)];
                }
                
                if (lastPresentationTime > 0 && metadata.presentationTime) {
                    metrics.frameInterval = (metadata.presentationTime - lastPresentationTime) * 1000;
                }
                if (metadata.presentationTime) {
                    lastPresentationTime = metadata.presentationTime;
                }
                
                if (metadata.expectedDisplayTime && metadata.presentationTime) {
                    metrics.compositorDelay = (metadata.presentationTime - metadata.expectedDisplayTime) * 1000;
                }
                
                // ══════════════════════════════════════════════════════════════════
                // FRAME CORRELATION: Calculate glass-to-glass latency at DISPLAY time!
                // This is the FIX for the timestamp timing bug.
                // ══════════════════════════════════════════════════════════════════
                this.correlateDisplayedFrame(trackId, metadata);
                
            } else {
                metrics.renderLatency = now - (this._lastFrameTime || now);
            }
            this._lastFrameTime = now;

            this.metrics.set(trackId, metrics);

            if (video.requestVideoFrameCallback) {
                video.requestVideoFrameCallback(callback);
            }
        };

        if (video.requestVideoFrameCallback) {
            video.requestVideoFrameCallback(callback);
            console.log('requestVideoFrameCallback enabled for', trackId);
        } else {
            console.warn('requestVideoFrameCallback not supported');
        }

        this.videoElements.set(trackId, video);
        this.startJitterBufferMonitoring(trackId);
    }
    
    startJitterBufferMonitoring(trackId) {
        if (this._jitterMonitorInterval) return;
        
        this._jitterMonitorInterval = setInterval(async () => {
            if (!this.pc) return;
            
            try {
                const stats = await this.pc.getStats();
                
                stats.forEach(report => {
                    if (report.type === 'inbound-rtp' && report.kind === 'video') {
                        const metrics = this.metrics.get(trackId) || {};
                        
                        if (report.jitterBufferDelay && report.jitterBufferEmittedCount) {
                            metrics.jitterBufferDelay = (report.jitterBufferDelay / report.jitterBufferEmittedCount) * 1000;
                        }
                        
                        if (report.totalDecodeTime && report.framesDecoded) {
                            metrics.decodeTime = (report.totalDecodeTime / report.framesDecoded) * 1000;
                        }
                        
                        metrics.framesDropped = report.framesDropped || 0;
                        metrics.framesDecoded = report.framesDecoded || 0;
                        
                        if (report.jitter !== undefined) {
                            metrics.jitter = report.jitter * 1000;
                        }
                        
                        this.metrics.set(trackId, metrics);
                        
                        if (this._jitterLogCount === undefined) this._jitterLogCount = 0;
                        this._jitterLogCount++;
                        if (this._jitterLogCount <= 3 || this._jitterLogCount % 30 === 0) {
                            console.log(`Render Pipeline: JitterBuf=${metrics.jitterBufferDelay?.toFixed(1) || '?'}ms, Decode=${metrics.decodeTime?.toFixed(1) || '?'}ms, Render=${metrics.renderLatency?.toFixed(1) || '?'}ms`);
                        }
                    }
                });
            } catch (e) {
                // Ignore
            }
        }, 1000);
    }

    /**
     * Handle incoming metrics from Python (via Go relay).
     * 
     * Now also extracts frame_id and capture_ms for timestamp correlation.
     * The latency shown is calculated in correlateDisplayedFrame() when video displays,
     * NOT here when the timestamp arrives.
     */
    handleMetrics(metricsData, timestamp) {
        if (!this._metricsLogCount) this._metricsLogCount = 0;
        this._metricsLogCount++;
        const shouldLog = this._metricsLogCount <= 5 || this._metricsLogCount % 30 === 0;
        
        const receiveTime = Date.now();
        const serverTimeMs = timestamp * 1000;
        
        // ════════════════════════════════════════════════════════════════════════
        // EXTRACT frame_id AND capture_ms FOR TIMESTAMP CORRELATION
        // Python now embeds these in the metrics message so Go can forward them
        // without needing to understand a new message type.
        // ════════════════════════════════════════════════════════════════════════
        
        for (const [trackId, trackMetrics] of Object.entries(metricsData)) {
            // Buffer the timestamp if frame_id is present
            if (trackMetrics.frame_id !== undefined && trackMetrics.capture_ms !== undefined) {
                this.bufferFrameTimestamp(
                    trackMetrics.frame_id,
                    trackMetrics.capture_ms,
                    trackId,
                    { ros_latency: trackMetrics.ros_latency, encoding_latency: trackMetrics.encoding_latency }
                );
                
                if (shouldLog) {
                    console.log(`Buffered timestamp: frame_id=${trackMetrics.frame_id}, buffer=${this.timestampBuffer.size}`);
                }
            }
        }
        
        // ════════════════════════════════════════════════════════════════════════
        // NETWORK LATENCY (DataChannel latency, NOT glass-to-glass)
        // This is kept for backward compatibility and for showing
        // the network component of total latency.
        // ════════════════════════════════════════════════════════════════════════
        
        const rawLatency = receiveTime - serverTimeMs;
        let networkTime;
        let latencyMethod;
        
        const SKEW_THRESHOLD = 1000;
        const hasLargeSkew = Math.abs(rawLatency) > SKEW_THRESHOLD;
        
        if (hasLargeSkew) {
            this.rawLatencySamples.push(rawLatency);
            if (this.rawLatencySamples.length > 10) this.rawLatencySamples.shift();
            
            if (this.rawLatencySamples.length >= 3 && !this.pythonOffsetCalibrated) {
                const sorted = [...this.rawLatencySamples].sort((a, b) => a - b);
                const medianRaw = sorted[Math.floor(sorted.length / 2)];
                const estimatedNetworkLatency = this.rttSamples.length > 0
                    ? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length / 2
                    : 25;
                this.pythonBrowserOffset = medianRaw - estimatedNetworkLatency;
                this.pythonOffsetCalibrated = true;
                console.log(`Python↔Browser offset calibrated: ${this.pythonBrowserOffset.toFixed(1)}ms`);
            }
            
            if (this.pythonOffsetCalibrated) {
                const compensated = rawLatency - this.pythonBrowserOffset;
                if (compensated >= 0 && compensated < 5000) {
                    networkTime = compensated;
                    latencyMethod = 'python-synced';
                } else {
                    this.pythonOffsetCalibrated = false;
                    this.rawLatencySamples = [];
                    networkTime = this.rttSamples.length > 0
                        ? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length / 2
                        : 20;
                    latencyMethod = 'recalibrating';
                }
            } else {
                networkTime = this.rttSamples.length > 0
                    ? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length / 2
                    : 20;
                latencyMethod = 'calibrating';
            }
        } else {
            if (this.pythonOffsetCalibrated && Math.abs(rawLatency) < 500) {
                this.pythonOffsetCalibrated = false;
                this.pythonBrowserOffset = 0;
                this.rawLatencySamples = [];
            }
            
            if (this.clockSynced) {
                const compensated = rawLatency + this.clockOffset;
                if (compensated >= 0 && compensated < 1000) {
                    networkTime = compensated;
                    latencyMethod = 'synced';
                } else {
                    networkTime = Math.max(0, rawLatency);
                    latencyMethod = 'raw';
                }
            } else {
                networkTime = Math.max(0, rawLatency);
                latencyMethod = 'raw';
            }
        }

        // Update metrics for each track
        for (const [trackId, trackMetrics] of Object.entries(metricsData)) {
            const existing = this.metrics.get(trackId) || {};
            
            const combined = {
                ...existing,
                rosLatency: trackMetrics.ros_latency || 0,
                encodingLatency: trackMetrics.encoding_latency || 0,
                networkLatency: Math.max(0, networkTime),
                processingLatency: (trackMetrics.ros_latency || 0) + (trackMetrics.encoding_latency || 0),
                timestamp: Date.now(),
                clockSynced: this.clockSynced || this.pythonOffsetCalibrated,
                latencyMethod: latencyMethod,
                rawLatency: rawLatency,
                clockOffset: this.clockOffset,
                pythonOffset: this.pythonBrowserOffset
            };

            // Total latency: use glass-to-glass if available, otherwise sum components
            if (combined.smoothedGlassLatency && combined.smoothedGlassLatency > 0) {
                combined.totalLatency = combined.smoothedGlassLatency;
            } else {
                combined.totalLatency = 
                    combined.rosLatency + 
                    combined.encodingLatency + 
                    combined.networkLatency + 
                    (combined.renderLatency || 0);
            }

            if (shouldLog) {
                const glassInfo = combined.smoothedGlassLatency 
                    ? `, glass=${combined.smoothedGlassLatency.toFixed(1)}ms` 
                    : '';
                console.log(`${trackId}: total=${combined.totalLatency.toFixed(1)}ms, network=${combined.networkLatency.toFixed(1)}ms (${latencyMethod})${glassInfo}`);
            }
            this.metrics.set(trackId, combined);
        }

        if (this.onMetricsUpdate) {
            this.onMetricsUpdate(this.metrics);
        }
    }

    async handleSignalingMessage(msg) {
        if (msg.type === 'pong') {
            this.handlePong(msg);
            return;
        }
        
        if (msg.type === 'metrics') {
            if (!this._wsMetricsCount) this._wsMetricsCount = 0;
            this._wsMetricsCount++;
            if (this._wsMetricsCount <= 3) {
                console.log('Received metrics via WebSocket (msg #' + this._wsMetricsCount + ')');
            }
            this.handleMetrics(msg.data, msg.timestamp);
            return;
        }
        
        switch (msg.type) {
            case 'joined':
                this.clientId = msg.client_id;
                console.log('Joined as client:', msg.client_id);
                
                const streamCount = msg.streams ? msg.streams.length : 1;
                for (let i = 0; i < Math.max(1, streamCount); i++) {
                    this.pc.addTransceiver('video', { direction: 'recvonly' });
                }
                
                const offer = await this.pc.createOffer();
                await this.pc.setLocalDescription(offer);
                
                this.sendMessage({
                    type: 'offer',
                    sdp: {
                        type: this.pc.localDescription.type,
                        sdp: this.pc.localDescription.sdp
                    }
                });
                break;

            case 'answer':
                try {
                    let answerSdp = msg.sdp;
                    if (msg.sdp && typeof msg.sdp === 'object') {
                        answerSdp = msg.sdp.sdp || msg.sdp;
                    }
                    const answer = new RTCSessionDescription({
                        type: 'answer',
                        sdp: answerSdp
                    });
                    await this.pc.setRemoteDescription(answer);
                    console.log('Set remote description');
                } catch (e) {
                    console.error('Error setting remote description:', e);
                }
                break;

            case 'candidate':
            case 'ice':
                if (msg.candidate) {
                    try {
                        await this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                    } catch (e) {
                        console.warn('Error adding ICE candidate:', e.message);
                    }
                }
                break;

            case 'streams':
                console.log('Updated streams list:', msg.streams);
                break;

            case 'error':
                console.error('Server error:', msg.message);
                break;
        }
    }

    sendMessage(msg) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    getStream(trackId) { return this.streams.get(trackId); }
    getMetrics(trackId) { return this.metrics.get(trackId); }
    getAllStreams() { return Array.from(this.streams.keys()); }
    getAllMetrics() { return this.metrics; }

    cleanup() {
        this.stopClockSync();
        
        if (this._jitterMonitorInterval) {
            clearInterval(this._jitterMonitorInterval);
            this._jitterMonitorInterval = null;
        }

        if (this.dataChannel) {
            this.dataChannel.close();
            this.dataChannel = null;
        }

        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        this.streams.clear();
        this.metrics.clear();
        this.pendingPings.clear();
        this.timestampBuffer.clear();
        this.glassLatencyHistory = [];
        this.frameIdOffset = null;
        
        this.clockSyncSamples = [];
        this.rttSamples = [];
        this.clockOffset = 0;
        this.clockSynced = false;
        this.lastSyncTime = null;
        
        this.pythonBrowserOffset = 0;
        this.pythonOffsetCalibrated = false;
        this.rawLatencySamples = [];
        
        this.videoElements.forEach(video => {
            video.srcObject = null;
        });
        this.videoElements.clear();
    }

    disconnect() {
        this.cleanup();
    }
}