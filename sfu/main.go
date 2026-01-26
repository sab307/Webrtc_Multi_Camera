package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v3"
)

const (
	CERT_DIR  = "certs"
	CERT_FILE = "cert.pem"
	KEY_FILE  = "key.pem"
)

var (
	// Command-line flags
	port        = flag.String("port", "8443", "Server port")
	host        = flag.String("host", "0.0.0.0", "Server host to bind to (use 0.0.0.0 for all interfaces)")
	frontendDir = flag.String("frontend", "./frontend-static", "Frontend directory path")
	codec       = flag.String("codec", "h264", "Video codec: h264, vp8, vp9, h265")

	upgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return true // Allow all origins for development
		},
	}

	// Global SFU instance
	sfu *SFU

	// Selected codec
	selectedCodec string
)

type SFU struct {
	publishers sync.Map // publisherID -> *Publisher
	viewers    sync.Map // viewerID -> *Viewer
	mu         sync.RWMutex
}

type Publisher struct {
	id             string
	peerConnection *webrtc.PeerConnection
	tracks         map[string]*webrtc.TrackLocalStaticRTP
	dataChannel    *webrtc.DataChannel
	mu             sync.RWMutex
}

type Viewer struct {
	id             string
	peerConnection *webrtc.PeerConnection
	ws             *websocket.Conn
	dataChannel    *webrtc.DataChannel
	mu             sync.RWMutex
}

func main() {
	// Parse command-line flags
	flag.Parse()

	// Validate and set codec
	selectedCodec = strings.ToLower(*codec)
	switch selectedCodec {
	case "h264", "vp8", "vp9", "h265":
		// Valid codec
	default:
		log.Fatalf("Invalid codec: %s. Must be one of: h264, vp8, vp9, h265", *codec)
	}

	log.Printf("Configuration:")
	log.Printf("   Host: %s", *host)
	log.Printf("   Port: %s", *port)
	log.Printf("   Frontend: %s", *frontendDir)
	log.Printf("   Codec: %s", selectedCodec)
	log.Printf("")

	// Initialize WebRTC API with selected codec
	initWebRTCAPI(selectedCodec)

	// Ensure TLS certificates exist
	if err := ensureTLSCertificates(); err != nil {
		log.Fatalf("Failed to setup TLS certificates: %v", err)
	}

	// Initialize SFU
	sfu = &SFU{}

	// Setup HTTP routes
	http.HandleFunc("/ws", handleWebSocket)
	http.HandleFunc("/health", handleHealth)
	http.HandleFunc("/streams", handleStreams)

	// Serve static frontend files
	if fileExists(*frontendDir + "/index.html") {
		log.Printf("Frontend found at %s", *frontendDir)

		// Serve static files
		fs := http.FileServer(http.Dir(*frontendDir))
		http.Handle("/", fs)
	} else {
		log.Printf("Frontend not found at %s", *frontendDir)
		// Placeholder for missing frontend
		http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			w.Write([]byte(fmt.Sprintf(`
<!DOCTYPE html>
<html>
<head>
    <title>ROS2 WebRTC SFU</title>
    <style>
        body { font-family: system-ui; max-width: 800px; margin: 100px auto; padding: 20px; }
        pre { background: #f5f5f5; padding: 15px; border-radius: 5px; overflow-x: auto; }
        .error { color: #d32f2f; }
    </style>
</head>
<body>
    <h1>🎥 ROS2 WebRTC SFU Server</h1>
    <p class="error">Frontend not found</p>
    <p>Expected frontend files at: <code>%s</code></p>
    <hr>
    <h2>API Endpoints</h2>
    <ul>
        <li><a href="/health">/health</a> - Health check</li>
        <li><a href="/streams">/streams</a> - Available streams</li>
        <li>wss://%s:%s/ws - WebSocket signaling</li>
    </ul>
    <h2>Configuration</h2>
    <ul>
        <li>Codec: %s</li>
    </ul>
</body>
</html>
			`, *frontendDir, getDisplayHost(), *port, selectedCodec)))
		})
	}

	// Load TLS certificate
	certPath := filepath.Join(CERT_DIR, CERT_FILE)
	keyPath := filepath.Join(CERT_DIR, KEY_FILE)

	// Get local IP for display
	localIP := getLocalIP()

	log.Printf("")
	log.Printf("ROS2 WebRTC SFU Server")
	log.Printf("══════════════════════════════════════")
	log.Printf("WebSocket:  wss://%s:%s/ws", getDisplayHost(), *port)
	log.Printf("Dashboard:  https://%s:%s", getDisplayHost(), *port)
	if localIP != "" && *host == "0.0.0.0" {
		log.Printf("LAN Access: https://%s:%s", localIP, *port)
	}
	log.Printf("Codec:      %s", selectedCodec)
	log.Printf("TLS Certs:  %s/", CERT_DIR)
	log.Printf("══════════════════════════════════════")
	log.Printf("")
	log.Printf("First-time TLS certificate setup:")
	log.Printf("   1. Visit https://%s:%s in browser", getDisplayHost(), *port)
	log.Printf("   2. Click 'Advanced' → 'Proceed to %s'", getDisplayHost())
	log.Printf("   3. Certificate trusted for this session!")
	log.Printf("")
	log.Printf("Server ready - waiting for connections...")
	log.Printf("")

	// Start HTTPS server
	bindAddr := fmt.Sprintf("%s:%s", *host, *port)
	log.Printf("Binding to: %s", bindAddr)
	err := http.ListenAndServeTLS(bindAddr, certPath, keyPath, nil)
	if err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(fmt.Sprintf(`{"status":"ok","service":"ros2-webrtc-sfu","codec":"%s"}`, selectedCodec)))
}

func handleStreams(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	// List active streams
	streams := getAvailableStreams()

	// Return JSON array
	data, _ := marshalJSON(map[string]interface{}{
		"streams": streams,
		"codec":   selectedCodec,
	})
	w.Write(data)
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}
	defer ws.Close()

	log.Printf("New WebSocket connection from %s", r.RemoteAddr)

	// Handle signaling messages
	handleSignaling(ws)
}

func getLocalIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ""
	}

	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			if ipnet.IP.To4() != nil {
				return ipnet.IP.String()
			}
		}
	}
	return ""
}

func getDisplayHost() string {
	if *host == "0.0.0.0" || *host == "" {
		return "localhost"
	}
	return *host
}

func ensureTLSCertificates() error {
	// Create certs directory if it doesn't exist
	if err := os.MkdirAll(CERT_DIR, 0755); err != nil {
		return fmt.Errorf("failed to create certs directory: %w", err)
	}

	certPath := filepath.Join(CERT_DIR, CERT_FILE)
	keyPath := filepath.Join(CERT_DIR, KEY_FILE)

	// Check if certificates already exist
	if _, err := os.Stat(certPath); err == nil {
		if _, err := os.Stat(keyPath); err == nil {
			log.Printf("TLS certificates found")
			return nil
		}
	}

	// Generate new self-signed certificates
	log.Printf("Generating self-signed TLS certificates...")
	if err := generateSelfSignedCert(certPath, keyPath); err != nil {
		return fmt.Errorf("failed to generate certificates: %w", err)
	}

	log.Printf("TLS certificates generated successfully")
	log.Printf("Self-signed cert - browsers will show security warning")
	return nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
