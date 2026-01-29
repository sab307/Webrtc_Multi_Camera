// stream-manager.js - Video stream and metrics management

import { LOW_LATENCY, MONITORING } from './constants.js';

export class StreamManager {
  constructor() {
    this.streams = new Map();
    this.metrics = new Map();
    this.videoElements = new Map();
    this.jitterMonitorInterval = null;
    this.jitterLogCount = 0;

    this.onStreamAdded = null;
    this.onStreamRemoved = null;
  }

  addStream(trackId, stream, receiver) {
    this.applyLowLatencyHints(receiver);
    this.streams.set(trackId, stream);
    this.metrics.set(trackId, this.createInitialMetrics());

    if (this.onStreamAdded) {
      this.onStreamAdded(trackId, stream);
    }

    this.setupFrameCallback(trackId, stream);
  }

  applyLowLatencyHints(receiver) {
    if (!receiver) return;

    if (receiver.playoutDelayHint !== undefined) {
      receiver.playoutDelayHint = LOW_LATENCY.PLAYOUT_DELAY_HINT;
      console.log('Set playoutDelayHint to 0ms');
    }

    if (receiver.jitterBufferTarget !== undefined) {
      receiver.jitterBufferTarget = LOW_LATENCY.JITTER_BUFFER_TARGET;
      console.log('Set jitterBufferTarget to 10ms');
    }
  }

  createInitialMetrics() {
    return {
      frameCount: 0,
      totalLatency: 0,
      rosLatency: 0,
      processingLatency: 0,
      networkLatency: 0,
      renderLatency: 0,
      jitterBufferDelay: 0,
      decodeTime: 0
    };
  }

  setupFrameCallback(trackId, stream) {
    const video = this.createVideoElement(stream);
    const frameState = this.createFrameState();

    const handleFrame = (now, metadata) => {
      this.processFrame(trackId, now, metadata, frameState);

      if (video.requestVideoFrameCallback) {
        video.requestVideoFrameCallback(handleFrame);
      }
    };

    if (video.requestVideoFrameCallback) {
      video.requestVideoFrameCallback(handleFrame);
      console.log('requestVideoFrameCallback enabled for', trackId);
    } else {
      console.warn('requestVideoFrameCallback not supported');
    }

    this.videoElements.set(trackId, video);
  }

  createVideoElement(stream) {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.preload = 'none';

    if (video.latencyHint !== undefined) {
      video.latencyHint = 'low';
    }

    video.play().catch(e => console.warn('Video play error:', e.message));
    return video;
  }

  createFrameState() {
    return {
      lastPresentationTime: 0,
      frameCount: 0,
      processingDurationSamples: [],
      lastFrameTime: 0
    };
  }

  processFrame(trackId, now, metadata, state) {
    state.frameCount++;
    const metrics = this.metrics.get(trackId) || {};
    metrics.frameCount = state.frameCount;

    if (metadata) {
      this.updateMetricsFromMetadata(metrics, metadata, state);
    } else {
      metrics.renderLatency = now - state.lastFrameTime;
    }

    state.lastFrameTime = now;
    this.metrics.set(trackId, metrics);
  }

  updateMetricsFromMetadata(metrics, metadata, state) {
    metrics.presentedFrames = metadata.presentedFrames;
    metrics.width = metadata.width;
    metrics.height = metadata.height;

    if (metadata.processingDuration !== undefined) {
      this.updateRenderLatency(metrics, metadata.processingDuration, state);
    }

    if (state.lastPresentationTime > 0 && metadata.presentationTime) {
      metrics.frameInterval = (metadata.presentationTime - state.lastPresentationTime) * 1000;
    }

    if (metadata.presentationTime) {
      state.lastPresentationTime = metadata.presentationTime;
    }

    if (metadata.expectedDisplayTime && metadata.presentationTime) {
      metrics.compositorDelay = (metadata.presentationTime - metadata.expectedDisplayTime) * 1000;
    }
  }

  updateRenderLatency(metrics, processingDuration, state) {
    const processingMs = processingDuration * 1000;
    state.processingDurationSamples.push(processingMs);

    if (state.processingDurationSamples.length > MONITORING.PROCESSING_DURATION_SAMPLES) {
      state.processingDurationSamples.shift();
    }

    const sorted = [...state.processingDurationSamples].sort((a, b) => a - b);
    metrics.renderLatency = sorted[Math.floor(sorted.length / 2)];
  }

  startJitterBufferMonitoring(pc) {
    if (this.jitterMonitorInterval) return;

    this.jitterMonitorInterval = setInterval(
      () => this.collectJitterStats(pc),
      MONITORING.JITTER_INTERVAL_MS
    );
  }

  async collectJitterStats(pc) {
    if (!pc) return;

    try {
      const stats = await pc.getStats();
      this.processStats(stats);
    } catch (e) {
      // Ignore stats errors
    }
  }

  processStats(stats) {
    stats.forEach(report => {
      if (report.type !== 'inbound-rtp' || report.kind !== 'video') return;

      for (const [trackId, metrics] of this.metrics) {
        this.updateJitterMetrics(metrics, report);
      }
    });

    this.logJitterStats();
  }

  updateJitterMetrics(metrics, report) {
    if (report.jitterBufferDelay && report.jitterBufferEmittedCount) {
      metrics.jitterBufferDelay =
        (report.jitterBufferDelay / report.jitterBufferEmittedCount) * 1000;
    }

    if (report.totalDecodeTime && report.framesDecoded) {
      metrics.decodeTime = (report.totalDecodeTime / report.framesDecoded) * 1000;
    }

    metrics.framesDropped = report.framesDropped || 0;
    metrics.framesDecoded = report.framesDecoded || 0;

    if (report.jitter !== undefined) {
      metrics.jitter = report.jitter * 1000;
    }
  }

  logJitterStats() {
    this.jitterLogCount++;
    const shouldLog = this.jitterLogCount <= 3 ||
                      this.jitterLogCount % MONITORING.LOG_FREQUENCY === 0;

    if (!shouldLog) return;

    for (const [trackId, metrics] of this.metrics) {
      console.log('Render Pipeline Stats:');
      console.log(`  Jitter Buffer: ${metrics.jitterBufferDelay?.toFixed(1) || '?'}ms`);
      console.log(`  Decode Time: ${metrics.decodeTime?.toFixed(1) || '?'}ms`);
      console.log(`  Frames: ${metrics.framesDecoded} decoded, ${metrics.framesDropped} dropped`);
    }
  }

  stopJitterBufferMonitoring() {
    if (this.jitterMonitorInterval) {
      clearInterval(this.jitterMonitorInterval);
      this.jitterMonitorInterval = null;
    }
  }

  updateMetrics(trackId, updates) {
    const existing = this.metrics.get(trackId) || this.createInitialMetrics();
    this.metrics.set(trackId, { ...existing, ...updates });
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
    this.stopJitterBufferMonitoring();

    this.videoElements.forEach(video => {
      video.srcObject = null;
    });

    this.streams.clear();
    this.metrics.clear();
    this.videoElements.clear();
  }
}