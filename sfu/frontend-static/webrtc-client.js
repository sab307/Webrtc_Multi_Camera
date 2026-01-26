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
        this.clockOffset = 0;           // Server time - Client time (ms)
        this.clockOffsetSamples = [];   // History of offset measurements
        this.rttSamples = [];           // History of RTT measurements
        this.pendingPings = new Map();  // pingId -> {sendTime}
        this.clockSyncInterval = null;
        this.clockSynced = false;
        this.lastSyncTime = null;
        
        // Callbacks
        this.onStreamAdded = null;
        this.onStreamRemoved = null;
        this.onMetricsUpdate = null;
        this.onConnectionStateChange = null;
        this.onClockSync = null;        // New callback for clock sync updates
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
        const t3 = msg.server_send;      // Server send time (often same as t2)
        // t4 = client receive time (already set above)
        
        // NTP-style calculation:
        // RTT = (t4 - t1) - (t3 - t2)  [total round trip minus server processing]
        // Offset = ((t2 - t1) + (t3 - t4)) / 2
        
        const serverProcessing = t3 - t2;
        const rtt = (t4 - t1) - serverProcessing;
        const offset = ((t2 - t1) + (t3 - t4)) / 2;
        
        // Store samples (keep last 10 for median calculation)
        this.rttSamples.push(rtt);
        this.clockOffsetSamples.push(offset);
        
        if (this.rttSamples.length > 10) {
            this.rttSamples.shift();
        }
        if (this.clockOffsetSamples.length > 10) {
            this.clockOffsetSamples.shift();
        }
        
        // Calculate median offset (more robust than mean against outliers)
        const sortedOffsets = [...this.clockOffsetSamples].sort((a, b) => a - b);
        const medianOffset = sortedOffsets[Math.floor(sortedOffsets.length / 2)];
        
        // Calculate RTT stats
        const avgRtt = this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length;
        const minRtt = Math.min(...this.rttSamples);
        const maxRtt = Math.max(...this.rttSamples);
        
        // Standard deviation of offset
        const avgOffset = this.clockOffsetSamples.reduce((a, b) => a + b, 0) / this.clockOffsetSamples.length;
        const variance = this.clockOffsetSamples.reduce((sum, val) => sum + Math.pow(val - avgOffset, 2), 0) / this.clockOffsetSamples.length;
        const stdDev = Math.sqrt(variance);
        
        // Update the clock offset (use median for robustness)
        this.clockOffset = medianOffset;
        this.clockSynced = true;
        this.lastSyncTime = Date.now();
        
        const syncStats = {
            offset: this.clockOffset,
            offsetDirection: this.clockOffset > 0 ? 'Server ahead' : 'Client ahead',
            rtt: rtt,
            avgRtt: avgRtt,
            minRtt: minRtt,
            maxRtt: maxRtt,
            jitter: maxRtt - minRtt,
            stdDev: stdDev,
            samples: this.clockOffsetSamples.length,
            serverTime: t2,
            clientTime: t1,
            t1: t1,
            t2: t2,
            t3: t3,
            t4: t4
        };
        
        // Log sync details (first 5 samples, then every 5th)
        if (this.clockOffsetSamples.length <= 5 || this.clockOffsetSamples.length % 5 === 0) {
            console.log(`Clock Sync #${this.clockOffsetSamples.length}:`);
            console.log(`├─ Clock Offset: ${this.clockOffset.toFixed(2)}ms (${syncStats.offsetDirection})`);
            console.log(`├─ RTT: ${rtt.toFixed(2)}ms (avg: ${avgRtt.toFixed(2)}ms)`);
            console.log(`├─ Jitter: ${syncStats.jitter.toFixed(2)}ms`);
            console.log(`└─ Std Dev: ${stdDev.toFixed(2)}ms`);
        }
        
        // Callback for UI updates
        if (this.onClockSync) {
            this.onClockSync(syncStats);
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
        if (!this.clockSynced) {
            return null;
        }
        
        const avgRtt = this.rttSamples.length > 0 
            ? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length 
            : 0;
        
        const avgOffset = this.clockOffsetSamples.reduce((a, b) => a + b, 0) / this.clockOffsetSamples.length;
        const variance = this.clockOffsetSamples.reduce((sum, val) => sum + Math.pow(val - avgOffset, 2), 0) / this.clockOffsetSamples.length;
            
        return {
            offset: this.clockOffset,
            offsetDirection: this.clockOffset > 0 ? 'Server ahead' : 'Client ahead',
            avgRtt: avgRtt,
            minRtt: this.rttSamples.length > 0 ? Math.min(...this.rttSamples) : 0,
            maxRtt: this.rttSamples.length > 0 ? Math.max(...this.rttSamples) : 0,
            jitter: this.rttSamples.length > 0 ? Math.max(...this.rttSamples) - Math.min(...this.rttSamples) : 0,
            stdDev: Math.sqrt(variance),
            samples: this.clockOffsetSamples.length,
            synced: this.clockSynced,
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
        console.log('Setting up WebRTC...');

        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
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
                console.log('Adding stream for track:', trackId);
                this.streams.set(trackId, stream);
                
                this.metrics.set(trackId, {
                    frameCount: 0,
                    totalLatency: 0,
                    rosLatency: 0,
                    processingLatency: 0,
                    networkLatency: 0,
                    renderLatency: 0
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
        
        video.play().catch(e => {
            console.warn('Video play error (hidden element):', e.message);
        });

        let lastFrameTime = performance.now();
        let frameCount = 0;

        const callback = (now, metadata) => {
            frameCount++;
            const timeSinceLastFrame = now - lastFrameTime;
            lastFrameTime = now;

            const metrics = this.metrics.get(trackId) || {};
            metrics.renderLatency = timeSinceLastFrame;
            metrics.frameCount = frameCount;
            
            if (metadata) {
                metrics.presentedFrames = metadata.presentedFrames;
                metrics.width = metadata.width;
                metrics.height = metadata.height;
            }

            this.metrics.set(trackId, metrics);

            if (video.requestVideoFrameCallback) {
                video.requestVideoFrameCallback(callback);
            }
        };

        if (video.requestVideoFrameCallback) {
            video.requestVideoFrameCallback(callback);
        }

        this.videoElements.set(trackId, video);
    }

    handleMetrics(metricsData, timestamp) {
        if (!this._metricsLogCount) this._metricsLogCount = 0;
        this._metricsLogCount++;
        const shouldLog = this._metricsLogCount <= 3;
        
        if (shouldLog) {
            console.log('handleMetrics called:', { metricsData, timestamp });
        }
        
        // Use synchronized clock for accurate network latency calculation
        let networkTime;
        if (this.clockSynced) {
            // Convert server timestamp to client time, then compare with now
            const serverTimeMs = timestamp * 1000;
            const clientEquivalent = this.serverToClientTime(serverTimeMs);
            networkTime = Date.now() - clientEquivalent;
            
            if (shouldLog) {
                console.log('Using synchronized clock for network latency:', networkTime.toFixed(2), 'ms');
            }
        } else {
            // Fallback: naive calculation (may be inaccurate if clocks differ)
            networkTime = Date.now() - (timestamp * 1000);
            if (shouldLog) {
                console.log('Clock not synced, using naive network latency:', networkTime.toFixed(2), 'ms');
            }
        }

        for (const [trackId, trackMetrics] of Object.entries(metricsData)) {
            const existing = this.metrics.get(trackId) || {};
            
            const combined = {
                ...existing,
                rosLatency: trackMetrics.ros_latency || 0,
                encodingLatency: trackMetrics.encoding_latency || 0,
                networkLatency: Math.max(0, networkTime),
                processingLatency: (trackMetrics.ros_latency || 0) + (trackMetrics.encoding_latency || 0),
                timestamp: Date.now(),
                clockSynced: this.clockSynced
            };

            combined.totalLatency = 
                combined.rosLatency + 
                combined.encodingLatency + 
                combined.networkLatency + 
                (combined.renderLatency || 0);

            if (shouldLog) {
                console.log('Metrics for', trackId, '- total:', combined.totalLatency.toFixed(1), 'ms');
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
            this.// WebRTC Client for ROS2 Streaming with Clock Synchronization
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
        this.clockOffset = 0;           // Server time - Client time (ms)
        this.clockOffsetSamples = [];   // History of offset measurements
        this.rttSamples = [];           // History of RTT measurements
        this.pendingPings = new Map();  // pingId -> {sendTime}
        this.clockSyncInterval = null;
        this.clockSynced = false;
        this.lastSyncTime = null;
        
        // Callbacks
        this.onStreamAdded = null;
        this.onStreamRemoved = null;
        this.onMetricsUpdate = null;
        this.onConnectionStateChange = null;
        this.onClockSync = null;        // New callback for clock sync updates
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
        const t3 = msg.server_send;      // Server send time (often same as t2)
        // t4 = client receive time (already set above)
        
        // NTP-style calculation:
        // RTT = (t4 - t1) - (t3 - t2)  [total round trip minus server processing]
        // Offset = ((t2 - t1) + (t3 - t4)) / 2
        
        const serverProcessing = t3 - t2;
        const rtt = (t4 - t1) - serverProcessing;
        const offset = ((t2 - t1) + (t3 - t4)) / 2;
        
        // ============================================================
        // OUTLIER FILTERING - Reject bad samples
        // ============================================================
        
        // Filter 1: Reject if RTT is unreasonably high (> 1000ms)
        // High RTT indicates network congestion - offset calculation unreliable
        const MAX_VALID_RTT = 1000; // ms
        if (rtt > MAX_VALID_RTT || rtt < 0) {
            console.warn(`Rejected sample: RTT ${rtt.toFixed(2)}ms out of range`);
            return;
        }
        
        // Filter 2: Reject if offset is wildly different from existing samples
        // Only apply after we have some baseline samples
        if (this.clockOffsetSamples.length >= 3) {
            const sortedExisting = [...this.clockOffsetSamples].sort((a, b) => a - b);
            const currentMedian = sortedExisting[Math.floor(sortedExisting.length / 2)];
            
            // Calculate IQR (Interquartile Range) for robust outlier detection
            const q1Index = Math.floor(sortedExisting.length * 0.25);
            const q3Index = Math.floor(sortedExisting.length * 0.75);
            const q1 = sortedExisting[q1Index];
            const q3 = sortedExisting[q3Index];
            const iqr = q3 - q1;
            
            // Use adaptive threshold: max of IQR-based or fixed minimum
            // This handles both stable and variable network conditions
            const minThreshold = 100; // Always allow at least 100ms deviation
            const iqrThreshold = Math.max(iqr * 3, minThreshold);
            
            // Also use absolute maximum deviation (e.g., 5000ms = 5 seconds)
            const maxDeviation = Math.min(iqrThreshold, 5000);
            
            const deviation = Math.abs(offset - currentMedian);
            if (deviation > maxDeviation) {
                console.warn(`Rejected outlier: offset ${offset.toFixed(2)}ms deviates ${deviation.toFixed(2)}ms from median ${currentMedian.toFixed(2)}ms (threshold: ${maxDeviation.toFixed(2)}ms)`);
                return;
            }
        }
        
        // Filter 3: Sanity check - offset shouldn't be more than a few seconds
        // unless clocks are REALLY misconfigured
        const MAX_REASONABLE_OFFSET = 10000; // 10 seconds
        if (Math.abs(offset) > MAX_REASONABLE_OFFSET && this.clockOffsetSamples.length === 0) {
            console.warn(`First sample has extreme offset: ${offset.toFixed(2)}ms - accepting but monitoring`);
            // Accept first sample even if extreme, but log warning
        } else if (Math.abs(offset) > MAX_REASONABLE_OFFSET) {
            console.warn(`Rejected sample: offset ${offset.toFixed(2)}ms exceeds reasonable range`);
            return;
        }
        
        // ============================================================
        // SAMPLE ACCEPTED - Store and calculate stats
        // ============================================================
        
        // Store samples (keep last 10 for median calculation)
        this.rttSamples.push(rtt);
        this.clockOffsetSamples.push(offset);
        
        if (this.rttSamples.length > 10) {
            this.rttSamples.shift();
        }
        if (this.clockOffsetSamples.length > 10) {
            this.clockOffsetSamples.shift();
        }
        
        // Calculate median offset (more robust than mean against outliers)
        const sortedOffsets = [...this.clockOffsetSamples].sort((a, b) => a - b);
        const medianOffset = sortedOffsets[Math.floor(sortedOffsets.length / 2)];
        
        // Calculate RTT stats
        const avgRtt = this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length;
        const minRtt = Math.min(...this.rttSamples);
        const maxRtt = Math.max(...this.rttSamples);
        
        // Standard deviation of offset (measure of sync stability)
        const avgOffset = this.clockOffsetSamples.reduce((a, b) => a + b, 0) / this.clockOffsetSamples.length;
        const variance = this.clockOffsetSamples.reduce((sum, val) => sum + Math.pow(val - avgOffset, 2), 0) / this.clockOffsetSamples.length;
        const stdDev = Math.sqrt(variance);
        
        // Update the clock offset (use median for robustness)
        this.clockOffset = medianOffset;
        this.clockSynced = true;
        this.lastSyncTime = Date.now();
        
        // Calculate sync quality rating
        let syncQuality = 'Excellent';
        if (stdDev > 50) syncQuality = 'Good';
        if (stdDev > 100) syncQuality = 'Fair';
        if (stdDev > 200) syncQuality = 'Poor';
        
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
            samples: this.clockOffsetSamples.length,
            acceptedSamples: this.clockOffsetSamples.length,
            serverTime: t2,
            clientTime: t1,
            t1: t1,
            t2: t2,
            t3: t3,
            t4: t4
        };
        
        // Log sync details (first 5 samples, then every 5th)
        if (this.clockOffsetSamples.length <= 5 || this.clockOffsetSamples.length % 5 === 0) {
            console.log(`Clock Sync #${this.clockOffsetSamples.length} [${syncQuality}]:`);
            console.log(`├─ Clock Offset: ${this.clockOffset.toFixed(2)}ms (${syncStats.offsetDirection})`);
            console.log(`├─ RTT: ${rtt.toFixed(2)}ms (avg: ${avgRtt.toFixed(2)}ms)`);
            console.log(`├─ Jitter: ${syncStats.jitter.toFixed(2)}ms`);
            console.log(`└─ Std Dev: ${stdDev.toFixed(2)}ms`);
        }
        
        // Callback for UI updates
        if (this.onClockSync) {
            this.onClockSync(syncStats);
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
        if (!this.clockSynced) {
            return null;
        }
        
        const avgRtt = this.rttSamples.length > 0 
            ? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length 
            : 0;
        
        const avgOffset = this.clockOffsetSamples.reduce((a, b) => a + b, 0) / this.clockOffsetSamples.length;
        const variance = this.clockOffsetSamples.reduce((sum, val) => sum + Math.pow(val - avgOffset, 2), 0) / this.clockOffsetSamples.length;
            
        return {
            offset: this.clockOffset,
            offsetDirection: this.clockOffset > 0 ? 'Server ahead' : 'Client ahead',
            avgRtt: avgRtt,
            minRtt: this.rttSamples.length > 0 ? Math.min(...this.rttSamples) : 0,
            maxRtt: this.rttSamples.length > 0 ? Math.max(...this.rttSamples) : 0,
            jitter: this.rttSamples.length > 0 ? Math.max(...this.rttSamples) - Math.min(...this.rttSamples) : 0,
            stdDev: Math.sqrt(variance),
            samples: this.clockOffsetSamples.length,
            synced: this.clockSynced,
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
                console.log('🔌 WebSocket disconnected');
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
        console.log('🎥 Setting up WebRTC...');

        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
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
                console.log('Adding stream for track:', trackId);
                this.streams.set(trackId, stream);
                
                this.metrics.set(trackId, {
                    frameCount: 0,
                    totalLatency: 0,
                    rosLatency: 0,
                    processingLatency: 0,
                    networkLatency: 0,
                    renderLatency: 0
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
        
        video.play().catch(e => {
            console.warn('Video play error (hidden element):', e.message);
        });

        let lastFrameTime = performance.now();
        let frameCount = 0;

        const callback = (now, metadata) => {
            frameCount++;
            const timeSinceLastFrame = now - lastFrameTime;
            lastFrameTime = now;

            const metrics = this.metrics.get(trackId) || {};
            metrics.renderLatency = timeSinceLastFrame;
            metrics.frameCount = frameCount;
            
            if (metadata) {
                metrics.presentedFrames = metadata.presentedFrames;
                metrics.width = metadata.width;
                metrics.height = metadata.height;
            }

            this.metrics.set(trackId, metrics);

            if (video.requestVideoFrameCallback) {
                video.requestVideoFrameCallback(callback);
            }
        };

        if (video.requestVideoFrameCallback) {
            video.requestVideoFrameCallback(callback);
        }

        this.videoElements.set(trackId, video);
    }

    handleMetrics(metricsData, timestamp) {
        if (!this._metricsLogCount) this._metricsLogCount = 0;
        this._metricsLogCount++;
        const shouldLog = this._metricsLogCount <= 3;
        
        if (shouldLog) {
            console.log('handleMetrics called:', { metricsData, timestamp });
        }
        
        // Calculate network latency using synchronized clock
        let networkTime;
        let latencyMethod = 'naive';
        
        if (this.clockSynced) {
            // Convert server timestamp to client time, then compare with now
            const serverTimeMs = timestamp * 1000;
            const clientEquivalent = this.serverToClientTime(serverTimeMs);
            networkTime = Date.now() - clientEquivalent;
            latencyMethod = 'synced';
            
            // ============================================================
            // SANITY CHECK: Reject unreasonable network latency values
            // ============================================================
            
            // If network latency is negative, something is wrong
            // This can happen if clock sync is off or timestamp is in the future
            if (networkTime < 0) {
                if (shouldLog) {
                    console.warn(`Negative network latency detected: ${networkTime.toFixed(2)}ms - using RTT/2 estimate`);
                }
                // Fall back to using half the average RTT as network estimate
                const avgRtt = this.rttSamples.length > 0 
                    ? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length 
                    : 10; // Default 10ms if no RTT samples
                networkTime = avgRtt / 2;
                latencyMethod = 'rtt-estimate';
            }
            
            // If network latency is unreasonably high (> 5 seconds), cap it
            // This prevents UI from showing crazy values
            const MAX_REASONABLE_NETWORK_LATENCY = 5000; // 5 seconds
            if (networkTime > MAX_REASONABLE_NETWORK_LATENCY) {
                if (shouldLog) {
                    console.warn(`Network latency too high: ${networkTime.toFixed(2)}ms - capping at ${MAX_REASONABLE_NETWORK_LATENCY}ms`);
                }
                networkTime = MAX_REASONABLE_NETWORK_LATENCY;
                latencyMethod = 'capped';
            }
            
            if (shouldLog) {
                console.log(`Network latency (${latencyMethod}): ${networkTime.toFixed(2)}ms`);
            }
        } else {
            // Fallback: naive calculation (may be inaccurate if clocks differ)
            networkTime = Date.now() - (timestamp * 1000);
            
            // Apply same sanity checks
            if (networkTime < 0) {
                networkTime = 10; // Default estimate
                latencyMethod = 'default';
            } else if (networkTime > 5000) {
                networkTime = 5000;
                latencyMethod = 'capped-naive';
            }
            
            if (shouldLog) {
                console.log(`Clock not synced, using ${latencyMethod} network latency: ${networkTime.toFixed(2)}ms`);
            }
        }

        for (const [trackId, trackMetrics] of Object.entries(metricsData)) {
            const existing = this.metrics.get(trackId) || {};
            
            const combined = {
                ...existing,
                rosLatency: trackMetrics.ros_latency || 0,
                encodingLatency: trackMetrics.encoding_latency || 0,
                networkLatency: Math.max(0, networkTime), // Ensure non-negative
                processingLatency: (trackMetrics.ros_latency || 0) + (trackMetrics.encoding_latency || 0),
                timestamp: Date.now(),
                clockSynced: this.clockSynced,
                latencyMethod: latencyMethod
            };

            combined.totalLatency = 
                combined.rosLatency + 
                combined.encodingLatency + 
                combined.networkLatency + 
                (combined.renderLatency || 0);

            if (shouldLog) {
                console.log('Metrics for', trackId, '- total:', combined.totalLatency.toFixed(1), 'ms');
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
                console.log(`📹 Adding ${streamCount} video transceiver(s) for streams`);
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
        console.log('🧹 Cleaning up...');
        
        this.stopClockSync();

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
        this.clockOffsetSamples = [];
        this.rttSamples = [];
        
        this.videoElements.forEach(video => {
            video.srcObject = null;
        });
        this.videoElements.clear();
    }

    disconnect() {
        this.cleanup();
    }
}_wsMetricsCount++;
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
                console.log(`📹 Adding ${streamCount} video transceiver(s) for streams`);
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
        this.clockOffsetSamples = [];
        this.rttSamples = [];
        
        this.videoElements.forEach(video => {
            video.srcObject = null;
        });
        this.videoElements.clear();
    }

    disconnect() {
        this.cleanup();
    }
}