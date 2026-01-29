// detail-view.js - Detail view management

import { UIUpdater } from './ui_updater.js';
import { ChartManager } from './chart_manager.js';
import { LatencyHistory } from './latency_history.js';
import { LatencyStats } from './latency_stats.js';

export class DetailView {
  constructor() {
    this.currentStreamId = null;
    this.chartManager = new ChartManager('latencyChart');
    this.latencyHistory = new LatencyHistory();
    this.latencyStats = new LatencyStats();
    this.webrtcClient = null;
  }

  setWebRTCClient(client) {
    this.webrtcClient = client;
  }

  show(streamId) {
    console.log('Showing detail for:', streamId);

    const stream = this.webrtcClient?.getStream(streamId);
    if (!stream) {
      console.error('Stream not found:', streamId);
      return;
    }

    this.currentStreamId = streamId;
    this.resetState();
    this.showDetailView();
    this.setupVideo(streamId, stream);
    this.chartManager.initialize();
    this.loadInitialData(streamId);
  }

  hide() {
    this.currentStreamId = null;
    this.showDashboardView();
    this.chartManager.destroy();
    this.clearVideo();
  }

  resetState() {
    this.latencyHistory.clear();
    this.latencyStats.reset();
  }

  showDetailView() {
    document.getElementById('dashboardView').style.display = 'none';
    document.getElementById('detailView').style.display = 'block';
  }

  showDashboardView() {
    document.getElementById('dashboardView').style.display = 'block';
    document.getElementById('detailView').style.display = 'none';
  }

  setupVideo(streamId, stream) {
    document.getElementById('streamTitle').textContent = this.formatStreamName(streamId);

    const video = document.getElementById('detailVideo');
    video.srcObject = stream;
    video.play().catch(err => console.warn('Detail video play error:', err.message));
  }

  clearVideo() {
    const video = document.getElementById('detailVideo');
    video.srcObject = null;
  }

  loadInitialData(streamId) {
    const metrics = this.webrtcClient?.getMetrics(streamId);
    if (metrics) {
      UIUpdater.updateDetailMetrics(metrics);
    }

    const clockStats = this.webrtcClient?.getClockSyncStats();
    if (clockStats) {
      UIUpdater.updateDetailClockDisplay(clockStats);
    }
  }

  updateMetrics(metrics) {
    if (!this.currentStreamId) return;

    UIUpdater.updateDetailMetrics(metrics);
    this.updateChart(metrics);
    this.updateStats(metrics);
  }

  updateChart(metrics) {
    this.latencyHistory.add(metrics);
    this.chartManager.update(this.latencyHistory);
  }

  updateStats(metrics) {
    const totalLatency = metrics.totalLatency || 0;

    if (totalLatency > 0) {
      this.latencyStats.update(totalLatency, metrics.latencyMethod);
      UIUpdater.updateLatencyStats(this.latencyStats);
    }
  }

  updateClockSync(syncStats) {
    if (this.currentStreamId) {
      UIUpdater.updateDetailClockDisplay(syncStats);
    }
  }

  formatStreamName(streamId) {
    return streamId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  getCurrentStreamId() {
    return this.currentStreamId;
  }

  isActive() {
    return this.currentStreamId !== null;
  }
}