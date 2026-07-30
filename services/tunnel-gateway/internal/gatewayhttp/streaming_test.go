package gatewayhttp

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/danjonesio/reviewplane/services/tunnel-gateway/datachannel"
)

// Streaming through the route.
//
// docs/ARCHITECTURE.md section 7.4 lists HTTP streaming and server-sent events
// as mandatory tunnel capabilities. They fail in a specific and recognisable
// way when any hop buffers: the events arrive in a burst at stream close
// instead of incrementally, and a test that asserted only on the final body
// would pass against exactly the implementation the capability exists to
// exclude. So these tests assert on arrival timing.

// eventStreamHandler is a development server emitting server-sent events.
func eventStreamHandler(count int, interval time.Duration) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		controller := http.NewResponseController(w)
		_ = controller.Flush()
		for index := 0; index < count; index++ {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(interval):
			}
			_, _ = fmt.Fprintf(w, "event: tick\ndata: {\"seq\":%d}\n\n", index)
			if err := controller.Flush(); err != nil {
				return
			}
		}
		_, _ = io.WriteString(w, "event: done\ndata: {}\n\n")
		_ = controller.Flush()
	}
}

// readArrivals reads whole double-newline-delimited records and records when
// each one arrived.
func readArrivals(t *testing.T, body io.Reader, want int) []time.Duration {
	t.Helper()
	started := time.Now()
	reader := bufio.NewReader(body)
	arrivals := make([]time.Duration, 0, want)
	var record strings.Builder
	for len(arrivals) < want {
		line, err := reader.ReadString('\n')
		record.WriteString(line)
		if strings.HasSuffix(record.String(), "\n\n") {
			arrivals = append(arrivals, time.Since(started))
			record.Reset()
		}
		if err != nil {
			break
		}
	}
	return arrivals
}

func TestServerSentEventsArriveIncrementally(t *testing.T) {
	const count = 6
	const interval = 120 * time.Millisecond

	h := newHarness(t, harnessOptions{devHandler: eventStreamHandler(count, interval)})
	h.publish(RegisterRequest{})

	response := h.browse(browserRequest{path: "/events", capability: h.defaultCapability()})
	defer func() { _ = response.Body.Close() }()
	if got := response.Header.Get("Content-Type"); !strings.HasPrefix(got, "text/event-stream") {
		t.Fatalf("content type %q", got)
	}
	if response.Header.Get("Content-Length") != "" {
		t.Fatal("an event stream was given a Content-Length, so something buffered it whole")
	}

	arrivals := readArrivals(t, response.Body, count)
	if len(arrivals) != count {
		t.Fatalf("received %d events, want %d", len(arrivals), count)
	}
	for index, arrival := range arrivals {
		t.Logf("event %d arrived after %s", index, arrival.Round(time.Millisecond))
	}

	// The assertion is timing, not content. A hop that buffered the stream
	// would deliver every event at once at close, so the gaps would collapse
	// towards zero and the first event would arrive at the same instant as the
	// last. Half the production interval is the threshold: it is well clear of
	// scheduling noise and nowhere near the zero a buffering hop produces.
	minimumGap := interval / 2
	for index := 1; index < len(arrivals); index++ {
		gap := arrivals[index] - arrivals[index-1]
		if gap < minimumGap {
			t.Fatalf("events %d and %d arrived %s apart; a hop is buffering the stream",
				index-1, index, gap.Round(time.Millisecond))
		}
	}
	if arrivals[0] > arrivals[len(arrivals)-1]/2 {
		t.Fatalf("the first event arrived after %s and the last after %s; that is a burst, not a stream",
			arrivals[0].Round(time.Millisecond), arrivals[len(arrivals)-1].Round(time.Millisecond))
	}
}

