#!/usr/bin/env python3
"""
ROS2 WebRTC Publisher with configurable codec support
Supports H.264, VP8, VP9, H.265

Usage:
    python ros2_webrtc_publisher.py --server wss://localhost:8443/ws --topic /camera/image_raw/compressed --track-id cam_front --codec h264
    python ros2_webrtc_publisher.py --simulate --codec vp8
"""

import asyncio
import json
import logging
import ssl
import time
import argparse
from dataclasses import dataclass, field
from typing import Optional, Dict, List
from fractions import Fraction
import numpy as np

# WebRTC
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer
from aiortc.contrib.media import MediaStreamTrack
from av import VideoFrame

# WebSocket
import websockets
from websockets.exceptions import ConnectionClosed

# Image processing
import cv2

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Try to import ROS2 (optional for simulation mode)
try:
    import rclpy
    from rclpy.node import Node
    from sensor_msgs.msg import CompressedImage
    ROS2_AVAILABLE = True
except ImportError:
    ROS2_AVAILABLE = False
    logger.warning("ROS2 not available, running in simulation mode")


# Codec configurations
CODEC_CONFIGS = {
    'h264': {
        'mime_type': 'video/H264',
        'clock_rate': 90000,
        'profile': 'baseline',
    },
    'vp8': {
        'mime_type': 'video/VP8',
        'clock_rate': 90000,
    },
    'vp9': {
        'mime_type': 'video/VP9',
        'clock_rate': 90000,
    },
    'h265': {
        'mime_type': 'video/H265',
        'clock_rate': 90000,
    },
}


@dataclass
class StreamConfig:
    """Configuration for a video stream"""
    topic: str
    track_id: str
    width: int = 640
    height: int = 480
    fps: int = 30
    codec: str = 'h264'


@dataclass
class ConnectionState:
    """Track the state of the WebRTC connection"""
    pc: Optional[RTCPeerConnection] = None
    client_id: Optional[str] = None
    is_connected: bool = False
    is_negotiating: bool = False
    pending_candidates: list = field(default_factory=list)
    offer_sent: bool = False
    answer_received: bool = False


