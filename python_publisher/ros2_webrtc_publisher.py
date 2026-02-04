#!/usr/bin/env python3
"""
ROS2 WebRTC Publisher with:
1. Frame ID correlation (frame_id + capture_ms embedded in metrics)
2. SCReAM congestion control (dynamic multi-stream)
3. Works with EXISTING Go relay (no Go changes needed)

KEY FIX: frame_id and capture_ms are sent INSIDE the 'metrics' message
that Go already knows how to forward. No new message types!
"""

import asyncio
import json
import logging
import ssl
import time
import argparse
import threading
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Deque
from fractions import Fraction
from collections import deque
import numpy as np

from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer
from aiortc.contrib.media import MediaStreamTrack
from av import VideoFrame

import websockets
from websockets.exceptions import ConnectionClosed

import cv2

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

try:
    import rclpy
    from rclpy.node import Node
    from sensor_msgs.msg import CompressedImage
    ROS2_AVAILABLE = True
except ImportError:
    ROS2_AVAILABLE = False
    logger.warning("ROS2 not available, running in simulation mode")


CODEC_CONFIGS = {
    'h264': {'mime_type': 'video/H264', 'clock_rate': 90000},
    'vp8': {'mime_type': 'video/VP8', 'clock_rate': 90000},
    'vp9': {'mime_type': 'video/VP9', 'clock_rate': 90000},
    'h265': {'mime_type': 'video/H265', 'clock_rate': 90000},
}


# ══════════════════════════════════════════════════════════════════════════════════════
# SCReAM CONGESTION CONTROL
# ══════════════════════════════════════════════════════════════════════════════════════
#
# SCReAM (Self-Clocked Rate Adaptation for Multimedia)
#
# ALGORITHM:
# ──────────
# 1. DELAY GRADIENT (primary signal):
#    gradient = (current_OWD - baseline_OWD) / baseline_OWD
#    gradient > threshold → queues building → REDUCE rate
#
# 2. RATE ADJUSTMENT:
#    Congestion:    rate_new = rate_old × (1 - β)     [Multiplicative Decrease]
#    No congestion: rate_new = rate_old × (1 + α)     [Additive Increase]
#    β = 0.1 (mild) to 0.3 (severe), α = 0.05
#
# 3. MULTI-STREAM FAIR SHARING:
#    max_rate_i = total_bandwidth × priority_i / Σ(priorities)
#    Streams added/removed → redistribute dynamically
#
# ══════════════════════════════════════════════════════════════════════════════════════

@dataclass
class SCReAMState:
    """Per-stream congestion control state"""
    target_bitrate: int = 2_000_000
    min_bitrate: int = 100_000
    max_bitrate: int = 8_000_000
    base_owd: Optional[float] = None
    owd_samples: Deque = field(default_factory=lambda: deque(maxlen=20))
    delay_gradient: float = 0.0
    loss_fraction: float = 0.0
    rtt_samples: Deque = field(default_factory=lambda: deque(maxlen=20))
    avg_rtt: float = 50.0
    state: str = 'INCREASE'
    stable_count: int = 0
    last_update: float = 0.0
    priority: float = 1.0


