// rtc.1ms.dog: the server end of speed.1ms.dog's UDP and QUIC checks, in Tokyo. Ports, directory and service name are
// as registered in 1ms-shell docs/processes.md, "VPS": 40100/udp (ICE), 40101/udp (WebTransport), 2087/tcp, 1ms-speed.
//
//   POST https://rtc.1ms.dog:2087/offer   a WebRTC offer in, the answer out (ice-lite, one UDP port): the page then
//                                          sends small packets on an unreliable data channel and this echoes each one
//   GET  wss://rtc.1ms.dog:2087/ws         WebSocket echo, the TCP side of the QUIC comparison
//   CONNECT https://rtc.1ms.dog:40101/wt   WebTransport (HTTP/3 over QUIC) echo of datagrams
//
// Nothing is logged or kept: packets are counted in memory for the length of one test, then dropped. Only errors and
// startup reach the journal. Every connection has a time limit, a packet budget and a cap on how many run at once.
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/ice/v4"
	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

const (
	maxPeers  = 200              // WebRTC and WebTransport sessions at once (each a few hundred KB)
	maxWS     = 200              // WebSocket echoes at once
	peerLife  = 90 * time.Second // a test takes about 30 s
	shortLife = 20 * time.Second // the QUIC/TCP comparison takes a few seconds
	maxPkt    = 64               // bytes in one test packet
	maxCount  = 6000             // packets one session may send (50 a second for two minutes)
)

var (
	origins = regexp.MustCompile(`^(https://speed\.1ms\.dog|http://localhost(:\d+)?|http://127\.0\.0\.1(:\d+)?)$`)
	peers   atomic.Int32
	wsOpen  atomic.Int32
	api     *webrtc.API
)

func allowed(r *http.Request) bool { return origins.MatchString(r.Header.Get("Origin")) }

func main() {
	sig := flag.String("sig", ":2087", "HTTPS address: /offer and /ws")
	icePort := flag.Int("ice", 40100, "UDP port for every WebRTC peer (ice-lite)")
	wt := flag.String("wt", ":40101", "UDP address for WebTransport")
	public4 := flag.String("public4", "", "public IPv4 to announce instead of the private one behind NAT")
	certs := flag.String("certs", os.Getenv("CREDENTIALS_DIRECTORY"), "directory with fullchain.pem and privkey.pem")
	flag.Parse()

	cert, err := tls.LoadX509KeyPair(filepath.Join(*certs, "fullchain.pem"), filepath.Join(*certs, "privkey.pem"))
	if err != nil {
		log.Fatalf("certificate: %v", err)
	}
	tlsConf := &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}

	// pion logs nothing below errors: no addresses in the journal
	lf := logging.NewDefaultLoggerFactory()
	lf.DefaultLogLevel = logging.LogLevelError
	mux, err := ice.NewMultiUDPMuxFromPort(*icePort, ice.UDPMuxFromPortWithNetworks(ice.NetworkTypeUDP4, ice.NetworkTypeUDP6),
		ice.UDPMuxFromPortWithLogger(lf.NewLogger("ice")))
	if err != nil {
		log.Fatalf("udp mux: %v", err)
	}
	se := webrtc.SettingEngine{LoggerFactory: lf}
	se.SetLite(true)
	se.SetICEUDPMux(mux)
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeUDP6})
	se.SetICETimeouts(5*time.Second, 10*time.Second, 2*time.Second)
	if *public4 != "" {
		if err := se.SetICEAddressRewriteRules(webrtc.ICEAddressRewriteRule{External: []string{*public4}, AsCandidateType: webrtc.ICECandidateTypeHost,
			Mode: webrtc.ICEAddressRewriteReplace, Networks: []webrtc.NetworkType{webrtc.NetworkTypeUDP4}}); err != nil {
			log.Fatalf("rewrite: %v", err)
		}
	}
	api = webrtc.NewAPI(webrtc.WithSettingEngine(se))

	h := http.NewServeMux()
	h.HandleFunc("/offer", offer)
	h.HandleFunc("/ws", echoWS)
	h.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "rtc.1ms.dog: see speed.1ms.dog", http.StatusNotFound) })
	srv := &http.Server{Addr: *sig, Handler: h, TLSConfig: tlsConf, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second,
		ErrorLog: log.New(io.Discard, "", 0)} // TLS handshake noise from scanners carries their addresses
	go func() { log.Fatal(srv.ListenAndServeTLS("", "")) }()

	wm := http.NewServeMux()
	ws := &webtransport.Server{H3: &http3.Server{Addr: *wt, Handler: wm, TLSConfig: http3.ConfigureTLSConfig(tlsConf)}, CheckOrigin: allowed}
	webtransport.ConfigureHTTP3Server(ws.H3)
	wm.HandleFunc("/wt", func(w http.ResponseWriter, r *http.Request) { echoWT(ws, w, r) })
	log.Printf("rtc.1ms.dog: https %s, ice udp %d, webtransport udp %s", *sig, *icePort, *wt)
	log.Fatal(ws.ListenAndServe())
}