func TestAChunkedResponseIsDeliveredIncrementally(t *testing.T) {
	const chunks = 5
	const interval = 120 * time.Millisecond

	h := newHarness(t, harnessOptions{devHandler: func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		controller := http.NewResponseController(w)
		for index := 0; index < chunks; index++ {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(interval):
			}
			_, _ = fmt.Fprintf(w, "chunk %d\n\n", index)
			if err := controller.Flush(); err != nil {
				return
			}
		}
	}})
	h.publish(RegisterRequest{})

	response := h.browse(browserRequest{path: "/chunked", capability: h.defaultCapability()})
	defer func() { _ = response.Body.Close() }()
	if response.ContentLength != -1 {
		t.Fatalf("a streamed response was given a length of %d", response.ContentLength)
	}

	arrivals := readArrivals(t, response.Body, chunks)
	if len(arrivals) != chunks {
		t.Fatalf("received %d chunks, want %d", len(arrivals), chunks)
	}
	for index := 1; index < len(arrivals); index++ {
		if gap := arrivals[index] - arrivals[index-1]; gap < interval/2 {
			t.Fatalf("chunks %d and %d arrived %s apart; the response was accumulated, not streamed",
				index-1, index, gap.Round(time.Millisecond))
		}
	}
}

func TestASlowConsumerOnAStreamedResponseProducesBackpressure(t *testing.T) {
	// docs/CONNECTOR_PROTOCOL.md section 12.2 forbids one stream from
	// exhausting connector memory, and docs/TESTING.md section 6 makes the slow
	// consumer a tested case. The property is that a browser which stops
	// reading stops the development service, rather than the bytes piling up in
	// the tunnel.
	const attempt = 32 << 20
	// The bound the consumer must hold the producer under.
	const bound = 8 << 20

	written := &atomic.Int64{}
	release := make(chan struct{})
	h := newHarness(t, harnessOptions{
		sessionCfg: datachannel.SessionConfig{StreamWindow: 64 << 10},
		devHandler: func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			controller := http.NewResponseController(w)
			// No write deadline: this handler is deliberately blocked by the
			// consumer, and a deadline would turn the property under test into
			// a timeout.
			_ = controller.SetWriteDeadline(time.Time{})
			block := make([]byte, 32<<10)
			for written.Load() < attempt {
				count, err := w.Write(block)
				written.Add(int64(count))
				if err != nil || r.Context().Err() != nil {
					return
				}
			}
		},
	})
	h.publish(RegisterRequest{})

	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, h.proxy.URL+"/flood", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	request.Host = testAlias + "." + testSuffix
	request.Header.Set(CapabilityHeader, h.defaultCapability())
	response, err := h.proxy.Client().Do(request)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() {
		close(release)
		_ = response.Body.Close()
	}()

	// The consumer reads nothing at all for long enough that an implementation
	// which queued rather than blocked would have swallowed the whole 16 MiB.
	time.Sleep(750 * time.Millisecond)
	stalled := written.Load()
	t.Logf("the development service wrote %d bytes while the consumer read none", stalled)

	// The bound is deliberately loose. What is in flight is the stream's
	// flow-control window, one copy buffer per hop and two kernel socket
	// buffers, and socket buffers on loopback autotune into the megabytes. A
	// tight bound would be asserting the kernel's tuning; what matters is that
	// the figure is a small fraction of what the producer offered rather than
	// all of it.
	if stalled >= bound {
		t.Fatalf("the development service wrote %d of %d bytes into a consumer reading nothing; "+
			"the tunnel is buffering rather than applying backpressure", stalled, attempt)
	}
	if stalled == 0 {
		t.Fatal("the development service wrote nothing at all, so this proves no backpressure")
	}

	// Draining releases the producer, which is the other half of the property:
	// backpressure, not a stall. The consumer keeps reading until the producer
	// has moved, because what is already queued in the two socket buffers has
	// to be consumed before any new credit reaches the far end.
	drained := &atomic.Int64{}
	go func() {
		buffer := make([]byte, 32<<10)
		for {
			count, err := response.Body.Read(buffer)
			drained.Add(int64(count))
			if err != nil {
				return
			}
			select {
			case <-release:
				return
			default:
			}
		}
	}()
	waitFor(t, "the development service to resume once the consumer read", func() bool {
		return written.Load() > stalled
	})
	if drained.Load() == 0 {
		t.Fatal("the stream delivered nothing once the consumer started reading")
	}
}