class SCReAMController:
    """
    Multi-stream SCReAM congestion controller.
    Dynamically adjusts bitrates based on delay gradient and loss.
    """
    
    DELAY_GRADIENT_THRESHOLD = 0.1
    LOSS_THRESHOLD = 0.02
    DECREASE_FACTOR_MILD = 0.1
    DECREASE_FACTOR_SEVERE = 0.3
    INCREASE_FACTOR = 0.05
    STABLE_THRESHOLD = 5
    
    def __init__(self, total_max_bitrate: int = 20_000_000):
        self.total_max_bitrate = total_max_bitrate
        self.streams: Dict[str, SCReAMState] = {}
        self._lock = threading.Lock()
        logger.info(f"🚦 SCReAM initialized (max total: {total_max_bitrate/1e6:.1f} Mbps)")
    
    def add_stream(self, stream_id: str, initial_bitrate: int = 2_000_000, priority: float = 1.0):
        with self._lock:
            self.streams[stream_id] = SCReAMState(
                target_bitrate=initial_bitrate,
                priority=priority,
                last_update=time.time()
            )
            self._redistribute_bandwidth()
            logger.info(f"Added stream '{stream_id}' (priority={priority})")
    
    def remove_stream(self, stream_id: str):
        with self._lock:
            if stream_id in self.streams:
                del self.streams[stream_id]
                self._redistribute_bandwidth()
                logger.info(f"Removed stream '{stream_id}'")
    
    def _redistribute_bandwidth(self):
        """Fair share: max_rate_i = total × priority_i / Σ priorities"""
        if not self.streams:
            return
        total_priority = sum(s.priority for s in self.streams.values())
        for stream_id, state in self.streams.items():
            fair_share = self.total_max_bitrate * (state.priority / total_priority)
            state.max_bitrate = int(fair_share)
            state.target_bitrate = min(state.target_bitrate, state.max_bitrate)
            logger.info(f"   {stream_id}: max={fair_share/1e6:.2f}Mbps")
    
    def process_rtcp_feedback(self, stream_id: str, rtt_ms: float, loss_fraction: float,
                               jitter_ms: float = 0):
        with self._lock:
            if stream_id not in self.streams:
                return
            state = self.streams[stream_id]
            
            # Update RTT
            state.rtt_samples.append(rtt_ms)
            state.avg_rtt = sum(state.rtt_samples) / len(state.rtt_samples)
            
            # One-way delay estimate
            owd = rtt_ms / 2
            state.owd_samples.append(owd)
            if state.base_owd is None or owd < state.base_owd:
                state.base_owd = owd
            
            state.loss_fraction = loss_fraction
            
            # Delay gradient
            if len(state.owd_samples) >= 3:
                recent = sum(list(state.owd_samples)[-3:]) / 3
                state.delay_gradient = (recent - state.base_owd) / max(state.base_owd, 1)
            
            old_bitrate = state.target_bitrate
            has_loss = loss_fraction > self.LOSS_THRESHOLD
            has_delay = state.delay_gradient > self.DELAY_GRADIENT_THRESHOLD
            
            if has_loss:
                # Severe: multiplicative decrease 30%
                state.state = 'DECREASE'
                state.target_bitrate = int(state.target_bitrate * (1 - self.DECREASE_FACTOR_SEVERE))
                state.stable_count = 0
                logger.warning(f" {stream_id}: LOSS {loss_fraction*100:.1f}% → {state.target_bitrate/1e6:.2f}Mbps")
            elif has_delay:
                # Mild: multiplicative decrease 10%
                state.state = 'DECREASE'
                state.target_bitrate = int(state.target_bitrate * (1 - self.DECREASE_FACTOR_MILD))
                state.stable_count = 0
                logger.info(f" {stream_id}: Delay↑ → {state.target_bitrate/1e6:.2f}Mbps")
            else:
                # No congestion: additive increase 5%
                state.stable_count += 1
                if state.stable_count >= self.STABLE_THRESHOLD:
                    state.state = 'INCREASE'
                    state.target_bitrate = int(state.target_bitrate * (1 + self.INCREASE_FACTOR))
                else:
                    state.state = 'STABLE'
            
            state.target_bitrate = max(state.min_bitrate, min(state.max_bitrate, state.target_bitrate))
            state.last_update = time.time()
    
    def get_target_bitrate(self, stream_id: str) -> int:
        with self._lock:
            return self.streams[stream_id].target_bitrate if stream_id in self.streams else 2_000_000
    
    def get_all_bitrates(self) -> Dict[str, int]:
        with self._lock:
            return {sid: s.target_bitrate for sid, s in self.streams.items()}
    
    def get_stats(self) -> Dict:
        with self._lock:
            total = sum(s.target_bitrate for s in self.streams.values())
            return {
                'stream_count': len(self.streams),
                'total_bitrate': total,
                'streams': {
                    sid: {
                        'bitrate': s.target_bitrate,
                        'max_bitrate': s.max_bitrate,
                        'state': s.state,
                        'delay_gradient': s.delay_gradient,
                        'loss': s.loss_fraction,
                        'rtt': s.avg_rtt,
                    }
                    for sid, s in self.streams.items()
                }
            }


# ══════════════════════════════════════════════════════════════════════════════════════
# VIDEO TRACK
# ══════════════════════════════════════════════════════════════════════════════════════

