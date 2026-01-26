package main

import (
	"encoding/json"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v3"
)

// SDPMessage can be either a string or an object with type and sdp fields
type SDPMessage struct {
	Type string `json:"type,omitempty"`
	SDP  string `json:"sdp,omitempty"`
}

// UnmarshalJSON handles both string and object SDP formats
func (s *SDPMessage) UnmarshalJSON(data []byte) error {
	// Try as string first
	var sdpStr string
	if err := json.Unmarshal(data, &sdpStr); err == nil {
		s.SDP = sdpStr
		return nil
	}

	// Try as object
	type sdpObj struct {
		Type string `json:"type"`
		SDP  string `json:"sdp"`
	}
	var obj sdpObj
	if err := json.Unmarshal(data, &obj); err != nil {
		return err
	}
	s.Type = obj.Type
	s.SDP = obj.SDP
	return nil
}

// Message types for signaling
type SignalingMessage struct {
	Type      string                   `json:"type"`
	ClientID  string                   `json:"client_id,omitempty"`
	Role      string                   `json:"role,omitempty"`
	SDP       *SDPMessage              `json:"sdp,omitempty"`
	Candidate *webrtc.ICECandidateInit `json:"candidate,omitempty"`
	Streams   []StreamInfo             `json:"streams,omitempty"`
	Message   string                   `json:"message,omitempty"`
	Timestamp float64                  `json:"timestamp,omitempty"`
	Data      json.RawMessage          `json:"data,omitempty"` // For metrics data
}

type StreamInfo struct {
	ID    string `json:"id"`
	Topic string `json:"topic"`
}

// Client represents a connected WebSocket client
type Client struct {
	ID                string
	Conn              *websocket.Conn
	PC                *webrtc.PeerConnection
	Role              string // "publisher" or "viewer"
	Streams           []StreamInfo
	mu                sync.Mutex
	isNegotiating     bool
	pendingCandidates []*webrtc.ICECandidateInit
	remoteDescSet     bool
}

// Global client registry
var (
	clients   = make(map[string]*Client)
	clientsMu sync.RWMutex
)

// ============================================================
// CLOCK SYNCHRONIZATION TYPES AND HANDLER
// ============================================================

// PingMessage represents a clock sync ping from the client
type PingMessage struct {
	Type       string `json:"type"`
	PingID     string `json:"ping_id"`
	ClientTime int64  `json:"client_time"` // Client's timestamp in milliseconds
}

// PongMessage represents the server's response with timestamps
type PongMessage struct {
	Type          string `json:"type"`
	PingID        string `json:"ping_id"`
	ClientTime    int64  `json:"client_time"`    // Echo back client's send time (t1)
	ServerReceive int64  `json:"server_receive"` // Server receive time (t2)
	ServerSend    int64  `json:"server_send"`    // Server send time (t3)
}

// handlePing processes a clock sync ping and sends a pong response
// This implements NTP-style clock synchronization:
//
//	Client                          Server
//	------                          ------
//	t1 (send ping) ----[ping]---->
//	                                t2 (receive ping)
//	                                t3 (send pong)
//	               <----[pong]----
//	t4 (receive pong)
//
// Client calculates:
//   - RTT = (t4 - t1) - (t3 - t2)
//   - Offset = ((t2 - t1) + (t3 - t4)) / 2
func handlePing(client *Client, msgData []byte) {
	// Record server receive time IMMEDIATELY (t2)
	// This must be the first operation for accuracy
	serverReceiveTime := time.Now().UnixMilli()

	// Parse the ping message
	var ping PingMessage
	if err := json.Unmarshal(msgData, &ping); err != nil {
		log.Printf("Failed to parse ping from %s: %v", client.ID, err)
		return
	}

	// Create pong response with all timestamps
	pong := PongMessage{
		Type:          "pong",
		PingID:        ping.PingID,
		ClientTime:    ping.ClientTime,
		ServerReceive: serverReceiveTime,
		ServerSend:    time.Now().UnixMilli(), // t3 - record just before sending
	}

	// Send pong response
	client.mu.Lock()
	err := client.Conn.WriteJSON(pong)
	client.mu.Unlock()

	if err != nil {
		log.Printf("Failed to send pong to %s: %v", client.ID, err)
		return
	}

	// Log occasionally for debugging (not every ping to avoid spam)
	if clockSyncLogCount < 5 || clockSyncLogCount%100 == 0 {
		log.Printf("Clock sync ping from %s: client_t1=%d, server_t2=%d, server_t3=%d",
			client.ID, ping.ClientTime, serverReceiveTime, pong.ServerSend)
	}
	clockSyncLogCount++
}

