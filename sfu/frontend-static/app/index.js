// index.js - Main application orchestrator

import { WebRTCClient } from '../webrtc-client/index.js';
import { StreamGrid } from './modules/stream_grid.js';
import { DetailView } from './modules/detail_view.js';
import { UIUpdater } from './modules/ui_updater.js';

class App {
  constructor() {
    this.webrtcClient = null;
    this.streamGrid = new StreamGrid('streamGrid');
    this.detailView = new DetailView();

    this.setupStreamGridCallbacks();
  }

  setupStreamGridCallbacks() {
    this.streamGrid.onStreamClick = (trackId) => this.showDetail(trackId);
  }

  async initialize() {
    console.log('Initializing ROS2 WebRTC Streaming with Clock Sync...');

    try {
      const signalingUrl = this.buildSignalingUrl();
      console.log('Connecting to:', signalingUrl);

      this.webrtcClient = new WebRTCClient(signalingUrl);
      this.detailView.setWebRTCClient(this.webrtcClient);

      this.setupWebRTCCallbacks();
      await this.connect();
    } catch (error) {
      console.error('Failed to initialize WebRTC:', error);
      UIUpdater.updateConnectionStatus('failed');
    }
  }

  buildSignalingUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    return `${protocol}//${host}/ws`;
  }

  setupWebRTCCallbacks() {
    this.webrtcClient.onStreamAdded = (trackId, stream) => {
      console.log('Stream added:', trackId);
      this.streamGrid.addStream(trackId, stream);
    };

    this.webrtcClient.onStreamRemoved = (trackId) => {
      console.log('Stream removed:', trackId);
      this.streamGrid.removeStream(trackId);
    };

    this.webrtcClient.onMetricsUpdate = (metricsMap) => {
      this.handleMetricsUpdate(metricsMap);
    };

    this.webrtcClient.onConnectionStateChange = (state) => {
      UIUpdater.updateConnectionStatus(state);
    };

    this.webrtcClient.onClockSync = (syncStats) => {
      this.handleClockSyncUpdate(syncStats);
    };
  }

  async connect() {
    UIUpdater.updateConnectionStatus('connecting');
    await this.webrtcClient.connect();
    UIUpdater.updateConnectionStatus('connected');
  }

  handleMetricsUpdate(metricsMap) {
    this.updateGridMetrics(metricsMap);

    if (this.detailView.isActive()) {
      const currentId = this.detailView.getCurrentStreamId();
      const metrics = metricsMap.get(currentId);
      
      if (metrics) {
        this.detailView.updateMetrics(metrics);
      }
    }
  }

  updateGridMetrics(metricsMap) {
    for (const trackId of this.streamGrid.getStreams()) {
      const metrics = metricsMap.get(trackId);
      if (metrics) {
        this.streamGrid.updateMetrics(trackId, metrics);
      }
    }
  }

  handleClockSyncUpdate(syncStats) {
    UIUpdater.updateClockSyncCompact(syncStats);
    UIUpdater.updateClockSyncPanel(syncStats);
    this.detailView.updateClockSync(syncStats);
  }

  showDetail(streamId) {
    this.detailView.show(streamId);
  }

  showDashboard() {
    this.detailView.hide();
  }

  cleanup() {
    if (this.webrtcClient) {
      this.webrtcClient.disconnect();
    }
  }
}

// Create global app instance
let app = null;

// Export functions for HTML onclick handlers
window.showDashboard = function() {
  app?.showDashboard();
};

window.showDetail = function(streamId) {
  app?.showDetail(streamId);
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', async () => {
  app = new App();
  await app.initialize();
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  app?.cleanup();
});

export { App };