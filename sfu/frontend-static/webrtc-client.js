// WebRTC Client for ROS2 Streaming with Clock Synchronization
class WebRTCClient {
    constructor(signalingUrl) {
        this.signalingUrl = signalingUrl;
        this.ws = null;
        this.pc = null;
        this.dataChannel = null;
        this.streams = new Map(); // trackId -> MediaStream
        this.metrics = new Map(); // trackId -> metrics
        this.videoElements = new Map(); // trackId -> video element
        this.clientId = null;
        
        // ==================== CLOCK SYNCHRONIZATION STATE ====================
        // Stores {offset, rtt, timestamp} objects for quality-based filtering
        this.clockSyncSamples = [];
        this.rttSamples = [];           // Derived from best clockSyncSamples
        this.pendingPings = new Map();  // pingId -> {t1}
        this.clockSyncInterval = null;
        this.clockOffset = 0;           // Go Server ↔ Browser offset (from ping/pong)
        this.clockSynced = false;       // True once we have reliable sync
        this.lastSyncTime = null;
        
        // ==================== TWO-STAGE CLOCK SYNC ====================
        // The ping/pong measures: Go relay ↔ Browser offset
        // But metrics timestamps come from: Python sender
        // So we need to detect and compensate for Python ↔ Browser offset separately
        this.pythonBrowserOffset = 0;       // Python sender ↔ Browser offset
        this.pythonOffsetCalibrated = false; // True once we've calculated Python offset
        this.rawLatencySamples = [];        // Recent raw latencies for calibration
        
        // Callbacks
        this.onStreamAdded = null;
        this.onStreamRemoved = null;
        this.onMetricsUpdate = null;
        this.onConnectionStateChange = null;
        this.onClockSync = null;        // Callback for clock sync updates
    }
    
    // ==================== CLOCK SYNCHRONIZATION ====================
    
    /**
     * Start the clock synchronization process.
     * Uses NTP-style ping/pong to measure RTT and calculate clock offset.
     * 
     * Algorithm:
     *   t1 = client send time
     *   t2 = server receive time
     *   t3 = server send time
     *   t4 = client receive time
     *   
     *   RTT = (t4 - t1) - (t3 - t2)
     *   Offset = ((t2 - t1) + (t3 - t4)) / 2
     *   
     * The offset tells us: server_time = client_time + offset
     */
    startClockSync() {
        console.log('Starting clock synchronization...');
        
        // Send initial burst of pings for quick sync (5 pings, 200ms apart)
        for (let i = 0; i < 5; i++) {
            setTimeout(() => this.sendPing(), i * 200);
        }
        
        // Then sync periodically (every 5 seconds) to maintain accuracy
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
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        
        const pingId = Math.random().toString(36).substring(2, 10);
        const t1 = Date.now(); // Client send time (absolute)
        
        this.pendingPings.set(pingId, {
            t1: t1
        });
        
        this.sendMessage({
            type: 'ping',
            ping_id: pingId,
            client_time: t1  // Send absolute time to server
        });
        
        // Timeout - remove stale pings after 5 seconds
        setTimeout(() => {
            if (this.pendingPings.has(pingId)) {
                this.pendingPings.delete(pingId);
                console.warn('Ping timeout:', pingId);
            }
        }, 5000);
    }
    
