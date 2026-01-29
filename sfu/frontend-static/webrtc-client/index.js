// index.js - Main WebRTCClient orchestrator

import { ClockSynchronizer } from './modules/clock_sync.js';
import { StreamManager } from './modules/stream_manager.js';
import { SignalingClient } from './modules/signaling.js';
import { WebRTCConnection } from './modules/connection.js';
import { MetricsProcessor } from './modules/metrics.js';

export class WebRTCClient {
  constructor(signalingUrl) {
    this.clockSync = new ClockSynchronizer();
    this.streamManager = new StreamManager();
    this.signaling = new SignalingClient(signalingUrl);
    this.connection = new WebRTCConnection();
    this.metrics = new MetricsProcessor(this.clockSync, this.streamManager);

    this.setupModuleCallbacks();

    // Public callbacks
    this.onStreamAdded = null;
    this.onStreamRemoved = null;
    this.onMetricsUpdate = null;
    this.onConnectionStateChange = null;
    this.onClockSync = null;
  }

  setupModuleCallbacks() {
    this.setupClockSyncCallbacks();
    this.setupStreamManagerCallbacks();
    this.setupMetricsCallbacks();
    this.setupConnectionCallbacks();
    this.setupSignalingCallbacks();
  }

  setupClockSyncCallbacks() {
    this.clockSync.onSync = (stats) => {
      if (this.onClockSync) {
        this.onClockSync(stats);
      }
    };
  }

  setupStreamManagerCallbacks() {
    this.streamManager.onStreamAdded = (trackId, stream) => {
      if (this.onStreamAdded) {
        this.onStreamAdded(trackId, stream);
      }
    };

    this.streamManager.onStreamRemoved = (trackId) => {
      if (this.onStreamRemoved) {
        this.onStreamRemoved(trackId);
      }
    };
  }

  setupMetricsCallbacks() {
    this.metrics.onUpdate = (metricsMap) => {
      if (this.onMetricsUpdate) {
        this.onMetricsUpdate(metricsMap);
      }
    };
  }

  setupConnectionCallbacks() {
    this.connection.onTrack = (event) => this.handleTrack(event);

    this.connection.onDataChannelMessage = (data) => {
      if (data.type === 'metrics') {
        this.metrics.process(data.data, data.timestamp);
      }
    };

    this.connection.onIceCandidate = (candidate) => {
      this.signaling.send({
        type: 'candidate',
        candidate: candidate.toJSON()
      });
    };

    this.connection.onConnectionStateChange = (state) => {
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(state);
      }
    };
  }

  setupSignalingCallbacks() {
    this.signaling.onClose = () => {
      this.clockSync.stop();
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange('disconnected');
      }
    };

    this.signaling.onMessage = (msg) => this.handleSignalingMessage(msg);
  }

  async connect() {
    await this.signaling.connect();
    this.connection.setup();
    this.clockSync.start((msg) => this.signaling.send(msg));
    this.signaling.send({ type: 'join', role: 'viewer' });
  }

  handleTrack(event) {
    const trackId = this.extractTrackId(event);
    const stream = event.streams[0];

    if (!stream) {
      console.warn('No stream in track event');
      return;
    }

    console.log('Adding stream for track:', trackId);
    this.streamManager.addStream(trackId, stream, event.receiver);
    this.streamManager.startJitterBufferMonitoring(this.connection.pc);
  }

  extractTrackId(event) {
    let trackId = event.track.id;

    const stream = event.streams?.[0];
    if (stream?.id?.startsWith('stream_')) {
      trackId = stream.id.replace('stream_', '');
      console.log('Extracted track name:', trackId);
    }

    return trackId;
  }

  async handleSignalingMessage(msg) {
    console.log('Received message:', msg.type);

    switch (msg.type) {
      case 'pong':
        this.clockSync.handlePong(msg);
        break;

      case 'metrics':
        this.metrics.process(msg.data, msg.timestamp);
        break;

      case 'joined':
        await this.handleJoined(msg);
        break;

      case 'answer':
        await this.connection.setAnswer(msg.sdp);
        break;

      case 'candidate':
      case 'ice':
        if (msg.candidate) {
          await this.connection.addIceCandidate(msg.candidate);
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

  async handleJoined(msg) {
    this.signaling.clientId = msg.client_id;
    console.log('Joined as client:', msg.client_id);
    console.log('Available streams:', msg.streams);

    const streamCount = msg.streams?.length || 1;
    this.connection.addTransceivers(streamCount);

    const offer = await this.connection.createOffer();
    this.signaling.send({ type: 'offer', sdp: offer });
  }

  // Public API

  getStream(trackId) {
    return this.streamManager.getStream(trackId);
  }

  getMetrics(trackId) {
    return this.streamManager.getMetrics(trackId);
  }

  getAllStreams() {
    return this.streamManager.getAllStreams();
  }

  getAllMetrics() {
    return this.streamManager.getAllMetrics();
  }

  getClockSyncStats() {
    return this.clockSync.getStats();
  }

  disconnect() {
    console.log('Disconnecting...');
    this.clockSync.stop();
    this.streamManager.cleanup();
    this.connection.close();
    this.signaling.close();
    this.clockSync.reset();
  }
}

// Re-export modules for direct access if needed
export { ClockSynchronizer } from './modules/clock_sync.js';
export { StreamManager } from './modules/stream_manager.js';
export { SignalingClient } from './modules/signaling.js';
export { WebRTCConnection } from './modules/connection.js';
export { MetricsProcessor } from './modules/metrics.js';