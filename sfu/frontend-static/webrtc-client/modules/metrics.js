// metrics.js - Latency metrics processing with clock compensation

import { MONITORING } from './constants.js';

export class MetricsProcessor {
  constructor(clockSync, streamManager) {
    this.clockSync = clockSync;
    this.streamManager = streamManager;
    this.logCount = 0;

    this.onUpdate = null;
  }

  process(metricsData, timestampSeconds) {
    this.logCount++;
    const shouldLog = this.shouldLog();

    const receiveTime = Date.now();
    const serverTimeMs = timestampSeconds * 1000;
    const rawLatency = receiveTime - serverTimeMs;

    const { latency: networkTime, method } = this.clockSync.compensateLatency(rawLatency);

    if (shouldLog) {
      this.logCompensation(rawLatency, networkTime, method);
    }

    this.updateAllTrackMetrics(metricsData, networkTime, method, rawLatency);
    this.notifyUpdate();
  }

  shouldLog() {
    return this.logCount <= 5 || this.logCount % MONITORING.LOG_FREQUENCY === 0;
  }

  logCompensation(rawLatency, networkTime, method) {
    console.log(`Latency: raw=${rawLatency.toFixed(1)}ms, compensated=${networkTime.toFixed(1)}ms (${method})`);
  }

  updateAllTrackMetrics(metricsData, networkTime, method, rawLatency) {
    for (const [trackId, trackMetrics] of Object.entries(metricsData)) {
      const combined = this.buildCombinedMetrics(trackId, trackMetrics, networkTime, method, rawLatency);
      this.streamManager.updateMetrics(trackId, combined);

      if (this.shouldLog()) {
        console.log(`${trackId}: total=${combined.totalLatency.toFixed(1)}ms`);
      }
    }
  }

  buildCombinedMetrics(trackId, trackMetrics, networkTime, method, rawLatency) {
    const existing = this.streamManager.getMetrics(trackId) || {};

    const rosLatency = trackMetrics.ros_latency || 0;
    const encodingLatency = trackMetrics.encoding_latency || 0;
    const renderLatency = existing.renderLatency || 0;

    return {
      ...existing,
      rosLatency,
      encodingLatency,
      networkLatency: Math.max(0, networkTime),
      processingLatency: rosLatency + encodingLatency,
      renderLatency,
      totalLatency: rosLatency + encodingLatency + Math.max(0, networkTime) + renderLatency,
      timestamp: Date.now(),
      clockSynced: this.clockSync.synced || this.clockSync.pythonCalibrated,
      latencyMethod: method,
      rawLatency,
      clockOffset: this.clockSync.offset,
      pythonOffset: this.clockSync.pythonOffset
    };
  }

  notifyUpdate() {
    if (this.onUpdate) {
      this.onUpdate(this.streamManager.getAllMetrics());
    }
  }
}