    handlePong(msg) {
        const t4 = Date.now(); // Client receive time
        
        const pingData = this.pendingPings.get(msg.ping_id);
        if (!pingData) {
            console.warn('Unknown pong received:', msg.ping_id);
            return;
        }
        
        this.pendingPings.delete(msg.ping_id);
        
        // NTP-style timestamps:
        const t1 = pingData.t1;          // Client send time
        const t2 = msg.server_receive;   // Server receive time
        const t3 = msg.server_send;      // Server send time
        // t4 = client receive time (already set above)
        
        // Calculate RTT and offset
        const rtt = (t4 - t1) - (t3 - t2);
        const oneWayDelay = rtt / 2;
        
        // Offset calculation: server_time + one_way_delay should equal our receive_time
        // offset = server_time - client_time (positive = server ahead)
        const offset = (t2 + oneWayDelay) - t4;
        
        // ============================================================
        // OUTLIER FILTERING - Reject bad samples based on RTT
        // ============================================================
        
        // Filter 1: Reject if RTT is too high (network congestion)
        const MAX_VALID_RTT = 500; // ms - stricter threshold
        if (rtt > MAX_VALID_RTT || rtt < 0) {
            console.warn(`Rejected sample: RTT ${rtt.toFixed(2)}ms out of range (max: ${MAX_VALID_RTT}ms)`);
            return;
        }
        
        // ============================================================
        // SAMPLE ACCEPTED - Store with RTT for quality-based filtering
        // ============================================================
        
        this.clockSyncSamples.push({
            offset: offset,
            rtt: rtt,
            timestamp: t4
        });
        
        // Keep last 20 samples
        if (this.clockSyncSamples.length > 20) {
            this.clockSyncSamples.shift();
        }
        
        // ============================================================
        // IMPROVED: Use median offset from samples with LOWEST RTT
        // This gives more accurate sync by prioritizing best network conditions
        // ============================================================
        
        if (this.clockSyncSamples.length >= 3) {
            // Sort by RTT and take the best 50% of samples
            const sortedByRTT = [...this.clockSyncSamples].sort((a, b) => a.rtt - b.rtt);
            const bestSamples = sortedByRTT.slice(0, Math.ceil(sortedByRTT.length / 2));
            
            // Calculate median offset from best samples
            const offsets = bestSamples.map(s => s.offset).sort((a, b) => a - b);
            const medianOffset = offsets[Math.floor(offsets.length / 2)];
            
            // Calculate RTT stats from best samples
            const rtts = bestSamples.map(s => s.rtt);
            const avgRtt = rtts.reduce((a, b) => a + b, 0) / rtts.length;
            const minRtt = Math.min(...rtts);
            const maxRtt = Math.max(...rtts);
            
            // Update the clock offset
            this.clockOffset = medianOffset;
            this.clockSynced = true;
            this.lastSyncTime = Date.now();
            
            // Store RTT samples for stats
            this.rttSamples = rtts;
            
            // Calculate sync quality
            const allOffsets = this.clockSyncSamples.map(s => s.offset);
            const avgOffset = allOffsets.reduce((a, b) => a + b, 0) / allOffsets.length;
            const variance = allOffsets.reduce((sum, val) => sum + Math.pow(val - avgOffset, 2), 0) / allOffsets.length;
            const stdDev = Math.sqrt(variance);
            
            // Determine sync quality rating
            let syncQuality = 'Excellent';
            if (stdDev > 20) syncQuality = 'Good';
            if (stdDev > 50) syncQuality = 'Fair';
            if (stdDev > 100) syncQuality = 'Poor';
            
            const syncStats = {
                offset: this.clockOffset,
                offsetDirection: this.clockOffset > 0 ? 'Server ahead' : 'Client ahead',
                rtt: rtt,
                avgRtt: avgRtt,
                minRtt: minRtt,
                maxRtt: maxRtt,
                jitter: maxRtt - minRtt,
                stdDev: stdDev,
                syncQuality: syncQuality,
                samples: this.clockSyncSamples.length,
                usedSamples: bestSamples.length,
                t1: t1,
                t2: t2,
                t3: t3,
                t4: t4
            };
            
            // Log sync details
            if (this.clockSyncSamples.length <= 5 || this.clockSyncSamples.length % 5 === 0) {
                console.log(`Clock Sync #${this.clockSyncSamples.length} [${syncQuality}]:`);
                console.log(`Offset: ${this.clockOffset.toFixed(2)}ms (${syncStats.offsetDirection})`);
                console.log(`RTT: ${rtt.toFixed(2)}ms (avg of best: ${avgRtt.toFixed(2)}ms)`);
                console.log(`Using ${bestSamples.length}/${this.clockSyncSamples.length} best samples`);
                console.log(`Std Dev: ${stdDev.toFixed(2)}ms`);
            }
            
            // Callback for UI updates
            if (this.onClockSync) {
                this.onClockSync(syncStats);
            }
        } else {
            console.log(`Collecting samples: ${this.clockSyncSamples.length}/3 (RTT: ${rtt.toFixed(2)}ms)`);
        }
    }
    