var clockSyncLogCount int64

// ============================================================
// WEBSOCKET SIGNALING HANDLER
// ============================================================

// handleSignaling handles WebSocket signaling for a single connection
func handleSignaling(ws *websocket.Conn) {
	clientID := uuid.New().String()
	client := &Client{
		ID:                clientID,
		Conn:              ws,
		pendingCandidates: make([]*webrtc.ICECandidateInit, 0),
	}

	// Register client
	clientsMu.Lock()
	clients[clientID] = client
	clientsMu.Unlock()

	log.Printf("📱 Client connected: %s", clientID)

	defer func() {
		removeClient(clientID)
		log.Printf("Client disconnected: %s", clientID)
	}()

	// Message handling loop
	for {
		_, msg, err := ws.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			break
		}

		var message SignalingMessage
		if err := json.Unmarshal(msg, &message); err != nil {
			log.Printf("Invalid message: %v", err)
			continue
		}

		// Handle message (pass raw bytes for ping to preserve timing accuracy)
		handleMessage(client, &message, msg)
	}
}

// handleMessage processes incoming signaling messages
func handleMessage(client *Client, msg *SignalingMessage, rawMsg []byte) {
	switch msg.Type {
	// ============================================================
	// CLOCK SYNC - Handle ping messages for time synchronization
	// ============================================================
	case "ping":
		handlePing(client, rawMsg)

	// Standard signaling messages
	case "join":
		handleJoin(client, msg)
	case "offer":
		handleOffer(client, msg)
	case "answer":
		handleAnswer(client, msg)
	case "ice", "candidate":
		handleICE(client, msg)
	case "metrics":
		handleMetrics(client, msg)
	default:
		log.Printf("Unknown message type: %s", msg.Type)
	}
}

// handleJoin processes join requests
func handleJoin(client *Client, msg *SignalingMessage) {
	client.mu.Lock()
	client.Role = msg.Role
	client.Streams = msg.Streams
	client.mu.Unlock()

	log.Printf("Client %s joined as %s", client.ID, msg.Role)

	// Send joined confirmation
	response := SignalingMessage{
		Type:     "joined",
		ClientID: client.ID,
	}

	// For viewers, include available streams
	if msg.Role == "viewer" {
		streams := getAvailableStreams()
		response.Streams = make([]StreamInfo, len(streams))
		for i, s := range streams {
			response.Streams[i] = StreamInfo{ID: s, Topic: s}
		}
	}

	sendToClient(client, &response)
}

