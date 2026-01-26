package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"sync"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v3"
)

var (
	// WebRTC API configuration
	api *webrtc.API
)

// initWebRTCAPI initializes the WebRTC API with all common video codecs
// The SFU needs to support any codec the publisher might send
func initWebRTCAPI(codecName string) {
	// Create media engine
	mediaEngine := &webrtc.MediaEngine{}

	// Register ALL common video codecs for maximum compatibility
	// The SFU forwards whatever codec the publisher sends

	// VP8 - widely supported, aiortc default
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeVP8,
			ClockRate: 90000,
			RTCPFeedback: []webrtc.RTCPFeedback{
				{Type: "goog-remb"},
				{Type: "ccm", Parameter: "fir"},
				{Type: "nack"},
				{Type: "nack", Parameter: "pli"},
			},
		},
		PayloadType: 96,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		log.Printf("Failed to register VP8: %v", err)
	} else {
		log.Printf("Registered codec: VP8")
	}

	// VP9
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeVP9,
			ClockRate: 90000,
			RTCPFeedback: []webrtc.RTCPFeedback{
				{Type: "goog-remb"},
				{Type: "ccm", Parameter: "fir"},
				{Type: "nack"},
				{Type: "nack", Parameter: "pli"},
			},
		},
		PayloadType: 98,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		log.Printf("Failed to register VP9: %v", err)
	} else {
		log.Printf("Registered codec: VP9")
	}

	// H.264 Constrained Baseline (maximum browser compatibility)
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeH264,
			ClockRate:   90000,
			SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
			RTCPFeedback: []webrtc.RTCPFeedback{
				{Type: "goog-remb"},
				{Type: "ccm", Parameter: "fir"},
				{Type: "nack"},
				{Type: "nack", Parameter: "pli"},
			},
		},
		PayloadType: 102,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		log.Printf("Failed to register H.264 (CB): %v", err)
	} else {
		log.Printf("Registered codec: H.264 (Constrained Baseline)")
	}

	// H.264 Constrained Baseline with different profile
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeH264,
			ClockRate:   90000,
			SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
			RTCPFeedback: []webrtc.RTCPFeedback{
				{Type: "goog-remb"},
				{Type: "ccm", Parameter: "fir"},
				{Type: "nack"},
				{Type: "nack", Parameter: "pli"},
			},
		},
		PayloadType: 104,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		log.Printf("Failed to register H.264 (CB2): %v", err)
	} else {
		log.Printf("Registered codec: H.264 (Constrained Baseline 2)")
	}

	// Create WebRTC API with media engine
	api = webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine))

	log.Printf("WebRTC API initialized with multi-codec support")
	log.Printf("Preferred codec hint: %s (publisher determines actual codec)", codecName)
}

// PublisherTracks holds tracks from publishers
type PublisherTracks struct {
	tracks       map[string]*webrtc.TrackLocalStaticRTP // trackName -> track
	remoteTracks map[string]*webrtc.TrackRemote         // trackName -> remote track (for SSRC)
	publisherPC  *webrtc.PeerConnection                 // Publisher's peer connection for sending RTCP
	dataChannel  *webrtc.DataChannel
	mu           sync.RWMutex
}

var (
	publisherTracks = &PublisherTracks{
		tracks:       make(map[string]*webrtc.TrackLocalStaticRTP),
		remoteTracks: make(map[string]*webrtc.TrackRemote),
	}
)

// RequestKeyframe sends a PLI to the publisher to request a keyframe for all tracks
func (pt *PublisherTracks) RequestKeyframe(trackName string) error {
	pt.mu.RLock()
	pc := pt.publisherPC
	remoteTrack := pt.remoteTracks[trackName]
	pt.mu.RUnlock()

	if pc == nil {
		log.Printf("Cannot request keyframe for %s: no publisher PC", trackName)
		return fmt.Errorf("no publisher connection")
	}
	if remoteTrack == nil {
		log.Printf("Cannot request keyframe for %s: no remote track", trackName)
		return fmt.Errorf("no remote track")
	}

	// Send PLI (Picture Loss Indication) to request keyframe
	ssrc := remoteTrack.SSRC()
	pli := &rtcp.PictureLossIndication{
		MediaSSRC: uint32(ssrc),
	}

	log.Printf("Sending PLI (keyframe request) for track %s (SSRC: %d)...", trackName, ssrc)

	if err := pc.WriteRTCP([]rtcp.Packet{pli}); err != nil {
		log.Printf("Failed to send PLI for track %s: %v", trackName, err)
		return err
	}

	log.Printf("PLI sent successfully for track %s", trackName)
	return nil
}