    /**
     * Convert a server timestamp to client time
     * @param {number} serverTime - Timestamp from server
     * @returns {number} Equivalent client time
     */
    serverToClientTime(serverTime) {
        return serverTime - this.clockOffset;
    }
    
    /**
     * Convert a client timestamp to server time
     * @param {number} clientTime - Timestamp from client
     * @returns {number} Equivalent server time
     */
    clientToServerTime(clientTime) {
        return clientTime + this.clockOffset;
    }
    
    /**
     * Get the current time synchronized to server clock
     * @returns {number} Current time in server's reference frame
     */
    getSyncedServerTime() {
        return Date.now() + this.clockOffset;
    }
    
    /**
     * Get comprehensive clock sync statistics
     * @returns {Object|null} Clock sync stats or null if not synced
     */
    getClockSyncStats() {
        if (!this.clockSynced && !this.pythonOffsetCalibrated) {
            return null;
        }
        
        const avgRtt = this.rttSamples.length > 0 
            ? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length 
            : 0;
        
        const offsets = this.clockSyncSamples.map(s => s.offset);
        const avgOffset = offsets.length > 0 
            ? offsets.reduce((a, b) => a + b, 0) / offsets.length 
            : 0;
        const variance = offsets.length > 0 
            ? offsets.reduce((sum, val) => sum + Math.pow(val - avgOffset, 2), 0) / offsets.length 
            : 0;
        
        // Determine which offset is being used
        const activeOffset = this.pythonOffsetCalibrated ? this.pythonBrowserOffset : this.clockOffset;
        const offsetSource = this.pythonOffsetCalibrated ? 'Python↔Browser' : 'Go↔Browser';
            
        return {
            offset: activeOffset,
            offsetDirection: activeOffset > 0 ? 'Server ahead' : 'Client ahead',
            offsetSource: offsetSource,
            goOffset: this.clockOffset,
            pythonOffset: this.pythonBrowserOffset,
            pythonCalibrated: this.pythonOffsetCalibrated,
            avgRtt: avgRtt,
            minRtt: this.rttSamples.length > 0 ? Math.min(...this.rttSamples) : 0,
            maxRtt: this.rttSamples.length > 0 ? Math.max(...this.rttSamples) : 0,
            jitter: this.rttSamples.length > 0 ? Math.max(...this.rttSamples) - Math.min(...this.rttSamples) : 0,
            stdDev: Math.sqrt(variance),
            samples: this.clockSyncSamples.length,
            synced: this.clockSynced || this.pythonOffsetCalibrated,
            lastSyncTime: this.lastSyncTime
        };
    }

    // ==================== CONNECTION ====================

