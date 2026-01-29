// signaling.js - WebSocket signaling client

export class SignalingClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.clientId = null;

    this.onOpen = null;
    this.onClose = null;
    this.onError = null;
    this.onMessage = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      console.log('Connecting to signaling server:', this.url);
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        if (this.onOpen) this.onOpen();
        resolve();
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        if (this.onError) this.onError(error);
        reject(error);
      };

      this.ws.onclose = () => {
        console.log('WebSocket disconnected');
        if (this.onClose) this.onClose();
      };

      this.ws.onmessage = async (event) => {
        await this.handleMessage(event);
      };
    });
  }

  async handleMessage(event) {
    try {
      const msg = JSON.parse(event.data);
      if (this.onMessage) {
        await this.onMessage(msg);
      }
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  }

  send(msg) {
    if (!this.isConnected) {
      console.error('WebSocket not ready');
      return false;
    }

    this.ws.send(JSON.stringify(msg));
    return true;
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}