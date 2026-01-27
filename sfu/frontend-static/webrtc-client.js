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
        this.clockOffset = 0;           // Server time - Client time (ms)
        this.clockSynced = false;
        this.lastSyncTime = null;
        
        // Adaptive clock skew detection threshold
        this.CLOCK_SKEW_THRESHOLD = 1000; // ms - if raw latency > this, apply compensation
        
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
                console.log(` Clock Sync #${this.clockSyncSamples.length} [${syncQuality}]:`);
                console.log(` ├─ Offset: ${this.clockOffset.toFixed(2)}ms (${syncStats.offsetDirection})`);
                console.log(` ├─ RTT: ${rtt.toFixed(2)}ms (avg of best: ${avgRtt.toFixed(2)}ms)`);
                console.log(` ├─ Using ${bestSamples.length}/${this.clockSyncSamples.length} best samples`);
                console.log(` └─ Std Dev: ${stdDev.toFixed(2)}ms`);
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
        if (!this.clockSynced) {
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
            
        return {
            offset: this.clockOffset,
            offsetDirection: this.clockOffset > 0 ? 'Server ahead' : 'Client ahead',
            avgRtt: avgRtt,
            minRtt: this.rttSamples.length > 0 ? Math.min(...this.rttSamples) : 0,
            maxRtt: this.rttSamples.length > 0 ? Math.max(...this.rttSamples) : 0,
            jitter: this.rttSamples.length > 0 ? Math.max(...this.rttSamples) - Math.min(...this.rttSamples) : 0,
            stdDev: Math.sqrt(variance),
            samples: this.clockSyncSamples.length,
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
        
        const receiveTime = Date.now();
        const serverTimeMs = timestamp * 1000;
        
        // ============================================================
        // ADAPTIVE CLOCK SKEW DETECTION
        // ============================================================
        // Calculate raw latency (no compensation)
        const rawLatency = receiveTime - serverTimeMs;
        
        // Detect if clocks are significantly out of sync
        // - If |rawLatency| > threshold: Clocks are skewed, apply compensation
        // - If |rawLatency| < threshold: Clocks are synced, use raw value
        const hasClockSkew = Math.abs(rawLatency) > this.CLOCK_SKEW_THRESHOLD;
        
        let networkTime;
        let latencyMethod;
        
        if (hasClockSkew && this.clockSynced) {
            // =========================================================
            // SCENARIO 1: Clock skew detected - apply compensation
            // =========================================================
            const clientEquivalent = this.serverToClientTime(serverTimeMs);
            networkTime = receiveTime - clientEquivalent;
            latencyMethod = 'compensated';
            
            if (shouldLog || this._metricsLogCount % 60 === 0) {
                console.log(`Clock skew detected! Raw=${rawLatency.toFixed(0)}ms`);
                console.log(`Offset: ${this.clockOffset.toFixed(2)}ms`);
                console.log(`Compensated latency: ${networkTime.toFixed(1)}ms`);
            }
        } else if (!hasClockSkew) {
            // =========================================================
            // SCENARIO 2: Clocks synced - use raw latency
            // =========================================================
            networkTime = rawLatency;
            latencyMethod = 'raw';
            
            if (shouldLog || this._metricsLogCount % 60 === 0) {
                console.log(`Clocks synced! Latency=${networkTime.toFixed(1)}ms (no compensation needed)`);
            }
        } else {
            // =========================================================
            // SCENARIO 3: Clock skew but not yet synced - estimate
            // =========================================================
            const avgRtt = this.rttSamples.length > 0 
                ? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length 
                : 20; // Default estimate
            networkTime = avgRtt / 2;
            latencyMethod = 'rtt-estimate';
            
            if (shouldLog) {
                console.log(`Clock skew detected but sync incomplete - using RTT/2 estimate: ${networkTime.toFixed(1)}ms`);
            }
        }
        
        // ============================================================
        // SANITY CHECKS
        // ============================================================
        
        // Reject negative latency
        if (networkTime < 0) {
            if (shouldLog) {
                console.warn(`Negative latency: ${networkTime.toFixed(1)}ms - using RTT/2 estimate`);
            }
            const avgRtt = this.rttSamples.length > 0 
                ? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length 
                : 20;
            networkTime = avgRtt / 2;
            latencyMethod = 'rtt-fallback';
        }
        
        // Cap extremely high latency
        const MAX_REASONABLE_LATENCY = 5000; // 5 seconds
        if (networkTime > MAX_REASONABLE_LATENCY) {
            if (shouldLog) {
                console.warn(`Latency too high: ${networkTime.toFixed(1)}ms - capping at ${MAX_REASONABLE_LATENCY}ms`);
            }
            networkTime = MAX_REASONABLE_LATENCY;
            latencyMethod = 'capped';
        }

        // ============================================================
        // UPDATE METRICS
        // ============================================================
        for (const [trackId, trackMetrics] of Object.entries(metricsData)) {
            const existing = this.metrics.get(trackId) || {};
            
            const combined = {
                ...existing,
                rosLatency: trackMetrics.ros_latency || 0,
                encodingLatency: trackMetrics.encoding_latency || 0,
                networkLatency: Math.max(0, networkTime),
                processingLatency: (trackMetrics.ros_latency || 0) + (trackMetrics.encoding_latency || 0),
                timestamp: Date.now(),
                clockSynced: this.clockSynced,
                latencyMethod: latencyMethod,
                rawLatency: rawLatency,
                hasClockSkew: hasClockSkew
            };

            combined.totalLatency = 
                combined.rosLatency + 
                combined.encodingLatency + 
                combined.networkLatency + 
                (combined.renderLatency || 0);

            if (shouldLog) {
                console.log(`Metrics for ${trackId}: total=${combined.totalLatency.toFixed(1)}ms (method: ${latencyMethod})`);
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
        
        // Reset clock sync state
        this.clockSyncSamples = [];
        this.rttSamples = [];
        this.clockOffset = 0;
        this.clockSynced = false;
        this.lastSyncTime = null;
        
        this.videoElements.forEach(video => {
            video.srcObject = null;
        });
        this.videoElements.clear();
    }

    disconnect() {
        this.cleanup();
    }
}