    async connect() {
        return new Promise((resolve, reject) => {
            console.log('Connecting to signaling server:', this.signalingUrl);
            
            this.ws = new WebSocket(this.signalingUrl);

            this.ws.onopen = () => {
                console.log('WebSocket connected');
                this.setupWebRTC();
                
                // Start clock synchronization immediately after WebSocket connects
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
            // Optimize for low latency
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        };

        this.pc = new RTCPeerConnection(configuration);

        // Create data channel for receiving metrics (must be created by offerer)
        const dcOptions = { 
            ordered: false,
            maxRetransmits: 0  // Unreliable for low latency
        };
        this.dataChannel = this.pc.createDataChannel('metrics', dcOptions);
        console.log('Created data channel, initial state:', this.dataChannel.readyState);
        
        // Set up data channel handlers
        const setupDataChannelHandlers = (dc, label) => {
            console.log(`Setting up handlers for data channel: ${label}, state: ${dc.readyState}`);
            
            if (dc.readyState === 'open') {
                console.log(`Data channel ${label} already OPEN!`);
            }
            
            dc.onopen = () => {
                console.log(`Data channel ${label} OPENED!`);
            };
            
            dc.onclose = () => {
                console.log(`Data channel ${label} closed`);
            };
            
            dc.onerror = (error) => {
                console.error(`Data channel ${label} error:`, error);
            };
            
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
                        console.warn(`Data channel parse error (msg #${dcMsgCount}), using WebSocket fallback`);
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
            console.log('Streams:', event.streams);
            
            // ==================== LOW LATENCY: Minimize jitter buffer ====================
            const receiver = event.receiver;
            if (receiver) {
                if (receiver.playoutDelayHint !== undefined) {
                    receiver.playoutDelayHint = 0.0;  // Request minimum delay
                    console.log('Set playoutDelayHint to 0ms (minimum latency)');
                }
                if (receiver.jitterBufferTarget !== undefined) {
                    receiver.jitterBufferTarget = 0.01;  // 10ms target
                    console.log('Set jitterBufferTarget to 10ms');
                }
            }
            // ============================================================================
            
            let trackId = event.track.id;
            
            if (event.streams && event.streams.length > 0) {
                const streamId = event.streams[0].id;
                console.log('   Stream ID:', streamId);
                
                if (streamId && streamId.startsWith('stream_')) {
                    trackId = streamId.replace('stream_', '');
                    console.log('   Extracted track name:', trackId);
                }
            }
            
            const stream = event.streams[0];
            if (stream) {
                console.log(' Adding stream for track:', trackId);
                this.streams.set(trackId, stream);
                
                this.metrics.set(trackId, {
                    frameCount: 0,
                    totalLatency: 0,
                    rosLatency: 0,
                    processingLatency: 0,
                    networkLatency: 0,
                    renderLatency: 0,
                    jitterBufferDelay: 0,
                    decodeTime: 0
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
            } else {
                console.warn('No stream in track event');
            }
        };

        // Handle incoming data channel from server (backup)
        this.pc.ondatachannel = (event) => {
            console.log('Received data channel from server:', event.channel.label, 'state:', event.channel.readyState);
            const channel = event.channel;
            let serverDcMsgCount = 0;
            
            if (channel.readyState === 'open') {
                console.log('Server data channel already OPEN!');
            }

            channel.onopen = () => {
                console.log('Server data channel opened');
            };
            
            channel.onclose = () => {
                console.log('Server data channel closed');
            };

            channel.onmessage = (msgEvent) => {
                serverDcMsgCount++;
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
                    if (serverDcMsgCount <= 3) {
                        console.warn(`Server data channel parse error (msg #${serverDcMsgCount})`);
                    }
                }
            };
        };

        // Handle ICE candidates
        this.pc.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('Sending ICE candidate');
                this.sendMessage({
                    type: 'candidate',
                    candidate: event.candidate.toJSON()
                });
            }
        };

        // Handle connection state
        this.pc.onconnectionstatechange = () => {
            console.log('Connection state:', this.pc.connectionState);
            console.log('Data channel state at connection change:', this.dataChannel.readyState);
            
            if (this.pc.connectionState === 'connected') {
                console.log('Peer connection connected - checking data channel...');
                setTimeout(() => {
                    console.log('Data channel state 1s after connected:', this.dataChannel.readyState);
                    if (this.dataChannel.readyState === 'open') {
                        console.log('Data channel confirmed OPEN - ready to receive metrics');
                    }
                }, 1000);
            }
            
            if (this.onConnectionStateChange) {
                this.onConnectionStateChange(this.pc.connectionState);
            }
        };

        this.pc.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', this.pc.iceConnectionState);
        };

        this.pc.onicegatheringstatechange = () => {
            console.log('ICE gathering state:', this.pc.iceGatheringState);
        };

        // Join as viewer
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
        
        // Low latency video element hints
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
                
                // ==================== PROPER RENDER LATENCY ====================
                // Use processingDuration if available (Chrome 89+)
                // This is the actual time spent decoding + rendering the frame
                if (metadata.processingDuration !== undefined) {
                    const processingMs = metadata.processingDuration * 1000;
                    processingDurationSamples.push(processingMs);
                    if (processingDurationSamples.length > 30) {
                        processingDurationSamples.shift();
                    }
                    // Use median for stability
                    const sorted = [...processingDurationSamples].sort((a, b) => a - b);
                    metrics.renderLatency = sorted[Math.floor(sorted.length / 2)];
                }
                
                // Frame interval (for FPS calculation)
                if (lastPresentationTime > 0 && metadata.presentationTime) {
                    metrics.frameInterval = (metadata.presentationTime - lastPresentationTime) * 1000;
                }
                if (metadata.presentationTime) {
                    lastPresentationTime = metadata.presentationTime;
                }
                
                // Expected vs actual display time (compositor delay)
                if (metadata.expectedDisplayTime && metadata.presentationTime) {
                    metrics.compositorDelay = (metadata.presentationTime - metadata.expectedDisplayTime) * 1000;
                }
            } else {
                // Fallback: use frame interval as rough estimate
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
            console.log(' requestVideoFrameCallback enabled for', trackId);
        } else {
            console.warn(' requestVideoFrameCallback not supported - render latency will be estimated');
        }

