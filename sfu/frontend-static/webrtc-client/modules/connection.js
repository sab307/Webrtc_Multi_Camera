// connection.js - WebRTC peer connection management

import { WEBRTC, DATA_CHANNEL } from './constants.js';

export class WebRTCConnection {
  constructor() {
    this.pc = null;
    this.dataChannel = null;

    this.onTrack = null;
    this.onDataChannelMessage = null;
    this.onConnectionStateChange = null;
    this.onIceCandidate = null;
  }

  setup() {
    console.log('Setting up WebRTC with low-latency optimizations...');

    this.pc = new RTCPeerConnection({
      iceServers: WEBRTC.ICE_SERVERS,
      bundlePolicy: WEBRTC.BUNDLE_POLICY,
      rtcpMuxPolicy: WEBRTC.RTCP_MUX_POLICY
    });

    this.createDataChannel();
    this.setupPeerConnectionHandlers();
  }

  createDataChannel() {
    this.dataChannel = this.pc.createDataChannel(DATA_CHANNEL.LABEL, {
      ordered: DATA_CHANNEL.ORDERED,
      maxRetransmits: DATA_CHANNEL.MAX_RETRANSMITS
    });

    console.log('Created data channel, state:', this.dataChannel.readyState);
    this.setupDataChannelHandlers(this.dataChannel, 'local');
  }

  setupDataChannelHandlers(dc, label) {
    console.log(`Setting up handlers for data channel: ${label}`);

    dc.onopen = () => console.log(`Data channel ${label} OPENED`);
    dc.onclose = () => console.log(`Data channel ${label} closed`);
    dc.onerror = (error) => console.error(`Data channel ${label} error:`, error);

    let messageCount = 0;

    dc.onmessage = (event) => {
      messageCount++;
      const data = this.parseDataChannelMessage(event.data, messageCount);

      if (data && this.onDataChannelMessage) {
        this.onDataChannelMessage(data);
      }
    };
  }

  parseDataChannelMessage(rawData, messageCount) {
    try {
      let jsonStr;

      if (typeof rawData === 'string') {
        jsonStr = rawData;
      } else if (rawData instanceof ArrayBuffer) {
        jsonStr = new TextDecoder().decode(rawData);
      } else if (rawData instanceof Blob) {
        return null;
      } else {
        return null;
      }

      return JSON.parse(jsonStr);
    } catch (error) {
      if (messageCount <= 3) {
        console.warn(`Data channel parse error (msg #${messageCount})`);
      }
      return null;
    }
  }

  setupPeerConnectionHandlers() {
    this.pc.ontrack = (event) => {
      console.log('Received track:', event.track.id, event.track.kind);
      if (this.onTrack) {
        this.onTrack(event);
      }
    };

    this.pc.ondatachannel = (event) => {
      console.log('Received data channel from server:', event.channel.label);
      this.setupDataChannelHandlers(event.channel, 'server');
    };

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.onIceCandidate) {
        console.log('Sending ICE candidate');
        this.onIceCandidate(event.candidate);
      }
    };

    this.pc.onconnectionstatechange = () => {
      console.log('Connection state:', this.pc.connectionState);
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
  }

  addTransceivers(count) {
    const transceiverCount = Math.max(1, count);
    console.log(`Adding ${transceiverCount} video transceiver(s)`);

    for (let i = 0; i < transceiverCount; i++) {
      this.pc.addTransceiver('video', { direction: 'recvonly' });
    }
  }

  async createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    console.log('Created and set local offer');

    return {
      type: this.pc.localDescription.type,
      sdp: this.pc.localDescription.sdp
    };
  }

  async setAnswer(answerSdp) {
    const sdp = this.extractSdp(answerSdp);
    const answer = new RTCSessionDescription({ type: 'answer', sdp });

    await this.pc.setRemoteDescription(answer);
    console.log('Set remote description');
  }

  extractSdp(answerSdp) {
    if (typeof answerSdp === 'object' && answerSdp !== null) {
      return answerSdp.sdp || answerSdp;
    }
    return answerSdp;
  }

  async addIceCandidate(candidate) {
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn('Error adding ICE candidate:', e.message);
    }
  }

  async getStats() {
    return this.pc ? this.pc.getStats() : null;
  }

  close() {
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
  }

  get connectionState() {
    return this.pc ? this.pc.connectionState : 'closed';
  }
}