class ROS2VideoTrack(MediaStreamTrack):
    """
    Video track that receives frames from ROS2 topic or simulation
    """
    kind = "video"
    
    def __init__(self, config: StreamConfig, simulation_mode: bool = False):
        super().__init__()
        # Override the auto-generated track ID with our custom one
        self._track_id = config.track_id
        
        self.config = config
        self.simulation_mode = simulation_mode
        self._timestamp = 0
        self._frame_count = 0
        self._start_time = time.time()
        self._latest_frame: Optional[np.ndarray] = None
        
        # Use threading primitives for cross-thread communication (ROS2 -> asyncio)
        import threading
        self._frame_lock = threading.Lock()
        self._frame_ready = threading.Event()
        
        self._loop = None
        self._recv_started = False
        
        # Timing metrics
        self._ros_receive_time: Optional[float] = None  # When frame received from ROS2
        self._last_ros_latency: float = 0.0  # Time from ROS2 callback to recv()
        self._last_encoding_latency: float = 0.0  # Encoding time (estimated)
        
        # For simulation mode
        if simulation_mode:
            self._sim_task: Optional[asyncio.Task] = None
            
        logger.info(f"Created video track: {config.track_id} for topic {config.topic} (codec: {config.codec})")
    
    @property
    def id(self) -> str:
        """Return the custom track ID"""
        return self._track_id
    
    def set_loop(self, loop):
        """Set the event loop for frame updates from ROS2 callbacks"""
        self._loop = loop
    
    def get_metrics(self) -> dict:
        """Get current timing metrics for this track"""
        return {
            'ros_latency': self._last_ros_latency * 1000,  # Convert to ms
            'encoding_latency': self._last_encoding_latency * 1000,
            'frame_count': self._frame_count,
        }
    
    def update_frame(self, frame: np.ndarray):
        """Update the latest frame (called from ROS2 callback thread)"""
        receive_time = time.time()
        
        with self._frame_lock:
            self._latest_frame = frame.copy()
            self._ros_receive_time = receive_time
            self._frame_ready.set()
        
        # Log occasionally to confirm frames are arriving
        if not hasattr(self, '_ros_frame_count'):
            self._ros_frame_count = 0
        self._ros_frame_count += 1
        if self._ros_frame_count == 1:
            logger.info(f"First ROS2 frame received for {self.config.track_id}")
        elif self._ros_frame_count % 30 == 0:
            logger.info(f"ROS2 frames received for {self.config.track_id}: {self._ros_frame_count}")
    
    async def start_simulation(self):
        """Start generating simulated frames"""
        if self._sim_task is None:
            logger.info(f"Starting simulation for track {self.config.track_id}")
            self._sim_task = asyncio.create_task(self._simulation_loop())
            # Give the simulation a moment to start
            await asyncio.sleep(0.1)
            logger.info(f"Simulation task created for {self.config.track_id}")
    
    async def _simulation_loop(self):
        """Generate simulated camera frames"""
        logger.info(f"Simulation loop RUNNING for {self.config.track_id}")
        colors = [
            (66, 133, 244),   # Blue
            (52, 168, 83),    # Green
            (251, 188, 4),    # Yellow
            (234, 67, 53),    # Red
        ]
        color_idx = 0
        frame_interval = 1.0 / self.config.fps
        sim_frame_count = 0
        last_log_time = time.time()
        
        while True:
            try:
                loop_start = time.time()
                
                # Create test pattern
                frame = np.zeros((self.config.height, self.config.width, 3), dtype=np.uint8)
                
                # Background gradient
                for y in range(self.config.height):
                    ratio = y / self.config.height
                    color = colors[color_idx % len(colors)]
                    frame[y, :] = [int(c * (0.3 + 0.7 * ratio)) for c in color]
                
                color_idx += 1
                
                # Add text with timestamp
                timestamp_ms = int((time.time() - self._start_time) * 1000)
                
                # Draw semi-transparent overlay
                overlay = frame.copy()
                cv2.rectangle(overlay, (20, 20), (self.config.width - 20, 160), (0, 0, 0), -1)
                frame = cv2.addWeighted(overlay, 0.5, frame, 0.5, 0)
                
                # Add text
                cv2.putText(frame, f"Track: {self.config.track_id}", (40, 60), 
                           cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
                cv2.putText(frame, f"Codec: {self.config.codec.upper()}", (40, 95), 
                           cv2.FONT_HERSHEY_SIMPLEX, 0.7, (200, 200, 200), 2)
                cv2.putText(frame, f"Frame: {sim_frame_count} | Time: {timestamp_ms}ms", (40, 130), 
                           cv2.FONT_HERSHEY_SIMPLEX, 0.6, (180, 180, 180), 1)
                
                # Add moving element
                x = int((sim_frame_count * 3) % (self.config.width - 60)) + 30
                y = self.config.height - 50
                cv2.circle(frame, (x, y), 20, (255, 255, 255), -1)
                cv2.circle(frame, (x, y), 20, (0, 0, 0), 2)
                
                # Update frame and signal using threading primitives
                with self._frame_lock:
                    self._latest_frame = frame
                    self._frame_ready.set()
                
                sim_frame_count += 1
                
                # Log periodically (every second)
                if time.time() - last_log_time >= 1.0:
                    logger.info(f"Simulation {self.config.track_id}: generated {sim_frame_count} frames")
                    last_log_time = time.time()
                
                # Calculate sleep time to maintain frame rate
                elapsed = time.time() - loop_start
                sleep_time = max(0, frame_interval - elapsed)
                await asyncio.sleep(sleep_time)
                
            except asyncio.CancelledError:
                logger.info(f"Simulation loop cancelled for {self.config.track_id}")
                break
            except Exception as e:
                logger.error(f"Simulation error for {self.config.track_id}: {e}")
                await asyncio.sleep(0.1)
    
    async def recv(self) -> VideoFrame:
        """Receive the next video frame"""
        # Ensure simulation is running (failsafe) - only for simulation mode
        if self.simulation_mode and self._sim_task is None:
            logger.warning(f"Simulation not started for {self.config.track_id}, starting now...")
            await self.start_simulation()
        
        # Log when recv is first called (aiortc requesting frames)
        if not self._recv_started:
            self._recv_started = True
            logger.info(f"recv() called for track {self.config.track_id} - aiortc is requesting frames")
        
        pts_increment = 90000 // self.config.fps  # 90kHz clock
        
        # Wait for a frame using threading.Event (works across threads)
        # Use a short timeout and poll to not block the event loop
        frame = None
        ros_receive_time = None
        
        # Try to get a frame with polling (non-blocking for asyncio)
        for _ in range(10):  # Try for up to ~100ms
            if self._frame_ready.wait(timeout=0.01):  # 10ms timeout
                with self._frame_lock:
                    if self._latest_frame is not None:
                        frame = self._latest_frame.copy()
                        ros_receive_time = self._ros_receive_time
                    self._frame_ready.clear()
                break
            # Yield to other async tasks
            await asyncio.sleep(0.001)
        
        # If still no frame and we're in simulation mode, wait a bit longer
        if frame is None and self.simulation_mode:
            if self._frame_ready.wait(timeout=0.05):
                with self._frame_lock:
                    if self._latest_frame is not None:
                        frame = self._latest_frame.copy()
                        ros_receive_time = self._ros_receive_time
                    self._frame_ready.clear()
        
        # Calculate ROS latency (time from ROS callback to now)
        if ros_receive_time is not None:
            self._last_ros_latency = time.time() - ros_receive_time
        
        # Generate blank frame if we don't have one
        if frame is None:
            frame = np.zeros((self.config.height, self.config.width, 3), dtype=np.uint8)
            cv2.putText(frame, "No Signal", (self.config.width // 2 - 80, self.config.height // 2),
                       cv2.FONT_HERSHEY_SIMPLEX, 1.2, (128, 128, 128), 2)
            if self._frame_count % 100 == 0 and self._frame_count > 0:
                logger.warning(f"No frame available for {self.config.track_id}")
        
        # Time encoding (VideoFrame creation)
        encode_start = time.time()
        
        # Convert to VideoFrame
        video_frame = VideoFrame.from_ndarray(frame, format="bgr24")
        video_frame.pts = self._timestamp
        video_frame.time_base = Fraction(1, 90000)
        
        self._last_encoding_latency = time.time() - encode_start
        
        self._timestamp += pts_increment
        self._frame_count += 1
        
        # Log every 30 frames
        if self._frame_count == 1:
            logger.info(f"First frame being sent for track {self.config.track_id}")
        elif self._frame_count % 30 == 0:
            logger.info(f"Track {self.config.track_id}: sent {self._frame_count} frames")
        
        return video_frame
    
    def stop(self):
        """Stop the track"""
        super().stop()
        if self._sim_task:
            self._sim_task.cancel()


class WebRTCPublisher:
    """
    Manages WebRTC connection to the SFU server
    """
    
    def __init__(self, server_url: str, streams: List[StreamConfig], simulation_mode: bool = False):
        self.server_url = server_url
        self.streams = streams
        self.simulation_mode = simulation_mode
        
        # Connection state - create fresh for each connection
        self.state: Optional[ConnectionState] = None
        
        # Video tracks
        self.tracks: Dict[str, ROS2VideoTrack] = {}
        
        # WebSocket
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        
        # Data channel for metrics
        self.data_channel = None
        self._metrics_task = None
        
        # Running flag
        self._running = False
        self._reconnect_delay = 2.0
        self._max_reconnect_delay = 30.0
        
        # ICE configuration
        self.ice_config = RTCConfiguration(
            iceServers=[
                RTCIceServer(urls=["stun:stun.l.google.com:19302"]),
                RTCIceServer(urls=["stun:stun1.l.google.com:19302"]),
            ]
        )
    
    async def _send_metrics_loop(self):
        """Periodically send metrics via WebSocket"""
        logger.info("Starting metrics sending loop (via WebSocket)")
        while self._running:
            try:
                if self.ws and self.state and self.state.is_connected:
                    # Collect metrics from all tracks
                    metrics_data = {}
                    for track_id, track in self.tracks.items():
                        metrics_data[track_id] = track.get_metrics()
                    
                    # Send metrics via WebSocket
                    message = json.dumps({
                        "type": "metrics",
                        "timestamp": time.time(),
                        "data": metrics_data
                    })
                    await self.ws.send(message)
                
                await asyncio.sleep(0.1)  # Send 10 times per second
            except Exception as e:
                logger.debug(f"Metrics send error: {e}")
                await asyncio.sleep(1.0)
    
    def _create_fresh_state(self) -> ConnectionState:
        """Create a fresh connection state"""
        return ConnectionState(
            pending_candidates=[],
            is_connected=False,
            is_negotiating=False,
            offer_sent=False,
            answer_received=False
        )
    
    async def _create_peer_connection(self) -> RTCPeerConnection:
        """Create a new peer connection with proper configuration"""
        pc = RTCPeerConnection(configuration=self.ice_config)
        
        @pc.on("connectionstatechange")
        async def on_connection_state_change():
            logger.info(f"Connection state: {pc.connectionState}")
            if pc.connectionState == "connected":
                if self.state:
                    self.state.is_connected = True
                    self.state.is_negotiating = False
                logger.info("WebRTC fully connected - media should start flowing")
                # Start metrics loop when connected
                if self._metrics_task is None or self._metrics_task.done():
                    logger.info("Starting metrics loop")
                    self._metrics_task = asyncio.create_task(self._send_metrics_loop())
            elif pc.connectionState == "failed":
                logger.error("Connection failed")
                if self.state:
                    self.state.is_connected = False
            elif pc.connectionState == "closed":
                logger.info("Connection closed")
                if self.state:
                    self.state.is_connected = False
        
        @pc.on("iceconnectionstatechange")
        async def on_ice_connection_state_change():
            logger.info(f"ICE connection state: {pc.iceConnectionState}")
        
        @pc.on("icegatheringstatechange")
        async def on_ice_gathering_state_change():
            logger.info(f"ICE gathering state: {pc.iceGatheringState}")
        
        @pc.on("icecandidate")
        async def on_ice_candidate(candidate):
            if candidate and self.ws and self.state and self.state.client_id:
                try:
                    await self.ws.send(json.dumps({
                        "type": "ice",
                        "client_id": self.state.client_id,
                        "candidate": {
                            "candidate": candidate.candidate,
                            "sdpMid": candidate.sdpMid,
                            "sdpMLineIndex": candidate.sdpMLineIndex
                        }
                    }))
                    logger.debug(f"Sent ICE candidate")
                except Exception as e:
                    logger.error(f"Failed to send ICE candidate: {e}")
        
        return pc
    
    def _create_tracks(self):
        """Create video tracks for all streams"""
        loop = asyncio.get_event_loop()
        for config in self.streams:
            track = ROS2VideoTrack(config, self.simulation_mode)
            track.set_loop(loop)
            self.tracks[config.track_id] = track
            logger.info(f"Created track: {config.track_id} (codec: {config.codec})")
    
    async def _cleanup_connection(self):
        """Clean up the current connection state"""
        if self.state and self.state.pc:
            try:
                await self.state.pc.close()
            except Exception as e:
                logger.debug(f"Error closing PC: {e}")
        
        self.state = None
    
    async def _setup_webrtc(self):
        """Set up WebRTC peer connection and add tracks"""
        # Clean up any existing connection
        await self._cleanup_connection()
        
        # Cancel existing metrics task
        if self._metrics_task:
            self._metrics_task.cancel()
            self._metrics_task = None
        
        # Create fresh state
        self.state = self._create_fresh_state()
        
        # Create new peer connection
        self.state.pc = await self._create_peer_connection()
        
        # Add tracks to peer connection
        for track_id, track in self.tracks.items():
            # Find the stream config for this track
            config = next((s for s in self.streams if s.track_id == track_id), None)
            if config:
                sender = self.state.pc.addTrack(track)
                logger.info(f"Added track: {track_id} ({config.topic}) - sender: {sender}")
                
                # Log track info
                logger.info(f"Track kind: {track.kind}, id: {track.id}")
        
        logger.info("WebRTC setup complete")
    
    async def _send_offer(self):
        """Create and send offer to SFU"""
        if not self.state or not self.state.pc:
            logger.error("Cannot send offer: no peer connection")
            return
        
        if self.state.is_negotiating:
            logger.warning("Already negotiating, skipping offer")
            return
        
        if self.state.offer_sent and not self.state.answer_received:
            logger.warning("Offer already sent, waiting for answer")
            return
        
        self.state.is_negotiating = True
        self.state.offer_sent = False
        self.state.answer_received = False
        self.state.pending_candidates = []
        
        try:
            # Create offer
            offer = await self.state.pc.createOffer()
            await self.state.pc.setLocalDescription(offer)
            
            # Send offer
            await self.ws.send(json.dumps({
                "type": "offer",
                "client_id": self.state.client_id,
                "sdp": self.state.pc.localDescription.sdp
            }))
            
            self.state.offer_sent = True
            logger.info("Sent offer")
            
        except Exception as e:
            logger.error(f"Failed to send offer: {e}")
            self.state.is_negotiating = False
            raise
    
    async def _handle_answer(self, sdp):
        """Handle answer from SFU"""
        if not self.state or not self.state.pc:
            logger.error("Cannot handle answer: no peer connection")
            return
        
        if not self.state.offer_sent:
            logger.error("Received answer but no offer was sent")
            return
        
        if self.state.answer_received:
            logger.warning("Answer already received, ignoring duplicate")
            return
        
        try:
            # Handle SDP as either string or dict
            if isinstance(sdp, dict):
                sdp_str = sdp.get('sdp', '')
            else:
                sdp_str = sdp
            
            if not sdp_str:
                logger.error("Empty SDP in answer")
                return
                
            answer = RTCSessionDescription(sdp=sdp_str, type="answer")
            await self.state.pc.setRemoteDescription(answer)
            self.state.answer_received = True
            logger.info("Set remote description (answer)")
            
            # Apply any pending ICE candidates
            for candidate in self.state.pending_candidates:
                try:
                    await self.state.pc.addIceCandidate(candidate)
                    logger.debug("Applied pending ICE candidate")
                except Exception as e:
                    logger.warning(f"Failed to apply pending ICE candidate: {e}")
            
            self.state.pending_candidates = []
            self.state.is_negotiating = False
            
        except Exception as e:
            logger.error(f"Failed to set remote description: {e}")
            self.state.is_negotiating = False
            raise
    
    async def _handle_ice_candidate(self, candidate_data: dict):
        """Handle ICE candidate from SFU"""
        if not self.state or not self.state.pc:
            logger.warning("Cannot handle ICE candidate: no peer connection")
            return
        
        try:
            from aiortc import RTCIceCandidate
            
            candidate = RTCIceCandidate(
                sdpMid=candidate_data.get("sdpMid"),
                sdpMLineIndex=candidate_data.get("sdpMLineIndex"),
                candidate=candidate_data.get("candidate")
            )
            
            # If we haven't received the answer yet, queue the candidate
            if not self.state.answer_received:
                self.state.pending_candidates.append(candidate)
                logger.debug("Queued ICE candidate (waiting for answer)")
            else:
                await self.state.pc.addIceCandidate(candidate)
                logger.debug("Added ICE candidate")
                
        except Exception as e:
            logger.warning(f"Failed to handle ICE candidate: {e}")
    
    async def _handle_message(self, message: str):
        """Handle incoming WebSocket message"""
        try:
            data = json.loads(message)
            msg_type = data.get("type")
            
            if msg_type == "joined":
                self.state.client_id = data.get("client_id")
                logger.info(f"Joined as client: {self.state.client_id}")
                
                # Send offer after joining
                await asyncio.sleep(0.1)  # Small delay to ensure state is ready
                await self._send_offer()
                
            elif msg_type == "answer":
                await self._handle_answer(data.get("sdp"))
                
            elif msg_type == "ice":
                await self._handle_ice_candidate(data.get("candidate", {}))
                
            elif msg_type == "error":
                logger.error(f"Server error: {data.get('message')}")
                # On error, clean up and reconnect
                if "ice-ufrag" in str(data.get('message', '')):
                    logger.info("Resetting connection due to ICE conflict")
                    await self._cleanup_connection()
                
            elif msg_type == "streams":
                streams = data.get("streams", [])
                logger.info(f"Available streams: {streams}")
                
            else:
                logger.debug(f"Unknown message type: {msg_type}")
                
        except json.JSONDecodeError:
            logger.error(f"Invalid JSON message: {message}")
        except Exception as e:
            logger.error(f"Error handling message: {e}")
    
    async def _connect(self):
        """Connect to the signaling server"""
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        logger.info(f"Connecting to {self.server_url}...")
        
        try:
            self.ws = await websockets.connect(
                self.server_url,
                ssl=ssl_context,
                ping_interval=20,
                ping_timeout=10,
                close_timeout=5
            )
            logger.info("Connected to signaling server")
            return True
        except Exception as e:
            logger.error(f"Connection failed: {e}")
            return False
    
    async def _run_connection(self):
        """Run the WebSocket connection loop"""
        # Set up WebRTC (creates fresh peer connection)
        await self._setup_webrtc()
        
        # Start simulation if needed
        if self.simulation_mode:
            for track in self.tracks.values():
                await track.start_simulation()
        
        # Join as publisher
        await self.ws.send(json.dumps({
            "type": "join",
            "role": "publisher",
            "streams": [
                {"id": config.track_id, "topic": config.topic}
                for config in self.streams
            ]
        }))
        logger.info("Sent join message as publisher")
        
        # Handle messages
        try:
            async for message in self.ws:
                await self._handle_message(message)
        except ConnectionClosed as e:
            logger.warning(f"WebSocket closed: {e}")
        except Exception as e:
            logger.error(f"Error: {e}")
    
    async def run(self):
        """Main run loop with reconnection"""
        self._running = True
        reconnect_delay = self._reconnect_delay
        
        # Create tracks once
        if not self.tracks:
            self._create_tracks()
        
        while self._running:
            try:
                if await self._connect():
                    reconnect_delay = self._reconnect_delay  # Reset delay on success
                    await self._run_connection()
                
            except Exception as e:
                logger.error(f"Connection error: {e}")
            
            finally:
                # Clean up
                await self._cleanup_connection()
                
                if self.ws:
                    try:
                        await self.ws.close()
                    except:
                        pass
                    self.ws = None
            
            if self._running:
                logger.info(f"Reconnecting in {reconnect_delay}s...")
                await asyncio.sleep(reconnect_delay)
                reconnect_delay = min(reconnect_delay * 1.5, self._max_reconnect_delay)
    
    def stop(self):
        """Stop the publisher"""
        self._running = False
        for track in self.tracks.values():
            track.stop()
        logger.info("Stopping publisher")


class ROS2SubscriberNode:
    """ROS2 node for receiving camera images (when ROS2 is available)"""
    
    def __init__(self, publisher: WebRTCPublisher):
        self.publisher = publisher
        self.node = None
    
    def init(self):
        """Initialize ROS2 node"""
        rclpy.init()
        self.node = rclpy.create_node('webrtc_publisher')
        
        # Log available tracks
        logger.info(f"Publisher tracks available: {list(self.publisher.tracks.keys())}")
        
        # Create subscriptions for each stream
        for config in self.publisher.streams:
            # Check if topic ends with /compressed to determine message type
            if config.topic.endswith('/compressed'):
                msg_type = CompressedImage
                logger.info(f"Subscribing to CompressedImage topic: {config.topic}")
            else:
                # Try to import Image message
                try:
                    from sensor_msgs.msg import Image
                    msg_type = Image
                    logger.info(f"Subscribing to raw Image topic: {config.topic}")
                except ImportError:
                    logger.warning(f"sensor_msgs.msg.Image not available, using CompressedImage")
                    msg_type = CompressedImage
            
            self.node.create_subscription(
                msg_type,
                config.topic,
                lambda msg, cfg=config, mtype=msg_type: self._image_callback(msg, cfg, mtype),
                10
            )
            logger.info(f"Subscribed to {config.topic} (type: {msg_type.__name__})")
    
    def _image_callback(self, msg, config: StreamConfig, msg_type):
        """Handle incoming image from ROS2"""
        try:
            # Log first message and periodically
            if not hasattr(self, '_callback_count'):
                self._callback_count = {}
            if config.track_id not in self._callback_count:
                self._callback_count[config.track_id] = 0
            
            self._callback_count[config.track_id] += 1
            count = self._callback_count[config.track_id]
            
            if count == 1:
                logger.info(f"First ROS2 message received for {config.track_id} (topic: {config.topic})")
                logger.info(f"   Message type: {msg_type.__name__}")
            elif count % 30 == 0:
                logger.info(f"ROS2 callback count for {config.track_id}: {count}")
            
            # Decode based on message type
            if msg_type.__name__ == 'CompressedImage':
                if count == 1:
                    logger.info(f"   Message format: {msg.format}, data size: {len(msg.data)} bytes")
                np_arr = np.frombuffer(msg.data, np.uint8)
                frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
            else:
                # Raw Image message
                if count == 1:
                    logger.info(f"   Image size: {msg.width}x{msg.height}, encoding: {msg.encoding}")
                
                # Convert based on encoding
                if msg.encoding == 'rgb8':
                    frame = np.frombuffer(msg.data, dtype=np.uint8).reshape((msg.height, msg.width, 3))
                    frame = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
                elif msg.encoding == 'bgr8':
                    frame = np.frombuffer(msg.data, dtype=np.uint8).reshape((msg.height, msg.width, 3))
                elif msg.encoding == 'mono8':
                    frame = np.frombuffer(msg.data, dtype=np.uint8).reshape((msg.height, msg.width))
                    frame = cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)
                elif msg.encoding in ['16UC1', 'mono16']:
                    # Depth image - normalize to 8-bit
                    frame = np.frombuffer(msg.data, dtype=np.uint16).reshape((msg.height, msg.width))
                    frame = cv2.normalize(frame, None, 0, 255, cv2.NORM_MINMAX, dtype=cv2.CV_8U)
                    frame = cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)
                else:
                    logger.warning(f"Unknown encoding: {msg.encoding}, trying to decode as BGR")
                    try:
                        frame = np.frombuffer(msg.data, dtype=np.uint8).reshape((msg.height, msg.width, 3))
                    except:
                        logger.error(f"Cannot decode encoding: {msg.encoding}")
                        return
            
            if frame is not None:
                if count == 1:
                    logger.info(f"   Decoded frame: {frame.shape}")
                
                # Resize if needed
                if frame.shape[1] != config.width or frame.shape[0] != config.height:
                    frame = cv2.resize(frame, (config.width, config.height))
                
                # Update the track
                track = self.publisher.tracks.get(config.track_id)
                if track:
                    track.update_frame(frame)
                    if count == 1:
                        logger.info(f"   Frame passed to track {config.track_id}")
                else:
                    if count == 1:
                        logger.error(f"   Track {config.track_id} not found in publisher.tracks!")
                        logger.error(f"   Available tracks: {list(self.publisher.tracks.keys())}")
            else:
                if count == 1 or count % 100 == 0:
                    logger.warning(f"Failed to decode frame for {config.track_id}")
                    
        except Exception as e:
            logger.error(f"Error processing image for {config.track_id}: {e}")
            import traceback
            traceback.print_exc()
    
    def spin(self):
        """Spin ROS2 node"""
        rclpy.spin(self.node)
    
    def shutdown(self):
        """Shutdown ROS2"""
        if self.node:
            self.node.destroy_node()
        rclpy.shutdown()