        this.videoElements.set(trackId, video);
        
        // Start jitter buffer monitoring
        this.startJitterBufferMonitoring(trackId);
    }
    
    // Monitor jitter buffer stats periodically
    startJitterBufferMonitoring(trackId) {
        if (this._jitterMonitorInterval) return; // Already monitoring
        
        this._jitterMonitorInterval = setInterval(async () => {
            if (!this.pc) return;
            
            try {
                const stats = await this.pc.getStats();
                
                stats.forEach(report => {
                    if (report.type === 'inbound-rtp' && report.kind === 'video') {
                        const metrics = this.metrics.get(trackId) || {};
                        
                        // Jitter buffer delay
                        if (report.jitterBufferDelay && report.jitterBufferEmittedCount) {
                            metrics.jitterBufferDelay = (report.jitterBufferDelay / report.jitterBufferEmittedCount) * 1000;
                        }
                        
                        // Decode time per frame
                        if (report.totalDecodeTime && report.framesDecoded) {
                            metrics.decodeTime = (report.totalDecodeTime / report.framesDecoded) * 1000;
                        }
                        
                        // Frames dropped
                        metrics.framesDropped = report.framesDropped || 0;
                        metrics.framesDecoded = report.framesDecoded || 0;
                        
                        // Jitter
                        if (report.jitter !== undefined) {
                            metrics.jitter = report.jitter * 1000;
                        }
                        
                        this.metrics.set(trackId, metrics);
                        
                        // Log occasionally
                        if (this._jitterLogCount === undefined) this._jitterLogCount = 0;
                        this._jitterLogCount++;
                        if (this._jitterLogCount <= 3 || this._jitterLogCount % 30 === 0) {
                            console.log(`Render Pipeline Stats:`);
                            console.log(`Jitter Buffer: ${metrics.jitterBufferDelay?.toFixed(1) || '?'}ms`);
                            console.log(`Decode Time: ${metrics.decodeTime?.toFixed(1) || '?'}ms`);
                            console.log(`Render (processing): ${metrics.renderLatency?.toFixed(1) || '?'}ms`);
                            console.log(`Frames: ${metrics.framesDecoded} decoded, ${metrics.framesDropped} dropped`);
                        }
                    }
                });
            } catch (e) {
                // Ignore stats errors
            }
        }, 1000);
    }

    handleMetrics(metricsData, timestamp) {
        if (!this._metricsLogCount) this._metricsLogCount = 0;
        this._metricsLogCount++;
        const shouldLog = this._metricsLogCount <= 5 || this._metricsLogCount % 30 === 0;
        
        const receiveTime = Date.now();
        const serverTimeMs = timestamp * 1000;
        
        // Raw latency = client_receive_time - server_send_time (no correction)
        const rawLatency = receiveTime - serverTimeMs;
        
        let networkTime;
        let latencyMethod;
        
        // ============================================================
        // TWO-STAGE CLOCK SYNCHRONIZATION
        // ============================================================
        // 
        // PROBLEM:
        //   - Ping/pong measures: Go relay ↔ Browser offset (~525ms)
        //   - Metrics timestamp from: Python sender (~67 seconds different!)
        //   - These are DIFFERENT clock offsets!
        //
        // SOLUTION:
        //   1. Detect large raw latency (> 1000ms) → Python clock skew exists
        //   2. Calculate Python↔Browser offset from raw latency
        //   3. Use Python offset for metrics compensation
        //
        // CALIBRATION:
        //   If raw_latency >> expected (e.g., 67000ms vs ~50ms expected)
        //   Then: python_offset ≈ raw_latency - (RTT/2)
        //   So:   compensated = raw_latency - python_offset ≈ RTT/2
        // ============================================================
        
        const SKEW_THRESHOLD = 1000; // 1 second - anything above this is clock skew
        const hasLargeSkew = Math.abs(rawLatency) > SKEW_THRESHOLD;
        
        if (hasLargeSkew) {
            // =========================================================
            // LARGE CLOCK SKEW DETECTED - Need Python↔Browser offset
            // =========================================================
            
            // Collect raw latency samples for calibration
            this.rawLatencySamples.push(rawLatency);
            if (this.rawLatencySamples.length > 10) {
                this.rawLatencySamples.shift();
            }
            
            // Calibrate Python offset after collecting a few samples
            if (this.rawLatencySamples.length >= 3 && !this.pythonOffsetCalibrated) {
                // Use median raw latency for stability
                const sorted = [...this.rawLatencySamples].sort((a, b) => a - b);
                const medianRaw = sorted[Math.floor(sorted.length / 2)];
                
                // Estimate actual network latency as RTT/2 (or default 25ms)
                const estimatedNetworkLatency = this.rttSamples.length > 0
                    ? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length / 2
                    : 25;
                
                // Calculate Python→Browser offset
                // raw_latency = actual_latency + offset
                // offset = raw_latency - actual_latency
                this.pythonBrowserOffset = medianRaw - estimatedNetworkLatency;
                this.pythonOffsetCalibrated = true;
                
                console.log(` Python↔Browser clock skew detected and calibrated:`);
                console.log(` Median raw latency: ${medianRaw.toFixed(1)}ms`);
                console.log(` Estimated network: ${estimatedNetworkLatency.toFixed(1)}ms`);
                console.log(` Python offset: ${this.pythonBrowserOffset.toFixed(1)}ms (${(this.pythonBrowserOffset/1000).toFixed(1)}s)`);
            }
            
            // Apply Python offset if calibrated
            if (this.pythonOffsetCalibrated) {
                const compensatedLatency = rawLatency - this.pythonBrowserOffset;
                
                if (shouldLog) {
                    console.log(` Two-Stage Compensation (Python→Browser):`);
                    console.log(` Raw latency: ${rawLatency.toFixed(1)}ms`);
                    console.log(` Python offset: ${this.pythonBrowserOffset.toFixed(1)}ms`);
                    console.log(` Compensated: ${compensatedLatency.toFixed(1)}ms`);
                }
                
                if (compensatedLatency >= 0 && compensatedLatency < 5000) {
                    networkTime = compensatedLatency;
                    latencyMethod = 'python-synced';
                } else if (compensatedLatency < 0) {
                    // Recalibrate - offset may have drifted
                    this.pythonOffsetCalibrated = false;
                    this.rawLatencySamples = [];
                    const avgRtt = this.rttSamples.length > 0 
                        ? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length 
                        : 20;
                    networkTime = avgRtt / 2;
                    latencyMethod = 'recalibrating';
                    console.warn(`Python offset needs recalibration (got ${compensatedLatency.toFixed(1)}ms)`);
                } else {
                    // Still too high after compensation - recalibrate
                    this.pythonOffsetCalibrated = false;
                    this.rawLatencySamples = [];
                    const avgRtt = this.rttSamples.length > 0 
                        ? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length 
                        : 20;
                    networkTime = avgRtt / 2;
                    latencyMethod = 'recalibrating';
                    console.warn(`Compensated still high (${compensatedLatency.toFixed(1)}ms) - recalibrating`);
                }
            } else {
                // Still calibrating - use RTT estimate
                const avgRtt = this.rttSamples.length > 0 
                    ? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length 
                    : 20;
                networkTime = avgRtt / 2;
                latencyMethod = 'calibrating';
                
                if (shouldLog) {
                    console.log(`Calibrating Python offset... (${this.rawLatencySamples.length}/3 samples)`);
                }
            }
        } else {
            // =========================================================
            // SMALL/NO CLOCK SKEW - Use simple compensation or raw
            // =========================================================
            
            // Reset Python calibration if we're suddenly seeing normal latencies
            if (this.pythonOffsetCalibrated && Math.abs(rawLatency) < 500) {
                console.log(`Clocks appear synced now - resetting Python offset`);
                this.pythonOffsetCalibrated = false;
                this.pythonBrowserOffset = 0;
                this.rawLatencySamples = [];
            }
            
            if (this.clockSynced) {
                // Use Go↔Browser offset for small adjustments
                const compensatedLatency = rawLatency + this.clockOffset;
                
                if (shouldLog) {
                    console.log(`Standard Compensation (Go↔Browser):`);
                    console.log(`Raw: ${rawLatency.toFixed(1)}ms, Offset: ${this.clockOffset.toFixed(1)}ms`);
                    console.log(`Compensated: ${compensatedLatency.toFixed(1)}ms`);
                }
                
                if (compensatedLatency >= 0 && compensatedLatency < 1000) {
                    networkTime = compensatedLatency;
                    latencyMethod = 'synced';
                } else {
                    // Compensation made it worse - just use raw
                    networkTime = Math.max(0, rawLatency);
                    latencyMethod = 'raw';
                }
            } else {
                // No sync yet - use raw if reasonable
                networkTime = Math.max(0, rawLatency);
                latencyMethod = 'raw';
                
                if (shouldLog) {
                    console.log(`Using raw latency: ${networkTime.toFixed(1)}ms`);
                }
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

            combined.totalLatency = 
                combined.rosLatency + 
                combined.encodingLatency + 
                combined.networkLatency + 
                (combined.renderLatency || 0);

            if (shouldLog) {
                console.log(`${trackId}: total=${combined.totalLatency.toFixed(1)}ms, network=${combined.networkLatency.toFixed(1)}ms (${latencyMethod})`);
            }
            this.metrics.set(trackId, combined);
        }

        if (this.onMetricsUpdate) {
            this.onMetricsUpdate(this.metrics);
        }
    }

    async handleSignalingMessage(msg) {
        console.log('Received message:', msg.type);
        
        // Handle pong for clock synchronization
        if (msg.type === 'pong') {
            this.handlePong(msg);
            return;
        }
        
        // Handle metrics directly via WebSocket
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
                console.log('Available streams:', msg.streams);
                
                const streamCount = msg.streams ? msg.streams.length : 1;
                console.log(`Adding ${streamCount} video transceiver(s) for streams`);
                for (let i = 0; i < Math.max(1, streamCount); i++) {
                    this.pc.addTransceiver('video', { direction: 'recvonly' });
                }
                
                const offer = await this.pc.createOffer();
                
                if (offer.sdp.includes('m=application')) {
                    console.log('Offer includes data channel (m=application)');
                }
                
                await this.pc.setLocalDescription(offer);
                
                console.log('Sending offer');
                this.sendMessage({
                    type: 'offer',
                    sdp: {
                        type: this.pc.localDescription.type,
                        sdp: this.pc.localDescription.sdp
                    }
                });
                break;

            case 'answer':
                console.log('Received answer');
                try {
                    let answerSdp;
                    if (msg.sdp && typeof msg.sdp === 'object') {
                        answerSdp = msg.sdp.sdp || msg.sdp;
                    } else {
                        answerSdp = msg.sdp;
                    }
                    
                    if (answerSdp && answerSdp.includes('m=application')) {
                        console.log('Answer includes data channel (m=application)');
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
                    console.log('Received ICE candidate');
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

            default:
                console.warn('Unknown message type:', msg.type);
        }
    }

    sendMessage(msg) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        } else {
            console.error('WebSocket not ready');
        }
    }

    getStream(trackId) {
        return this.streams.get(trackId);
    }

    getMetrics(trackId) {
        return this.metrics.get(trackId);
    }

    getAllStreams() {
        return Array.from(this.streams.keys());
    }

    getAllMetrics() {
        return this.metrics;
    }

    cleanup() {
        console.log('Cleaning up...');
        
        this.stopClockSync();
        
        // Stop jitter buffer monitoring
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
        
        // Reset clock sync state
        this.clockSyncSamples = [];
        this.rttSamples = [];
        this.clockOffset = 0;
        this.clockSynced = false;
        this.lastSyncTime = null;
        
        // Reset Python offset state
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