// RequestAllKeyframes requests keyframes for all tracks
func (pt *PublisherTracks) RequestAllKeyframes() {
	pt.mu.RLock()
	trackNames := make([]string, 0, len(pt.tracks))
	for name := range pt.tracks {
		trackNames = append(trackNames, name)
	}
	pt.mu.RUnlock()

	log.Printf("Requesting keyframes for %d tracks", len(trackNames))

	for _, name := range trackNames {
		if err := pt.RequestKeyframe(name); err != nil {
			log.Printf("Keyframe request failed for %s: %v", name, err)
		}
	}
}

func handlePublisher(pc *webrtc.PeerConnection, publisherID string) error {
	log.Printf("Setting up publisher: %s", publisherID)

	// Store publisher's peer connection for sending RTCP
	publisherTracks.mu.Lock()
	publisherTracks.publisherPC = pc
	publisherTracks.mu.Unlock()

	// Note: Data channel for metrics is handled via WebSocket, not WebRTC data channel
	// This avoids ICE credential conflicts that can occur with some WebRTC implementations

	// Handle incoming tracks from publisher
	pc.OnTrack(func(remoteTrack *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		trackName := remoteTrack.ID()
		codecMime := remoteTrack.Codec().MimeType
		payloadType := remoteTrack.Codec().PayloadType
		log.Printf("Received track: %s (codec: %s, PT: %d)", trackName, codecMime, payloadType)

		// Create local track to forward to viewers
		localTrack, err := webrtc.NewTrackLocalStaticRTP(
			remoteTrack.Codec().RTPCodecCapability,
			trackName,
			fmt.Sprintf("stream_%s", trackName),
		)
		if err != nil {
			log.Printf("Failed to create local track: %v", err)
			return
		}

		log.Printf("   Local track created with codec: %s", localTrack.Codec().MimeType)

		// Store track and remote track for viewers
		publisherTracks.mu.Lock()
		publisherTracks.tracks[trackName] = localTrack
		publisherTracks.remoteTracks[trackName] = remoteTrack
		publisherTracks.mu.Unlock()

		log.Printf("Track %s ready for forwarding (codec: %s)", trackName, codecMime)

		// Forward RTP packets to local track
		go func() {
			rtpBuf := make([]byte, 1500)
			packetCount := 0
			for {
				n, _, err := remoteTrack.Read(rtpBuf)
				if err != nil {
					if err != io.EOF {
						log.Printf("Track %s read error: %v", trackName, err)
					}
					// Remove track on disconnect
					publisherTracks.mu.Lock()
					delete(publisherTracks.tracks, trackName)
					delete(publisherTracks.remoteTracks, trackName)
					publisherTracks.mu.Unlock()
					log.Printf("Track %s removed (forwarded %d packets)", trackName, packetCount)
					return
				}

				packetCount++
				if packetCount == 1 {
					// Parse first RTP packet header for debugging
					if n >= 12 {
						pt := rtpBuf[1] & 0x7F // Payload type is in second byte, lower 7 bits
						seq := uint16(rtpBuf[2])<<8 | uint16(rtpBuf[3])
						log.Printf("First RTP packet for track %s: %d bytes, PT=%d, seq=%d", trackName, n, pt, seq)
					} else {
						log.Printf("First RTP packet for track %s: %d bytes (too small for header)", trackName, n)
					}
				} else if packetCount%500 == 0 {
					log.Printf("Track %s: forwarded %d packets", trackName, packetCount)
				}

				// Forward to local track (viewers will receive this)
				if _, err := localTrack.Write(rtpBuf[:n]); err != nil {
					log.Printf("Track %s write error: %v", trackName, err)
					return
				}
			}
		}()
	})

	return nil
}