def parse_stream_args(args) -> List[StreamConfig]:
    """Parse stream arguments into StreamConfig objects"""
    streams = []
    
    # Parse topics and track IDs
    topics = args.topic if isinstance(args.topic, list) else [args.topic]
    track_ids = args.track_id if isinstance(args.track_id, list) else [args.track_id]
    
    # Ensure we have matching topics and track IDs
    if len(track_ids) < len(topics):
        # Auto-generate track IDs if not enough provided
        for i in range(len(track_ids), len(topics)):
            track_ids.append(f"cam_{i}")
    
    for i, topic in enumerate(topics):
        streams.append(StreamConfig(
            topic=topic,
            track_id=track_ids[i] if i < len(track_ids) else f"cam_{i}",
            width=args.width,
            height=args.height,
            fps=args.fps,
            codec=args.codec
        ))
    
    return streams


async def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description='ROS2 WebRTC Publisher with configurable codec support',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Simulation mode with H.264
  python ros2_webrtc_publisher.py --simulate --codec h264

  # Connect to custom server with VP8
  python ros2_webrtc_publisher.py --server wss://192.168.1.100:8443/ws --codec vp8

  # Multiple camera topics
  python ros2_webrtc_publisher.py --topic /cam1/image/compressed --topic /cam2/image/compressed --track-id cam_front --track-id cam_rear

  # Custom resolution
  python ros2_webrtc_publisher.py --simulate --width 1280 --height 720 --fps 30
