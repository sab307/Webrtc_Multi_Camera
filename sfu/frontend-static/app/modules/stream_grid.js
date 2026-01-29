// stream-grid.js - Stream card management

import { UIUpdater } from './ui_updater.js';

export class StreamGrid {
  constructor(gridId) {
    this.gridId = gridId;
    this.streams = [];
    this.onStreamClick = null;
  }

  addStream(trackId, stream) {
    console.log('Adding stream to grid:', trackId);

    if (!this.streams.includes(trackId)) {
      this.streams.push(trackId);
      this.updateStreamCount();
    }

    this.removeLoadingIndicator();

    if (document.getElementById(`card-${trackId}`)) {
      console.log('Card already exists:', trackId);
      return;
    }

    const card = this.createStreamCard(trackId, stream);
    this.getGrid().appendChild(card);

    this.setupVideoPlayback(trackId, stream);
    console.log('Stream card created:', trackId);
  }

  removeStream(trackId) {
    this.streams = this.streams.filter(id => id !== trackId);
    this.updateStreamCount();

    const card = document.getElementById(`card-${trackId}`);
    if (card) card.remove();

    if (this.streams.length === 0) {
      this.showLoadingIndicator();
    }
  }

  createStreamCard(trackId, stream) {
    const card = document.createElement('div');
    card.className = 'stream-card';
    card.id = `card-${trackId}`;
    card.onclick = () => this.handleCardClick(trackId);

    const video = this.createVideoElement(trackId, stream);
    const info = this.createInfoSection(trackId);

    card.appendChild(video);
    card.appendChild(info);

    return card;
  }

  createVideoElement(trackId, stream) {
    const video = document.createElement('video');
    video.id = `video-${trackId}`;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;

    video.onloadedmetadata = () => {
      console.log(`Video ${trackId} metadata:`, video.videoWidth, 'x', video.videoHeight);
    };

    video.onerror = (e) => console.error(`Video ${trackId} error:`, e);

    return video;
  }

  createInfoSection(trackId) {
    const info = document.createElement('div');
    info.className = 'stream-card-info';

    const title = document.createElement('div');
    title.className = 'stream-card-title';
    title.textContent = this.formatStreamName(trackId);

    const stats = document.createElement('div');
    stats.className = 'stream-card-stats';
    stats.innerHTML = this.createStatsHtml(trackId);

    info.appendChild(title);
    info.appendChild(stats);

    return info;
  }

  createStatsHtml(trackId) {
    return `
      <div class="stream-stat">
        <span class="stream-stat-label">Latency</span>
        <span class="stream-stat-value" id="card-latency-${trackId}">0ms</span>
      </div>
      <div class="stream-stat">
        <span class="stream-stat-label">Frames</span>
        <span class="stream-stat-value" id="card-frames-${trackId}">0</span>
      </div>
      <div class="stream-stat">
        <span class="stream-stat-label">Status</span>
        <span class="stream-stat-value" id="card-status-${trackId}">● Connecting</span>
      </div>
    `;
  }

  setupVideoPlayback(trackId, stream) {
    const video = document.getElementById(`video-${trackId}`);
    if (!video) return;

    const playVideo = async () => {
      try {
        await video.play();
        console.log(`Video ${trackId} playing`);
      } catch (err) {
        console.warn(`Video ${trackId} play failed:`, err.message);
        setTimeout(playVideo, 500);
      }
    };

    setTimeout(playVideo, 100);
    this.setupTrackListeners(trackId, stream);
  }

  setupTrackListeners(trackId, stream) {
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;

    console.log('Track state:', videoTrack.readyState, 'enabled:', videoTrack.enabled);

    const updateStatus = (status) => {
      const el = document.getElementById(`card-status-${trackId}`);
      if (el) el.textContent = status;
    };

    videoTrack.onended = () => updateStatus('● Ended');
    videoTrack.onmute = () => updateStatus('● Muted');
    videoTrack.onunmute = () => updateStatus('● Live');

    if (videoTrack.readyState === 'live' && !videoTrack.muted) {
      updateStatus('● Live');
    }
  }

  handleCardClick(trackId) {
    if (this.onStreamClick) {
      this.onStreamClick(trackId);
    }
  }

  updateMetrics(trackId, metrics) {
    const latencyEl = document.getElementById(`card-latency-${trackId}`);
    const framesEl = document.getElementById(`card-frames-${trackId}`);

    if (latencyEl) {
      latencyEl.textContent = Math.round(metrics.totalLatency || 0) + 'ms';
    }
    if (framesEl) {
      framesEl.textContent = metrics.frameCount || 0;
    }
  }

  getGrid() {
    return document.getElementById(this.gridId);
  }

  removeLoadingIndicator() {
    const loading = this.getGrid().querySelector('.loading');
    if (loading) loading.remove();
  }

  showLoadingIndicator() {
    this.getGrid().innerHTML = `
      <div class="loading">
        <div class="spinner"></div>
        <p>Waiting for streams...</p>
      </div>
    `;
  }

  updateStreamCount() {
    UIUpdater.updateStreamCount(this.streams.length);
  }

  formatStreamName(streamId) {
    return streamId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  getStreams() {
    return this.streams;
  }
}