func handleViewer(pc *webrtc.PeerConnection, viewerID string) error {
	log.Printf("Setting up viewer: %s", viewerID)

	viewer := &Viewer{
		id:             viewerID,
		peerConnection: pc,
	}

	sfu.viewers.Store(viewerID, viewer)

	// Listen for data channel from viewer (browser creates it in offer)
	log.Printf("Registering OnDataChannel callback for viewer %s", viewerID)
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		dcID := "nil"
		if dc.ID() != nil {
			dcID = fmt.Sprintf("%d", *dc.ID())
		}
		log.Printf("*** RECEIVED data channel from viewer %s: label='%s' id=%s ***", viewerID, dc.Label(), dcID)

		viewer.mu.Lock()
		viewer.dataChannel = dc
		viewer.mu.Unlock()

		dc.OnOpen(func() {
			log.Printf("Data channel OPEN for viewer: %s (label=%s)", viewerID, dc.Label())
		})

		dc.OnClose(func() {
			log.Printf("Data channel CLOSED for viewer: %s", viewerID)
		})

		dc.OnError(func(err error) {
			log.Printf("Data channel ERROR for viewer %s: %v", viewerID, err)
		})
	})

	// NOTE: Tracks are added in handleOffer AFTER SetRemoteDescription
	// This is required for proper SDP negotiation

	// Handle ICE connection state changes
	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		log.Printf("Viewer %s ICE state: %s", viewerID, state.String())

		if state == webrtc.ICEConnectionStateFailed ||
			state == webrtc.ICEConnectionStateDisconnected ||
			state == webrtc.ICEConnectionStateClosed {
			sfu.viewers.Delete(viewerID)
			log.Printf("Viewer %s disconnected", viewerID)
		}
	})

	return nil
}