'''
    )
    
    # Server configuration
    parser.add_argument('--server', '-s', default='wss://0.0.0.0:8443/ws',
                       help='SFU server WebSocket URL (default: wss://0.0.0.0:8443/ws)')
    parser.add_argument('--host', default='0.0.0.0',
                       help='Server host (convenience flag, used to construct server URL)')
    parser.add_argument('--port', '-p', default='8443',
                       help='Server port (convenience flag, used to construct server URL)')
    
    # Stream configuration
    parser.add_argument('--topic', '-t', action='append', default=[],
                       help='ROS2 topic to subscribe to (can specify multiple)')
    parser.add_argument('--track-id', '-i', action='append', default=[],
                       help='Track ID for the stream (can specify multiple)')
    
    # Video configuration
    parser.add_argument('--width', '-W', type=int, default=640,
                       help='Video width (default: 640)')
    parser.add_argument('--height', '-H', type=int, default=480,
                       help='Video height (default: 480)')
    parser.add_argument('--fps', '-f', type=int, default=30,
                       help='Video FPS (default: 30)')
    
    # Codec configuration
    parser.add_argument('--codec', '-c', choices=['h264', 'vp8', 'vp9', 'h265'],
                       default='h264',
                       help='Video codec (default: h264)')
    
    # Mode
    parser.add_argument('--simulate', action='store_true',
                       help='Run in simulation mode (no ROS2 required)')
    
    args = parser.parse_args()
    
    # Construct server URL if host/port specified but server not overridden
    if args.server == 'wss://0.0.0.0:8443/ws' and (args.host != '0.0.0.0' or args.port != '8443'):
        args.server = f'wss://{args.host}:{args.port}/ws'
    
    # Default topic if none specified
    if not args.topic:
        args.topic = ['/camera1/image_raw/compressed']
    
    # Default track ID if none specified
    if not args.track_id:
        args.track_id = ['cam_front']
    
    # Parse streams
    streams = parse_stream_args(args)
    
    # Determine mode
    simulation_mode = args.simulate or not ROS2_AVAILABLE
    if simulation_mode and not args.simulate:
        logger.warning("ROS2 not available, forcing simulation mode")
    
    # Create publisher
    publisher = WebRTCPublisher(
        server_url=args.server,
        streams=streams,
        simulation_mode=simulation_mode
    )
    
    # Print configuration
    print("\n" + "="*60)
    print("ROS2 WebRTC Publisher")
    print("="*60)
    print(f"Server: {args.server}")
    print(f"Codec:  {args.codec.upper()}")
    print(f"Mode:   {'SIMULATION' if simulation_mode else 'ROS2'}")
    print(f"Resolution: {args.width}x{args.height} @ {args.fps}fps")
    print("-"*60)
    print("Streams:")
    for s in streams:
        print(f"   - {s.track_id}: {s.topic}")
    print("="*60 + "\n")
    
    try:
        if simulation_mode:
            await publisher.run()
        else:
            logger.info("Setting up ROS2 subscribers...")
            ros2_node = ROS2SubscriberNode(publisher)
            ros2_node.init()
            
            # Run WebRTC in main thread, ROS2 in background
            import threading
            ros2_thread = threading.Thread(target=ros2_node.spin, daemon=True)
            ros2_thread.start()
            
            await publisher.run()
            
            ros2_node.shutdown()
            
    except KeyboardInterrupt:
        logger.info("\nGoodbye!")
    finally:
        publisher.stop()


if __name__ == "__main__":
    asyncio.run(main())