func cors(w http.ResponseWriter, r *http.Request) bool {
	if !allowed(r) {
		http.Error(w, "origin", http.StatusForbidden)
		return false
	}
	w.Header().Set("Access-Control-Allow-Origin", r.Header.Get("Origin"))
	w.Header().Set("Access-Control-Allow-Methods", "POST")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Vary", "Origin")
	w.Header().Set("Cache-Control", "no-store")
	return true
}

// The page's offer in, the answer with this server's candidates out. The data channel echoes every binary message
// as it comes; the text message "n" asks how many arrived per phase (the first byte of each packet), so the page
// can tell packets lost on the way here from those lost on the way back.
func offer(w http.ResponseWriter, r *http.Request) {
	if !cors(w, r) {
		return
	}
	if r.Method == http.MethodOptions {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var o webrtc.SessionDescription
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&o); err != nil || o.Type != webrtc.SDPTypeOffer {
		http.Error(w, "offer", http.StatusBadRequest)
		return
	}
	if peers.Add(1) > maxPeers {
		peers.Add(-1)
		http.Error(w, "busy", http.StatusServiceUnavailable)
		return
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		peers.Add(-1)
		http.Error(w, "peer", http.StatusInternalServerError)
		return
	}
	var once atomic.Bool
	done := func() {
		if once.CompareAndSwap(false, true) {
			pc.Close()
			peers.Add(-1)
		}
	}
	timer := time.AfterFunc(peerLife, done)
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateFailed || s == webrtc.PeerConnectionStateClosed || s == webrtc.PeerConnectionStateDisconnected {
			timer.Stop()
			done()
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		var got [4]int
		n := 0
		dc.OnMessage(func(m webrtc.DataChannelMessage) {
			if !m.IsString {
				if n++; n > maxCount || len(m.Data) == 0 || len(m.Data) > maxPkt {
					return
				}
				if p := m.Data[0]; p < 4 {
					got[p]++
				}
				dc.Send(m.Data)
				return
			}
			if string(m.Data) == "n" {
				b, _ := json.Marshal(got)
				dc.SendText(string(b))
			}
		})
	})
	if err := pc.SetRemoteDescription(o); err != nil {
		timer.Stop()
		done()
		http.Error(w, "offer", http.StatusBadRequest)
		return
	}
	ans, err := pc.CreateAnswer(nil)
	if err == nil {
		gathered := webrtc.GatheringCompletePromise(pc)
		if err = pc.SetLocalDescription(ans); err == nil {
			select {
			case <-gathered:
			case <-time.After(3 * time.Second):
			}
		}
	}
	if err != nil {
		timer.Stop()
		done()
		http.Error(w, "answer", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(pc.LocalDescription())
}

// WebSocket echo: the same small messages over TCP, for the QUIC comparison
func echoWS(w http.ResponseWriter, r *http.Request) {
	if !allowed(r) {
		http.Error(w, "origin", http.StatusForbidden)
		return
	}
	if wsOpen.Add(1) > maxWS {
		wsOpen.Add(-1)
		http.Error(w, "busy", http.StatusServiceUnavailable)
		return
	}
	defer wsOpen.Add(-1)
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"speed.1ms.dog", "localhost:*", "127.0.0.1:*"}})
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(maxPkt)
	ctx, cancel := context.WithTimeout(r.Context(), shortLife)
	defer cancel()
	for i := 0; i < 200; i++ {
		t, b, err := c.Read(ctx)
		if err != nil {
			return
		}
		if c.Write(ctx, t, b) != nil {
			return
		}
	}
}

// WebTransport echo: datagrams back as they come, for as long as the comparison takes
func echoWT(s *webtransport.Server, w http.ResponseWriter, r *http.Request) {
	if peers.Add(1) > maxPeers {
		peers.Add(-1)
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	defer peers.Add(-1)
	sess, err := s.Upgrade(w, r)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(sess.Context(), shortLife)
	defer cancel()
	defer sess.CloseWithError(0, "")
	for i := 0; i < 200; i++ {
		b, err := sess.ReceiveDatagram(ctx)
		if err != nil {
			return
		}
		if len(b) <= maxPkt {
			sess.SendDatagram(b)
		}
	}
}
