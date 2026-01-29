// latency-history.js - Latency history for chart

import { CHART } from './constants.js';

export class LatencyHistory {
  constructor() {
    this.data = [];
  }

  add(metrics) {
    const now = new Date();

    this.data.push({
      time: this.formatTime(now),
      total: metrics.totalLatency || 0,
      network: metrics.networkLatency || 0,
      processing: (metrics.rosLatency || 0) + (metrics.encodingLatency || 0),
      timestamp: now.getTime()
    });

    this.pruneOldEntries(now);
  }

  formatTime(date) {
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  pruneOldEntries(now) {
    const cutoffTime = now.getTime() - (CHART.DURATION_SECONDS * 1000);

    while (this.data.length > 0 && this.data[0].timestamp < cutoffTime) {
      this.data.shift();
    }

    while (this.data.length > CHART.MAX_HISTORY_POINTS) {
      this.data.shift();
    }
  }

  clear() {
    this.data = [];
  }

  getLabels() {
    return this.data.map(h => h.time);
  }

  getTotalLatencies() {
    return this.data.map(h => h.total);
  }

  getNetworkLatencies() {
    return this.data.map(h => h.network);
  }

  getProcessingLatencies() {
    return this.data.map(h => h.processing);
  }

  getMaxTotal() {
    if (this.data.length === 0) return 50;
    return Math.max(...this.data.map(h => h.total), 50);
  }
}