// addTracksToViewer adds all available publisher tracks to a viewer's peer connection
func addTracksToViewer(pc *webrtc.PeerConnection, viewerID string) int {
	trackCount := 0
	publisherTracks.mu.RLock()
	defer publisherTracks.mu.RUnlock()

	log.Printf("Adding tracks to viewer %s (available tracks: %d)", viewerID, len(publisherTracks.tracks))

	// Get existing transceivers from the viewer's offer
	transceivers := pc.GetTransceivers()
	log.Printf("Viewer has %d transceivers", len(transceivers))

	for i, t := range transceivers {
		var currentTrackID string
		if t.Sender() != nil && t.Sender().Track() != nil {
			currentTrackID = t.Sender().Track().ID()
		}
		log.Printf("   Transceiver %d: kind=%s direction=%s mid=%s senderTrack=%s",
			i, t.Kind(), t.Direction(), t.Mid(), currentTrackID)
	}

	// Find video transceivers to use (prefer existing ones over AddTrack)
	usedTransceivers := make(map[*webrtc.RTPTransceiver]bool)

	for trackName, track := range publisherTracks.tracks {
		log.Printf("   Trying to add track: %s (streamID: %s, codec: %s)",
			trackName, track.StreamID(), track.Codec().MimeType)

		// Find an unused video transceiver
		var targetTransceiver *webrtc.RTPTransceiver
		for _, t := range transceivers {
			if t.Kind() == webrtc.RTPCodecTypeVideo && !usedTransceivers[t] {
				// Found an unused video transceiver
				targetTransceiver = t
				usedTransceivers[t] = true
				break
			}
		}

		if targetTransceiver != nil {
			// Use existing transceiver via ReplaceTrack
			log.Printf("   Using existing transceiver (mid: %s, direction: %s)",
				targetTransceiver.Mid(), targetTransceiver.Direction())

			sender := targetTransceiver.Sender()
			if sender == nil {
				log.Printf("Transceiver has no sender, falling back to AddTrack")
				goto useAddTrack
			}

			err := sender.ReplaceTrack(track)
			if err != nil {
				log.Printf("ReplaceTrack failed: %v, falling back to AddTrack", err)
				goto useAddTrack
			}

			log.Printf("Successfully replaced track on transceiver for %s", trackName)
			trackCount++

			// Read RTCP packets and forward PLI to publisher
			go func(s *webrtc.RTPSender, name string) {
				rtcpBuf := make([]byte, 1500)
				for {
					n, _, err := s.Read(rtcpBuf)
					if err != nil {
						return
					}
					if n > 0 {
						// Parse RTCP and forward PLI/FIR to publisher
						packets, err := rtcp.Unmarshal(rtcpBuf[:n])
						if err == nil {
							for _, pkt := range packets {
								switch pkt.(type) {
								case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
									log.Printf("Keyframe request from viewer for track %s", name)
									publisherTracks.RequestKeyframe(name)
								}
							}
						}
					}
				}
			}(sender, trackName)
			continue
		}

	useAddTrack:
		// Fall back to AddTrack if no suitable transceiver found
		log.Printf("   Using AddTrack for %s", trackName)
		rtpSender, err := pc.AddTrack(track)
		if err != nil {
			log.Printf("Failed to add track %s to viewer %s: %v", trackName, viewerID, err)
			continue
		}

		log.Printf("Added track %s to viewer %s via AddTrack", trackName, viewerID)
		trackCount++

		// Read RTCP packets and forward PLI to publisher
		go func(sender *webrtc.RTPSender, name string) {
			rtcpBuf := make([]byte, 1500)
			for {
				n, _, err := sender.Read(rtcpBuf)
				if err != nil {
					return
				}
				if n > 0 {
					// Parse RTCP and forward PLI/FIR to publisher
					packets, err := rtcp.Unmarshal(rtcpBuf[:n])
					if err == nil {
						for _, pkt := range packets {
							switch pkt.(type) {
							case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
								log.Printf("Keyframe request from viewer for track %s", name)
								publisherTracks.RequestKeyframe(name)
							}
						}
					}
				}
			}
		}(rtpSender, trackName)
	}

	log.Printf("Total tracks added to viewer %s: %d", viewerID, trackCount)

	// Request keyframes for all tracks so the new viewer can start decoding
	if trackCount > 0 {
		go func() {
			// Initial delay to ensure connection is established
			time.Sleep(100 * time.Millisecond)
			log.Printf("Initial keyframe request for new viewer %s", viewerID)
			publisherTracks.RequestAllKeyframes()

			// Send a few more keyframe requests to ensure one gets through
			for i := 0; i < 3; i++ {
				time.Sleep(500 * time.Millisecond)
				log.Printf("Retry keyframe request #%d for viewer %s", i+1, viewerID)
				publisherTracks.RequestAllKeyframes()
			}
		}()
	}

	return trackCount
}

func getAvailableStreams() []string {
	streams := []string{}
	publisherTracks.mu.RLock()
	for trackName := range publisherTracks.tracks {
		streams = append(streams, trackName)
	}
	publisherTracks.mu.RUnlock()
	return streams
}

// WebRTC configuration
func getWebRTCConfig() webrtc.Configuration {
	return webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{
				URLs: []string{
					"stun:stun.l.google.com:19302",
					"stun:stun1.l.google.com:19302",
				},
			},
		},
		SDPSemantics: webrtc.SDPSemanticsUnifiedPlan,
	}
}

// Helper to marshal and log JSON
func marshalJSON(v interface{}) ([]byte, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal JSON: %w", err)
	}
	return data, nil
}

// RemovePublisher removes a publisher and its tracks
func removePublisher(publisherID string) {
	log.Printf("Removing publisher: %s", publisherID)

	// Clear all tracks from this publisher
	publisherTracks.mu.Lock()
	publisherTracks.tracks = make(map[string]*webrtc.TrackLocalStaticRTP)
	publisherTracks.dataChannel = nil
	publisherTracks.mu.Unlock()
}