// handleOffer processes SDP offers
func handleOffer(client *Client, msg *SignalingMessage) {
	client.mu.Lock()

	// If we already have a peer connection, close it first
	// This prevents "multiple conflicting ice-ufrag values" errors
	if client.PC != nil {
		log.Printf("Closing existing peer connection for client %s", client.ID)
		oldPC := client.PC
		client.PC = nil
		client.isNegotiating = false
		client.remoteDescSet = false
		client.pendingCandidates = make([]*webrtc.ICECandidateInit, 0)
		client.mu.Unlock()

		// Close the old peer connection outside the lock
		if err := oldPC.Close(); err != nil {
			log.Printf("Error closing old PC: %v", err)
		}

		client.mu.Lock()
	}

	client.isNegotiating = true
	role := client.Role
	client.mu.Unlock()

	log.Printf("Received offer from %s (role: %s)", client.ID, role)

	// Validate SDP
	if msg.SDP == nil || msg.SDP.SDP == "" {
		log.Printf("No SDP in offer from %s", client.ID)
		sendError(client, "No SDP in offer")
		client.mu.Lock()
		client.isNegotiating = false
		client.mu.Unlock()
		return
	}

	// Create new peer connection
	pc, err := api.NewPeerConnection(getWebRTCConfig())
	if err != nil {
		log.Printf("Failed to create peer connection: %v", err)
		sendError(client, "Failed to create peer connection: "+err.Error())
		client.mu.Lock()
		client.isNegotiating = false
		client.mu.Unlock()
		return
	}

	client.mu.Lock()
	client.PC = pc
	client.mu.Unlock()

	// Setup based on role
	if role == "publisher" {
		if err := handlePublisher(pc, client.ID); err != nil {
			log.Printf("Failed to setup publisher: %v", err)
			sendError(client, "Failed to setup publisher: "+err.Error())
			pc.Close()
			client.mu.Lock()
			client.PC = nil
			client.isNegotiating = false
			client.mu.Unlock()
			return
		}
	} else {
		if err := handleViewer(pc, client.ID); err != nil {
			log.Printf("Failed to setup viewer: %v", err)
			sendError(client, "Failed to setup viewer: "+err.Error())
			pc.Close()
			client.mu.Lock()
			client.PC = nil
			client.isNegotiating = false
			client.mu.Unlock()
			return
		}
	}

	// Set up ICE candidate handler
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}

		candidate := c.ToJSON()
		sendToClient(client, &SignalingMessage{
			Type:      "candidate",
			ClientID:  client.ID,
			Candidate: &candidate,
		})
	})

	// Connection state handler
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("Client %s connection state: %s", client.ID, state.String())

		if state == webrtc.PeerConnectionStateFailed ||
			state == webrtc.PeerConnectionStateClosed {
			client.mu.Lock()
			client.isNegotiating = false
			client.mu.Unlock()
		}

		if state == webrtc.PeerConnectionStateConnected {
			log.Printf("Client %s fully connected", client.ID)
		}
	})

	// ICE connection state handler
	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		log.Printf("Client %s ICE state: %s", client.ID, state.String())
	})

	// Set remote description (the offer)
	offer := webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  msg.SDP.SDP,
	}

	// Log offer SDP for debugging (viewer offers)
	if role == "viewer" {
		log.Printf("Offer SDP from viewer (codecs):")
		for _, line := range strings.Split(offer.SDP, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "m=video") ||
				strings.HasPrefix(line, "m=application") ||
				strings.HasPrefix(line, "a=rtpmap:") ||
				strings.HasPrefix(line, "a=fmtp:") ||
				strings.HasPrefix(line, "a=sctpmap:") ||
				strings.HasPrefix(line, "a=sctp-port:") {
				log.Printf("   %s", line)
			}
		}
	}

	if err := pc.SetRemoteDescription(offer); err != nil {
		log.Printf("Failed to set remote description: %v", err)
		sendError(client, "Failed to set remote description: "+err.Error())

		client.mu.Lock()
		client.isNegotiating = false
		client.PC = nil
		client.mu.Unlock()

		pc.Close()
		return
	}

	client.mu.Lock()
	client.remoteDescSet = true
	pendingCandidates := client.pendingCandidates
	client.pendingCandidates = make([]*webrtc.ICECandidateInit, 0)
	client.mu.Unlock()

	// For viewers: add tracks AFTER setting remote description
	// This ensures proper SDP negotiation
	if role == "viewer" {
		trackCount := addTracksToViewer(pc, client.ID)
		if trackCount == 0 {
			log.Printf("No tracks available for viewer %s - they may need to reconnect after publisher starts", client.ID)
		}
	}

	// Apply any pending ICE candidates
	for _, candidate := range pendingCandidates {
		if err := pc.AddICECandidate(*candidate); err != nil {
			log.Printf("Failed to add pending ICE candidate: %v", err)
		} else {
			log.Printf("Applied pending ICE candidate for %s", client.ID)
		}
	}

	// Create answer
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		log.Printf("Failed to create answer: %v", err)
		sendError(client, "Failed to create answer: "+err.Error())

		client.mu.Lock()
		client.isNegotiating = false
		client.mu.Unlock()
		return
	}

	// Log answer SDP for debugging (media lines and codec info)
	if role == "viewer" {
		log.Printf("Answer SDP for viewer (media sections):")
		for _, line := range strings.Split(answer.SDP, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "m=") ||
				strings.HasPrefix(line, "a=mid:") ||
				strings.HasPrefix(line, "a=sendrecv") ||
				strings.HasPrefix(line, "a=sendonly") ||
				strings.HasPrefix(line, "a=recvonly") ||
				strings.HasPrefix(line, "a=inactive") ||
				strings.HasPrefix(line, "a=rtpmap:") ||
				strings.HasPrefix(line, "a=fmtp:") ||
				strings.HasPrefix(line, "a=sctp-port:") ||
				strings.HasPrefix(line, "a=sctpmap:") {
				log.Printf("   %s", line)
			}
		}
	}

	// Set local description
	if err := pc.SetLocalDescription(answer); err != nil {
		log.Printf("Failed to set local description: %v", err)
		sendError(client, "Failed to set local description: "+err.Error())

		client.mu.Lock()
		client.isNegotiating = false
		client.mu.Unlock()
		return
	}

	// Send answer (in the format the browser expects)
	sendToClient(client, &SignalingMessage{
		Type:     "answer",
		ClientID: client.ID,
		SDP: &SDPMessage{
			Type: "answer",
			SDP:  answer.SDP,
		},
	})

	client.mu.Lock()
	client.isNegotiating = false
	client.mu.Unlock()

	log.Printf("Sent answer to %s", client.ID)
}

