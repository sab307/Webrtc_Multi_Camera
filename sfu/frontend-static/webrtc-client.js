// WebRTC Client for ROS2 Streaming
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
        
        // Callbacks
        this.onStreamAdded = null;
        this.onStreamRemoved = null;
        this.onMetricsUpdate = null;
        this.onConnectionStateChange = null;
    }

    async connect() {
        return new Promise((resolve, reject) => {
            console.log('Connecting to signaling server:', this.signalingUrl);
            
            this.ws = new WebSocket(this.signalingUrl);

            this.ws.onopen = () => {
                console.log('WebSocket connected');
                this.setupWebRTC();
                resolve();
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                reject(error);
            };

            this.ws.onclose = () => {
                console.log('🔌 WebSocket disconnected');
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
        // Note: We create it BEFORE any handlers to ensure we don't miss events
        const dcOptions = { 
            ordered: false,
            maxRetransmits: 0  // Unreliable for low latency
        };
        this.dataChannel = this.pc.createDataChannel('metrics', dcOptions);
        console.log('Created data channel, initial state:', this.dataChannel.readyState);
        
        // Set up data channel handlers immediately
        const setupDataChannelHandlers = (dc, label) => {
            console.log(`Setting up handlers for data channel: ${label}, state: ${dc.readyState}`);
            
            // If already open, fire our handler
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
            
            // Track message count to reduce log spam
            let dcMsgCount = 0;
            
            dc.onmessage = (event) => {
                dcMsgCount++;
                try {
                    // Handle both string and binary data
                    let jsonStr;
                    if (typeof event.data === 'string') {
                        jsonStr = event.data;
                    } else if (event.data instanceof ArrayBuffer) {
                        jsonStr = new TextDecoder().decode(event.data);
                    } else if (event.data instanceof Blob) {
                        // Blob needs async handling - skip for now, WebSocket works
                        return;
                    } else {
                        return;
                    }
                    
                    const data = JSON.parse(jsonStr);
                    if (data.type === 'metrics') {
                        this.handleMetrics(data.data, data.timestamp);
                    }
                } catch (error) {
                    // Only log first few errors
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
            
            // Get the track name from the stream ID
            // Server sends stream ID as "stream_<trackName>"
            let trackId = event.track.id;
            
            if (event.streams && event.streams.length > 0) {
                const streamId = event.streams[0].id;
                console.log('   Stream ID:', streamId);
                
                // Extract track name from stream ID (format: "stream_trackName")
                if (streamId && streamId.startsWith('stream_')) {
                    trackId = streamId.replace('stream_', '');
                    console.log('   Extracted track name:', trackId);
                }
            }
            
            const stream = event.streams[0];
            if (stream) {
                console.log('🎬 Adding stream for track:', trackId);
                this.streams.set(trackId, stream);
                
                // Initialize metrics for this track
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

                // Setup frame callback for metrics
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
                // Data channel should be open once peer connection is connected
                setTimeout(() => {
                    console.log('Data channel state 1s after connected:', this.dataChannel.readyState);
                    if (this.dataChannel.readyState === 'open') {
                        console.log('Data channel confirmed OPEN - ready to receive metrics');
                    } else {
                        console.error('Data channel still not open after 1s:', this.dataChannel.readyState);
                    }
                }, 1000);
                
                // Also check every second for 10 seconds
                let checkCount = 0;
                const interval = setInterval(() => {
                    checkCount++;
                    console.log(`Data channel check #${checkCount}:`, this.dataChannel.readyState, 
                        'bufferedAmount:', this.dataChannel.bufferedAmount);
                    if (this.dataChannel.readyState === 'open' || checkCount >= 10) {
                        clearInterval(interval);
                    }
                }, 1000);
            }
            
            if (this.onConnectionStateChange) {
                this.onConnectionStateChange(this.pc.connectionState);
            }
        };

        this.pc.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', this.pc.iceConnectionState);
            console.log('Data channel state at ICE change:', this.dataChannel.readyState);
        };

        this.pc.onicegatheringstatechange = () => {
            console.log('ICE gathering state:', this.pc.iceGatheringState);
        };
        
        // Monitor SCTP transport state if available
        if (this.pc.sctp) {
            console.log('SCTP transport available:', this.pc.sctp.state);
            this.pc.sctp.onstatechange = () => {
                console.log('SCTP transport state:', this.pc.sctp.state);
            };
        } else {
            console.log('SCTP transport not yet available');
            // Check periodically
            const checkSctp = setInterval(() => {
                if (this.pc.sctp) {
                    console.log('SCTP transport now available:', this.pc.sctp.state);
                    this.pc.sctp.onstatechange = () => {
                        console.log('SCTP transport state changed:', this.pc.sctp.state);
                    };
                    clearInterval(checkSctp);
                }
            }, 500);
            setTimeout(() => clearInterval(checkSctp), 10000);
        }

        // Join as viewer
        this.sendMessage({
            type: 'join',
            role: 'viewer'
        });
        
        // IMPORTANT: Start polling for data channel state
        // This catches cases where callbacks might not fire
        let pollCount = 0;
        const pollInterval = setInterval(() => {
            pollCount++;
            const dcState = this.dataChannel ? this.dataChannel.readyState : 'no channel';
            const pcState = this.pc ? this.pc.connectionState : 'no pc';
            const iceState = this.pc ? this.pc.iceConnectionState : 'no pc';
            
            // Only log first 5 polls
            if (pollCount <= 5) {
                console.log(`Poll #${pollCount}: DC=${dcState}, PC=${pcState}, ICE=${iceState}`);
            }
            
            if (dcState === 'open' && pollCount <= 5) {
                console.log('Data channel is OPEN! (detected via polling)');
            }
            
            if (pollCount >= 5 || dcState === 'open') {
                clearInterval(pollInterval);
            }
        }, 1000);
    }

    setupFrameCallback(trackId, stream) {
        // Create a hidden video element for frame callbacks
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        video.autoplay = true;
        
        // Need to play to trigger frame callbacks
        video.play().catch(e => {
            console.warn('Video play error (hidden element):', e.message);
        });

        let lastFrameTime = performance.now();
        let frameCount = 0;

        const callback = (now, metadata) => {
            frameCount++;
            const timeSinceLastFrame = now - lastFrameTime;
            lastFrameTime = now;

            // Update metrics
            const metrics = this.metrics.get(trackId) || {};
            metrics.renderLatency = timeSinceLastFrame;
            metrics.frameCount = frameCount;
            
            if (metadata) {
                metrics.presentedFrames = metadata.presentedFrames;
                metrics.width = metadata.width;
                metrics.height = metadata.height;
            }

            this.metrics.set(trackId, metrics);

            // Continue requesting frames
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
        // Only log first 3 metrics messages
        if (!this._metricsLogCount) this._metricsLogCount = 0;
        this._metricsLogCount++;
        const shouldLog = this._metricsLogCount <= 3;
        
        if (shouldLog) {
            console.log('handleMetrics called:', { metricsData, timestamp });
        }
        
        const networkTime = Date.now() - (timestamp * 1000);

        for (const [trackId, trackMetrics] of Object.entries(metricsData)) {
            const existing = this.metrics.get(trackId) || {};
            
            const combined = {
                ...existing,
                rosLatency: trackMetrics.ros_latency || 0,
                encodingLatency: trackMetrics.encoding_latency || 0,
                networkLatency: Math.max(0, networkTime),
                processingLatency: (trackMetrics.ros_latency || 0) + (trackMetrics.encoding_latency || 0),
                timestamp: Date.now()
            };

            // Calculate total latency
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
        
        // Handle metrics directly via WebSocket (in addition to data channel)
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
                
                // Check data channel state before offer
                console.log('Data channel state before offer:', this.dataChannel.readyState);
                
                // Add one transceiver for EACH available stream
                const streamCount = msg.streams ? msg.streams.length : 1;
                console.log(`📹 Adding ${streamCount} video transceiver(s) for streams`);
                for (let i = 0; i < Math.max(1, streamCount); i++) {
                    this.pc.addTransceiver('video', { direction: 'recvonly' });
                    console.log(`   Added transceiver ${i + 1}/${streamCount}`);
                }
                
                // Create offer
                const offer = await this.pc.createOffer();
                
                // Log if offer contains data channel (m=application)
                if (offer.sdp.includes('m=application')) {
                    console.log('Offer includes data channel (m=application)');
                } else {
                    console.warn('Offer does NOT include data channel!');
                }
                
                // Count m=video lines in offer
                const videoLines = (offer.sdp.match(/m=video/g) || []).length;
                console.log(`📹 Offer contains ${videoLines} video section(s)`);
                
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
                    // Handle both formats: {type, sdp} object or just the SDP string
                    let answerSdp;
                    if (msg.sdp && typeof msg.sdp === 'object') {
                        answerSdp = msg.sdp.sdp || msg.sdp;
                    } else {
                        answerSdp = msg.sdp;
                    }
                    
                    // Log if answer contains data channel
                    if (answerSdp && answerSdp.includes('m=application')) {
                        console.log('Answer includes data channel (m=application)');
                    } else {
                        console.warn('Answer does NOT include data channel!');
                    }
                    
                    const answer = new RTCSessionDescription({
                        type: 'answer',
                        sdp: answerSdp
                    });
                    await this.pc.setRemoteDescription(answer);
                    console.log('Set remote description');
                    console.log('Data channel state after answer:', this.dataChannel.readyState);
                    
                    // Monitor data channel state changes
                    const checkDataChannel = () => {
                        console.log('Data channel state check:', this.dataChannel.readyState);
                        if (this.dataChannel.readyState === 'open') {
                            console.log('Data channel is now OPEN!');
                        } else if (this.dataChannel.readyState !== 'closed') {
                            setTimeout(checkDataChannel, 500);
                        }
                    };
                    setTimeout(checkDataChannel, 500);
                    
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
        
        this.videoElements.forEach(video => {
            video.srcObject = null;
        });
        this.videoElements.clear();
    }

    disconnect() {
        this.cleanup();
    }
}