@dataclass
class StreamConfig:
    topic: str
    track_id: str
    width: int = 640
    height: int = 480
    fps: int = 30
    codec: str = 'h264'


@dataclass
class ConnectionState:
    pc: Optional[RTCPeerConnection] = None
    client_id: Optional[str] = None
    is_connected: bool = False
    is_negotiating: bool = False
    pending_candidates: list = field(default_factory=list)
    offer_sent: bool = False
    answer_received: bool = False


class ROS2VideoTrack(MediaStreamTrack):
    """Video track with frame_id for timestamp correlation"""
    kind = "video"
    
    def __init__(self, config: StreamConfig, simulation_mode: bool = False):
        super().__init__()
        self._track_id = config.track_id
        self.config = config
        self.simulation_mode = simulation_mode
        self._timestamp = 0
        self._frame_count = 0
        self._frame_id = 0              # Correlation key!
        self._start_time = time.time()
        self._latest_frame: Optional[np.ndarray] = None
        
        self._frame_lock = threading.Lock()
        self._frame_ready = threading.Event()
        self._loop = None
        self._recv_started = False
        
        # Timing
        self._ros_receive_time: Optional[float] = None
        self._last_ros_latency: float = 0.0
        self._last_encoding_latency: float = 0.0
        self._capture_time_ms: float = 0.0
        
        if simulation_mode:
            self._sim_task = None
        
        logger.info(f"Created video track: {config.track_id} (codec: {config.codec})")
    
    @property
    def id(self) -> str:
        return self._track_id
    
    def set_loop(self, loop):
        self._loop = loop
    
    def get_metrics(self) -> dict:
        """Get timing metrics INCLUDING frame_id and capture_ms for correlation"""
        return {
            'ros_latency': self._last_ros_latency * 1000,
            'encoding_latency': self._last_encoding_latency * 1000,
            'frame_count': self._frame_count,
            # ═══ NEW: Frame correlation data ═══
            # Browser stores these and matches when video displays
            'frame_id': self._frame_id,
            'capture_ms': self._capture_time_ms,
        }
    
    def update_frame(self, frame: np.ndarray):
        """Update with new frame from ROS2 callback"""
        receive_time = time.time()
        with self._frame_lock:
            self._latest_frame = frame.copy()
            self._ros_receive_time = receive_time
            self._frame_ready.set()
        
        if not hasattr(self, '_ros_frame_count'):
            self._ros_frame_count = 0
        self._ros_frame_count += 1
        if self._ros_frame_count == 1:
            logger.info(f"First ROS2 frame for {self.config.track_id}")
        elif self._ros_frame_count % 30 == 0:
            logger.info(f"ROS2 frames for {self.config.track_id}: {self._ros_frame_count}")
    
    async def start_simulation(self):
        if self._sim_task is None:
            logger.info(f"Starting simulation for {self.config.track_id}")
            self._sim_task = asyncio.create_task(self._simulation_loop())
            await asyncio.sleep(0.1)
    
    async def _simulation_loop(self):
        colors = [(66, 133, 244), (52, 168, 83), (251, 188, 4), (234, 67, 53)]
        color_idx = 0
        frame_interval = 1.0 / self.config.fps
        sim_count = 0
        
        while True:
            try:
                frame = np.zeros((self.config.height, self.config.width, 3), dtype=np.uint8)
                for y in range(self.config.height):
                    ratio = y / self.config.height
                    color = colors[color_idx % len(colors)]
                    frame[y, :] = [int(c * (0.3 + 0.7 * ratio)) for c in color]
                color_idx += 1
                
                overlay = frame.copy()
                cv2.rectangle(overlay, (20, 20), (self.config.width - 20, 160), (0, 0, 0), -1)
                frame = cv2.addWeighted(overlay, 0.5, frame, 0.5, 0)
                
                cv2.putText(frame, f"Track: {self.config.track_id}", (40, 60),
                           cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
                cv2.putText(frame, f"Codec: {self.config.codec.upper()}", (40, 95),
                           cv2.FONT_HERSHEY_SIMPLEX, 0.7, (200, 200, 200), 2)
                cv2.putText(frame, f"Frame: {sim_count}", (40, 130),
                           cv2.FONT_HERSHEY_SIMPLEX, 0.6, (180, 180, 180), 1)
                
                x = int((sim_count * 3) % (self.config.width - 60)) + 30
                cv2.circle(frame, (x, self.config.height - 50), 20, (255, 255, 255), -1)
                
                with self._frame_lock:
                    self._latest_frame = frame
                    self._ros_receive_time = time.time()
                    self._frame_ready.set()
                
                sim_count += 1
                await asyncio.sleep(frame_interval)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Simulation error: {e}")
                await asyncio.sleep(0.1)
    
    async def recv(self) -> VideoFrame:
        if self.simulation_mode and self._sim_task is None:
            await self.start_simulation()
        
        if not self._recv_started:
            self._recv_started = True
            logger.info(f"recv() called for {self.config.track_id}")
        
        pts_increment = 90000 // self.config.fps
        frame = None
        ros_receive_time = None
        
        for _ in range(10):
            if self._frame_ready.wait(timeout=0.01):
                with self._frame_lock:
                    if self._latest_frame is not None:
                        frame = self._latest_frame.copy()
                        ros_receive_time = self._ros_receive_time
                    self._frame_ready.clear()
                break
            await asyncio.sleep(0.001)
        
        if frame is None and self.simulation_mode:
            if self._frame_ready.wait(timeout=0.05):
                with self._frame_lock:
                    if self._latest_frame is not None:
                        frame = self._latest_frame.copy()
                        ros_receive_time = self._ros_receive_time
                    self._frame_ready.clear()
        
        if ros_receive_time is not None:
            self._last_ros_latency = time.time() - ros_receive_time
        
        if frame is None:
            frame = np.zeros((self.config.height, self.config.width, 3), dtype=np.uint8)
            cv2.putText(frame, "No Signal", (self.config.width // 2 - 80, self.config.height // 2),
                       cv2.FONT_HERSHEY_SIMPLEX, 1.2, (128, 128, 128), 2)
        
        encode_start = time.time()
        
        # ════════════════════════════════════════════════════════════════════════
        # CRITICAL: Increment frame_id and record capture time HERE
        # This is the EXACT moment the frame enters the WebRTC pipeline
        # Browser will use this to calculate glass-to-glass latency
        # ════════════════════════════════════════════════════════════════════════
        self._frame_id += 1
        self._capture_time_ms = time.time() * 1000  # Milliseconds for browser
        
        video_frame = VideoFrame.from_ndarray(frame, format="bgr24")
        video_frame.pts = self._timestamp
        video_frame.time_base = Fraction(1, 90000)
        
        self._last_encoding_latency = time.time() - encode_start
        self._timestamp += pts_increment
        self._frame_count += 1
        
        if self._frame_count == 1:
            logger.info(f"First frame sent: {self.config.track_id}")
        elif self._frame_count % 30 == 0:
            logger.info(f"Track {self.config.track_id}: {self._frame_count} frames sent")
        
        return video_frame
    
    def stop(self):
        super().stop()
        if hasattr(self, '_sim_task') and self._sim_task:
            self._sim_task.cancel()


# ══════════════════════════════════════════════════════════════════════════════════════
# PUBLISHER
# ══════════════════════════════════════════════════════════════════════════════════════

class WebRTCPublisher:
    """WebRTC publisher with SCReAM and frame_id correlation"""
    
    def __init__(self, server_url: str, streams: List[StreamConfig], simulation_mode: bool = False):
        self.server_url = server_url
        self.streams = streams
        self.simulation_mode = simulation_mode
        
        self.state: Optional[ConnectionState] = None
        self.tracks: Dict[str, ROS2VideoTrack] = {}
        self.ws = None
        self.data_channel = None
        self._metrics_task = None
        self._running = False
        self._reconnect_delay = 2.0
        self._max_reconnect_delay = 30.0
        
        # SCReAM controller
        self.scream = SCReAMController(total_max_bitrate=20_000_000)
        self._rtcp_task = None
        
        self.ice_config = RTCConfiguration(
            iceServers=[
                RTCIceServer(urls=["stun:stun.l.google.com:19302"]),
                RTCIceServer(urls=["stun:stun1.l.google.com:19302"]),
            ]
        )
    
    async def _send_metrics_loop(self):
        """
        Send metrics via WebSocket at 10Hz.
        
        IMPORTANT: frame_id and capture_ms are embedded IN the metrics message.
        This uses the existing 'metrics' message type that Go already forwards!
        No new message types needed = no Go changes needed.
        """
        logger.info("Starting metrics loop (with frame_id correlation data)")
        while self._running:
            try:
                if self.ws and self.state and self.state.is_connected:
                    metrics_data = {}
                    for track_id, track in self.tracks.items():
                        metrics_data[track_id] = track.get_metrics()
                        # get_metrics() now includes frame_id and capture_ms!
                    
                    message = json.dumps({
                        "type": "metrics",          # Same type Go already handles!
                        "timestamp": time.time(),
                        "data": metrics_data         # Contains frame_id + capture_ms per track
                    })
                    await self.ws.send(message)
                
                await asyncio.sleep(0.1)
            except Exception as e:
                logger.debug(f"Metrics send error: {e}")
                await asyncio.sleep(1.0)
    
    async def _rtcp_monitor_loop(self):
        """Monitor RTCP stats and feed to SCReAM controller"""
        logger.info(" Starting RTCP monitoring for SCReAM")
        while self._running:
            try:
                if self.state and self.state.pc:
                    stats = await self.state.pc.getStats()
                    
                    for report in stats.values():
                        if hasattr(report, 'type') and report.type == 'outbound-rtp':
                            if hasattr(report, 'kind') and report.kind == 'video':
                                rtt = getattr(report, 'roundTripTime', 0.05) * 1000
                                packets_sent = getattr(report, 'packetsSent', 0)
                                packets_lost = getattr(report, 'packetsLost', 0)
                                loss = packets_lost / max(packets_sent, 1)
                                
                                for track_id in self.tracks:
                                    self.scream.process_rtcp_feedback(
                                        stream_id=track_id,
                                        rtt_ms=rtt,
                                        loss_fraction=loss
                                    )
                
                await asyncio.sleep(0.5)
            except Exception as e:
                logger.debug(f"RTCP monitor error: {e}")
                await asyncio.sleep(1.0)
    
    def _create_fresh_state(self) -> ConnectionState:
        return ConnectionState()
    
    async def _create_peer_connection(self) -> RTCPeerConnection:
        pc = RTCPeerConnection(configuration=self.ice_config)
        
        @pc.on("connectionstatechange")
        async def on_state():
            logger.info(f"Connection state: {pc.connectionState}")
            if pc.connectionState == "connected":
                if self.state:
                    self.state.is_connected = True
                    self.state.is_negotiating = False
                if self._metrics_task is None or self._metrics_task.done():
                    self._metrics_task = asyncio.create_task(self._send_metrics_loop())
                if self._rtcp_task is None or self._rtcp_task.done():
                    self._rtcp_task = asyncio.create_task(self._rtcp_monitor_loop())
            elif pc.connectionState in ("failed", "closed"):
                if self.state:
                    self.state.is_connected = False
        
        @pc.on("iceconnectionstatechange")
        async def on_ice():
            logger.info(f"ICE state: {pc.iceConnectionState}")
        
        @pc.on("icecandidate")
        async def on_candidate(candidate):
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
                except Exception as e:
                    logger.error(f"Failed to send ICE candidate: {e}")
        
        return pc
    
    def _create_tracks(self):
        loop = asyncio.get_event_loop()
        for config in self.streams:
            track = ROS2VideoTrack(config, self.simulation_mode)
            track.set_loop(loop)
            self.tracks[config.track_id] = track
            self.scream.add_stream(config.track_id, initial_bitrate=2_000_000, priority=1.0)
    
    async def _cleanup_connection(self):
        if self._metrics_task and not self._metrics_task.done():
            self._metrics_task.cancel()
            self._metrics_task = None
        if self._rtcp_task and not self._rtcp_task.done():
            self._rtcp_task.cancel()
            self._rtcp_task = None
        if self.state and self.state.pc:
            try:
                await self.state.pc.close()
            except:
                pass
        self.state = None
    
    async def _setup_webrtc(self):
        await self._cleanup_connection()
        self.state = self._create_fresh_state()
        self.state.pc = await self._create_peer_connection()
        
        for track_id, track in self.tracks.items():
            sender = self.state.pc.addTrack(track)
            logger.info(f"Added track: {track_id} - sender: {sender}")
    
    async def _send_offer(self):
        if not self.state or not self.state.pc:
            return
        if self.state.is_negotiating or (self.state.offer_sent and not self.state.answer_received):
            return
        
        self.state.is_negotiating = True
        self.state.offer_sent = False
        self.state.answer_received = False
        self.state.pending_candidates = []
        
        try:
            offer = await self.state.pc.createOffer()
            await self.state.pc.setLocalDescription(offer)
            
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
    
    async def _handle_answer(self, sdp):
        if not self.state or not self.state.pc or not self.state.offer_sent or self.state.answer_received:
            return
        
        try:
            sdp_str = sdp.get('sdp', '') if isinstance(sdp, dict) else sdp
            if not sdp_str:
                return
            answer = RTCSessionDescription(sdp=sdp_str, type="answer")
            await self.state.pc.setRemoteDescription(answer)
            self.state.answer_received = True
            logger.info("Set remote description (answer)")
            
            for candidate in self.state.pending_candidates:
                try:
                    await self.state.pc.addIceCandidate(candidate)
                except:
                    pass
            self.state.pending_candidates = []
            self.state.is_negotiating = False
        except Exception as e:
            logger.error(f"Failed to set remote description: {e}")
            self.state.is_negotiating = False
    
    async def _handle_ice_candidate(self, candidate_data: dict):
        if not self.state or not self.state.pc:
            return
        try:
            from aiortc import RTCIceCandidate
            candidate = RTCIceCandidate(
                sdpMid=candidate_data.get("sdpMid"),
                sdpMLineIndex=candidate_data.get("sdpMLineIndex"),
                candidate=candidate_data.get("candidate")
            )
            if not self.state.answer_received:
                self.state.pending_candidates.append(candidate)
            else:
                await self.state.pc.addIceCandidate(candidate)
        except Exception as e:
            logger.warning(f"ICE candidate error: {e}")
    
    async def _handle_message(self, message: str):
        try:
            data = json.loads(message)
            msg_type = data.get("type")
            
            if msg_type == "joined":
                self.state.client_id = data.get("client_id")
                logger.info(f"Joined as: {self.state.client_id}")
                await asyncio.sleep(0.1)
                await self._send_offer()
            elif msg_type == "answer":
                await self._handle_answer(data.get("sdp"))
            elif msg_type == "ice":
                await self._handle_ice_candidate(data.get("candidate", {}))
            elif msg_type == "error":
                logger.error(f"Server error: {data.get('message')}")
                if "ice-ufrag" in str(data.get('message', '')):
                    await self._cleanup_connection()
            elif msg_type == "streams":
                logger.info(f"Available streams: {data.get('streams', [])}")
            else:
                logger.debug(f"Unknown message type: {msg_type}")
        except json.JSONDecodeError:
            logger.error(f"Invalid JSON")
        except Exception as e:
            logger.error(f"Message handling error: {e}")
    
    async def _connect(self):
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
        await self._setup_webrtc()
        
        if self.simulation_mode:
            for track in self.tracks.values():
                await track.start_simulation()
        
        await self.ws.send(json.dumps({
            "type": "join",
            "role": "publisher",
            "streams": [
                {"id": config.track_id, "topic": config.topic}
                for config in self.streams
            ]
        }))
        logger.info("Sent join as publisher")
        
        try:
            async for message in self.ws:
                await self._handle_message(message)
        except ConnectionClosed as e:
            logger.warning(f"WebSocket closed: {e}")
        except Exception as e:
            logger.error(f"Error: {e}")
    
    async def run(self):
        self._running = True
        reconnect_delay = self._reconnect_delay
        
        if not self.tracks:
            self._create_tracks()
        
        while self._running:
            try:
                if await self._connect():
                    reconnect_delay = self._reconnect_delay
                    await self._run_connection()
            except Exception as e:
                logger.error(f"Connection error: {e}")
            finally:
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
        self._running = False
        for track in self.tracks.values():
            track.stop()


# ══════════════════════════════════════════════════════════════════════════════════════
# ROS2 SUBSCRIBER
# ══════════════════════════════════════════════════════════════════════════════════════

class ROS2SubscriberNode:
    def __init__(self, publisher: WebRTCPublisher):
        self.publisher = publisher
        self.node = None
    
    def init(self):
        rclpy.init()
        self.node = rclpy.create_node('webrtc_publisher')
        
        for config in self.publisher.streams:
            if config.topic.endswith('/compressed'):
                msg_type = CompressedImage
            else:
                try:
                    from sensor_msgs.msg import Image
                    msg_type = Image
                except ImportError:
                    msg_type = CompressedImage
            
            self.node.create_subscription(
                msg_type, config.topic,
                lambda msg, cfg=config, mt=msg_type: self._callback(msg, cfg, mt),
                10
            )
            logger.info(f"Subscribed to {config.topic}")
    
    def _callback(self, msg, config, msg_type):
        try:
            if msg_type.__name__ == 'CompressedImage':
                np_arr = np.frombuffer(msg.data, np.uint8)
                frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
            else:
                if msg.encoding in ('rgb8',):
                    frame = np.frombuffer(msg.data, np.uint8).reshape((msg.height, msg.width, 3))
                    frame = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
                elif msg.encoding in ('bgr8',):
                    frame = np.frombuffer(msg.data, np.uint8).reshape((msg.height, msg.width, 3))
                elif msg.encoding in ('mono8',):
                    frame = np.frombuffer(msg.data, np.uint8).reshape((msg.height, msg.width))
                    frame = cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)
                else:
                    frame = np.frombuffer(msg.data, np.uint8).reshape((msg.height, msg.width, 3))
            
            if frame is not None:
                if frame.shape[1] != config.width or frame.shape[0] != config.height:
                    frame = cv2.resize(frame, (config.width, config.height))
                track = self.publisher.tracks.get(config.track_id)
                if track:
                    track.update_frame(frame)
        except Exception as e:
            logger.error(f"Image processing error: {e}")
    
    def spin(self):
        rclpy.spin(self.node)
    
    def shutdown(self):
        if self.node:
            self.node.destroy_node()
        rclpy.shutdown()


# ══════════════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════════════

def parse_stream_args(args) -> List[StreamConfig]:
    streams = []
    topics = args.topic if isinstance(args.topic, list) else [args.topic]
    track_ids = args.track_id if isinstance(args.track_id, list) else [args.track_id]
    
    if len(track_ids) < len(topics):
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
    parser = argparse.ArgumentParser(description='ROS2 WebRTC Publisher with SCReAM')
    parser.add_argument('--server', '-s', default='wss://0.0.0.0:8443/ws')
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--port', '-p', default='8443')
    parser.add_argument('--topic', '-t', action='append', default=[])
    parser.add_argument('--track-id', '-i', action='append', default=[])
    parser.add_argument('--width', '-W', type=int, default=640)
    parser.add_argument('--height', '-H', type=int, default=480)
    parser.add_argument('--fps', '-f', type=int, default=30)
    parser.add_argument('--codec', '-c', choices=['h264', 'vp8', 'vp9', 'h265'], default='h264')
    parser.add_argument('--simulate', action='store_true')
    
    args = parser.parse_args()
    
    if args.server == 'wss://0.0.0.0:8443/ws' and (args.host != '0.0.0.0' or args.port != '8443'):
        args.server = f'wss://{args.host}:{args.port}/ws'
    
    if not args.topic:
        args.topic = ['/camera1/image_raw/compressed']
    if not args.track_id:
        args.track_id = ['cam_front']
    
    streams = parse_stream_args(args)
    simulation_mode = args.simulate or not ROS2_AVAILABLE
    
    publisher = WebRTCPublisher(
        server_url=args.server,
        streams=streams,
        simulation_mode=simulation_mode
    )
    
    print("\n" + "="*60)
    print("ROS2 WebRTC Publisher + SCReAM Congestion Control")
    print("="*60)
    print(f"Server: {args.server}")
    print(f"Codec:  {args.codec.upper()}")
    print(f"Mode:   {'SIMULATION' if simulation_mode else 'ROS2'}")
    print(f"Resolution: {args.width}x{args.height} @ {args.fps}fps")
    print("-"*60)
    for s in streams:
        print(f"   {s.track_id}: {s.topic}")
    print("="*60 + "\n")
    
    try:
        if simulation_mode:
            await publisher.run()
        else:
            ros2_node = ROS2SubscriberNode(publisher)
            ros2_node.init()
            
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