// handleAnswer processes SDP answers (for viewer connections initiated by SFU)
func handleAnswer(client *Client, msg *SignalingMessage) {
	client.mu.Lock()
	pc := client.PC
	client.mu.Unlock()

	if pc == nil {
		log.Printf("No peer connection for answer from %s", client.ID)
		return
	}

	// Validate SDP
	if msg.SDP == nil || msg.SDP.SDP == "" {
		log.Printf("No SDP in answer from %s", client.ID)
		sendError(client, "No SDP in answer")
		return
	}

	answer := webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  msg.SDP.SDP,
	}

	if err := pc.SetRemoteDescription(answer); err != nil {
		log.Printf("Failed to set remote description (answer): %v", err)
		sendError(client, "Failed to set remote description: "+err.Error())
		return
	}

	client.mu.Lock()
	client.remoteDescSet = true
	client.mu.Unlock()

	log.Printf("Set answer from %s", client.ID)
}

// handleICE processes ICE candidates
func handleICE(client *Client, msg *SignalingMessage) {
	if msg.Candidate == nil {
		return
	}

	client.mu.Lock()
	pc := client.PC
	isNegotiating := client.isNegotiating
	remoteDescSet := client.remoteDescSet
	client.mu.Unlock()

	// If we don't have a peer connection yet or remote description not set,
	// queue the candidate
	if pc == nil || !remoteDescSet {
		client.mu.Lock()
		client.pendingCandidates = append(client.pendingCandidates, msg.Candidate)
		client.mu.Unlock()
		log.Printf("Queued ICE candidate for %s (pc: %v, remoteDesc: %v, negotiating: %v)",
			client.ID, pc != nil, remoteDescSet, isNegotiating)
		return
	}

	if err := pc.AddICECandidate(*msg.Candidate); err != nil {
		log.Printf("Failed to add ICE candidate for %s: %v", client.ID, err)
	} else {
		log.Printf("Added ICE candidate for %s", client.ID)
	}
}

// sendToClient sends a message to a specific client
func sendToClient(client *Client, msg *SignalingMessage) {
	client.mu.Lock()
	defer client.mu.Unlock()

	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Failed to marshal message: %v", err)
		return
	}

	if err := client.Conn.WriteMessage(websocket.TextMessage, data); err != nil {
		log.Printf("Failed to send message to %s: %v", client.ID, err)
	}
}

// sendError sends an error message to a client
func sendError(client *Client, message string) {
	sendToClient(client, &SignalingMessage{
		Type:    "error",
		Message: message,
	})
}

// removeClient removes a client and cleans up resources
func removeClient(clientID string) {
	clientsMu.Lock()
	client, exists := clients[clientID]
	if exists {
		delete(clients, clientID)
	}
	clientsMu.Unlock()

	if exists {
		client.mu.Lock()
		pc := client.PC
		role := client.Role
		client.mu.Unlock()

		if pc != nil {
			pc.Close()
		}

		// Remove publisher tracks if applicable
		if role == "publisher" {
			removePublisher(clientID)
		}

		// Remove viewer
		if role == "viewer" {
			sfu.viewers.Delete(clientID)
		}
	}
}

// broadcastStreamsUpdate notifies all viewers of stream changes
func broadcastStreamsUpdate() {
	streams := getAvailableStreams()
	streamInfos := make([]StreamInfo, len(streams))
	for i, s := range streams {
		streamInfos[i] = StreamInfo{ID: s, Topic: s}
	}

	clientsMu.RLock()
	defer clientsMu.RUnlock()

	for _, client := range clients {
		client.mu.Lock()
		role := client.Role
		client.mu.Unlock()

		if role == "viewer" {
			sendToClient(client, &SignalingMessage{
				Type:    "streams",
				Streams: streamInfos,
			})
		}
	}
}

// handleMetrics forwards metrics from publisher to viewers via data channel
func handleMetrics(client *Client, msg *SignalingMessage) {
	client.mu.Lock()
	role := client.Role
	client.mu.Unlock()

	// Only publishers can send metrics
	if role != "publisher" {
		return
	}

	// Create metrics message to forward
	metricsMsg := struct {
		Type      string          `json:"type"`
		Timestamp float64         `json:"timestamp"`
		Data      json.RawMessage `json:"data"`
	}{
		Type:      "metrics",
		Timestamp: msg.Timestamp,
		Data:      msg.Data,
	}

	metricsBytes, err := json.Marshal(metricsMsg)
	if err != nil {
		log.Printf("Failed to marshal metrics: %v", err)
		return
	}

	// Forward to all viewers via data channel AND WebSocket (fallback)
	viewerCount := 0
	totalViewers := 0
	sfu.viewers.Range(func(key, value interface{}) bool {
		totalViewers++
		viewer := value.(*Viewer)
		viewer.mu.RLock()
		dcState := "nil"
		if viewer.dataChannel != nil {
			dcState = viewer.dataChannel.ReadyState().String()
		}

		// Try data channel first
		sentViaDataChannel := false
		if viewer.dataChannel != nil && viewer.dataChannel.ReadyState() == webrtc.DataChannelStateOpen {
			viewer.dataChannel.Send(metricsBytes)
			viewerCount++
			sentViaDataChannel = true
		}
		viewer.mu.RUnlock()

		// Also send via WebSocket as fallback (always, for reliability)
		viewerID := key.(string)
		clientsMu.RLock()
		client, exists := clients[viewerID]
		clientsMu.RUnlock()

		if exists && client != nil {
			client.mu.Lock()
			if client.Conn != nil {
				// Send metrics via WebSocket
				wsMetrics := &SignalingMessage{
					Type:      "metrics",
					Timestamp: metricsMsg.Timestamp,
					Data:      metricsMsg.Data,
				}
				if err := client.Conn.WriteJSON(wsMetrics); err != nil {
					// Just log occasionally, don't spam
					if metricsForwardCount < 5 {
						log.Printf("Failed to send metrics via WebSocket to %s: %v", viewerID, err)
					}
				} else if !sentViaDataChannel && metricsForwardCount < 5 {
					log.Printf("Sent metrics via WebSocket to %s (data channel state: %s)", viewerID, dcState)
				}
			}
			client.mu.Unlock()
		}

		// Log data channel state for debugging (first few messages only)
		if metricsForwardCount < 5 {
			log.Printf("   Viewer %s: dataChannel state=%s", key, dcState)
		}
		return true
	})

	// Log periodically (every 100 messages = ~10 seconds at 10Hz)
	metricsForwardCount++
	if metricsForwardCount == 1 || metricsForwardCount%100 == 0 {
		log.Printf("Forwarding metrics to %d/%d viewer(s) (msg #%d)", viewerCount, totalViewers, metricsForwardCount)
	}
}

var metricsForwardCount int64
